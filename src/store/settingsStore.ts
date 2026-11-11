import { create } from "zustand";
import { isServiceId, type ServiceId } from "../lib/services";
import { touch } from "./syncMeta";
import { errorText, logError } from "./errorStore";

/**
 * Настройки приложения, не относящиеся к теме оформления: звуки интерфейса,
 * уведомления и интеграции. Хранятся локально.
 */

const STORAGE_KEY = "music_hub_settings";

/**
 * Отметка «выбор при скачивании запомнен». Лежит отдельным ключом, потому что
 * сам выбор по умолчанию не пустой («both»): отличить «ещё не выбирал» от
 * «выбрал всё вместе» иначе невозможно. Пока отметки нет, окно выбора
 * показывается при каждом скачивании.
 */
const CHOICE_REMEMBERED_KEY = "music_hub_download_choice_remembered";

/** Что сохранять при скачивании трека. */
export type DownloadChoice = "track" | "lyrics" | "both";

/** Выбран ли в этом варианте трек / текст — для вызывающей стороны. */
export function choiceWantsTrack(choice: DownloadChoice): boolean {
  return choice === "track" || choice === "both";
}

export function choiceWantsLyrics(choice: DownloadChoice): boolean {
  return choice === "lyrics" || choice === "both";
}

/** Верхняя граница лимита автокеша: 2 ТБ — дальше только опечатка. */
const MAX_CACHE_LIMIT_MB = 2_000_000;

/**
 * Оформление интерфейса, которое применяется к документу CSS-переменными.
 * Живёт здесь, а не в теме: это настройки, а не палитра, и они не должны
 * ломать выбор пресета.
 */

/** Скругление углов: «нет» — плотная сетка образца, «большое» — мягкие панели. */
export type CornerRadius = "none" | "sm" | "md" | "lg";

/** Масштаб интерфейса в процентах: множитель корневого размера и отступов. */
export type UiScale = 75 | 90 | 100 | 110 | 125;

/** Размер шрифта интерфейса: базовый кегль, от которого считаются подписи. */
export type FontSize = 12 | 14 | 16 | 18;

/**
 * Скругления. Значения уходят атрибутом `data-radius` в styles.css, где лежат
 * сами радиусы; по умолчанию «среднее» — прежний вид приложения.
 */
export const CORNER_OPTIONS: { id: CornerRadius; label: string; hint: string }[] = [
  { id: "none", label: "Нет", hint: "Плотная сетка без скруглений" },
  { id: "sm", label: "Малое", hint: "6–8 px: строгие панели" },
  { id: "md", label: "Среднее", hint: "Как в макете: 10–14 px" },
  { id: "lg", label: "Большое", hint: "Мягкие плитки до 20 px" },
];

export const SCALE_OPTIONS: { id: UiScale; label: string; hint: string }[] = [
  { id: 75, label: "75%", hint: "Больше всего на экране" },
  { id: 90, label: "90%", hint: "Чуть плотнее обычного" },
  { id: 100, label: "100%", hint: "Обычный масштаб" },
  { id: 110, label: "110%", hint: "Крупнее на 10%" },
  { id: 125, label: "125%", hint: "Для больших мониторов" },
];

export const FONT_OPTIONS: { id: FontSize; label: string; hint: string }[] = [
  { id: 12, label: "12", hint: "Мелкий" },
  { id: 14, label: "14", hint: "Обычный" },
  { id: 16, label: "16", hint: "Крупный" },
  { id: 18, label: "18", hint: "Самый крупный" },
];

/**
 * Пишет оформление в документ: корневой кегль (от него считаются rem-отступы
 * Tailwind) и две переменные — множитель масштаба и множитель шрифта. Текстовые
 * утилиты с фиксированными px умножаются на их произведение в styles.css,
 * поэтому «масштаб» двигает всю сетку, а «шрифт» — только подписи.
 */
function applyUiAppearance(scale: UiScale, fontSize: FontSize) {
  const root = document.documentElement;
  root.style.setProperty("--ui-scale", String(scale / 100));
  root.style.setProperty("--font-scale", String(fontSize / 14));
  root.dataset.scale = String(scale);
  root.dataset.font = String(fontSize);
}

/** Скругление задаётся атрибутом: значения радиусов лежат в styles.css. */
function applyCornerRadius(radius: CornerRadius) {
  document.documentElement.dataset.radius = radius;
}

/** Скругление из сохранения; старые имена (`medium` и т. п.) тоже понимаем. */
function cornerFrom(value: unknown): CornerRadius | null {
  if (value === "none" || value === "sm" || value === "md" || value === "lg") return value;
  if (value === "small") return "sm";
  if (value === "medium") return "md";
  if (value === "large") return "lg";
  return null;
}

