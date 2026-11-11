import { create } from "zustand";
import type { Track } from "./playerStore";
import { softDelete, touch } from "./syncMeta";

/**
 * История прослушивания: локально, без сети. Используется на главной
 * («Продолжить слушать», «Недавно слушали») и в статистике профиля.
 *
 * Кроме числа включений (`plays`) запись помнит фактически прослушанные
 * секунды (`seconds`): часы в статистике считаются по ним, а не по
 * «включений × длительность трека». У записей прошлых версий времени нет —
 * за них отвечает `untimedPlays`, и такие включения оцениваются по
 * длительности трека, если она известна (из тегов файла или библиотеки).
 */

const KEY = "music_hub_history";

/** Сколько отметок времени держим на запись: этого хватает для полосок по дням. */
const MAX_RECENT = 60;

export interface HistoryEntry {
  id: string;
  title: string;
  artist: string | null;
  cover: string | null;
  source: "local" | "service";
  path: string;
  /** Сколько раз включали. */
  plays: number;
  /** Когда слушали в последний раз (мс). */
  at: number;
  /**
   * Фактически прослушано, секунды. Накапливает плеер по позиции трека:
   * пауза, перемотка и обрыв потока временем не считаются. Поле
   * необязательное — записи прошлых версий его не знают.
   */
  seconds?: number;
  /** Включения, для которых времени нет: считаем их по длительности трека. */
  untimedPlays?: number;
  /** Длительность трека, мс — основа для оценки включений без учёта времени. */
  durationMs?: number;
  /** Времена последних включений (мс), новые впереди: полоски по дням. */
  recent?: number[];
}

/**
 * Приводим запись к одной форме. Старые записи (без `seconds`) получают ноль
 * измеренных секунд и счётчик включений без времени — иначе их нельзя было бы
 * честно оценить по длительности.
 */
function normalizeEntry(entry: HistoryEntry): HistoryEntry {
  const raw = entry as HistoryEntry & { seconds?: unknown; untimedPlays?: unknown };
  const knowsTime = typeof raw.seconds === "number" && Number.isFinite(raw.seconds);
  const seconds = knowsTime && (raw.seconds as number) > 0 ? (raw.seconds as number) : 0;
  const plays = Math.max(0, Math.round(entry.plays));
  const untimedPlays = !knowsTime
    ? plays
    : typeof raw.untimedPlays === "number" && Number.isFinite(raw.untimedPlays) && raw.untimedPlays > 0
      ? Math.min(Math.round(raw.untimedPlays), plays)
      : 0;
  const durationMs =
    typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs > 0
      ? Math.round(entry.durationMs)
      : undefined;
  const recent = Array.isArray(entry.recent)
    ? entry.recent.filter((stamp) => typeof stamp === "number" && Number.isFinite(stamp)).slice(0, MAX_RECENT)
    : [];
  return {
    ...entry,
    plays,
    seconds,
    untimedPlays,
    durationMs,
    recent: recent.length ? recent : undefined,
  };
}

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    const list = parsed
      .filter((item): item is HistoryEntry => {
        const entry = item as Partial<HistoryEntry>;
        return typeof entry?.id === "string" && typeof entry?.at === "number";
      })
      .map(normalizeEntry);
    // Досчёт записей прошлых версий сохраняем на диск: иначе он повторялся бы
    // при каждом запуске и путался бы с реально прослушанным временем
    const text = JSON.stringify(list.slice(0, 300));
    if (text !== raw) localStorage.setItem(KEY, text);
    return list;
  } catch {
    return [];
  }
}

