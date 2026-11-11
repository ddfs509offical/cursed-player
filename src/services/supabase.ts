/**
 * Синхронизация через Supabase.
 *
 * Здесь только транспорт к своему же Rust-ядру: адрес проекта и публичный
 * publishable-ключ вшиты в сборку (это публичные данные — publishable-ключ по
 * дизайну Supabase лежит в клиенте, а доступ ограничивают правила RLS).
 * Токены входа живут в файле
 * сессии рядом с профилями, пароль наружу не сохраняется никогда: он
 * передаётся один раз при входе.
 *
 * Отсюда же — облачные профили людей (`profiles`): юзернейм, аватар, баннер,
 * описание и приватность. По ним работает раздел «Люди».
 *
 * В браузере (без Tauri) все вызовы no-op, как и в соседних сервисах.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./profiles";

/* ------------------------------------------------------------------ */
/* Вшитая конфигурация                                                 */
/* ------------------------------------------------------------------ */

/**
 * Адрес проекта. Единственное место в коде, где он записан.
 */
export const SUPABASE_URL_DEFAULT = "https://fmynbjjwfuxdvorzzhdn.supabase.co";

/**
 * Публичный ключ проекта — `sb_publishable_…` из новой системы ключей Supabase
 * (пришёл на смену старому anon-JWT). Публичный по дизайну: он и так уезжает в
 * клиент, а данные защищают правила RLS.
 *
 * Сюда нельзя класть секретные ключи: ни `sb_secret_…` новой системы, ни
 * старый `service_role` — они дают полный доступ в обход RLS. Поле в интерфейсе
 * для них тоже есть не будет.
 *
 * Имя константы оставлено прежним (`…_ANON_KEY_…`), чтобы не трогать вызовы:
 * роль у ключа та же — анонимный публичный доступ.
 */
export const SUPABASE_ANON_KEY_DEFAULT = "sb_publishable_3TJcaJwb6Umt1FJR_-7a1w_vodLDWcQ";

/** Адрес проекта и ключ — ровно то, что нужно команде `sync_configure`. */
export interface SyncConfig {
  url: string;
  anonKey: string;
}

/**
 * Конфигурация, зашитая в сборку. `null` — если хотя бы одно из значений
 * пустое: тогда остаётся ручная настройка для разработки.
 */
export function embeddedConfig(): SyncConfig | null {
  const url = SUPABASE_URL_DEFAULT.trim();
  const anonKey = SUPABASE_ANON_KEY_DEFAULT.trim();
  return url && anonKey ? { url, anonKey } : null;
}

/** Вшитая конфигурация есть: обычный пользователь ничего не вводит. */
export function hasEmbeddedConfig(): boolean {
  return embeddedConfig() !== null;
}

/** Адрес проекта для подсказок: вшитый или сохранённый вручную. */
export function knownUrl(manual?: string): string {
  return embeddedConfig()?.url ?? manual?.trim() ?? "";
}

/* ------------------------------------------------------------------ */
/* Временное ограничение регистрации                                   */
/* ------------------------------------------------------------------ */

/**
 * Честный текст про закрытую регистрацию. Пока проект в бете, запрет держит
 * не интерфейс, а триггер на `auth.users` — обойти его из клиента нельзя.
 */
export const REGISTRATION_CLOSED_NOTICE =
  "Регистрация пока только по приглашению: проект в бете. Код выдаёт владелец — " +
  "введи его в поле «Код приглашения» под паролем.";

/** Ответ сервера означает «регистрация закрыта»? */
export function isRegistrationClosed(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("регистрация временно закрыта") ||
    lower.includes("registration is closed") ||
    lower.includes("registration_closed")
  );
}

/* ------------------------------------------------------------------ */
/* Ключи не попадают никуда, кроме запросов                            */
/* ------------------------------------------------------------------ */

/** JWT-подобная строка: ей быть в журнале ошибок незачем. */
const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

/**
 * Ключи новой системы Supabase. Публичный `sb_publishable_…` секретом не
 * является, но мелькать в журнале ему нечего; `sb_secret_…` и старый
 * `service_role` вычищаем тем более — их вообще не должно быть в клиенте.
 */
const NEW_KEY_RE = /sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g;

/**
 * Затереть всё похожее на ключ. Применяется к любому тексту ошибки до записи
 * в журнал: публичный ключ и так уезжает в клиент, но логи — не его место, а
 * `service_role` / `sb_secret_…` (если их когда-нибудь вставят по ошибке) —
 * тем более.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  const secrets = [SUPABASE_ANON_KEY_DEFAULT.trim()].filter(Boolean);
  for (const secret of secrets) out = out.split(secret).join("‹скрыто›");
  return out.replace(NEW_KEY_RE, "‹ключ скрыт›").replace(JWT_RE, "‹ключ скрыт›");
}

/* ------------------------------------------------------------------ */
/* Состояние аккаунта                                                  */
/* ------------------------------------------------------------------ */

