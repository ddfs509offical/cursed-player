import { motion } from "framer-motion";
import { SEARCH_SERVICES, type ServiceId } from "../lib/services";
import { useServiceStore } from "../store/serviceStore";
import { useSettingsStore } from "../store/settingsStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import ServiceMark from "./ServiceMark";

interface Props {
  /** Большой вариант — для страницы поиска. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Переключение между сервисами. Неподключённые сервисы показаны серыми:
 * по клику объясняем, что нужно вставить токен, а не делаем вид, что ищем.
 */
export default function ServiceSwitcher({ size = "sm", className = "" }: Props) {
  const available = useServiceStore((s) => s.available);
  const activeService = useSettingsStore((s) => s.activeService);
  const setActiveService = useSettingsStore((s) => s.setActiveService);

  function pick(id: ServiceId, name: string, searchable: boolean) {
    if (!available[id]) {
      sounds.error();
      toast({
        title: `${name} не подключена`,
        description: searchable
          ? "Вставь токен в настройках — и поиск заработает"
          : "VK с 2021 не отдаёт музыку через API",
        tone: "danger",
      });
      return;
    }
    if (id === activeService) return;
    sounds.open();
    setActiveService(id);
  }

  return (
    <div
      className={`inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-inset border border-line/[0.07] ${className}`}
      role="tablist"
      aria-label="Сервис"
    >
      {SEARCH_SERVICES.map((service) => {
        const isActive = service.id === activeService;
        const enabled = available[service.id];
        return (
          <button
            key={service.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => pick(service.id, service.name, service.searchable)}
            title={enabled ? service.name : `${service.name}: не подключено`}
            className={`relative flex items-center gap-1.5 rounded-md transition-colors ${
              size === "md" ? "h-8 px-3 text-[12px]" : "h-7 px-2 text-[11px]"
            } ${isActive ? "text-ink" : enabled ? "text-muted hover:text-ink" : "text-faint/60"}`}
          >
            {isActive && (
              <motion.span
                layoutId={`service-pill-${size}`}
                className="absolute inset-0 rounded-md bg-surface shadow-panel"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
              />
            )}
            {/* Иконку поднимаем над подложкой активной пилюли, иначе она прячется */}
            <span className="relative z-10 flex items-center">
              <ServiceMark service={service.id} size={size === "md" ? 15 : 13} muted={!enabled} />
            </span>
            <span className="relative z-10">{service.short}</span>
            {!enabled && <span className="relative z-10 text-[10px] opacity-70">не подключён</span>}
          </button>
        );
      })}
    </div>
  );
}
