import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Palette,
  UserRound,
  Cloud,
  Plug,
  Info,
  Check,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Ticket,
  Volume2,
  Bell,
  Undo2,
  Download,
  Monitor,
  MonitorPlay,
  AlertTriangle,
  Trash2,
  ChevronRight,
  Hammer,
  AtSign,
  Image as ImageIcon,
  Link2,
  Ruler,
  Type,
  SlidersHorizontal,
  PanelTop,
  PanelLeft,
  Speaker,
  Database,
  Heart,
  ShieldCheck,
  Music2,
  Squircle,
  Square,
  ALargeSmall,
  ZoomIn,
  ZoomOut,
  Route as RouteIcon,
  Network,
  Search,
  type LucideIcon,
} from "lucide-react";
import Avatar from "../components/Avatar";
import OptionCards, { type OptionCard } from "../components/OptionCards";
import WallpaperSetting from "../components/WallpaperSetting";
import Modal, {
  GhostButton,
  PrimaryButton,
  SettingCards,
  SettingNote,
  SettingPanel,
  SettingRow,
  SettingSegments,
  SettingTabs,
} from "../components/Modal";
import { DENSITIES, PRESETS, deriveTheme, useThemeStore, type Density } from "../store/themeStore";
import {
  CORNER_OPTIONS,
  FONT_OPTIONS,
  NETWORK_ROUTE_OPTIONS,
  SCALE_OPTIONS,
  useSettingsStore,
  type CornerRadius,
  type FontSize,
  type NetworkRoute,
  type UiScale,
} from "../store/settingsStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import { APP_BUILD, APP_NAME, APP_VERSION } from "../lib/app";
import { checkUpdate, installUpdate, type UpdateInfo } from "../services/updates";
import { discordTest } from "../services/integrations";
import type { Profile } from "../services/profiles";
import { invoke } from "@tauri-apps/api/core";
import { useAppIcon, pickAppIcon, exportAppIconFile, applyWindowIcon } from "../lib/appIcon";
import { SOUND_PACKS } from "../lib/sounds";
import { discoverSoundcloudClientId } from "../services/catalog";
import { formatSize } from "../services/downloads";
import { serviceInfo, type ServiceId } from "../lib/services";
import { useErrorStore, errorText, logError, type AppError } from "../store/errorStore";
import { useServiceStore } from "../store/serviceStore";
import {
  PRIVACY_FIELDS,
  useProfilePrivacy,
  useProfileStore,
  type ProfilePrivacy,
} from "../store/profileStore";
import { useSyncStore } from "../store/syncStore";
import {
  hasEmbeddedConfig,
  inviteCheck,
  inviteCreate,
  inviteList,
  inviteRevoke,
  isInvitesUnsupported,
  isNotOwnerError,
  isRegistrationClosed,
  REGISTRATION_CLOSED_NOTICE,
  type Invite,
} from "../services/supabase";
import { validateUsername } from "../services/profiles";
import { audioOutputSupported, setAudioOutput } from "../player/audio";
import { detectLocalProxy, networkConfigure, testRoute } from "../services/network";

interface Props {
  profile: Profile;
  onOpenProfile: () => void;
  /** Раздел, который нужно открыть сразу: например «Ошибки» из уведомлений. */
  requestedSection?: SectionId | null;
  /** Открыть админ-панель (кнопка видна только владельцу). */
  onOpenAdmin?: () => void;
}

/**
 * Разделы верхнего уровня. Переключатель — сегментированный контрол с иконкой
 * и подписью (SettingTabs): активный получает тихую подложку accent/12 и
 * планку акцента снизу, остальные остаются mute без рамок.
 */
export type SettingsSectionId = "account" | "appearance" | "player" | "services" | "system" | "about";

/**
 * Идентификаторы, которые приходят извне (уведомления, кнопка «Настройки»).
 * Старые id оставлены: ссылки из уведомлений не должны устареть, а «Ошибки»
 * теперь открываются в разделе «О приложении» на под-вкладке журнала.
 */
export type SectionId =
  | SettingsSectionId
  | "profile"
  | "privacy"
  | "sound"
  | "errors"
  | "zapret";

const TABS: { id: SettingsSectionId; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "account", label: "Аккаунт", hint: "Профиль, приватность и перенос данных", icon: UserRound },
  { id: "appearance", label: "Интерфейс", hint: "Темы, акцент, форма и масштаб", icon: Palette },
  { id: "player", label: "Плеер", hint: "Звук, переходы между треками и офлайн", icon: Music2 },
  { id: "services", label: "Сервисы", hint: "SoundCloud, Discord и то, что не подключить", icon: Plug },
  { id: "system", label: "Система", hint: "Окно, уведомления и хранилище", icon: Monitor },
  { id: "about", label: "О приложении", hint: "Версия, журнал ошибок и черновики", icon: Info },
];

/** Под-вкладки разделов: сегментированная панель под верхними вкладками. */
const SUB_TABS: Record<SettingsSectionId, { id: string; label: string }[]> = {
  account: [
    { id: "profile", label: "Профиль" },
    { id: "privacy", label: "Приватность" },
    { id: "sync", label: "Синхронизация" },
  ],
  appearance: [
    { id: "look", label: "Вид" },
    { id: "tabs", label: "Вкладки" },
  ],
  player: [
    { id: "sound", label: "Звук" },
    { id: "transitions", label: "Переходы" },
  ],
  services: [
    { id: "soundcloud", label: "SoundCloud" },
    { id: "discord", label: "Discord" },
    { id: "other", label: "Другие" },
  ],
  system: [
    { id: "general", label: "Общее" },
    { id: "network", label: "Сеть" },
    { id: "storage", label: "Хранилище" },
  ],
  about: [
    { id: "app", label: "Приложение" },
    { id: "errors", label: "Журнал ошибок" },
    { id: "dev", label: "В разработке" },
  ],
};

/** Куда ведёт каждый внешний id: раздел верхнего уровня и под-вкладка. */
const SECTION_OF: Record<SectionId, { section: SettingsSectionId; sub: string }> = {
  account: { section: "account", sub: "profile" },
  appearance: { section: "appearance", sub: "look" },
  player: { section: "player", sub: "sound" },
  services: { section: "services", sub: "soundcloud" },
  system: { section: "system", sub: "general" },
  about: { section: "about", sub: "app" },
  profile: { section: "account", sub: "profile" },
  privacy: { section: "account", sub: "privacy" },
  sound: { section: "player", sub: "sound" },
  errors: { section: "about", sub: "errors" },
  zapret: { section: "about", sub: "dev" },
};

/**
 * Иконки плиток оформления: store хранит только данные и не знает про React,
 * поэтому «вид» варианта выбирается здесь.
 */
const CORNER_ICONS: Record<CornerRadius, LucideIcon> = {
  none: Square,
  sm: Squircle,
  md: Squircle,
  lg: Squircle,
};

const SCALE_ICONS: Record<UiScale, LucideIcon> = {
  75: ZoomOut,
  90: ZoomOut,
  100: Monitor,
  110: ZoomIn,
  125: ZoomIn,
};