interface HistoryState {
  entries: HistoryEntry[];
  /** Записывает включение трека. */
  record: (track: Track) => void;
  /**
   * Прибавляет фактически прослушанные секунды к записи. Вызывается плеером
   * по ходу воспроизведения; включения и паузы не трогает.
   */
  addSeconds: (id: string, seconds: number, durationMs?: number) => void;
  clear: () => void;
  /**
   * Синхронизация: отметить запись изменённой во время `atMs` (по умолчанию —
   * сейчас). У истории время изменения уже есть — это поле `at`.
   */
  markChanged: (id: string, atMs?: number) => void;
  /**
   * Синхронизация: слить запись с сервера. Прослушивания не теряются: берём
   * большее число, а карточку — с того устройства, где запись новее.
   */
  applyRemote: (entry: HistoryEntry) => void;
  applyRemoteDelete: (id: string) => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => {
  const save = (entries: HistoryEntry[]) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries.slice(0, 300)));
    } catch {
      // переполнение хранилища не должно ломать плеер
    }
    set({ entries });
  };

  return {
    entries: load(),
    record: (track) => {
      const now = Date.now();
      const existing = get().entries.find((entry) => entry.id === track.id);
      const entry: HistoryEntry = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        cover: track.cover ?? null,
        source: track.source,
        path: track.path,
        plays: (existing?.plays ?? 0) + 1,
        at: now,
        // Измеренное время не обнуляем: оно копится за все включения трека
        seconds: existing?.seconds ?? 0,
        /**
         * Прошлые включения остаются без учёта времени, текущее — уже с ним:
         * `untimedPlays` заполняет `normalizeEntry` при чтении истории.
         */
        untimedPlays: existing?.untimedPlays ?? 0,
        durationMs: track.durationMs > 0 ? Math.round(track.durationMs) : existing?.durationMs,
        recent: [now, ...(existing?.recent ?? [])].slice(0, MAX_RECENT),
      };
      save([entry, ...get().entries.filter((item) => item.id !== track.id)]);
      // Синхронизация: включение трека — это изменение истории
      touch("history", track.id, now);
    },
    addSeconds: (id, seconds, durationMs) => {
      if (!id || !Number.isFinite(seconds) || seconds <= 0) return;
      const entries = get().entries;
      const existing = entries.find((entry) => entry.id === id);
      if (!existing) return;
      const entry: HistoryEntry = {
        ...existing,
        seconds: Math.round(((existing.seconds ?? 0) + seconds) * 10) / 10,
        durationMs:
          durationMs && Number.isFinite(durationMs) && durationMs > 0
            ? Math.round(durationMs)
            : existing.durationMs,
      };
      /**
       * Синхронизацию не будим: строка истории время не переносит (см.
       * `historyPayload` в syncStore), а лишняя отметка гоняла бы круги
       * обмена впустую.
       */
      save(entries.map((item) => (item.id === id ? entry : item)));
    },
    clear: () => {
      const entries = get().entries;
      localStorage.removeItem(KEY);
      set({ entries: [] });
      // Синхронизация: очистка — это удаление всех записей, оставляем надгробия
      for (const entry of entries) softDelete("history", entry.id, null);
    },

    markChanged: (id, atMs) => {
      touch("history", id, atMs);
    },

    applyRemote: (entry) => {
      const entries = get().entries;
      const local = entries.find((item) => item.id === entry.id);
      const merged: HistoryEntry = local
        ? {
            ...local,
            ...normalizeEntry(entry),
            // Пустые поля с чужого устройства не должны затирать наши данные
            path: entry.path || local.path,
            cover: entry.cover ?? local.cover,
            plays: Math.max(local.plays, entry.plays),
            at: Math.max(local.at, entry.at),
            // Время и отметки включений складываем: они могли накопиться здесь
            seconds: Math.max(local.seconds ?? 0, entry.seconds ?? 0),
            untimedPlays: Math.max(local.untimedPlays ?? 0, entry.untimedPlays ?? 0),
            durationMs: entry.durationMs ?? local.durationMs,
            recent: mergeRecent(local.recent, entry.recent),
          }
        : normalizeEntry(entry);
      save([merged, ...entries.filter((item) => item.id !== entry.id)]);
    },

    applyRemoteDelete: (id) => {
      const entries = get().entries;
      if (entries.some((item) => item.id === id)) {
        save(entries.filter((item) => item.id !== id));
      }
    },
  };
});

/** Отметки включений с двух устройств: без дублей, новые впереди. */
function mergeRecent(a?: number[], b?: number[]): number[] | undefined {
  const merged = [...new Set([...(a ?? []), ...(b ?? [])])].sort((x, y) => y - x).slice(0, MAX_RECENT);
  return merged.length ? merged : undefined;
}

/* ------------------------------------------------------------------ */
/* Статистика прослушивания                                            */
/* ------------------------------------------------------------------ */

export interface HistoryDay {
  /** Начало дня по локальным часам (мс). */
  startMs: number;
  /** Сколько включений пришлось на этот день. */
  plays: number;
  /** Сколько минут прослушано за день — среднее время включения записи. */
  minutes: number;
}

export interface HistoryStats {
  /** Всего включений. */
  plays: number;
  /** Уникальных треков в истории. */
  unique: number;
  /** Фактически прослушано, секунды (измерено + оценено по длительности). */
  seconds: number;
  /** Из общего времени — измеренное плеером. */
  measuredSeconds: number;
  /** Из общего времени — досчитанное по длительности трека. */
  estimatedSeconds: number;
  /** То же время в часах: удобно для модели профиля. */
  hours: number;
  topArtist: string | null;
  topArtistPlays: number;
  topTrack: HistoryEntry | null;
  topTrackPlays: number;
  /** Первое прослушивание (мс) — по самым ранним отметкам времени. */
  firstAt: number | null;
  /** Последнее прослушивание (мс). */
  lastAt: number | null;
  /** Полоски по дням: ровно `days` дней, от старого к сегодняшнему. */
  days: HistoryDay[];
}

export interface HistoryStatsOptions {
  /** Окно полосок по дням: 7 или 30. */
  days?: number;
  /** Длительность трека, мс: для локальных файлов её знает библиотека. */
  durationOf?: (entry: HistoryEntry) => number | null;
  /** «Сейчас» — чтобы расчёт можно было проверить тестом. */
  now?: number;
}

/** Длительность трека из записи или из библиотеки: 0 — неизвестна. */
function durationSecondsOf(
  entry: HistoryEntry,
  durationOf?: (entry: HistoryEntry) => number | null
): number {
  const own = entry.durationMs ?? 0;
  if (own > 0) return own / 1000;
  const known = durationOf?.(entry) ?? 0;
  return known > 0 ? known / 1000 : 0;
}

