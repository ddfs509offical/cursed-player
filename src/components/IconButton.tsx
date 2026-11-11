import type { LucideIcon } from "lucide-react";

interface Props {
  Icon: LucideIcon;
  label: string;
  onClick?: () => void;
  /** Визуальный размер квадрата; кликабельная зона больше за счёт padding. */
  size?: number;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}

/**
 * Иконка-кнопка: 32px визуально, ~40px зона попадания — иначе по кнопкам
 * транспорта тяжело попадать мышью.
 */
export default function IconButton({
  Icon,
  label,
  onClick,
  size = 32,
  active = false,
  className = "",
  disabled = false,
}: Props) {
  const iconSize = Math.round(size * 0.5);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{ width: size, height: size }}
      className={`rounded-lg flex items-center justify-center transition-colors disabled:opacity-35 ${
        active
          ? "text-ink bg-ink/[0.14] ring-1 ring-inset ring-ink/20"
          : "text-muted hover:text-ink hover:bg-ink/[0.06]"
      } ${className}`}
    >
      <Icon size={iconSize} strokeWidth={1.9} />
    </button>
  );
}
