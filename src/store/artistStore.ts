/**
 * Окно артиста SoundCloud: кто открыт, профиль, треки и кэш на время сессии.
 *
 * Профиль и первая страница треков остаются в памяти до перезапуска: повторное
 * открытие того же артиста показывает всё сразу и в сеть не ходит. Треки
 * догружаются порциями по 25 тем же способом, что и страницы поиска: сначала
 * спрашиваем порцию у SoundCloud, затем держим её в состоянии — переключение
 * страниц внутри загруженного не делает ни одного запроса.
 *
 * Запросы идут последовательно и с номером попытки: ответ на устаревший вызов
 * (пользователь успел открыть другого артиста или закрыть окно) состояние не
 * меняет.
 */

import { create } from "zustand";
import {
  explainSoundcloudError,
  getServiceToken,
  soundcloudUser,
  soundcloudUserTracks,
  type SearchTrack,
  type SoundcloudUser,
} from "../services/catalog";
import { errorText, logError } from "./errorStore";

/** Размер порции треков артиста: столько же строк показывает страница. */
export const ARTIST_PAGE_SIZE = 25;

/** Что помним про артиста: профиль и всё, что уже загрузили за сессию. */
interface ArtistCache {
  profile: SoundcloudUser;
  tracks: SearchTrack[];
  /** Порций больше нет: размер списка окончательный. */
  exhausted: boolean;
}

/** Кэш на время сессии: ключ — «soundcloud:<ник или id в нижнем регистре>». */
const cache = new Map<string, ArtistCache>();
/** Номер последнего запроса: по нему отсекаем устаревшие ответы. */
let attempt = 0;

/** Ключ артиста: по нему ищем кэш и понимаем, к кому относится ответ. */
export function artistKey(target: string): string {
  return `soundcloud:${target.trim().toLowerCase()}`;
}