/**
 * Время одной записи: измеренные секунды плюс оценка включений, для которых
 * времени нет. Если длительность неизвестна, оценка нулевая — лучше показать
 * меньше, чем выдумать часы.
 */
export function entryListenSeconds(
  entry: HistoryEntry,
  durationOf?: (entry: HistoryEntry) => number | null
): { measured: number; estimated: number; total: number } {
  const measured = entry.seconds && entry.seconds > 0 ? entry.seconds : 0;
  const untimed = Math.max(0, Math.round(entry.untimedPlays ?? 0));
  const estimated = untimed > 0 ? untimed * durationSecondsOf(entry, durationOf) : 0;
  return { measured, estimated, total: measured + estimated };
}

/** Резолвер длительностей из локальной библиотеки: идентификатор → мс. */
export function durationsFromLibrary(
  tracks: readonly { id: string; durationMs: number }[]
): (entry: HistoryEntry) => number | null {
  const known = new Map(tracks.map((track) => [track.id, track.durationMs]));
  return (entry) => {
    const own = entry.durationMs ?? 0;
    if (own > 0) return own;
    const local = known.get(entry.id) ?? 0;
    return local > 0 ? local : null;
  };
}

function dayStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY_MS = 86_400_000;

/**
 * Живая статистика из истории. Считается по запросу (при изменении истории), а
 * не по таймеру: цифры всегда соответствуют тому, что лежит в сторе.
 */
export function computeHistoryStats(
  entries: HistoryEntry[],
  options: HistoryStatsOptions = {}
): HistoryStats {
  const windowDays = Math.max(1, Math.min(90, Math.round(options.days ?? 7)));
  const now = options.now ?? Date.now();

  const days: HistoryDay[] = [];
  for (let back = windowDays - 1; back >= 0; back -= 1) {
    days.push({ startMs: dayStart(now - back * DAY_MS), plays: 0, minutes: 0 });
  }
  const dayIndex = new Map<number, number>();
  days.forEach((day, index) => {
    if (!dayIndex.has(day.startMs)) dayIndex.set(day.startMs, index);
  });

  const byArtist = new Map<string, number>();
  let plays = 0;
  let measuredSeconds = 0;
  let estimatedSeconds = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let topTrack: HistoryEntry | null = null;
  let topTrackPlays = 0;

  for (const entry of entries) {
    const entryPlays = Math.max(0, Math.round(entry.plays));
    plays += entryPlays;

    const { measured, estimated, total } = entryListenSeconds(entry, options.durationOf);
    measuredSeconds += measured;
    estimatedSeconds += estimated;

    const artist = entry.artist?.trim();
    if (artist) byArtist.set(artist, (byArtist.get(artist) ?? 0) + entryPlays);

    if (
      !topTrack ||
      entryPlays > topTrackPlays ||
      (entryPlays === topTrackPlays && entry.at > topTrack.at)
    ) {
      topTrack = entry;
      topTrackPlays = entryPlays;
    }

    const stamps = entry.recent?.length ? entry.recent : [entry.at];
    const earliest = stamps[stamps.length - 1];
    if (firstAt === null || earliest < firstAt) firstAt = earliest;
    if (lastAt === null || entry.at > lastAt) lastAt = entry.at;

    // Минуты по дням: среднее время одного включения этой записи
    const perPlay = entryPlays > 0 ? total / entryPlays : 0;
    for (const stamp of stamps) {
      const index = dayIndex.get(dayStart(stamp));
      if (index === undefined) continue;
      days[index].plays += 1;
      days[index].minutes += perPlay;
    }
  }

  const topArtist =
    [...byArtist.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))[0] ?? null;
  const seconds = measuredSeconds + estimatedSeconds;

  return {
    plays,
    unique: entries.length,
    seconds,
    measuredSeconds,
    estimatedSeconds,
    hours: seconds / 3600,
    topArtist: topArtist?.[0] ?? null,
    topArtistPlays: topArtist?.[1] ?? 0,
    topTrack,
    topTrackPlays,
    firstAt,
    lastAt,
    days,
  };
}

/** Агрегаты для модели профиля (`ProfileStats`): часы, треки, любимый исполнитель. */
export function statsForProfile(
  entries: HistoryEntry[],
  durationOf?: (entry: HistoryEntry) => number | null
): { hours: number; tracks: number; topArtist: string | null } {
  const stats = computeHistoryStats(entries, { days: 1, durationOf, now: Date.now() });
  return { hours: stats.hours, tracks: stats.unique, topArtist: stats.topArtist };
}

/** Сколько всего прослушиваний и какие исполнители чаще. */
export function historyStats(entries: HistoryEntry[]) {
  const plays = entries.reduce((sum, entry) => sum + entry.plays, 0);
  const byArtist = new Map<string, number>();
  entries.forEach((entry) => {
    const name = entry.artist?.trim();
    if (!name) return;
    byArtist.set(name, (byArtist.get(name) ?? 0) + entry.plays);
  });
  const topArtist = [...byArtist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { plays, unique: entries.length, topArtist };
}
