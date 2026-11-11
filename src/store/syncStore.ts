/**
 * Синхронизация между устройствами через Supabase (общая таблица строк).
 *
 * Правила простые и намеренно скучные:
 * * локальные сторы — источник истины для интерфейса, сервер — способ перенести
 *   данные на другое устройство;
 * * если аккаунт не настроен, вход не выполнен или сервер не дал `userId` —
 *   здесь не происходит ничего: ни одного сетевого вызова, ни одной ошибки;
 * * отправляем только `user_id`, `kind`, `item_id`, `payload`, `deleted`;
 *   `updated_at` ставит сервер сам (default + триггер), поэтому часы устройств
 *   на конфликты не влияют;
 * * своё «время последнего изменения» ведём отдельно, в localStorage
 *   (`syncMeta`): запись «грязная», если менялась позже последней удачной
 *   синхронизации — только такие строки и уезжают;
 * * конфликт решается по серверному `updated_at` из pull: строку применяем,
 *   если она новее момента последней удачной синхронизации и локально эту
 *   запись с тех пор не меняли; если меняли — остаётся локальная версия и
 *   уезжает наверх;
 * * удаление не стирается молча: снятый лайк или удалённая офлайн-копия
 *   остаются надгробием и уезжают строкой с `deleted: true`;
 * * ошибки не показываются модалками — они идут в журнал (`logError`,
 *   источник «синхронизация») и в `status.lastError`.
 *
 * Один круг: pull(since = время последней удачной синхронизации) → применить
 * более новые строки → отправить свои изменения → запомнить начало круга →
 * ещё один pull(since = начало круга), чтобы забрать то, что успело появиться
 * на сервере (в том числе канонические серверные `updated_at`).
 */

import { create } from "zustand";
import { serviceFromTrackId } from "../lib/services";
import type { Profile } from "../services/profiles";
import type { SavedFile } from "../services/downloads";
import {
  embeddedConfig,
  isRegistrationClosed,
  machineHwid,
  meIsOwner,
  deviceBind,
  profileGet,
  profileUpsert,
  redactSecrets,
  syncConfigure,
  syncPull,
  syncPush,
  syncSignIn,
  syncSignOut,
  syncSignUp,
  syncStatus,
  type CloudProfile,
  type CloudProfileDraft,
  type SyncStatus,
} from "../services/supabase";
import { errorText, logError } from "./errorStore";
import { cardPayload, favoriteTrackFrom, useFavoritesStore, type FavoriteTrack } from "./favoritesStore";
import { useHistoryStore, type HistoryEntry } from "./historyStore";
import { useOfflineStore } from "./offlineStore";
import {
  ensurePlaylistsLoaded,
  playlistPayload,
  usePlaylistsStore,
  type Playlist,
} from "./playlistsStore";
import { useProfileStore } from "./profileStore";
import { SYNCED_SETTINGS, useSettingsStore } from "./settingsStore";
import {
  SYNC_KINDS,
  commitSync,
  dropTombstones,
  keyOf,
  markRemoteOffline,
  setMetaScope,
  snapshotMeta,
  touch,
  updatedAtOf,
  type SyncKind,
} from "./syncMeta";

/**
 * Строка, которую отправляем. `updated_at` здесь нет намеренно: его ставит
 * сервер (default now() + триггер). `user_id` — часть первичного ключа, его
 * берём из состояния аккаунта и передаём всегда.
 */
export interface OutboundRow {
  user_id: string;
  kind: SyncKind;
  item_id: string;
  payload: Record<string, unknown>;
  deleted: boolean;
}

/** Строка, которую отдаёт pull: серверный `updated_at` решает конфликты. */
export interface IncomingRow {
  user_id?: string;
  kind: SyncKind;
  item_id: string;
  payload: Record<string, unknown>;
  /** Время последнего изменения на сервере (ISO). */
  updated_at: string;
  deleted: boolean;
}

/** Адрес проекта и anon key: второй — публичный ключ, не секрет. */
export interface SyncConfig {
  url: string;
  anonKey: string;
}

/** Свой дубль настроек подключения: нужен только чтобы заполнить поля формы. */
const CONFIG_KEY = "music_hub_sync_config";

/** Привязка профиля к аккаунту: у каждого аккаунта свой локальный профиль. */
const BINDING_KEY = "music_hub_cloud_binding";

/** Юзернейм, введённый при регистрации: применим его после подтверждения почты. */
const PENDING_USERNAME_KEY = "music_hub_pending_username";

/** Дебаунс: пачка изменений (например, «убрать всё») уезжает одним кругом. */
const DEBOUNCE_MS = 4000;

/** Дебаунс отправки профиля: правки в форме не должны слать запрос на каждый символ. */
const PROFILE_DEBOUNCE_MS = 1500;

/**
 * Аватар и баннер уезжают в облако целиком (data-URL после сжатия). Слишком
 * большую картинку не отправляем: сервер её не примет, а обрезать нельзя.
 */
const MAX_CLOUD_IMAGE_CHARS = 900_000;

/**
 * Насколько раньше запрашиваем строки у сервера. Само решение о конфликте
 * по-прежнему опирается на время последней удачной синхронизации, а этот запас
 * нужен только запросу: серверное `updated_at` ставит сервер, и если его часы
 * отстают от наших, ровно тот же момент времени мог бы «потерять» строку.
 * Лишние строки отсеет проверка `updated_at > последняя синхронизация`.
 */
