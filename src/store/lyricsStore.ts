/**
 * Состояние панели текста: что загружено, идёт ли поиск, что показывать.
 * Позиция воспроизведения здесь не хранится: активную строку компонент
 * считает сам из `position` игрока, поэтому на каждый кадр ничего не
 * пересчитывается — только при изменении позиции.
 *
 * Здесь же живёт ручное смещение синхронизации: текст регулярно отстаёт от
 * музыки, и подстроить его удобнее в плеере, а не в редакторе тегов.
 */

import { create } from "zustand";
import {
  lyricsFetch,
  lyricsLoadLocal,
  lyricsSaveLocal,
  linesOf,
  isSynced,
  hasTimestamps,
  readCachedLyrics,
  writeCachedLyrics,
  readLyricsOffset,
  writeLyricsOffset,
  readVariantChoice,
  writeVariantChoice,
  writeGlobalLyricsOffset,
  readGlobalOffsetEnabled,
  writeGlobalOffsetEnabled,
  type LyricLine,
  type LyricsQuery,
  type LyricsResult,
  type LyricsVariant,
} from "../services/lyrics";
import { errorText, logError } from "./errorStore";
import { useOfflineStore } from "./offlineStore";
import { lyricsKeyFor, setLyricsOfflineKeys } from "../lib/lyricsKey";
import type { Track } from "./playerStore";

/**
 * Резолверу ключа текста нужен реестр офлайна: по пути к копии он узнаёт
 * исходный сервисный id, а по id — путь копии (для лечения старых файлов).
 * Реестр уже прочитан при старте, поэтому здесь только синхронные чтения:
 * ни диска, ни сети.
 */
setLyricsOfflineKeys({
  trackIdFor: (value) => {
    const state = useOfflineStore.getState();
    // Сначала как id: запись офлайна ищется по ключу трека
    const record = state.record(value);
    if (record) return record.trackId;
    // Затем как путь к файлу копии: именно он лежит в id трека из «Скачанных»
    const lower = value.toLowerCase();
    return state.list.find((file) => file.path.toLowerCase() === lower)?.trackId ?? null;
  },
  pathFor: (trackId) => useOfflineStore.getState().record(trackId)?.path ?? null,
});

/**
 * Сообщение, когда не нашлось ни синхронного текста, ни обычного.
 * Формулировка пользователя — дословно.
 */
export const LYRICS_NOT_FOUND_TEXT = "Текст отсутствует в базе данных";

interface LyricsState {
  /** Панель текста открыта. */
  open: boolean;
  /** Трек, для которого загружен текст (id), чтобы не грузить одно и то же. */
  trackId: string | null;
  loading: boolean;
  /** Текст не найден — показываем сообщение и кнопку «Искать заново». */
  notFound: boolean;
  /** Техническая ошибка (сеть и т.п.) — текст состояния в панели. */
  error: string | null;
  /** Понятная подпись состояния: «Ищу текст…», ошибка или пусто. */
  status: string;
  lines: LyricLine[];
  synced: boolean;
  /** Название и исполнитель от источника — для подписи «источник: netease». */
  source: string | null;
  title: string | null;
  artist: string | null;
  /**
   * Текст найден у оригинала, а не у играющей версии (speed up/reverb/коллаж).
   * Панель показывает это подписью «Текст от оригинала: …».
   */
  fromOriginal: boolean;
  /** Время строк посчитано нами (Genius без тайминга): подсветка примерная. */
  estimated: boolean;
  /**
   * Все найденные варианты текста (LRCLIB, Netease, Genius, lyrics.ovh):
   * 0-й — выбранный. Если вариантов больше одного, в панели есть переключение.
   */
  variants: LyricsVariant[];
  /** Какой вариант сейчас показан. */
  variantIndex: number;
  /** Показать другой вариант: текст, источник и подписи меняются целиком. */
  selectVariant: (index: number) => void;
  /** Исходный ответ Rust: из него берутся варианты при переключении. */
  variantSource: LyricsResult | null;
  /** Название и исполнитель реально найденной записи — для той же подписи. */
  matchedTitle: string | null;
  matchedArtist: string | null;
  /** Ручное смещение синхронизации текущего трека, секунды. */
  offset: number;
  /**
   * Переключатель «Для всех треков»: включён — активно общее смещение
   * (оно применяется ко всем трекам), выключен — своё у каждого трека.
   */
  globalEnabled: boolean;