/** Кегль из сохранения: старый ключ `uiFontSize` читается как `fontSize`. */
function fontFrom(value: unknown): FontSize | null {
  return value === 12 || value === 14 || value === 16 || value === 18 ? value : null;
}

/** Вариант сортировки из сохранения: неизвестный ключ откатываем к имени. */
function librarySortFrom(value: unknown): LibrarySortKey | null {
  return value === "title" || value === "artist" || value === "duration" || value === "added"
    ? value
    : null;
}

/** Направление сортировки из сохранения. */
function libraryDirFrom(value: unknown): LibrarySortDir | null {
  return value === "asc" || value === "desc" ? value : null;
}

/** Группировка из сохранения. */
function libraryGroupFrom(value: unknown): LibraryGroup | null {
  return value === "list" || value === "artist" || value === "album" ? value : null;
}

/**
 * Как отсортирован список «Моей музыки». Набор общий для всех трёх вкладок:
 * человек один, и «по названию» на вкладке «Избранное» после перехода на
 * «Все треки» значит то же самое. «По популярности» здесь нет: в данных ни у
 * одного источника нет счётчика прослушиваний, а вариант, который ничего не
 * меняет, — обман.
 */
export type LibrarySortKey = "title" | "artist" | "duration" | "added";

/** Направление сортировки: по возрастанию или по убыванию. */
export type LibrarySortDir = "asc" | "desc";

/** Группировка строк: плоский список, по исполнителям или по альбомам. */
export type LibraryGroup = "list" | "artist" | "album";

/**
 * Как приложение ходит в сеть. «Прямой» — как есть, «локальный прокси» — только
 * через адрес из `proxyUrl`, «авто» — гонка двух путей: кто ответит первым,
 * тот и выиграл. Прокси при этом только локальный (или свой), публичных списков
 * нет и не будет.
 */
export type NetworkRoute = "direct" | "proxy" | "auto";

/** Варианты маршрута для настроек. */
export const NETWORK_ROUTE_OPTIONS: { id: NetworkRoute; label: string; hint: string }[] = [
  { id: "direct", label: "Прямой", hint: "Без прокси, как есть" },
  { id: "proxy", label: "Локальный прокси", hint: "Только через адрес ниже" },
  { id: "auto", label: "Авто", hint: "Гонка путей: что ответит быстрее" },
];