export default function Settings({ profile, onOpenProfile, requestedSection, onOpenAdmin }: Props) {
  const appIcon = useAppIcon();
  const { presetId, colors, setPreset, setAccentRgb, density, setDensity } = useThemeStore();
  const accentFromCover = useThemeStore((s) => s.accentFromCover);
  const setAccentFromCover = useThemeStore((s) => s.setAccentFromCover);
  const settings = useSettingsStore();
  const [section, setSection] = useState<SettingsSectionId>("account");
  const [sub, setSub] = useState<string>("profile");

  // Пришли из уведомления с конкретным разделом — открываем его сразу
  useEffect(() => {
    if (!requestedSection) return;
    const target = SECTION_OF[requestedSection];
    setSection(target.section);
    setSub(target.sub);
  }, [requestedSection]);

  const [r, g, b] = colors.accent.split(" ").map(Number);
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

  const accentBefore = useRef<string | null>(null);
  const volumeBefore = useRef<number | null>(null);

  const [discordBusy, setDiscordBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  /** Поле лимита офлайн-хранилища: пустым его тоже надо показать. */
  const [cacheLimitDraft, setCacheLimitDraft] = useState(String(settings.cacheLimitMb));

  /**
   * Сеть: маршрут, адрес прокси, найденные локальные варианты и результат
   * проверки. Адрес в поле — черновик: в настройки он попадает только после
   * того, как Rust его принял.
   */
  const [proxyDraft, setProxyDraft] = useState(settings.proxyUrl);
  const [foundProxies, setFoundProxies] = useState<string[]>([]);
  const [proxyBusy, setProxyBusy] = useState<"detect" | "check" | null>(null);
  const [routeCheck, setRouteCheck] = useState<{ ok: boolean; text: string } | null>(null);

  // Адрес прокси могли изменить снаружи (синхронизация настроек) — обновляем поле
  useEffect(() => {
    setProxyDraft(settings.proxyUrl);
  }, [settings.proxyUrl]);
  const [whyOpen, setWhyOpen] = useState<ServiceId | null>(null);
  const [openError, setOpenError] = useState<AppError | null>(null);
  const errors = useErrorStore((s) => s.errors);
  const clearErrors = useErrorStore((s) => s.clear);
  const removeError = useErrorStore((s) => s.remove);

  /** Устройства вывода звука: список для выбора в разделе «Звук». */
  const [outputs, setOutputs] = useState<{ id: string; label: string }[]>([]);
  /** Движок умеет направлять звук на выбранное устройство. */
  const [outputSupported, setOutputSupported] = useState(true);
  /** Что показать после проверки звука: куда ушёл сигнал или текст ошибки. */
  const [soundCheck, setSoundCheck] = useState<string | null>(null);
  const [soundCheckBusy, setSoundCheckBusy] = useState(false);

  /** Приватность профиля: что видят другие. Хранится локально, по профилю. */
  const privacy = useProfilePrivacy(profile.id);

  /**
   * Аккаунт и синхронизация. Адрес проекта и anon-ключ вшиты в сборку, поэтому
   * обычный пользователь их не видит: он вводит юзернейм, почту и пароль.
   * Ручная настройка спрятана в «Дополнительно (для разработки)». Пока вход не
   * выполнен, приложение работает ровно так же, как без аккаунта.
   */
  const sync = useSyncStore();
  const [syncUrl, setSyncUrl] = useState(sync.config.url);
  const [syncKey, setSyncKey] = useState(sync.config.anonKey);
  const [syncEmail, setSyncEmail] = useState("");
  const [syncPassword, setSyncPassword] = useState("");
  const [syncUsername, setSyncUsername] = useState(profile.username);
  const [showPassword, setShowPassword] = useState(false);
  /** Что показываем: регистрацию в один клик или вход. */
  const [authMode, setAuthMode] = useState<"signUp" | "signIn">("signUp");
  /** Понятный текст ошибки прямо под формой — без модалок. */
  const [authError, setAuthError] = useState<string | null>(null);
  /** «У меня есть доступ»: снимает замок вручную — сервер всё равно проверит сам. */
  const [registrationUnlocked, setRegistrationUnlocked] = useState(false);
  /** Аккаунт создан, но Supabase ждёт подтверждения почты. */
  const [awaitingEmail, setAwaitingEmail] = useState(false);
  /** Ручная настройка нужна только разработчику. */
  const [advancedOpen, setAdvancedOpen] = useState(!hasEmbeddedConfig());
  const [syncBusy, setSyncBusy] = useState<
    "config" | "signIn" | "signUp" | "confirm" | "profile" | "sync" | "signOut" | null
  >(null);

  /**
   * Приглашения. Код вводится при регистрации (если есть), а панель выдачи
   * видна только владельцу: право решает сервер (`invite_list` → not_allowed).
   */
  const [inviteCode, setInviteCode] = useState("");
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [invitesAllowed, setInvitesAllowed] = useState(false);
  const [inviteNote, setInviteNote] = useState("");
  const [inviteDays, setInviteDays] = useState(14);
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [invitesBusy, setInvitesBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  /** Сервер не знает про приглашения: миграция не применена — показываем подсказку. */
  const [invitesUnsupported, setInvitesUnsupported] = useState(false);
  /** Обновления: что нашлось на сервере и идёт ли скачивание. */
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateNote, setUpdateNote] = useState<string | null>(null);

  // Адрес и ключ подставляем, когда их прочитал стор: при открытии настроек
  // они уже на месте, а поля показывают именно сохранённое.
  useEffect(() => {
    setSyncUrl(sync.config.url);
    setSyncKey(sync.config.anonKey);
  }, [sync.config.url, sync.config.anonKey]);

  // После выхода в форме снова локальный юзернейм: чужой аккаунт не подставляем
  useEffect(() => {
    if (!sync.status.signedIn) setSyncUsername(profile.username);
  }, [sync.status.signedIn, profile.username]);

  /** Строка состояния: «не настроено» / «не вошёл» / время или текст ошибки. */
  function syncLabel(): string {
    const state = sync.status;
    if (!state.configured) return "Подключение готовится";
    if (!state.signedIn) return "Аккаунт не подключён — это необязательно";
    if (state.lastError) return state.lastError;
    if (state.lastSyncAtMs) {
      return `Синхронизировано в ${new Date(state.lastSyncAtMs).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
    }
    return "Вход выполнен, переноса ещё не было";
  }

  const syncCredentialsReady = syncUrl.trim().length > 0 && syncKey.trim().length > 0;
  const signInReady = syncEmail.trim().length > 0 && syncPassword.length > 0;
  const signUpReady = signInReady && validateUsername(syncUsername).ok;
  /** Юзернейм, который видит сервер: он главнее локального. */
  const cloudUsername = sync.cloudProfile?.username ?? profile.username;
  /** Сервер отказал из-за закрытой регистрации — подсветим честный текст. */
  const closedByServer = isRegistrationClosed(authError) || isRegistrationClosed(sync.status.lastError);
  /**
   * Замок на форме создания аккаунта появляется ТОЛЬКО когда сервер уже
   * ответил «регистрация закрыта» — раньше он висел всегда, и человек с
   * ключом не мог даже ввести поля. Вход при этом доступен всегда.
   * «У меня есть доступ» снимает замок для повторной попытки с кодом,
   * окончательное решение всё равно за сервером.
   */
  const registrationLocked = authMode === "signUp" && closedByServer && !registrationUnlocked;

  // Сервер ответил «регистрация закрыта» — возвращаем замок и показываем текст
  // ошибки уже под слоем, чтобы он читался.
  useEffect(() => {
    if (closedByServer) setRegistrationUnlocked(false);
  }, [closedByServer]);

  // Панель приглашений видна только после входа, и только владельцу: сервер
  // отвечает not_allowed всем остальным — тогда раздел просто не появляется.
  // Отдельный случай — миграция не применена: это не «нет прав», а «модуля ещё
  // нет на сервере», и владельцу нужно сказать об этом словами.
  /**
   * Перечитать список приглашений и заодно выяснить, знает ли сервер про этот
   * модуль. Вынесено из эффекта: после применения SQL в Dashboard владелец
   * жмёт «Проверить снова» и не перезапускает приложение.
   */
  async function refreshInvites() {
    if (!useSyncStore.getState().status.signedIn) {
      setInvitesAllowed(false);
      setInvites(null);
      setInvitesUnsupported(false);
      return;
    }
    try {
      const list = await inviteList();
      setInvites(list);
      setInvitesAllowed(true);
      setInvitesUnsupported(false);
      setInviteError(null);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const notOwner = isNotOwnerError(text);
      const unsupported = isInvitesUnsupported(text);
      setInvitesAllowed(!notOwner);
      setInvitesUnsupported(unsupported && !notOwner);
      setInviteError(notOwner ? null : text);
    }
  }

  useEffect(() => {
    void refreshInvites();
    // refreshInvites читает актуальное состояние через store, поэтому в
    // зависимостях достаточно факта входа
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.status.signedIn]);

  /** Создать приглашение и обновить список. */
  async function createInvite() {
    setInvitesBusy(true);
    setInviteError(null);
    try {
      const created = await inviteCreate(inviteNote.trim() || null, inviteDays, inviteMaxUses);
      sounds.save();
      setInvites((current) => [created, ...(current ?? [])]);
      setInviteNote("");
      toast({ title: "Приглашение создано", description: created.code });
    } catch (e) {
      sounds.error();
      setInviteError(e instanceof Error ? e.message : String(e));
    } finally {
      setInvitesBusy(false);
    }
  }

  /** Отозвать код: уже зарегистрированные по нему остаются в проекте. */
  async function revokeInvite(code: string) {
    setInvitesBusy(true);
    setInviteError(null);
    try {
      const changed = await inviteRevoke(code);
      if (changed) {
        sounds.close();
        setInvites((current) =>
          (current ?? []).map((item) =>
            item.code === code ? { ...item, status: "revoked" } : item
          )
        );
        toast({ title: "Приглашение отозвано", description: code });
      } else {
        sounds.error();
        setInviteError("Сервер не нашёл такое приглашение — обнови список");
      }
    } catch (e) {
      sounds.error();
      setInviteError(e instanceof Error ? e.message : String(e));
    } finally {
      setInvitesBusy(false);
    }
  }

  async function copyInviteCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      sounds.save();
      toast({ title: "Код скопирован", description: code });
    } catch {
      sounds.error();
      toast({ title: "Не удалось скопировать", description: code });
    }
  }

  /**
   * Готовое сообщение другу: код, срок и шаги. Другу не нужно объяснять, что
   * такое Supabase и где искать поле кода — он просто запускает файл.
   */
  /**
   * Обновления: проверка вручную и установка. Скачивается установщик, дальше
   * работает NSIS — приложение закроется и заменит файлы само.
   */
  async function checkUpdates() {
    setUpdateBusy(true);
    setUpdateNote(null);
    try {
      const info = await checkUpdate();
      setUpdateInfo(info);
      if (info) sounds.save();
      else setUpdateNote("Обновлений нет — стоит последняя сборка");
    } catch (e) {
      setUpdateNote(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function runUpdate() {
    if (!updateInfo) return;
    setUpdateBusy(true);
    setUpdateNote(null);
    try {
      await installUpdate(updateInfo);
      sounds.save();
      setUpdateNote("Установщик открыт: заверши установку, приложение закроется");
    } catch (e) {
      sounds.error();
      setUpdateNote(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function copyInviteMessage(invite: Invite) {
    const until = new Date(invite.expiresAt).toLocaleDateString("ru-RU");
    const text = [
      `${APP_NAME}: доступ по приглашению`,
      `Код: ${invite.code} (до ${until})`,
      "",
      "Как войти:",
      `1. Открой файл ${APP_NAME}.exe (Windows 10/11, ставить ничего не нужно).`,
      "2. На первом экране приложение попросит ключ — вставь код выше.",
      "3. Дальше почта и пароль: аккаунт создастся сразу, ник подставится из почты.",
      "4. Если попросит подтвердить почту — перейди по ссылке из письма и нажми «Я подтвердил».",
      "",
      "Без кода регистрация закрыта: проект в бете.",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      sounds.save();
      toast({ title: "Приглашение скопировано", description: "Осталось вставить в чат другу" });
    } catch {
      sounds.error();
      toast({ title: "Не удалось скопировать", description: invite.code });
    }
  }

  /** Сохранить адрес проекта и anon key, затем перечитать состояние. */
  async function connectSync() {
    setSyncBusy("config");
    try {
      const ok = await sync.configure(syncUrl, syncKey);
      if (ok) {
        sounds.save();
        toast({ title: "Подключение сохранено", description: "Адрес проекта и ключ приняты" });
      } else {
        sounds.error();
      }
    } finally {
      setSyncBusy(null);
    }
  }

  /** Вход по почте и паролю. */
  async function signInSync(
    email = syncEmail,
    password = syncPassword,
    busy: "signIn" | "confirm" = "signIn"
  ) {
    setSyncBusy(busy);
    setAuthError(null);
    try {
      const result = await sync.signIn(email, password);
      if (result.ok) {
        sounds.save();
        setSyncPassword("");
        setAwaitingEmail(false);
        toast({ title: "Вход выполнен", description: "Данные переносятся на это устройство" });
      } else {
        sounds.error();
        setAuthError(result.error ?? "Не удалось войти в аккаунт");
      }
      return result;
    } finally {
      setSyncBusy(null);
    }
  }

  /** Регистрация в один клик: юзернейм, почта, пароль и код приглашения. */
  async function signUpSync() {
    setSyncBusy("signUp");
    setAuthError(null);
    try {
      // Код проверяем до отправки: форма не расходует его зря, а человек сразу
      // видит опечатку, а не загадочный отказ сервера
      const code = inviteCode.trim();
      if (code) {
        let valid = false;
        try {
          valid = await inviteCheck(code);
        } catch {
          valid = true; // проверка не удалась — пусть решает сервер
        }
        if (!valid) {
          sounds.error();
          setAuthError("Код приглашения недействителен, просрочен или уже использован");
          return;
        }
      }
      const result = await sync.signUp(syncEmail, syncPassword, syncUsername, code);
      if (result.ok) {
        sounds.save();
        setSyncPassword("");
        setAwaitingEmail(false);
        toast({ title: "Аккаунт создан", description: `@${syncUsername} — данные переносятся` });
      } else if (result.needsConfirmation) {
        // Токенов нет: Supabase прислал письмо, вход ещё не выполнен
        sounds.save();
        setAwaitingEmail(true);
      } else {
        sounds.error();
        setAuthError(result.error ?? "Не удалось создать аккаунт");
      }
    } finally {
      setSyncBusy(null);
    }
  }

  /** «Я подтвердил, войти»: тем же паролем, что вводили при регистрации. */
  async function confirmEmailSync() {
    await signInSync(syncEmail, syncPassword, "confirm");
  }

  /** Юзернейм и остальные поля — в облако, чтобы человека нашли в «Людях». */
  async function saveCloudProfile() {
    const name = validateUsername(syncUsername);
    if (!name.ok) {
      sounds.error();
      setAuthError(name.error ?? "Проверь юзернейм");
      return;
    }
    setSyncBusy("profile");
    setAuthError(null);
    try {
      await useProfileStore.getState().update(profile.id, { username: name.value });
      const ok = await useSyncStore.getState().saveProfileToCloud();
      if (ok) {
        sounds.save();
        toast({ title: "Профиль сохранён в облако", description: `@${name.value}` });
      } else {
        sounds.error();
        setAuthError(useSyncStore.getState().cloudError ?? "Не удалось сохранить профиль");
      }
    } finally {
      setSyncBusy(null);
    }
  }

  async function syncNow() {
    setSyncBusy("sync");
    try {
      await useSyncStore.getState().syncNow();
      if (useSyncStore.getState().status.lastError) sounds.error();
      else sounds.save();
    } finally {
      setSyncBusy(null);
    }
  }

  async function signOutSync() {
    setSyncBusy("signOut");
    try {
      await sync.signOut();
      sounds.close();
      toast({
        title: "Вышел из аккаунта",
        description: "Локальные данные остались на устройстве",
      });
    } finally {
      setSyncBusy(null);
    }
  }

  /**
   * Раздел «В разработке» и ручная настройка проекта — только владельцу.
   * Решает сервер (`is_owner` → `role` в syncStore), а не имя локального
   * профиля: раньше достаточно было назвать профиль «developer».
   */
  const isDeveloper = useSyncStore((s) => s.role === "owner");
  const visibleSub = SUB_TABS[section].filter((item) => isDeveloper || item.id !== "dev");
  const current = visibleSub.some((item) => item.id === sub) ? sub : visibleSub[0].id;
  const tabHint = TABS.find((item) => item.id === section)?.hint ?? "";

  // Автозапуск можно поменять и мимо приложения: запись в реестре Windows живая,
  // а в сторе лежит последнее известное значение. При открытии раздела «Система»
  // сверяемся с реестром, чтобы тумблер не показывал неправду.
  useEffect(() => {
    if (section !== "system" || current !== "general") return;
    let cancelled = false;
    void invoke<boolean>("autostart_get")
      .then((enabled) => {
        if (cancelled) return;
        if (enabled !== useSettingsStore.getState().autostart) {
          useSettingsStore.getState().setAutostart(enabled);
        }
      })
      .catch(() => {
        // Реестр недоступен — оставляем как есть: это проверка, а не действие
      });
    return () => {
      cancelled = true;
    };
  }, [section, current]);

  /**
   * Список устройств вывода. Обновляем при открытии под-вкладки «Звук» и по
   * событию `devicechange`: наушники подключают и отключают на ходу, и старый
   * список показывал бы то, чего уже нет.
   */
  useEffect(() => {
    if (section !== "player" || current !== "sound") return;
    let cancelled = false;
    const media = navigator.mediaDevices;

    const refresh = async () => {
      if (!cancelled) setOutputSupported(audioOutputSupported());
      if (!media?.enumerateDevices) {
        if (!cancelled) setOutputs([]);
        return;
      }
      try {
        const devices = await media.enumerateDevices();
        // Без разрешения на микрофон система отдаёт устройства без опознающего
        // id и без подписи: пункт без id выбрать нельзя, поэтому пропускаем его,
        // а безымянное устройство показываем номером — «Устройство 1».
        const found = devices
          .filter((device) => device.kind === "audiooutput" && device.deviceId)
          .map((device, index) => ({
            id: device.deviceId,
            label: device.label?.trim() || `Устройство ${index + 1}`,
          }));
        if (!cancelled) setOutputs(found);
      } catch {
        // Список устройств недоступен — остаётся системное по умолчанию
        if (!cancelled) setOutputs([]);
      }
    };

    void refresh();
    const onDeviceChange = () => void refresh();
    media?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      cancelled = true;
      media?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [section, current]);

  /**
   * Плитки устройств вывода: системное умолчание плюс все перечисленные
   * устройства. Селекта нет — весь список виден сразу и выбирается кликом.
   * Выбранное устройство остаётся в списке, даже если система отдала его
   * последним или оно уже отключено.
   */
  const outputOptions: OptionCard[] = useMemo(() => {
    const cards: OptionCard[] = [
      {
        id: "default",
        label: "Системное по умолчанию",
        hint: "Куда Windows отправляет звук",
        icon: Monitor,
      },
    ];
    const current = outputs.find((device) => device.id === settings.audioOutputId);
    if (settings.audioOutputId !== "default" && !current) {
      cards.push({
        id: settings.audioOutputId,
        label: "Выбранное устройство",
        hint: "Сейчас недоступно",
        icon: Speaker,
      });
    }
    for (const device of outputs) {
      const selected = device.id === settings.audioOutputId;
      cards.push({
        id: device.id,
        label: device.label,
        hint: selected ? "Выбрано сейчас" : undefined,
        icon: Speaker,
      });
    }
    return cards;
  }, [outputs, settings.audioOutputId]);

  /** Подпись устройства для строки состояния проверки звука. */
  function outputLabel(id: string): string {
    if (id === "default") return "системное по умолчанию";
    return outputs.find((device) => device.id === id)?.label ?? "выбранное устройство";
  }

  /**
   * Смена устройства вывода: сразу направляем звук плеера. Ошибка не остаётся
   * молчаливой — тост, журнал и возврат на системное умолчание: «выбрано, но
   * молчит» хуже всего и выглядит как пропавший звук.
   */
  async function changeOutput(id: string) {
    settings.setAudioOutputId(id);
    setSoundCheck(null);
    if (!audioOutputSupported()) return;
    try {
      await setAudioOutput(id === "default" ? "" : id);
      sounds.save();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      settings.setAudioOutputId("default");
      logError("Не удалось переключить устройство вывода", text, "звук", errorText(e));
      toast({ title: "Устройство вывода не переключилось", description: text, tone: "danger" });
      try {
        await setAudioOutput("");
      } catch {
        // Системное устройство тоже не приняло — оставляем как есть
      }
    }
  }

  /** Проверка звука: короткий сигнал и честная подпись, куда он ушёл. */
  async function checkSound() {
    const id = settings.audioOutputId;
    setSoundCheckBusy(true);
    try {
      const where = await playTestTone(id === "default" ? "" : id);
      setSoundCheck(`сигнал отправлен на: ${where === "device" ? outputLabel(id) : "системное по умолчанию"}`);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      logError("Проверка звука не удалась", text, "звук", errorText(e));
      setSoundCheck(`сигнал отправить не удалось: ${text}`);
    } finally {
      setSoundCheckBusy(false);
    }
  }

  function accentStart() {
    accentBefore.current = useThemeStore.getState().colors.accent;
  }

  function accentCommit() {
    const before = accentBefore.current;
    accentBefore.current = null;
    const now = useThemeStore.getState().colors.accent;
    if (!before || before === now) return;
    sounds.save();
    toast({
      title: "Акцентный цвет изменён",
      description: `rgb(${now})`,
      action: {
        label: "Отменить",
        run: () => {
          const [pr, pg, pb] = before.split(" ").map(Number);
          setAccentRgb(pr, pg, pb);
        },
      },
    });
  }

  function choosePreset(id: string, label: string) {
    if (id === presetId) return;
    const previous = presetId;
    setPreset(id);
    sounds.save();
    toast({ title: `Тема: ${label}`, action: { label: "Отменить", run: () => setPreset(previous) } });
  }

  function chooseDensity(id: Density, label: string) {
    if (id === density) return;
    const previous = density;
    setDensity(id);
    sounds.save();
    toast({ title: `Плотность: ${label}`, action: { label: "Отменить", run: () => setDensity(previous) } });
  }

  /** Где живёт навигация: панель сверху или боковое меню. Применяется сразу. */
  function chooseNavLayout(value: "top" | "side", label: string) {
    if (value === settings.navLayout) return;
    const previous = settings.navLayout;
    settings.setNavLayout(value);
    sounds.save();
    toast({
      title: `Навигация: ${label}`,
      action: { label: "Отменить", run: () => settings.setNavLayout(previous) },
    });
  }

  /** Скругление углов: значения радиусов в styles.css, здесь только выбор. */
  function chooseCorner(value: CornerRadius, label: string) {
    if (value === settings.cornerRadius) return;
    const previous = settings.cornerRadius;
    settings.setCornerRadius(value);
    sounds.save();
    toast({
      title: `Скругление: ${label}`,
      action: { label: "Отменить", run: () => settings.setCornerRadius(previous) },
    });
  }

  /** Масштаб интерфейса: корневой кегль и отступы. */
  function chooseScale(value: UiScale, label: string) {
    if (value === settings.uiScale) return;
    const previous = settings.uiScale;
    settings.setUiScale(value);
    sounds.save();
    toast({
      title: `Масштаб интерфейса: ${label}`,
      action: { label: "Отменить", run: () => settings.setUiScale(previous) },
    });
  }

  /** Размер шрифта интерфейса: только подписи, сетку не двигает. */
  function chooseFontSize(value: FontSize, label: string) {
    if (value === settings.fontSize) return;
    const previous = settings.fontSize;
    settings.setFontSize(value);
    sounds.save();
    toast({
      title: `Размер шрифта: ${label} px`,
      action: { label: "Отменить", run: () => settings.setFontSize(previous) },
    });
  }

  /** Акцент из обложки текущего трека: цвет берётся с картинки, тема — фон. */
  function toggleAccentFromCover() {
    const next = !accentFromCover;
    setAccentFromCover(next);
    if (next) sounds.on();
    else sounds.off();
    toast({
      title: next ? "Акцент берём из обложки" : "Акцент вернулся к теме",
      description: next
        ? "Если обложки нет или цвет не читается, остаётся акцент темы"
        : undefined,
      action: { label: "Отменить", run: () => setAccentFromCover(!next) },
    });
  }

  /**
   * Настройки островка живут в Rust: он создаёт окно и решает, когда его
   * показывать. Поэтому после каждого переключателя отправляем всю тройку.
   */
  function pushIslandConfig(next: { enabled: boolean; always: boolean; alwaysOnTop: boolean }) {
    void invoke("island_config", {
      config: { enabled: next.enabled, always: next.always, alwaysOnTop: next.alwaysOnTop },
    }).catch(() => {});
  }

  function toggleIsland() {
    const enabled = !settings.islandEnabled;
    settings.setIslandEnabled(enabled);
    pushIslandConfig({ enabled, always: settings.islandAlways, alwaysOnTop: settings.islandAlwaysOnTop });
  }

  function toggleIslandAlways() {
    const always = !settings.islandAlways;
    settings.setIslandAlways(always);
    pushIslandConfig({ enabled: settings.islandEnabled, always, alwaysOnTop: settings.islandAlwaysOnTop });
  }

  function toggleIslandOnTop() {
    const alwaysOnTop = !settings.islandAlwaysOnTop;
    settings.setIslandAlwaysOnTop(alwaysOnTop);
    pushIslandConfig({ enabled: settings.islandEnabled, always: settings.islandAlways, alwaysOnTop });
  }
  function toggleSound() {
    const next = !settings.soundEnabled;
    if (next) {
      settings.setSoundEnabled(true);
      sounds.on();
    } else {
      sounds.off();
      settings.setSoundEnabled(false);
    }
    toast({
      title: `Звуки интерфейса ${next ? "включены" : "выключены"}`,
      action: { label: "Отменить", run: () => settings.setSoundEnabled(!next) },
    });
  }

  function toggleToasts() {
    const next = !settings.toastsEnabled;
    settings.setToastsEnabled(next);
    if (next) sounds.on();
    else sounds.off();
    toast(
      {
        title: `Уведомления ${next ? "включены" : "выключены"}`,
        action: { label: "Отменить", run: () => settings.setToastsEnabled(!next) },
      },
      { force: true }
    );
  }

  function toggleDiscord() {
    const next = !settings.discordEnabled;
    settings.setDiscordEnabled(next);
    if (next) sounds.on();
    else sounds.off();
    toast({
      title: `Discord: показ активности ${next ? "включён" : "выключен"}`,
      action: { label: "Отменить", run: () => settings.setDiscordEnabled(!next) },
    });
  }

  async function testDiscord() {
    setDiscordBusy(true);
    try {
      await discordTest(settings.discordClientId, "logo");
      sounds.save();
      toast({ title: "Активность отправлена", description: "Проверь свой профиль в Discord" });
    } catch (e) {
      sounds.error();
      toast({
        title: "Discord не принял активность",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    } finally {
      setDiscordBusy(false);
    }
  }

  async function saveIcon() {
    setIconBusy(true);
    try {
      const path = await exportAppIconFile(settings.customAppIcon);
      sounds.save();
      toast({ title: "Иконка сохранена", description: path });
    } catch (e) {
      sounds.error();
      toast({
        title: "Не удалось сохранить иконку",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    } finally {
      setIconBusy(false);
    }
  }

  /** Своя иконка приложения: подходит PNG, JPEG, WebP и анимированный GIF. */
  async function chooseAppIcon() {
    try {
      const picked = await pickAppIcon();
      if (!picked) return;
      settings.setCustomAppIcon(picked);
      await applyWindowIcon(picked);
      sounds.save();
      toast({
        title: "Иконка приложения обновлена",
        description: picked.startsWith("data:image/gif") ? "Анимированный GIF сохранит движение" : undefined,
        action: { label: "Отменить", run: () => void resetAppIcon() },
      });
    } catch (e) {
      sounds.error();
      toast({
        title: "Не удалось поставить иконку",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    }
  }

  async function resetAppIcon() {
    settings.setCustomAppIcon(null);
    await applyWindowIcon(null);
    sounds.off();
    toast({ title: "Вернул встроенную иконку" });
  }

  function volumeStart() {
    volumeBefore.current = settings.soundVolume;
  }

  function volumeCommit() {
    const before = volumeBefore.current;
    volumeBefore.current = null;
    const now = useSettingsStore.getState().soundVolume;
    if (before === null || before === now) return;
    sounds.save();
    toast({
      title: `Громкость звуков: ${Math.round(now * 100)}%`,
      action: { label: "Отменить", run: () => settings.setSoundVolume(before) },
    });
  }

  /** Переход на раздел/под-вкладку по внешнему id (например, из уведомления). */
  /**
   * Маршрут сети: сохраняем настройку и сразу передаём её в Rust — сетевой
   * слой живёт в процессе и не читает localStorage сам.
   */
  async function chooseNetworkRoute(route: NetworkRoute) {
    if (route === settings.networkRoute) return;
    settings.setNetworkRoute(route);
    setRouteCheck(null);
    sounds.save();
    try {
      await networkConfigure(route, settings.proxyUrl);
    } catch (e) {
      toast({
        title: "Маршрут не принят",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Адрес прокси проверяет Rust: мусор не запоминаем и показываем причину. */
  async function saveProxyUrl() {
    const value = proxyDraft.trim();
    if (value === settings.proxyUrl) return;
    try {
      await networkConfigure(settings.networkRoute, value);
      settings.setProxyUrl(value);
      setRouteCheck(null);
      toast({
        title: value ? "Прокси сохранён" : "Прокси убран",
        description: value || "Приложение снова ходит напрямую",
      });
    } catch (e) {
      // Возвращаем поле к сохранённому адресу: непроверенный не запоминаем
      setProxyDraft(settings.proxyUrl);
      toast({
        title: "Адрес прокси не принят",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Поиск локального прокси: только 127.0.0.1, наружу приложение не ходит. */
  async function findLocalProxy() {
    setProxyBusy("detect");
    try {
      const found = await detectLocalProxy();
      setFoundProxies(found);
      if (found.length === 0) {
        toast({
          title: "Локальный прокси не найден",
          description: "Проверены порты 7890, 7891, 1080, 10808, 2080, 9150 и 10801",
        });
      }
    } catch (e) {
      toast({
        title: "Поиск не получился",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setProxyBusy(null);
    }
  }

  /** Подставить найденный вариант: сохраняем его сразу, чтобы не забыть. */
  async function pickFoundProxy(value: string) {
    setProxyDraft(value);
    try {
      await networkConfigure(settings.networkRoute, value);
      settings.setProxyUrl(value);
      setRouteCheck(null);
      toast({ title: "Прокси выбран", description: value });
    } catch (e) {
      toast({
        title: "Адрес прокси не принят",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** «Проверить»: живой запрос через выбранный маршрут и время ответа. */
  async function checkRoute() {
    setProxyBusy("check");
    setRouteCheck(null);
    try {
      const result = await testRoute(settings.networkRoute, proxyDraft);
      setRouteCheck({ ok: true, text: `ок, ${result.ms} мс` });
    } catch (e) {
      setRouteCheck({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setProxyBusy(null);
    }
  }

  function openSection(id: SectionId) {
    const target = SECTION_OF[id];
    if (target.section === section && target.sub === current) return;
    sounds.open();
    setSection(target.section);
    setSub(target.sub);
  }

  /** Переключение верхней вкладки: внутри открывается первая под-вкладка. */
  function openTab(id: SettingsSectionId) {
    if (id === section) return;
    sounds.open();
    setSection(id);
    setSub(SUB_TABS[id][0].id);
  }

  /**
   * Пункт приватности: пишем сразу и даём откат — как у остальных тумблеров
   * приложения, чтобы случайное нажатие не оставалось без следа.
   */
  function togglePrivacy(key: keyof ProfilePrivacy) {
    const next = !privacy[key];
    const patch: Partial<ProfilePrivacy> = {};
    patch[key] = next;
    useProfileStore.getState().setPrivacy(profile.id, patch);
    if (next) sounds.on();
    else sounds.off();
    const label = PRIVACY_FIELDS.find((field) => field.key === key)?.title ?? "Приватность";
    toast({
      title: `${label}: ${next ? "видно другим" : "скрыто"}`,
      action: {
        label: "Отменить",
        run: () => {
          const back: Partial<ProfilePrivacy> = {};
          back[key] = !next;
          useProfileStore.getState().setPrivacy(profile.id, back);
        },
      },
    });
  }

  /** Автозапуск: пишем или убираем запись в реестре Windows. */
  async function toggleAutostart() {
    const next = !settings.autostart;
    try {
      await invoke("autostart_set", { enabled: next });
      settings.setAutostart(next);
      if (next) sounds.on();
      else sounds.off();
      toast({
        title: `Автозапуск с Windows ${next ? "включён" : "выключен"}`,
        description: next ? "Приложение будет стартовать вместе с системой" : undefined,
        action: {
          label: "Отменить",
          run: () => {
            void invoke("autostart_set", { enabled: !next });
            settings.setAutostart(!next);
          },
        },
      });
    } catch (e) {
      sounds.error();
      toast({
        title: "Не удалось изменить автозапуск",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    }
  }

  function toggleNotifications() {
    const next = !settings.notifyOnTrackChange;
    settings.setNotifyOnTrackChange(next);
    if (next) {
      sounds.on();
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          void Notification.requestPermission();
        }
      } catch {
        // ок
      }
    } else {
      sounds.off();
    }
    toast({
      title: `Уведомления о треках ${next ? "включены" : "выключены"}`,
      action: { label: "Отменить", run: () => settings.setNotifyOnTrackChange(!next) },
    });
  }

  function chooseClose(behavior: "ask" | "tray" | "quit", label: string) {
    if (behavior === settings.closeBehavior) return;
    const previous = settings.closeBehavior;
    settings.setCloseBehavior(behavior);
    sounds.save();
    toast({
      title: `При закрытии: ${label}`,
      action: { label: "Отменить", run: () => settings.setCloseBehavior(previous) },
    });
  }

  return (
    <div className="max-w-[1040px]">
      {/* Шапка раздела в языке STUDIO: метка, крупный заголовок, пояснение.
          Раньше здесь была одна строка «Настройки» — экран начинался с пустоты. */}
      <header className="mb-6">
              <h1 className="title-page">Настройки</h1>
        <p className="text-[13px] text-muted mt-2 max-w-[620px] leading-relaxed">
          Всё, что меняет поведение и вид плеера. Изменения применяются сразу и хранятся
          на этом устройстве; часть настроек синхронизируется с профилем.
        </p>
      </header>

      <button type="button" onClick={() => { setSection("system"); setSub("storage"); }} className="mb-5 flex w-full items-center justify-between gap-4 rounded-2xl border border-accent/25 bg-accent/[0.06] px-4 py-3 text-left transition hover:bg-accent/[0.10]">
        <span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/10 text-accent"><ShieldCheck size={17}/></span><span><span className="block text-[13px] text-ink">Резервная копия настроек</span><span className="mt-0.5 block text-[12px] text-muted">Экспортируй настройки или восстанови их из файла</span></span></span>
        <ChevronRight size={16} className="shrink-0 text-muted"/>
      </button>

      {/* Переключатель разделов: сегменты «иконка + подпись», акцент — у активного. */}
      <SettingTabs items={TABS} value={section} onChange={openTab} group="sections" />
      {tabHint && <p className="text-[12px] text-muted mt-2.5">{tabHint}</p>}

      {/* Под-вкладки: делит раздел, только когда делить есть что */}
      {visibleSub.length > 1 && (
        <div className="mt-4 mb-5">
          <SettingSegments items={visibleSub} value={current} onChange={setSub} group={section} />
        </div>
      )}
      {visibleSub.length <= 1 && <div className="mt-5" />}

      <div className="grid grid-cols-1 min-[1180px]:grid-cols-2 gap-x-6 gap-y-4 items-start">
        {section === "account" && current === "profile" && (
          <SettingPanel>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Avatar profile={profile} size={44} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink truncate">{profile.displayName}</p>
                <p className="text-[12px] text-muted truncate">
                  @{profile.username}
                  {profile.guest ? " · гостевой профиль" : ""}
                </p>
              </div>
              <GhostButton onClick={onOpenProfile}>Открыть профиль</GhostButton>
            </div>
            <SettingRow
              icon={AtSign}
              title="Почта"
              hint={profile.email ?? "Не указана — можно добавить в профиле"}
              control={<GhostButton onClick={onOpenProfile}>Изменить</GhostButton>}
            />
            <SettingRow
              icon={ImageIcon}
              title="Аватар и баннер"
              hint={
                profile.avatar
                  ? "Аватар загружен — баннер и обрезка в профиле"
                  : "Пока стандартные — поставь свои в профиле, поддерживаются GIF"
              }
              control={<GhostButton onClick={onOpenProfile}>Настроить</GhostButton>}
            />
            <SettingRow
              icon={Lock}
              title="PIN"
              hint={profile.pin ? "PIN задан: вход в профиль защищён" : "PIN не задан"}
              control={<GhostButton onClick={onOpenProfile}>Настроить</GhostButton>}
            />
            <SettingRow
              icon={Music2}
              title="Статистика профиля"
              hint={`${profile.stats.hours.toFixed(1)} ч в музыке · ${profile.stats.tracks} треков · любимый исполнитель: ${
                profile.stats.topArtist ?? "пока нет"
              }${privacy.showStats ? "" : " · скрыто от других"}`}
              control={<GhostButton onClick={() => openSection("privacy")}>Приватность</GhostButton>}
            />
            <SettingNote>
              Данные профиля (имя, почта, аватар, баннер, PIN) хранятся только на этом устройстве в
              локальной базе. Статистика считается из истории прослушиваний при каждом её изменении, а
              правила приватности лежат локально рядом с профилем. Лайки и плейлисты — отдельно для
              каждого профиля.
            </SettingNote>
          </SettingPanel>
        )}

        {section === "account" && current === "privacy" && (
          <SettingPanel
            title="Что видят другие"
            hint="Свой профиль ты видишь полностью — эти правила работают только для чужих"
          >
            {PRIVACY_FIELDS.map((field) => (
              <SettingRow
                key={field.key}
                icon={field.key === "discoverable" ? ShieldCheck : Eye}
                title={field.title}
                hint={field.hint}
                control={
                  <Toggle
                    on={privacy[field.key]}
                    onChange={() => togglePrivacy(field.key)}
                    label={field.title}
                  />
                }
              />
            ))}
            <SettingNote>
              По умолчанию статистика и недавно прослушанное скрыты: приватность важнее. В чужом виде
              профиля выключенный пункт не показывается — вместо данных там честная заглушка «Скрыто
              владельцем профиля». Настройки хранятся локально, у каждого профиля свои; на другие
              устройства они пока не переносятся — профили в синхронизации не участвуют.
            </SettingNote>
          </SettingPanel>
        )}

        {section === "account" && current === "sync" && (
          <>
            <SettingPanel title="Аккаунт" hint="Перенос лайков, истории и настроек на другие устройства">
              {/* Состояние: одна строка. Полей с адресом и ключом здесь нет —
                  они вшиты в сборку, а для разработки спрятаны ниже. */}
              <div className="flex items-center gap-3 px-4 py-3.5">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    sync.status.lastError
                      ? "bg-amber-400"
                      : sync.status.signedIn
                        ? "bg-emerald-400"
                        : "bg-ink/25"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className={`text-[13px] ${sync.status.lastError ? "text-amber-300" : "text-ink"}`}>
                    {syncLabel()}
                  </p>
                  <p className="text-[12px] text-muted truncate">
                    {sync.status.signedIn
                      ? `Аккаунт: ${sync.status.email ?? "почта не указана"} · @${cloudUsername}`
                      : "Аккаунт необязателен: музыка играет и без него"}
                  </p>
                </div>
                {sync.status.signedIn && (
                  <GhostButton onClick={() => void signOutSync()} disabled={syncBusy !== null}>
                    {syncBusy === "signOut" ? "Выхожу…" : "Выйти"}
                  </GhostButton>
                )}
              </div>

              {sync.status.signedIn && (
                <>
                  <SettingRow
                    icon={AtSign}
                    title="Юзернейм в облаке"
                    hint={
                      sync.cloudError
                        ? sync.cloudError
                        : `По нему тебя найдут в разделе «Люди»${sync.cloudBusy ? " · сохраняю…" : ""}`
                    }
                    control={
                      <div className="flex items-center gap-2">
                        <input
                          value={syncUsername}
                          onChange={(event) => setSyncUsername(event.target.value)}
                          placeholder="username"
                          spellCheck={false}
                          autoComplete="off"
                          className="input w-40"
                        />
                        <GhostButton
                          onClick={() => void saveCloudProfile()}
                          disabled={syncBusy !== null || sync.cloudBusy}
                        >
                          {syncBusy === "profile" ? "Сохраняю…" : "Сохранить"}
                        </GhostButton>
                      </div>
                    }
                  />
                  <SettingRow
                    icon={Cloud}
                    title="Синхронизировать сейчас"
                    hint={
                      sync.pendingCount > 0
                        ? `Ждут отправки строк: ${sync.pendingCount}`
                        : "Все изменения уже перенесены"
                    }
                    control={
                      <PrimaryButton
                        onClick={() => void syncNow()}
                        disabled={syncBusy !== null || sync.busy}
                      >
                        {sync.busy
                          ? sync.progress > 0
                            ? `Отправляю ${sync.progress}…`
                            : "Синхронизирую…"
                          : "Синхронизировать сейчас"}
                      </PrimaryButton>
                    }
                  />
                </>
              )}

              {!sync.status.signedIn && (
                <div className="relative overflow-hidden p-4 border-t border-line/[0.06]">
                  <motion.div
                    initial={{ y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
                    className="relative ui-panel border border-line/[0.08] bg-inset/60 p-4 sm:p-5 space-y-3"
                  >
                    <div className="grid grid-cols-2 gap-1 p-1 ui-control bg-inset border border-line/[0.07]">
                      {(
                        [
                          ["signUp", "Создать аккаунт"],
                          ["signIn", "Войти"],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          onClick={() => {
                            setAuthMode(id);
                            setAuthError(null);
                          }}
                          className={`relative h-9 ui-control text-[12px] transition-colors ${
                            authMode === id ? "text-ink" : "text-muted hover:text-ink"
                          }`}
                        >
                          {/* Режим переезжает пилюлей, а не переключается рывком */}
                          {authMode === id && (
                            <motion.span
                              layoutId="settings-auth-mode-pill"
                              className="absolute inset-0 ui-control bg-surface shadow-panel"
                              transition={{ type: "spring", stiffness: 380, damping: 32 }}
                            />
                          )}
                          <span className="relative z-10">{label}</span>
                        </button>
                      ))}
                    </div>

                    {authMode === "signUp" && (
                      <div
                        className={`ui-tile border px-3.5 py-3 ${
                          closedByServer
                            ? "border-amber-400/45 bg-amber-400/[0.10]"
                            : "border-amber-400/25 bg-amber-400/[0.06]"
                        }`}
                      >
                        <p className="text-[12px] leading-relaxed text-amber-100/90">
                          {REGISTRATION_CLOSED_NOTICE}
                        </p>
                        <div className="flex items-center gap-2 mt-2.5">
                          <GhostButton
                            onClick={() => {
                              setAuthMode("signIn");
                              setAuthError(null);
                            }}
                          >
                            Войти
                          </GhostButton>
                          <span className="text-[11px] text-faint">Если аккаунт уже есть</span>
                        </div>
                      </div>
                    )}

                    {/* Регистрация: поля и кнопка. Замок лежит только над этим
                        блоком, поэтому вход остаётся полностью доступным.
                        Панели «Создать аккаунт» и «Войти» сменяются плавно.
                        Без AnimatePresence: при остановке кадров он не отдаёт
                        конец анимации выхода, и форма остаётся пустой. */}
                    <motion.div
                      key={authMode}
                      initial={{ y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                      className="relative"
                    >
                      <div
                        className={
                          registrationLocked ? "space-y-3 pointer-events-none select-none" : "space-y-3"
                        }
                      >
                        {authMode === "signUp" && (
                          <label className="block">
                            <span className="block text-[12px] text-muted mb-1">Юзернейм</span>
                            <input
                              value={syncUsername}
                              onChange={(event) => setSyncUsername(event.target.value)}
                              placeholder="cursed42"
                              spellCheck={false}
                              autoComplete="off"
                              className="input h-11 w-full"
                            />
                            <span className="block text-[11px] text-faint mt-1">
                              Латиница, цифры, «_» и «.», 3–20 символов. По нему тебя найдут в «Людях»
                            </span>
                          </label>
                        )}

                        <label className="block">
                          <span className="block text-[12px] text-muted mb-1">Почта</span>
                          <input
                            type="email"
                            value={syncEmail}
                            onChange={(event) => setSyncEmail(event.target.value)}
                            placeholder="you@example.com"
                            autoComplete="email"
                            spellCheck={false}
                            className="input h-11 w-full"
                          />
                        </label>

                        <label className="block">
                          <span className="block text-[12px] text-muted mb-1">Пароль</span>
                          <div className="flex items-center gap-2">
                            <input
                              type={showPassword ? "text" : "password"}
                              value={syncPassword}
                              onChange={(event) => setSyncPassword(event.target.value)}
                              placeholder={authMode === "signUp" ? "Придумай пароль" : "Пароль от аккаунта"}
                              autoComplete={authMode === "signUp" ? "new-password" : "current-password"}
                              className="input h-11 flex-1"
                            />
                            <GhostButton
                              onClick={() => setShowPassword((value) => !value)}
                              aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                              className="flex items-center gap-1.5"
                            >
                              {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                              {showPassword ? "Скрыть" : "Показать"}
                            </GhostButton>
                          </div>
                        </label>

                        {authMode === "signUp" && (
                          <label className="block">
                            <span className="block text-[12px] text-muted mb-1">
                              Код приглашения
                            </span>
                            <input
                              value={inviteCode}
                              onChange={(event) =>
                                setInviteCode(event.target.value.trim().toUpperCase())
                              }
                              placeholder="ABCD-EFGH-JKLM"
                              spellCheck={false}
                              autoComplete="off"
                              className="input h-11 w-full font-mono tracking-wide"
                            />
                            <span className="block text-[11px] text-faint mt-1">
                              Нужен, пока регистрация открыта только по приглашениям. Владельцу и
                              при свободной регистрации — не нужен
                            </span>
                          </label>
                        )}

                        {authError && !registrationLocked && (
                          <motion.p
                            initial={{ y: -2 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                            className="text-[12px] text-red-400"
                          >
                            {authError}
                          </motion.p>
                        )}

                        {awaitingEmail && (
                          <div className="ui-tile border border-line/[0.10] bg-inset px-3.5 py-3 space-y-2">
                            <p className="text-[12px] text-muted leading-relaxed">
                              Аккаунт создан. Осталось подтвердить почту: открой письмо от Supabase и перейди
                              по ссылке, а потом нажми кнопку ниже — вход выполнится с теми же почтой и паролем.
                            </p>
                            <PrimaryButton
                              onClick={() => void confirmEmailSync()}
                              disabled={syncBusy !== null || !signInReady}
                              className="press h-11 ui-control"
                            >
                              {syncBusy === "confirm" ? "Вхожу…" : "Я подтвердил, войти"}
                            </PrimaryButton>
                          </div>
                        )}

                        <div className="flex items-center gap-2">
                          {authMode === "signUp" ? (
                            <PrimaryButton
                              onClick={() => void signUpSync()}
                              disabled={syncBusy !== null || !signUpReady}
                              className="press h-11 ui-control"
                            >
                              {syncBusy === "signUp" ? "Создаю…" : "Создать аккаунт"}
                            </PrimaryButton>
                          ) : (
                            <PrimaryButton
                              onClick={() => void signInSync()}
                              disabled={syncBusy !== null || !signInReady}
                              className="press h-11 ui-control"
                            >
                              {syncBusy === "signIn" ? "Вхожу…" : "Войти"}
                            </PrimaryButton>
                          )}
                          <span className="text-[12px] text-faint">
                            {authMode === "signUp"
                              ? "После регистрации вход выполнится сразу"
                              : "Аккаунт не нужен, чтобы слушать музыку"}
                          </span>
                        </div>
                      </div>

                      {/* Слой не перехватывает клики: под ним уже ничего не нажать —
                          поля выключены pointer-events-none. */}
                      {registrationLocked && (
                        <div className="absolute inset-0 rounded-[var(--radius-panel)] bg-app/80 pointer-events-none flex flex-col items-center justify-center gap-1.5 px-6 text-center">
                          <Lock size={22} className="text-muted" />
                          <p className="text-[13px] font-medium">Регистрация — по приглашению</p>
                          <p className="text-[12px] text-muted leading-relaxed max-w-[420px]">
                            Проект в бете. Если у тебя есть код приглашения — нажми «У меня есть доступ»
                            и введи его в форме.
                          </p>
                        </div>
                      )}
                    </motion.div>

                    {registrationLocked && authError && (
                      <p className="text-[12px] text-red-400">{authError}</p>
                    )}

                    {registrationLocked && (
                      <button
                        onClick={() => {
                          sounds.open();
                          setRegistrationUnlocked(true);
                        }}
                        className="text-[12px] text-muted hover:text-ink transition-colors"
                      >
                        У меня есть доступ
                      </button>
                    )}
                  </motion.div>
                </div>
              )}

              <SettingNote>
                {sync.status.signedIn
                  ? "Выход ничего не удаляет: данные остаются здесь, просто прекращается перенос на другие устройства."
                  : "Аккаунт переносит лайки, историю и настройки между устройствами. Без него приложение работает полностью."}
              </SettingNote>
            </SettingPanel>

            {/* Владелец: вход в админ-панель. Кнопка есть только у него, а
                данные всё равно защищены сервером (admin_* проверяют is_owner). */}
            {isDeveloper && onOpenAdmin && (
              <SettingPanel title="Владелец">
                <SettingRow
                  icon={ShieldCheck}
                  title="Админ-панель"
                  hint="Люди, привязанные устройства, коды приглашений и журнал регистраций"
                  control={<GhostButton onClick={onOpenAdmin}>Открыть</GhostButton>}
                />
              </SettingPanel>
            )}

            {/* Приглашения: панель появляется только у владельца — право
                проверяет сервер, интерфейс лишь прячет раздел при отказе.
                Если сервер ещё не знает про приглашения (миграция не
                применена), показываем это словами, а не сырым ответом API. */}
            {sync.status.signedIn && (invitesAllowed || invitesUnsupported) && (
              <SettingPanel title="Приглашения">
                <div className="px-4 py-4 space-y-4">
                  {invitesUnsupported ? (
                    <div className="space-y-2">
                      <p className="text-[13px] text-ink">Сервер ещё не умеет приглашения</p>
                      <p className="text-[12px] text-muted leading-relaxed">
                        Код не создать, пока в проекте Supabase не применены миграции
                        <span className="text-ink"> 20261023_invites.sql</span> и
                        <span className="text-ink"> 20261028_owner_admin.sql</span> (папка
                        <span className="text-ink"> supabase/migrations</span>, Dashboard → SQL
                        Editor). После них нажми «Проверить снова» — перезапускать приложение
                        не нужно.
                      </p>
                      <GhostButton onClick={() => void refreshInvites()}>
                        Проверить снова
                      </GhostButton>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-[12px] text-muted leading-relaxed">
                        Код открывает регистрацию одному человеку (или нескольким, если так
                        указать). Отправь его другу вместе с файлом приложения — кнопка
                        «Поделиться» копирует готовое сообщение.
                      </p>
                      <label className="block">
                        <span className="block text-[12px] text-muted mb-1">Заметка (кому)</span>
                        <input
                          value={inviteNote}
                          onChange={(event) => setInviteNote(event.target.value)}
                          placeholder="например: другу на работу"
                          spellCheck={false}
                          className="input h-11 w-full"
                        />
                      </label>
                      <div className="flex items-end gap-3">
                        <label className="block w-28">
                          <span className="block text-[12px] text-muted mb-1">Срок, дней</span>
                          <input
                            type="number"
                            min={1}
                            max={365}
                            value={inviteDays}
                            onChange={(event) =>
                              setInviteDays(Math.max(1, Math.min(365, Number(event.target.value) || 1)))
                            }
                            className="input h-11 w-full"
                          />
                        </label>
                        <label className="block w-36">
                          <span className="block text-[12px] text-muted mb-1">Использований</span>
                          <input
                            type="number"
                            min={1}
                            max={1000}
                            value={inviteMaxUses}
                            onChange={(event) =>
                              setInviteMaxUses(
                                Math.max(1, Math.min(1000, Number(event.target.value) || 1))
                              )
                            }
                            className="input h-11 w-full"
                          />
                        </label>
                        <PrimaryButton
                          onClick={() => void createInvite()}
                          disabled={invitesBusy}
                          className="press h-11 ui-control"
                        >
                          <Ticket size={14} className="shrink-0" />
                          {invitesBusy ? "Создаю…" : "Создать приглашение"}
                        </PrimaryButton>
                      </div>
                    </div>
                  )}

                  {inviteError && !invitesUnsupported && (
                    <p className="text-[12px] text-red-400">{inviteError}</p>
                  )}

                  {!invitesUnsupported && (
                    <div className="space-y-2">
                      {(invites ?? []).length === 0 && (
                        <p className="text-[12px] text-faint">Приглашений пока нет</p>
                      )}
                      {(invites ?? []).map((invite) => (
                        <div
                          key={invite.code}
                          className="ui-tile border border-line/[0.10] bg-inset px-3.5 py-3 flex items-center gap-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[13px] tracking-wide truncate">
                                {invite.code}
                              </span>
                              <span
                                className={`text-[11px] px-1.5 py-0.5 rounded-full shrink-0 ${
                                  invite.status === "active"
                                    ? "bg-emerald-400/15 text-emerald-300"
                                    : "bg-ink/[0.06] text-faint"
                                }`}
                              >
                                {invite.status === "active"
                                  ? "активен"
                                  : invite.status === "used"
                                    ? "использован"
                                    : invite.status === "expired"
                                      ? "истёк"
                                      : "отозван"}
                              </span>
                            </div>
                            <p className="text-[11px] text-faint mt-0.5 truncate">
                              {invite.usedCount}/{invite.maxUses} использований · до{" "}
                              {new Date(invite.expiresAt).toLocaleDateString("ru-RU")}
                              {invite.note ? ` · ${invite.note}` : ""}
                            </p>
                          </div>
                          <GhostButton
                            onClick={() => void copyInviteCode(invite.code)}
                            aria-label="Скопировать код"
                            title="Скопировать только код"
                            className="flex items-center gap-1.5 shrink-0"
                          >
                            <Copy size={13} />
                          </GhostButton>
                          {invite.status === "active" && (
                            <>
                              <GhostButton
                                onClick={() => void copyInviteMessage(invite)}
                                className="flex items-center gap-1.5 shrink-0"
                              >
                                Поделиться
                              </GhostButton>
                              <GhostButton
                                onClick={() => void revokeInvite(invite.code)}
                                disabled={invitesBusy}
                                className="shrink-0"
                              >
                                Отозвать
                              </GhostButton>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </SettingPanel>
            )}

            {/* Ручная настройка — только владельцу проекта: у обычного
                пользователя адрес и ключ уже вшиты в сборку. */}
            {isDeveloper && (
            <SettingPanel title="Дополнительно (для разработки)">
              <button
                onClick={() => setAdvancedOpen((value) => !value)}
                aria-expanded={advancedOpen}
                className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-ink/[0.03] transition-colors"
              >
                <ChevronRight
                  size={14}
                  className={`text-faint shrink-0 transition-transform ${advancedOpen ? "rotate-90" : ""}`}
                />
                <span className="text-[12px] text-muted">
                  {hasEmbeddedConfig()
                    ? "Адрес проекта и anon-ключ вшиты в сборку — менять не нужно"
                    : "Адрес проекта и anon-ключ придётся задать вручную"}
                </span>
              </button>
              {advancedOpen && (
                <div className="px-4 py-4 space-y-3 border-t border-line/[0.06]">
                  <label className="block">
                    <span className="block text-[12px] text-muted mb-1">Адрес проекта Supabase</span>
                    <input
                      value={syncUrl}
                      onChange={(event) => setSyncUrl(event.target.value)}
                      placeholder="https://xxxxxxxx.supabase.co"
                      spellCheck={false}
                      autoComplete="off"
                      className="input w-full"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[12px] text-muted mb-1">Anon key</span>
                    <input
                      value={syncKey}
                      onChange={(event) => setSyncKey(event.target.value)}
                      placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
                      spellCheck={false}
                      autoComplete="off"
                      className="input w-full text-[11px] font-mono"
                    />
                  </label>
                  <div className="flex items-center gap-3">
                    <PrimaryButton
                      onClick={() => void connectSync()}
                      disabled={syncBusy !== null || !syncCredentialsReady}
                    >
                      {syncBusy === "config" ? "Проверяю…" : "Сохранить и проверить"}
                    </PrimaryButton>
                    <span className="text-[12px] text-faint">
                      Только anon-ключ: ключ service_role в приложении не поддерживается
                    </span>
                  </div>
                  <p className="text-[12px] text-faint leading-relaxed">
                    Здесь лежит тот же публичный ключ, что и в сборке. Значения попадают только в файл
                    сессии рядом с профилями и в запросы к проекту — в журнал ошибок ключи не пишутся.
                  </p>
                </div>
              )}
            </SettingPanel>
            )}
          </>
        )}

        {/* ──────────────────────── Интерфейс ──────────────────────── */}
        {section === "appearance" && current === "look" && (
          <>
            <SettingPanel title="Тема" hint="Плитки показывают фон, поверхность и акцент пресета">
              <div className="p-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {Object.entries(PRESETS).map(([id, preset]) => {
                    // Превью считаем той же функцией, что и применённую тему:
                    // иначе карточка в настройках и реальный интерфейс расходятся
                    const preview = deriveTheme(preset.colors, preset.mode);
                    const selected = presetId === id;
                    return (
                      <button
                        key={id}
                        onClick={() => choosePreset(id, preset.label)}
                        aria-pressed={selected}
                        className={`ui-tile border p-2 text-left transition-colors ${
                          selected
                            ? "border-accentText bg-accent/[0.08]"
                            : "border-line/[0.09] hover:border-line/20 hover:bg-ink/[0.03]"
                        }`}
                      >
                        <span
                          className="block h-12 ui-control border border-line/10 relative overflow-hidden"
                          style={{ background: `rgb(${preview.app})` }}
                        >
                          <span
                            className="absolute inset-x-0 bottom-0 h-5"
                            style={{ background: `rgb(${preview.surface})` }}
                          />
                          <span
                            className="absolute left-2 top-2 w-4 h-4 rounded-full"
                            style={{ background: `rgb(${preview.accent})` }}
                          />
                          <span
                            className="absolute right-2 bottom-2 h-1.5 w-10 rounded-full"
                            style={{ background: `rgb(${preview.inset})` }}
                          />
                        </span>
                        <span className="mt-2 flex items-center gap-1.5 min-w-0">
                          <span className="text-[12px] truncate">{preset.label}</span>
                          {selected && <Check size={12} className="text-accentText ml-auto shrink-0" />}
                        </span>
                        <span className="flex items-center gap-1 mt-1.5">
                          <span
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ background: `rgb(${preview.accent})` }}
                          />
                          <span
                            className="w-2.5 h-2.5 rounded-full border border-line/10"
                            style={{ background: `rgb(${preview.surface2})` }}
                          />
                          <span
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ background: `rgb(${preview.ink})` }}
                          />
                          <span className="text-[10px] text-faint ml-1">
                            {preset.mode === "light" ? "светлая" : "тёмная"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <SettingRow
                icon={Palette}
                title="Акцент из обложки трека"
                hint="Доминирующий цвет текущей обложки становится акцентом: кнопки, полосы, выделения. Если обложки нет или цвет не читается — остаётся акцент темы"
                control={
                  <Toggle on={accentFromCover} onChange={toggleAccentFromCover} label="Акцент из обложки трека" />
                }
              />
              <SettingRow
                icon={Palette}
                title="Акцентный цвет"
                hint={
                  accentFromCover
                    ? "Сейчас акцент берётся из обложки. Свой цвет отключит этот режим"
                    : "Точная настройка каналов — на под-вкладке «Кастом»"
                }
                control={
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-muted tnum uppercase">{hex}</span>
                    <input
                      type="color"
                      value={hex}
                      onChange={(event) => {
                        const value = event.target.value;
                        setAccentRgb(
                          parseInt(value.slice(1, 3), 16),
                          parseInt(value.slice(3, 5), 16),
                          parseInt(value.slice(5, 7), 16)
                        );
                      }}
                      onPointerDown={accentStart}
                      onPointerUp={accentCommit}
                      onKeyDown={accentStart}
                      onKeyUp={accentCommit}
                      onBlur={accentCommit}
                      aria-label="Акцентный цвет"
                      className="w-9 h-9 ui-control bg-transparent border border-line/[0.12] cursor-pointer"
                    />
                  </div>
                }
              />
            </SettingPanel>

            <SettingPanel title="Форма" hint="Применяется сразу ко всем панелям, плиткам и полям">
              <SettingRow
                icon={Ruler}
                title="Скругление углов"
                hint={CORNER_OPTIONS.find((item) => item.id === settings.cornerRadius)?.hint}
                stacked
              >
                <OptionCards
                  options={CORNER_OPTIONS.map((item) => ({
                    id: item.id,
                    label: item.label,
                    hint: item.hint,
                    icon: CORNER_ICONS[item.id],
                  }))}
                  value={settings.cornerRadius}
                  onChange={(id) => {
                    const option = CORNER_OPTIONS.find((item) => item.id === id);
                    if (option) chooseCorner(option.id, option.label);
                  }}
                  columns={4}
                  ariaLabel="Скругление углов"
                />
              </SettingRow>
              <SettingRow
                icon={Monitor}
                title="Масштаб интерфейса"
                hint="Двигает всю сетку: отступы, высоты строк и подписи. 125% проверен на 1360×820"
                stacked
              >
                <OptionCards
                  options={SCALE_OPTIONS.map((item) => ({
                    id: String(item.id),
                    label: item.label,
                    hint: item.hint,
                    icon: SCALE_ICONS[item.id],
                  }))}
                  value={String(settings.uiScale)}
                  onChange={(id) => {
                    const option = SCALE_OPTIONS.find((item) => String(item.id) === id);
                    if (option) chooseScale(option.id, option.label);
                  }}
                  columns={4}
                  ariaLabel="Масштаб интерфейса"
                />
              </SettingRow>
              <SettingRow
                icon={Type}
                title="Размер шрифта интерфейса"
                hint="Меняет только подписи и заголовки, сетка остаётся на месте. 14 px — обычный"
                stacked
              >
                <OptionCards
                  options={FONT_OPTIONS.map((item) => ({
                    id: String(item.id),
                    label: item.label,
                    hint: item.hint,
                    icon: ALargeSmall,
                  }))}
                  value={String(settings.fontSize)}
                  onChange={(id) => {
                    const option = FONT_OPTIONS.find((item) => String(item.id) === id);
                    if (option) chooseFontSize(option.id, option.label);
                  }}
                  columns={4}
                  ariaLabel="Размер шрифта интерфейса"
                />
              </SettingRow>
            </SettingPanel>

            {/* Обои: фото или гифка на всё приложение и полноэкранный плеер.
                Раньше кнопка жила в шапке плеера — здесь её и искали. */}
            <WallpaperSetting />

            <SettingPanel title="Поверх окон" hint="Островок с треком поверх других программ">
              <SettingRow
                icon={MonitorPlay}
                title="Показывать островок"
                hint="Полоска с текущим треком поверх других окон"
                control={<Toggle on={settings.islandEnabled} onChange={toggleIsland} label="Показывать островок" />}
              />
              <SettingRow
                icon={MonitorPlay}
                title="Всегда, не только в игре"
                hint="Иначе островок появляется, когда запущена Dota 2"
                control={
                  <Toggle
                    on={settings.islandAlways}
                    onChange={toggleIslandAlways}
                    label="Показывать островок всегда"
                  />
                }
              />
              <SettingRow
                icon={MonitorPlay}
                title="Поверх всех окон"
                hint="Выключи, если островок перекрывает игру"
                control={
                  <Toggle
                    on={settings.islandAlwaysOnTop}
                    onChange={toggleIslandOnTop}
                    label="Островок поверх всех окон"
                  />
                }
              />
            </SettingPanel>
          </>
        )}

        {section === "appearance" && current === "tabs" && (
          <>
            <SettingPanel title="Панель навигации" hint="Где живут разделы приложения">
              <SettingRow
                icon={settings.navLayout === "top" ? PanelTop : PanelLeft}
                title="Положение панели"
                hint={
                  settings.navLayout === "top"
                    ? "Панель во всю ширину сверху, контент занимает экран целиком"
                    : "Привычное боковое меню слева"
                }
                stacked
              >
                <OptionCards
                  options={[
                    {
                      id: "top",
                      label: "Сверху",
                      hint: "Панель во всю ширину",
                      icon: PanelTop,
                    },
                    {
                      id: "left",
                      label: "Слева",
                      hint: "Вертикальное меню",
                      icon: PanelLeft,
                    },
                  ]}
                  value={settings.navLayout === "top" ? "top" : "left"}
                  onChange={(id) => chooseNavLayout(id === "top" ? "top" : "side", id === "top" ? "Сверху" : "Слева")}
                  columns={2}
                  ariaLabel="Положение панели навигации"
                />
              </SettingRow>
              <SettingNote>
                Панель сама подстраивается под ширину окна: на узком окне подписи прячутся, остаются
                иконки, а разделы по-прежнему доступны. Переключение применяется сразу, откат — в
                уведомлении.
              </SettingNote>
            </SettingPanel>

            <SettingPanel title="Плотность" hint="Сколько строк помещается на экране">
              <SettingRow
                icon={Ruler}
                title="Плотность интерфейса"
                hint={DENSITIES.find((item) => item.id === density)?.hint}
                stacked
              >
                <SettingCards
                  options={DENSITIES.map((item) => ({
                    id: item.id,
                    label: item.label,
                    hint: item.hint,
                  }))}
                  value={density}
                  onChange={(id) => {
                    const option = DENSITIES.find((item) => item.id === id);
                    if (option) chooseDensity(option.id, option.label);
                  }}
                  columns={3}
                  ariaLabel="Плотность интерфейса"
                />
              </SettingRow>
            </SettingPanel>
          </>
        )}

        {/* Свой акцент и иконка — по-прежнему на вкладке «Вид», ниже формы */}
        {section === "appearance" && current === "look" && (
          <>
            <SettingPanel
              title="Свой акцент"
              hint="Точная настройка каналов. Свой цвет выключает режим «акцент из обложки»"
            >
              <div className="p-4 space-y-4">
                <div className="flex items-center gap-3">
                  <span
                    className="w-12 h-12 ui-tile border border-line/[0.12] shrink-0"
                    style={{ background: `rgb(${colors.accent})` }}
                  />
                  <div className="min-w-0">
                    <p className="text-[13px] text-ink tnum">RGB {r} · {g} · {b}</p>
                    <p className="text-[12px] text-muted tnum uppercase">{hex}</p>
                    {accentFromCover && (
                      <p className="text-[11px] text-faint mt-0.5">
                        Режим «акцент из обложки» включён: изменение цвета его выключит
                      </p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  {(
                    [
                      ["R", r, "#ff5c5c", (v: number) => setAccentRgb(v, g, b)],
                      ["G", g, "#5cff7a", (v: number) => setAccentRgb(r, v, b)],
                      ["B", b, "#5c8aff", (v: number) => setAccentRgb(r, g, v)],
                    ] as const
                  ).map(([label, value, color, onChange]) => (
                    <label key={label} className="flex items-center gap-3">
                      <span className="w-4 text-[12px] text-muted shrink-0">{label}</span>
                      <input
                        type="range"
                        min={0}
                        max={255}
                        value={value}
                        onChange={(event) => onChange(Number(event.target.value))}
                        onPointerDown={accentStart}
                        onPointerUp={accentCommit}
                        onKeyDown={accentStart}
                        onKeyUp={accentCommit}
                        style={{ accentColor: color }}
                        aria-label={`Канал ${label}`}
                        className="flex-1 min-w-0 cursor-pointer"
                      />
                      <span className="w-9 text-[12px] text-muted text-right shrink-0 tnum">{value}</span>
                    </label>
                  ))}
                </div>
              </div>
            </SettingPanel>

            <SettingPanel title="Иконка приложения" hint="Появится в сайдбаре, на заставке и в панели задач">
              <div className="p-4 flex items-start gap-3">
                <img
                  src={appIcon}
                  alt=""
                  className="w-12 h-12 ui-tile border border-line/[0.10] object-cover shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <GhostButton onClick={() => void chooseAppIcon()}>Выбрать иконку</GhostButton>
                    {settings.customAppIcon && (
                      <button
                        onClick={() => void resetAppIcon()}
                        className="text-[12px] text-muted hover:text-ink transition-colors"
                      >
                        Вернуть встроенную
                      </button>
                    )}
                  </div>
                  <p className="text-[12px] text-faint mt-2 leading-relaxed">
                    PNG, JPEG, WebP или анимированный GIF. Свою иконку можно загрузить в Discord как
                    ассет — кнопка «Сохранить файлом» лежит в разделе «Сервисы → Discord».
                  </p>
                </div>
              </div>
            </SettingPanel>
          </>
        )}

        {/* ────────────────────────── Плеер ────────────────────────── */}
        {section === "player" && current === "sound" && (
          <>
            <SettingPanel title="Вывод звука" hint="Куда идут музыка и сигналы интерфейса">
              <SettingRow
                icon={Speaker}
                title="Устройство вывода"
                hint={
                  !outputSupported
                    ? "Этот движок не умеет выбирать устройство — играет системное умолчание"
                    : outputs.length === 0
                      ? "Система не показала список устройств — доступен только системный вывод"
                      : "Наушники, колонки или системное умолчание"
                }
                stacked
              >
                <OptionCards
                  options={outputOptions}
                  value={settings.audioOutputId}
                  onChange={(id) => void changeOutput(id)}
                  columns={2}
                  ariaLabel="Устройство вывода звука"
                />
              </SettingRow>
              <SettingRow
                icon={Volume2}
                title="Проверить звук"
                hint={
                  soundCheck ??
                  "Короткий сигнал 440 Гц: сразу слышно, работает ли вывод. Трек при проверке не трогаем"
                }
                control={
                  <GhostButton onClick={() => void checkSound()} disabled={soundCheckBusy}>
                    {soundCheckBusy ? "Сигнал…" : "Проверить"}
                  </GhostButton>
                }
              />
            </SettingPanel>

            <SettingPanel title="Звуки интерфейса" hint="Тихие короткие сигналы: включение, сохранение, откат">
              <SettingRow
                icon={Volume2}
                title="Сигналы интерфейса"
                hint="Короткий отклик на действия — не музыка"
                control={<Toggle on={settings.soundEnabled} onChange={toggleSound} label="Звуки интерфейса" />}
              />
              <SettingRow
                icon={Volume2}
                title="Громкость сигналов"
                hint={`${Math.round(settings.soundVolume * 100)}% от общей громкости системы`}
                control={
                  <div className="flex items-center gap-2 w-40">
                    <Volume2 size={14} className="text-faint shrink-0" />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.soundVolume}
                      disabled={!settings.soundEnabled}
                      onChange={(event) => settings.setSoundVolume(Number(event.target.value))}
                      onPointerDown={volumeStart}
                      onPointerUp={volumeCommit}
                      onKeyDown={volumeStart}
                      onKeyUp={volumeCommit}
                      aria-label="Громкость звуков интерфейса"
                      className="flex-1 min-w-0 accent-accent cursor-pointer disabled:opacity-40"
                    />
                  </div>
                }
              />
              <SettingRow
                icon={Music2}
                title="Набор сигналов"
                hint={SOUND_PACKS.find((pack) => pack.id === settings.soundPack)?.hint ?? ""}
                stacked
              >
                <SettingCards
                  options={SOUND_PACKS.map((pack) => ({ id: pack.id, label: pack.label, hint: pack.hint }))}
                  value={settings.soundPack}
                  onChange={(id) => {
                    if (id === settings.soundPack) return;
                    const previous = settings.soundPack;
                    const pack = SOUND_PACKS.find((item) => item.id === id);
                    settings.setSoundPack(id as typeof settings.soundPack);
                    sounds.save();
                    toast({
                      title: `Звуки: ${pack?.label ?? id}`,
                      action: { label: "Отменить", run: () => settings.setSoundPack(previous) },
                    });
                  }}
                  columns={3}
                  ariaLabel="Набор звуков интерфейса"
                />
              </SettingRow>
              <SettingNote>
                Качество потока здесь не настраивается: SoundCloud отдаёт один поток без выбора
                битрейта, а локальные файлы играют в своём исходном качестве. Если сервис когда-нибудь
                даст варианты, выбор появится в этом разделе.
              </SettingNote>
            </SettingPanel>
          </>
        )}

        {section === "player" && current === "transitions" && (
          <>
            <SettingPanel title="Переходы между треками" hint="Что происходит на стыке и в конце трека">
              <SettingRow
                icon={Undo2}
                title="Пропускать тишину в конце трека"
                hint="Работает для треков, сохранённых на устройство: тишина в конце пропускается. Для потоковых треков не применяется — определить её надёжно нельзя"
                control={
                  <Toggle
                    on={settings.skipTailSilence}
                    onChange={() => {
                      const next = !settings.skipTailSilence;
                      settings.setSkipTailSilence(next);
                      if (next) sounds.save();
                      else sounds.off();
                    }}
                    label="Пропускать тишину в конце трека"
                  />
                }
              />
              <SettingRow
                icon={Heart}
                title="Спрашивать при скачивании"
                hint={
                  settings.downloadChoiceRemembered
                    ? "Выбор запомнен: окно «Что сохранить?» не показывается — сразу скачивается запомненный вариант"
                    : "Окно «Что сохранить?» показывается при каждом скачивании с снятой галочкой «Запомнить выбор»"
                }
                control={
                  <Toggle
                    on={!settings.downloadChoiceRemembered}
                    onChange={() => {
                      // Тумблер «спрашивать» — обратная сторона «запомнить выбор».
                      // Сам выбор (трек / текст / вместе) не трогаем: он запомнен
                      // отдельно и остаётся прежним, когда спрашивание вернётся.
                      const askAgain = settings.downloadChoiceRemembered;
                      settings.setDownloadChoice(settings.downloadChoice, !askAgain);
                      sounds.save();
                      toast({
                        title: askAgain
                          ? "Спрашивать при скачивании"
                          : "Выбор при скачивании запомнен",
                        description: askAgain
                          ? "Окно «Что сохранить?» вернётся при каждом скачивании"
                          : "Кнопка скачивания сразу применяет запомненный вариант",
                      });
                    }}
                    label="Спрашивать при скачивании"
                  />
                }
              />
              <SettingRow
                icon={Link2}
                title="Запасной путь: внешний сервис"
                hint="Запасной путь: внешний сервис soundloadmate. Включай, если наш способ не справился. Работает без гарантий."
                control={
                  <Toggle
                    on={settings.externalDownloaderEnabled}
                    onChange={() => {
                      const next = !settings.externalDownloaderEnabled;
                      settings.setExternalDownloaderEnabled(next);
                      if (next) sounds.save();
                      else sounds.off();
                      toast({
                        title: next ? "Внешний сервис включён" : "Внешний сервис выключен",
                        description: next
                          ? "Когда наше сохранение не справится, в ошибке появится кнопка «Попробовать через внешний сервис»"
                          : "Офлайн сохраняет только наш способ — сторонний сервис не тронем",
                      });
                    }}
                    label="Запасной путь через внешний сервис"
                  />
                }
              />
            </SettingPanel>
          </>
        )}

        {/* ───────────────────────── Сервисы ───────────────────────── */}
        {section === "services" && current === "soundcloud" && (
          <>
            <SettingPanel title="SoundCloud" hint="Поиск и воспроизведение работают через публичный API">
              <SettingRow
                icon={Plug}
                title="Client ID"
                hint={
                  settings.soundcloudClientId
                    ? "Заполнено — поиск и воспроизведение работают"
                    : "Можно не заполнять: приложение найдёт публичный автоматически"
                }
                control={
                  <input
                    value={settings.soundcloudClientId}
                    onChange={(event) => settings.setSoundcloudClientId(event.target.value)}
                    placeholder="32 символа"
                    className="input w-56"
                  />
                }
              />
              <SettingRow
                icon={Search}
                title="Найти автоматически"
                hint="Возьмём публичный client_id веб-клиента SoundCloud"
                control={
                  <GhostButton
                    onClick={() => {
                      sounds.open();
                      void discoverSoundcloudClientId()
                        .then((id) => {
                          settings.setSoundcloudClientId(id);
                          sounds.save();
                          toast({ title: "SoundCloud готов", description: "client_id найден автоматически" });
                          void useServiceStore.getState().refresh();
                        })
                        .catch((e) =>
                          toast({
                            title: "Не удалось найти client_id",
                            description: e instanceof Error ? e.message : String(e),
                            tone: "danger",
                          })
                        );
                    }}
                  >
                    Найти
                  </GhostButton>
                }
              />
              <SettingNote>
                Свой client_id можно получить в кабинете SoundCloud (soundcloud.com/you/apps), но обычно
                он не нужен — приложение подставит публичный само. Выбор качества потока сервис не
                предоставляет: играет то, что отдаёт API.
              </SettingNote>
            </SettingPanel>

            <SettingPanel title="Почему Яндекс и VK не поддерживаются">
              <SettingRow
                icon={Music2}
                title="Яндекс Музыка"
                hint={serviceInfo("yandex").note ?? "Сервис не поддерживается"}
                control={
                  <GhostButton
                    onClick={() => {
                      sounds.open();
                      setWhyOpen("yandex");
                    }}
                  >
                    Почему не поддерживается?
                  </GhostButton>
                }
              />
              <SettingRow
                icon={Music2}
                title="VK Музыка"
                hint={serviceInfo("vk").note ?? "Сервис не поддерживается"}
                control={<span className="text-[12px] text-faint">API закрыт с 2021</span>}
              />
              <Modal
                open={whyOpen !== null}
                onClose={() => setWhyOpen(null)}
                title={
                  whyOpen === "vk"
                    ? "Почему VK Музыка не поддерживается"
                    : "Почему Яндекс Музыка не поддерживается"
                }
                description={
                  whyOpen === "vk"
                    ? "Коротко: VK закрыл музыку для сторонних приложений, поэтому подключить сервис нельзя."
                    : "Коротко: сервис закрыт для сторонних приложений, а полное аудио отдаёт только своим клиентам."
                }
                footer={<PrimaryButton onClick={() => setWhyOpen(null)}>Понятно</PrimaryButton>}
              >
                {whyOpen === "vk" ? (
                  <ul className="text-[13px] text-muted space-y-2.5">
                    <li className="flex gap-2">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-accentText shrink-0" />
                      <span>
                        <span className="text-ink/85">API закрыт с 2021 года.</span> VK не отдаёт музыку
                        через API: доступ к аудио для сторонних приложений закрыт, поэтому подключить
                        сервис нельзя.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-accentText shrink-0" />
                      <span>
                        <span className="text-ink/85">Полные треки — только в приложениях VK.</span>
                        Стороннему плееру сервис полное аудио не отдаёт.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-accentText shrink-0" />
                      <span>
                        <span className="text-ink/85">Что вместо.</span> Полностью работают SoundCloud и
                        локальные файлы: их можно слушать целиком, без подписок.
                      </span>
                    </li>
                  </ul>
                ) : (
                  <ul className="text-[13px] text-muted space-y-2.5">
                    <li className="flex gap-2">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-accentText shrink-0" />
                      <span>
                        <span className="text-ink/85">Публичного API нет.</span> У Spotify и SoundCloud он
                        официальный, у Яндекса — только внутренний, который меняют без предупреждения.
                        Сторонние клиенты ломаются из-за капчи и «safe-mode».
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-accentText shrink-0" />
                      <span>
                        <span className="text-ink/85">Полное аудио — только своим.</span> Проверили напрямую:
                        и без Плюса, и с Плюсом через стороннее приложение Яндекс отдаёт 30-секундный фрагмент.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-accentText shrink-0" />
                      <span>
                        <span className="text-ink/85">Про монополию.</span> Есть регуляторные вопросы: ФАС
                        разбирала жалобы на дискриминационные условия, а в исследованиях по конкуренции
                        разбирается самопредпочтение на своих площадках.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-accentText shrink-0" />
                      <span>
                        <span className="text-ink/85">Что вместо.</span> Поддерживаем Spotify и SoundCloud,
                        локальные файлы играем целиком, а вход в Яндекс убрали из настроек — он всё равно
                        отдавал только 30 секунд.
                      </span>
                    </li>
                  </ul>
                )}
              </Modal>
            </SettingPanel>
          </>
        )}

        {section === "services" && current === "discord" && (
          <SettingPanel title="Discord" hint="Rich Presence: что видно в профиле Discord">
            <SettingRow
              icon={Plug}
              title="Показывать, что я слушаю"
              hint="Активность обновляется сама при смене трека"
              control={
                <Toggle on={settings.discordEnabled} onChange={toggleDiscord} label="Discord Rich Presence" />
              }
            />
            <SettingRow
              icon={AtSign}
              title="Application ID"
              hint="Идентификатор приложения Discord"
              control={
                <input
                  value={settings.discordClientId}
                  onChange={(event) => settings.setDiscordClientId(event.target.value)}
                  placeholder="например 1234567890123456789"
                  className="input w-56"
                />
              }
            />
            <SettingRow
              icon={ImageIcon}
              title="Иконка приложения"
              hint="Её показывает Discord, когда ничего не играет"
              control={
                <div className="flex items-center gap-2">
                  <img
                    src={appIcon}
                    alt=""
                    className="w-9 h-9 ui-control border border-line/[0.10] object-cover"
                  />
                  <GhostButton onClick={() => void saveIcon()} disabled={iconBusy}>
                    {iconBusy ? "Сохраняю…" : "Сохранить файлом"}
                  </GhostButton>
                </div>
              }
            />
            <SettingRow
              icon={Bell}
              title="Проверить подключение"
              hint="Отправит тестовую активность в запущенный Discord"
              control={
                <GhostButton onClick={() => void testDiscord()} disabled={discordBusy}>
                  {discordBusy ? "Отправляю…" : "Проверить"}
                </GhostButton>
              }
            />
            <SettingNote>
              Discord не показывает активность без Application ID — это правило платформы. Чтобы там
              были название и иконка приложения, а не «Неизвестное приложение»: открой
              discord.com/developers/applications и создай приложение, скопируй Application ID в поле
              выше, в разделе Rich Presence → Art Assets загрузи картинку (её можно сохранить кнопкой) и
              назови её ровно <span className="text-ink/70">logo</span>, затем включи тумблер.
            </SettingNote>
          </SettingPanel>
        )}

        {section === "services" && current === "other" && (
          <>
            <SettingPanel title="Подключённые сервисы">
              {/* Справка о состоянии вместо кнопок: подключать вручную нечего —
                  Яндекс и Spotify не отдают полное аудио, у VK API закрыт с 2021 */}
              <SettingRow
                icon={Cloud}
                title="SoundCloud"
                hint={
                  settings.soundcloudClientId
                    ? "client_id заполнен — поиск и воспроизведение работают"
                    : "client_id не заполнен — приложение подставит публичный автоматически"
                }
                control={
                  <span
                    className={`text-[12px] ${settings.soundcloudClientId ? "text-emerald-400/90" : "text-faint"}`}
                  >
                    {settings.soundcloudClientId ? "Подключено" : "Не подключено"}
                  </span>
                }
              />
              <SettingRow
                icon={Plug}
                title="Discord"
                hint={
                  settings.discordEnabled
                    ? "Тумблер включён: активность обновляется при смене трека"
                    : "Тумблер выключен — Discord не показывает, что играет"
                }
                control={
                  <span className={`text-[12px] ${settings.discordEnabled ? "text-emerald-400/90" : "text-faint"}`}>
                    {settings.discordEnabled ? "Подключено" : "Не подключено"}
                  </span>
                }
              />
              <SettingRow
                icon={Music2}
                title="VK Музыка"
                hint={serviceInfo("vk").note ?? "Сервис не поддерживается"}
                control={
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[12px] text-faint">Не поддерживается</span>
                    <GhostButton
                      onClick={() => {
                        sounds.open();
                        setWhyOpen("vk");
                      }}
                    >
                      Почему?
                    </GhostButton>
                  </div>
                }
              />
              <SettingNote>
                Подключения вручную здесь нет: Яндекс Музыка и Spotify не отдают полное аудио сторонним
                приложениям, а VK закрыл музыку для них в 2021 году. Полностью работают SoundCloud и
                локальные файлы.
              </SettingNote>
            </SettingPanel>

            <SettingPanel title="Почему Spotify и Яндекс не подключить полностью">
              <div className="px-4 py-4 text-[13px] text-muted leading-relaxed space-y-3">
                <p>
                  <span className="text-ink/85">Прости, что так вышло.</span> Обещал подключить сервисы
                  целиком — на практике у обоих есть техническая стена, которую нельзя обойти из
                  стороннего приложения. Ниже честно, что именно мешает.
                </p>
                <p>
                  <span className="text-ink/85">Spotify.</span> Воспроизведение возможно только через их
                  Web Playback SDK, а он требует активной подписки Premium на аккаунте. Без неё Spotify
                  отдаёт лишь каталог: названия, исполнителей, обложки. Поиск у нас работает, включить
                  трек — нет.
                </p>
                <p>
                  <span className="text-ink/85">Яндекс Музыка.</span> Публичного API нет вообще, а полное
                  аудио сервис отдаёт только своим приложениям. Мы проверили это дважды — обычным токеном
                  и полноценным входом по OAuth: в обоих случаях приходит 30-секундный фрагмент. Даже с
                  активным Плюсом стороннему клиенту полный трек не выдаётся.
                </p>
                <p>
                  <span className="text-ink/85">Что будем делать.</span> Мы продолжаем над этим работать:
                  следим за изменениями их API, и если появится легальный способ — сразу подключим. Пока
                  полностью работают <span className="text-ink/85">SoundCloud</span> и{" "}
                  <span className="text-ink/85">локальные файлы</span>: их можно слушать целиком, без
                  подписок.
                </p>
              </div>
            </SettingPanel>
          </>
        )}

        {/* ───────────────────────── Система ───────────────────────── */}
        {section === "system" && current === "general" && (
          <>
            <SettingPanel title="Окно" hint="Что делает крестик и как приложение живёт в системе">
              <SettingRow
                icon={Monitor}
                title="Что делает крестик"
                hint="При сворачивании в трей музыка продолжает играть, а окно возвращается кликом по иконке"
                stacked
              >
                <SettingCards
                  options={[
                    { id: "ask", label: "Спрашивать", hint: "Выбор при каждом закрытии" },
                    { id: "tray", label: "В трей", hint: "Свернуть, не закрывать" },
                    { id: "quit", label: "Закрывать", hint: "Выходить полностью" },
                  ]}
                  value={settings.closeBehavior}
                  onChange={(id) => {
                    if (id === settings.closeBehavior) return;
                    const label =
                      id === "ask" ? "Спрашивать" : id === "tray" ? "В трей" : "Закрывать";
                    chooseClose(id as "ask" | "tray" | "quit", label);
                  }}
                  columns={3}
                  ariaLabel="Что делает крестик"
                />
              </SettingRow>
              <SettingRow
                icon={Monitor}
                title="Медиа-клавиши"
                hint="Play/Pause, следующий и предыдущий трек с клавиатуры — пока окно приложения в фокусе"
                control={<span className="text-[12px] text-emerald-400/90">включены</span>}
              />
              <SettingRow
                icon={Monitor}
                title="Запускать вместе с Windows"
                hint={settings.autostart ? "Приложение стартует при входе в систему" : "Выключено"}
                control={
                  <Toggle on={settings.autostart} onChange={() => void toggleAutostart()} label="Автозапуск" />
                }
              />
            </SettingPanel>

            <SettingPanel title="Уведомления" hint="Что приложение сообщает само">
              <SettingRow
                icon={Bell}
                title="Уведомление при смене трека"
                hint="Всплывающее уведомление Windows с названием и исполнителем"
                control={
                  <Toggle
                    on={settings.notifyOnTrackChange}
                    onChange={toggleNotifications}
                    label="Уведомления о треках"
                  />
                }
              />
              <SettingRow
                icon={Bell}
                title="Всплывающие уведомления в приложении"
                hint="Показывать сверху, что изменилось, с кнопкой «Отменить»"
                control={<Toggle on={settings.toastsEnabled} onChange={toggleToasts} label="Уведомления" />}
              />
              <SettingRow
                icon={Bell}
                title="Проверить уведомление"
                hint="Показать пример с колоколом и откатом"
                control={
                  <GhostButton
                    onClick={() => {
                      sounds.save();
                      // Проверка должна показывать пример всегда: иначе при
                      // выключенных уведомлениях кнопка выглядит сломанной
                      toast(
                        {
                          title: "Пример уведомления",
                          description: "Так выглядит сообщение о действии",
                          action: { label: "Отменить", run: () => undefined },
                        },
                        { force: true }
                      );
                    }}
                    className="flex items-center gap-1.5"
                  >
                    <Bell size={13} /> Показать
                  </GhostButton>
                }
              />
            </SettingPanel>
          </>
        )}

        {/* ── Сеть: маршрут, прокси и проверка ── */}
        {section === "system" && current === "network" && (
          <>
            <SettingPanel title="Маршрут" hint="Как приложение ходит в сеть">
              <SettingRow
                icon={RouteIcon}
                title="Маршрут"
                hint="«Авто» гонит два пути одновременно: прямой и через прокси — и берёт тот, что ответил первым. Проигравший отменяется"
                stacked
              >
                <OptionCards
                  options={NETWORK_ROUTE_OPTIONS.map((option) => ({
                    id: option.id,
                    label: option.label,
                    hint: option.hint,
                  }))}
                  value={settings.networkRoute}
                  onChange={(id) => void chooseNetworkRoute(id as NetworkRoute)}
                  columns={3}
                  ariaLabel="Маршрут сети"
                />
              </SettingRow>
              <SettingRow
                icon={Network}
                title="Адрес прокси"
                hint={
                  settings.proxyUrl
                    ? "Только этот адрес: публичные прокси-листы не поддерживаются"
                    : "Пусто — прокси не задан. Пример: socks5h://127.0.0.1:7890"
                }
                control={
                  <input
                    value={proxyDraft}
                    onChange={(event) => setProxyDraft(event.target.value)}
                    onBlur={() => void saveProxyUrl()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        setProxyDraft(settings.proxyUrl);
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="socks5h://127.0.0.1:7890"
                    spellCheck={false}
                    aria-label="Адрес локального прокси"
                    className="input w-64"
                  />
                }
              />
              <SettingRow
                icon={Search}
                title="Найти локальный прокси"
                hint="Проверит 7890, 7891, 1080, 10808, 2080, 9150 и 10801 на 127.0.0.1 — наружу не ходит"
                control={
                  <GhostButton onClick={() => void findLocalProxy()} disabled={proxyBusy !== null}>
                    {proxyBusy === "detect" ? "Ищу…" : "Найти"}
                  </GhostButton>
                }
              />
              {foundProxies.length > 0 && (
                <div className="px-4 pb-3">
                  <p className="text-[12px] text-muted mb-2">
                    Найдено: нажми вариант — он подставится в поле и сохранится.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {foundProxies.map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => void pickFoundProxy(value)}
                        className={`ui-control border px-2.5 py-1.5 text-[12px] transition-colors ${
                          value === settings.proxyUrl
                            ? "border-accentText text-ink"
                            : "border-line/[0.09] text-ink/85 hover:border-line/20 hover:bg-ink/[0.03]"
                        }`}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <SettingRow
                icon={RouteIcon}
                title="Проверить"
                hint="Живой запрос к SoundCloud через выбранный маршрут с замером времени"
                control={
                  <GhostButton onClick={() => void checkRoute()} disabled={proxyBusy !== null}>
                    {proxyBusy === "check" ? "Проверяю…" : "Проверить"}
                  </GhostButton>
                }
              />
              {routeCheck && (
                <div className="px-4 pb-3">
                  <p className={`text-[12px] ${routeCheck.ok ? "text-emerald-400/90" : "text-red-400"}`}>
                    {routeCheck.text}
                  </p>
                </div>
              )}
              <SettingNote>
                Приложение поддерживает только свой прокси: адрес, который ты ввёл сам, или тот, что
                нашёлся на этом компьютере. Списков чужих прокси здесь нет и не будет. Если системный
                DNS подменяет адрес, приложение всё равно умеет ходить через DoH — для этого есть
                запасной путь.
              </SettingNote>
            </SettingPanel>
          </>
        )}

        {section === "system" && current === "storage" && (
          <>
            <SettingPanel title="Резервная копия настроек" hint="Перенеси оформление и параметры на другое устройство">
              <SettingRow icon={ShieldCheck} title="Экспорт настроек" hint="Сохранить настройки приложения в JSON-файл" control={<GhostButton onClick={() => {
                const keys = ["music_hub_settings", "music_hub_theme", "music_hub_download_choice_remembered"];
                const payload = { format: "cursed-settings", version: 1, createdAt: new Date().toISOString(), data: Object.fromEntries(keys.flatMap((key) => { const value = localStorage.getItem(key); return value === null ? [] : [[key, value]]; })) };
                const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
                const link = document.createElement("a"); link.href = url; link.download = `cursed-settings-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
                toast({ title: "Копия настроек сохранена" });
              }} className="flex items-center gap-1.5"><Download size={13}/>Скачать копию</GhostButton>} />
              <SettingRow icon={Database} title="Восстановить настройки" hint="Заменит текущие параметры данными из выбранной копии" control={<GhostButton onClick={() => { const input = document.createElement("input"); input.type = "file"; input.accept = ".json,application/json"; input.onchange = async () => { const file = input.files?.[0]; if (!file) return; try { const parsed = JSON.parse(await file.text()); if (parsed?.format !== "cursed-settings" || parsed?.version !== 1 || !parsed.data || typeof parsed.data !== "object") throw new Error("invalid"); for (const [key, value] of Object.entries(parsed.data)) { if (["music_hub_settings", "music_hub_theme", "music_hub_download_choice_remembered"].includes(key) && typeof value === "string") localStorage.setItem(key, value); } toast({ title: "Настройки восстановлены", description: "Приложение перезапустит интерфейс" }); window.setTimeout(() => window.location.reload(), 500); } catch { toast({ title: "Не удалось восстановить копию", description: "Проверь, что выбран JSON-файл настроек Cursed player" }); } }; input.click(); }} className="flex items-center gap-1.5"><Undo2 size={13}/>Выбрать файл</GhostButton>} />
              <SettingNote>Копия включает параметры приложения и тему. Профили, пароли, токены и офлайн-файлы в неё не входят.</SettingNote>
            </SettingPanel>
            <SettingPanel title="Офлайн-хранилище" hint="Что остаётся на диске без интернета">
              <SettingRow
                icon={Database}
                title="Автокеш прослушанного"
                hint="Играющие треки из сервиса тихо остаются на диске — потом играют без интернета"
                control={
                  <Toggle
                    on={settings.autoCacheEnabled}
                    onChange={() => {
                      const next = !settings.autoCacheEnabled;
                      settings.setAutoCacheEnabled(next);
                      if (next) sounds.save();
                      else sounds.off();
                      toast({
                        title: next ? "Автокеш включён" : "Автокеш выключен",
                        description: next
                          ? "Прослушанные треки будут сохраняться на диск сами"
                          : "Офлайн останутся только сохранённые вручную",
                      });
                    }}
                    label="Автокеш прослушанного"
                  />
                }
              />
              <SettingRow
                icon={Database}
                title="Лимит офлайн-хранилища"
                hint={
                  settings.cacheLimitMb > 0
                    ? `Выше лимита автокеш останавливается: ${formatSize(
                        settings.cacheLimitMb * 1024 * 1024
                      )}. Скачанное вручную не удаляется`
                    : "Ноль — автокеш выключен, сохранять треки офлайн можно только вручную"
                }
                control={
                  <label className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={2000000}
                      step={100}
                      value={cacheLimitDraft}
                      onChange={(event) => {
                        const raw = event.target.value;
                        setCacheLimitDraft(raw);
                        const parsed = Number(raw);
                        // Пустое поле — это ещё не «ноль»: ждём, пока договорят
                        if (raw.trim() !== "" && Number.isFinite(parsed) && parsed >= 0) {
                          settings.setCacheLimitMb(parsed);
                        }
                      }}
                      onBlur={() => setCacheLimitDraft(String(useSettingsStore.getState().cacheLimitMb))}
                      aria-label="Лимит офлайн-хранилища в мегабайтах"
                      className="input w-28 text-right"
                    />
                    <span className="text-[12px] text-muted">МБ</span>
                  </label>
                }
              />
              <SettingRow
                icon={Heart}
                title="Загрузка локальных файлов"
                hint="FLAC, MP3, WAV, OGG, M4A — теги читаются из файла"
                control={
                  <span className="text-[12px] text-muted">
                    {settings.libraryFolders.length} папок в библиотеке
                  </span>
                }
              />
              <SettingNote>
                Скачанное вручную не удаляется никогда — лимит касается только автокеша. Офлайн-копии
                лежат в папке приложения и играют без сети.
              </SettingNote>
            </SettingPanel>

            <SettingPanel title="Журнал ошибок" hint="Что и когда не сработало">
              <SettingRow
                icon={AlertTriangle}
                title="Записи журнала"
                hint="Поиск, воспроизведение и сервисы пишут сюда свои ошибки"
                control={<span className="text-[12px] text-muted">{errors.length} из 60</span>}
              />
              <SettingRow
                icon={Trash2}
                title="Очистить журнал"
                hint="Удаляет все записи без возможности отката"
                control={
                  <GhostButton
                    onClick={() => {
                      clearErrors();
                      sounds.off();
                      toast({ title: "Журнал ошибок очищен" });
                    }}
                    disabled={errors.length === 0}
                    className="flex items-center gap-1.5"
                  >
                    <Trash2 size={13} /> Очистить
                  </GhostButton>
                }
              />
              <SettingRow
                icon={AlertTriangle}
                title="Открыть журнал"
                hint="Раздел «О приложении → Журнал ошибок»: там видно подробности каждой записи"
                control={<GhostButton onClick={() => openSection("errors")}>Открыть</GhostButton>}
              />
            </SettingPanel>
          </>
        )}

        {/* ─────────────────────── О приложении ─────────────────────── */}
        {section === "about" && current === "app" && (
          <>
            <SettingPanel>
              <div className="flex items-center gap-3 px-4 py-4">
                <img
                  src={appIcon}
                  alt=""
                  className="w-12 h-12 ui-tile border border-line/[0.10]"
                />
                <div className="min-w-0">
                  <p className="text-[14px] text-ink">{APP_NAME}</p>
                  <p className="text-[12px] text-muted">{APP_VERSION} · локальный музыкальный плеер</p>
                </div>
              </div>
              <SettingNote>Профили, настройки и оформление хранятся только на этом устройстве.</SettingNote>
              <SettingNote>
                <span className="flex items-center gap-1.5">
                  <Undo2 size={12} /> Любое переключение можно откатить кнопкой «Отменить» в уведомлении.
                </span>
              </SettingNote>
            </SettingPanel>

            <SettingPanel title="Обновления" hint="Новая сборка ставится установщиком с сервера">
              <SettingRow
                icon={Download}
                title={
                  updateInfo
                    ? `Доступна сборка ${updateInfo.version}`
                    : `Установлена сборка ${APP_BUILD}`
                }
                hint={
                  updateBusy
                    ? "Секунду…"
                    : updateInfo
                      ? updateInfo.notes || "Скачается установщик, приложение закроется и обновится"
                      : updateNote ?? "Проверить, не вышла ли новая версия"
                }
                control={
                  updateInfo ? (
                    <PrimaryButton
                      onClick={() => void runUpdate()}
                      disabled={updateBusy}
                      className="press"
                    >
                      {updateBusy ? "Скачиваю…" : "Обновить"}
                    </PrimaryButton>
                  ) : (
                    <GhostButton
                      onClick={() => void checkUpdates()}
                      disabled={updateBusy}
                      className="flex items-center gap-1.5"
                    >
                      {updateBusy ? "Проверяю…" : "Проверить"}
                    </GhostButton>
                  )
                }
              />
              <SettingNote>
                Обновления читаются из бакета <span className="text-ink">updates</span> вашего проекта
                Supabase: приложение сравнивает номер сборки с файлом <span className="text-ink">latest.json</span>.
                Если файла нет, обновлений не предлагается.
              </SettingNote>
            </SettingPanel>

            <SettingPanel title="Сводка" hint="Что сейчас выбрано">
              <SettingRow
                icon={Palette}
                title="Тема и акцент"
                hint={`${PRESETS[presetId]?.label ?? presetId} · ${accentFromCover ? "акцент из обложки" : `rgb(${colors.accent})`}`}
                control={
                  <GhostButton onClick={() => openSection("appearance")}>Изменить</GhostButton>
                }
              />
              <SettingRow
                icon={Ruler}
                title="Форма интерфейса"
                hint={`Скругление: ${
                  CORNER_OPTIONS.find((item) => item.id === settings.cornerRadius)?.label ??
                  settings.cornerRadius
                } · масштаб ${settings.uiScale}% · шрифт ${settings.fontSize} px`}
                control={<GhostButton onClick={() => openSection("appearance")}>Настроить</GhostButton>}
              />
              <SettingRow
                icon={SlidersHorizontal}
                title="Плеер и звук"
                hint={`Навигация: ${settings.navLayout === "top" ? "сверху" : "слева"} · вывод: ${outputLabel(
                  settings.audioOutputId
                )}`}
                control={<GhostButton onClick={() => openSection("player")}>Открыть</GhostButton>}
              />
            </SettingPanel>
          </>
        )}

        {section === "about" && current === "errors" && (
          <SettingPanel title="Журнал ошибок" hint="Хранятся последние 60 записей">
            {errors.length === 0 && (
              <div className="px-4 py-6 text-center">
                <p className="text-[13px] text-muted">Ошибок пока нет</p>
                <p className="text-[12px] text-faint mt-1">
                  Сюда попадает всё, что не сработало: поиск, воспроизведение, сервисы.
                </p>
              </div>
            )}
            {errors.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  sounds.open();
                  setOpenError(item);
                }}
                className="setting-row w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink/[0.04] transition-colors"
              >
                <AlertTriangle size={14} className="text-amber-400 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] truncate text-ink">{item.title}</span>
                  <span className="block text-[12px] text-muted truncate">
                    {new Date(item.at).toLocaleString("ru-RU")} · {item.source} · {item.description}
                  </span>
                </span>
                <ChevronRight size={14} className="text-faint shrink-0" />
              </button>
            ))}
            {errors.length > 0 && (
              <div className="setting-row flex items-center gap-2 px-4 py-3">
                <GhostButton
                  onClick={() => {
                    clearErrors();
                    sounds.off();
                    toast({ title: "Журнал ошибок очищен" });
                  }}
                  className="flex items-center gap-1.5"
                >
                  <Trash2 size={13} /> Очистить журнал
                </GhostButton>
                <span className="text-[12px] text-faint">Хранятся последние 60 записей</span>
              </div>
            )}
          </SettingPanel>
        )}

        {section === "about" && current === "dev" && isDeveloper && (
          <SettingPanel title="В разработке" hint="Видно только профилю @developer">
            <div className="px-4 py-4">
              <p className="text-[13px] text-ink">Ещё не готовые разделы</p>
              <p className="text-[12px] text-muted mt-1 leading-relaxed">
                Здесь собрано то, что раньше висело в обычных настройках, но ничего не делало.
              </p>
            </div>
            <div className="setting-row px-4 py-3.5">
              <p className="text-[12px] text-ink/85">Свои глобальные горячие клавиши</p>
              <p className="text-[12px] text-muted mt-1 leading-relaxed">
                Свои сочетания клавиш (например Ctrl+Alt+Space) появятся здесь, когда будет готова
                системная регистрация: сейчас поле globalHotkeys в хранилище никем не читается, поэтому
                настройка не показывается. Медиа-клавиши работают, пока окно в фокусе.
              </p>
            </div>
            <div className="setting-row px-4 py-3.5">
              <p className="text-[12px] text-ink/85">Ключи Spotify и Яндекс OAuth</p>
              <p className="text-[12px] text-muted mt-1 leading-relaxed">
                Поля spotifyClientId, yandexClientId и yandexClientSecret остались в хранилище, но
                интерфейс для их ввода убран: оба сервиса не отдают полное аудио сторонним клиентам.
                Вернём поля, если появится рабочий способ входа.
              </p>
            </div>
            <div className="setting-row px-4 py-3.5">
              <p className="text-[12px] text-ink/85">Подбор стратегий обхода блокировок</p>
              <p className="text-[12px] text-muted mt-1 leading-relaxed">
                Раздел появится здесь, когда будет готов: сейчас он не подключён к настройкам.
              </p>
            </div>
            <SettingRow
              icon={EyeOff}
              title="Скрытый слой"
              control={
                <>
                  <GhostButton
                    onClick={() => window.dispatchEvent(new CustomEvent("ui:layer:hide"))}
                    className="flex items-center gap-1.5"
                  >
                    <EyeOff size={13} /> Сбросить A
                  </GhostButton>
                  <GhostButton
                    onClick={() => window.dispatchEvent(new CustomEvent("ui:layer:reset"))}
                    className="flex items-center gap-1.5"
                  >
                    <Trash2 size={13} /> Сбросить B
                  </GhostButton>
                </>
              }
            />
            <SettingNote>Скоро</SettingNote>
          </SettingPanel>
        )}
      </div>

      {openError && (
        <Modal
          open
          onClose={() => setOpenError(null)}
          title={openError.title}
          description={`${new Date(openError.at).toLocaleString("ru-RU")} · ${openError.source}`}
          footer={
            <>
              <GhostButton
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `${openError.title}\n${openError.description}\n\n${openError.details ?? ""}`
                  );
                  sounds.save();
                  toast({ title: "Скопировано в буфер" });
                }}
              >
                Скопировать
              </GhostButton>
              <GhostButton
                onClick={() => {
                  removeError(openError.id);
                  setOpenError(null);
                }}
              >
                Удалить
              </GhostButton>
              <PrimaryButton onClick={() => setOpenError(null)}>Закрыть</PrimaryButton>
            </>
          }
        >
          <div className="space-y-3">
            <div>
              <p className="text-[12px] text-muted mb-1">Что произошло</p>
              <p className="text-[13px] selectable">{openError.description}</p>
            </div>
            <div>
              <p className="text-[12px] text-muted mb-1">Технические подробности</p>
              <pre className="text-[11px] text-muted bg-inset border border-line/[0.07] ui-tile p-3 max-h-56 overflow-auto whitespace-pre-wrap selectable">
                {openError.details || "Подробностей нет"}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Частота, длина и громкость сигнала проверки звука. */
