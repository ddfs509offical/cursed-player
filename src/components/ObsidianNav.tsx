/**
 * Панель навигации «Обсидиан».
 *
 * Не колонка кнопок, а каталог: заголовок приложения, разделы, а внизу —
 * профиль как дверь в личное. Активный раздел отмечен штрихом света на краю
 * панели, а не цветной плашкой: интерфейс должен говорить «ты здесь», не
 * отвлекая от музыки.
 *
 * Отдельно от `Sidebar`: старая панель остаётся для прежнего слоя, новую
 * можно править, не рискуя его задеть.
 */
import { ChevronRight, Settings as SettingsIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Avatar from "./Avatar";
import type { Profile } from "../services/profiles";
import { APP_NAME } from "../lib/app";
import { useAppIcon } from "../lib/appIcon";

export interface RailItem {
  Icon: LucideIcon;
  label: string;
}

interface Props {
  items: RailItem[];
  selected: number;
  onSelect: (index: number) => void;
  settingsActive: boolean;
  onSettingsSelect: () => void;
  profile: Profile;
  profileActive: boolean;
  onProfileSelect: () => void;
  /** Режим панели: в узком остаются только значки. */
  compact: boolean;
}

export default function ObsidianNav({
  items,
  selected,
  onSelect,
  settingsActive,
  onSettingsSelect,
  profile,
  profileActive,
  onProfileSelect,
  compact,
}: Props) {
  const appIcon = useAppIcon();

  return (
    <nav className="obs-nav" aria-label="Разделы">
      <div className="obs-nav__brand">
        <img src={appIcon} alt="" className="obs-nav__mark" />
        {!compact && <span className="obs-nav__name">{APP_NAME}</span>}
      </div>

      <div className="obs-nav__items">
        {items.map((item, index) => (
          <NavLink
            key={item.label}
            Icon={item.Icon}
            label={item.label}
            active={selected === index}
            compact={compact}
            onClick={() => onSelect(index)}
          />
        ))}

        <div className="obs-nav__rule" />

        <NavLink
          Icon={SettingsIcon}
          label="Настройки"
          active={settingsActive}
          compact={compact}
          onClick={onSettingsSelect}
        />
      </div>

      <div className="obs-nav__spacer" />

      {/* Профиль: аватар, имя и отношение к аккаунту. Отдельная кнопка,
          потому что это дверь, а не ещё один раздел каталога. */}
      <button
        onClick={onProfileSelect}
        className="obs-profile"
        data-active={profileActive}
        title={compact ? profile.displayName : undefined}
      >
        <Avatar profile={profile} size={compact ? 28 : 30} />
        {!compact && (
          <span className="obs-profile__text">
            <span className="obs-profile__name">{profile.displayName}</span>
            <span className="obs-profile__handle">@{profile.username}</span>
          </span>
        )}
        {!compact && <ChevronRight size={14} className="obs-profile__chev" />}
      </button>
    </nav>
  );
}

function NavLink({
  Icon,
  label,
  active,
  compact,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  active: boolean;
  compact: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="obs-nav-item"
      data-active={active}
      aria-current={active ? "page" : undefined}
      title={compact ? label : undefined}
    >
      <Icon size={17} strokeWidth={active ? 2 : 1.75} />
      {!compact && <span>{label}</span>}
    </button>
  );
}