const PULL_MARGIN_MS = 5 * 60_000;

/** Чем закончилась попытка входа или регистрации — для понятного сообщения. */
export interface AuthResult {
  /** Вход выполнен: токены получены. */
  ok: boolean;
  /** Аккаунт создан, но Supabase ждёт подтверждения почты. */
  needsConfirmation: boolean;
  /** Регистрация закрыта: проект в бете, доступ только владельцу. */
  registrationClosed: boolean;
  /** Текст ошибки для показа (ключи из него уже вырезаны). */
  error: string | null;
}

interface SyncState {
  status: SyncStatus;
  /** Круг синхронизации идёт прямо сейчас. */
  busy: boolean;
  /** Сколько строк в текущем круге: показывает прогресс. */
  progress: number;
  /** Сколько строк ждёт отправки. */
  pendingCount: number;
  config: SyncConfig;
  /**
   * Отметки «держу офлайн» с других устройств. В список сохранённых файлов их
   * не кладём: файла здесь нет, и плеер не должен думать иначе.
   */
  remoteOffline: Record<string, Record<string, unknown>>;
  /** Своя строка в публичной таблице `profiles` — как её видит сервер. */
  cloudProfile: CloudProfile | null;
  /** Идёт запись профиля в облако. */
  cloudBusy: boolean;
  /** Почему профиль не уехал в облако (например, юзернейм занят). */
  cloudError: string | null;
  /**
   * Роль текущего аккаунта по мнению сервера: `owner` — владелец проекта,
   * `user` — обычный человек, `null` — не знаем (не вошли или сервер не ответил).
   * По этой роли клиент прячет разделы разработчика и показывает админ-панель;
   * сами данные защищены на сервере, роль — только оформление.
   */
  role: "owner" | "user" | null;
  /** Перечитать роль из `is_owner()`; зовётся после входа и при старте. */
  refreshRole: () => Promise<void>;

  /** Запуск: читает состояние аккаунта и подписывается на изменения сторов. */
  init: (profileId?: string | null) => Promise<void>;
  /** Сохранить адрес и ключ проекта, затем перечитать состояние. */
  configure: (url: string, anonKey: string) => Promise<boolean>;
  /** Регистрация. Введённый юзернейм запомним для облачного профиля. */
  signUp: (
    email: string,
    password: string,
    username?: string,
    inviteCode?: string
  ) => Promise<AuthResult>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  /** Полный круг: pull → apply → push → pull. Без аккаунта не делает ничего. */
  syncNow: () => Promise<void>;
  /** Смена профиля: у каждого профиля свои метки времени синхронизации. */
  setProfile: (profileId: string | null) => void;

  /** Облачный профиль: перечитать свою строку из `profiles`. */
  loadCloudProfile: () => Promise<CloudProfile | null>;
  /** Облачный профиль: свести локальный с облачным (после входа). */
  syncProfileNow: () => Promise<void>;
  /** Облачный профиль: отправить локальные поля в облако сейчас. */
  saveProfileToCloud: () => Promise<boolean>;

  /** Служебное: собрать строки для отправки (см. collectLocalRows). */
  collectLocal: (skip?: ReadonlySet<string>) => OutboundRow[];
  /** Служебное: применить серверные строки (см. applyRemoteRows). */
  applyRemote: (rows: IncomingRow[]) => string[];
  /** Служебное: запланировать круг синхронизации после изменений. */
  scheduleSync: () => void;
}

let started = false;
let timer: number | null = null;
let profileTimer: number | null = null;
let running = false;
/** Попытка тихой настройки вшитой конфигурации: одна на всё приложение. */
let configuring: Promise<boolean> | null = null;
/**
 * Идёт применение серверных строк: подписки на сторы в этот момент стреляют
 * сами, и планировать новый круг из-за них не нужно.
 */
let quiet = false;
/** Идёт сведение профиля: обратную отправку в облако из-за него не затеваем. */
let cloudQuiet = false;

