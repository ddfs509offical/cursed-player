/**
 * Текст песни: запрос к цепочке источников через Rust-команду, разбор LRC и
 * локальный кеш.
 *
 * Источники (Rust перебирает их по порядку): LRCLIB → Netease Cloud Music →
 * Genius → api.lyrics.ovh. Синхронный текст (LRC) важнее обычного, поэтому
 * подсветка строк включается, только если источник отдал метки времени. Поле
 * `source` говорит, откуда пришёл текст: «lrclib», «netease», «genius» или
 * «lyrics.ovh».
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./profiles";
import { lyricsKeyFor, lyricsOfflinePath } from "../lib/lyricsKey";

/** Ответ Rust-команды `lyrics_fetch` (serde camelCase). */
export interface LyricsResult {
  found: boolean;
  /** LRC-текст с метками времени, если он есть у источника. */
  synced: string | null;
  /** Обычный текст без времени. */
  plain: string | null;
  /** Источник текста: «lrclib», «netease», «genius» или «lyrics.ovh». */
  source: string | null;
  title: string | null;
  artist: string | null;
  /**
   * Название найденной записи, по которому прошла строгая проверка
   * соответствия. Видно в журнале: если подобралось не то, здесь окажется
   * чужая песня, а не запрос плеера.
   */
  matchedTitle?: string | null;
  /** Исполнитель найденной записи — та же проверка, то же назначение. */
  matchedArtist?: string | null;
  /**
   * Текст взят у оригинала, а не у той версии, что играет: в плеере может быть
   * «speed up», реверб или коллаж из нескольких песен, а в базе нашлась только
   * исходная запись (или одна из частей коллажа). Панель показывает это честной
   * подписью «Текст от оригинала: <исполнитель> — <название>».
   */
  fromOriginal?: boolean | null;
  /**
   * Время строк посчитано приложением по длине текста, а не взято у источника
   * (Genius синхронного текста не отдаёт). Подсветка работает, но панель честно
   * пишет «тайминг примерный».
   */
  estimated?: boolean | null;
  /**
   * Все найденные варианты (LRCLIB, Netease, Genius, lyrics.ovh): 0-й — лучший.
   * Если источники нашли разное, панель даёт переключиться на нужный текст.
   */
  variants?: LyricsVariant[] | null;
  /**
   * Что пробовал Rust, когда текста не нашлось: перечень попадает в журнал
   * ошибок, чтобы промах можно было разобрать без отладчика.
   */
  attempts?: string[] | null;
}

/** Один вариант текста: его источник, подписи и содержимое. */
export interface LyricsVariant {
  source: string;
  title: string | null;
  artist: string | null;
  synced: string | null;
  plain: string | null;
  estimated: boolean;
  fromOriginal: boolean;
  matchedTitle?: string | null;
  matchedArtist?: string | null;
}

/** Одна строка текста: с временем (синхронный текст) или без него. */
export interface LyricLine {
  /** Время появления строки в миллисекундах; null — строка без времени. */
  atMs: number | null;
  text: string;
}

/** Что нужно для поиска: id трека (ключ кеша) и теги. */
export interface LyricsQuery {
  id: string;
  title: string;
  artist: string | null;
  /** Длительность в миллисекундах: по ней источник выбирает нужную версию. */
  durationMs: number;
}

const CACHE_KEY = "music_hub_lyrics";
/**
 * Версия формата кеша. 2 — добавлена строгая проверка соответствия: записи,
 * сделанные до неё, могли содержать текст ЧУЖОЙ песни (именно так приехал
 * «Prettiest Dolphin» из Netease), поэтому старый кеш целиком недействителен.
 */
const CACHE_VERSION = 2;
/**
 * Версия логики поиска. Промах, записанный старой версией, не переиспользуем:
 * иначе треки, которые не нашлись раньше, так и остались бы «не найденными».
 * Удачные записи при этом живут дальше — они верны при любой версии поиска.
 *
 * 4 — источники опрашиваются параллельно и только те записи, что прошли
 * строгую сверку названия, исполнителя и длительности.
 *
 * 5 — точное название принимается и с чужим исполнителем, а производные версии
 * (speed up/reverb) и коллажи ищутся ещё и по оригиналу. Промахи, записанные
 * версией 4, недействительны: именно их поиск и не находил.
 */
