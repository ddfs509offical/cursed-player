import { create } from "zustand";
import { usePlayerStore } from "./playerStore";
import { useSettingsStore } from "./settingsStore";

/** Плотность интерфейса — переключается пользователем в настройках. */
export type Density = "compact" | "cozy" | "airy";

export const DENSITIES: { id: Density; label: string; hint: string }[] = [
  { id: "compact", label: "Компактная", hint: "Больше строк на экране" },
  { id: "cozy", label: "Обычная", hint: "Баланс отступов" },
  { id: "airy", label: "Просторная", hint: "Крупные блоки и отступы" },
];

/**
 * Базовые токены темы — то, что задаёт пресет.
 * Все цвета хранятся как rgb-триплеты ("17 17 21"), чтобы Tailwind мог
 * применять прозрачность: bg-surface/80, border-line/10 и так далее.
 */
export interface BaseColors {
  /** Фон окна. */
  app: string;
  /** Углублённые поверхности: поля поиска, строки таблиц. */
  inset: string;
  /** Основные панели и карточки. */
  surface: string;
  /** Всплывающие слои: меню, поповеры. */
  surface2: string;
  /** Модалки и полноэкранные оверлеи. */
  surface3: string;
  /** Цвет границ/разделителей (используется с альфой). */
  line: string;
  /** Основной цвет текста (используется с альфой для иерархии). */
  ink: string;
  /** Акцент, который выбирает пользователь. */
  accent: string;
}

/**
 * Тема целиком: базовые токены пресета + производные, которые считаются из
 * акцента. Производные не хранятся как «правда» — они всегда пересчитываются,
 * поэтому старые сохранения и любой пользовательский акцент остаются рабочими.
 */
export interface ThemeColors extends BaseColors {
  /** Текст/иконки поверх заливки accent. */
  onAccent: string;
  /** Акцент, пригодный для текста на поверхности (контраст ≥ 4.5:1). */
  accentText: string;
  /** Заливка accent для :hover — на том же полюсе, что onAccent. */
  accentHover: string;
  /**
   * Вторичный текст и подписи. Считаются от фона с целевым контрастом,
   * а не задаются прозрачностью: ink/55 в светлой теме давал 4.28:1, в
   * тёмной — 5.84:1, то есть «одна и та же» прозрачность читалась по-разному.
   */
  muted: string;
  /** Микро-подписи и иконки-указатели: целевой контраст ~3.3:1. */
  faint: string;
  /** Обложки и градиенты: всегда средне-тёмные, чтобы текст читался. */
  coverA: string;
  coverB: string;
  coverC: string;
  coverInk: string;
  shadowPanel: string;
  shadowLift: string;
}

const WHITE = "255 255 255";
const DARK = "10 10 12";

const SHADOWS = {
  dark: {
    panel: "0 1px 2px rgb(0 0 0 / 0.30), 0 8px 24px -8px rgb(0 0 0 / 0.45)",
    lift: "0 2px 4px rgb(0 0 0 / 0.35), 0 16px 32px -12px rgb(0 0 0 / 0.55)",
  },
  light: {
    panel: "0 1px 2px rgb(15 15 20 / 0.06), 0 8px 24px -12px rgb(15 15 20 / 0.16)",
    lift: "0 2px 4px rgb(15 15 20 / 0.08), 0 16px 32px -12px rgb(15 15 20 / 0.22)",
  },
};

const BASE_KEYS: (keyof BaseColors)[] = [
  "app",
  "inset",
  "surface",
  "surface2",
  "surface3",
  "line",
  "ink",
  "accent",
];

const RGB_RE = /^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/;

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const rgb = (v: string) => v.split(" ").map(Number);
const fmt = (v: number[]) => `${clamp(v[0])} ${clamp(v[1])} ${clamp(v[2])}`;

/** Быстрая «воспринимаемая» яркость — для выбора направления правки цвета. */
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