export const useSyncStore = create<SyncState>((set, get) => ({
  status: {
    configured: false,
    signedIn: false,
    email: null,
    userId: null,
    lastSyncAtMs: null,
    lastError: null,
  },
  busy: false,
  progress: 0,
  pendingCount: 0,
  config: readConfig(),
  remoteOffline: snapshotMeta().remoteOffline,
  cloudProfile: null,
  cloudBusy: false,
  cloudError: null,
  role: null,

  init: async (profileId) => {
    const id = profileId === undefined ? useProfileStore.getState().activeId : profileId;
    setMetaScope(id);
    set({ remoteOffline: snapshotMeta().remoteOffline });
    subscribeStores();

    await refreshStatus();
    set({ config: readConfig() });
    refreshPending();

    // Аккаунт уже настроен и вход выполнен — сразу переносим данные
    const status = get().status;
    if (status.configured && status.signedIn && status.userId) {
      void runSync();
      void pullCloudProfile();
      // Привязка устройства и роль владельца: тихо, без сети — просто без них
      void bindDeviceAndRole();
      // Ключ в сборке могли поменять: тот же тихий вызов это заметит и
      // перенастроит подключение. Когда всё на месте, сети он не касается.
      void autoConfigure();
      return;
    }
    // Вшитая конфигурация: один тихий вызов, пользователь полей не видит.
    // Нет сети — молча работаем без аккаунта и повторим при входе.
    void autoConfigure();
  },

  configure: async (url, anonKey) => {
    const clean: SyncConfig = { url: url.trim(), anonKey: anonKey.trim() };
    try {
      await syncConfigure(clean.url, clean.anonKey);
      saveConfig(clean);
      set({ config: clean });
      await refreshStatus();
      refreshPending();
      const status = get().status;
      if (status.signedIn && status.userId) {
        void runSync();
        void pullCloudProfile();
        void bindDeviceAndRole();
      } else {
        set({ role: null });
      }
      return status.configured;
    } catch (e) {
      fail("Не удалось сохранить подключение", e);
      return false;
    }
  },

  signUp: async (email, password, username, inviteCode) => {
    if (username?.trim()) rememberPendingUsername(username);
    // Поле с ключом пользователь не видит: подключение готовим сами
    await autoConfigure();
    try {
      await syncSignUp(email.trim(), password, inviteCode?.trim() || undefined);
      await refreshStatus();
      const status = get().status;
      // Supabase может требовать подтверждение почты: тогда вход ещё не выполнен
      if (status.signedIn) {
        await runSync();
        await pullCloudProfile();
        void bindDeviceAndRole();
        return { ok: true, needsConfirmation: false, registrationClosed: false, error: null };
      }
      return {
        ok: false,
        needsConfirmation: true,
        registrationClosed: false,
        error: status.lastError,
      };
    } catch (e) {
      fail("Не удалось создать аккаунт", e);
      const error = get().status.lastError ?? "";
      return {
        ok: false,
        needsConfirmation: false,
        registrationClosed: isRegistrationClosed(error),
        error,
      };
    }
  },

  signIn: async (email, password) => {
    await autoConfigure();
    try {
      await syncSignIn(email.trim(), password);
      await refreshStatus();
      const status = get().status;
      if (status.signedIn) {
        await runSync();
        await pullCloudProfile();
        void bindDeviceAndRole();
        return { ok: true, needsConfirmation: false, registrationClosed: false, error: null };
      }
      return { ok: false, needsConfirmation: false, registrationClosed: false, error: status.lastError };
    } catch (e) {
      fail("Не удалось войти в аккаунт", e);
      const error = get().status.lastError ?? "";
      return {
        ok: false,
        needsConfirmation: false,
        registrationClosed: isRegistrationClosed(error),
        error,
      };
    }
  },

  signOut: async () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (profileTimer !== null) {
      window.clearTimeout(profileTimer);
      profileTimer = null;
    }
    try {
      await syncSignOut();
    } catch (e) {
      fail("Не удалось выйти из аккаунта", e);
    }
    await refreshStatus();
    // Локальные данные никуда не деваются: выход только про перенос.
    // Облачный профиль тоже забываем — он принадлежал аккаунту.
    set({ progress: 0, pendingCount: 0, cloudProfile: null, cloudError: null, role: null });
  },

  syncNow: async () => {
    await runSync();
  },

  setProfile: (profileId) => {
    setMetaScope(profileId);
    set({ remoteOffline: snapshotMeta().remoteOffline });
    refreshPending();
  },

  refreshRole: async () => {
    if (!get().status.signedIn) {
      if (get().role !== null) set({ role: null });
      return;
    }
    const owner = await meIsOwner();
    set({ role: owner ? "owner" : "user" });
  },

  loadCloudProfile: () => loadCloudProfile(),
  syncProfileNow: () => pullCloudProfile(),
  saveProfileToCloud: () => publishProfile(),

  collectLocal: (skip) => collectLocalRows(userIdOf(), skip),
  applyRemote: (rows) => applyRemoteRows(rows),
  scheduleSync: () => scheduleSoon(),
}));

/* ------------------------------------------------------------------ */
/* Настройки подключения                                               */
/* ------------------------------------------------------------------ */

function readConfig(): SyncConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { url: "", anonKey: "" };
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    return {
      url: typeof parsed.url === "string" ? parsed.url : "",
      anonKey: typeof parsed.anonKey === "string" ? parsed.anonKey : "",
    };
  } catch {
    return { url: "", anonKey: "" };
  }
}

function saveConfig(config: SyncConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // не критично: поля формы заполнятся в следующий раз пустыми
  }
}

/** Идентификатор аккаунта или пустая строка: без него строки не собрать. */
function userIdOf(): string {
  return useSyncStore.getState().status.userId ?? "";
}

/* ------------------------------------------------------------------ */
/* Вшитая конфигурация и облачный профиль                              */
/* ------------------------------------------------------------------ */

/**
 * Тихо настроить подключение вшитыми адресом и ключом. Обычный пользователь
 * этих полей не видит вообще: он просто регистрируется. Нет сети — значит нет
 * аккаунта, музыка работает и так; ни тоста, ни записи в журнал ошибок.
 */
function autoConfigure(): Promise<boolean> {
  if (configuring) return configuring;
  const attempt = autoConfigureOnce().finally(() => {
    configuring = null;
  });
  configuring = attempt;
  return attempt;
}

