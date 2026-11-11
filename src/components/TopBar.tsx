import { useEffect, useRef, useState } from "react";
import { Search as SearchIcon, X } from "lucide-react";
import ProfileMenu from "./ProfileMenu";
import NotificationsBell from "./NotificationsBell";
import ServiceMark from "./ServiceMark";
import { SEARCH_SERVICES, type ServiceId } from "../lib/services";
import { useServiceStore } from "../store/serviceStore";
import { useSettingsStore } from "../store/settingsStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import type { Profile } from "../services/profiles";

interface Props {
  profile: Profile;
  showSearch?: boolean;
  onSearchSubmit?: (query: string) => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onAddAccount: () => void;
  /** Колокольчик: открыть журнал ошибок в настройках. */
  onOpenErrors: () => void;
}

/**
 * Поиск с выбором сервиса: клик по знаку решает, через какой сервис искать, а
 * неподключённые — серые и объясняют, что нужно вставить токен. Живёт отдельным
 * компонентом, потому что то же поле стоит и в верхней панели, и в стеклянной
 * панели навигации: поведение у них общее, отличается только ширина.
 */
export function SearchField({
  show = true,
  onSearchSubmit,
  className = "",
}: {
  show?: boolean;
  onSearchSubmit?: (query: string) => void;
  /** Ширина поля: тянущееся в панели или фиксированное в навбаре. */
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const available = useServiceStore((s) => s.available);
  const activeService = useSettingsStore((s) => s.activeService);
  const setActiveService = useSettingsStore((s) => s.setActiveService);

  // Ctrl+K / Cmd+K — фокус в поиск
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function pickService(id: ServiceId, name: string) {
    if (!available[id]) {
      sounds.error();
      toast({
        title: `${name} не подключена`,
        description: "Вставь токен в настройках — и поиск пойдёт через этот сервис",
        tone: "danger",
      });
      return;
    }
    sounds.open();
    setActiveService(id);
    onSearchSubmit?.(query.trim());
    inputRef.current?.focus();
  }

  if (!show) return null;

  return (
    <div
      className={`flex items-center gap-2 h-9 px-3 rounded-xl bg-inset border border-line/[0.07] focus-within:border-accentText/50 transition-colors ${className}`}
    >
      <SearchIcon size={15} className="text-faint shrink-0" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSearchSubmit?.(query.trim());
        }}
        placeholder={`Искать в ${SEARCH_SERVICES.find((s) => s.id === activeService)?.name ?? "сервисе"}…`}
        className="bg-transparent flex-1 min-w-0 outline-none text-[13px] placeholder:text-faint"
      />
      {query && (
        <button
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
          aria-label="Очистить поиск"
          className="shrink-0 p-0.5 rounded text-faint hover:text-ink transition-colors"
        >
          <X size={13} />
        </button>
      )}

      {/* Знаки сервисов вместо подсказки Ctrl+K */}
      <span className="flex items-center gap-0.5 shrink-0 pl-1.5 ml-0.5 border-l border-line/[0.08]">
        {SEARCH_SERVICES.map((service) => {
          const enabled = available[service.id];
          const isActive = service.id === activeService;
          return (
            <button
              key={service.id}
              onClick={() => pickService(service.id, service.name)}
              title={
                enabled
                  ? `Искать в ${service.name}${isActive ? " (выбран)" : ""}`
                  : `${service.name}: не подключено — вставь токен в настройках`
              }
              aria-label={`Сервис ${service.name}${enabled ? "" : " (не подключено)"}`}
              className={`p-1 rounded-md transition-colors ${
                isActive
                  ? "bg-accent/12"
                  : enabled
                    ? "hover:bg-ink/[0.06]"
                    : ""
              }`}
            >
              <ServiceMark service={service.id} size={15} muted={!enabled} />
            </button>
          );
        })}
      </span>
    </div>
  );
}

/**
 * Верхняя панель: поиск, уведомления и меню профиля. Осталась для режима
 * бокового меню: в режиме верхней навигации те же элементы собирает NavBar.
 */
export default function TopBar({
  profile,
  showSearch = true,
  onSearchSubmit,
  onOpenProfile,
  onOpenSettings,
  onAddAccount,
  onOpenErrors,
}: Props) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 px-page h-14 bg-app/70 backdrop-blur-[14px] border-b border-line/[0.06]">
      <SearchField show={showSearch} onSearchSubmit={onSearchSubmit} className="flex-1 max-w-[440px] min-w-0" />

      <div className="flex items-center gap-1 ml-auto shrink-0">
        <NotificationsBell onOpenErrors={onOpenErrors} />
        <div className="ml-1">
          <ProfileMenu
            profile={profile}
            onOpenProfile={onOpenProfile}
            onOpenSettings={onOpenSettings}
            onAddAccount={onAddAccount}
          />
        </div>
      </div>
    </header>
  );
}