function toLinear(channel: number) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Относительная яркость по WCAG — по ней считаем настоящий контраст. */
function relLum([r, g, b]: number[]) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function ratio(a: number[], b: number[]) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * Тёмный или белый текст поверх акцентной заливки. Сравниваем реальные
 * коэффициенты контраста и берём строго лучший вариант: «на глаз» на средних
 * тонах (красный, сиреневый) легко получить белую надпись на светлом фоне.
 */
function contrastFor(accent: number[]): string {
  const background = relLum(accent);
  const withWhite = (1 + 0.05) / (background + 0.05);
  const withDark = (background + 0.05) / (relLum(rgb(DARK)) + 0.05);
  return withDark > withWhite ? DARK : WHITE;
}

/**
 * Доводит акцент до читаемого текстового цвета на заданной поверхности:
 * двигаем его от фона, пока контраст не станет ≥ min. Целимся чуть выше
 * порога (4.6 вместо 4.5): цвета округляются до 8 бит на канал, и итоговое
 * значение легко оказывается на 0.01 ниже порога.
 */
function textAccent(accent: number[], surface: number[], min = 4.6): number[] {
  if (ratio(accent, surface) >= min) return accent;
  const target = relLum(surface) < 0.5 ? rgb(WHITE) : [0, 0, 0];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const k = (lo + hi) / 2;
    if (ratio(mix(accent, target, k), surface) < min) lo = k;
    else hi = k;
  }
  return mix(accent, target, (lo + hi) / 2);
}

/**
 * Заливка accent для :hover: уводим цвет от текста, чтобы контраст только рос.
 * Совсем тёмный или совсем светлый акцент иначе не даёт заметного hover.
 */
function hoverFor(accent: number[], darkText: boolean): number[] {
  const [r, g, b] = accent;
  if (darkText) {
    if (lum(r, g, b) < 235) return accent.map((v) => v + (255 - v) * 0.25);
    return accent.map((v) => v * 0.9);
  }
  if (lum(r, g, b) < 45) return accent.map((v) => v + (255 - v) * 0.22);
  return accent.map((v) => v * 0.86);
}

/**
 * Загоняет цвет в диапазон ОТНОСИТЕЛЬНОЙ яркости (WCAG). У голубых и зелёных
 * тонов при одинаковой воспринимаемой яркости WCAG-яркость выше, поэтому
 * границы заданы по ней: 1.05 / (0.175 + 0.05) ≈ 4.67:1 для белого текста.
 */
function fitToLuminance(color: number[], min: number, max: number): number[] {
  const current = relLum(color);
  if (current >= min && current <= max) return color;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const k = (lo + hi) / 2;
    const value = current > max ? color.map((v) => v * k) : mix(color, [255, 255, 255], k);
    const l = relLum(value);
    if (current > max ? l > max : l < min) {
      if (current > max) hi = k;
      else lo = k;
    } else if (current > max) {
      lo = k;
    } else {
      hi = k;
    }
  }
  const k = (lo + hi) / 2;
  return current > max ? color.map((v) => v * k) : mix(color, [255, 255, 255], k);
}

interface Preset {
  label: string;
  mode: "dark" | "light";
  colors: BaseColors;
}

