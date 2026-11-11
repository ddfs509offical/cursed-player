import { create } from "zustand";
import { favoriteKeyFor, isServiceFavoriteKey } from "../lib/favoriteKey";
import { softDelete, touch } from "./syncMeta";

/**
 * Лайки: списки хранятся отдельно для каждого профиля, поэтому у Артёма
 * и @developer они свои.
 *
 * Раньше в localStorage лежали только идентификаторы треков. Из-за этого
 * треки из сервиса после перезапуска нельзя было показать (негде взять
 * название и обложку) и нельзя было включить: ссылка на поток успевает
 * истечь. Теперь храним полную карточку, а старый формат переносим на месте.
 */

export interface FavoriteTrack {
  /** Для локальных файлов это путь, для сервисных — «сервис:id». */
  id: string;
  title: string;
  artist: string | null;
  cover: string | null;
  source: "local" | "service";
  /** Локальный путь; для сервисных — пустая строка (ссылку даёт плеер). */
  path: string;
}

const PREFIX = "music_hub_favorites_";

/** Имя файла без расширения: заголовок для лайка старого формата. */
function titleFromPath(value: string): string {
  const name = value.split(/[\\/]/).pop() ?? value;
  return name.replace(/\.[^.]+$/, "") || value;
}

/**
 * Карточка лайка в каноническом виде: id — единый ключ трека, `source` и `path`
 * выведены из него. Один и тот же трек, добавленный из разных списков, даёт
 * одну и ту же карточку, поэтому лайк не двоится.
 */
function normalizeFavorite(item: FavoriteTrack): FavoriteTrack {
  const id = favoriteKeyFor(item);
  const service = isServiceFavoriteKey(id);
  const title = item.title?.trim() ? item.title : "";
  return {
    id,
    // Название, оставшееся от старого ключа, заменяем на сам ключ: пустая
    // строка тут хуже — карточка должна быть читаемой
    title: title && title !== item.id ? title : service ? id : titleFromPath(id),
    artist: typeof item.artist === "string" ? item.artist : null,
    cover: typeof item.cover === "string" ? item.cover : null,
    source: service ? "service" : "local",
    // У сервисного ссылка на поток не хранится: её выдаёт плеер перед стартом
    path: service ? "" : item.path || id,
  };
}

/** Отличается ли карточка от того, что лежит в хранилище. */
function sameFavorite(a: FavoriteTrack, b: FavoriteTrack): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.cover === b.cover &&
    a.source === b.source &&
    a.path === b.path
  );
}

/**
 * Слияние двух карточек одного трека: id один, а метаданные берём самые полные.
 * Нужно для миграции: старая версия клала один трек под двумя ключами
 * (сервисным и путём к офлайн-копии).
 */
function mergeFavorite(a: FavoriteTrack, b: FavoriteTrack): FavoriteTrack {
  const titleIsId = (card: FavoriteTrack) => !card.title || card.title === card.id;
  return {
    ...a,
    title: titleIsId(a) && !titleIsId(b) ? b.title : a.title,
    artist: a.artist ?? b.artist,
    cover: a.cover ?? b.cover,
    path: a.path || b.path,
  };
}

/**
 * Приведение списка к каноническим ключам с слиянием дублей. Возвращает ещё и
 * признак «что-то изменилось», чтобы однократно перезаписать хранилище.
 */
function canonicalFavorites(items: FavoriteTrack[]): { items: FavoriteTrack[]; changed: boolean } {
  const result: FavoriteTrack[] = [];
  const positions = new Map<string, number>();
  let changed = false;

  for (const item of items) {
    const card = normalizeFavorite(item);
    if (!sameFavorite(card, item)) changed = true;
    const at = positions.get(card.id);
    if (at === undefined) {
      positions.set(card.id, result.length);
      result.push(card);
      continue;
    }
    // Тот же трек под другим ключом: сливаем в один, лайк не теряется
    result[at] = mergeFavorite(result[at], card);
    changed = true;
  }
  return { items: result, changed };
}

