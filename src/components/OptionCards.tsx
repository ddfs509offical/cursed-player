import { Check, type LucideIcon } from "lucide-react";

/**
 * Группа плиток-вариантов для настроек: 2–4 штуки в ряд, на узком окне — по две.
 * Каждая плитка: иконка, название и необязательное короткое пояснение.
 * Выбранная обведена акцентом и подсвечена фоном — без теней, «стекла» и пилюль.
 */

/** Один вариант в группе. */
export interface OptionCard {
  id: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
}

export default function OptionCards({
  options,
  value,
  onChange,
  columns = 2,
  ariaLabel,
}: {
  options: OptionCard[];
  value: string;
  onChange: (id: string) => void;
  /** Сколько плиток в ряду на широком окне. На узком всегда две. */
  columns?: 2 | 3 | 4;
  ariaLabel?: string;
}) {
  const grid =
    columns === 2
      ? "grid-cols-2"
      : columns === 3
        ? "grid-cols-2 sm:grid-cols-3"
        : "grid-cols-2 sm:grid-cols-4";

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`grid gap-2 ${grid}`}>
      {options.map((option) => {
        const selected = option.id === value;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className={`ui-tile border px-3 py-2.5 text-left transition-colors ${
              selected
                ? "border-accentText bg-accent/[0.08]"
                : "border-line/[0.09] hover:border-line/20 hover:bg-ink/[0.03]"
            }`}
          >
            <span className="flex items-center gap-2 min-w-0">
              {Icon && (
                <Icon size={14} className={selected ? "text-accentText shrink-0" : "text-muted shrink-0"} />
              )}
              <span className={`text-[13px] truncate ${selected ? "text-ink" : "text-ink/85"}`}>
                {option.label}
              </span>
              {selected && <Check size={12} className="text-accentText ml-auto shrink-0" />}
            </span>
            {option.hint && (
              <span className="block text-[11px] text-muted mt-1 leading-snug">{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
