import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import anime from "animejs";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { LucideIcon } from "lucide-react";
import { motion } from "framer-motion";
import {
  X,
  Shuffle,
  SkipBack,
  SkipForward,
  Play,
  Pause,
  Repeat,
  Repeat1,
  ListMusic,
  Music2,
  Mic2,
  Volume1,
  Volume2,
  VolumeX,
  Globe,
  Loader2,
  RefreshCw,
  Waves,
} from "lucide-react";
import { usePlayerStore } from "../store/playerStore";
import { useRadioStore } from "../store/radioStore";
import { useSettingsStore } from "../store/settingsStore";
import { useLyricsStore, syncLyricsTrack, LYRICS_NOT_FOUND_TEXT } from "../store/lyricsStore";
import { findActiveLine, formatOffset, OFFSET_STEP_SEC } from "../services/lyrics";
import { formatDuration } from "../services/catalog";
import { sounds } from "../lib/sounds";
import { useAppIcon } from "../lib/appIcon";
import { useWallpaperSource } from "../store/wallpaperStore";
import { useExitGuard } from "../lib/useExitGuard";
import { Equalizer } from "./MiniPlayer";
import Cover from "./Cover";
// Фоновое фото плеера, если пользователь не выбрал обои: та самая картинка,
// что раньше стояла по умолчанию. Лежит в сборке, поэтому видна сразу.
import playerBackdrop from "../assets/player-backdrop.jpg";

import { serviceFromTrackId } from "../lib/services";
import { ArtistLink } from "./ArtistWindow";
import FavoriteButton from "./FavoriteButton";
import IconButton from "./IconButton";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Размеры панели текста: справа от обложки — по ширине, под плеером — по высоте. */
const PANEL_WIDTH = 560;
/** У самого порога `lg` панель уже: иначе плеер слева сжимается до неудобного. */
const PANEL_WIDTH_TIGHT = 440;
const PANEL_HEIGHT = 440;
const PANEL_HEIGHT_NARROW = 300;
/** Тот же порог, что у Tailwind `lg`: раскладка и анимация меняются вместе. */
const WIDE_QUERY = "(min-width: 1024px)";
/** Просторное окно: панели текста есть где развернуться под крупные строки. */
const ROOMY_QUERY = "(min-width: 1200px)";
/** Кривая входа — как у остальных появлений в приложении. */
const EASE: [number, number, number, number] = [0.2, 0, 0, 1];
/** Каскад строк: шаг и предел, чтобы длинный текст не расползался на секунды. */
const STAGGER_STEP = 0.02;
const STAGGER_LIMIT = 24;
/**
 * Колонка текста: строки переносятся, но не расползаются на всю ширину.
 * Верхняя граница — и 520 px, и ширина панели сразу: строка не может выйти
 * за подложку и не даёт горизонтального вылета.
 */
const TEXT_COLUMN = "mx-auto w-full max-w-[min(100%,520px)]";
/** Смена активной строки: цвет и прозрачность перетекают за 0.2 с. */
const LINE_TRANSITION = "transition duration-200 ease-out";
/** Сколько автопрокрутка молчит после того, как текст прокрутили руками. */
const RESUME_MS = 5000;
/** Пока идёт наша плавная прокрутка, её события скролла — не «ручные». */
const AUTO_SCROLL_MS = 1200;
/** Панель раскрывается за 0.25 с: её первые события скролла ручными не считаем. */
const OPEN_GRACE_MS = 400;
/**
 * Сдвиг указателя больше этого (px) между нажатием и отпусканием — это уже
 * протаскивание текста, а не клик по строке: такие клики игнорируем.
 */
const DRAG_SLOP_PX = 6;
/** Вспышка строки после перехода: коротко и заметно, что клик сработал. */
const FLASH_MS = 220;
/**
 * Сколько трек должен играть, прежде чем тихо искать текст заранее.
 * К этому моменту понятно, что трек слушают, а не пролистывают.
 */
const LYRICS_PRELOAD_MS = 5000;

/** Широкое окно: текст встаёт в один ряд с плеером, а не под ним. */
function useWideLayout(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches
  );

  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return wide;
}

/**
 * Ширина панели текста. На просторном окне — под крупные строки, у самого
 * порога `lg` — уже: иначе колонка плеера слева сжимается до неудобного.
 */
function useLyricsPanelWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(ROOMY_QUERY).matches
      ? PANEL_WIDTH
      : PANEL_WIDTH_TIGHT
  );

  useEffect(() => {
    const query = window.matchMedia(ROOMY_QUERY);
    const onChange = () => setWidth(query.matches ? PANEL_WIDTH : PANEL_WIDTH_TIGHT);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return width;
}

/** Верхняя панель плеера и отступы вокруг — столько высоты панели текста недоступно. */
const PANEL_CHROME = 120;

/** Высота панели: желаемую урезаем так, чтобы она помещалась в окно. */
function fitHeight(preferred: number): number {
  if (typeof window === "undefined") return preferred;
  return Math.max(180, Math.min(preferred, window.innerHeight - PANEL_CHROME));
}

/** Следит за высотой окна: на низком окне панель текста не должна вылезать. */
function usePanelHeight(preferred: number): number {
  const [height, setHeight] = useState(() => fitHeight(preferred));

  useEffect(() => {
    const onResize = () => setHeight(fitHeight(preferred));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [preferred]);

  return height;
}

/**
 * Кнопка «Текст» — пилюля верхней полосы плеера, в одном ряду с «Wave» и
 * «Очередью»: три второстепенные кнопки живут сверху, а не в ряду транспорта.
 */
function LyricsToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.94 }}
      aria-pressed={open}
      aria-label={open ? "Скрыть текст песни" : "Показать текст песни"}
      title={open ? "Скрыть текст" : "Текст песни"}
      className={`shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[12px] whitespace-nowrap transition-colors ${
        open
          ? "border-accent/40 bg-accent/15 text-accentText"
          : "border-transparent text-faint hover:text-ink hover:bg-ink/[0.06]"
      }`}
    >
      {/* Иконка мягко «включается» вместе с панелью */}
      <motion.span
        key={open ? "открыт" : "закрыт"}
        initial={{ scale: 0.7, rotate: -16 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 22 }}
        className="flex"
      >
        <Mic2 size={13} />
      </motion.span>
      Текст
    </motion.button>
  );
}

/** Длина дорожки громкости в поповере: по ней же считается ширина плашки. */
const VOLUME_TRACK_W = 120;