  setOpen: (value: boolean) => void;
  /** Загрузить текст для трека: кеш, иначе запрос к источникам. */
  load: (track: Track) => Promise<void>;
  /** «Искать заново» — мимо кеша. */
  retry: () => Promise<void>;
  /** Сменить трек: сбрасываем всё, что относится к прошлому. */
  reset: () => void;
  /** Задать смещение синхронизации (значение клампится). */
  setOffset: (value: number) => void;
  /** Сдвинуть смещение на шаг (кнопки «−0.5 с» и «+0.5 с»). */
  nudgeOffset: (delta: number) => void;
  /** Сбросить смещение к нулю: в глобальном режиме — общее. */
  resetOffset: () => void;
  /**
   * Переключатель «Для всех треков». Включение делает активным общее смещение:
   * ненулевое текущее смещение записывается как общее, а если текущее нулевое —
   * возвращается запомненное общее. Выключение возвращает своё значение трека
   * (нет — 0), общее остаётся записанным. Плеер и текст не трогает: меняется
   * только применяемое смещение и подсветка.
   */
  setGlobalEnabled: (value: boolean) => void;
  /**
   * Тихая предзагрузка: ищет текст заранее и кладёт его в кеш, чтобы панель
   * открылась сразу. Панель и воспроизведение она не трогает.
   */
  preload: (track: Track) => Promise<void>;
}

const EMPTY = {
  loading: false,
  notFound: false,
  error: null,
  status: "",
  lines: [] as LyricLine[],
  synced: false,
  source: null,
  title: null,
  artist: null,
  fromOriginal: false,
  estimated: false,
  variants: [] as LyricsVariant[],
  variantIndex: 0,
  variantSource: null as LyricsResult | null,
  matchedTitle: null,
  matchedArtist: null,
  offset: 0,
};

function queryOf(track: Track): LyricsQuery {
  return {
    id: track.id,
    title: track.title?.trim() ?? "",
    artist: track.artist?.trim() || null,
    durationMs: Number.isFinite(track.durationMs) ? track.durationMs : 0,
  };
}

/** Подпись трека для журнала: «Исполнитель — Название». */
function labelOf(query: LyricsQuery): string {
  return `${query.artist ? `${query.artist} — ` : ""}${query.title}`;
}

/** Номер последнего запроса: ответ на устаревший запрос не должен перебивать новый. */
let requestId = 0;
/** Последний запрос — для кнопки «Искать заново». */
let lastQuery: LyricsQuery | null = null;

/**
 * Ключ кеша и дедупликации: id трека, иначе пара «исполнитель::название».
 * id проходит через единый резолвер (`lyricsKeyFor`): трек из «Скачанных»
 * приходит с id-путём к офлайн-копии, а текст сохранялся под `soundcloud:id`.
 * Один трек — один ключ, из какого бы списка его ни включили.
 */
function keyOf(query: LyricsQuery): string {
  const id = query.id?.trim();
  if (id) return lyricsKeyFor(id);
  return `${query.artist ?? ""}::${query.title}`.trim().toLowerCase();
}

/**
 * Запросы в полёте. Один запрос на трек: повторные обращения — например,
 * пользователь нажал «Текст», пока идёт предзагрузка, — ждут тот же промис.
 * Сделано по образцу `requestServiceUrl` из playerStore.
 */
const pendingFetches = new Map<string, Promise<LyricsResult>>();

