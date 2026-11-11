import { create } from "zustand";
import {
  makeProfile,
  prepareProfileStorage,
  profileRepo,
  type Profile,
  type ProfileStats,
  type ProfileDraft,
} from "../services/profiles";
import { useHistoryStore, durationsFromLibrary, statsForProfile } from "./historyStore";
import { useLibraryStore } from "./libraryStore";

/* ------------------------------------------------------------------ */
/* Приватность профиля                                                 */
/* ------------------------------------------------------------------ */

/**
 * Что владелец профиля показывает другим. Живёт рядом с моделью профиля, но
 * не внутри неё: таблица профилей в SQLite знает только имя, аватар и общие
 * агрегаты статистики, поэтому приватность хранится отдельно — в localStorage.
 */
export interface ProfilePrivacy {
  /** Показывать статистику прослушивания. */
  showStats: boolean;
  /** Показывать недавно прослушанное. */
  showRecent: boolean;
  /** Показывать любимых исполнителей. */
  showTopArtists: boolean;
  /** Показывать лайки. */
  showLikes: boolean;
  /** Показывать плейлисты. */
  showPlaylists: boolean;
  /** Показывать описание профиля. */
  showBio: boolean;
  /** Показывать аватар и баннер. */
  showAvatar: boolean;
  /** Разрешить находить меня по юзернейму. */
  discoverable: boolean;
}

/**
 * По умолчанию приватность важнее: статистика и недавно прослушанное скрыты,
 * всё остальное (то, что и так видно в профиле) — открыто.
 */
export const PRIVACY_DEFAULTS: ProfilePrivacy = {
  showStats: false,
  showRecent: false,
  showTopArtists: true,
  showLikes: true,
  showPlaylists: true,
  showBio: true,
  showAvatar: true,
  discoverable: true,
};

/** Пункты раздела «Приватность» в настройках: порядок и тексты в одном месте. */
export const PRIVACY_FIELDS: readonly { key: keyof ProfilePrivacy; title: string; hint: string }[] = [
  {
    key: "showStats",
    title: "Показывать статистику прослушивания",
    hint: "Часы, треки и число прослушиваний в профиле",
  },
  {
    key: "showRecent",
    title: "Показывать недавно прослушанное",
    hint: "Последние треки с обложками и временем",
  },
  {
    key: "showTopArtists",
    title: "Показывать любимых исполнителей",
    hint: "Самый частый исполнитель в блоке статистики",
  },
  {
    key: "showLikes",
    title: "Показывать лайки",
    hint: "Сколько треков в избранном",
  },
  {
    key: "showPlaylists",
    title: "Показывать плейлисты",
    hint: "Число плейлистов в профиле",
  },
  {
    key: "showBio",
    title: "Показывать описание профиля",
    hint: "Текст «О себе»",
  },
  {
    key: "showAvatar",
    title: "Показывать аватар и баннер",
    hint: "Фото профиля и обложка",
  },
  {
    key: "discoverable",
    title: "Разрешить находить меня по юзернейму",
    hint: "Пока поиска по юзернейму нет: флаг хранится локально и убирает кнопку копирования ника",
  },
];

const PRIVACY_KEY = "music_hub_privacy";

/** Приводим запись из localStorage к известным полям: чужие ключи не берём. */
function sanitizePrivacy(value: unknown): ProfilePrivacy {
  const raw = (value ?? {}) as Record<string, unknown>;
  const privacy = { ...PRIVACY_DEFAULTS };
  for (const key of Object.keys(PRIVACY_DEFAULTS) as (keyof ProfilePrivacy)[]) {
    if (typeof raw[key] === "boolean") privacy[key] = raw[key] as boolean;
  }
  return privacy;
}