export interface AppSettings {
  soundEnabled: boolean;
  /** Громкость звуков интерфейса, 0..1. */
  soundVolume: number;
  toastsEnabled: boolean;
  /** Discord Rich Presence: показывать, что играет. */
  discordEnabled: boolean;
  /** Application ID из Discord Developer Portal (обязателен для платформы). */
  discordClientId: string;
  /** Client ID приложения Spotify (публичный, не секрет). */
  spotifyClientId: string;
  /** Сервис, через который ищем и показываем музыку. */
  activeService: ServiceId;
  /** Папки локальной библиотеки. */
  libraryFolders: string[];
  /** Громкость музыки, 0..1 (отдельно от звуков интерфейса). */
  playerVolume: number;
  /**
   * Устройство вывода звука (`deviceId` из `enumerateDevices`) или "default" —
   * системное по умолчанию. Настройка устройства, а не вкуса, поэтому между
   * компьютерами она не переносится.
   */
  audioOutputId: string;
  /** Автокеш прослушанного: играющие сервисные треки тихо остаются офлайн. */
  autoCacheEnabled: boolean;
  /** Лимит офлайн-хранилища в мегабайтах: выше него автокеш не сохраняет. */
  cacheLimitMb: number;
  /** Что делает крестик: спрашивать, свернуть в трей или закрыть. */
  closeBehavior: "ask" | "tray" | "quit";
  /** Уведомление Windows при смене трека. */
  notifyOnTrackChange: boolean;
  /** Свои глобальные горячие клавиши. */
  globalHotkeys: boolean;
  /** Запускать вместе с Windows. */
  autostart: boolean;
  /** Набор звуков интерфейса. */
  soundPack: "soft" | "classic" | "minimal";
  /** Своя иконка приложения (data-URL) вместо встроенной. */
  customAppIcon: string | null;
  /**
   * Обои приложения. Значение — ссылка `media:wallpaper` (байты лежат в базе
   * медиа, см. `lib/wallpaperMedia`) либо data-URL старого формата: такие
   * записи переносятся в базу при первом запуске. `null` — обоев нет.
   * Синхронизации нет: тяжёлой картинке нечего делать в облачных настройках.
   */
  playerWallpaper: string | null;
  /** Затемнение обоев 0..0.85: обложка и текст должны читаться на любом фото. */
  playerWallpaperDim: number;
  /** Насколько панели и карточки пропускают обои: 1 — плотные, 0.4 — стекло. */
  panelAlpha: number;
  /** Островок поверх других окон включён. */
  islandEnabled: boolean;
  /** Показывать островок всегда, а не только когда запущена Dota. */
  islandAlways: boolean;
  /** Оставшееся действие: держать островок поверх всех окон. */
  islandAlwaysOnTop: boolean;
  /** Прозрачность окна целиком: 1 — обычное, ниже — видно рабочий стол. */
  windowAlpha: number;
  /**
   * Где живёт навигация: стеклянная панель во всю ширину сверху или привычное
   * боковое меню. Переключается в настройках, применяется сразу.
   */
  navLayout: "top" | "side";
  /** Приложение Яндекс OAuth: id и секрет для честного входа. */
  yandexClientId: string;
  yandexClientSecret: string;
  /** Какой адрес возврата зарегистрирован в приложении Яндекса. */
  yandexRedirectHost: string;
  /** client_id SoundCloud: если пусто, приложение найдёт публичный само. */
  soundcloudClientId: string;
  /**
   * Запасной путь сохранения: внешний сервис soundloadmate. По умолчанию
   * выключен — это чужая сторона, и работает она без гарантий.
   */
  externalDownloaderEnabled: boolean;
  /**
   * Что сохранять при скачивании: трек, текст или всё вместе. Спрашивается
   * окном выбора только пока не отмечено «запомнить» (см. `choiceRemembered`).
   */
  downloadChoice: DownloadChoice;
  /**
   * Пропускать тишину в конце трека. Работает только там, где есть локальный
   * файл: у потока хвост измерить надёжно нельзя, поэтому для потоковых треков
   * настройка ничего не меняет.
   */
  skipTailSilence: boolean;
  /** Скругление углов интерфейса: применяется к общим классам панелей и плиток. */
  cornerRadius: CornerRadius;
  /** Масштаб интерфейса: корневой кегль и отступы. */
  uiScale: UiScale;
  /** Размер шрифта интерфейса: базовый кегль подписей. */
  fontSize: FontSize;
  /**
   * Акцент интерфейса берётся из обложки текущего трека. Здесь хранится сама
   * настройка (её видно в «Интерфейс → Вид»); применяет её тема: без обложки,
   * при ошибке загрузки или нехватке контраста остаётся акцент пресета.
   * По умолчанию выключено — цвет интерфейса не должен меняться сам.
   */
  accentFromCover: boolean;
  /**
   * Сортировка и группировка в «Моей музыке». Запоминаются отдельным ключом
   * настроек и переживают перезапуск: список не должен каждый раз начинаться
   * заново «как получилось». Выбор общий для всех трёх вкладок.
   */
  librarySort: LibrarySortKey;
  librarySortDir: LibrarySortDir;
  libraryGroup: LibraryGroup;
  /**
   * Маршрут сети: напрямую, через локальный прокси или гонкой. Настройка
   * устройства, а не вкуса: между компьютерами не переносится.
   */
  networkRoute: NetworkRoute;
  /**
   * Адрес локального прокси, например `socks5h://127.0.0.1:7890` или
   * `http://127.0.0.1:2080`. Пусто — прокси не задан. Только то, что ввёл
   * пользователь (или нашлось локально).
   */
  proxyUrl: string;
}

/**
 * Настройки, которые переносятся между устройствами. Здесь только то, что
 * описывает вкус пользователя: ключи сервисов, папки библиотеки, автозапуск и
 * своя иконка — вещи устройства, их синхронизировать нельзя.
 */
export const SYNCED_SETTINGS: readonly (keyof AppSettings)[] = [
  "soundEnabled",
  "soundVolume",
  "toastsEnabled",
  "soundPack",
  "closeBehavior",
  "notifyOnTrackChange",
  "playerVolume",
  "autoCacheEnabled",
  "cacheLimitMb",
  "externalDownloaderEnabled",
  "activeService",
  "skipTailSilence",
];