/** Треки, для которых предзагрузка уже запускалась в этой сессии. */
const preloaded = new Set<string>();

function requestLyrics(query: LyricsQuery): Promise<LyricsResult> {
  const key = keyOf(query);
  const pending = key ? pendingFetches.get(key) : undefined;
  if (pending) return pending;

  const request = lyricsFetch(
    query.artist ?? "",
    query.title,
    Math.round(query.durationMs / 1000)
  ).finally(() => {
    if (key) pendingFetches.delete(key);
  });

  if (key) pendingFetches.set(key, request);
  return request;
}

/**
 * Есть ли в результате хоть какой-то текст. Пустая запись в кеше — это промах
 * прошлого поиска, и использовать его как «найденный текст» нельзя.
 */
function hasText(result: LyricsResult): boolean {
  return Boolean(result.synced?.trim() || result.plain?.trim());
}

export const useLyricsStore = create<LyricsState>((set, get) => {
  /** Применить вариант: его текст, источник и подписи становятся текущими. */
  const showVariant = (result: LyricsResult, variants: LyricsVariant[], index: number) => {
    const variant = variants[index];
    const effective: LyricsResult = variant
      ? {
          ...result,
          synced: variant.synced,
          plain: variant.plain,
          source: variant.source,
          title: variant.title,
          artist: variant.artist,
          estimated: variant.estimated,
          fromOriginal: variant.fromOriginal,
          matchedTitle: variant.matchedTitle ?? null,
          matchedArtist: variant.matchedArtist ?? null,
        }
      : result;
    return { effective, lines: linesOf(effective) };
  };

  const apply = (query: LyricsQuery, result: LyricsResult | null) => {
    if (!result) return;
    // Варианты приходят от Rust: 0-й — лучший. Если источники нашли разное,
    // человек сам выберет нужный текст (бывает, что первый — не та версия).
    const variants = (result.variants ?? []).filter((variant) => variant.synced || variant.plain);
    const stored = readVariantChoice(query.id);
    const index = variants.length ? Math.min(Math.max(stored, 0), variants.length - 1) : 0;
    const { effective, lines } = showVariant(result, variants, index);
    set({
      trackId: query.id,
      loading: false,
      notFound: !lines.length,
      error: null,
      status: lines.length ? "" : LYRICS_NOT_FOUND_TEXT,
      lines,
      synced: isSynced(lines),
      source: effective.source,
      title: effective.title,
      artist: effective.artist,
      fromOriginal: Boolean(effective.fromOriginal),
      estimated: Boolean(effective.estimated),
      matchedTitle: effective.matchedTitle ?? null,
      matchedArtist: effective.matchedArtist ?? null,
      variants,
      variantIndex: index,
      offset: readLyricsOffset(query.id),
      // Исходный результат нужен, чтобы переключать варианты без новой загрузки.
      variantSource: result,
    });
  };

  /**
   * Текст, сохранённый файлом рядом с офлайн-копией трека (формат LRC).
   * `null` — файла нет или он пуст. Сбой чтения текста не ломает: просто
   * идём к следующему источнику.
   */
  const localFileResult = async (query: LyricsQuery): Promise<LyricsResult | null> => {
    const text = await lyricsLoadLocal(query.id);
    if (!text) return null;
    return {
      found: true,
      synced: hasTimestamps(text) ? text : null,
      plain: hasTimestamps(text) ? null : text,
      source: "файл",
      title: query.title,
      artist: query.artist,
      fromOriginal: false,
      matchedTitle: null,
      matchedArtist: null,
    };
  };

  /**
   * Записать результат в кеш, а синхронный текст ещё и файлом. На диск пишем
   * ТОЛЬКО то, что пришло из сети: файл — копия ответа источника с таймингами,
   * а не копия файла или кеша.
   */
  const remember = async (query: LyricsQuery, result: LyricsResult, network: boolean): Promise<void> => {
    writeCachedLyrics(query, result);
    if (!network || !hasText(result)) return;

    const text = result.synced?.trim() || result.plain?.trim();
    if (!text) return;

    // Файл уже с этим текстом — писать повторно незачем. Чтение и запись сами
    // приводят id к одному ключу (`lyricsKeyFor`): у трека из «Скачанных» здесь
    // путь копии, а файл лежит под сервисным id.
    const existing = await lyricsLoadLocal(query.id);
    if (existing?.trim() === text) return;
    await lyricsSaveLocal(query.id, text, result.source ?? null);
  };

  const load = async (track: Track, force = false) => {
    const query = queryOf(track);
    lastQuery = query;
    const token = ++requestId;

    if (!query.title && !query.artist) {
      set({
        ...EMPTY,
        trackId: query.id,
        notFound: true,
        status: "У трека нет названия — искать нечего",
      });
      return;
    }

    if (!force) {
      // 1. Файл рядом с офлайн-копией трека: он переживает и чистку кеша, и
      //    перезапуск, и отсутствие сети.
      const file = await localFileResult(query);
      if (token !== requestId) return;
      if (file) {
        const cached = readCachedLyrics(query);
        const networkIsBetter = !file.synced && !hasTimestamps(cached?.synced);
        // Синхронный текст из сети лучше обычного из файла — идём за ним.
        // Обычный файл при обычном кеше (или без кеша) показываем сразу.
        if (!networkIsBetter) {
          if (cached && !hasTimestamps(file.synced)) {
            // Кеш про ту же запись: подписи «от оригинала» берём из него.
            // Синхронного текста в кеше нет (иначе за ним пошли бы в сеть),
            // поэтому текст остаётся файловым.
            apply(query, { ...file, ...cached });
          } else {
            apply(query, file);
          }
          return;
        }
      } else {
        // 2. Кеш localStorage — как раньше
        const cached = readCachedLyrics(query);
        if (cached) {
          apply(query, cached);
          return;
        }
      }
    }

    set({
      trackId: query.id,
      loading: true,
      notFound: false,
      error: null,
      status: "",
      lines: [],
      synced: false,
      offset: readLyricsOffset(query.id),
    });

    try {
      const result = await requestLyrics(query);
      if (token !== requestId) return; // трек уже сменился — ответ не наш
      await remember(query, result, true);
      if (token !== requestId) return;
      apply(query, result);
      // Полный провал: в журнал уходит перечень всех вариантов, которые
      // перебрал Rust, — иначе такой промах не разобрать.
      if (!result.found) {
        logError(
          "Текст песни не найден",
          labelOf(query),
          "текст",
          (result.attempts ?? []).join("\n")
        );
      }
    } catch (error) {
      if (token !== requestId) return;
      // Сеть не ответила, но текст уже лежит файлом — это и есть офлайн
      // с таймингами: показываем его, а не пустую панель.
      const file = await localFileResult(query);
      if (token !== requestId) return;
      if (file) {
        apply(query, file);
        return;
      }
      const text = errorText(error);
      logError(
        "Не удалось получить текст песни",
        "Ни один источник текста не ответил",
        "текст",
        text
      );
      set({
        ...EMPTY,
        trackId: query.id,
        notFound: true,
        error: "Не удалось получить текст: проверь соединение",
        status: "Не удалось получить текст: проверь соединение",
      });
    }
  };

  return {
    open: false,
    trackId: null,
    ...EMPTY,
    // Режим «Для всех треков» переживает перезапуск: читаем из localStorage
    globalEnabled: readGlobalOffsetEnabled(),

    setOpen: (value) => set({ open: value }),

    load: (track) => load(track),

    selectVariant: (index) => {
      const state = get();
      const base = state.variantSource;
      const variants = state.variants;
      if (!base || variants.length < 2) return;
      const next = ((index % variants.length) + variants.length) % variants.length;
      const { effective, lines } = showVariant(base, variants, next);
      if (state.trackId) writeVariantChoice(state.trackId, next);
      set({
        lines,
        synced: isSynced(lines),
        source: effective.source,
        title: effective.title,
        artist: effective.artist,
        fromOriginal: Boolean(effective.fromOriginal),
        estimated: Boolean(effective.estimated),
        matchedTitle: effective.matchedTitle ?? null,
        matchedArtist: effective.matchedArtist ?? null,
        notFound: !lines.length,
        variantIndex: next,
      });
    },

    retry: async () => {      const query = lastQuery;
      const state = get();
      const id = query?.id ?? state.trackId ?? "";
      if (!id) return;
      await load(
        {
          id,
          path: "",
          title: query?.title ?? state.title ?? "",
          artist: query?.artist ?? state.artist,
          album: null,
          durationMs: query?.durationMs ?? 0,
          source: "local",
        },
        true
      );
    },

    reset: () => {
      requestId++;
      lastQuery = null;
      set({ trackId: null, ...EMPTY });
    },

    setOffset: (value) => {
      const state = get();
      // В глобальном режиме правится общее значение, в локальном — значение
      // трека. Нет трека — писать больше некуда, значит общее.
      const next =
        state.globalEnabled || !state.trackId
          ? writeGlobalLyricsOffset(value)
          : writeLyricsOffset(state.trackId, value);
      set({ offset: next });
    },

    nudgeOffset: (delta) => {
      get().setOffset(get().offset + delta);
    },

    resetOffset: () => {
      get().setOffset(0);
    },

    setGlobalEnabled: (value) => {
      const state = get();
      if (state.globalEnabled === value) return;

      if (value) {
        // Включили. Режим отмечаем до чтения: активное смещение берётся из
        // общего. Своё ненулевое смещение трека становится общим — ровно то,
        // что раньше делала кнопка «для всех». Нулевое значение общее не
        // затирает: возвращаем запомненное, чтобы оно не потерялось.
        writeGlobalOffsetEnabled(true);
        const current = state.offset;
        const global =
          current !== 0 ? writeGlobalLyricsOffset(current) : readLyricsOffset(state.trackId);
        set({ globalEnabled: true, offset: global });
        return;
      }

      // Выключили: активным снова становится своё смещение трека (нет — 0).
      // Общее значение остаётся в localStorage и вернётся при включении.
      writeGlobalOffsetEnabled(false);
      set({ globalEnabled: false, offset: readLyricsOffset(state.trackId) });
    },

    preload: async (track) => {
      const query = queryOf(track);
      const key = keyOf(query);
      if (!key || (!query.title && !query.artist)) return;
      if (preloaded.has(key)) return; // один раз на трек за сессию
      preloaded.add(key);

      // Текст уже лежит файлом с таймингами — искать заново незачем
      const file = await localFileResult(query);
      if (file?.synced) return;
      // Или он есть в кеше: синхронный кеш закрывает вопрос, обычный —
      // не мешает сходить за синхронным.
      const cached = readCachedLyrics(query);
      if (cached && (hasTimestamps(cached.synced) || (file && hasText(cached)))) return;

      try {
        const result = await requestLyrics(query);
        void remember(query, result, true);
        // Панель и плеер предзагрузка не трогает: она только наполняет кеш и
        // кладёт текст файлом. Промах в журнал не пишем — про него расскажет
        // открытие панели.
      } catch (error) {
        // Сбой предзагрузки — только журнал: пользователь о ней не просил
        logError(
          "Не удалось предзагрузить текст песни",
          labelOf(query),
          "текст",
          errorText(error)
        );
      }
    },
  };
});