export const PRESETS: Record<string, Preset> = {
  violet: {
    label: "Фиолетовая",
    mode: "dark",
    colors: {
      app: "9 9 12",
      inset: "12 12 16",
      surface: "17 17 21",
      surface2: "23 23 28",
      surface3: "29 29 35",
      line: "255 255 255",
      ink: "245 245 247",
      accent: "240 240 242",
    },
  },
  graphite: {
    label: "Графит",
    mode: "dark",
    colors: {
      app: "11 11 13",
      inset: "15 15 17",
      surface: "20 20 23",
      surface2: "26 26 30",
      surface3: "32 32 37",
      line: "255 255 255",
      ink: "243 243 245",
      accent: "240 240 242",
    },
  },
  black: {
    label: "Чёрная",
    mode: "dark",
    colors: {
      app: "0 0 0",
      inset: "6 6 7",
      surface: "12 12 13",
      surface2: "18 18 20",
      surface3: "24 24 27",
      line: "255 255 255",
      ink: "246 246 248",
      accent: "240 240 242",
    },
  },
  light: {
    label: "Светлая",
    mode: "light",
    colors: {
      app: "250 250 251",
      inset: "243 243 245",
      surface: "255 255 255",
      surface2: "255 255 255",
      surface3: "255 255 255",
      line: "10 10 14",
      ink: "12 12 16",
      // На белом фоне кнопка должна быть тёмной: белый акцент здесь не виден.
      accent: "24 24 28",
    },
  },
  /**
   * Дальше — темы галереи. Все собраны из тех же восьми токенов, поэтому
   * автоматически получают читаемый текст, тени и градиенты обложек.
   */
  amoled: {
    label: "AMOLED",
    mode: "dark",
    colors: {
      app: "0 0 0",
      inset: "0 0 0",
      surface: "4 4 5",
      surface2: "9 9 11",
      surface3: "15 15 18",
      line: "255 255 255",
      ink: "238 238 242",
      accent: "45 212 191",
    },
  },
  nord: {
    label: "Nord",
    mode: "dark",
    colors: {
      app: "46 52 64",
      inset: "56 63 78",
      surface: "65 74 92",
      surface2: "74 84 104",
      surface3: "86 97 118",
      line: "216 222 233",
      ink: "236 239 244",
      accent: "136 192 208",
    },
  },
  sky: {
    label: "Sky",
    mode: "light",
    colors: {
      app: "244 249 255",
      inset: "234 242 252",
      surface: "255 255 255",
      surface2: "255 255 255",
      surface3: "255 255 255",
      line: "12 36 62",
      ink: "10 30 54",
      accent: "2 132 199",
    },
  },
  mint: {
    label: "Mint",
    mode: "dark",
    colors: {
      app: "7 14 12",
      inset: "10 20 17",
      surface: "14 26 22",
      surface2: "20 34 29",
      surface3: "26 43 37",
      line: "255 255 255",
      ink: "238 246 243",
      accent: "52 199 123",
    },
  },
  ocean: {
    label: "Ocean",
    mode: "dark",
    colors: {
      app: "6 11 22",
      inset: "9 16 30",
      surface: "13 22 40",
      surface2: "18 30 52",
      surface3: "24 39 66",
      line: "255 255 255",
      ink: "236 242 252",
      accent: "56 132 255",
    },
  },
  crimson: {
    label: "Crimson",
    mode: "dark",
    colors: {
      app: "14 8 10",
      inset: "22 11 14",
      surface: "28 14 18",
      surface2: "37 19 24",
      surface3: "47 25 31",
      line: "255 255 255",
      ink: "250 240 242",
      accent: "225 29 72",
    },
  },
  sakura: {
    label: "Sakura",
    mode: "dark",
    colors: {
      app: "18 12 15",
      inset: "26 17 21",
      surface: "34 22 27",
      surface2: "44 29 35",
      surface3: "56 37 45",
      line: "255 255 255",
      ink: "252 242 245",
      accent: "244 114 182",
    },
  },
  sunset: {
    label: "Sunset",
    mode: "dark",
    colors: {
      app: "16 10 8",
      inset: "25 16 11",
      surface: "32 20 14",
      surface2: "42 27 19",
      surface3: "54 35 25",
      line: "255 255 255",
      ink: "252 242 235",
      accent: "251 146 60",
    },
  },
  /**
   * Светлое «стекло»: холодный лавандово-серый фон вместо чисто белого,
   * мягкий индиго-акцент. Поверхности чуть светлее фона — эффект матового
   * стекла, а не листа бумаги (как у обычной светлой темы).
   */
  frost: {
    label: "Frost",
    mode: "light",
    colors: {
      app: "238 240 247",
      inset: "229 232 242",
      surface: "245 246 251",
      surface2: "251 251 254",
      surface3: "255 255 255",
      line: "39 41 60",
      ink: "28 30 46",
      accent: "99 91 255",
    },
  },
};