async function autoConfigureOnce(): Promise<boolean> {
  const embedded = embeddedConfig();
  if (!embedded) return false;

  // Ровно та же пара уже сохранена и подключение поднято — лишний запрос не
  // нужен. А вот смену ключа в сборке замечаем: иначе приложение молча
  // осталось бы со старым ключом и перестало работать.
  const saved = readConfig();
  const same = saved.url === embedded.url && saved.anonKey === embedded.anonKey;
  if (useSyncStore.getState().status.configured && same) return true;

  try {
    const status = await syncConfigure(embedded.url, embedded.anonKey);
    saveConfig(embedded);
    useSyncStore.setState({ config: embedded, status: { ...status, lastError: null } });
    refreshPending();
    const after = useSyncStore.getState().status;
    if (after.signedIn && after.userId) {
      void runSync();
      void pullCloudProfile();
    }
    return status.configured;
  } catch {
    // Молча: пользователю показывать нечего, повторим при следующем входе
    return false;
  }
}

/** Привязки «аккаунт → локальный профиль»: у каждого аккаунта свой профиль. */
function readBindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BINDING_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const bindings: Record<string, string> = {};
    for (const [userId, profileId] of Object.entries(parsed)) {
      if (typeof profileId === "string" && profileId) bindings[userId] = profileId;
    }
    return bindings;
  } catch {
    return {};
  }
}

function writeBinding(userId: string, profileId: string): void {
  try {
    localStorage.setItem(BINDING_KEY, JSON.stringify({ ...readBindings(), [userId]: profileId }));
  } catch {
    // не критично: в следующий раз привяжемся к активному профилю
  }
}

function rememberPendingUsername(username: string): void {
  try {
    localStorage.setItem(PENDING_USERNAME_KEY, username.trim());
  } catch {
    // не критично: юзернейм возьмём из локального профиля
  }
}

