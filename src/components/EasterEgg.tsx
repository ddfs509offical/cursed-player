import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { useThemeStore } from "../store/themeStore";
import {
  ACCENT_SLOT,
  ACCENT_TOLERANCE,
  LAYER_EVENTS,
  OPEN_MILESTONES,
  RANDOM_SLOTS,
  STORAGE_KEYS,
  accentSignature,
  accentTriplet,
  decodeSlot,
  pushTriggerChar,
} from "../lib/eggObf";

/**
 * Тихий секрет владельца: три слоя, каждый следующий открывается только после
 * предыдущего.
 *
 * 1. Ключевое слово-триггер в любом месте интерфейса (кроме полей ввода).
 *    После совпадения в правом верхнем углу живёт крошечная тусклая звезда.
 * 2. Три клика по звезде — она разгорается, рядом проступает созвездие из
 *    четырёх точек. После перезапуска прогресс не сбрасывается.
 * 3. Клик по самой яркой звезде открывает маленькое стеклянное окно: рисунок
 *    созвездия, пульсирующее сердце и одна фраза. Счётчик открытий даёт две
 *    особые фразы — на десятом и двадцать пятом.
 *
 * Второй вход — по цвету: если актуальный акцент интерфейса совпадает с
 * «магическим», слово набирать не нужно — через несколько секунд звезда
 * появляется сама. В этом же цвете окно говорит особую фразу, а созвездие и
 * сердце рисуются акцентом.
 *
 * Управление: повторный набор слова прячет и снова показывает звезду, пока
 * созвездие не открыто (прогресс кликов при этом цел). Удержание звезды 1,2 с
 * сбрасывает секрет полностью. Те же два действия доступны из настроек
 * (раздел «О приложении → В разработке») через события window.
 *
 * Секрет не должен себя выдавать: никаких подсказок, title-атрибутов, записей
 * в журнал и сети. Прогресс лежит только в localStorage. Слово-триггер, тексты
 * и цвет в бандле отсутствуют: всё приходит из кодированного src/lib/eggObf.ts.
 */

/** Простой, после которого набранное забывается. */
const IDLE_MS = 3000;

/** «Магический» акцент — второй вход. Собирается из упакованного целого. */
const MAGIC_ACCENT = accentTriplet();
/** Сколько акцент должен продержаться, прежде чем звезда появится сама. */
const MAGIC_DELAY_MS = 4000;
/** Уход звезды: совпадает с transition-opacity у её контейнера. */
const MAGIC_FADE_MS = 500;

/** Сколько звезда держится, прежде чем секрет сбросится полностью. */
const HOLD_MS = 1200;
/** Насколько звезда увеличивается, пока её держат. */
const HOLD_SCALE = 1.3;
/** Клик сразу после удержания — «хвост» pointerup, а не обычный клик. */
const HOLD_CLICK_GUARD_MS = 600;

/** Четыре точки созвездия в углу: первая — самая яркая, по ней и кликают. */
const CORNER_POINTS = [
  { x: 92, y: 12 },
  { x: 68, y: 30 },
  { x: 42, y: 20 },
  { x: 54, y: 58 },
];

/** То же созвездие в окне — крупнее, дугой вокруг сердца. */
const WINDOW_POINTS = [
  { x: 34, y: 72 },
  { x: 76, y: 26 },
  { x: 224, y: 26 },
  { x: 266, y: 72 },
];

const CORNER_PATH = "M92 12 L68 30 L42 20 M68 30 L54 58";
const WINDOW_PATH = "M34 72 L76 26 L224 26 L266 72";

function readCount(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function writeCount(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Хранилище недоступно — прогресс просто не переживёт перезапуск.
  }
}

/** Полный сброс: ключа быть не должно, а не «ноль» в нём. */
function removeCount(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Хранилище недоступно — удалять нечего.
  }
}