/**
 * Один элемент хранилища в карточку. Строка — это старый формат
 * («soundcloud:123» или локальный путь), объект — новый. И то, и другое сразу
 * приводится к каноническому ключу.
 */
function toFavorite(value: unknown): FavoriteTrack | null {
  if (typeof value === "string") {
    return normalizeFavorite({
      id: value,
      title: "",
      artist: null,
      cover: null,
      source: "local",
      path: "",
    });
  }
  if (value && typeof value === "object") {
    const item = value as Partial<FavoriteTrack>;
    if (typeof item.id !== "string" || !item.id) return null;
    const source = item.source === "service" ? "service" : "local";
    return normalizeFavorite({
      id: item.id,
      title: typeof item.title === "string" && item.title ? item.title : item.id,
      artist: typeof item.artist === "string" ? item.artist : null,
      cover: typeof item.cover === "string" ? item.cover : null,
      source,
      path: typeof item.path === "string" ? item.path : source === "local" ? item.id : "",
    });
  }
  return null;
}

function read(profileId: string | null): FavoriteTrack[] {
  if (!profileId) return [];
  try {
    const raw = localStorage.getItem(PREFIX + profileId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const stored = parsed.map(toFavorite).filter((item): item is FavoriteTrack => item !== null);
    // Однократная миграция: старый формат строк и дубли одного трека под
    // разными ключами сливаем здесь же, чтобы дальше хранилище было чистым
    const { items, changed } = canonicalFavorites(stored);
    if (changed || parsed.some((item) => typeof item === "string")) write(profileId, items);
    return items;
  } catch {
    return [];
  }
}

function write(profileId: string, items: FavoriteTrack[]) {
  try {
    localStorage.setItem(PREFIX + profileId, JSON.stringify(items));
  } catch {
    // переполнение хранилища не должно ломать лайки в текущей сессии
  }
}

/** Карточка лайка в том виде, в каком она уезжает в общую таблицу. */
export function cardPayload(track: FavoriteTrack): Record<string, unknown> {
  return { title: track.title, artist: track.artist, cover: track.cover, source: track.source };
}

/**
 * Любая карточка трека (или её часть) превращается в запись избранного.
 * Ключом становится единый ключ лайка (`favoriteKeyFor`), а не сырой id: строка
 * из очереди или из офлайн-копии приходит путём к файлу кеша, и без приведения
 * лайк того же трека уезжал в отдельную запись.
 */
export function favoriteTrackFrom(track: Partial<FavoriteTrack> & { id: string }): FavoriteTrack {
  const id = favoriteKeyFor({ id: track.id, path: track.path, source: track.source });
  const service = isServiceFavoriteKey(id) || track.source === "service";
  const source: FavoriteTrack["source"] = service ? "service" : "local";
  const artist = typeof track.artist === "string" && track.artist ? track.artist : null;
  const cover = typeof track.cover === "string" && track.cover ? track.cover : null;
  return {
    id,
    title: track.title?.trim() ? track.title : source === "local" ? titleFromPath(id) : id,
    artist,
    cover,
    source,
    path: source === "local" ? track.path || id : "",
  };
}

interface FavoritesState {
  profileId: string | null;
  items: FavoriteTrack[];
  /** Идентификаторы избранного — производное поле для старых вызовов. */
  ids: string[];
  load: (profileId: string | null) => void;
  toggle: (track: FavoriteTrack) => boolean;
  has: (id: string) => boolean;
  remove: (id: string) => void;
  /**
   * Обновляет карточки с теми же id (например, когда у старого лайка
   * появились настоящее название, исполнитель и обложка).
   */
  update: (tracks: FavoriteTrack[]) => void;
  clear: () => void;
  /**
   * Синхронизация: отметить лайк изменённым во время `atMs` (по умолчанию —
   * сейчас). Зовётся из `toggle`, `remove` и `clear`, вручную нужна редко.
   */
  markChanged: (id: string, atMs?: number) => void;
  /** Синхронизация: применить карточку с сервера (серверная версия новее). */
  applyRemote: (track: FavoriteTrack) => void;
  /**
   * Синхронизация: снять лайк по серверному удалению. Надгробие не создаём —
   * удаление уже есть в общей таблице, отправлять обратно нечего.
   */
  applyRemoteDelete: (id: string) => void;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  profileId: null,
  items: [],
  ids: [],

  load: (profileId) => {
    if (get().profileId === profileId) return;
    const items = read(profileId);
    set({ profileId, items, ids: items.map((item) => item.id) });
  },

  toggle: (track) => {
    const { items, profileId } = get();
    // Ключ приводим к каноническому ещё раз: сюда может прийти строка из
    // очереди или из офлайн-копии, где id — путь к файлу кеша
    const card = normalizeFavorite(track);
    const liked = items.some((item) => item.id === card.id);
    const next = liked ? items.filter((item) => item.id !== card.id) : [...items, card];
    if (profileId) write(profileId, next);
    set({ items: next, ids: next.map((item) => item.id) });
    // Синхронизация: снятый лайк не стираем молча — оставляем надгробие,
    // чтобы удаление уехало на сервер и не вернулось с другого устройства
    if (liked) softDelete("favorite", card.id, cardPayload(card));
    else touch("favorite", card.id);
    return !liked;
  },

  has: (id) => get().ids.includes(favoriteKeyFor(id)),

  remove: (id) => {
    const { items, profileId } = get();
    const key = favoriteKeyFor(id);
    const removed = items.find((item) => item.id === key);
    if (!removed) return;
    const next = items.filter((item) => item.id !== key);
    if (profileId) write(profileId, next);
    set({ items: next, ids: next.map((item) => item.id) });
    softDelete("favorite", key, cardPayload(removed));
  },

  update: (tracks) => {
    const { items, profileId } = get();
    if (!tracks.length) return;
    const fresh = new Map(tracks.map((track) => [favoriteKeyFor(track), track]));
    let changed = false;
    const next = items.map((item) => {
      const track = fresh.get(item.id);
      if (!track) return item;
      changed = true;
      // Пустые поля из ответа не должны затирать то, что уже было
      return {
        ...item,
        title: track.title?.trim() ? track.title : item.title,
        artist: track.artist ?? item.artist,
        cover: track.cover ?? item.cover,
        source: track.source,
        path: track.path || item.path,
      };
    });
    if (!changed) return;
    if (profileId) write(profileId, next);
    set({ items: next, ids: next.map((item) => item.id) });
  },

  clear: () => {
    const { profileId, items } = get();
    if (profileId) localStorage.removeItem(PREFIX + profileId);
    set({ items: [], ids: [] });
    // Синхронизация: «убрать всё» — это тоже удаление, и оно должно уехать
    for (const item of items) softDelete("favorite", item.id, cardPayload(item));
  },

  markChanged: (id, atMs) => {
    touch("favorite", id, atMs);
  },

  applyRemote: (track) => {
    const { items, profileId } = get();
    // Серверная карточка могла прийти со старого устройства, где ключ был
    // записан путём к офлайн-копии или через «_»
    const card = normalizeFavorite(track);
    const known = items.some((item) => item.id === card.id);
    const next = known
      ? items.map((item) => (item.id === card.id ? card : item))
      : [...items, card];
    if (profileId) write(profileId, next);
    set({ items: next, ids: next.map((item) => item.id) });
    // Время локального изменения не трогаем: карточка пришла с сервера и
    // «грязной» от этого быть не должна
  },

  applyRemoteDelete: (id) => {
    const { items, profileId } = get();
    const key = favoriteKeyFor(id);
    if (items.some((item) => item.id === key)) {
      const next = items.filter((item) => item.id !== key);
      if (profileId) write(profileId, next);
      set({ items: next, ids: next.map((item) => item.id) });
    }
  },
}));