const FALLBACK: AppSettings = {
  soundEnabled: true,
  soundVolume: 0.5,
  toastsEnabled: true,
  discordEnabled: false,
  discordClientId: "",
  spotifyClientId: "",
  activeService: "spotify",
  libraryFolders: [],
  playerVolume: 0.8,
  // Автокеш по умолчанию выключен: фоновая загрузка всего трека через curl
  // делила соединение с получением потока и заметно задерживала первый звук.
  // Кому нужно — включает сам (у кого уже сохранено true, значение не меняем).
  autoCacheEnabled: false,
  cacheLimitMb: 5000,
  closeBehavior: "ask",
  audioOutputId: "default",
  notifyOnTrackChange: true,
  globalHotkeys: true,
  autostart: false,
  soundPack: "soft",
  // Иконка по умолчанию — новая (нота на чёрном), а не старая фиолетовая.
  customAppIcon: "data:image/png;base64,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",
  // Обоев по умолчанию нет: плеер выглядит как раньше, пока человек сам не
  // выберет картинку. Затемнение 0.55 — середина: фото видно, текст читается.
  playerWallpaper: null,
  playerWallpaperDim: 0.55,
  panelAlpha: 1,
  islandEnabled: true,
  islandAlways: false,
  islandAlwaysOnTop: true,
  windowAlpha: 1,
  // Верхняя панель — новый вид оболочки по умолчанию; боковое меню остаётся
  // доступным переключателем в настройках.
  navLayout: "top",
  yandexClientId: "",
  yandexClientSecret: "",
  yandexRedirectHost: "127.0.0.1",
  /** client_id SoundCloud: если пусто, приложение найдёт публичный само. */
  soundcloudClientId: "",
  // Запасной путь через чужой сервис выключен, пока пользователь сам не
  // решит: нативное сохранение надёжнее, а внешний сервис может закрыться.
  externalDownloaderEnabled: false,
  // По умолчанию сохраняем и трек, и текст: это ожидаемый результат
  // скачивания, а окно выбора лишь уточняет его.
  downloadChoice: "both",
  // По умолчанию хвост не пропускаем: приложение должно вести себя как раньше,
  // пока человек сам не попросит обрезать тишину.
  skipTailSilence: false,
  // Оформление по умолчанию совпадает с прежним видом: среднее скругление,
  // масштаб 100% и кегль 14 — ничего не меняется без просьбы пользователя.
  cornerRadius: "md",
  uiScale: 100,
  fontSize: 14,
  // Акцент из обложки по умолчанию выключен: тема остаётся предсказуемой,
  // пока человек сам не попросит подстраивать цвет под трек.
  accentFromCover: false,
  // «Моя музыка» по умолчанию идёт как раньше: плоский список в порядке
  // добавления, без группировки. Сортировка по названию по возрастанию.
  librarySort: "title",
  librarySortDir: "asc",
  libraryGroup: "list",
  // Сеть по умолчанию — «авто»: если рядом есть локальный прокси, приложение
  // само сравнит его с прямым путём и возьмёт тот, что ответил первым.
  networkRoute: "auto",
  proxyUrl: "",
};

/** Запомнен ли выбор при скачивании: пока нет — окно показывается каждый раз. */
function loadChoiceRemembered(): boolean {
  try {
    return localStorage.getItem(CHOICE_REMEMBERED_KEY) === "1";
  } catch {
    return false;
  }
}

