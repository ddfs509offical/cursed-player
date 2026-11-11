import { create } from "zustand";
import { serviceFromTrackId } from "../lib/services";
import { softDelete, touch } from "./syncMeta";
import { useProfileStore } from "./profileStore";
import type { Track } from "./playerStore";

/**
 * Плейлисты пользователя. Список хранится отдельно для каждого профиля —
 * так же, как лайки: у Артёма и @developer свои плейлисты.
 *
 * В самом плейлисте лежат только идентификаторы треков. Название, исполнитель,
 * обложка и длительность держатся рядом, в общей картотеке треков: без неё
 * после перезапуска сервисный трек показывался бы как «soundcloud:123», а
 * ссылку на поток всё равно приходится спрашивать заново (она истекает),
 * поэтому в плейлисте ссылок нет.
 *
 * Синхронизация: каждая правка отмечается через `syncMeta` (kind «playlist»,
 * item_id — идентификатор плейлиста), а `playlistPayload` отдаёт полезную
 * нагрузку в том виде, в каком она уезжает в облако.
 */

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  cover?: string | null;
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Карточка трека плейлиста: всё, что нужно строке списка и плееру. */
export interface PlaylistTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number;
  cover: string | null;
  source: Track["source"];
  /** Локальный путь; у сервисного трека пусто — свежую ссылку выдаёт плеер. */
  path: string;
}

const PREFIX = "music_hub_playlists_";
const CARDS_PREFIX = "music_hub_playlist_cards_";

/** Идентификатор плейлиста: у каждого профиля он свой, совпадений не боимся. */
function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  );
}

function toPlaylist(value: unknown): Playlist | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Playlist>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Плейлист";
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  return {
    id: raw.id,
    name,
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description : undefined,
    cover: typeof raw.cover === "string" && raw.cover ? raw.cover : null,
    trackIds: Array.isArray(raw.trackIds)
      ? [...new Set(raw.trackIds.filter((id): id is string => typeof id === "string" && !!id))]
      : [],
    createdAt,
    updatedAt:
      typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

function read(profileId: string | null): Playlist[] {
  if (!profileId) return [];
  try {
    const raw = localStorage.getItem(PREFIX + profileId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(toPlaylist).filter((item): item is Playlist => item !== null);
  } catch {
    return [];
  }
}

function write(profileId: string | null, items: Playlist[]): void {
  if (!profileId) return;
  try {
    localStorage.setItem(PREFIX + profileId, JSON.stringify(items));
  } catch {
    // переполнение хранилища не должно ломать плейлисты в текущей сессии
  }
}

/** Карточка трека из localStorage: битые и чужие записи пропускаем. */
function toCard(value: unknown): PlaylistTrack | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PlaylistTrack>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const source: PlaylistTrack["source"] = raw.source === "service" ? "service" : "local";
  return {
    id: raw.id,
    title: typeof raw.title === "string" && raw.title ? raw.title : raw.id,
    artist: typeof raw.artist === "string" && raw.artist ? raw.artist : null,
    album: typeof raw.album === "string" && raw.album ? raw.album : null,
    durationMs: typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) ? raw.durationMs : 0,
    cover: typeof raw.cover === "string" && raw.cover ? raw.cover : null,
    source,
    path: typeof raw.path === "string" ? raw.path : source === "local" ? raw.id : "",
  };
}

function readCards(profileId: string | null): Record<string, PlaylistTrack> {
  if (!profileId) return {};
  try {
    const raw = localStorage.getItem(CARDS_PREFIX + profileId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const cards: Record<string, PlaylistTrack> = {};
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      const card = toCard(value);
      if (card) cards[card.id] = card;
    }
    return cards;
  } catch {
    return {};
  }
}

function writeCards(profileId: string | null, cards: Record<string, PlaylistTrack>): void {
  if (!profileId) return;
  try {
    localStorage.setItem(CARDS_PREFIX + profileId, JSON.stringify(cards));
  } catch {
    // картотека — вспомогательная: без неё плейлисты всё равно работают
  }
}

/** Трек из плеера или библиотеки в карточку плейлиста. */
export function cardFromTrack(track: Track | PlaylistTrack): PlaylistTrack {
  // Идентификатор вида «soundcloud:123» важнее поля source: он не врёт
  const source: PlaylistTrack["source"] =
    track.source === "service" || serviceFromTrackId(track.id) ? "service" : "local";
  const path = typeof track.path === "string" ? track.path : "";
  return {
    id: track.id,
    title: track.title?.trim() ? track.title : track.id,
    artist: typeof track.artist === "string" && track.artist ? track.artist : null,
    album: typeof track.album === "string" && track.album ? track.album : null,
    durationMs: typeof track.durationMs === "number" && Number.isFinite(track.durationMs) ? track.durationMs : 0,
    cover: typeof track.cover === "string" && track.cover ? track.cover : null,
    source,
    // Ссылка на поток сервиса живёт недолго — в карточке её не храним
    path: source === "local" ? path || track.id : "",
  };
}