/**
 * Громкость в боковой колонке главного ряда: в ряду остаётся только иконка
 * динамика (32 px, приглушённая) — ползунок рядом с транспортом сдвигал кнопки
 * и уводил центр. По клику открывается стеклянный поповер с дорожкой в 120 px
 * и подписью «N%». Повторный клик по иконке при открытом поповере — выключить
 * звук и вернуть прежний уровень обратно.
 *
 * Значение берём из того же места, что мини-плеер и настройки
 * (playerStore.volume), и пишем в оба хранилища — второго источника правды нет.
 * Поповер закрывается кликом мимо и по Esc (в capture-фазе, чтобы то же
 * нажатие не дошло до обработчика плеера и не закрыло его целиком).
 */
function VolumeControl() {
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setPlayerVolume = useSettingsStore((s) => s.setPlayerVolume);
  /** Уровень до выключения звука: возвращаем именно его, а не «середину». */
  const beforeMute = useRef(0.8);
  /** Поповер с дорожкой: в ряду остаётся только иконка динамика. */
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const apply = useCallback(
    (value: number) => {
      const next = Math.min(1, Math.max(0, value));
      if (next > 0) beforeMute.current = next;
      setVolume(next);
      setPlayerVolume(next);
    },
    [setVolume, setPlayerVolume]
  );

  const muted = volume <= 0.001;
  const Icon = muted ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  const toggleMute = useCallback(() => {
    sounds.save();
    apply(muted ? (beforeMute.current > 0 ? beforeMute.current : 0.5) : 0);
  }, [apply, muted]);

  // Поповер закрывается кликом мимо и по Esc. Esc слушаем на фазе погружения:
  // иначе то же нажатие дошло бы до обработчика плеера и закрыло его целиком.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const slider = (
    <input
      type="range"
      min={0}
      max={1}
      step={0.01}
      value={volume}
      onChange={(event) => apply(Number(event.target.value))}
      onPointerUp={() => sounds.save()}
      aria-label="Громкость музыки"
      title={`Громкость ${Math.round(volume * 100)}%`}
      style={{ width: VOLUME_TRACK_W }}
      className="h-1 accent-ink cursor-pointer shrink-0"
    />
  );

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => {
          // Первый клик открывает дорожку, повторный — выключает и возвращает звук
          if (!open) {
            sounds.open();
            setOpen(true);
            return;
          }
          toggleMute();
        }}
        aria-label={open ? (muted ? "Включить звук" : "Выключить звук") : "Громкость"}
        aria-haspopup="true"
        aria-expanded={open}
        title={`Громкость ${Math.round(volume * 100)}%${muted ? " · звук выключен" : ""}`}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
          muted ? "text-faint hover:text-ink hover:bg-ink/[0.06]" : "text-muted hover:text-ink hover:bg-ink/[0.06]"
        }`}
      >
        <Icon size={16} strokeWidth={1.9} />
      </button>
      {open && (
        // Плашка над иконкой: ниже ряд кончается, а выше есть место — стекло
        // ложится поверх полосы перемотки и ничего не сдвигает.
        <div className="glass-raised absolute bottom-full left-0 z-20 mb-2 flex items-center gap-2 rounded-xl border border-line/[0.08] bg-surface/85 px-2.5 py-2 backdrop-blur-[16px]">
          <button
            onClick={toggleMute}
            aria-label={muted ? "Включить звук" : "Выключить звук"}
            aria-pressed={muted}
            title={muted ? "Включить звук" : "Выключить звук"}
            className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-ink/[0.06] transition-colors"
          >
            <Icon size={15} strokeWidth={1.9} />
          </button>
          {slider}
          <span className="w-8 shrink-0 text-[11px] tnum text-faint">
            {Math.round(volume * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Кнопка режима (перемешать / повтор): активное состояние одинаковое — иконка
 * акцентом на мягкой акцентной подложке вместо залитого квадрата. Обе кнопки
 * одного размера (28 px) и тише транспорта: это второстепенное управление.
 *
 * Точка под иконкой — индикатор «повтор списка»; у «повтора трека» режим виден
 * по самой иконке Repeat1 (цифра 1 в ней).
 */
const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

/**
 * Скорость воспроизведения: одна кнопка-цикл.
 *
 * Показываем подпись («1×»), а не только иконку: скорость — это число, и
 * человек должен видеть его не наводясь. Активное состояние — когда скорость
 * не обычная, чтобы ускоренный трек не выглядел «сломанным».
 */
function SpeedButton() {
  const speed = usePlayerStore((s) => s.speed);
  const setSpeed = usePlayerStore((s) => s.setSpeed);
  const label = speed === 1 ? "1×" : `${speed}×`;
  const index = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
  const next = SPEEDS[(index < 0 ? 1 : index + 1) % SPEEDS.length];

  return (
    <button
      type="button"
      onClick={() => {
        sounds.open();
        setSpeed(next);
      }}
      aria-label={`Скорость ${label}`}
      title={`Скорость ${label} · нажми для ${next}×`}
      className={`w-10 h-10 rounded-lg neu flex items-center justify-center text-[12px] tnum transition-colors ${
        speed !== 1 ? "text-accentText bg-accent/12 hover:bg-accent/20" : "text-muted hover:text-ink hover:bg-ink/[0.06]"
      }`}
    >
      {label}
    </button>
  );
}

function ModeButton({
  Icon,
  label,
  active,
  onClick,
  dot = false,
}: {
  Icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
  /** Маленькая точка под иконкой: включён повтор списка. */
  dot?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`relative w-10 h-10 rounded-lg neu flex items-center justify-center transition-colors ${
        active
          ? "text-accentText bg-accent/12 hover:bg-accent/20"
          : "text-muted hover:text-ink hover:bg-ink/[0.06]"
      }`}
    >
      <Icon size={16} strokeWidth={1.9} />
      {dot && (
        <span
          className="absolute bottom-[2px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-current"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

/**
 * Полоса перемотки полноэкранного плеера: нейтральная дорожка в 3 px на всю
 * ширину блока, при наведении и перетаскивании она утолщается до 5 px и
 * показывает кружок. Акцента здесь нет — акцент принадлежит только кнопке
 * «играть». Логика та же, что у общего SeekBar: захват указателя при
 * перетаскивании, отпускание — перемотка, стрелки с клавиатуры.
 */
function PlayerSeekBar({
  progress,
  onSeek,
  disabled = false,
  className = "",
}: {
  progress: number;
  onSeek: (fraction: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const value = dragValue ?? Math.min(1, Math.max(0, progress));
  /** Пока тянем — без перехода, иначе кружок «догоняет» курсор. */
  const move = dragging ? "opacity 150ms ease" : "transform 140ms linear, opacity 150ms ease";

  function fractionAt(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  return (
    <div
      role="slider"
      aria-label="Позиция трека"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-disabled={disabled}
      tabIndex={0}
      onPointerDown={(event) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
        setDragValue(fractionAt(event.clientX));
      }}
      onPointerMove={(event) => {
        if (dragging) setDragValue(fractionAt(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        const target = dragValue ?? fractionAt(event.clientX);
        setDragging(false);
        setDragValue(null);
        onSeek(target);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "ArrowRight") onSeek(Math.min(1, value + 0.02));
        if (event.key === "ArrowLeft") onSeek(Math.max(0, value - 0.02));
      }}
      className={`group/seek flex items-center py-2 ${
        disabled ? "opacity-40 cursor-default" : "cursor-pointer"
      } ${className}`}
    >
      <span
        ref={trackRef}
        className={`relative w-full rounded-full bg-ink/[0.12] transition-[height] duration-150 ${
          dragging ? "h-[5px]" : "h-[3px] group-hover/seek:h-[5px]"
        }`}
      >
        {/* Слой обрезает заливку, чтобы скругление не растягивалось вместе с scaleX */}
        <span className="absolute inset-0 rounded-full overflow-hidden">
          <span
            className="absolute inset-0 rounded-full bg-ink origin-left"
            style={{
              transform: `scaleX(${value})`,
              transition: dragging ? "none" : "transform 140ms linear",
              willChange: "transform",
            }}
          />
        </span>
        {/* Кружок — только при наведении или перетаскивании: в покое полоса тонкая */}
        <span
          className={`pointer-events-none absolute inset-y-0 left-0 w-full ${
            dragging ? "opacity-100" : "opacity-0 group-hover/seek:opacity-100"
          }`}
          style={{
            transform: `translate3d(${value * 100}%, 0, 0)`,
            transition: move,
            willChange: "transform",
          }}
        >
          <span className="absolute left-0 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink" />
        </span>
      </span>
    </div>
  );
}

/** Пока текст ищется — аккуратные пульсирующие строки вместо пустоты. */
function LyricsSkeleton() {
  return (
    <motion.div
      initial={{ scale: 0.98 }}
      animate={{ scale: 1 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex flex-col items-center gap-4 py-3"
    >
      <span className="flex items-center gap-1.5 text-[12px] text-faint">
        <Loader2 size={12} className="animate-spin" /> Ищу текст…
      </span>
      {[92, 74, 86, 62, 90, 70].map((width, index) => (
        <span
          key={index}
          className="h-3.5 max-w-[420px] rounded-full bg-ink/[0.08] animate-pulse"
          style={{ width: `${width}%`, animationDelay: `${index * 90}ms` }}
        />
      ))}
    </motion.div>
  );
}

/**
 * Одна строка текста. Компонент мемоизирован: обновление позиции
 * воспроизведения перерисовывает только ту строку, которая стала активной
 * (и ту, что перестала), — список целиком не пересобирается.
 *
 * Крупный кегль, жирное начертание и центрирование — как на макете;
 * активная строка ярче и чуть крупнее (scale), остальные приглушены.
 *
 * Строку синхронного текста можно нажать — плеер перемотается на её момент.
 * Текст без меток остаётся простым текстом: не кликается и курсор не меняет.
 */
const LyricRow = memo(function LyricRow({
  text,
  state,
  delay,
  atMs,
  onSeek,
}: {
  text: string;
  /** active — поёт сейчас, idle — синхронный текст, plain — текст без меток. */
  state: "active" | "idle" | "plain";
  /** Задержка каскада появления строк (только при первом показе). */
  delay: number;
  /** Метка времени строки в миллисекундах; null — у строки времени нет. */
  atMs: number | null;
  /** Переход к моменту строки; null — строки не кликабельны. */
  onSeek: ((atMs: number) => void) | null;
}) {
  // Задержку каскада применяем один раз: дальше строка меняет только состояние
  const entering = useRef(true);
  useEffect(() => {
    entering.current = false;
  }, []);

  /** Короткая вспышка после перехода: видно, что именно эта строка сработала. */
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  /** Где нажали: по сдвигу указателя отличаем клик от протаскивания текста. */
  const pressAt = useRef<{ x: number; y: number } | null>(null);

  // Таймер вспышки не должен пережить строку
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    []
  );

  // Кликабельна только строка с временем: у текста без синхронизации его нет
  const clickable = atMs !== null && onSeek !== null;

  const onPointerDown = (event: ReactPointerEvent<HTMLParagraphElement>) => {
    pressAt.current = { x: event.clientX, y: event.clientY };
  };

  const onClick = (event: ReactMouseEvent<HTMLParagraphElement>) => {
    if (atMs === null || !onSeek) return;
    const start = pressAt.current;
    pressAt.current = null;
    // Протаскивание (прокрутка текста) кликом не считаем
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_SLOP_PX) {
      return;
    }

    setFlash(true);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlash(false);
    }, FLASH_MS);

    onSeek(atMs);
  };

  // Пока строка вспыхнула, показываем её в полную силу: у приглушённых строк
  // иначе и сама подсветка вышла бы еле заметной
  return (
    <p
      data-active={state === "active" ? "true" : undefined}
      onPointerDown={onPointerDown}
      onClick={onClick}
      style={flash ? { opacity: 1 } : undefined}
      className={`${TEXT_COLUMN} max-w-full break-words px-4 py-1.5 rounded-lg text-center text-[22px] font-semibold leading-tight lg:text-[26px] ${LINE_TRANSITION} ${
        clickable ? "cursor-pointer hover:bg-ink/[0.06]" : ""
      } ${flash ? "bg-accent/15" : ""} ${
        state === "active"
          ? "text-ink opacity-100"
          : state === "idle"
            ? "text-muted opacity-45"
            : "text-ink/75 opacity-100"
      }`}
    >
      <motion.span
        initial={{ y: 6, scale: 1 }}
        animate={{ opacity: 1, y: 0, scale: state === "active" ? 1.05 : 1 }}
        transition={{ duration: 0.2, ease: EASE, delay: entering.current ? delay : 0 }}
        className="inline-block max-w-full break-words"
      >
        {text}
      </motion.span>
    </p>
  );
});

/**
 * Ручная подстройка синхронизации текста: «−0.5 с», «+0.5 с», сброс к нулю и
 * переключатель «Для всех треков». Кнопки без рамок и фона — в одном ряду с
 * крестиком, чтобы не отвлекать. Смещение показывается мелким текстом:
 * по нему видно, что именно применено.
 *
 * Переключатель «Для всех треков» — настоящий тумблер: включён (акцентный фон)
 * — активно общее смещение и правки идут в него; выключен — снова своё
 * значение трека. Переключение ничего не перезапускает и не сбрасывает:
 * меняется только применяемое смещение и подсветка.
 */
function LyricsOffsetControls() {
  const synced = useLyricsStore((s) => s.synced);
  const offset = useLyricsStore((s) => s.offset);
  const globalEnabled = useLyricsStore((s) => s.globalEnabled);
  const nudgeOffset = useLyricsStore((s) => s.nudgeOffset);
  const resetOffset = useLyricsStore((s) => s.resetOffset);
  const setGlobalEnabled = useLyricsStore((s) => s.setGlobalEnabled);

  // Подстраивать нечего: подсветки строк нет, смещение ни на что не влияет
  if (!synced) return null;

  const label = formatOffset(offset);
  const button =
    "px-1.5 h-7 rounded-md text-[11px] tnum text-faint/80 hover:text-ink hover:bg-ink/[0.06] transition-colors";

  return (
    <div className="flex items-center gap-0.5 mr-1" role="group" aria-label="Синхронизация текста">
      <button
        type="button"
        onClick={() => nudgeOffset(-OFFSET_STEP_SEC)}
        title="Показать строки на 0.5 с раньше"
        aria-label="Сдвинуть текст на 0.5 секунды раньше"
        className={button}
      >
        −0.5 с
      </button>
      {/* Текущее значение: видно, что именно применено */}
      <span
        title={
          offset
            ? `${globalEnabled ? "Общее смещение текста" : "Смещение текста"}: ${label}`
            : "Смещение текста не задано"
        }
        className={`w-12 text-center text-[11px] tnum ${
          offset ? "text-accentText" : "text-faint/70"
        }`}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={() => nudgeOffset(OFFSET_STEP_SEC)}
        title="Показать строки на 0.5 с позже"
        aria-label="Сдвинуть текст на 0.5 секунды позже"
        className={button}
      >
        +0.5 с
      </button>
      {offset !== 0 && (
        <button
          type="button"
          onClick={resetOffset}
          title={globalEnabled ? "Вернуть общее смещение к нулю" : "Вернуть синхронизацию к нулю"}
          aria-label="Сбросить смещение текста"
          className={button}
        >
          сброс
        </button>
      )}
      <span className="w-px h-4 mx-0.5 bg-line/[0.12]" aria-hidden="true" />
      {/* Переключатель режима: включён — смещение применяется ко всем трекам */}
      <button
        type="button"
        onClick={() => setGlobalEnabled(!globalEnabled)}
        aria-pressed={globalEnabled}
        title={
          globalEnabled
            ? "Смещение применяется ко всем трекам — нажми, чтобы вернуть своё для каждого трека"
            : "Применять текущее смещение ко всем трекам"
        }
        className={`flex items-center gap-1 h-7 px-2 rounded-md text-[11px] whitespace-nowrap transition-colors ${
          globalEnabled
            ? "bg-accent/15 text-accentText"
            : "text-faint/80 hover:text-ink hover:bg-ink/[0.06]"
        }`}
      >
        <Globe size={11} />
        Для всех треков
      </button>
    </div>
  );
}

/**
 * Содержимое панели текста: активная строка, автопрокрутка к ней, каскад
 * появления, скелетон и сообщение «Текст отсутствует в базе данных» с кнопкой
 * повтора. Ни рамки, ни фона — текст лежит прямо на фоне плеера.
 */
function LyricsBody() {
  const position = usePlayerStore((s) => s.position);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const lines = useLyricsStore((s) => s.lines);
  const synced = useLyricsStore((s) => s.synced);
  const loading = useLyricsStore((s) => s.loading);
  const notFound = useLyricsStore((s) => s.notFound);
  const error = useLyricsStore((s) => s.error);
  const source = useLyricsStore((s) => s.source);
  const fromOriginal = useLyricsStore((s) => s.fromOriginal);
  const matchedTitle = useLyricsStore((s) => s.matchedTitle);
  const matchedArtist = useLyricsStore((s) => s.matchedArtist);
  const trackId = useLyricsStore((s) => s.trackId);
  const offset = useLyricsStore((s) => s.offset);
  const retry = useLyricsStore((s) => s.retry);

  // Активную строку пересчитываем только когда поменялась позиция
  // воспроизведения (timeupdate приходит ~4 раза в секунду) или смещение,
  // а не на кадр
  const activeLine = useMemo(
    () => (synced ? findActiveLine(lines, position, offset) : -1),
    [synced, lines, position, offset]
  );

  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Строка, к которой уже прокрутились: лишних прокруток не делаем. */
  const lastScrolled = useRef(-1);
  /** Время последней ручной прокрутки: до него + RESUME_MS автопрокрутка молчит. */
  const manualAt = useRef(0);
  /** Пока идёт наша плавная прокрутка, её события скролла — не «ручные». */
  const autoUntil = useRef(0);
  /** Таймер возврата к активной строке после ручной прокрутки. */
  const resumeTimer = useRef<number | null>(null);
  /**
   * Счётчик переходов по клику. Эффект прокрутки следит и за ним: иначе панель
   * не поехала бы к строке, если перемотка упёрлась в край и активная строка по
   * расчёту осталась прежней.
   */
  const [seekTick, setSeekTick] = useState(0);

  /**
   * Поставить активную строку в центр области текста.
   * Положение считаем по прямоугольникам контейнера и строки: offsetTop
   * зависит от ближайшего позиционированного предка и легко даёт промах.
   */
  const centerActive = useCallback((behavior: ScrollBehavior = "smooth") => {
    let tries = 0;
    let lastHeight = -1;

    const step = () => {
      const body = bodyRef.current;
      if (!body) return;
      const line = body.querySelector<HTMLElement>('[data-active="true"]');
      if (!line) return;

      // Панель раскрывается по высоте: ждём, пока размер перестанет меняться,
      // иначе центр посчитается по недомеренному контейнеру
      if ((body.clientHeight < 24 || body.clientHeight !== lastHeight) && tries < 60) {
        lastHeight = body.clientHeight;
        tries++;
        requestAnimationFrame(step);
        return;
      }

      const bodyBox = body.getBoundingClientRect();
      const lineBox = line.getBoundingClientRect();
      const target =
        body.scrollTop + (lineBox.top - bodyBox.top) - (body.clientHeight - lineBox.height) / 2;
      // Ближе к концу текста по центру уже не выйдет — доезжаем до предела
      const limit = Math.max(0, body.scrollHeight - body.clientHeight);
      autoUntil.current = Date.now() + AUTO_SCROLL_MS;
      body.scrollTo({ top: Math.max(0, Math.min(target, limit)), behavior });
    };

    step();
  }, []);

  /**
   * Текст прокрутили руками: автопрокрутка замолкает на RESUME_MS, а затем
   * сама возвращается к активной строке (даже если она не сменилась).
   */
  const noteManual = useCallback(() => {
    manualAt.current = Date.now();
    if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => {
      resumeTimer.current = null;
      lastScrolled.current = -1; // та же строка — но вернуться к ней всё равно надо
      centerActive("smooth");
    }, RESUME_MS);
  }, [centerActive]);

  /** События скролла от нашей плавной прокрутки ручными не считаем. */
  const onScroll = useCallback(() => {
    if (Date.now() < autoUntil.current) return;
    noteManual();
  }, [noteManual]);

  /**
   * Переход к строке текста. Подсветка считает `at = position + offset`,
   * поэтому строка звучит при `position = lineTime − offset`: смещение именно
   * вычитаем. Позицию клампим в [0, duration], а пока длительность неизвестна —
   * в [0, время строки]. Играет трек или стоит на паузе — не меняем: перемотка
   * сама воспроизведение не включает.
   */
  const seekLine = useCallback(
    (atMs: number) => {
      const lineTime = atMs / 1000;
      const end = durationMs > 0 ? durationMs / 1000 : lineTime;
      const seconds = Math.min(Math.max(0, lineTime - offset), Math.max(0, end));
      // Клик по строке — не ручная прокрутка: автопрокрутку к новой активной
      // строке он глушить не должен, иначе текст останется на старом месте.
      // lastScrolled и счётчик переходов — чтобы панель доехала до строки,
      // даже если активной она уже была.
      manualAt.current = 0;
      if (resumeTimer.current !== null) {
        window.clearTimeout(resumeTimer.current);
        resumeTimer.current = null;
      }
      lastScrolled.current = -1;
      seekTo(seconds);
      setSeekTick((value) => value + 1);
    },
    [offset, durationMs, seekTo]
  );

  // Сменился трек или подгрузился новый текст — прокрутку начинаем заново
  useEffect(() => {
    lastScrolled.current = -1;
    manualAt.current = 0;
    autoUntil.current = Date.now() + OPEN_GRACE_MS;
    if (resumeTimer.current !== null) {
      window.clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
    }
  }, [trackId, lines]);

  // Таймер возврата не должен пережить панель
  useEffect(() => {
    return () => {
      if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
    };
  }, []);

  // Активная строка сменилась — ведём её к центру. Пока пользователь читает
  // сам (ручная прокрутка), не мешаем: строка вспомнится и доедет по таймеру.
  // Переход по клику (seekTick) центрирует панель всегда — он ручной прокруткой
  // не считается.
  useEffect(() => {
    if (!synced || activeLine < 0) return;
    if (lastScrolled.current === activeLine) return;
    lastScrolled.current = activeLine;
    if (Date.now() - manualAt.current < RESUME_MS) return;
    centerActive("smooth");
  }, [activeLine, synced, centerActive, seekTick]);

  // Панель только что открыли или начался новый поиск — показываем скелетон
  const searching = loading || (!notFound && lines.length === 0);

  // Подпись «Текст от оригинала: исполнитель — название» собираем из того, что
  // реально нашлось. Пусто — останется просто «Текст от оригинала».
  const originalLabel = useMemo(
    () => [matchedArtist, matchedTitle].filter(Boolean).join(" — "),
    [matchedArtist, matchedTitle]
  );

  return (
    <div
      ref={bodyRef}
      onScroll={onScroll}
      onWheel={noteManual}
      onPointerDown={noteManual}
      onTouchStart={noteManual}
      onKeyDown={noteManual}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pb-7 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {searching && <LyricsSkeleton />}

      {!searching && notFound && (
        <motion.div
          initial={{ y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: EASE }}
          className="flex flex-col items-center gap-3 py-6 text-center"
        >
          <p className="min-w-0 text-[13px] leading-relaxed text-muted">
            {error ?? LYRICS_NOT_FOUND_TEXT}
          </p>
          <button
            onClick={() => void retry()}
            className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] bg-accent/15 text-accentText hover:bg-accent/25 transition-colors"
          >
            <RefreshCw size={13} /> Искать заново
          </button>
        </motion.div>
      )}

      {!searching && !notFound && (
        <div className="flex flex-col">
          {lines.map((line, index) => (
            <LyricRow
              key={`${index}-${line.atMs ?? "t"}`}
              text={line.text}
              state={!synced ? "plain" : index === activeLine ? "active" : "idle"}
              delay={Math.min(index, STAGGER_LIMIT) * STAGGER_STEP}
              atMs={line.atMs}
              onSeek={synced ? seekLine : null}
            />
          ))}
          {(source || fromOriginal) && (
            <span className="mt-5 flex flex-col items-center gap-0.5 text-center">
              {source && (
                <span className="text-[10px] uppercase tracking-wider text-faint/70">
                  источник: {source}
                  {/* Синхронизации нет — говорим об этом мягко, чтобы было
                      понятно, почему строки просто идут ровным текстом */}
                  {!synced && " · без синхронизации"}
                </span>
              )}
              {/* Текст нашёлся у оригинала, а не у играющей версии: честно
                  говорим, чей это текст, чтобы подмена не выглядела ошибкой */}
              {fromOriginal && (
                <span className="text-[11px] text-faint">
                  Текст от оригинала
                  {originalLabel ? `: ${originalLabel}` : ""}
                </span>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Полноэкранный режим «сейчас играет»: только плеер, ничего лишнего.
 * Текст песни — часть плеера: кнопка-пилюля стоит рядом с названием трека,
 * панель раскрывается справа от обложки (на узком окне — под плеером).
 * Очередь открывается своей кнопкой сверху справа и панель не ломает.
 */
export default function NowPlaying({ open, onClose }: Props) {
  const [queueOpen, setQueueOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const wide = useWideLayout();
  const panelWidth = useLyricsPanelWidth();
  const panelHeight = usePanelHeight(wide ? PANEL_HEIGHT : PANEL_HEIGHT_NARROW);
  const appIcon = useAppIcon();
  /** Полноэкранный слой уходит по таймеру и сразу перестаёт ловить клики. */
  const { mounted, leaving } = useExitGuard(open);
  /** Панель текста: складывается сразу, из дерева уходит по таймеру. */
  const { mounted: lyricsMounted, leaving: lyricsLeaving } = useExitGuard(lyricsOpen, 400);
  /** Очередь: то же самое — уход не должен зависеть от кадров анимации. */
  const { mounted: queueMounted, leaving: queueLeaving } = useExitGuard(queueOpen, 400);
  /** Куда складывается панель текста при уходе. */
  const lyricsClosed = wide
    ? { width: 0, height: panelHeight, opacity: 0, x: 24 }
    : { width: "100%", height: 0, opacity: 0 };

  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const position = usePlayerStore((s) => s.position);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const progress = usePlayerStore((s) => s.progress);
  const trackTitle = usePlayerStore((s) => s.trackTitle);
  const trackArtist = usePlayerStore((s) => s.trackArtist);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const previous = usePlayerStore((s) => s.previous);
  const next = usePlayerStore((s) => s.next);
  const seekFraction = usePlayerStore((s) => s.seekFraction);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const jumpTo = usePlayerStore((s) => s.jumpTo);
  const removeAt = usePlayerStore((s) => s.removeAt);
  const clearQueue = usePlayerStore((s) => s.clearQueue);
  const waveEnabled = useRadioStore((s) => s.enabled);
  const waveLoading = useRadioStore((s) => s.loading);
  const toggleWave = useRadioStore((s) => s.toggle);

  // Обои плеера: картинка и её затемнение живут в настройках, поэтому
  // переживают перезапуск и меняются на лету из попапа в шапке.
  // Обои живут байтами в базе медиа: в настройках только ссылка media:wallpaper,
  // поэтому берём готовый blob-URL из хранилища обоев, а не строку настройки.
  const playerWallpaper = useWallpaperSource();
  const playerWallpaperDim = useSettingsStore((s) => s.playerWallpaperDim);

  const loadLyrics = useLyricsStore((s) => s.load);
  const preloadLyrics = useLyricsStore((s) => s.preload);
  const setLyricsPanelOpen = useLyricsStore((s) => s.setOpen);

  const currentTrack = queue[index];
  const trackId = currentTrack?.id ?? null;

  /**
   * Смена трека — фирменный вход (anime.js): обложка подрастает снизу,
   * подпись чуть отстаёт. Начальное состояние почти финальное (лёгкий сдвиг
   * и масштаб), поэтому при остановке кадров всё равно видно и на месте —
   * правило приложения «украшение не управляет видимостью» соблюдено.
   */
  const coverBlockRef = useRef<HTMLDivElement>(null);
  const titleBlockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!trackId) return;
    if (coverBlockRef.current) {
      anime({
        targets: coverBlockRef.current,
        scale: [0.94, 1],
        translateY: [10, 0],
        easing: "easeOutCubic",
        duration: 420,
      });
    }
    if (titleBlockRef.current) {
      anime({
        targets: titleBlockRef.current,
        translateY: [8, 0],
        easing: "easeOutCubic",
        duration: 380,
        delay: 60,
      });
    }
  }, [trackId]);
  /**
   * Имя исполнителя сервисного трека SoundCloud — ссылка на окно артиста.
   * У локального файла или трека без имени исполнителя ссылки нет: остаётся
   * обычный текст.
   */
  const artistForLink =
    currentTrack && currentTrack.artist?.trim() && serviceFromTrackId(currentTrack.id) === "soundcloud"
      ? currentTrack.artist
      : null;

  /** Открыть/закрыть панель текста. */
  const toggleLyrics = (value?: boolean) => {
    const next = value ?? !lyricsOpen;
    if (next) sounds.open();
    else sounds.close();
    setLyricsOpen(next);
  };

  // Открытая панель нужна и хранилищу: по этому флагу оно подгружает текст
  // при смене трека — и не делает этого, когда плеер закрыт.
  useEffect(() => {
    setLyricsPanelOpen(lyricsOpen && open);
  }, [lyricsOpen, open, setLyricsPanelOpen]);

  // Сменился трек — текст прошлого не показываем
  useEffect(() => {
    syncLyricsTrack(currentTrack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId]);

  // Панель открыли (в том числе на уже играющем треке) — подгружаем текст
  useEffect(() => {
    if (!open || !lyricsOpen || !currentTrack) return;
    if (useLyricsStore.getState().trackId === currentTrack.id) return;
    void loadLyrics(currentTrack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lyricsOpen, trackId]);

  // Предзагрузка текста: трек играет ~5 секунд — тихо ищем его заранее, чтобы
  // панель открылась сразу из кеша. Таймер сбрасывается при смене трека и на
  // паузе, а в момент срабатывания трек ещё раз сверяется с текущим: результат
  // поиска не должен относиться к другому треку.
  useEffect(() => {
    if (!open || !isPlaying || !currentTrack) return;
    if (useLyricsStore.getState().trackId === currentTrack.id) return;
    const id = currentTrack.id;
    const track = currentTrack;
    const timer = window.setTimeout(() => {
      const player = usePlayerStore.getState();
      if (player.queue[player.index]?.id !== id) return;
      void preloadLyrics(track);
    }, LYRICS_PRELOAD_MS);
    return () => window.clearTimeout(timer);
  }, [open, isPlaying, currentTrack, preloadLyrics]);

  // Esc закрывает очередь, а если её нет — полноэкранный плеер. Панель текста
  // Esc НЕ закрывает: иначе одно нажатие прятало текст, а следующее уже
  // выходило из плеера. Текст закрывается только явно — крестиком в панели
  // или повторным нажатием пилюли «Текст».
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (queueOpen) {
        sounds.close();
        setQueueOpen(false);
        return;
      }
      sounds.close();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, queueOpen, onClose]);

  return (
    /*
      Слой живёт ровно столько, сколько нужно: наличие в дереве определяет
      `mounted` (он снимается таймером в useExitGuard), а framer только рисует
      появление и уход. Раньше здесь стоял AnimatePresence: он убирает элемент
      лишь после конца анимации выхода, и при остановке кадров (окно свернули в
      трей) полноэкранный плеер оставался в DOM непрозрачным слоем поверх всего
      приложения — «экран замер».
    */
    <>
      {mounted && (
        <motion.div
          initial={{ y: 18 }}
          animate={leaving ? { opacity: 0, y: 18 } : { opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          style={leaving ? { pointerEvents: "none" } : undefined}
          className="absolute inset-0 z-50 bg-app flex overflow-hidden"
        >
          {/* Обои плеера: фото лежит под всем интерфейсом, сверху — слой
              затемнения (opacity из настроек). Оба слоя вне потока, контент
              поднят классом relative — иначе фото перекрыло бы его. */}
          {playerWallpaper ? (
            <>
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url(${playerWallpaper})` }}
              />
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-app"
                style={{ opacity: playerWallpaperDim }}
              />
            </>
          ) : (
            /* Обоев нет — штатно фон пустой, но совсем чёрный экран читался
               как «всё пропало»: кладём тихую картинку приложения. */
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-cover bg-center opacity-[0.07] blur-[2px]"
              style={{ backgroundImage: `url(${playerBackdrop})` }}
            />
          )}
          <div className="relative flex-1 min-w-0 flex flex-col">
            {/* Верхняя полоса плеера: закрытие слева, второстепенные пилюли
                справа — «Wave», «Текст» и «Очередь». Ряд транспорта внизу из-за
                них не сдвигается и остаётся ровно по центру. Полоса лежит ниже
                системной полосы окна, кнопкам Windows не мешает. */}
            <div className="flex items-center justify-between gap-2 px-4 h-12 shrink-0 bg-app/70 backdrop-blur-[14px] border-b border-line/[0.06]">
              <IconButton
                Icon={X}
                label="Закрыть плеер (Esc)"
                onClick={() => {
                  sounds.close();
                  onClose();
                }}
              />
              <div className="flex min-w-0 items-center gap-1.5">
                {/* «Волна»: радио из похожих треков. Состояние читается рамкой,
                    подложкой и точкой; подпись прячется на узком окне. */}
                <button
                  type="button"
                  onClick={() => {
                    sounds.open();
                    toggleWave();
                  }}
                  aria-pressed={waveEnabled}
                  aria-label={waveEnabled ? "Выключить Wave" : "Включить Wave"}
                  title={
                    waveEnabled
                      ? "Wave включена: очередь пополняется похожими треками — нажми, чтобы остановить"
                      : "Wave: радио из похожих треков"
                  }
                  className={`shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[12px] whitespace-nowrap transition-colors ${
                    waveEnabled
                      ? "border-accent/40 bg-accent/15 text-accentText"
                      : "border-transparent text-faint hover:text-ink hover:bg-ink/[0.06]"
                  }`}
                >
                  {waveLoading ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Waves size={13} />
                  )}
                  <span className="hidden min-[820px]:inline">Wave</span>
                  {waveEnabled && (
                    <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
                  )}
                </button>
                <LyricsToggle open={lyricsOpen} onClick={() => toggleLyrics()} />
                <button
                  onClick={() => {
                    sounds.open();
                    setQueueOpen((value) => !value);
                  }}
                  aria-pressed={queueOpen}
                  aria-label="Очередь"
                  title={queueOpen ? "Скрыть очередь" : "Показать очередь"}
                  className={`shrink-0 flex items-center gap-1.5 h-7 px-2.5 mr-1 rounded-lg border text-[12px] whitespace-nowrap transition-colors ${
                    queueOpen
                      ? "border-accent/40 bg-accent/15 text-accentText"
                      : "border-transparent text-faint hover:text-ink hover:bg-ink/[0.06]"
                  }`}
                >
                  <ListMusic size={13} />
                  Очередь{queue.length ? ` · ${queue.length}` : ""}
                </button>
              </div>
            </div>

            {/* Один горизонтальный блок: плеер слева, текст справа от обложки.
                На узком окне текст переезжает под плеер. */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {/* safe_center — чтобы на низком окне верх содержимого не уезжал
                  за край и оставался доступен прокруткой */}
              <div className="min-h-full flex flex-col lg:flex-row items-center [justify-content:safe_center] gap-6 lg:gap-8 px-6 lg:px-10 py-6">
                <div className="flex flex-col items-center w-full max-w-[600px] min-w-0 shrink-0 lg:flex-1 lg:shrink">
                  <div ref={coverBlockRef} className="relative shrink-0">
                    <div className="absolute inset-0 rounded-3xl blur-[70px] opacity-30 scale-105 bg-accent/40" />
                    {currentTrack?.cover ? (
                      <Cover
                        src={currentTrack.cover}
                        size={236}
                        rounded="rounded-2xl"
                        className="relative shadow-lift"
                        service={serviceFromTrackId(currentTrack.id)}
                      />
                    ) : (
                      <div className="relative w-[236px] h-[236px] rounded-2xl bg-inset border border-line/[0.08] flex items-center justify-center shadow-lift">
                        <img src={appIcon} alt="" className="w-16 h-16 rounded-2xl opacity-70" />
                      </div>
                    )}
                  </div>

                  {/* Название и эквалайзер: «Текст», «Очередь» и «Wave» живут
                      пилюлями в верхней полосе, а лайк — в ряду управления */}
                  <div
                    ref={titleBlockRef}
                    className="mt-7 flex w-full min-w-0 items-center justify-center gap-1.5"
                  >
                    <h2 className="min-w-0 truncate text-[22px] font-semibold tracking-tight">
                      {trackTitle || "Ничего не играет"}
                    </h2>
                    {isPlaying && (
                      <span className="shrink-0 flex items-center">
                        <Equalizer active />
                      </span>
                    )}
                  </div>
                  <p className="mt-1 w-full truncate text-center text-[13px] text-muted">
                    {/* У трека SoundCloud имя исполнителя — ссылка: клик
                        открывает окно артиста и воспроизведение не трогает */}
                    {artistForLink ? (
                      <ArtistLink name={artistForLink} />
                    ) : (
                      trackArtist ||
                      (queue.length ? "Неизвестный исполнитель" : "Открой файлы или включи трек из поиска")
                    )}
                  </p>

                  {/* Перемотка главнее всего: полоса на всю ширину блока, время
                      по краям моноширинно (tabular-nums — не дёргается), текущее
                      время ярче. Ниже — отдельный ряд транспорта. */}
                  <div className="w-full max-w-[560px] mt-7">
                    <div className="flex items-center gap-3">
                      <span className="shrink-0 w-11 text-right text-[11px] tnum text-ink">
                        {formatDuration(position * 1000)}
                      </span>
                      <PlayerSeekBar
                        progress={progress}
                        onSeek={seekFraction}
                        disabled={durationMs <= 0}
                        className="flex-1 min-w-0"
                      />
                      <span className="shrink-0 w-11 text-[11px] tnum text-muted">
                        {formatDuration(durationMs)}
                      </span>
                    </div>

                    {/*
                      Главный ряд: три колонки grid — транспорт всегда ровно по
                      центру блока, независимо от того, что стоит по краям.
                      Слева — второстепенное: громкость (иконка с поповером) и
                      лайк; правую колонку держит распорка.
                    */}
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center mt-5">
                      <div className="justify-self-start flex items-center gap-0.5">
                        <VolumeControl />
                        {currentTrack && (
                          <FavoriteButton track={currentTrack} size={15} className="shrink-0" />
                        )}
                      </div>
                      <div className="flex items-center justify-center gap-3">
                        <ModeButton
                          Icon={Shuffle}
                          label="Перемешать"
                          active={shuffle}
                          onClick={() => {
                            toggleShuffle();
                            sounds.open();
                          }}
                        />
                        <IconButton
                          Icon={SkipBack}
                          label="Предыдущий"
                          onClick={previous}
                          size={40}
                          className="neu rounded-lg"
                        />
                        <button
                          onClick={togglePlay}
                          aria-label={isPlaying ? "Пауза" : "Играть"}
                          className="w-14 h-14 rounded-full bg-accent text-onAccent flex items-center justify-center hover:bg-accentHover transition-[background-color,transform] duration-150 active:scale-[0.97] shadow-lift"
                        >
                          {isPlaying ? (
                            <Pause size={24} fill="currentColor" />
                          ) : (
                            <Play size={24} fill="currentColor" className="ml-0.5" />
                          )}
                        </button>
                        <IconButton
                          Icon={SkipForward}
                          label="Следующий"
                          onClick={next}
                          size={40}
                          className="neu rounded-lg"
                        />
                        <ModeButton
                          Icon={repeat === "one" ? Repeat1 : Repeat}
                          label={
                            repeat === "off"
                              ? "Повтор выключен"
                              : repeat === "all"
                                ? "Повтор списка"
                                : "Повтор трека"
                          }
                          active={repeat !== "off"}
                          dot={repeat === "all"}
                          onClick={() => {
                            cycleRepeat();
                            sounds.open();
                          }}
                        />
                        {/* Скорость: одна кнопка-цикл, подпись всегда видна —
                            «1×», «1.25×». Медленнее и быстрее обычного. */}
                        <SpeedButton />
                      </div>
                      {/* Распорка: без неё транспорт сместился бы к центру с
                          учётом ширины левой колонки */}
                      <div aria-hidden="true" />
                    </div>
                  </div>
                </div>

                {/* Текст песни: раскрывается по ширине справа от обложки,
                    на узком окне — по высоте под плеером.
                    Уход не ждёт кадров анимации: панель складывается сразу, а
                    из дерева её убирает таймер (см. useExitGuard). Иначе при
                    остановке кадров (окно свернули, система загружена)
                    AnimatePresence не получал конца анимации и панель навсегда
                    оставалась в DOM поверх плеера. */}
                {(
                    <motion.aside
                      key="lyrics"
                      // Начало — сложенное состояние: панель раскрывается по
                      // ширине (а на узком окне по высоте). Тогда открытие и
                      // закрытие одинаково плавные, без рывка на месте.
                      initial={false}
                      animate={
                        lyricsLeaving || !lyricsOpen
                          ? lyricsClosed
                          : wide
                            ? { width: panelWidth, height: panelHeight, opacity: 1, x: 0 }
                            : { width: "100%", height: panelHeight, opacity: 1, y: 0 }
                      }
                      transition={{ duration: 0.32, ease: EASE }}
                      style={!lyricsOpen || lyricsLeaving ? { pointerEvents: "none" } : undefined}
                      aria-label="Текст песни"
                      className="shrink-0 w-full max-h-full overflow-hidden lg:w-auto"
                    >
                      {/* Никакой плашки: ни рамки, ни фона, ни заголовка —
                          текст лежит прямо на фоне плеера. Ширину держим той же,
                          что у анимации панели, чтобы строки не переливались. */}
                      <div
                        className="glass-raised flex h-full flex-col overflow-hidden rounded-2xl border border-line/[0.08] bg-surface/60 backdrop-blur-[16px]"
                        style={{ width: "100%" }}
                      >
                        <div className="flex shrink-0 items-center justify-end gap-1 pr-1.5 pt-1.5">
                          <LyricsOffsetControls />
                          <button
                            onClick={() => {
                              sounds.close();
                              toggleLyrics(false);
                            }}
                            aria-label="Закрыть текст"
                            title="Скрыть текст"
                            className="p-1.5 rounded-lg text-faint/80 hover:text-ink transition-colors"
                          >
                            <X size={15} />
                          </button>
                        </div>

                        <LyricsBody />
                      </div>
                    </motion.aside>
                  )}
              </div>
            </div>
          </div>

          {/* Очередь внутри плеера: открывается по кнопке и честно закрывается */}
          {queueMounted && (
              <motion.aside
                key="queue"
                initial={{ x: 320 }}
                animate={queueLeaving ? { x: 320, opacity: 0 } : { x: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
                style={queueLeaving ? { pointerEvents: "none" } : undefined}
                className="glass-raised w-80 shrink-0 border-l border-line/[0.07] bg-surface/70 backdrop-blur-[16px] flex flex-col min-h-0"
              >
                <div className="flex items-center gap-2 px-4 h-12 shrink-0 border-b border-line/[0.06]">
                  <ListMusic size={14} className="text-faint" />
                  <span className="text-[13px] font-medium">Очередь</span>
                  <span className="text-[12px] text-muted">{queue.length}</span>
                  <div className="ml-auto flex items-center gap-1">
                    {queue.length > 0 && (
                      <button
                        onClick={() => {
                          clearQueue();
                          sounds.off();
                        }}
                        className="text-[12px] text-faint hover:text-ink transition-colors px-1.5"
                      >
                        Очистить
                      </button>
                    )}
                    <button
                      onClick={() => {
                        sounds.close();
                        setQueueOpen(false);
                      }}
                      aria-label="Закрыть очередь"
                      className="p-1.5 rounded-lg text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto py-1">
                  {queue.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-3 px-6 text-center h-full">
                      <Music2 size={20} className="text-faint" />
                      <p className="text-[13px] text-muted leading-relaxed">
                        Очередь пуста. Открой файлы или включи трек из поиска.
                      </p>
                    </div>
                  )}
                  {queue.map((track, position_) => {
                    const active = position_ === index;
                    return (
                      <div
                        key={`${track.id}-${position_}`}
                        className={`group flex items-center gap-2 px-3 py-2 ${
                          active ? "bg-accent/10" : "hover:bg-ink/[0.04]"
                        }`}
                      >
                        <button
                          onClick={() => (active ? togglePlay() : jumpTo(position_))}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className={`block text-[12px] truncate ${active ? "text-accentText" : ""}`}>
                            {track.title}
                          </span>
                          <span className="block text-[11px] text-muted truncate">
                            {track.artist ?? "Неизвестный исполнитель"}
                            {track.source === "service" ? " · сервис" : ""}
                          </span>
                        </button>
                        <span className="text-[11px] text-faint tnum shrink-0">
                          {formatDuration(track.durationMs)}
                        </span>
                        <button
                          onClick={() => removeAt(position_)}
                          aria-label="Убрать из очереди"
                          className="p-1 rounded text-faint opacity-0 group-hover:opacity-100 hover:text-ink transition-all shrink-0"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </motion.aside>
            )}
        </motion.div>
      )}
    </>
  );
}