/**
 * Приглушает цвет до заданного контраста с фоном. Подбираем долю подмешивания
 * фона делением отрезка: контраст монотонно падает при движении к фону.
 */
function dimToContrast(color: number[], background: number[], target: number): number[] {
  if (ratio(color, background) <= target) return color;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const k = (lo + hi) / 2;
    if (ratio(mix(color, background, k), background) > target) lo = k;
    else hi = k;
  }
  return mix(color, background, (lo + hi) / 2);
}

export function deriveTheme(base: BaseColors, mode: Preset["mode"]): ThemeColors {
  const accent = rgb(base.accent);
  const surface = rgb(base.surface);
  const app = rgb(base.app);
  const ink = rgb(base.ink);
  const onAccent = contrastFor(accent);
  const shadow = SHADOWS[mode];

  return {
    ...base,
    onAccent,
    accentText: fmt(textAccent(accent, surface)),
    accentHover: fmt(hoverFor(accent, onAccent === DARK)),
    muted: fmt(dimToContrast(ink, app, 5.2)),
    faint: fmt(dimToContrast(ink, app, 3.4)),
    coverA: fmt(fitToLuminance(accent, 0.03, 0.1)),
    coverB: fmt(fitToLuminance(mix(accent, [255, 255, 255], 0.35), 0.08, 0.175)),
    coverC: fmt(fitToLuminance(rgb(base.surface2), 0.02, 0.07)),
    coverInk: WHITE,
    shadowPanel: shadow.panel,
    shadowLift: shadow.lift,
  };
}

const STORAGE_KEY = "music_hub_theme";
const DEFAULT_PRESET = "violet";

function applyToDocument(colors: ThemeColors, mode: Preset["mode"], density: Density) {
  const root = document.documentElement;
  const style = root.style;
  style.setProperty("--color-app", colors.app);
  style.setProperty("--color-inset", colors.inset);
  style.setProperty("--color-surface", colors.surface);
  style.setProperty("--color-surface-2", colors.surface2);
  style.setProperty("--color-surface-3", colors.surface3);
  style.setProperty("--color-line", colors.line);
  style.setProperty("--color-ink", colors.ink);
  style.setProperty("--color-accent", colors.accent);
  style.setProperty("--color-on-accent", colors.onAccent);
  style.setProperty("--color-accent-text", colors.accentText);
  style.setProperty("--color-accent-hover", colors.accentHover);
  style.setProperty("--color-muted", colors.muted);
  style.setProperty("--color-faint", colors.faint);
  style.setProperty("--color-cover-a", colors.coverA);
  style.setProperty("--color-cover-b", colors.coverB);
  style.setProperty("--color-cover-c", colors.coverC);
  style.setProperty("--color-cover-ink", colors.coverInk);
  style.setProperty("--shadow-panel", colors.shadowPanel);
  style.setProperty("--shadow-lift", colors.shadowLift);
  root.dataset.mode = mode;
  root.dataset.density = density;
  style.colorScheme = mode;
}

function pickBase(colors: BaseColors): BaseColors {
  const out = {} as BaseColors;
  for (const key of BASE_KEYS) out[key] = colors[key];
  return out;
}

/** Старые сохранения (bg/surfaceAlt/overlay) переводим в новые токены. */
const LEGACY_MAP: Record<string, keyof BaseColors> = {
  bg: "app",
  inset: "inset",
  surface: "surface",
  surfaceAlt: "surface2",
  overlay: "line",
  ink: "ink",
  accent: "accent",
};

/**
 * Акцент, одинаковый раньше во всех пресетах. Он не проходит AA (максимум
 * 4.38:1 с любым текстом), поэтому в старых сохранениях подменяем его на
 * актуальный пресетный. Если пользователь выбрал свой цвет — оставляем его.
 */
