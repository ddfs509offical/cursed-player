import { Music2 } from "lucide-react";
import { themeCover } from "../lib/coverTone";

interface Props {
  seed: number;
  /** Реальная картинка (локальный файл или URL). Если нет — градиент. */
  src?: string | null;
  className?: string;
  /** Показывать ноту на градиентной заглушке. */
  glyph?: boolean;
}

/**
 * Обложка. Картинки лежат в проекте (src/assets/covers) и попадают в сборку
 * через Vite — сеть не нужна. Когда картинки нет, рисуем детерминированный
 * градиент с нотой: пустая обложка должна выглядеть намеренной, а не серым
 * прямоугольником.
 */
export default function Tile({ seed, src, className = "", glyph = true }: Props) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        className={`object-cover select-none ${className}`}
      />
    );
  }

  return (
    <div
      className={`relative overflow-hidden select-none ${className}`}
      style={{ background: themeCover(seed) }}
      aria-hidden
    >
      {glyph && (
        <Music2
          strokeWidth={1.5}
          className="absolute inset-0 m-auto w-1/3 h-1/3 text-coverInk/25"
        />
      )}
    </div>
  );
}