const TEST_TONE_HZ = 440;
const TEST_TONE_SEC = 0.6;
const TEST_TONE_GAIN = 0.2;

/** Контекст или элемент с поддержкой выбора устройства вывода. */
type Sinkable = { setSinkId?: (deviceId: string) => Promise<void> };

/** WAV с коротким тоном: нужен там, где сигнал играет обычный медиаэлемент. */
function toneWavUrl(): string {
  const rate = 44100;
  const frames = Math.round(rate * TEST_TONE_SEC);
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);

  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    // Мягкая атака и затухание: без щелчков и без резкого обрыва
    const envelope = Math.min(1, t / 0.02) * Math.min(1, (TEST_TONE_SEC - t) / 0.06);
    const sample = Math.sin(2 * Math.PI * TEST_TONE_HZ * t) * TEST_TONE_GAIN * envelope;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }

  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

/**
 * Короткий сигнал проверки звука (440 Гц, 0,6 с) и ответ, куда он реально ушёл:
 * `"device"` — на выбранное устройство, `"default"` — на системное.
 *
 * Сначала пробуем WebAudio: у свежих движков у `AudioContext` есть свой
 * `setSinkId`, и сигнал идёт ровно на выбранное устройство. Если так не умеет —
 * играем отдельным медиаэлементом: у него маршрутизация есть давно. Играющий
 * трек при этом не трогаем — `playerAudio` не переиспользуем, иначе проверка
 * глушила бы музыку.
 */