/** Прежний акцент: фиолетовый. У сохранённых тем меняем его на белый. */
const LEGACY_PRESET_ACCENT = "124 92 252";
const OLD_VIOLET_ACCENTS = ["124 92 252", "109 74 238", "110 84 245"];

function readBase(raw: unknown, fallback: BaseColors): BaseColors {
  if (!raw || typeof raw !== "object") return fallback;
  const source = raw as Record<string, unknown>;
  const out = { ...fallback };
  // Новый формат
  for (const key of BASE_KEYS) {
    const value = source[key];
    if (typeof value === "string" && RGB_RE.test(value.trim())) out[key] = value.trim();
  }
  // Старый формат: часть ключей называется иначе
  for (const [legacy, key] of Object.entries(LEGACY_MAP)) {
    const value = source[legacy];
    if (key !== legacy && typeof value === "string" && RGB_RE.test(value.trim())) out[key] = value.trim();
  }
  // Старый пресетный фиолетовый (и в сохранениях нового формата) меняем на
  // актуальный: это то же самое, но проходящее AA. Свой выбор цвета не трогаем.
  if (OLD_VIOLET_ACCENTS.includes(out.accent) && !OLD_VIOLET_ACCENTS.includes(fallback.accent)) {
    out.accent = fallback.accent;
  }
  return out;
}

function loadInitial(): {
  presetId: string;
  mode: Preset["mode"];
  colors: ThemeColors;
  density: Density;
  accentFromCover: boolean;
  /** Последний акцент обложки: переживает перезагрузку WebView. */
  coverAccent: string | null;
  /** Обложка, с которой этот акцент снят. */
  coverAccentCover: string | null;
} {
  const fallback = PRESETS[DEFAULT_PRESET];
  /*
   * Настройка «акцент из обложки» живёт в settingsStore (её видно в
   * «Интерфейс → Вид»), но применяется здесь. Старый ключ темы читаем как
   * запасной: у тех, кто успел включить режим раньше, выбор не потеряется.
   */
  const savedSetting = useSettingsStore.getState().accentFromCover;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        presetId?: unknown;
        colors?: unknown;
        density?: unknown;
        accentFromCover?: unknown;
        coverAccent?: unknown;
        coverAccentCover?: unknown;
      };
      const presetId =
        typeof parsed?.presetId === "string" && PRESETS[parsed.presetId] ? parsed.presetId : DEFAULT_PRESET;
      const preset = PRESETS[presetId];
      const density: Density =
        parsed?.density === "compact" || parsed?.density === "airy" || parsed?.density === "cozy"
          ? parsed.density
          : "cozy";
      const base = readBase(parsed?.colors, preset.colors);
      const accentFromCover =
        typeof parsed?.accentFromCover === "boolean" ? parsed.accentFromCover : savedSetting;
      /*
       * Акцент обложки храним рядом с темой: перезагрузка WebView (ресайз,
       * разворот окна) пересоздаёт модуль и убила бы вычисленный цвет. Пара
       * «цвет + обложка» позволяет вернуть акцент сразу, ещё до чтения canvas,
       * и не показать чужой цвет от предыдущего трека.
       */
      const coverAccent =
        typeof parsed?.coverAccent === "string" && RGB_RE.test(parsed.coverAccent.trim())
          ? parsed.coverAccent.trim()
          : null;
      const coverAccentCover =
        typeof parsed?.coverAccentCover === "string" && parsed.coverAccentCover
          ? parsed.coverAccentCover
          : null;
      return {
        presetId,
        mode: preset.mode,
        colors: deriveTheme(base, preset.mode),
        density,
        accentFromCover,
        coverAccent: accentFromCover && coverAccentCover ? coverAccent : null,
        coverAccentCover: accentFromCover && coverAccentCover ? coverAccentCover : null,
      };
    }
  } catch {
    // повреждённое значение — используем дефолт
  }
  return {
    presetId: DEFAULT_PRESET,
    mode: fallback.mode,
    colors: deriveTheme(fallback.colors, fallback.mode),
    density: "cozy",
    accentFromCover: savedSetting,
    coverAccent: null,
    coverAccentCover: null,
  };
}