export interface SyncStatus {
  /** Адрес проекта и anon-ключ заполнены. */
  configured: boolean;
  /** Есть refresh-токен: сессия жива (access-токен может быть просрочен). */
  signedIn: boolean;
  email: string | null;
  userId: string | null;
  /** Unix-миллисекунды последней удачной синхронизации. */
  lastSyncAtMs: number | null;
  /** Текст последней ошибки — только для показа. */
  lastError: string | null;
}

const EMPTY_STATUS: SyncStatus = {
  configured: false,
  signedIn: false,
  email: null,
  userId: null,
  lastSyncAtMs: null,
  lastError: null,
};

/**
 * Сохраняет адрес проекта и anon-ключ и проверяет доступность.
 * При вшитой конфигурации вызывается приложением само — пользователь полей
 * не видит; вручную то же самое можно сделать в «Дополнительно».
 */
export async function syncConfigure(url: string, anonKey: string): Promise<SyncStatus> {
  if (!isTauri()) return EMPTY_STATUS;
  return invoke<SyncStatus>("sync_configure", { url, anonKey });
}

/** Регистрация. Если включено подтверждение почты, вернётся статус без входа. */
export async function syncSignUp(
  email: string,
  password: string,
  inviteCode?: string
): Promise<SyncStatus> {
  if (!isTauri()) throw new Error("Синхронизация доступна только в приложении");
  return invoke<SyncStatus>("sync_sign_up", { email, password, inviteCode });
}

/* ------------------------------------------------------------------ */
/* Приглашения                                                         */
/* ------------------------------------------------------------------ */

/** Приглашение, как его отдаёт RPC `invite_list`. */
export interface Invite {
  code: string;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
  /** `active` / `used` / `expired` / `revoked`. */
  status: string;
}

/** Проверить код до отправки формы регистрации — код не расходуется. */
export async function inviteCheck(code: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("invite_check", { code });
}

/** Создать приглашение. Сервер пропустит только владельца. */
export async function inviteCreate(note: string | null, days: number, maxUses: number): Promise<Invite> {
  if (!isTauri()) throw new Error("Синхронизация доступна только в приложении");
  return invoke<Invite>("invite_create", { note, days, maxUses });
}

/**
 * Список приглашений. Чужому пользователю сервер ответит `not_allowed` —
 * по этому тексту интерфейс прячет раздел настроек.
 */
export async function inviteList(): Promise<Invite[]> {
  if (!isTauri()) throw new Error("Синхронизация доступна только в приложении");
  return invoke<Invite[]>("invite_list");
}

/** Отозвать код: уже зарегистрированных это не удаляет. */
export async function inviteRevoke(code: string): Promise<boolean> {
  if (!isTauri()) throw new Error("Синхронизация доступна только в приложении");
  return invoke<boolean>("invite_revoke", { code });
}

/** Сервер отказал из-за не-владельца: раздел приглашений не для этого аккаунта. */
export function isNotOwnerError(text: string | null | undefined): boolean {
  return !!text && text.toLowerCase().includes("not_allowed");
}

/**
 * Сервер ещё не знает про приглашения: миграция не применена (нет таблиц или
 * RPC). Это не ошибка пользователя — интерфейс объясняет причину словами, а не
 * сырым ответом PostgREST.
 */
export function isInvitesUnsupported(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("pgrst202") ||
    lower.includes("pgrst205") ||
    lower.includes("could not find the table") ||
    lower.includes("could not find the function") ||
    lower.includes("schema cache") ||
    lower.includes("does not exist")
  );
}

/* ------------------------------------------------------------------ */
/* Устройство (HWID) и админ-панель                                    */
/* ------------------------------------------------------------------ */

/** Отпечаток этого компьютера: 64 символа hex, считает Rust. */
export async function machineHwid(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("machine_guid");
}

/** Привязать компьютер к текущему аккаунту (зовётся после входа). */
export async function deviceBind(hwid: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("device_bind", { fingerprint: hwid });
}

/** К какому аккаунту привязан компьютер. `null` — не привязан. */
export interface DeviceAccount {
  username: string;
  displayName: string;
  email: string;
}