/**
 * Актуальный акцент интерфейса. Стор темы — единственный источник: в документ
 * попадает ровно то же значение, что выбирает painted(), то есть акцент
 * обложки, если режим «акцент из обложки» включён, иначе акцент темы.
 * setAccentRgb пишет прямо в colors.accent, поэтому его цвет виден здесь сразу.
 */
function currentAccent(): [number, number, number] | null {
  const state = useThemeStore.getState();
  const raw = state.accentFromCover && state.coverAccent ? state.coverAccent : state.colors.accent;
  return parseRgbTriplet(raw);
}

/** Разбирает строку вида "r g b" или "rgb(r g b)" в триплет; иначе null. */
function parseRgbTriplet(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  const parts = value.match(/\d{1,3}/g);
  if (!parts || parts.length < 3) return null;
  const channels = parts.slice(0, 3).map(Number);
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null;
  return [channels[0], channels[1], channels[2]];
}

/** Совпадение с MAGIC_ACCENT по каждой компоненте с допуском. */
function isMagicAccent(accent: [number, number, number] | null): boolean {
  if (!accent) return false;
  return accent.every((channel, index) => Math.abs(channel - MAGIC_ACCENT[index]) <= ACCENT_TOLERANCE);
}

/**
 * Проверка «клавиши идут в текст»: активный элемент и цель события. Одного
 * activeElement мало — в момент keydown цель уже может быть вложена в
 * contenteditable, а фокус ещё числиться на поле.
 */
function isTextEntry(target: EventTarget | null): boolean {
  const nodes: (HTMLElement | null)[] = [
    target instanceof HTMLElement ? target : null,
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  ];
  return nodes.some((node) => {
    if (!node) return false;
    const tag = node.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return node.isContentEditable || node.closest('[contenteditable="true"]') !== null;
  });
}