function persistChoiceRemembered(value: boolean): void {
  try {
    localStorage.setItem(CHOICE_REMEMBERED_KEY, value ? "1" : "0");
  } catch {
    // Переполнение хранилища не должно ломать скачивание
  }
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return FALLBACK;
    // Старые имена полей оформления читаем тоже: иначе у тех, кто уже
    // настроил вид, настройки молча откатились бы к умолчанию.
    const parsed = JSON.parse(raw) as Partial<AppSettings> & {
      radius?: unknown;
      uiFontSize?: unknown;
    };
    const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
    return {
      soundEnabled: bool(parsed.soundEnabled, FALLBACK.soundEnabled),
      soundVolume:
        typeof parsed.soundVolume === "number"
          ? Math.min(1, Math.max(0, parsed.soundVolume))
          : FALLBACK.soundVolume,
      toastsEnabled: bool(parsed.toastsEnabled, FALLBACK.toastsEnabled),
      discordEnabled: bool(parsed.discordEnabled, FALLBACK.discordEnabled),
      discordClientId:
        typeof parsed.discordClientId === "string" ? parsed.discordClientId : FALLBACK.discordClientId,
      spotifyClientId:
        typeof parsed.spotifyClientId === "string" ? parsed.spotifyClientId : FALLBACK.spotifyClientId,
      activeService: isServiceId(parsed.activeService) ? parsed.activeService : FALLBACK.activeService,
      libraryFolders: Array.isArray(parsed.libraryFolders)
        ? parsed.libraryFolders.filter((v): v is string => typeof v === "string")
        : FALLBACK.libraryFolders,
      playerVolume:
        typeof parsed.playerVolume === "number"
          ? Math.min(1, Math.max(0, parsed.playerVolume))
          : FALLBACK.playerVolume,
      audioOutputId:
        typeof parsed.audioOutputId === "string" && parsed.audioOutputId
          ? parsed.audioOutputId
          : FALLBACK.audioOutputId,
      autoCacheEnabled: bool(parsed.autoCacheEnabled, FALLBACK.autoCacheEnabled),
      cacheLimitMb:
        typeof parsed.cacheLimitMb === "number" && Number.isFinite(parsed.cacheLimitMb)
          ? Math.min(MAX_CACHE_LIMIT_MB, Math.max(0, Math.round(parsed.cacheLimitMb)))
          : FALLBACK.cacheLimitMb,
      closeBehavior:
        parsed.closeBehavior === "tray" || parsed.closeBehavior === "quit" || parsed.closeBehavior === "ask"
          ? parsed.closeBehavior
          : FALLBACK.closeBehavior,
      notifyOnTrackChange: bool(parsed.notifyOnTrackChange, FALLBACK.notifyOnTrackChange),
      globalHotkeys: bool(parsed.globalHotkeys, FALLBACK.globalHotkeys),
      autostart: bool(parsed.autostart, FALLBACK.autostart),
      soundPack:
        parsed.soundPack === "classic" || parsed.soundPack === "minimal" || parsed.soundPack === "soft"
          ? parsed.soundPack
          : FALLBACK.soundPack,
      customAppIcon: typeof parsed.customAppIcon === "string" ? parsed.customAppIcon : null,
      playerWallpaper: typeof parsed.playerWallpaper === "string" ? parsed.playerWallpaper : null,
      playerWallpaperDim:
        typeof parsed.playerWallpaperDim === "number" && Number.isFinite(parsed.playerWallpaperDim)
          ? Math.min(0.85, Math.max(0, parsed.playerWallpaperDim))
          : FALLBACK.playerWallpaperDim,
      islandEnabled: bool(parsed.islandEnabled, FALLBACK.islandEnabled),
      islandAlways: bool(parsed.islandAlways, FALLBACK.islandAlways),
      islandAlwaysOnTop: bool(parsed.islandAlwaysOnTop, FALLBACK.islandAlwaysOnTop),
      panelAlpha:
        typeof parsed.panelAlpha === "number" && Number.isFinite(parsed.panelAlpha)
          ? Math.min(1, Math.max(0.3, parsed.panelAlpha))
          : FALLBACK.panelAlpha,
      windowAlpha:
        typeof parsed.windowAlpha === "number" && Number.isFinite(parsed.windowAlpha)
          ? Math.min(1, Math.max(0.35, parsed.windowAlpha))
          : FALLBACK.windowAlpha,
      navLayout: parsed.navLayout === "side" ? "side" : "top",
      yandexClientId: typeof parsed.yandexClientId === "string" ? parsed.yandexClientId : "",
      yandexClientSecret: typeof parsed.yandexClientSecret === "string" ? parsed.yandexClientSecret : "",
      yandexRedirectHost: parsed.yandexRedirectHost === "localhost" ? "localhost" : "127.0.0.1",
      soundcloudClientId:
        typeof parsed.soundcloudClientId === "string" ? parsed.soundcloudClientId : "",
      externalDownloaderEnabled: bool(
        parsed.externalDownloaderEnabled,
        FALLBACK.externalDownloaderEnabled
      ),
      downloadChoice:
        parsed.downloadChoice === "track" ||
        parsed.downloadChoice === "lyrics" ||
        parsed.downloadChoice === "both"
          ? parsed.downloadChoice
          : FALLBACK.downloadChoice,
      skipTailSilence: bool(parsed.skipTailSilence, FALLBACK.skipTailSilence),
      cornerRadius: cornerFrom(parsed.cornerRadius ?? parsed.radius) ?? FALLBACK.cornerRadius,
      uiScale:
        parsed.uiScale === 75 ||
        parsed.uiScale === 90 ||
        parsed.uiScale === 110 ||
        parsed.uiScale === 125 ||
        parsed.uiScale === 100
          ? parsed.uiScale
          : FALLBACK.uiScale,
      fontSize: fontFrom(parsed.fontSize ?? parsed.uiFontSize) ?? FALLBACK.fontSize,
      accentFromCover: bool(parsed.accentFromCover, FALLBACK.accentFromCover),
      librarySort: librarySortFrom(parsed.librarySort) ?? FALLBACK.librarySort,
      librarySortDir: libraryDirFrom(parsed.librarySortDir) ?? FALLBACK.librarySortDir,
      libraryGroup: libraryGroupFrom(parsed.libraryGroup) ?? FALLBACK.libraryGroup,
      networkRoute:
        parsed.networkRoute === "direct" ||
        parsed.networkRoute === "proxy" ||
        parsed.networkRoute === "auto"
          ? parsed.networkRoute
          : FALLBACK.networkRoute,
      proxyUrl: typeof parsed.proxyUrl === "string" ? parsed.proxyUrl.trim() : FALLBACK.proxyUrl,
    };
  } catch {
    return FALLBACK;
  }
}