function pendingUsername(): string | null {
  try {
    const value = localStorage.getItem(PENDING_USERNAME_KEY)?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

function clearPendingUsername(): void {
  try {
    localStorage.removeItem(PENDING_USERNAME_KEY);
  } catch {
    // не критично
  }
}

/** Локальный профиль этого аккаунта: привязанный, иначе активный. */
function bindLocalProfile(userId: string): Profile | null {
  const store = useProfileStore.getState();
  const bound = readBindings()[userId];
  if (bound) {
    const found = store.profiles.find((profile) => profile.id === bound);
    if (found) return found;
  }
  const active = store.profiles.find((profile) => profile.id === store.activeId) ?? store.profiles[0] ?? null;
  if (active) writeBinding(userId, active.id);
  return active;
}

function findProfile(profileId: string): Profile | null {
  return useProfileStore.getState().profiles.find((profile) => profile.id === profileId) ?? null;
}

/**
 * После входа/регистрации: привязать этот компьютер к аккаунту и узнать роль.
 *
 * Привязка — это «человек забыл пароль и ник»: сервер по HWID подскажет почту,
 * а дальше обычный сброс пароля письмом. Роль решает сервер (`is_owner`), по ней
 * интерфейс прячет разделы разработчика. Ошибки обеих операций вход не ломают.
 */
async function bindDeviceAndRole(): Promise<void> {
  try {
    const hwid = await machineHwid();
    if (hwid) void deviceBind(hwid).catch(() => undefined);
  } catch {
    // отпечаток не определился (не Windows, нет реестра) — вход всё равно работает
  }
  await useSyncStore.getState().refreshRole();
}

/** Слишком большая картинка в облако не поедет: там её не примут. */
function cloudImage(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  return raw.length > MAX_CLOUD_IMAGE_CHARS ? null : raw;
}

/**
 * Приватность ведёт модель профиля (её пишет другой подрядчик): правила лежат
 * в `useProfileStore.privacy` по идентификатору профиля. Читаем аккуратно —
 * если записи ещё нет, поле в самом профиле, или всё пусто, отправляем пустой
 * объект, то есть «всё видно». Ничего не додумываем и не затираем.
 */
function readPrivacy(profile: Profile | null | undefined): Record<string, unknown> {
  if (!profile) return {};
  const stored = useProfileStore.getState().privacy[profile.id];
  if (stored) return { ...stored };
  const raw = (profile as unknown as { privacy?: unknown }).privacy;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
  return {};
}

/** Что взять из облака в локальный профиль: заполненные поля облака главнее. */
function remotePatch(local: Profile, remote: CloudProfile): Partial<Profile> {
  const patch: Partial<Profile> = {};
  if (remote.username && remote.username !== local.username) patch.username = remote.username;
  if (remote.displayName && remote.displayName !== local.displayName) patch.displayName = remote.displayName;
  if (remote.avatar && remote.avatar !== local.avatar) patch.avatar = remote.avatar;
  if (remote.banner && remote.banner !== local.banner) patch.banner = remote.banner;
  if (remote.bio && remote.bio !== local.bio) patch.bio = remote.bio;
  return patch;
}

/** Есть ли в локальном профиле то, чего нет в облаке (тогда дозаливаем). */
function localDiffers(local: Profile, remote: CloudProfile): boolean {
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? "").trim() === (b ?? "").trim();
  return (
    !same(local.username, remote.username) ||
    !same(local.displayName, remote.displayName) ||
    !same(cloudImage(local.avatar), remote.avatar) ||
    !same(cloudImage(local.banner), remote.banner) ||
    !same(local.bio, remote.bio)
  );
}

/** Перечитать свою строку из `profiles` — без сведения с локальным профилем. */
async function loadCloudProfile(): Promise<CloudProfile | null> {
  const state = useSyncStore.getState();
  const userId = state.status.userId;
  if (!state.status.signedIn || !userId) return null;
  try {
    const remote = await profileGet(userId);
    useSyncStore.setState({ cloudProfile: remote });
    return remote;
  } catch (e) {
    useSyncStore.setState({
      cloudError: redactSecrets(e instanceof Error ? e.message : errorText(e)),
    });
    return null;
  }
}

/**
 * Свести локальный профиль с облачным после входа. Облако главнее по
 * заполненным полям: юзернейм уникален на весь проект. То, чего в облаке нет
 * (например, только что поставленный аватар), дозаливаем.
 */
async function pullCloudProfile(): Promise<void> {
  const state = useSyncStore.getState();
  const userId = state.status.userId;
  if (!state.status.signedIn || !userId) return;

  cloudQuiet = true;
  useSyncStore.setState({ cloudBusy: true, cloudError: null });
  try {
    const remote = await profileGet(userId);
    useSyncStore.setState({ cloudProfile: remote });

    if (remote) {
      const local = bindLocalProfile(userId);
      if (!local) {
        // Локального профиля нет вовсе — создаём по данным сервера
        await useProfileStore.getState().create({
          username: remote.username,
          displayName: remote.displayName ?? remote.username,
          bio: remote.bio ?? "",
          avatar: remote.avatar ?? null,
          banner: remote.banner ?? null,
        });
        return;
      }
      const patch = remotePatch(local, remote);
      let adoptFailed = false;
      if (Object.keys(patch).length) {
        try {
          await useProfileStore.getState().update(local.id, patch);
        } catch {
          // Юзернейм из облака занят другим профилем на этом устройстве:
          // остальные поля всё равно применим, а ник оставим локальный
          adoptFailed = true;
          const { username: _skip, ...rest } = patch;
          if (Object.keys(rest).length) await useProfileStore.getState().update(local.id, rest);
        }
      }
      // Дозаливаем только то, чего в облаке нет. При неудачном сведении не
      // отправляем ничего: иначе локальный ник затёр бы облачный.
      if (!adoptFailed) {
        const merged = findProfile(local.id) ?? local;
        if (localDiffers(merged, remote)) await publishProfile();
      }
      return;
    }

    // Строки в облаке ещё нет: создаём из юзернейма, введённого при
    // регистрации, и локального профиля
    const pending = pendingUsername();
    const local = bindLocalProfile(userId);
    if (local && pending && pending !== local.username) {
      try {
        await useProfileStore.getState().update(local.id, { username: pending });
      } catch {
        // имя занято на устройстве — оставим локальное
      }
    }
    if (local || pending) {
      const saved = await publishProfile({ username: pending ?? undefined });
      if (saved && pending) clearPendingUsername();
    }
  } catch (e) {
    useSyncStore.setState({
      cloudError: redactSecrets(e instanceof Error ? e.message : errorText(e)),
    });
  } finally {
    cloudQuiet = false;
    useSyncStore.setState({ cloudBusy: false });
  }
}

/**
 * Отправить свой профиль в облако (`profiles`). Ошибку не глотаем: занятый
 * юзернейм человек должен увидеть, иначе будет думать, что его найдут.
 */
async function publishProfile(overrides?: { username?: string }): Promise<boolean> {
  const state = useSyncStore.getState();
  const userId = state.status.userId;
  if (!state.status.signedIn || !userId) return false;

  const local = bindLocalProfile(userId);
  const username = (overrides?.username ?? local?.username ?? state.cloudProfile?.username ?? "").trim();
  if (!username) {
    useSyncStore.setState({ cloudError: "Укажи юзернейм — по нему тебя найдут в разделе «Люди»" });
    return false;
  }

  const draft: CloudProfileDraft = {
    username,
    displayName: (local?.displayName ?? state.cloudProfile?.displayName ?? username).trim(),
    avatar: cloudImage(local?.avatar ?? state.cloudProfile?.avatar),
    banner: cloudImage(local?.banner ?? state.cloudProfile?.banner),
    bio: (local?.bio ?? state.cloudProfile?.bio ?? "").trim(),
    privacy: readPrivacy(local),
  };

  useSyncStore.setState({ cloudBusy: true });
  try {
    const saved = await profileUpsert(draft);
    useSyncStore.setState({ cloudProfile: saved, cloudError: null });
    return true;
  } catch (e) {
    const text = redactSecrets(e instanceof Error ? e.message : errorText(e));
    logError("Профиль не сохранён в облако", text, "синхронизация", text);
    useSyncStore.setState({ cloudError: text });
    return false;
  } finally {
    useSyncStore.setState({ cloudBusy: false });
  }
}

/** Правки профиля уезжают в облако с задержкой: форма не должна слать каждый символ. */
function scheduleProfilePush(): void {
  if (cloudQuiet) return;
  const state = useSyncStore.getState();
  if (!state.status.signedIn || !state.status.userId) return;
  if (profileTimer !== null) window.clearTimeout(profileTimer);
  profileTimer = window.setTimeout(() => {
    profileTimer = null;
    void publishProfile();
  }, PROFILE_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ */
/* Сбор локальных строк                                                */
/* ------------------------------------------------------------------ */

/** Проверка строки, пришедшей с сервера: чужие поля и виды пропускаем. */
function toLocalRow(value: unknown): IncomingRow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  const itemId = raw.item_id;
  if (typeof kind !== "string" || !SYNC_KINDS.includes(kind as SyncKind)) return null;
  if (typeof itemId !== "string" || !itemId) return null;
  const payload =
    raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : {};
  return {
    kind: kind as SyncKind,
    item_id: itemId,
    payload,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
    deleted: raw.deleted === true,
  };
}

/**
 * Время локального изменения записи. У старых записей его нет: считаем
 * моментом первого сбора — такую запись отправим один раз, а дальше она молчит.
 */
function adopt(kind: SyncKind, itemId: string, atMs?: number): number {
  const known = updatedAtOf(kind, itemId);
  if (known !== undefined) return known;
  const at = atMs !== undefined && Number.isFinite(atMs) && atMs > 0 ? atMs : Date.now();
  touch(kind, itemId, at);
  return updatedAtOf(kind, itemId) ?? at;
}

function offlinePayload(file: SavedFile): Record<string, unknown> {
  return { kept: file.kept, kind: file.kind, method: file.method };
}

function historyPayload(entry: HistoryEntry): Record<string, unknown> {
  return {
    plays: entry.plays,
    at: entry.at,
    title: entry.title,
    artist: entry.artist,
    cover: entry.cover,
  };
}

/**
 * Все локальные строки, изменённые с прошлой успешной синхронизации, плюс
 * надгробия. `skip` — то, что только что пришло с сервера: обратно не гоняем.
 */
function collectLocalRows(userId: string, skip?: ReadonlySet<string>): OutboundRow[] {
  const rows: OutboundRow[] = [];
  if (!userId) return rows; // без идентификатора строку собрать нельзя
  const meta = snapshotMeta();
  const since = meta.lastSyncAtMs;
  const seen = new Set<string>();

  const add = (
    kind: SyncKind,
    itemId: string,
    payload: Record<string, unknown>,
    atMs: number,
    deleted: boolean
  ) => {
    const key = keyOf(kind, itemId);
    if (seen.has(key) || skip?.has(key)) return;
    seen.add(key);
    if (!(atMs > since)) return; // уже синхронизировано
    rows.push({ user_id: userId, kind, item_id: itemId, payload, deleted });
  };

  // Надгробия первыми: удаление важнее, чем живая запись с тем же ключом
  for (const stone of meta.tombstones) {
    add(stone.kind, stone.itemId, stone.payload ?? {}, stone.updatedAtMs, true);
  }

  for (const item of useFavoritesStore.getState().items) {
    add("favorite", item.id, cardPayload(item), adopt("favorite", item.id), false);
  }

  for (const file of useOfflineStore.getState().list) {
    add("offline", file.trackId, offlinePayload(file), adopt("offline", file.trackId, file.savedAtMs), false);
  }

  const settings = useSettingsStore.getState();
  for (const name of SYNCED_SETTINGS) {
    add("setting", name, { value: settings[name] }, adopt("setting", name), false);
  }

  // Плейлисты читаются лениво, как лайки: их список грузит страница, и без
  // этого вызова первый сбор просто не увидел бы плейлистов. Чтение
  // синхронное и ничего не делает, если профиль уже загружен; на время чтения
  // глушим подписки, чтобы загрузка не считалась изменением и не планировала
  // лишний круг — собранные плейлисты и так уедут в этом же сборе.
  const wasQuiet = quiet;
  quiet = true;
  ensurePlaylistsLoaded();
  quiet = wasQuiet;

  for (const playlist of usePlaylistsStore.getState().items) {
    // Своё время изменения плейлиста (`updatedAt`) — и есть локальная метка
    add(
      "playlist",
      playlist.id,
      playlistPayload(playlist),
      adopt("playlist", playlist.id, playlist.updatedAt),
      false
    );
  }

  for (const entry of useHistoryStore.getState().entries) {
    add("history", entry.id, historyPayload(entry), adopt("history", entry.id, entry.at), false);
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/* Применение серверных строк                                          */
/* ------------------------------------------------------------------ */

function applyRemoteFavorite(row: IncomingRow): void {
  const store = useFavoritesStore.getState();
  if (row.deleted) {
    store.applyRemoteDelete(row.item_id);
    return;
  }
  const payload = row.payload;
  const card: FavoriteTrack = favoriteTrackFrom({
    id: row.item_id,
    title: typeof payload.title === "string" ? payload.title : undefined,
    artist: typeof payload.artist === "string" ? payload.artist : null,
    cover: typeof payload.cover === "string" ? payload.cover : null,
    source: payload.source === "service" ? "service" : payload.source === "local" ? "local" : undefined,
  });
  store.applyRemote(card);
}

function applyRemoteHistory(row: IncomingRow, atMs: number): void {
  const store = useHistoryStore.getState();
  if (row.deleted) {
    store.applyRemoteDelete(row.item_id);
    return;
  }
  const payload = row.payload;
  const service = serviceFromTrackId(row.item_id);
  const entry: HistoryEntry = {
    id: row.item_id,
    title: typeof payload.title === "string" && payload.title ? payload.title : row.item_id,
    artist: typeof payload.artist === "string" ? payload.artist : null,
    cover: typeof payload.cover === "string" ? payload.cover : null,
    source: service ? "service" : "local",
    path: service ? "" : row.item_id,
    plays: typeof payload.plays === "number" && payload.plays > 0 ? Math.round(payload.plays) : 1,
    at: typeof payload.at === "number" && Number.isFinite(payload.at) ? payload.at : atMs,
  };
  store.applyRemote(entry);
}

/**
 * Плейлист с сервера: из нагрузки собираем объект сторa. Название, описание,
 * обложку и список треков берём из payload, идентификатор — из строки, время
 * изменения — серверное (оно новее, раз строку вообще применяем). Локальное
 * время в `syncMeta` не трогаем: плейлист пришёл с сервера и «грязным» быть не
 * должен.
 */
function applyRemotePlaylist(row: IncomingRow, atMs: number): void {
  const store = usePlaylistsStore.getState();
  if (row.deleted) {
    store.applyRemoteDelete(row.item_id);
    return;
  }
  const payload = row.payload;
  const known = store.items.find((item) => item.id === row.item_id);
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null;
  const description =
    typeof payload.description === "string" && payload.description.trim() ? payload.description : undefined;
  const trackIds = Array.isArray(payload.trackIds)
    ? [...new Set(payload.trackIds.filter((id): id is string => typeof id === "string" && !!id))]
    : [];
  const playlist: Playlist = {
    id: row.item_id,
    name: name ?? known?.name ?? "Плейлист",
    description,
    cover: typeof payload.cover === "string" && payload.cover ? payload.cover : null,
    trackIds,
    // Дату создания сервер не хранит: у известного плейлиста она своя
    createdAt: known?.createdAt ?? atMs,
    updatedAt: atMs,
  };
  store.applyRemote(playlist);
}

/**
 * Применить серверные строки. Возвращает ключи применённого: их не нужно
 * отправлять обратно в этом же круге.
 *
 * Конфликт решает серверное `updated_at`, а не часы устройств: строку
 * применяем, только если она новее момента последней удачной синхронизации и
 * локально эту запись с тех пор не меняли. Локальное изменение всегда главнее —
 * оно уедет наверх.
 */
function applyRemoteRows(rows: IncomingRow[]): string[] {
  const applied: string[] = [];
  const reference = snapshotMeta().lastSyncAtMs;
  const own = userIdOf();
  quiet = true;
  try {
    for (const row of rows) {
      // Чужие строки не применяем никогда: доступ ограничивает RLS, но
      // проверка стоит копейки и защищает при неверной политике
      if (row.user_id && own && row.user_id !== own) continue;
      const at = Date.parse(row.updated_at);
      if (!Number.isFinite(at)) continue;
      // Локально меняли после последней синхронизации — наша версия главнее
      const local = updatedAtOf(row.kind, row.item_id) ?? 0;
      if (local > reference) continue;
      // Строку мы уже видели в прошлых кругах
      if (!(at > reference)) continue;

      switch (row.kind) {
        case "favorite":
          applyRemoteFavorite(row);
          break;
        case "offline":
          // Файла здесь нет: держим только отметку, что он есть на другом устройстве
          markRemoteOffline(row.item_id, row.deleted ? null : row.payload);
          break;
        case "setting":
          useSettingsStore.getState().applyRemote(row.item_id, row.payload.value);
          break;
        case "history":
          applyRemoteHistory(row, at);
          break;
        case "playlist":
          applyRemotePlaylist(row, at);
          break;
        default:
          // Незнакомый вид строки из чужой версии приложения — пропускаем
          break;
      }

      applied.push(keyOf(row.kind, row.item_id));
    }
  } finally {
    quiet = false;
  }
  useSyncStore.setState({ remoteOffline: snapshotMeta().remoteOffline });
  return applied;
}

/* ------------------------------------------------------------------ */
/* Круг синхронизации и подписки                                       */
/* ------------------------------------------------------------------ */

function refreshPending(): void {
  const state = useSyncStore.getState();
  const userId = state.status.userId;
  if (!state.status.configured || !state.status.signedIn || !userId) {
    useSyncStore.setState({ pendingCount: 0 });
    return;
  }
  useSyncStore.setState({ pendingCount: collectLocalRows(userId).length });
}

function scheduleSoon(): void {
  if (quiet) return;
  const state = useSyncStore.getState();
  // Без аккаунта ничего не планируем: приложение работает как обычно
  if (!state.status.configured || !state.status.signedIn || !state.status.userId) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void runSync();
  }, DEBOUNCE_MS);
}

function subscribeStores(): void {
  if (started) return;
  started = true;
  useFavoritesStore.subscribe((state, previous) => {
    if (state.items !== previous.items) scheduleSoon();
  });
  useOfflineStore.subscribe((state, previous) => {
    if (state.list !== previous.list) scheduleSoon();
  });
  useHistoryStore.subscribe((state, previous) => {
    if (state.entries !== previous.entries) scheduleSoon();
  });
  usePlaylistsStore.subscribe((state, previous) => {
    // Правки плейлистов (переименование, треки, удаление) едут тем же дебаунсом
    if (state.items !== previous.items) scheduleSoon();
  });
  useSettingsStore.subscribe((state, previous) => {
    // Реагируем только на переносимые настройки, а не на всё подряд
    for (const key of SYNCED_SETTINGS) {
      if (state[key] !== previous[key]) {
        scheduleSoon();
        return;
      }
    }
  });
  // Профиль уезжает в облако отдельно от строк `user_data`: там свои поля
  // (юзернейм, аватар, баннер, описание) и своя таблица — `profiles`.
  // Приватность едет вместе с ним: без неё чужие клиенты не узнают, что скрыто.
  useProfileStore.subscribe((state, previous) => {
    if (state.profiles !== previous.profiles || state.privacy !== previous.privacy) {
      scheduleProfilePush();
    }
  });
}

async function refreshStatus(): Promise<SyncStatus> {
  try {
    const status = await syncStatus();
    useSyncStore.setState({ status });
    return status;
  } catch (e) {
    // Команды может не быть в текущей сборке: пользователю об этом не сообщаем
    const text = redactSecrets(e instanceof Error ? e.message : errorText(e));
    logError(
      "Синхронизация недоступна",
      "Не удалось прочитать состояние аккаунта",
      "синхронизация",
      redactSecrets(errorText(e))
    );
    useSyncStore.setState((state) => ({ status: { ...state.status, lastError: text } }));
    return useSyncStore.getState().status;
  }
}

/**
 * Ошибка синхронизации — в журнал и в статус. Текст всегда проходит через
 * `redactSecrets`: anon-ключ (и всё похожее на ключ) в журнал не попадает.
 */
function fail(title: string, e: unknown): void {
  const text = redactSecrets(e instanceof Error ? e.message : errorText(e));
  logError(title, text, "синхронизация", redactSecrets(errorText(e)));
  useSyncStore.setState((state) => ({ status: { ...state.status, lastError: text } }));
}

/**
 * Круг синхронизации. Без настроенного проекта, без входа и без идентификатора
 * аккаунта — вообще ничего: ни одного сетевого вызова.
 */
async function runSync(): Promise<void> {
  if (running) return;
  const state = useSyncStore.getState();
  if (!state.status.configured || !state.status.signedIn) return;
  if (!state.status.userId) {
    // Идентификатор — часть первичного ключа: пробуем перечитать состояние
    await refreshStatus();
    if (!useSyncStore.getState().status.userId) {
      useSyncStore.setState((current) => ({
        status: { ...current.status, lastError: "Сервер не вернул идентификатор аккаунта — войди заново" },
      }));
      return;
    }
  }
  const userId = userIdOf();

  running = true;
  const startedAt = Date.now();
  useSyncStore.setState({ busy: true, progress: 0 });
  let succeeded = false;

  try {
    const since = snapshotMeta().lastSyncAtMs;

    // 1. Забираем то, что изменилось на других устройствах
    const incoming = toLocalRows(await syncPull(pullSince(since)));

    // 2. Применяем только более новые строки; конфликт решает серверное время
    const applied = applyRemoteRows(incoming);

    // 3. Отправляем свои изменения; пришедшее с сервера обратно не гоняем
    const outbound = collectLocalRows(userId, new Set(applied));
    useSyncStore.setState({ progress: outbound.length, pendingCount: outbound.length });
    if (outbound.length) await syncPush(outbound);

    // Успех: запоминаем начало круга. Всё, что изменилось во время круга,
    // останется «грязным» (его метка новее) и уедет следующим кругом.
    commitSync(startedAt);
    dropTombstones(startedAt);
    useSyncStore.setState((current) => ({
      status: { ...current.status, lastSyncAtMs: startedAt, lastError: null },
    }));
    succeeded = true;

    // 4. Канонические серверные updated_at и то, что успело появиться за круг
    await pullAfterPush(startedAt);
  } catch (e) {
    fail("Не удалось синхронизировать", e);
  } finally {
    quiet = false;
    running = false;
    useSyncStore.setState({ busy: false, progress: 0 });
    refreshPending();
    // Изменения, пришедшие во время круга, доводим следующим: иначе они
    // остались бы ждать случайного следующего действия пользователя.
    if (succeeded && useSyncStore.getState().pendingCount > 0) scheduleSoon();
  }
}

/** Разбор ответа pull: строки без обязательных полей просто пропускаем. */
function toLocalRows(pulled: unknown[]): IncomingRow[] {
  const rows: IncomingRow[] = [];
  for (const raw of pulled) {
    const row = toLocalRow(raw);
    if (row) rows.push(row);
  }
  return rows;
}

/** Время для запроса pull: с небольшим запасом, чтобы не потерять строки. */
function pullSince(atMs: number): number {
  return Math.max(0, atMs - PULL_MARGIN_MS);
}

/**
 * Второй pull после отправки: с сервера приходят канонические `updated_at`, а
 * заодно подхватывается то, что записало другое устройство за время круга.
 * Ошибка здесь не отменяет уже удачную отправку — только попадает в статус.
 */
async function pullAfterPush(since: number): Promise<void> {
  try {
    applyRemoteRows(toLocalRows(await syncPull(pullSince(since))));
  } catch (e) {
    fail("Не удалось прочитать изменения после отправки", e);
  }
}