/**
 * Трек сменился — сбрасываем текст прошлого. Вызывается из плеера.
 * Если панель открыта, текст нового трека подгружается сразу.
 */
export function syncLyricsTrack(track: Track | undefined): void {
  const state = useLyricsStore.getState();
  const id = track?.id ?? null;

  if (state.trackId === id) return; // тот же трек — ничего не делаем
  state.reset();
  if (id && state.open) void state.load(track as Track);
}

// ---------- Сохранение текста при скачивании ----------

/** Чем кончилось сохранение текста. Тосты показывает вызывающий. */
export type SaveLyricsStatus = "saved" | "not_found" | "error";

export interface SaveLyricsResult {
  status: SaveLyricsStatus;
  /** Короткая причина ошибки — для тоста и журнала. */
  error?: string;
}

/** Треки, по которым ошибка уже попала в журнал: не чаще одного раза на трек. */
const saveErrorLogged = new Set<string>();

/**
 * Положить текст трека на диск файлом `.lrc` — в том же виде, что панель
 * текста: с таймингами, если источник их отдал.
 *
 * Порядок такой же, как у самой панели: сначала сохранённый файл, потом кеш,
 * и только потом поиск в источниках. Исполнителя и название берём из полей
 * трека (`queryOf`) — для сервисного это карточка, для локального файла теги.
 *
 * Ничего не показывает и не бросает: наружу уходит только результат, а ошибка
 * один раз ложится в журнал (source «текст»).
 */
