import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";

interface Props {
  Icon: LucideIcon;
  value: string;
  label: string;
  trend?: string;
  trendUp?: boolean;
}

/**
 * Показатель без карточки: заголовок-подпись, крупное число и тренд.
 * Раньше это была отдельная карточка, из-за чего экран состоял из
 * одинаковых прямоугольников — Linear/Figma так не делают.
 */
export default function StatCard({ Icon, value, label, trend, trendUp = true }: Props) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-faint">
        <Icon size={13} strokeWidth={2} />
        <span className="text-[11px] uppercase tracking-[0.1em] truncate">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        {/* Прочерк вместо числа не должен выглядеть как крупное значение */}
        <span
          className={`leading-none font-semibold tracking-tight ${
            value === "—" ? "text-[16px] text-faint" : "text-[22px] tnum"
          }`}
        >
          {value}
        </span>
        {trend && (
          <span
            className={`flex items-center gap-0.5 text-xs tnum ${trendUp ? "text-emerald-400" : "text-red-400"}`}
          >
            {trendUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {trend}
          </span>
        )}
      </div>
    </div>
  );
}