interface ThemeState {
  presetId: string;
  mode: Preset["mode"];
  colors: ThemeColors;
  density: Density;
  /** Акцент интерфейса берётся из обложки текущего трека, а не из пресета. */
  accentFromCover: boolean;
  /** Доминирующий цвет последней обложки (rgb-триплет) или null. */
  coverAccent: string | null;
  /** Обложка, с которой снят coverAccent: акцент не должен «переезжать» на другой трек. */
  coverAccentCover: string | null;
  setPreset: (id: string) => void;
  setAccentRgb: (r: number, g: number, b: number) => void;
  setDensity: (density: Density) => void;
  setAccentFromCover: (value: boolean) => void;
  /**
   * Готовый акцент обложки: применяется к документу, если включён режим
   * «акцент из обложки». null — обложки нет, значит работает тема.
   */
  applyCoverAccent: (accent: string | null) => void;
}

const initial = loadInitial();

type Painted = Pick<ThemeState, "colors" | "mode" | "density" | "accentFromCover" | "coverAccent">;

/**
 * Что рисовать в документе: тему или тему с акцентом, снятым с обложки.
 * Возвращает уже производные цвета — их и пишем в CSS-переменные.
 *
 * Акцент обложки здесь не «поверх» темы, а её часть: базовые токены берутся у
 * текущей темы, акцент подменяется. Поэтому смена пресета пересчитывает
 * контраст под акцент обложки, но не сбрасывает его.
 */
function painted(state: Painted): ThemeColors {
  const accent = state.accentFromCover ? state.coverAccent : null;
  if (!accent) return state.colors;
  return deriveTheme({ ...pickBase(state.colors), accent }, state.mode);
}

// Первый кадр — сразу с восстановленным акцентом обложки, без мигания темой
applyToDocument(painted(initial), initial.mode, initial.density);

/**
 * Единственное место, где состояние темы попадает в документ. Все изменения
 * (пресет, плотность, акцент, ресайз) идут через него, поэтому акцент обложки
 * физически не может быть затёрт повторным применением темы.
 */
function syncDocument() {
  const state = useThemeStore.getState();
  applyToDocument(painted(state), state.mode, state.density);
}