const SEARCH_VERSION = 5;
/** Текст песни не меняется: 30 дней — разумный срок жизни записи. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Больше 200 песен в localStorage держать незачем. */
const CACHE_LIMIT = 200;

interface CacheEntry {
  at: number;
  /** Какая версия поиска записала запись (у старых записей её нет). */
  v?: number;
  synced: string | null;
  plain: string | null;
  source: string | null;
  /**
   * Текст найден у оригинала, а не у играющей версии. Вместе с названием и
   * исполнителем записи это нужно подписи в панели: без них предзагруженный из
   * кеша текст выглядел бы как текст самого трека.
   */
  fromOriginal?: boolean;
  matchedTitle?: string | null;
  matchedArtist?: string | null;
}

interface CachePayload {
  version: number;
  entries: Record<string, CacheEntry>;
}

/** Разбор строки с метками времени в массив строк с временем. */
export function parseLrc(lrc: string): LyricLine[] {
  if (!lrc) return [];
  const lines: LyricLine[] = [];

  for (const raw of lrc.split(/\r?\n/)) {
    const marks = extractMarks(raw);
    if (!marks.times.length) continue;
    const text = marks.text.trim();
    // Строка без текста — это разметка вроде [ar:Исполнитель] или пауза,
    // подсвечивать в ней нечего
    if (!text) continue;
    for (const atMs of marks.times) lines.push({ atMs, text });
  }

  return lines.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

/**
 * Обычный текст без времени: строки как есть, пустые убираем.
 * Метки времени, если они случайно оказались в таком тексте, тоже снимаем —
 * иначе пользователь увидел бы «[00:12.00]» прямо в строке.
 */
export function parsePlain(text: string): LyricLine[] {
  if (!text) return [];
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const value = extractMarks(raw).text.trim();
    if (!value) continue;
    lines.push({ atMs: null, text: value });
  }
  return lines;
}

/** Все метки времени строки и её текст без меток. */
function extractMarks(raw: string): { times: number[]; text: string } {
  const times: number[] = [];
  let text = raw;

  // Метка в квадратных скобках: [mm:ss.xx], [mm:ss.xxx], [mm:ss], [hh:mm:ss.xx]
  while (true) {
    const match = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(text);
    if (!match) break;
    const atMs = toMs(match[1], match[2], match[3]);
    if (atMs !== null) times.push(atMs);
    text = text.slice(match[0].length);
  }

  // Вторая форма: 00:12.50 текст (без скобок) — встречается у части файлов
  if (!times.length) {
    const bare = /^\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s+(.+)$/.exec(text);
    if (bare) {
      const atMs = toMs(bare[1], bare[2], bare[3]);
      if (atMs !== null) {
        times.push(atMs);
        text = bare[4];
      }
    }
  }

  // Оставшаяся метка в середине строки («[00:12.00] текст [00:14.00]»)
  if (times.length) text = text.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, " ");

  return { times, text };
}

/** Минуты, секунды и доли в миллисекунды. Некорректная метка — null. */
function toMs(minutes: string, seconds: string, fraction?: string): number | null {
  const min = Number(minutes);
  const sec = Number(seconds);
  if (!Number.isFinite(min) || !Number.isFinite(sec)) return null;
  if (sec > 59) return null;

  let ms = 0;
  if (fraction) {
    // «5» — это 500 мс, «50» — 500 мс, «500» — 500 мс
    ms = Number(fraction.padEnd(3, "0").slice(0, 3));
    if (!Number.isFinite(ms)) ms = 0;
  }
  return Math.round((min * 60 + sec) * 1000 + ms);
}

/**
 * Индекс активной строки: последняя метка, которая уже наступила.
 * `offsetSec` — ручная подстройка синхронизации: положительное значение
 * показывает строки позже звука, отрицательное — раньше.
 */
