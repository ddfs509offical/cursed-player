/**
 * Локальные профили пользователя.
 *
 * Основное хранилище — SQLite в приложении (Rust-команды, файл profiles.db
 * в папке данных). Если приложение открыто в обычном браузере (например,
 * `vite dev` без Tauri), используется запасное хранилище в localStorage,
 * а при первом запуске в Tauri профили из него переносятся в базу.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ProfileLink {
  label: string;
  url: string;
}

export interface ProfileStats {
  hours: number;
  tracks: number;
  topArtist: string | null;
}

export interface Profile {
  id: string;
  /** Уникальный в пределах устройства, без «@»: @cursed, @dj.night */
  username: string;
  displayName: string;
  bio: string;
  /** Почта профиля. Хранится локально; подтверждение появится вместе с сервером. */
  email: string | null;
  /** Картинка профиля: data-URL (после ресайза) или обычная ссылка. */
  avatar: string | null;
  banner: string | null;
  genres: string[];
  links: ProfileLink[];
  nowPlaying: string | null;
  createdAt: string;
  stats: ProfileStats;
  /** Локальный PIN (не шифрование — защита от случайного входа). */
  pin: string | null;
  guest: boolean;
}

export interface ProfileDraft {
  username: string;
  displayName: string;
  bio?: string;
  email?: string | null;
  avatar?: string | null;
  banner?: string | null;
  genres?: string[];
  links?: ProfileLink[];
  pin?: string | null;
  guest?: boolean;
}

export interface ProfileRepo {
  list(): Promise<Profile[]>;
  save(profile: Profile): Promise<Profile>;
  remove(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  setActiveId(id: string | null): Promise<void>;
}

/** Правила @username: как в соцсетях — латиница, цифры, «_» и «.». */
export const USERNAME_RE = /^[a-z0-9._]{3,20}$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Проверка почты без обращения к сети: формат и длина. */
export function validateEmail(raw: string): { ok: boolean; value: string; error?: string } {
  const value = raw.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length > 120) return { ok: false, value, error: "Слишком длинный адрес" };
  if (!EMAIL_RE.test(value)) return { ok: false, value, error: "Похоже, в адресе опечатка" };
  return { ok: true, value };
}

export function validateUsername(raw: string): { ok: boolean; value: string; error?: string } {
  const value = raw.trim().replace(/^@+/, "").toLowerCase();
  if (!value) return { ok: false, value, error: "Введите имя пользователя" };
  if (value.length < 3) return { ok: false, value, error: "Минимум 3 символа" };
  if (value.length > 20) return { ok: false, value, error: "Максимум 20 символов" };
  if (!USERNAME_RE.test(value)) return { ok: false, value, error: "Только латиница, цифры, «_» и «.»" };
  return { ok: true, value };
}

export function newProfileId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Заготовка имени для формы регистрации: cursed42 */
export function suggestUsername(): string {
  const base = ["listener", "cursed", "night", "wave", "echo", "vinyl"][Math.floor(Math.random() * 6)];
  return `${base}${Math.floor(Math.random() * 90 + 10)}`;
}

export function makeProfile(draft: ProfileDraft): Profile {
  const username = validateUsername(draft.username).value;
  return {
    id: newProfileId(),
    username,
    displayName: draft.displayName.trim() || username,
    bio: draft.bio?.trim() ?? "",
    email: draft.email?.trim() ? draft.email.trim() : null,
    avatar: draft.avatar ?? null,
    banner: draft.banner ?? null,
    genres: draft.genres ?? [],
    links: draft.links ?? [],
    nowPlaying: null,
    createdAt: new Date().toISOString(),
    stats: { hours: 0, tracks: 0, topArtist: null },
    pin: draft.pin ?? null,
    guest: draft.guest ?? false,
  };
}

const STORAGE_KEY = "music_hub_profiles";
const MIGRATED_KEY = "music_hub_profiles_migrated";

interface Stored {
  activeId: string | null;
  profiles: Profile[];
}

function readLocal(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { activeId: null, profiles: [] };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
      profiles: Array.isArray(parsed.profiles) ? (parsed.profiles as Profile[]) : [],
    };
  } catch {
    return { activeId: null, profiles: [] };
  }
}

function writeLocal(state: Stored) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Хранилище в localStorage — запасной вариант вне Tauri. */
const localRepo: ProfileRepo = {
  async list() {
    return readLocal().profiles;
  },
  async save(profile) {
    const state = readLocal();
    const index = state.profiles.findIndex((p) => p.id === profile.id);
    const taken = state.profiles.some((p) => p.id !== profile.id && p.username === profile.username);
    if (taken) throw new Error("Это имя уже занято на устройстве");
    const profiles = [...state.profiles];
    if (index < 0) profiles.push(profile);
    else profiles[index] = profile;
    writeLocal({ ...state, profiles });
    return profile;
  },
  async remove(id) {
    const state = readLocal();
    const profiles = state.profiles.filter((p) => p.id !== id);
    const activeId = state.activeId === id ? (profiles[0]?.id ?? null) : state.activeId;
    writeLocal({ activeId, profiles });
  },
  async getActiveId() {
    const state = readLocal();
    if (state.activeId && state.profiles.some((p) => p.id === state.activeId)) return state.activeId;
    return state.profiles[0]?.id ?? null;
  },
  async setActiveId(id) {
    writeLocal({ ...readLocal(), activeId: id });
  },
};

/** Основное хранилище: SQLite внутри приложения. */
const sqliteRepo: ProfileRepo = {
  async list() {
    return invoke<Profile[]>("profiles_list");
  },
  async save(profile) {
    return invoke<Profile>("profile_save", { profile });
  },
  async remove(id) {
    await invoke("profile_delete", { id });
  },
  async getActiveId() {
    return (await invoke<string | null>("profile_active_get")) ?? null;
  },
  async setActiveId(id) {
    await invoke("profile_active_set", { id });
  },
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const profileRepo: ProfileRepo = isTauri() ? sqliteRepo : localRepo;

/**
 * Готовит хранилище к работе: при первом запуске в приложении переносит
 * профили, созданные предыдущей версией в localStorage, и оставляет их
 * как резервную копию (не удаляем — данные пользователя дороже чистоты).
 */
export async function prepareProfileStorage(): Promise<void> {
  if (!isTauri() || localStorage.getItem(MIGRATED_KEY) === "1") return;
  const local = readLocal();
  if (local.profiles.length) {
    const imported = await invoke<number>("profiles_import", { profiles: local.profiles });
    if (imported > 0) {
      const active = await invoke<string | null>("profile_active_get");
      const wanted = local.activeId ?? local.profiles[0]?.id ?? null;
      if (!active && wanted) await invoke("profile_active_set", { id: wanted });
    }
  }
  localStorage.setItem(MIGRATED_KEY, "1");
}