/** Сохранение: базовые токены + акцент обложки, чтобы он пережил перезагрузку. */
function persistState() {
  const state = useThemeStore.getState();
  // Пишем только базовые токены: производные всегда пересчитываются из них.
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      presetId: state.presetId,
      colors: pickBase(state.colors),
      density: state.density,
      accentFromCover: state.accentFromCover,
      coverAccent: state.coverAccent,
      coverAccentCover: state.coverAccentCover,
    })
  );
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  presetId: initial.presetId,
  mode: initial.mode,
  colors: initial.colors,
  density: initial.density,
  accentFromCover: initial.accentFromCover,
  coverAccent: initial.coverAccent,
  coverAccentCover: initial.coverAccentCover,

  setPreset: (id) => {
    const preset = PRESETS[id];
    if (!preset) return;
    // Базовые токены новой темы. Акцент обложки (если включён) остаётся:
    // painted() подмешает его к новой теме и пересчитает контраст под неё.
    set({
      presetId: id,
      mode: preset.mode,
      colors: deriveTheme(preset.colors, preset.mode),
    });
    persistState();
    syncDocument();
  },

  // Детальная RGB-настройка акцента — поверх выбранного пресета,
  // не трогая фон и поверхности. Свой цвет главнее обложки: режим
  // «акцент из обложки» выключается, иначе ползунки бы ничего не делали.
  setAccentRgb: (r, g, b) => {
    const current = get();
    const base: BaseColors = {
      ...pickBase(current.colors),
      accent: `${clamp(r)} ${clamp(g)} ${clamp(b)}`,
    };
    set({
      colors: deriveTheme(base, current.mode),
      accentFromCover: false,
      coverAccent: null,
      coverAccentCover: null,
    });
    // Настройка живёт в settingsStore: зеркалим выключение, чтобы галочка в
    // настройках не осталась включённой при выбранном вручную цвете.
    useSettingsStore.getState().setAccentFromCover(false);
    persistState();
    syncDocument();
  },

  setDensity: (density) => {
    set({ density });
    persistState();
    syncDocument();
  },

  setAccentFromCover: (value) => {
    // Настройка хранится в settingsStore, режим применяет тема: пишем в оба
    // места, чтобы галочка в «Интерфейс → Вид» и реальный акцент не разошлись.
    useSettingsStore.getState().setAccentFromCover(value);
    if (!value) {
      // Выключили — сразу возвращаем акцент темы
      set({ accentFromCover: false, coverAccent: null, coverAccentCover: null });
      persistState();
      syncDocument();
      return;
    }
    const cover = currentCover();
    // Цвет этой обложки уже посчитан — применяем синхронно, без мигания темой
    const cached = cover ? coverAccentCache.get(cover) ?? null : null;
    set({
      accentFromCover: true,
      coverAccent: cached,
      coverAccentCover: cached ? cover : null,
    });
    persistState();
    syncDocument();
    if (!cover) return;
    void accentForCover(cover).then((accent) => {
      if (!useThemeStore.getState().accentFromCover) return;
      if (currentCover() !== cover) return;
      applyAccentOverride(accent, cover);
    });
  },

  applyCoverAccent: (accent) => {
    applyAccentOverride(accent, currentCover());
  },
}));

/**
 * Применяет акцент обложки отдельно от темы: базовые токены не меняются,
 * пересчитываются только акцент и его производные. Повторное применение темы
 * (пресет, плотность, ресайз) уважает оверрайд — см. painted().
 */
export function applyAccentOverride(accent: string | null, cover: string | null = currentCover()) {
  const state = useThemeStore.getState();
  // Режим выключен — акцент обложки не имеет права вернуться сам
  if (!state.accentFromCover) return;
  const normalized = accent && RGB_RE.test(accent) ? accent : null;
  useThemeStore.setState({
    coverAccent: normalized,
    coverAccentCover: normalized ? cover : null,
  });
  persistState();
  syncDocument();
}

/** Снимает оверрайд: интерфейс возвращается к акценту темы. */
export function clearAccentOverride() {
  useThemeStore.setState({ coverAccent: null, coverAccentCover: null });
  persistState();
  syncDocument();
}

/*
 * Акцент не должен зависеть от размера окна. Обработчика resize, который
 * переписывал бы тему, в приложении нет, но перерисовка/перезагрузка WebView
 * при развороте способна потерять инлайновые CSS-переменные на :root (модуль
 * темы пересоздаётся и читает сохранение). Поэтому после каждого ресайза один
 * раз возвращаем актуальное состояние — с акцентом обложки, если он включён.
 */
if (typeof window !== "undefined") {
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      syncDocument();
    });
  });
}

/* ─────────────── Акцент из обложки трека ─────────────── */

/** Обложка текущего трека: ссылка на картинку или null. */
function currentCover(): string | null {
  const state = usePlayerStore.getState();
  return state.queue[state.index]?.cover?.trim() || null;
}

/** Загрузка картинки обложки: удалённые требуют crossOrigin, иначе canvas «грязный». */
function loadCoverImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (!src.startsWith("data:")) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("обложка не открылась"));
    image.src = src;
  });
}

/**
 * Доминирующий цвет обложки. Пиксели уменьшенной копии взвешиваются по
 * насыщенности: серый фон, чёрные поля и белые блики в акцент не попадают,
 * иначе интерфейс стал бы серым. Итог доводится до диапазона яркости, в
 * котором производные токены (текст на акценте, тени) читаемы.
 */