/**
 * Слить новую карточку со старой: непустые поля новой важнее, но название,
 * которое выглядит как идентификатор, никогда не затирает настоящее имя.
 */
export function mergeTrackCard(previous: PlaylistTrack | undefined, incoming: PlaylistTrack): PlaylistTrack {
  if (!previous) return incoming;
  const incomingTitleIsId = !incoming.title || incoming.title === incoming.id;
  return {
    id: incoming.id,
    title: incomingTitleIsId ? previous.title : incoming.title,
    artist: incoming.artist ?? previous.artist,
    album: incoming.album ?? previous.album,
    durationMs: incoming.durationMs > 0 ? incoming.durationMs : previous.durationMs,
    cover: incoming.cover ?? previous.cover,
    source: incoming.source,
    path: incoming.path || previous.path,
  };
}

function cardChanged(a: PlaylistTrack, b: PlaylistTrack): boolean {
  return (
    a.title !== b.title ||
    a.artist !== b.artist ||
    a.album !== b.album ||
    a.durationMs !== b.durationMs ||
    a.cover !== b.cover ||
    a.source !== b.source ||
    a.path !== b.path
  );
}

/** Нагрузка плейлиста для облака: kind «playlist», item_id — id плейлиста. */
export function playlistPayload(playlist: Playlist): Record<string, unknown> {
  return {
    name: playlist.name,
    description: playlist.description ?? null,
    cover: playlist.cover ?? null,
    trackIds: [...playlist.trackIds],
  };
}

interface PlaylistsState {
  profileId: string | null;
  items: Playlist[];
  /** Общая картотека треков: id → название, исполнитель, обложка, длительность. */
  cards: Record<string, PlaylistTrack>;

  /** Читает плейлисты профиля (лениво, как favoritesStore.load). */
  load: (profileId: string | null) => void;

  create: (name: string, description?: string) => Playlist;
  rename: (id: string, name: string) => void;
  update: (id: string, patch: { name?: string; description?: string; cover?: string | null }) => void;
  remove: (id: string) => void;

  /** Возвращает true, если трек действительно добавлен (повтор — false). */
  addTrack: (id: string, track: string | PlaylistTrack) => boolean;
  /** Сколько треков добавилось на самом деле. */
  addTracks: (id: string, tracks: Array<string | PlaylistTrack>) => number;
  removeTrack: (id: string, trackId: string) => void;
  /** Есть — убрать, нет — добавить. Возвращает новое состояние «в плейлисте». */
  toggleTrack: (id: string, track: string | PlaylistTrack) => boolean;
  /** Перестановка треков: `from` и `to` — индексы в списке плейлиста. */
  reorder: (id: string, from: number, to: number) => void;

  has: (id: string, trackId: string) => boolean;
  /** Дописать карточки треков (после добавления, догрузки метаданных и т. п.). */
  rememberTracks: (tracks: PlaylistTrack[]) => void;

  /** Синхронизация: плейлист пришёл с сервера (серверная версия новее). */
  applyRemote: (playlist: Playlist) => void;
  /** Синхронизация: плейлист удалён на другом устройстве. */
  applyRemoteDelete: (id: string) => void;
}