export function findActiveLine(
  lines: LyricLine[],
  positionSec: number,
  offsetSec = 0
): number {
  if (!lines.length) return -1;
  const at = Math.max(0, positionSec + offsetSec) * 1000;
  // Строки без времени активными не считаем: подсветка только у синхронного
  if (!lines[0] || lines[0].atMs === null) return -1;

  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const stamp = lines[middle]?.atMs ?? 0;
    if (stamp <= at) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Строки для показа: синхронные важнее обычных. */
export function linesOf(result: LyricsResult): LyricLine[] {
  const synced = result.synced ? parseLrc(result.synced) : [];
  if (synced.length) return synced;
  return result.plain ? parsePlain(result.plain) : [];
}

/** Синхронный ли текст: от этого зависит подсветка строк. */
export function isSynced(lines: LyricLine[]): boolean {
  return lines.some((line) => line.atMs !== null);
}

// ---------- Кеш ----------

/**
 * Ключ кеша. id проходит через единый резолвер (`lyricsKeyFor`): иначе ответ,
 * запомненный для `soundcloud:123`, не находился бы для трека из «Скачанных»
 * с id-путём, и панель шла бы в сеть за уже сохранённым текстом.
 */
function cacheKeyOf(query: LyricsQuery): string {
  const id = query.id?.trim();
  if (id) return lyricsKeyFor(id);
  return `${query.artist ?? ""}::${query.title}`.trim().toLowerCase();
}

/**
 * Ключи для чтения кеша: канонический, а затем сырой id. Старые версии писали
 * запись по пути к офлайн-копии — она должна дочитаться, а не потеряться.
 */
function cacheReadKeysOf(query: LyricsQuery): string[] {
  const canonical = cacheKeyOf(query);
  const raw = query.id?.trim();
  return raw && raw !== canonical ? [canonical, raw] : [canonical];
}

function readCache(): CachePayload {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { version: CACHE_VERSION, entries: {} };
    const parsed = JSON.parse(raw) as Partial<CachePayload>;
    if (parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: CACHE_VERSION, entries: {} };
    }
    return { version: CACHE_VERSION, entries: parsed.entries };
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

function writeCache(payload: CachePayload): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Переполнение хранилища не должно ломать показ текста
  }
}

/** Запись из кеша, если она ещё не устарела. */
export function readCachedLyrics(query: LyricsQuery, now = Date.now()): LyricsResult | null {
  const keys = cacheReadKeysOf(query);
  const entries = readCache().entries;
  let entry: CacheEntry | undefined;
  for (const key of keys) {
    entry = key ? entries[key] : undefined;
    if (entry) break;
  }
  if (!entry || typeof entry.at !== "number") return null;
  if (now - entry.at > CACHE_TTL_MS) return null;

  const hasText = Boolean(entry.synced || entry.plain);
  // Старый промах ничего не говорит о новом поиске — спрашиваем источник заново
  if (!hasText && entry.v !== SEARCH_VERSION) return null;

  return {
    found: hasText,
    synced: entry.synced ?? null,
    plain: entry.plain ?? null,
    source: entry.source ?? null,
    title: query.title,
    artist: query.artist,
    fromOriginal: entry.fromOriginal ?? false,
    matchedTitle: entry.matchedTitle ?? null,
    matchedArtist: entry.matchedArtist ?? null,
  };
}

/** Кладём результат в кеш: чистим устаревшее и держим лимит записей. */
export function writeCachedLyrics(
  query: LyricsQuery,
  result: LyricsResult,
  now = Date.now()
): void {
  const key = cacheKeyOf(query);
  if (!key) return;
  const payload = readCache();

  const fresh: Record<string, CacheEntry> = {};
  for (const [id, entry] of Object.entries(payload.entries)) {
    if (now - entry.at <= CACHE_TTL_MS) fresh[id] = entry;
  }
  fresh[key] = {
    at: now,
    v: SEARCH_VERSION,
    synced: result.synced ?? null,
    plain: result.plain ?? null,
    source: result.source ?? null,
    fromOriginal: Boolean(result.fromOriginal),
    matchedTitle: result.matchedTitle ?? null,
    matchedArtist: result.matchedArtist ?? null,
  };

  // Лимит: оставляем самые свежие записи, старые уходят
  const entries = Object.fromEntries(
    Object.entries(fresh)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_LIMIT)
  );
  writeCache({ version: CACHE_VERSION, entries });
}