async function extractCoverAccent(src: string): Promise<string | null> {
  try {
    const image = await loadCoverImage(src);
    // 24×24 достаточно для среднего цвета и стоит копейки по времени
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);

    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const pr = data[i];
      const pg = data[i + 1];
      const pb = data[i + 2];
      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const luma = (0.299 * pr + 0.587 * pg + 0.114 * pb) / 255;
      if (saturation < 0.18 || luma < 0.08 || luma > 0.94) continue;
      // Середина по яркости — самый «цветной» пиксель; края дают грязь
      const w = saturation * saturation * (1 - Math.abs(luma - 0.5) * 0.6);
      r += pr * w;
      g += pg * w;
      b += pb * w;
      weight += w;
    }
    if (weight <= 0) return null;
    const average = [r / weight, g / weight, b / weight];
    return fmt(fitToLuminance(average, 0.09, 0.28));
  } catch {
    // Нет CORS на CDN, битая ссылка или canvas недоступен — акцент остаётся темой
    return null;
  }
}

/**
 * Кэш посчитанных акцентов на сессию: ключ — ссылка на обложку. Один и тот же
 * трек не должен заново читать картинку и перебирать пиксели. Неудача тоже
 * запоминается (null): битую ссылку или CDN без CORS незачем пробовать снова
 * при каждом включении. Размер ограничен — обложки дата-URL бывают крупными.
 */
const coverAccentCache = new Map<string, string | null>();
const COVER_CACHE_LIMIT = 120;

async function accentForCover(src: string): Promise<string | null> {
  if (coverAccentCache.has(src)) return coverAccentCache.get(src) ?? null;
  const accent = await extractCoverAccent(src);
  if (coverAccentCache.size >= COVER_CACHE_LIMIT) coverAccentCache.clear();
  coverAccentCache.set(src, accent);
  return accent;
}

/** Обложка текущего трека на момент запуска приложения. */
const initialCover = currentCover();

/**
 * Обложка, для которой уже посчитан акцент. undefined — «ещё не смотрели»:
 * очередь плеера восстанавливается позже (AudioEngine), и первый же сигнал
 * стора должен пересчитать акцент, даже если обложки нет вовсе.
 */
let observedCover: string | null | undefined = undefined;

// Обложка уже стоит в очереди при запуске (плеер восстановил её из сохранения):
// подписка сработает только на смену трека, поэтому первый акцент берём здесь.
if (initialCover && useThemeStore.getState().accentFromCover) {
  observedCover = initialCover;
  void accentForCover(initialCover).then((accent) => {
    if (!useThemeStore.getState().accentFromCover) return;
    if (currentCover() !== initialCover) return;
    applyAccentOverride(accent, initialCover);
  });
}

// Обложка меняется вместе с треком — подписка держит акцент в актуальном
// состоянии, пока приложение открыто. Сравнение по строке обложки: событий
// плеера много (позиция трека), а тяжёлая работа должна идти только на смену.
usePlayerStore.subscribe((state) => {
  const cover = state.queue[state.index]?.cover?.trim() || null;
  if (cover === observedCover) return;
  observedCover = cover;
  const theme = useThemeStore.getState();
  if (!theme.accentFromCover) return;
  if (!cover) {
    // Обложки нет — фолбэк на акцент темы, а не на цвет прошлого трека
    applyAccentOverride(null, null);
    return;
  }
  // Акцент этой обложки уже применён (например, восстановлен из сохранения)
  if (theme.coverAccent && theme.coverAccentCover === cover) return;
  void accentForCover(cover).then((accent) => {
    if (!useThemeStore.getState().accentFromCover) return;
    // Пока картинка читалась, трек мог смениться: чужой акцент не применяем
    if (currentCover() !== cover) return;
    applyAccentOverride(accent, cover);
  });
});
