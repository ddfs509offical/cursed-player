import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  Icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/**
 * Пустое состояние вместо мок-данных: объясняем, что здесь появится,
 * и даём одно понятное действие.
 */
export default function EmptyState({ Icon, title, description, action, className = "" }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-16 px-6 ${className}`}>
      <div className="w-14 h-14 rounded-2xl border border-line/10 bg-surface flex items-center justify-center text-faint mb-4">
        <Icon size={22} strokeWidth={1.75} />
      </div>
      <p className="text-[15px] font-semibold">{title}</p>
      {description && <p className="text-[13px] text-muted mt-1.5 max-w-sm leading-relaxed">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