/** Очистить кеш текстов (например, чтобы найти другой вариант). */
export function clearLyricsCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // нечего чистить
  }
}

// ---------- Смещение синхронизации ----------

/**
 * Ручная подстройка синхронизации: текст часто отстаёт или спешит на полсекунды.
 * Хранится по id трека. Переключатель «Для всех треков» переводит панель в
 * глобальный режим: тогда активным становится общее смещение, а своё значение
 * каждого трека остаётся записанным и возвращается при выключении режима.
 */
const OFFSET_KEY = "music_hub_lyrics_offset";
/** Пределы смещения: ±30 секунд — дальше это уже не подстройка синхрона. */
export const OFFSET_MIN_SEC = -30;
export const OFFSET_MAX_SEC = 30;
/** Шаг подстройки: полсекунды хватает, чтобы попасть в строку. */
export const OFFSET_STEP_SEC = 0.5;

interface OffsetPayload {
  /** Общее смещение: действует, когда включён режим «Для всех треков». */
  global: number;
  /** Смещения по id треков: в глобальном режиме не теряются. */
  tracks: Record<string, number>;
  /**
   * Включён ли режим «Для всех треков». Записи, сделанные до его появления,
   * поля не содержат — тогда режим выключен (разбираем их безопасно).
   */
  globalEnabled: boolean;
}

/** Привести смещение к допустимому диапазону и шагу 0.5 с. */
export function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const stepped = Math.round(value / OFFSET_STEP_SEC) * OFFSET_STEP_SEC;
  const clamped = Math.min(OFFSET_MAX_SEC, Math.max(OFFSET_MIN_SEC, stepped));
  // Точность с плавающей запятой: 0.5 + 0.5 + 0.5 даёт 1.5000000000000002
  return Math.round(clamped * 10) / 10;
}

function readOffsets(): OffsetPayload {
  try {
    const raw = localStorage.getItem(OFFSET_KEY);
    if (!raw) return { global: 0, tracks: {}, globalEnabled: false };
    const parsed = JSON.parse(raw) as Partial<OffsetPayload>;
    const global = clampOffset(Number(parsed?.global) || 0);
    const tracks: Record<string, number> = {};
    if (parsed?.tracks && typeof parsed.tracks === "object") {
      for (const [id, value] of Object.entries(parsed.tracks)) {
        tracks[id] = clampOffset(Number(value) || 0);
      }
    }
    return { global, tracks, globalEnabled: parsed?.globalEnabled === true };
  } catch {
    return { global: 0, tracks: {}, globalEnabled: false };
  }
}

function writeOffsets(payload: OffsetPayload): void {
  try {
    localStorage.setItem(OFFSET_KEY, JSON.stringify(payload));
  } catch {
    // Переполнение хранилища не должно ломать показ текста
  }
}

/**
 * Активное смещение трека.
 *
 * Режим «Для всех треков» включён — действует общее значение. Выключен — своё
 * значение трека, а если его нет, ноль: общее смещение в этом режиме не
 * подставляется, но и не теряется — оно вернётся при повторном включении.
 */
export function readLyricsOffset(trackId?: string | null): number {
  const payload = readOffsets();
  if (payload.globalEnabled) return payload.global;
  const id = trackId?.trim();
  if (!id) return 0;
  const own = payload.tracks[id];
  return typeof own === "number" ? own : 0;
}

/**
 * Какой вариант текста человек выбрал для трека. Хранится по id: возвращаясь к
 * песне, он видит тот же текст, а не снова «лучший по мнению источников».
 */
const VARIANT_KEY = "music_hub_lyrics_variant";

function readVariantMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(VARIANT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const map: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed ?? {})) {
      const index = Number(value);
      if (Number.isInteger(index) && index >= 0) map[id] = index;
    }
    return map;
  } catch {
    return {};
  }
}

/** Выбранный вариант трека; 0 — «как решили источники». */
export function readVariantChoice(trackId?: string | null): number {
  const id = trackId?.trim();
  if (!id) return 0;
  return readVariantMap()[id] ?? 0;
}