function persist(state: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // Квота кончилась (обычно из-за тяжёлой картинки в другой записи):
    // молча терять настройки нельзя — пишем в журнал ошибок.
    logError(
      "Настройки не сохранились",
      "В локальном хранилище не осталось места. Настройка применилась до перезапуска.",
      "настройки",
      errorText(e)
    );
  }
}

interface SettingsState extends AppSettings {
  setSoundEnabled: (value: boolean) => void;
  setSoundVolume: (value: number) => void;
  setToastsEnabled: (value: boolean) => void;
  setDiscordEnabled: (value: boolean) => void;
  setDiscordClientId: (value: string) => void;
  setSpotifyClientId: (value: string) => void;
  setActiveService: (value: ServiceId) => void;
  setPlayerVolume: (value: number) => void;
  setAudioOutputId: (value: string) => void;
  setAutoCacheEnabled: (value: boolean) => void;
  setCacheLimitMb: (value: number) => void;
  addLibraryFolder: (path: string) => void;
  removeLibraryFolder: (path: string) => void;
  setCloseBehavior: (value: "ask" | "tray" | "quit") => void;
  setNotifyOnTrackChange: (value: boolean) => void;
  setGlobalHotkeys: (value: boolean) => void;
  setAutostart: (value: boolean) => void;
  setSoundPack: (value: "soft" | "classic" | "minimal") => void;
  setCustomAppIcon: (value: string | null) => void;
  /** Обои полноэкранного плеера: data-URL картинки или null, чтобы убрать. */
  setPlayerWallpaper: (value: string | null) => void;
  /** Затемнение обоев, 0..0.85. */
  setPlayerWallpaperDim: (value: number) => void;
  setPanelAlpha: (value: number) => void;
  setIslandEnabled: (value: boolean) => void;
  setIslandAlways: (value: boolean) => void;
  setIslandAlwaysOnTop: (value: boolean) => void;
  setWindowAlpha: (value: number) => void;
  setNavLayout: (value: "top" | "side") => void;
  setYandexClientId: (value: string) => void;
  setYandexClientSecret: (value: string) => void;
  setYandexRedirectHost: (value: string) => void;
  setSoundcloudClientId: (value: string) => void;
  setExternalDownloaderEnabled: (value: boolean) => void;
  /** Пропускать тишину в конце трека (только для локальных файлов). */
  setSkipTailSilence: (value: boolean) => void;
  /** Скругление углов интерфейса. */
  setCornerRadius: (value: CornerRadius) => void;
  /** Масштаб интерфейса (проценты). */
  setUiScale: (value: UiScale) => void;
  /** Размер шрифта интерфейса. */
  setFontSize: (value: FontSize) => void;
  /** Акцент из обложки текущего трека (сам цвет считает тема). */
  setAccentFromCover: (value: boolean) => void;
  /** Сортировка списка «Моей музыки»: вариант и направление. */
  setLibrarySort: (value: LibrarySortKey) => void;
  setLibrarySortDir: (value: LibrarySortDir) => void;
  /** Группировка списка «Моей музыки». */
  setLibraryGroup: (value: LibraryGroup) => void;
  /** Маршрут сети: напрямую, через прокси или гонкой. */
  setNetworkRoute: (value: NetworkRoute) => void;
  /** Адрес прокси: пустая строка — прокси не задан. */
  setProxyUrl: (value: string) => void;
  /**
   * Выбор при скачивании. `remember` = true (по умолчанию) — больше не
   * спрашивать; false — окно выбора вернётся при следующем скачивании.
   */
  setDownloadChoice: (value: DownloadChoice, remember?: boolean) => void;
  /** Запомнен ли выбор при скачивании: иначе строку спрашивает окно. */
  downloadChoiceRemembered: boolean;
  /**
   * Синхронизация: отметить настройку изменённой во время `atMs` (по
   * умолчанию — сейчас). Обычно зовётся сама из `save`.
   */
  markChanged: (name: string, atMs?: number) => void;
  /**
   * Синхронизация: применить значение с сервера. Неизвестные для этой версии
   * настройки игнорируются, а «грязный» флаг не ставится: значение пришло с
   * сервера и обратно уезжать не должно.
   */
  applyRemote: (name: string, value: unknown) => void;
}

