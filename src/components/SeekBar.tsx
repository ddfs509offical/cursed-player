/**
 * Полоска позиции трека.
 *
 * Раньше она ползла рывками: позиция приходит из `timeupdate` примерно четыре
 * раза в секунду, а CSS-переход был на 140 мс — между обновлениями полоска
 * успевала «догнать» старое значение и замирала. Здесь положение считается на
 * каждом кадре от последнего известного времени, а плавный «догон» включается
 * только на больших скачках: перемотка, смена трека, пауза.
 *
 * Всё движение идёт трансформом: scaleX у заливки, translate3d у бегунка.
 * Ширина не анимируется — она заставляла браузер пересчитывать раскладку.
 */
import { useEffect, useRef, useState } from "react";

interface Props {
  /** Доля прослушанного 0..1 — последнее известное значение из плеера. */
  progress: number;
  onSeek: (fraction: number) => void;
  disabled?: boolean;
  className?: string;
  /** Играет ли трек: от этого зависит, досчитывать ли время между кадрами. */
  playing?: boolean;
  /** Длительность в миллисекундах: нужна, чтобы досчитать позицию точно. */
  durationMs?: number;
  /** Куда сообщать текущее положение в секундах: подпись времени рядом. */
  onPosition?: (seconds: number) => void;
}

export default function SeekBar({
  progress,
  onSeek,
  disabled = false,
  className = "",
  playing = false,
  durationMs = 0,
  onPosition,
}: Props) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState<number | null>(null);

  // Показываемое положение: обновляется в кадре, а не по приходу данных.
  const [shown, setShown] = useState(() => clamp(progress));
  // Мягкий переход нужен только на больших скачках (перемотка, смена трека).
  const [smooth, setSmooth] = useState(false);

  const lastProgress = useRef(progress);
  const lastAt = useRef(performance.now());
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Новое значение из плеера: запоминаем момент, но не дёргаем положение,
  // если расхождение маленькое — его досчитает кадр.
  useEffect(() => {
    lastProgress.current = clamp(progress);
    lastAt.current = performance.now();
    if (Math.abs(progress - shownRef.current) > 0.02) {
      setSmooth(true);
      setShown(clamp(progress));
      const timer = window.setTimeout(() => setSmooth(false), 260);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [progress]);

  /**
   * Живое время прямо из аудиоэлемента.
   *
   * Полоска не должна зависеть только от `progress` из состояния: если
   * store по какой-то причине не обновляется, она замирает. Здесь читаем
   * `currentTime` у самого `<audio>` — это правда о воспроизведении,
   * независимо от того, дошло ли событие `timeupdate`.
   */
  const readLiveSeconds = (): number | null => {
    const audio = document.querySelector("audio");
    if (!audio) return null;
    const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationMs / 1000;
    if (!Number.isFinite(total) || total <= 0) return null;
    return Math.min(1, Math.max(0, audio.currentTime / total));
  };

  // Кадр: пока играем, прибавляем прошедшее время к последнему значению.
  useEffect(() => {
    if (dragging) return undefined;
    let frame = 0;
    const tick = () => {
      const now = performance.now();
      const delta = (now - lastAt.current) / 1000;
      let next = lastProgress.current;
      const live = readLiveSeconds();
      if (live !== null) {
        // Аудио знает время точнее состояния — берём его.
        next = live;
      } else if (playing && durationMs > 0) {
        next = Math.min(1, next + delta / (durationMs / 1000));
      }
      setShown(next);
      // Отдаём положение наружу: подпись времени не должна отставать от полоски.
      if (onPosition && durationMs > 0) onPosition(next * (durationMs / 1000));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, durationMs, dragging, onPosition]);

  const value = dragging && dragValue !== null ? dragValue : shown;
  const transition = dragging || !smooth ? "none" : "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";

  function fractionAt(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp((clientX - rect.left) / rect.width);
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
        if (!dragging) return;
        setDragValue(fractionAt(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        const target = dragValue ?? fractionAt(event.clientX);
        setDragging(false);
        setDragValue(null);
        setShown(target);
        onSeek(target);
      }}
      onPointerCancel={() => {
        setDragging(false);
        setDragValue(null);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "ArrowRight") onSeek(Math.min(1, value + 0.02));
        if (event.key === "ArrowLeft") onSeek(Math.max(0, value - 0.02));
      }}
      className={`obs-seek ${dragging ? "obs-seek--drag" : ""} ${disabled ? "obs-seek--off" : ""} ${className}`}
    >
      <span ref={trackRef} className="obs-seek__track">
        <span className="obs-seek__fill" style={{ transform: `scaleX(${value})`, transition }} />
        <span
          className="obs-seek__thumb"
          style={{ transform: `translate3d(${value * 100}%, 0, 0)`, transition }}
        >
          <span className="obs-seek__dot" />
        </span>
      </span>
    </div>
  );
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
