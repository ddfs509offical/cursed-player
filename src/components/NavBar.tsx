import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { MoreHorizontal, Settings as SettingsIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import ProfileMenu from "./ProfileMenu";
import NotificationsBell from "./NotificationsBell";
import { APP_NAME } from "../lib/app";
import { useAppIcon } from "../lib/appIcon";
import type { NavItem } from "./Sidebar";
import type { Profile } from "../services/profiles";

/** Ниже этой ширины разделы теряют подписи и остаются иконками с подсказкой. */
const ICON_ONLY_WIDTH = 980;
/** Ниже этой ширины лишние разделы уходят под кнопку «⋯». */
const COMPACT_WIDTH = 760;
/** Совсем узко — под «⋯» уезжает и часть основных разделов. */
const NARROW_WIDTH = 640;
/** Название приложения показываем, только когда для него есть место. */
const LOGO_TEXT_WIDTH = 1200;

interface Props {
  items: NavItem[];
  selected: number;
  onSelect: (index: number) => void;
  settingsActive: boolean;
  onSettingsSelect: () => void;
  profile: Profile;
  /** Открыта страница профиля: подсвечиваем аватар, как это делало боковое меню. */
  profileActive?: boolean;
  /** Оставлены для совместимости с вызовами из App.tsx: поле поиска в панели убрано. */
  showSearch?: boolean;
  onSearchSubmit?: (query: string) => void;
  onOpenProfile: () => void;
  onAddAccount: () => void;
  /** Колокольчик: открыть журнал ошибок в настройках. */
  onOpenErrors: () => void;
}

/** Ширина окна: от неё зависит, что помещается в панели. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1360 : window.innerWidth
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/**
 * Стеклянная панель навигации сверху: логотип слева, разделы по центру со
 * скользящей пилюлей, уведомления, настройки и профиль справа.
 * Логика разделов та же, что у бокового меню, — отличается только подача.
 * Поле поиска в панели не показывается: поиск доступен в разделе «Поиск».
 */
export default function NavBar({
  items,
  selected,
  onSelect,
  settingsActive,
  onSettingsSelect,
  profile,
  profileActive = false,
  onOpenProfile,
  onAddAccount,
  onOpenErrors,
}: Props) {
  const appIcon = useAppIcon();
  const width = useWindowWidth();

  const iconOnly = width < ICON_ONLY_WIDTH;
  const compact = width < COMPACT_WIDTH;
  const showLogoText = width >= LOGO_TEXT_WIDTH;

  // На узком окне разделы прячутся под «⋯»: подписи там всё равно скрыты,
  // а кнопка меню занимает место одной иконки.
  const visibleCount = compact ? (width < NARROW_WIDTH ? 2 : 4) : items.length;
  const visible = items.slice(0, visibleCount);
  const hidden = items.slice(visibleCount);
  const hiddenActive = compact && selected >= visibleCount;

  return (
    /**
     * Панель — отдельный слой над контентом (z-30). Причина: выпадающие меню
     * (профиль, «⋯», уведомления) живут внутри панели, а у самой панели
     * backdrop-blur создаёт свой контекст наложения. Без явного z-index контент
     * раздела, у которого есть transform (анимация появления), оказывался выше
     * панели: меню было видно, но клики уходили в контент. Ровно так же сделан
     * TopBar в режиме бокового меню.
     */
    <header className="relative z-30 shrink-0 px-page pt-3">
      <nav className="glass-float relative flex items-center gap-3 h-14 pl-3.5 pr-2.5 rounded-2xl bg-app/70 backdrop-blur-[14px] border border-line/10">
        {/* Логотип приложения: иконка, название и полоски-эквалайзер из макета */}
        <div className="flex items-center gap-2 shrink-0">
          <img src={appIcon} alt="" className="w-7 h-7 rounded-lg shrink-0" />
          {showLogoText && (
            <>
              <span className="text-[14px] font-semibold tracking-tight whitespace-nowrap">
                {APP_NAME}
              </span>
              <span className="flex items-end gap-[2px] h-3.5" aria-hidden="true">
                <span className="w-0.5 h-2 rounded-full bg-accentText" />
                <span className="w-0.5 h-3.5 rounded-full bg-accentText" />
                <span className="w-0.5 h-2.5 rounded-full bg-accentText" />
              </span>
            </>
          )}
        </div>

        {/* Разделы: активный подсвечен скользящей пилюлей.
            Блок занимает всё свободное место и центрирует разделы между
            логотипом и правой группой кнопок (поля поиска в панели больше нет). */}
        <div className="flex-1 min-w-0 flex items-center justify-center gap-0.5">
          {visible.map((item, index) => (
            <NavButton
              key={item.label}
              Icon={item.Icon}
              label={item.label}
              active={selected === index}
              iconOnly={iconOnly}
              onClick={() => onSelect(index)}
              pillId="navbar-pill"
            />
          ))}
          {compact && hidden.length > 0 && (
            <MoreMenu
              items={hidden}
              offset={visibleCount}
              selected={selected}
              onSelect={onSelect}
              active={hiddenActive}
              iconOnly={iconOnly}
            />
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <NotificationsBell onOpenErrors={onOpenErrors} />
          <button
            onClick={onSettingsSelect}
            title="Настройки"
            aria-label="Настройки"
            aria-current={settingsActive ? "page" : undefined}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors press ${
              settingsActive
                ? "bg-ink/[0.08] text-accentText"
                : "text-muted hover:text-ink hover:bg-ink/[0.06]"
            }`}
          >
            <SettingsIcon size={16} strokeWidth={1.9} />
          </button>
          <div className={`rounded-full transition-shadow ${profileActive ? "ring-2 ring-accentText/60" : ""}`}>
            <ProfileMenu
              profile={profile}
              onOpenProfile={onOpenProfile}
              onOpenSettings={onSettingsSelect}
              onAddAccount={onAddAccount}
            />
          </div>
        </div>
      </nav>
    </header>
  );
}

/** Пункт панели: иконка и подпись, а на узком окне — только иконка с подсказкой. */
function NavButton({
  Icon,
  label,
  active,
  iconOnly,
  onClick,
  pillId,
}: {
  Icon: LucideIcon;
  label: string;
  active: boolean;
  iconOnly: boolean;
  onClick: () => void;
  /** Общая пилюля на всю панель: подсветка едет от раздела к разделу. */
  pillId: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`press relative flex items-center gap-1.5 h-9 rounded-xl text-[13px] ${
        iconOnly ? "px-2.5" : "px-2"
      } ${
        active ? "text-ink font-medium" : "text-muted hover:text-ink hover:bg-ink/[0.04]"
      }`}
    >
      {active && (
        <motion.span
          layoutId={pillId}
          className="glass absolute inset-0 rounded-xl bg-ink/[0.08] border border-line/[0.08]"
          transition={{ type: "spring", stiffness: 400, damping: 34 }}
        />
      )}
      <Icon
        size={16}
        strokeWidth={1.9}
        className={`relative z-10 shrink-0 ${active ? "text-accentText" : ""}`}
      />
      {!iconOnly && <span className="relative z-10 whitespace-nowrap">{label}</span>}
    </button>
  );
}

/** «⋯»: разделы, которым не хватило места в самой панели. */
function MoreMenu({
  items,
  offset,
  selected,
  onSelect,
  active,
  iconOnly,
}: {
  items: NavItem[];
  /** Индекс первого спрятанного раздела: в панели нумерация сквозная. */
  offset: number;
  selected: number;
  onSelect: (index: number) => void;
  active: boolean;
  iconOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Закрытие по клику вне меню и по Esc
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((value) => !value)}
        title="Ещё разделы"
        aria-label="Ещё разделы"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`press relative flex items-center justify-center h-9 rounded-xl ${
          iconOnly ? "px-2.5" : "px-2"
        } ${active || open ? "text-ink" : "text-muted hover:text-ink hover:bg-ink/[0.04]"}`}
      >
        {active && (
          <motion.span
            layoutId="navbar-pill"
            className="glass absolute inset-0 rounded-xl bg-ink/[0.08] border border-line/[0.08]"
            transition={{ type: "spring", stiffness: 400, damping: 34 }}
          />
        )}
        <MoreHorizontal size={16} strokeWidth={1.9} className="relative z-10 shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Ещё разделы"
          className="pop-in glass-float absolute right-0 top-[calc(100%+8px)] w-52 z-50 p-1.5 rounded-xl bg-surface2/85 backdrop-blur-[16px] border border-line/10"
        >
            {items.map((item, i) => {
              const index = offset + i;
              const isActive = selected === index;
              return (
                <button
                  key={item.label}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onSelect(index);
                  }}
                  className={`w-full flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[13px] text-left transition-colors ${
                    isActive ? "bg-ink/[0.07] text-ink font-medium" : "text-ink/85 hover:bg-ink/[0.06]"
                  }`}
                >
                  <item.Icon
                    size={15}
                    strokeWidth={1.9}
                    className={`shrink-0 ${isActive ? "text-accentText" : "opacity-75"}`}
                  />
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