export async function saveLyricsForTrack(track: Track): Promise<SaveLyricsResult> {
  const query = queryOf(track);
  if (!query.id || (!query.title && !query.artist)) return { status: "not_found" };

  /**
   * Ключ, под которым текст ляжет на диск: единый резолвер. У трека из
   * «Скачанных» в id лежит путь к копии, а текст сохранялся под сервисным id —
   * без резолвера запись и чтение снова разошлись бы.
   */
  const key = lyricsKeyFor(track);

  const failed = (error: unknown): SaveLyricsResult => {
    const text = errorText(error);
    if (!saveErrorLogged.has(key)) {
      saveErrorLogged.add(key);
      logError("Не удалось сохранить текст песни", labelOf(query), "текст", text);
    }
    return {
      status: "error",
      error: error instanceof Error ? error.message : text,
    };
  };

  try {
    // 1. Текст уже лежит файлом — писать повторно нечего. Сырой id нужен
    //    специально: по нему сервис дочитает файл старой версии и перепишет
    //    его под каноническим ключом.
    if (await lyricsLoadLocal(query.id)) return { status: "saved" };

    // 2. Кеш: ответ источника, запомненный при показе панели.
    const cached = readCachedLyrics(query);
    if (cached) {
      const cachedText = cached.synced?.trim() || cached.plain?.trim();
      if (cachedText) {
        const ok = await lyricsSaveLocal(key, cachedText, cached.source ?? null);
        return ok ? { status: "saved" } : failed(new Error("Файл текста не записался"));
      }
    }

    // 3. Источники: тот же запрос, что делает панель текста.
    const result = await requestLyrics(query);
    writeCachedLyrics(query, result);
    const text = result.synced?.trim() || result.plain?.trim();
    if (!text) return { status: "not_found" };
    const ok = await lyricsSaveLocal(key, text, result.source ?? null);
    return ok ? { status: "saved" } : failed(new Error("Файл текста не записался"));
  } catch (error) {
    return failed(error);
  }
}

/**
 * Заголовок тоста после скачивания: что в итоге легло на диск. Отдельная
 * функция, потому что строку показывает и поиск, и библиотека.
 */
export function savedOutcomeTitle(
  trackSaved: boolean,
  lyrics: SaveLyricsStatus | null
): string {
  if (trackSaved && lyrics === "saved") return "Сохранено: трек и текст";
  if (trackSaved) {
    if (lyrics === "not_found") return "Сохранено: только трек (текст не найден в базах)";
    if (lyrics === "error") return "Сохранено: только трек (текст не сохранился)";
    return "Сохранено: только трек";
  }
  if (lyrics === "saved") return "Сохранено: только текст";
  if (lyrics === "not_found") return "Текст не найден в базах";
  if (lyrics === "error") return "Текст не удалось сохранить";
  return "Сохранять нечего";
}