/** Запомнить выбранный вариант: 0 — вариант по умолчанию. */
export function writeVariantChoice(trackId: string, index: number): void {
  const id = trackId.trim();
  if (!id) return;
  try {
    const map = readVariantMap();
    if (index <= 0) delete map[id];
    else map[id] = index;
    localStorage.setItem(VARIANT_KEY, JSON.stringify(map));
  } catch {
    // Переполнение хранилища не повод ломать показ текста
  }
}

/** Включён ли режим «Для всех треков» — для переключателя в панели текста. */export function readGlobalOffsetEnabled(): boolean {
  return readOffsets().globalEnabled;
}

/** Запомнить состояние переключателя «Для всех треков». */
export function writeGlobalOffsetEnabled(enabled: boolean): void {
  const payload = readOffsets();
  payload.globalEnabled = enabled;
  writeOffsets(payload);
}

/** Записать смещение конкретного трека. */
export function writeLyricsOffset(trackId: string | null | undefined, value: number): number {
  const id = trackId?.trim();
  const next = clampOffset(value);
  const payload = readOffsets();
  if (!id) {
    payload.global = next;
  } else {
    payload.tracks[id] = next;
  }
  writeOffsets(payload);
  return next;
}

/** Записать общее смещение: так трек можно подстроить сразу для всех. */
export function writeGlobalLyricsOffset(value: number): number {
  return writeLyricsOffset(null, value);
}

/** Забыть смещение трека — снова начнёт действовать общее. */
export function clearLyricsOffset(trackId: string | null | undefined): void {
  const id = trackId?.trim();
  if (!id) return;
  const payload = readOffsets();
  delete payload.tracks[id];
  writeOffsets(payload);
}

/** Подпись смещения: «+1.5 с», «−0.5 с», «0 с». */
export function formatOffset(value: number): string {
  const next = clampOffset(value);
  if (next === 0) return "0 с";
  const sign = next > 0 ? "+" : "−";
  return `${sign}${Math.abs(next).toFixed(1)} с`;
}

// ---------- Запрос ----------

/** Запрос к источникам текста. Приложение отдаёт только то, что нашлось. */
export async function lyricsFetch(
  artist: string,
  title: string,
  durationSec: number
): Promise<LyricsResult> {
  const empty: LyricsResult = {
    found: false,
    synced: null,
    plain: null,
    source: null,
    title: title || null,
    artist: artist || null,
    fromOriginal: false,
  };
  if (!isTauri()) return empty;
  const result = await invoke<LyricsResult>("lyrics_fetch", {
    artist,
    title,
    durationSec: Math.max(0, Math.round(durationSec) || 0),
  });
  return {
    found: Boolean(result?.found),
    synced: result?.synced ?? null,
    plain: result?.plain ?? null,
    source: result?.source ?? null,
    title: result?.title ?? (title || null),
    artist: result?.artist ?? (artist || null),
    matchedTitle: result?.matchedTitle ?? null,
    matchedArtist: result?.matchedArtist ?? null,
    fromOriginal: Boolean(result?.fromOriginal),
    attempts: Array.isArray(result?.attempts) ? result.attempts : [],
  };
}

// ---------- Текст на диске ----------

/**
 * Текст хранится ещё и файлом рядом с офлайн-копией трека
 * (`%APPDATA%\com.example.musichub\lyrics\<id>.lrc`). localStorage переживает
 * не всё, а файл даёт подсветку строк и в офлайне, и после чистки кеша
 * браузера. Запись идёт только из сети — см. `lyricsStore`.
 *
 * Ключ файла — всегда канонический (`lyricsKeyFor`), поэтому он один и тот же
 * и для карточки сервиса, и для её офлайн-копии. Rust строит имя файла из
 * исходного id с хешем, так что разные записи ключа — это разные файлы.
 */

/** Записать/прочитать/удалить файл ровно по этому ключу, без нормализации. */
async function writeLocalKey(
  key: string,
  text: string,
  source: string | null
): Promise<boolean> {
  if (!isTauri()) return false;
  if (!key || !text?.trim()) return false;
  try {
    await invoke("lyrics_save_local", { trackId: key, text, source });
    return true;
  } catch {
    // Диск — не причина ломать показ текста
    return false;
  }
}

