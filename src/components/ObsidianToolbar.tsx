/**
 * Правая часть шапки «Обсидиан»: уведомления, настройки, профиль.
 *
 * Старая шапка (`TopBar`) знала о поиске и раскладке, которая в новой
 * оболочке не нужна. Здесь только действия: три кнопки и аватар.
 */
import { Bell, Settings as SettingsIcon } from "lucide-react";
import Avatar from "./Avatar";
import type { Profile } from "../services/profiles";
import { useErrorStore } from "../store/errorStore";

interface Props {
  profile: Profile;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onAddAccount: () => void;
  onOpenErrors: () => void;
}

export default function ObsidianToolbar({
  profile,
  onOpenProfile,
  onOpenSettings,
  onOpenErrors,
}: Props) {
  // Счётчик ошибок: кнопка становится заметной, только когда есть что смотреть.
  const errors = useErrorStore((s) => s.errors.length);

  return (
    <>
      <button
        className="obs-icon"
        onClick={onOpenErrors}
        aria-label={errors > 0 ? `Ошибки: ${errors}` : "Ошибок нет"}
        title={errors > 0 ? `Ошибки: ${errors}` : "Ошибок нет"}
        data-on={errors > 0}
      >
        <Bell size={16} />
      </button>
      <button
        className="obs-icon"
        onClick={onOpenSettings}
        aria-label="Настройки"
        title="Настройки"
      >
        <SettingsIcon size={16} />
      </button>
      <button
        onClick={onOpenProfile}
        className="obs-icon"
        aria-label={`Профиль ${profile.displayName}`}
        title={profile.displayName}
        style={{ width: 34, height: 34 }}
      >
        <Avatar profile={profile} size={28} />
      </button>
    </>
  );
}