export async function deviceLookup(hwid: string): Promise<DeviceAccount | null> {
  if (!isTauri()) return null;
  return invoke<DeviceAccount | null>("device_lookup", { fingerprint: hwid });
}

/** Владелец ли текущий аккаунт: решает сервер, а не интерфейс. */
export async function meIsOwner(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("is_owner");
  } catch {
    return false;
  }
}

/**
 * Открыта ли регистрация для всех: флаг владельца на сервере.
 * `false` — значит нужен ключ приглашения (или сервер ещё не знает про флаг).
 */
export async function registrationOpen(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("app_registration_state");
  } catch {
    return false;
  }
}

/** Письмо для сброса пароля на почту аккаунта. */
export async function recoverPassword(email: string): Promise<void> {
  if (!isTauri()) throw new Error("Сброс пароля доступен только в приложении");
  await invoke("auth_recover", { email });
}

export interface AdminUser {
  userId: string;
  username: string;
  displayName: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  devices: number;
}

export interface AdminDevice {
  username: string;
  email: string;
  hwid: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface InviteUse {
  code: string;
  email: string;
  usedAt: string;
}

export interface AdminStats {
  users: number;
  invitesActive: number;
  invitesUsed: number;
  devices: number;
  registrationOpen: boolean;
}

export async function adminUsers(): Promise<AdminUser[]> {
  if (!isTauri()) return [];
  return invoke<AdminUser[]>("admin_users");
}

export async function adminDevices(): Promise<AdminDevice[]> {
  if (!isTauri()) return [];
  return invoke<AdminDevice[]>("admin_devices");
}

export async function adminInviteUses(): Promise<InviteUse[]> {
  if (!isTauri()) return [];
  return invoke<InviteUse[]>("admin_invite_uses");
}

export async function adminStats(): Promise<AdminStats> {
  if (!isTauri()) {
    return { users: 0, invitesActive: 0, invitesUsed: 0, devices: 0, registrationOpen: false };
  }
  return invoke<AdminStats>("admin_stats");
}

export async function adminSetOpen(open: boolean): Promise<boolean> {
  if (!isTauri()) return open;
  return invoke<boolean>("admin_set_open", { open });
}

/** Вход по email и паролю. Пароль не сохраняется — только токены. */
export async function syncSignIn(email: string, password: string): Promise<SyncStatus> {
  if (!isTauri()) throw new Error("Синхронизация доступна только в приложении");
  return invoke<SyncStatus>("sync_sign_in", { email, password });
}

/** Выход: токены забываются, локальные данные остаются на месте. */
export async function syncSignOut(): Promise<void> {
  if (!isTauri()) return;
  await invoke("sync_sign_out");
}

/** Состояние без сети: есть ли настройка, вошли ли, когда синхронизировались. */
export async function syncStatus(): Promise<SyncStatus> {
  if (!isTauri()) return EMPTY_STATUS;
  return invoke<SyncStatus>("sync_status");
}

/** Отправка строк в таблицу `user_data` проекта. */
export async function syncPush(rows: unknown[]): Promise<void> {
  if (!isTauri()) throw new Error("Синхронизация доступна только в приложении");
  await invoke("sync_push", { rows });
}

/**
 * Выгрузка строк, изменённых позже `sinceMs` (Unix-миллисекунды).
 * Ноль или отрицательное значение — «всё подряд».
 */
export async function syncPull(sinceMs: number): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invoke<unknown[]>("sync_pull", { sinceMs });
}

/* ------------------------------------------------------------------ */
/* Облачные профили                                                    */
/* ------------------------------------------------------------------ */

/**
 * Строка публичной таблицы `profiles`. Поля необязательные: сервер отдаёт
 * только то, что заполнено.
 */
export interface CloudProfile {
  id: string;
  username: string;
  displayName?: string | null;
  avatar?: string | null;
  banner?: string | null;
  bio?: string | null;
  /** Настройки приватности владельца; пустой объект — «всё видно». */
  privacy?: Record<string, unknown> | null;
  updatedAt?: string | null;
}

/** Что отправляем в облако при сохранении своего профиля. */
export interface CloudProfileDraft {
  username: string;
  displayName: string;
  avatar: string | null;
  banner: string | null;
  bio: string;
  privacy: Record<string, unknown>;
}

/** Своя строка в `profiles`: создаётся или обновляется одной командой. */
export async function profileUpsert(draft: CloudProfileDraft): Promise<CloudProfile> {
  if (!isTauri()) throw new Error("Профиль доступен только в приложении");
  return invoke<CloudProfile>("profile_upsert", {
    username: draft.username,
    displayName: draft.displayName,
    avatar: draft.avatar,
    banner: draft.banner,
    bio: draft.bio,
    privacy: draft.privacy,
  });
}