export const usePlaylistsStore = create<PlaylistsState>((set, get) => {
  /** Сохранить список: и в состояние, и в localStorage текущего профиля. */
  function save(items: Playlist[]): void {
    write(get().profileId, items);
    set({ items });
  }

  /** Пометить плейлист изменённым: время в объекте и метка для синхронизации. */
  function stamp(playlist: Playlist, atMs: number = Date.now()): Playlist {
    touch("playlist", playlist.id, atMs);
    return { ...playlist, updatedAt: atMs };
  }

  /** Изменить один плейлист: `change` возвращает null, если менять нечего. */
  function patch(id: string, change: (playlist: Playlist) => Playlist | null): void {
    const { items } = get();
    let changed = false;
    const next = items.map((playlist) => {
      if (playlist.id !== id) return playlist;
      const result = change(playlist);
      if (!result) return playlist;
      changed = true;
      return result;
    });
    if (changed) save(next);
  }

  /** Выбросить карточки треков, на которые больше не ссылается ни один плейлист. */
  function pruneCards(items: Playlist[]): void {
    const { cards } = get();
    const used = new Set<string>();
    for (const playlist of items) for (const trackId of playlist.trackIds) used.add(trackId);
    const next: Record<string, PlaylistTrack> = {};
    let changed = false;
    for (const [id, card] of Object.entries(cards)) {
      if (used.has(id)) next[id] = card;
      else changed = true;
    }
    if (!changed) return;
    writeCards(get().profileId, next);
    set({ cards: next });
  }

  return {
    profileId: null,
    items: [],
    cards: {},

    load: (profileId) => {
      if (get().profileId === profileId) return;
      set({ profileId, items: read(profileId), cards: readCards(profileId) });
    },

    create: (name, description) => {
      const trimmed = name.trim() || "Новый плейлист";
      const note = description?.trim();
      const now = Date.now();
      const playlist: Playlist = {
        id: newId(),
        name: trimmed,
        description: note ? note : undefined,
        cover: null,
        trackIds: [],
        createdAt: now,
        updatedAt: now,
      };
      touch("playlist", playlist.id, now);
      save([...get().items, playlist]);
      return playlist;
    },

    rename: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      patch(id, (playlist) => (playlist.name === trimmed ? null : stamp({ ...playlist, name: trimmed })));
    },

    update: (id, change) => {
      patch(id, (playlist) => {
        const name = change.name !== undefined ? change.name.trim() || playlist.name : playlist.name;
        const description =
          change.description !== undefined
            ? change.description.trim() || undefined
            : playlist.description;
        const cover = change.cover !== undefined ? change.cover : playlist.cover ?? null;
        if (name === playlist.name && description === playlist.description && cover === (playlist.cover ?? null)) {
          return null;
        }
        return stamp({ ...playlist, name, description, cover });
      });
    },

    remove: (id) => {
      const { items } = get();
      const found = items.find((playlist) => playlist.id === id);
      if (!found) return;
      // Удаление уезжает в облако надгробием: иначе вернётся с другого устройства
      softDelete("playlist", id, playlistPayload(found));
      const next = items.filter((playlist) => playlist.id !== id);
      save(next);
      pruneCards(next);
    },

    addTrack: (id, track) => {
      const trackId = typeof track === "string" ? track : track.id;
      if (!trackId) return false;
      if (typeof track !== "string") get().rememberTracks([track]);
      let added = false;
      patch(id, (playlist) => {
        if (playlist.trackIds.includes(trackId)) return null;
        added = true;
        return stamp({ ...playlist, trackIds: [...playlist.trackIds, trackId] });
      });
      return added;
    },

    addTracks: (id, tracks) => {
      const cards = tracks.filter((track): track is PlaylistTrack => typeof track !== "string");
      if (cards.length) get().rememberTracks(cards);
      const ids = tracks.map((track) => (typeof track === "string" ? track : track.id)).filter((trackId) => !!trackId);
      if (!ids.length) return 0;
      let added = 0;
      patch(id, (playlist) => {
        const next = [...playlist.trackIds];
        for (const trackId of ids) {
          if (next.includes(trackId)) continue;
          next.push(trackId);
          added += 1;
        }
        if (!added) return null;
        return stamp({ ...playlist, trackIds: next });
      });
      return added;
    },

    removeTrack: (id, trackId) => {
      patch(id, (playlist) =>
        playlist.trackIds.includes(trackId)
          ? stamp({ ...playlist, trackIds: playlist.trackIds.filter((item) => item !== trackId) })
          : null
      );
      pruneCards(get().items);
    },

    toggleTrack: (id, track) => {
      const trackId = typeof track === "string" ? track : track.id;
      if (!trackId) return false;
      if (get().has(id, trackId)) {
        get().removeTrack(id, trackId);
        return false;
      }
      return get().addTrack(id, track);
    },

    reorder: (id, from, to) => {
      patch(id, (playlist) => {
        const ids = [...playlist.trackIds];
        if (from === to) return null;
        if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return null;
        const [moved] = ids.splice(from, 1);
        if (moved === undefined) return null;
        ids.splice(to, 0, moved);
        return stamp({ ...playlist, trackIds: ids });
      });
    },

    has: (id, trackId) => get().items.find((playlist) => playlist.id === id)?.trackIds.includes(trackId) ?? false,

    rememberTracks: (tracks) => {
      if (!tracks.length) return;
      const { cards } = get();
      const next = { ...cards };
      let changed = false;
      for (const track of tracks) {
        if (!track?.id) continue;
        const merged = mergeTrackCard(next[track.id], track);
        if (!next[track.id] || cardChanged(next[track.id], merged)) {
          next[track.id] = merged;
          changed = true;
        }
      }
      if (!changed) return;
      writeCards(get().profileId, next);
      set({ cards: next });
    },

    applyRemote: (playlist) => {
      const { items } = get();
      const next = items.some((item) => item.id === playlist.id)
        ? items.map((item) => (item.id === playlist.id ? playlist : item))
        : [...items, playlist];
      save(next);
      // Время локального изменения не трогаем: плейлист пришёл с сервера и
      // «грязным» от этого быть не должен
    },

    applyRemoteDelete: (id) => {
      const { items } = get();
      if (items.some((playlist) => playlist.id === id)) {
        const next = items.filter((playlist) => playlist.id !== id);
        save(next);
        pruneCards(next);
      }
      // Надгробие не создаём: удаление уже есть в облаке, отправлять нечего
    },
  };
});

/**
 * Прочитать плейлисты активного профиля. Нужно местам, которые показывают
 * плейлисты до открытия страницы «Плейлисты» (например, «Добавить в плейлист»
 * на странице библиотеки).
 */
export function ensurePlaylistsLoaded(): void {
  usePlaylistsStore.getState().load(useProfileStore.getState().activeId);
}
