/**
 * Офлайн-логика без побочных эффектов: по ней плеер решает, можно ли играть
 * трек без интернета, а автокеш — стоит ли сохранять прослушанное.
 *
 * Здесь нет ни обращений к Tauri, ни React: чистые функции можно проверить
 * отдельно и невозможно случайно «сходить в сеть» из места, где её нет.
 * Главное правило: локальная копия важнее сети, и её наличие проверяется
 * до любого запроса ссылки на поток.
 */

/** Режим офлайн-копии. `keep` — копию просили держать офлайн. */
export type OfflineKind = "download" | "cache" | "keep";

/** Режим, в котором копия лежит на диске (без учёта «держу офлайн»). */
export type OfflineBaseKind = "download" | "cache";

/** Что известно о сохранённой копии — те же поля приходят из Rust. */
export interface OfflineEntry {
  /** Исходный идентификатор трека, например «soundcloud:123». */
  trackId: string;
  /** Путь к файлу на диске. */
  path: string;
  kind: OfflineKind;
  baseKind?: OfflineBaseKind;
  kept: boolean;
  /** Размер файла в байтах. */
  size: number;
  /** Дата сохранения в формате RFC3339. */
  savedAt: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number;
  cover: string | null;
}

/** Офлайн-копия как трек для плеера: сервисный трек, играющий с диска. */
export interface OfflineTrack {
  id: string;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number;
  /** Источник остаётся «service»: трек из сервиса, просто играет офлайн. */
  source: "service";
  cover: string | null;
}

/** Что писать в журнал, когда играть нечем и взять неоткуда. */
export const OFFLINE_MISSING_MESSAGE = "Нет интернета и нет сохранённой копии";

/**
 * Ключ сравнения идентификаторов: только строчные латинские буквы и цифры.
 * «soundcloud:123», «soundcloud-123» и «soundcloud_123» — один и тот же трек:
 * раньше имя файла собирали заменой знаков в id, поэтому запись могла не
 * совпасть с идентификатором из очереди или избранного.
 */
export function offlineKey(id: string): string {
  return (id ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Запись по идентификатору трека: сначала точное совпадение, затем по ключу. */
export function findOffline<T extends { trackId: string }>(
  entries: readonly T[],
  trackId: string
): T | null {
  if (!trackId) return null;
  const exact = entries.find((entry) => entry.trackId === trackId);
  if (exact) return exact;
  const key = offlineKey(trackId);
  if (!key) return null;
  return entries.find((entry) => offlineKey(entry.trackId) === key) ?? null;
}

/**
 * Офлайн-копия как трек: идентификатор остаётся тем, который просили, а путь
 * ведёт на локальный файл — плеер играет его через `toPlayableUrl` и в сеть
 * не ходит.
 */
export function offlineTrack(entry: OfflineEntry, requestedId = entry.trackId): OfflineTrack {
  return {
    id: requestedId || entry.trackId,
    path: entry.path,
    title: entry.title?.trim() ? entry.title : entry.trackId,
    artist: entry.artist,
    album: entry.album,
    durationMs: entry.durationMs,
    source: "service",
    cover: entry.cover,
  };
}

/**
 * Есть ли сейчас сеть. В WebView это `navigator.onLine`: когда машина без
 * интернета, ждать ответа сервиса бессмысленно — плеер должен сразу сказать,
 * что играть нечего.
 */
export function hasNetwork(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

/** Похоже ли сообщение на отсутствие сети, а не на отказ сервиса. */
export function looksOffline(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return /failed to fetch|network ?error|load failed|err_(internet|network|name_not_resolved|connection|connection_refused|timed_out|address_unreachable|proxy)|no internet|offline|curl: \((6|7|28)\)|could not resolve|connection (failed|refused|reset)|timed out|оборвал|соединени|не ответил|не получил ответ/i.test(
    text
  );
}

/**
 * Понятный текст ошибки. Если копии нет и связи нет — говорим об этом прямо,
 * а не показываем «сервис не отдал ссылку»: пользователю важно понять, что
 * трек просто не сохранён офлайн.
 */
export function offlineFailureMessage(error: unknown, hasCopy: boolean): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (!hasCopy && (!hasNetwork() || looksOffline(error))) return OFFLINE_MISSING_MESSAGE;
  return text.trim() || "Не удалось включить трек";
}

/** Лимит офлайн-хранилища в байтах. Ноль и меньше — автокеш выключен. */
export function cacheLimitBytes(limitMb: number): number {
  if (!Number.isFinite(limitMb) || limitMb <= 0) return 0;
  return Math.floor(limitMb) * 1024 * 1024;
}

/**
 * Что делать с сервисным треком. Порядок важен и проверяется тестами:
 * 1. сохранённая копия — играем с диска и в сеть не ходим вовсе;
 * 2. свежая ссылка из памяти (кеш на 10 минут) — сеть тоже не нужна;
 * 3. сети нет и копии нет — понятная ошибка вместо ожидания ответа;
 * 4. иначе — идём за ссылкой в сервис.
 */
export type PlaybackDecision =
  | { action: "local"; path: string }
  | { action: "url"; path: string }
  | { action: "network" }
  | { action: "error"; message: string };

export function decideServicePlayback(options: {
  trackId: string;
  /** Записи офлайн-файлов; обычно это offlineStore.list. */
  entries: readonly { trackId: string; path: string }[];
  /** Ссылка из кеша ссылок в памяти, если есть. */
  cachedUrl?: string | null;
  /** Есть ли сеть; по умолчанию спрашиваем navigator. */
  online?: boolean;
}): PlaybackDecision {
  const copy = findOffline(options.entries, options.trackId);
  if (copy && copy.path) return { action: "local", path: copy.path };

  const cached = (options.cachedUrl ?? "").trim();
  if (cached) return { action: "url", path: cached };

  const online = options.online ?? hasNetwork();
  if (!online) return { action: "error", message: OFFLINE_MISSING_MESSAGE };

  return { action: "network" };
}

/**
 * Стоит ли класть прослушанное в кеш: только когда автокеш включён, копии
 * этого трека ещё нет и офлайн-файлы не дошли до лимита.
 */
export function shouldAutoCache(options: {
  enabled: boolean;
  hasCopy: boolean;
  totalBytes: number;
  limitMb: number;
}): boolean {
  if (!options.enabled || options.hasCopy) return false;
  const limit = cacheLimitBytes(options.limitMb);
  if (limit <= 0) return false;
  return Math.max(0, options.totalBytes) < limit;
}

/** Суммарный размер офлайн-файлов по списку записей. */
export function totalOfflineBytes(entries: readonly { size: number }[]): number {
  return entries.reduce((total, entry) => total + (Number.isFinite(entry.size) ? entry.size : 0), 0);
}

/** Короткая подпись режима для интерфейса. */
export function kindLabel(kind: OfflineKind): string {
  if (kind === "download") return "скачано";
  if (kind === "keep") return "держу офлайн";
  return "офлайн-копия";
}

/** Подробное объяснение режима — для подсказки при наведении. */
export function kindHint(kind: OfflineKind): string {
  if (kind === "download") return "Автор разрешил скачивание: это настоящий файл трека";
  if (kind === "keep") return "Копию просили держать офлайн: уборка её не удалит";
  return "Офлайн-копия потока: автор скачивание не разрешил";
}
