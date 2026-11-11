import { Settings as SettingsIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Avatar from "./Avatar";
import type { Profile } from "../services/profiles";
import { APP_NAME, APP_VERSION } from "../lib/app";
import { useAppIcon } from "../lib/appIcon";

export interface NavItem {
  Icon: LucideIcon;
  label: string;
}

export type ServiceConnState = "disconnected" | "connecting" | "connected";
export interface ServiceStatus {
  name: string;
  state: ServiceConnState;
}

interface Props {
  items: NavItem[];
  selected: number;
  onSelect: (index: number) => void;
  settingsActive: boolean;
  onSettingsSelect: () => void;
  profile: Profile;
  profileActive: boolean;
  onProfileSelect: () => void;
}

/**
 * Боковая навигация в языке «STUDIO» (редизайн 28.10.2026).
 *
 * Плоская колонка на тон темнее приложения: границу держит волосяная линия,
 * а не рамка. Активный раздел помечается короткой акцентной планкой слева и
 * тихой подложкой — цветная пилюля с пружиной осталась в прошлом слое: она
 * перетягивала внимание с содержимого.
 */
export default function Sidebar({
  items,
  selected,
  onSelect,
  settingsActive,
  onSettingsSelect,
  profile,
  profileActive,
  onProfileSelect,
}: Props) {
  const appIcon = useAppIcon();
  return (
    <aside className="w-[236px] shrink-0 bg-inset/50 border-r border-line/[0.06] flex flex-col min-h-0">
      {/* Шапка: иконка, имя и версия одной строкой. Версия — тихая метка,
          а не рамка: она нужна раз в месяц, но не должна спорить с именем. */}
      <div className="flex items-center gap-2.5 px-5 h-16 shrink-0">
        <img src={appIcon} alt="" className="w-8 h-8 rounded-[10px] shrink-0" />
        <span className="text-[15px] font-semibold tracking-[-0.015em] truncate">{APP_NAME}</span>
        <span className="ml-auto text-[10px] text-faint tnum">{APP_VERSION}</span>
      </div>


      <nav className="px-3 flex flex-col gap-0.5">
        {items.map((item, i) => (
          <NavRow
            key={item.label}
            Icon={item.Icon}
            label={item.label}
            selected={selected === i}
            onClick={() => onSelect(i)}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <div className="px-3 pb-3 flex flex-col gap-0.5">
        <NavRow
          Icon={SettingsIcon}
          label="Настройки"
          selected={settingsActive}
          onClick={onSettingsSelect}
        />

        {/* Профиль — карточка с аватаром: это вход в личный раздел, а не пункт
            меню, поэтому у него своя подложка и тон. */}
        <button
          onClick={onProfileSelect}
          className={`mt-1 flex items-center gap-2.5 h-12 px-2.5 rounded-[10px] text-left transition-colors ${
            profileActive ? "bg-surface2" : "hover:bg-ink/[0.05]"
          }`}
        >
          <Avatar profile={profile} size={28} />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium truncate">{profile.displayName}</span>
            <span className="block text-[11px] text-faint truncate">@{profile.username}</span>
          </span>
        </button>
      </div>
    </aside>
  );
}

function NavRow({
  Icon,
  label,
  selected,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={`relative flex items-center gap-3 h-9 px-2.5 rounded-[10px] text-[13px] text-left transition-colors ${
        selected
          ? "rail-active font-medium"
          : "text-muted hover:text-ink hover:bg-ink/[0.04]"
      }`}
    >
      <Icon
        size={16}
        strokeWidth={1.85}
        className={selected ? "text-accentText" : undefined}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}
