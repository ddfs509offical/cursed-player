/**
 * Метки синхронизации: когда запись менялась локально и что уже удалено.
 *
 * Сторы остаются источником истины для интерфейса, а этот модуль хранит только
 * служебные отметки времени: без них нельзя понять, что новее — локальная
 * запись или серверная, и что вообще нужно отправить. Отдельный файл без
 * единого импорта из сторов: иначе получился бы цикл «стор → syncStore → стор».
 *
 * Времена здесь — наши собственные (`Date.now()`), а не серверные: сервер
 * проставляет `updated_at` сам, а расхождение часов между устройствами ломало
 * бы сравнение. «Грязная» запись — та, что менялась позже последней удачной
 * синхронизации (`updatedAt[key] > lastSyncAtMs`).
 *
 * Рядом лежат надгробия: снятый лайк или удалённую офлайн-копию нельзя стирать
 * молча — удаление должно уехать на сервер (`deleted: true`), иначе оно
 * вернётся с другого устройства. Надгробие живёт до первой успешной отправки.
 *
 * Область (`scope`) — активный профиль: у каждого профиля свои лайки и своя
 * история синхронизации. Ключ области и есть ключ localStorage.
 */

export type SyncKind = "favorite" | "offline" | "setting" | "playlist" | "history";

/** Все виды записей общей таблицы: всё остальное считаем чужим и не трогаем. */
export const SYNC_KINDS: readonly SyncKind[] = ["favorite", "offline", "setting", "playlist", "history"];

export interface Tombstone {
  kind: SyncKind;
  itemId: string;
  /** Полезная нагрузка удалённой записи: серверу она не нужна, но пусть будет. */
  payload: Record<string, unknown> | null;
  /** Когда запись удалили локально (мс). */
  updatedAtMs: number;
}

export interface SyncMetaState {
  /**
   * Время последнего ЛОКАЛЬНОГО изменения записи по нашим часам, ключ —
   * «kind:itemId». Серверное `updated_at` сюда не попадает: оно живёт только
   * в ответе pull и нужно лишь для решения о конфликте.
   */
  updatedAt: Record<string, number>;
  /** Удалённые записи: уезжают на сервер и только потом забываются. */
  tombstones: Tombstone[];
  /** Время последней успешной синхронизации (мс); 0 — ещё не было. */
  lastSyncAtMs: number;
  /** Офлайн-отметки с других устройств: файла здесь нет, отметка — чужая. */
  remoteOffline: Record<string, Record<string, unknown>>;
}

const PREFIX = "music_hub_sync_meta_";
const SHARED_SCOPE = "shared";

/** Больше тысячи надгробий смысла нет: они копятся только когда нет входа. */
const MAX_TOMBSTONES = 1000;

let scope = SHARED_SCOPE;
let state: SyncMetaState = empty();

function empty(): SyncMetaState {
  return { updatedAt: {}, tombstones: [], lastSyncAtMs: 0, remoteOffline: {} };
}

/** Ключ записи в общей таблице: без него не сходятся строки двух устройств. */
export function keyOf(kind: SyncKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

const KINDS = SYNC_KINDS;

function isTombstone(value: unknown): value is Tombstone {
  const stone = value as Partial<Tombstone>;
  return (
    !!stone &&
    typeof stone.itemId === "string" &&
    typeof stone.updatedAtMs === "number" &&
    KINDS.includes(stone.kind as SyncKind)
  );
}

function read(): SyncMetaState {
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<SyncMetaState>;

    const updatedAt: Record<string, number> = {};
    if (parsed.updatedAt && typeof parsed.updatedAt === "object") {
      for (const [key, value] of Object.entries(parsed.updatedAt)) {
        if (typeof value === "number" && Number.isFinite(value)) updatedAt[key] = value;
      }
    }

    const remoteOffline: Record<string, Record<string, unknown>> = {};
    if (parsed.remoteOffline && typeof parsed.remoteOffline === "object") {
      for (const [key, value] of Object.entries(parsed.remoteOffline)) {
        if (value && typeof value === "object") remoteOffline[key] = value as Record<string, unknown>;
      }
    }

    return {
      updatedAt,
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones.filter(isTombstone) : [],
      lastSyncAtMs:
        typeof parsed.lastSyncAtMs === "number" && Number.isFinite(parsed.lastSyncAtMs)
          ? parsed.lastSyncAtMs
          : 0,
      remoteOffline,
    };
  } catch {
    return empty();
  }
}

function persist(): void {
  try {
    localStorage.setItem(PREFIX + scope, JSON.stringify(state));
  } catch {
    // переполнение хранилища не должно ломать ни лайки, ни плеер
  }
}

/** Переключить область на профиль: у каждого профиля свои метки времени. */
export function setMetaScope(profileId: string | null): void {
  const next = profileId && profileId.trim() ? profileId : SHARED_SCOPE;
  if (next === scope) return;
  scope = next;
  state = read();
}

/** Снимок меток. Менять его напрямую нельзя — только через функции ниже. */
export function snapshotMeta(): SyncMetaState {
  return state;
}

export function updatedAtOf(kind: SyncKind, itemId: string): number | undefined {
  return state.updatedAt[keyOf(kind, itemId)];
}

/**
 * Отметить запись изменённой. Живая запись отменяет надгробие: если трек
 * снова лайкнули, удаление отправлять больше не нужно.
 *
 * Время поднимаем как минимум до «последняя синхронизация + 1 мс»: так сбитые
 * назад системные часы не оставят изменение неотправленным навсегда.
 */
export function touch(kind: SyncKind, itemId: string, atMs: number = Date.now()): void {
  const key = keyOf(kind, itemId);
  state.updatedAt[key] = Math.max(atMs, state.lastSyncAtMs + 1);
  state.tombstones = state.tombstones.filter((stone) => keyOf(stone.kind, stone.itemId) !== key);
  persist();
}

/**
 * Мягкое удаление: запись пропадает из интерфейса, но остаётся надгробие —
 * удаление обязано уехать на сервер.
 */
export function softDelete(
  kind: SyncKind,
  itemId: string,
  payload: Record<string, unknown> | null = null,
  atMs: number = Date.now()
): void {
  const key = keyOf(kind, itemId);
  const at = Math.max(atMs, state.lastSyncAtMs + 1);
  state.updatedAt[key] = at;
  state.tombstones = state.tombstones.filter((stone) => keyOf(stone.kind, stone.itemId) !== key);
  state.tombstones.push({ kind, itemId, payload, updatedAtMs: at });
  if (state.tombstones.length > MAX_TOMBSTONES) {
    state.tombstones = state.tombstones.slice(-MAX_TOMBSTONES);
  }
  persist();
}

/** Забыть надгробия, которые уже уехали: после успешной отправки они не нужны. */
export function dropTombstones(notNewerThanMs: number): void {
  const next = state.tombstones.filter((stone) => stone.updatedAtMs > notNewerThanMs);
  if (next.length === state.tombstones.length) return;
  state.tombstones = next;
  persist();
}

/** Запомнить время последней успешной синхронизации. */
export function commitSync(atMs: number): void {
  state.lastSyncAtMs = atMs;
  persist();
}

/** Офлайн-отметка с другого устройства: файла здесь нет, отметка остаётся. */
export function markRemoteOffline(itemId: string, payload: Record<string, unknown> | null): void {
  if (payload) state.remoteOffline[itemId] = payload;
  else delete state.remoteOffline[itemId];
  persist();
}