export default function EasterEgg() {
  const [seen, setSeen] = useState(() => readCount(STORAGE_KEYS.seen) > 0);
  const [clicks, setClicks] = useState(() => Math.min(3, readCount(STORAGE_KEYS.clicks)));
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  /** Окно уже открывалось — второй вход по цвету больше не нужен. */
  const [found, setFound] = useState(() => readCount(STORAGE_KEYS.opens) > 0);
  /** Акцент сейчас «магический»: от этого зависят фраза и цвет рисунка. */
  const [magicActive, setMagicActive] = useState(() => isMagicAccent(currentAccent()));
  /** Звезда от второго входа и её плавное исчезновение. */
  const [magicStar, setMagicStar] = useState(false);
  const [magicHiding, setMagicHiding] = useState(false);
  /** Звезда скрыта словом или из настроек: прогресс кликов при этом цел. */
  const [hidden, setHidden] = useState(false);
  /** Идёт плавное скрытие: opacity 500 мс, затем unmount. */
  const [hiding, setHiding] = useState(false);
  /** Звезду держат: она чуть увеличивается до срабатывания сброса. */
  const [holding, setHolding] = useState(false);
  /** Меняется при полном сбросе: заново запускает второй вход по цвету. */
  const [resetToken, setResetToken] = useState(0);

  /** Хвост набранных символов и таймер простоя буфера. */
  const typed = useRef<string[]>([]);
  const idleTimer = useRef<number | null>(null);
  /** Предыдущая обычная фраза: одну и ту же два раза подряд не показываем. */
  const lastPhrase = useRef(-1);

  /*
   * Зеркало состояния для подписки на тему: обработчик создаётся один раз и
   * обязан видеть свежие значения, не пересоздавая подписку.
   */
  const seenRef = useRef(seen);
  const foundRef = useRef(found);
  const starRef = useRef(magicStar);
  const clicksRef = useRef(clicks);
  const hiddenRef = useRef(hidden);
  const hidingRef = useRef(hiding);
  /** Таймер плавного скрытия и таймер удержания. */
  const fadeTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  /** Момент срабатывания удержания: клик сразу после него не считается. */
  const holdAt = useRef(0);
  /** После полного сброса второй вход молчит до следующей смены акцента. */
  const suppressMagic = useRef(false);
  useEffect(() => {
    seenRef.current = seen;
    foundRef.current = found;
    starRef.current = magicStar;
    clicksRef.current = clicks;
    hiddenRef.current = hidden;
    hidingRef.current = hiding;
  }, [seen, found, magicStar, clicks, hidden, hiding]);

  const clearFadeTimer = useCallback(() => {
    if (fadeTimer.current !== null) {
      window.clearTimeout(fadeTimer.current);
      fadeTimer.current = null;
    }
  }, []);

  /** Вернуть звезду: отменяет и плавное скрытие, и флаг «скрыта». */
  const showStar = useCallback(() => {
    clearFadeTimer();
    hiddenRef.current = false;
    hidingRef.current = false;
    setHidden(false);
    setHiding(false);
  }, [clearFadeTimer]);

  /** Плавно убрать звезду, не трогая прогресс кликов. */
  const fadeOutStar = useCallback(() => {
    clearFadeTimer();
    hiddenRef.current = false;
    hidingRef.current = true;
    setHiding(true);
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = null;
      hiddenRef.current = true;
      hidingRef.current = false;
      setHidden(true);
      setHiding(false);
    }, MAGIC_FADE_MS);
  }, [clearFadeTimer]);

  /** Полный сброс: все три ключа, окно, созвездие, локальное состояние. */
  const resetEgg = useCallback(() => {
    clearFadeTimer();
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    setHolding(false);

    removeCount(STORAGE_KEYS.seen);
    removeCount(STORAGE_KEYS.clicks);
    removeCount(STORAGE_KEYS.opens);

    seenRef.current = false;
    clicksRef.current = 0;
    foundRef.current = false;
    hiddenRef.current = false;
    hidingRef.current = false;
    starRef.current = false;

    setSeen(false);
    setClicks(0);
    setFound(false);
    setHidden(false);
    setHiding(false);
    setOpen(false);
    setPhrase("");
    setMagicStar(false);
    setMagicHiding(false);

    typed.current = [];
    lastPhrase.current = -1;
    // Пока акцент не сменится, второй вход не должен возвращать звезду сам.
    suppressMagic.current = true;
    // Второй вход по цвету запускается заново, как при первом старте.
    setResetToken((token) => token + 1);
  }, [clearFadeTimer]);

  // Слой 1: слово. Esc и сочетания с Ctrl/Alt/Meta не трогаем совсем —
  // остальная логика приложения (закрытие разделов, горячие клавиши) цела.
  useEffect(() => {
    const clearIdle = () => {
      if (idleTimer.current !== null) {
        window.clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
    };

    const armIdle = () => {
      clearIdle();
      idleTimer.current = window.setTimeout(() => {
        idleTimer.current = null;
        typed.current = [];
      }, IDLE_MS);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      if (event.key === "Escape") return;
      if (isTextEntry(event.target)) return;

      if (event.key.length !== 1) {
        typed.current = [];
        clearIdle();
        return;
      }

      /*
       * Буфер держит только хвост длиной со слово-ключ. Сравнение идёт по
       * FNV-1a 64 от нормализованного хвоста: самого слова в коде нет, а
       * поведение то же — символы назад не откатываются, неверный символ
       * просто сдвигает окно на единицу.
       */
      const buffer = typed.current;
      const matched = pushTriggerChar(buffer, event.key);
      armIdle();
      if (!matched) return;

      buffer.length = 0;
      clearIdle();

      const wasSeen = seenRef.current;
      seenRef.current = true;
      setSeen(true);
      writeCount(STORAGE_KEYS.seen, 1);

      // Первое нахождение: слово просто показывает звезду.
      if (!wasSeen) {
        showStar();
        return;
      }
      // Звезда скрыта прошлым вводом или из настроек — ввод возвращает её.
      if (hiddenRef.current || hidingRef.current) {
        showStar();
        return;
      }
      // Созвездие открыто: звезда часть найденного, ввод её не прячет.
      if (clicksRef.current >= 3) return;
      /*
       * Иначе слово — переключатель: повторный ввод плавно убирает звезду.
       * Прогресс кликов остаётся и в localStorage, и в состоянии.
       */
      fadeOutStar();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      clearIdle();
    };
  }, [fadeOutStar, showStar]);

  /*
   * Слой 1б: второй вход по цвету. Подписка на стор темы вместо таймера —
   * любое изменение акцента (пресет, ползунки, «акцент из обложки») приходит
   * сюда сразу, сравнение стоит одно чтение строки. Если секрет уже найден
   * или слово набрано, вход молчит; акцент при этом продолжает отслеживаться,
   * потому что от него зависит фраза и цвет рисунка в окне.
   */
  useEffect(() => {
    let showTimer: number | null = null;
    let hideTimer: number | null = null;

    const clearShow = () => {
      if (showTimer !== null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
    };
    const clearHide = () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const evaluate = () => {
      const magic = isMagicAccent(currentAccent());
      setMagicActive(magic);
      // Акцент сменился — второй вход снова разрешён после полного сброса.
      if (!magic) suppressMagic.current = false;

      // Слово уже набрано или окно уже открывали — второй вход не показываем.
      if (seenRef.current || foundRef.current) {
        clearShow();
        return;
      }

      if (magic) {
        clearHide();
        setMagicHiding(false);
        // Сброс только что убрал звезду: сами её не возвращаем.
        if (suppressMagic.current) {
          clearShow();
          return;
        }
        if (!starRef.current && showTimer === null) {
          showTimer = window.setTimeout(() => {
            showTimer = null;
            // Пока ждали, цвет мог уйти: тогда звезда не нужна.
            if (!isMagicAccent(currentAccent())) return;
            if (seenRef.current || foundRef.current) return;
            starRef.current = true;
            setMagicStar(true);
          }, MAGIC_DELAY_MS);
        }
        return;
      }

      /*
       * Цвет ушёл. Звезду, которую уже «активировали» тремя кликами, не
       * трогаем; прогресс кликов не сбрасывается ни в каком случае — он
       * просто перестаёт быть видимым.
       */
      clearShow();
      if (starRef.current && clicksRef.current < 3) {
        setMagicHiding(true);
        clearHide();
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          starRef.current = false;
          setMagicStar(false);
          setMagicHiding(false);
        }, MAGIC_FADE_MS);
      }
    };

    evaluate();
    const unsubscribe = useThemeStore.subscribe(evaluate);
    return () => {
      unsubscribe();
      clearShow();
      clearHide();
    };
    // resetToken: после полного сброса второй вход запускается заново.
  }, [resetToken]);

  /*
   * Канал из настроек: компонент смонтирован в App и живёт отдельно от
   * страницы, поэтому действия приходят событиями window. Обработчики
   * стабильны (useCallback), подписка не пересоздаётся.
   */
  useEffect(() => {
    const onHide = () => fadeOutStar();
    const onReset = () => resetEgg();
    window.addEventListener(LAYER_EVENTS.hide, onHide);
    window.addEventListener(LAYER_EVENTS.reset, onReset);
    return () => {
      window.removeEventListener(LAYER_EVENTS.hide, onHide);
      window.removeEventListener(LAYER_EVENTS.reset, onReset);
    };
  }, [fadeOutStar, resetEgg]);

  // Размонтирование: таймеры скрытия и удержания не должны пережить компонент.
  useEffect(
    () => () => {
      clearFadeTimer();
      if (holdTimer.current !== null) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
    },
    [clearFadeTimer]
  );

  // Слой 3: Esc закрывает только окно. Перехват — лишь пока окно открыто,
  // и только на capture: остальные Esc-обработчики приложения не срабатывают.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  function openWindow() {
    const count = readCount(STORAGE_KEYS.opens) + 1;
    writeCount(STORAGE_KEYS.opens, count);
    setFound(true);

    // Текст слота расшифровывается только здесь, в момент показа.
    let slot: number = OPEN_MILESTONES.tenth;
    if (count === 25) {
      slot = OPEN_MILESTONES.twentyFifth;
    } else if (count !== 10) {
      let index = Math.floor(Math.random() * RANDOM_SLOTS);
      if (RANDOM_SLOTS > 1 && index === lastPhrase.current) {
        index = (index + 1) % RANDOM_SLOTS;
      }
      lastPhrase.current = index;
      slot = index;
    }

    setPhrase(decodeSlot(slot));
    setOpen(true);
  }

  /**
   * Короткое нажатие и удержание различаются таймером: pointerdown запускает
   * 1,2 с, pointerup/pointerleave отменяют. Сработавшее удержание сбрасывает
   * секрет, а «хвостовой» клик после него поглощается по отметке времени.
   */
  function endHold() {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    setHolding(false);
  }

  function onStarPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    setHolding(true);
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      holdAt.current = Date.now();
      setHolding(false);
      resetEgg();
    }, HOLD_MS);
  }

  function onStarClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    // Удержание уже всё сбросило: клик, пришедший сразу после, не считается.
    if (holdAt.current !== 0 && Date.now() - holdAt.current < HOLD_CLICK_GUARD_MS) return;
    if (clicks < 3) {
      const next = clicks + 1;
      setClicks(next);
      writeCount(STORAGE_KEYS.clicks, next);
      return;
    }
    openWindow();
  }

  // До первого слоя в DOM нет ничего — ни пустой разметки, ни слушателей,
  // которые что-то рисуют. Звезда от второго входа живёт по тем же правилам.
  // Скрытая звезда (слово-переключатель, настройки) не рендерится вовсе.
  if (hidden || (!seen && !magicStar)) return null;

  /** Скрытие: своё у слова и настроек, магическое — у второго входа. */
  const fading = magicHiding || hiding;

  /** Яркость растёт с каждым кликом; на третьем звезда становится главной. */
  const starOpacity = fading ? 0 : clicks >= 3 ? 0.85 : 0.25 + clicks * 0.12;

  return (
    <>
      {/* Отступ считается от rem: при крупном масштабе интерфейса звёздочка
          остаётся под шапкой, а не поверх её кнопок */}
      <div
        style={{ top: "calc(6.5rem + 8px)" }}
        className="pointer-events-none fixed right-4 z-[60] select-none"
      >
        <div
          className="relative h-20 w-[110px] transition-opacity duration-500"
          style={{ opacity: fading ? 0 : 1 }}
        >
          {clicks >= 3 && (
            <motion.svg
              initial={{ opacity: 0.6 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.9, ease: "easeOut" }}
              viewBox="0 0 110 80"
              className="pointer-events-none absolute inset-0 h-20 w-[110px] overflow-visible text-faint"
              fill="none"
              aria-hidden="true"
            >
              <path
                d={CORNER_PATH}
                stroke="currentColor"
                strokeWidth="0.7"
                strokeLinecap="round"
                opacity="0.35"
              />
              {CORNER_POINTS.slice(1).map((point) => (
                <circle
                  key={`${point.x}-${point.y}`}
                  cx={point.x}
                  cy={point.y}
                  r="1.5"
                  fill="currentColor"
                  opacity="0.35"
                />
              ))}
            </motion.svg>
          )}

          <button
            type="button"
            tabIndex={-1}
            onClick={onStarClick}
            onPointerDown={onStarPointerDown}
            onPointerUp={endHold}
            onPointerLeave={endHold}
            onPointerCancel={endHold}
            style={{
              left: CORNER_POINTS[0].x,
              top: CORNER_POINTS[0].y,
              opacity: starOpacity,
              pointerEvents: fading ? "none" : undefined,
              /* Обычный клик — как раньше; удержание чуть увеличивает звезду. */
              transform: `translate(-50%, -50%) scale(${holding ? HOLD_SCALE : 1})`,
              transition: "transform 300ms ease-out, opacity 500ms",
            }}
            className="pointer-events-auto absolute flex h-4 w-4 cursor-default items-center justify-center border-0 bg-transparent p-0 text-faint"
          >
            <svg viewBox="0 0 24 24" className="h-[6px] w-[6px]" fill="currentColor" aria-hidden="true">
              <path d="M12 1.5c.6 5.2 3.8 8.4 9 9-5.2.6-8.4 3.8-9 9-.6-5.2-3.8-8.4-9-9 5.2-.6 8.4-3.8 9-9Z" />
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <motion.div
          initial={{ opacity: 0.94 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[75] flex items-center justify-center bg-app/45 p-6 backdrop-blur-[2px]"
        >
          <motion.div
            initial={{ opacity: 0.97, scale: 0.985, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            className="glass-float relative w-[360px] max-w-full select-none rounded-2xl border border-line/10 bg-surface3/85 px-5 pb-5 pt-6 backdrop-blur-[18px]"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Закрыть"
              className="absolute right-2.5 top-2.5 rounded-lg p-1.5 text-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
            >
              <X size={13} />
            </button>

            {/* Рисунок созвездия и сердце — в одном компоненте, без правок styles.css */}
            <style>{`
              @keyframes egg-constellation-draw {
                from { stroke-dashoffset: 1; }
                to { stroke-dashoffset: 0; }
              }
              .egg-constellation-path {
                stroke-dasharray: 1;
                stroke-dashoffset: 0;
                animation: egg-constellation-draw 2.6s cubic-bezier(0.4, 0, 0.2, 1) both;
              }
              @keyframes egg-heart-pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.08); }
              }
              .egg-heart {
                transform-origin: center;
                animation: egg-heart-pulse 2s ease-in-out infinite;
              }
            `}</style>

            {/*
              В «магическом» акценте созвездие и сердце рисуются самим цветом
              темы: берём ту же переменную, что и весь интерфейс, а не копию
              числа в разметке.
            */}
            <div
              className={magicActive ? "relative h-[120px] w-full" : "relative h-[120px] w-full text-faint"}
              style={magicActive ? { color: "rgb(var(--color-accent))" } : undefined}
            >
              <svg
                viewBox="0 0 300 120"
                className="absolute inset-0 h-full w-full"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d={WINDOW_PATH}
                  pathLength={1}
                  className="egg-constellation-path"
                  stroke="currentColor"
                  strokeWidth="0.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.55"
                />
                {WINDOW_POINTS.map((point, index) => (
                  <circle
                    key={`${point.x}-${point.y}`}
                    cx={point.x}
                    cy={point.y}
                    r={index === 0 || index === WINDOW_POINTS.length - 1 ? 2 : 1.6}
                    fill="currentColor"
                    opacity="0.5"
                  />
                ))}
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <svg
                  viewBox="0 0 24 24"
                  className={magicActive ? "egg-heart h-4 w-4" : "egg-heart h-4 w-4 text-accentText"}
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 20.4 3.9 12.3a5.4 5.4 0 0 1 7.6-7.6l.5.5.5-.5a5.4 5.4 0 0 1 7.6 7.6Z" />
                </svg>
              </div>
            </div>

            <p className="mt-1 px-1 text-center text-[13px] leading-relaxed text-ink/90">
              {magicActive ? decodeSlot(ACCENT_SLOT) : phrase}
            </p>
            {magicActive && (
              <p className="mt-2 px-1 text-center text-[10px] tracking-[0.3em] text-faint">
                {accentSignature()}
              </p>
            )}
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