async function playTestTone(deviceId: string): Promise<"device" | "default"> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const contextSink = Ctor ? (Ctor.prototype as Sinkable).setSinkId : undefined;

  if (Ctor && (!deviceId || typeof contextSink === "function")) {
    const context = new Ctor() as AudioContext & Sinkable;
    const sink = context.setSinkId;
    const routed = Boolean(deviceId) && typeof sink === "function";
    if (routed && sink) await sink.call(context, deviceId);
    if (context.state === "suspended") await context.resume();

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = TEST_TONE_HZ;
    const start = context.currentTime + 0.02;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(TEST_TONE_GAIN, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + TEST_TONE_SEC);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + TEST_TONE_SEC + 0.05);
    // Контекст проверки больше не нужен: закрываем, чтобы не держать устройство
    window.setTimeout(() => void context.close().catch(() => undefined), (TEST_TONE_SEC + 0.3) * 1000);
    return routed ? "device" : "default";
  }

  if (!deviceId || audioOutputSupported()) {
    const url = toneWavUrl();
    const element = new Audio() as HTMLAudioElement & Sinkable;
    const sink = element.setSinkId;
    const routed = Boolean(deviceId) && typeof sink === "function";
    try {
      if (routed && sink) await sink.call(element, deviceId);
      element.src = url;
      await element.play();
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        element.addEventListener("ended", done, { once: true });
        element.addEventListener("error", done, { once: true });
        window.setTimeout(done, (TEST_TONE_SEC + 1) * 1000);
      });
      return routed ? "device" : "default";
    } finally {
      element.pause();
      URL.revokeObjectURL(url);
    }
  }

  throw new Error("движок не умеет направлять звук на выбранное устройство");
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      onClick={onChange}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${on ? "bg-accent" : "bg-ink/15"}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 w-5 h-5 rounded-full shadow-md transition-transform duration-200 ${
          on ? "translate-x-4 bg-onAccent" : "translate-x-0 bg-muted"
        }`}
      />
    </button>
  );
}