/** Профиль по идентификатору пользователя. `null` — строки ещё нет. */
export async function profileGet(userId: string): Promise<CloudProfile | null> {
  if (!isTauri()) return null;
  return (await invoke<CloudProfile | null>("profile_get", { userId })) ?? null;
}

/** Поиск людей по юзернейму и отображаемому имени (регистр не важен). */
export async function profileSearch(query: string): Promise<CloudProfile[]> {
  if (!isTauri()) return [];
  const rows = await invoke<CloudProfile[]>("profile_search", { query });
  return Array.isArray(rows) ? rows : [];
}

/* ------------------------------------------------------------------ */
/* Приватность                                                         */
/* ------------------------------------------------------------------ */

/**
 * Поля приватности, которые проверяет интерфейс, прежде чем показать чужие
 * данные. Имена — как в модели приватности профиля (`ProfilePrivacy`),
 * чтобы облачная запись и локальные настройки говорили на одном языке.
 */
export type PrivacyKey =
  | "showStats"
  | "showRecent"
  | "showTopArtists"
  | "showLikes"
  | "showPlaylists"
  | "showBio"
  | "showAvatar"
  | "discoverable";

/**
 * Синонимы из старых записей: облако могло сохранить и короткие имена.
 * Читаем оба варианта, чтобы настройка не «потерялась» после переименования.
 */
const PRIVACY_ALIASES: Record<PrivacyKey, readonly string[]> = {
  showStats: ["stats"],
  showRecent: ["recent"],
  showTopArtists: ["topArtists"],
  showLikes: ["likes", "favorites"],
  showPlaylists: ["playlists"],
  showBio: ["bio"],
  showAvatar: ["avatar", "banner"],
  discoverable: ["searchable", "profile"],
};

const VISIBLE_WORDS = ["public", "everyone", "all", "yes", "on", "true", "open", "visible"];
const HIDDEN_WORDS = [
  "private",
  "only_me",
  "onlyme",
  "nobody",
  "no",
  "off",
  "false",
  "friends",
  "followers",
  "following",
  "closed",
  "hidden",
];

/** Разобрать словесное описание области видимости: непонятное считаем открытым. */
function scopeVisible(scope: string): boolean {
  const text = scope.trim().toLowerCase();
  if (VISIBLE_WORDS.includes(text)) return true;
  if (HIDDEN_WORDS.includes(text)) return false;
  return true;
}

/**
 * Видно ли поле чужому человеку. Модель приватности пишет другой подрядчик, и
 * поля может ещё не быть — тогда считаем «всё видно». Понимаем и флаг
 * (`{"showStats": false}`), и словесное описание, и вложенный объект.
 */
export function privacyAllows(privacy: unknown, key: PrivacyKey): boolean {
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) return true;
  const raw = privacy as Record<string, unknown>;
  let value = raw[key];
  if (value === undefined) {
    for (const alias of PRIVACY_ALIASES[key]) {
      if (raw[alias] !== undefined) {
        value = raw[alias];
        break;
      }
    }
  }
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return scopeVisible(value);
  if (typeof value === "object") {
    const inner = value as Record<string, unknown>;
    if (typeof inner.visible === "boolean") return inner.visible;
    if (typeof inner.enabled === "boolean") return inner.enabled;
    if (typeof inner.public === "boolean") return inner.public;
    if (typeof inner.scope === "string") return scopeVisible(inner.scope);
    if (typeof inner.value === "string") return scopeVisible(inner.value);
    return true;
  }
  return true;
}

/** Что из чужого профиля можно показать — готовый набор для страницы «Люди». */
export interface CloudVisibility {
  stats: boolean;
  recent: boolean;
  topArtists: boolean;
  likes: boolean;
  playlists: boolean;
  bio: boolean;
  avatar: boolean;
}

export function cloudVisibility(privacy: unknown): CloudVisibility {
  return {
    stats: privacyAllows(privacy, "showStats"),
    recent: privacyAllows(privacy, "showRecent"),
    topArtists: privacyAllows(privacy, "showTopArtists"),
    likes: privacyAllows(privacy, "showLikes"),
    playlists: privacyAllows(privacy, "showPlaylists"),
    bio: privacyAllows(privacy, "showBio"),
    avatar: privacyAllows(privacy, "showAvatar"),
  };
}

/** Человек разрешил находить себя по юзернейму (по умолчанию — да). */
export function cloudIsDiscoverable(privacy: unknown): boolean {
  return privacyAllows(privacy, "discoverable");
}