const initial = load();

// Оформление применяем до первого кадра: иначе окно мигнуло бы чужим масштабом
applyUiAppearance(initial.uiScale, initial.fontSize);
applyCornerRadius(initial.cornerRadius);

export const useSettingsStore = create<SettingsState>((set, get) => {
  /**
   * Применяем значение с сервера: своё время изменения не ставим, иначе
   * чужая настройка тут же уехала бы обратно как «только что изменённая».
   */
  let applyingRemote = false;

  const save = (patch: Partial<AppSettings>) => {
    const before = get();
    const next = { ...before, ...patch };
    persist({
      soundEnabled: next.soundEnabled,
      soundVolume: next.soundVolume,
      toastsEnabled: next.toastsEnabled,
      discordEnabled: next.discordEnabled,
      discordClientId: next.discordClientId,
      spotifyClientId: next.spotifyClientId,
      activeService: next.activeService,
      libraryFolders: next.libraryFolders,
      playerVolume: next.playerVolume,
      audioOutputId: next.audioOutputId,
      autoCacheEnabled: next.autoCacheEnabled,
      cacheLimitMb: next.cacheLimitMb,
      closeBehavior: next.closeBehavior,
      notifyOnTrackChange: next.notifyOnTrackChange,
      globalHotkeys: next.globalHotkeys,
      autostart: next.autostart,
      soundPack: next.soundPack,
      customAppIcon: next.customAppIcon,
      playerWallpaper: next.playerWallpaper,
      playerWallpaperDim: next.playerWallpaperDim,
      panelAlpha: next.panelAlpha,
      islandEnabled: next.islandEnabled,
      islandAlways: next.islandAlways,
      islandAlwaysOnTop: next.islandAlwaysOnTop,
      windowAlpha: next.windowAlpha,
      navLayout: next.navLayout,
      yandexClientId: next.yandexClientId,
      yandexClientSecret: next.yandexClientSecret,
      yandexRedirectHost: next.yandexRedirectHost,
      soundcloudClientId: next.soundcloudClientId,
      externalDownloaderEnabled: next.externalDownloaderEnabled,
      downloadChoice: next.downloadChoice,
      skipTailSilence: next.skipTailSilence,
      cornerRadius: next.cornerRadius,
      uiScale: next.uiScale,
      fontSize: next.fontSize,
      accentFromCover: next.accentFromCover,
      librarySort: next.librarySort,
      librarySortDir: next.librarySortDir,
      libraryGroup: next.libraryGroup,
      networkRoute: next.networkRoute,
      proxyUrl: next.proxyUrl,
    });
    set(patch);

    // Синхронизация: «грязными» становятся только переносимые настройки,
    // которые действительно поменялись. Ключи сервисов и адреса устройства
    // сюда не попадают: они лежат вне SYNCED_SETTINGS.
    if (applyingRemote) return;
    const now = Date.now();
    for (const key of SYNCED_SETTINGS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (before[key] === next[key]) continue;
      touch("setting", key, now);
    }
  };

  return {
    ...initial,
    downloadChoiceRemembered: loadChoiceRemembered(),
    setSoundEnabled: (value) => save({ soundEnabled: value }),
    setSoundVolume: (value) => save({ soundVolume: Math.min(1, Math.max(0, value)) }),
    setToastsEnabled: (value) => save({ toastsEnabled: value }),
    setDiscordEnabled: (value) => save({ discordEnabled: value }),
    setDiscordClientId: (value) => save({ discordClientId: value.trim() }),
    setSpotifyClientId: (value) => save({ spotifyClientId: value.trim() }),
    setActiveService: (value) => save({ activeService: value }),
    setPlayerVolume: (value) => save({ playerVolume: Math.min(1, Math.max(0, value)) }),
    // Пустая строка и мусор означают системное устройство: иначе выбор вывода
    // остался бы «ни на чём» и звук снова пропал бы.
    setAudioOutputId: (value) =>
      save({ audioOutputId: typeof value === "string" && value ? value : "default" }),
    setAutoCacheEnabled: (value) => save({ autoCacheEnabled: value }),
    setCacheLimitMb: (value) =>
      save({
        cacheLimitMb: Number.isFinite(value)
          ? Math.min(MAX_CACHE_LIMIT_MB, Math.max(0, Math.round(value)))
          : FALLBACK.cacheLimitMb,
      }),
    addLibraryFolder: (path) =>
      save({
        libraryFolders: get().libraryFolders.includes(path)
          ? get().libraryFolders
          : [...get().libraryFolders, path],
      }),
    removeLibraryFolder: (path) =>
      save({ libraryFolders: get().libraryFolders.filter((item) => item !== path) }),
    setCloseBehavior: (value) => save({ closeBehavior: value }),
    setNotifyOnTrackChange: (value) => save({ notifyOnTrackChange: value }),
    setGlobalHotkeys: (value) => save({ globalHotkeys: value }),
    setAutostart: (value) => save({ autostart: value }),
    setSoundPack: (value) => save({ soundPack: value }),
    setCustomAppIcon: (value) => save({ customAppIcon: value }),
    setPlayerWallpaper: (value) => save({ playerWallpaper: value }),
    setPlayerWallpaperDim: (value) => save({ playerWallpaperDim: Math.min(0.85, Math.max(0, value)) }),
    setPanelAlpha: (value) => save({ panelAlpha: Math.min(1, Math.max(0.3, value)) }),
    setIslandEnabled: (value) => save({ islandEnabled: value }),
    setIslandAlways: (value) => save({ islandAlways: value }),
    setIslandAlwaysOnTop: (value) => save({ islandAlwaysOnTop: value }),
    setWindowAlpha: (value) => save({ windowAlpha: Math.min(1, Math.max(0.35, value)) }),
    setNavLayout: (value) => save({ navLayout: value }),
    setYandexClientId: (value) => save({ yandexClientId: value.trim() }),
    setYandexClientSecret: (value) => save({ yandexClientSecret: value.trim() }),
    setYandexRedirectHost: (value) => save({ yandexRedirectHost: value === "localhost" ? "localhost" : "127.0.0.1" }),
    setSoundcloudClientId: (value) => save({ soundcloudClientId: value.trim() }),
    setExternalDownloaderEnabled: (value) => save({ externalDownloaderEnabled: value }),
    setSkipTailSilence: (value) => save({ skipTailSilence: value }),
    setCornerRadius: (value) => {
      applyCornerRadius(value);
      save({ cornerRadius: value });
    },
    setUiScale: (value) => {
      applyUiAppearance(value, get().fontSize);
      save({ uiScale: value });
    },
    setFontSize: (value) => {
      applyUiAppearance(get().uiScale, value);
      save({ fontSize: value });
    },
    setAccentFromCover: (value) => save({ accentFromCover: value }),
    setLibrarySort: (value) => save({ librarySort: value }),
    setLibrarySortDir: (value) => save({ librarySortDir: value }),
    setLibraryGroup: (value) => save({ libraryGroup: value }),
    setNetworkRoute: (value) => save({ networkRoute: value }),
    setProxyUrl: (value) => save({ proxyUrl: value.trim() }),
    setDownloadChoice: (value, remember = true) => {
      save({ downloadChoice: value });
      persistChoiceRemembered(remember);
      set({ downloadChoiceRemembered: remember });
    },

    markChanged: (name, atMs) => {
      touch("setting", name, atMs);
    },

    applyRemote: (name, value) => {
      const state = get();
      applyingRemote = true;
      try {
        switch (name) {
          case "soundEnabled":
            if (typeof value === "boolean") state.setSoundEnabled(value);
            break;
          case "soundVolume":
            if (typeof value === "number") state.setSoundVolume(value);
            break;
          case "toastsEnabled":
            if (typeof value === "boolean") state.setToastsEnabled(value);
            break;
          case "soundPack":
            if (value === "soft" || value === "classic" || value === "minimal") {
              state.setSoundPack(value);
            }
            break;
          case "closeBehavior":
            if (value === "ask" || value === "tray" || value === "quit") {
              state.setCloseBehavior(value);
            }
            break;
          case "notifyOnTrackChange":
            if (typeof value === "boolean") state.setNotifyOnTrackChange(value);
            break;
          case "playerVolume":
            if (typeof value === "number") state.setPlayerVolume(value);
            break;
          case "autoCacheEnabled":
            if (typeof value === "boolean") state.setAutoCacheEnabled(value);
            break;
          case "cacheLimitMb":
            if (typeof value === "number") state.setCacheLimitMb(value);
            break;
          case "externalDownloaderEnabled":
            if (typeof value === "boolean") state.setExternalDownloaderEnabled(value);
            break;
          case "activeService":
            if (isServiceId(value)) state.setActiveService(value);
            break;
          case "skipTailSilence":
            if (typeof value === "boolean") state.setSkipTailSilence(value);
            break;
          default:
            // Настройка из другой версии приложения: молча пропускаем
            return;
        }
      } finally {
        applyingRemote = false;
      }
    },
  };
});