/** Склейка порций: один и тот же трек не должен попасть в список дважды. */
function mergeTracks(current: SearchTrack[], batch: SearchTrack[]): SearchTrack[] {
  const seen = new Set(current.map((track) => `${track.service}:${track.id}`));
  const merged = [...current];
  for (const track of batch) {
    const id = `${track.service}:${track.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(track);
  }
  return merged;
}

interface ArtistState {
  /** Окно открыто. */
  open: boolean;
  /** Ключ артиста: «soundcloud:<ник или id>». */
  key: string | null;
  /** Что именно спросили у SoundCloud: ник, id или адрес страницы. */
  target: string | null;
  profile: SoundcloudUser | null;
  /** Загруженные треки: их показываем страницами по 25. */
  tracks: SearchTrack[];
  /** Текущая страница (1..). */
  page: number;
  /** Идёт первая загрузка: показываем скелетоны. */
  loading: boolean;
  /** Идёт догрузка порции: строки-плейсхолдеры, окно не блокируем. */
  loadingMore: boolean;
  /** Человеческое объяснение ошибки сети; null — ошибки нет. */
  error: string | null;
  /** Порций больше нет: значит, число страниц известно. */
  exhausted: boolean;

  /** Открыть окно артиста: имя, числовой id или адрес страницы SoundCloud. */
  openArtist: (target: string) => void;
  close: () => void;
  setPage: (page: number) => void;
  /** Догрузить следующую порцию: шаг вперёд за пределы загруженного. */
  loadMore: () => Promise<void>;
  /** Повторить загрузку после ошибки сети. */
  retry: () => Promise<void>;
}

export const useArtistStore = create<ArtistState>((set, get) => {
  /**
   * Профиль, затем первая порция треков. Единая точка загрузки: её же
   * вызывает «Повторить» после ошибки.
   */
  async function load(key: string, target: string): Promise<void> {
    const id = ++attempt;
    const alive = () => id === attempt && get().key === key;

    const clientId = await getServiceToken("soundcloud");
    if (!alive()) return;
    if (!clientId) {
      set({ loading: false, error: "SoundCloud: нужен client_id — вставь в настройках" });
      return;
    }

    try {
      const profile = await soundcloudUser(clientId, target);
      if (!alive()) return;
      set({ profile });

      /**
       * Треки спрашиваем по числовому id: по нику эндпоинт `/users/<ник>/tracks`
       * не работает, а resolve уже дал нам точный идентификатор.
       */
      const tracks = await soundcloudUserTracks(
        clientId,
        profile.id || target,
        ARTIST_PAGE_SIZE,
        0
      );
      if (!alive()) return;

      const exhausted = tracks.length < ARTIST_PAGE_SIZE;
      cache.set(key, { profile, tracks, exhausted });
      set({ tracks, exhausted, loading: false, error: null });
    } catch (e) {
      if (!alive()) return;
      const message = explainSoundcloudError(e);
      logError(`Не удалось открыть артиста: ${target}`, message, "артист", errorText(e));
      set({ loading: false, error: message });
    }
  }

  return {
    open: false,
    key: null,
    target: null,
    profile: null,
    tracks: [],
    page: 1,
    loading: false,
    loadingMore: false,
    error: null,
    exhausted: false,

    openArtist(target) {
      const name = target.trim();
      if (!name) return;
      const key = artistKey(name);
      const remembered = cache.get(key);

      /**
       * Артист уже открывался: профиль и загруженные треки показываем сразу,
       * без запроса — как и обещает кэш на время сессии.
       */
      if (remembered) {
        set({
          open: true,
          key,
          target: name,
          profile: remembered.profile,
          tracks: remembered.tracks,
          exhausted: remembered.exhausted,
          page: 1,
          loading: false,
          loadingMore: false,
          error: null,
        });
        return;
      }

      set({
        open: true,
        key,
        target: name,
        profile: null,
        tracks: [],
        exhausted: false,
        page: 1,
        loading: true,
        loadingMore: false,
        error: null,
      });
      void load(key, name);
    },

    close() {
      set({ open: false });
    },

    setPage(page) {
      set({ page: Math.max(1, Math.floor(page) || 1) });
    },

    async loadMore() {
      const { key, target, profile, tracks, exhausted, loading, loadingMore } = get();
      if (!key || !target || exhausted || loading || loadingMore) return;
      // Следующую порцию можно не спрашивать: без кэша профиль уже загружен
      if (!profile) return;

      const id = ++attempt;
      const alive = () => id === attempt && get().key === key;

      const clientId = await getServiceToken("soundcloud");
      if (!alive()) return;
      if (!clientId) {
        set({ error: "SoundCloud: нужен client_id — вставь в настройках" });
        return;
      }

      set({ loadingMore: true, error: null });
      try {
        const batch = await soundcloudUserTracks(clientId, profile.id || target, ARTIST_PAGE_SIZE, tracks.length);
        if (!alive()) return;

        const merged = mergeTracks(tracks, batch);
        /**
         * Неполная порция означает конец списка — как и порция, которая не
         * принесла ничего нового (такое бывает, если сервис проигнорировал
         * смещение): тогда «Вперёд» не должен крутиться вхолостую.
         */
        const done = batch.length < ARTIST_PAGE_SIZE || merged.length === tracks.length;
        cache.set(key, { profile, tracks: merged, exhausted: done });
        set({ tracks: merged, exhausted: done, loadingMore: false });
      } catch (e) {
        if (!alive()) return;
        const message = explainSoundcloudError(e);
        logError(`Не удалось догрузить треки артиста: ${target}`, message, "артист", errorText(e));
        set({ loadingMore: false, error: message });
      }
    },

    async retry() {
      const { key, target } = get();
      if (!key || !target) return;
      cache.delete(key);
      set({
        profile: null,
        tracks: [],
        exhausted: false,
        page: 1,
        loading: true,
        loadingMore: false,
        error: null,
      });
      await load(key, target);
    },
  };
});