async function readLocalKey(key: string): Promise<string | null> {
  if (!isTauri() || !key) return null;
  try {
    const text = await invoke<string | null>("lyrics_load_local", { trackId: key });
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

async function removeLocalKey(key: string): Promise<boolean> {
  if (!isTauri() || !key) return false;
  try {
    await invoke("lyrics_remove_local", { trackId: key });
    return true;
  } catch {
    return false;
  }
}

/**
 * Где ещё может лежать текст этого трека: сырой id (старая версия писала по
 * пути копии) и путь офлайн-копии из реестра (старая версия писала по
 * сервисному id, а читаем по пути — или наоборот). Список нужен только для
 * лечения старых файлов и удаления.
 */
function legacyLocalKeys(raw: string, canonical: string): string[] {
  const keys: string[] = [];
  const push = (value: string | null | undefined) => {
    const key = value?.trim();
    if (!key || key === canonical || keys.includes(key)) return;
    keys.push(key);
  };
  push(raw);
  // Реестр может знать путь копии и тогда, когда к нам пришёл сервисный id
  push(lyricsOfflinePath(canonical));
  return keys;
}

/** Сохранить текст файлом. Тайминги сохраняются, если они есть в тексте. */
export async function lyricsSaveLocal(
  trackId: string,
  text: string,
  source: string | null
): Promise<boolean> {
  if (!isTauri()) return false;
  const key = lyricsKeyFor(trackId);
  if (!key) return false;
  return writeLocalKey(key, text, source);
}

/**
 * Прочитать сохранённый текст. null — файла нет, он пуст или не читается.
 *
 * Сначала канонический ключ. Если там пусто — один раз пробуем «сырые» ключи
 * (путь копии, старый id) и, найдя текст, переписываем его под каноническим:
 * иначе старый файл так и остался бы невидимым для панели. Без сети и без
 * повторных попыток.
 */
export async function lyricsLoadLocal(trackId: string): Promise<string | null> {
  if (!isTauri()) return null;
  const raw = trackId?.trim();
  if (!raw) return null;
  const canonical = lyricsKeyFor(raw);
  if (!canonical) return null;

  const direct = await readLocalKey(canonical);
  if (direct) return direct;

  for (const legacy of legacyLocalKeys(raw, canonical)) {
    const text = await readLocalKey(legacy);
    if (!text) continue;
    // Найденный старый файл переписываем под каноническим ключом: следующее
    // чтение попадёт сразу, а сам файл переживёт и смену ключей в будущем.
    // Источник в старом файле неизвестен — служебную строку не пишем.
    await writeLocalKey(canonical, text, null);
    return text;
  }
  return null;
}

/**
 * Сохранён ли текст файлом. Обёртка над `lyricsLoadLocal` для тех мест, где
 * важен только сам факт «есть или нет» — например, серое состояние вариантов
 * в окне выбора при скачивании.
 */
export async function lyricsHasLocal(trackId: string): Promise<boolean> {
  return (await lyricsLoadLocal(trackId)) !== null;
}

/** Удалить сохранённый текст. Ошибка наружу не выходит. */
export async function lyricsRemoveLocal(trackId: string): Promise<boolean> {
  if (!isTauri()) return false;
  const raw = trackId?.trim();
  if (!raw) return false;
  const canonical = lyricsKeyFor(raw);
  if (!canonical) return false;
  const ok = await removeLocalKey(canonical);
  // Старые файлы под сырым ключом тоже убираем: иначе текст «вернётся»
  for (const legacy of legacyLocalKeys(raw, canonical)) {
    await removeLocalKey(legacy);
  }
  return ok;
}

/**
 * Синхронный ли текст: есть ли хотя бы одна метка времени вида `[mm:ss`.
 * По этому признаку выбирается источник текста: файл или кеш без таймингов
 * уступает синхронному ответу сети.
 */
export function hasTimestamps(text: string | null | undefined): boolean {
  return typeof text === "string" && /\[\d{1,3}:\d{1,2}[.:\]]/.test(text);
}