function loadPrivacy(): Record<string, ProfilePrivacy> {
  try {
    const raw = localStorage.getItem(PRIVACY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, ProfilePrivacy> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (id) map[id] = sanitizePrivacy(value);
    }
    return map;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Стор профилей                                                       */
/* ------------------------------------------------------------------ */

interface ProfileState {
  ready: boolean;
  profiles: Profile[];
  activeId: string | null;
  /** Правила приватности по идентификатору профиля. */
  privacy: Record<string, ProfilePrivacy>;
  load: () => Promise<void>;
  create: (draft: ProfileDraft) => Promise<Profile>;
  update: (id: string, patch: Partial<Profile>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Возврат удалённого профиля (для кнопки «Отменить»). */
  restore: (profile: Profile) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Меняет пункты приватности и сохраняет их локально. */
  setPrivacy: (profileId: string, patch: Partial<ProfilePrivacy>) => void;
  /**
   * Пересчитывает агрегаты профиля из истории прослушиваний. Статистика не
   * хранится в истории: она вычисляется и кладётся в модель профиля, чтобы её
   * видели и главная, и настройки.
   */
  refreshStats: (profileId?: string | null) => Promise<void>;
}

/**
 * В dev-режиме React StrictMode монтирует компоненты дважды: без общей
 * промис-загрузки два параллельных вызова гонятся друг с другом и могут
 * оставить интерфейс без активного профиля при живых данных в базе.
 */
let loading: Promise<void> | null = null;

async function loadProfiles(set: (state: Partial<ProfileState>) => void) {
  try {
    // Первый запуск: переносим профили из старого localStorage в SQLite
    await prepareProfileStorage();
  } catch {
    // миграция не должна мешать запуску
  }

  const [profiles, storedActive] = await Promise.all([profileRepo.list(), profileRepo.getActiveId()]);

  // Если профили есть, активный обязан быть: иначе покажем экран создания
  // аккаунта поверх существующих данных.
  let activeId = storedActive;
  if (!activeId && profiles.length) {
    activeId = profiles[0].id;
    try {
      await profileRepo.setActiveId(activeId);
    } catch {
      // не критично: активный профиль всё равно уже выбран в памяти
    }
  }

  set({ ready: true, profiles, activeId });
  // Статистику профиля никто не обновлял: считаем её из истории при запуске
  if (activeId) void useProfileStore.getState().refreshStats(activeId);
}

/** Часы считаем по фактически прослушанному времени, а не по длительностям. */
function statsFromHistory(profileId: string): ProfileStats | null {
  const profile = useProfileStore.getState().profiles.find((item) => item.id === profileId);
  if (!profile) return null;
  const durationOf = durationsFromLibrary(useLibraryStore.getState().tracks);
  const next = statsForProfile(useHistoryStore.getState().entries, durationOf);
  return sameStats(profile.stats, next) ? null : next;
}

/** Статистика растёт медленно: в базу пишем, только если цифры реально другие. */
function sameStats(a: ProfileStats, b: ProfileStats): boolean {
  return (
    Math.abs(a.hours - b.hours) < 1 / 60 && a.tracks === b.tracks && (a.topArtist ?? null) === (b.topArtist ?? null)
  );
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  ready: false,
  profiles: [],
  activeId: null,
  privacy: loadPrivacy(),

  load: async () => {
    if (!loading) loading = loadProfiles(set).finally(() => { loading = null; });
    await loading;
  },

  create: async (draft) => {
    const profile = await profileRepo.save(makeProfile(draft));
    await profileRepo.setActiveId(profile.id);
    set({ profiles: await profileRepo.list(), activeId: profile.id });
    return profile;
  },

  update: async (id, patch) => {
    const current = get().profiles.find((p) => p.id === id);
    if (!current) return;
    await profileRepo.save({ ...current, ...patch });
    set({ profiles: await profileRepo.list() });
  },

  remove: async (id) => {
    await profileRepo.remove(id);
    const [profiles, activeId] = await Promise.all([profileRepo.list(), profileRepo.getActiveId()]);
    set({ profiles, activeId });
  },

  restore: async (profile) => {
    // После удаления update() не найдёт профиль в списке, поэтому пишем напрямую
    await profileRepo.save(profile);
    await profileRepo.setActiveId(profile.id);
    set({ profiles: await profileRepo.list(), activeId: profile.id });
  },

  switchTo: async (id) => {
    await profileRepo.setActiveId(id);
    set({ activeId: id });
  },

  signOut: async () => {
    await profileRepo.setActiveId(null);
    set({ activeId: null });
  },

  setPrivacy: (profileId, patch) => {
    if (!profileId) return;
    const current = get().privacy[profileId] ?? PRIVACY_DEFAULTS;
    const next = { ...get().privacy, [profileId]: sanitizePrivacy({ ...current, ...patch }) };
    try {
      localStorage.setItem(PRIVACY_KEY, JSON.stringify(next));
    } catch {
      // переполнение хранилища не повод терять настройку в памяти
    }
    set({ privacy: next });
  },

  refreshStats: async (profileId) => {
    const id = profileId === undefined ? get().activeId : profileId;
    if (!id) return;
    const next = statsFromHistory(id);
    if (!next) return;
    const current = get().profiles.find((p) => p.id === id);
    if (!current) return;
    try {
      await profileRepo.save({ ...current, stats: next });
      set({ profiles: await profileRepo.list() });
    } catch {
      // статистика не стоит того, чтобы ломать профиль из-за ошибки записи
    }
  },
}));

/**
 * Живая статистика: пересчитываем агрегаты профиля, когда меняется история.
 * Пересчёт не чаще раза в полторы секунды — история меняется на событиях
 * плеера, а запись в базу не должна идти на каждое из них.
 */
const STATS_DEBOUNCE_MS = 1500;
let statsTimer: number | null = null;

useHistoryStore.subscribe((state, previous) => {
  if (state.entries === previous.entries) return;
  if (statsTimer !== null) window.clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => {
    statsTimer = null;
    void useProfileStore.getState().refreshStats();
  }, STATS_DEBOUNCE_MS);
});

/** Активный профиль (или null, если пользователь ещё не создал аккаунт). */
export function useActiveProfile(): Profile | null {
  return useProfileStore((s) => s.profiles.find((p) => p.id === s.activeId) ?? null);
}

/** Правила приватности профиля: без записи — значения по умолчанию. */
export function useProfilePrivacy(profileId: string | null | undefined): ProfilePrivacy {
  return useProfileStore((s) => (profileId ? s.privacy[profileId] : undefined) ?? PRIVACY_DEFAULTS);
}
