import { useEffect, useRef, useState } from "react";
import {
  UserRound,
  Settings,
  Users,
  UserPlus,
  Palette,
  LogOut,
  Trash2,
  Check,
  ChevronLeft,
  Lock,
} from "lucide-react";
import Avatar from "./Avatar";
import { useProfileStore } from "../store/profileStore";
import { DENSITIES, PRESETS, useThemeStore, type Density } from "../store/themeStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import { APP_NAME, APP_VERSION } from "../lib/app";
import type { Profile } from "../services/profiles";

type View = "root" | "accounts" | "theme" | "pin" | "delete";

interface Props {
  profile: Profile;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onAddAccount: () => void;
}

const rowClass =
  "w-full flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[13px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors text-left";

function Row({
  Icon,
  label,
  hint,
  onClick,
  danger,
  trailing,
}: {
  Icon: typeof UserRound;
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      tabIndex={-1}
      onClick={onClick}
      className={`${rowClass} ${danger ? "text-red-400 hover:text-red-300" : ""}`}
    >
      <Icon size={15} strokeWidth={1.9} className="shrink-0 opacity-75" />
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] text-faint tnum">{hint}</span>}
      {trailing}
    </button>
  );
}

/**
 * Меню по клику на аватар в топбаре: профиль, настройки, переключение
 * аккаунтов, быстрая тема и выход. Внутри — несколько «экранов» панели,
 * как это делают в Arc/Linear, чтобы не смешивать аккаунты и настройки
 * в один плоский список.
 */
export default function ProfileMenu({ profile, onOpenProfile, onOpenSettings, onAddAccount }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("root");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pendingProfile, setPendingProfile] = useState<Profile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const profiles = useProfileStore((s) => s.profiles);
  const switchTo = useProfileStore((s) => s.switchTo);
  const signOut = useProfileStore((s) => s.signOut);
  const remove = useProfileStore((s) => s.remove);
  const restore = useProfileStore((s) => s.restore);

  const { presetId, setPreset, colors, setAccentRgb, density, setDensity } = useThemeStore();
  const accentBefore = useRef<string | null>(null);
  const [accentInput, setAccentInput] = useState(`#${colors.accent.split(" ").map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`);

  useEffect(() => {
    setAccentInput(`#${colors.accent.split(" ").map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`);
  }, [colors.accent]);

  // Закрытие по клику вне панели и по Esc с возвратом фокуса на аватар
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Стрелки внутри меню (паттерн APG menu-button)
  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next === -1 ? items.length - 1 : next]?.focus();
  }

  function openMenu() {
    setOpen(true);
    setView("root");
    setPin("");
    setPinError(null);
    setConfirmDelete(false);
    sounds.open();
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
  }

  function closeMenu() {
    sounds.close();
    setOpen(false);
  }

  async function pickAccount(target: Profile) {
    if (target.pin) {
      setPendingProfile(target);
      setPin("");
      setPinError(null);
      setView("pin");
      return;
    }
    const previous = profile.id;
    await switchTo(target.id);
    setOpen(false);
    sounds.save();
    toast({
      title: `Аккаунт: @${target.username}`,
      action: { label: "Отменить", run: () => switchTo(previous) },
    });
  }

  async function submitPin() {
    if (!pendingProfile) return;
    if (pin !== pendingProfile.pin) {
      setPinError("Неверный PIN");
      sounds.error();
      return;
    }
    const previous = profile.id;
    const target = pendingProfile;
    await switchTo(target.id);
    setOpen(false);
    sounds.save();
    toast({
      title: `Аккаунт: @${target.username}`,
      action: { label: "Отменить", run: () => switchTo(previous) },
    });
  }

  const others = profiles.filter((p) => p.id !== profile.id);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu();
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Меню профиля"
        className="rounded-full focus-visible:outline-offset-4"
      >
        <Avatar profile={profile} size={32} className="hover:ring-line/25 transition-shadow" />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Профиль"
          onKeyDown={onPanelKeyDown}
          className="pop-in glass-float absolute right-0 top-[calc(100%+8px)] w-72 z-50 p-1.5 rounded-xl bg-surface2/85 backdrop-blur-[16px] border border-line/10"
        >
            {view === "root" && (
              <>
                <div className="flex items-center gap-3 px-2.5 py-2.5">
                  <Avatar profile={profile} size={40} />
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold truncate">{profile.displayName}</p>
                    <p className="text-[12px] text-muted truncate">
                      @{profile.username}
                      {profile.guest && <span className="ml-1.5 text-amber-400/90">гость</span>}
                    </p>
                  </div>
                </div>
                <div className="h-px bg-line/[0.08] my-1.5" />
                <Row Icon={UserRound} label="Профиль" onClick={() => { setOpen(false); onOpenProfile(); }} />
                <Row Icon={Settings} label="Настройки" onClick={() => { setOpen(false); onOpenSettings(); }} />
                <div className="h-px bg-line/[0.08] my-1.5" />
                <Row
                  Icon={Users}
                  label="Сменить аккаунт"
                  hint={others.length > 0 ? String(others.length + 1) : undefined}
                  onClick={() => setView("accounts")}
                  trailing={<ChevronLeft size={14} className="rotate-180 opacity-40" />}
                />
                <Row Icon={UserPlus} label="Добавить аккаунт" onClick={() => { setOpen(false); onAddAccount(); }} />
                <Row
                  Icon={Palette}
                  label="Тема и акцент"
                  onClick={() => setView("theme")}
                  trailing={<ChevronLeft size={14} className="rotate-180 opacity-40" />}
                />
                <div className="h-px bg-line/[0.08] my-1.5" />
                <Row
                  Icon={LogOut}
                  label="Выйти"
                  onClick={() => {
                    const previous = profile.id;
                    setOpen(false);
                    sounds.close();
                    void signOut();
                    toast({
                      title: "Вы вышли из профиля",
                      description: `@${profile.username}`,
                      action: { label: "Отменить", run: () => switchTo(previous) },
                    });
                  }}
                />
                <Row Icon={Trash2} label="Удалить профиль" danger onClick={() => setView("delete")} />
                <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-faint">
                  {APP_NAME} · {APP_VERSION} · данные хранятся локально
                </p>
              </>
            )}

            {view === "accounts" && (
              <>
                <PanelHeader title="Аккаунты" onBack={() => setView("root")} />
                <div className="max-h-64 overflow-y-auto">
                  {[profile, ...others].map((p) => (
                    <button
                      key={p.id}
                      role="menuitem"
                      tabIndex={-1}
                      aria-checked={p.id === profile.id}
                      onClick={() => void pickAccount(p)}
                      className="w-full flex items-center gap-2.5 h-11 px-2.5 rounded-lg hover:bg-ink/[0.06] transition-colors text-left"
                    >
                      <Avatar profile={p} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] truncate">{p.displayName}</span>
                        <span className="block text-[11px] text-faint truncate">
                          @{p.username}
                          {p.guest && " · гость"}
                          {p.pin && " · PIN"}
                        </span>
                      </span>
                      {p.id === profile.id && <Check size={15} className="text-accentText shrink-0" />}
                    </button>
                  ))}
                </div>
                <div className="h-px bg-line/[0.08] my-1.5" />
                <Row Icon={UserPlus} label="Добавить аккаунт" onClick={() => { setOpen(false); onAddAccount(); }} />
              </>
            )}

            {view === "theme" && (
              <>
                <PanelHeader title="Тема и акцент" onBack={() => setView("root")} />
                <div className="px-2.5 py-1">
                  <p className="text-[11px] text-faint mb-2">Пресет</p>
                  <div className="grid grid-cols-4 gap-2">
                    {Object.entries(PRESETS).map(([id, preset]) => (
                      <button
                        key={id}
                        onClick={() => {
                          if (id === presetId) return;
                          const previous = presetId;
                          setPreset(id);
                          sounds.save();
                          toast({
                            title: `Тема: ${preset.label}`,
                            action: { label: "Отменить", run: () => setPreset(previous) },
                          });
                        }}
                        title={preset.label}
                        className={`h-8 rounded-lg border transition-colors ${
                          presetId === id ? "border-accentText" : "border-line/10 hover:border-line/25"
                        }`}
                        style={{ background: `rgb(${preset.colors.app})` }}
                      />
                    ))}
                  </div>
                  <p className="text-[11px] text-faint mt-3 mb-2">Свой акцент</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={accentInput}
                      onChange={(e) => {
                        const hex = e.target.value;
                        setAccentInput(hex);
                        setAccentRgb(
                          parseInt(hex.slice(1, 3), 16),
                          parseInt(hex.slice(3, 5), 16),
                          parseInt(hex.slice(5, 7), 16)
                        );
                      }}
                      className="w-9 h-8 rounded-lg bg-transparent border border-line/10 cursor-pointer"
                      aria-label="Свой акцентный цвет"
                      onPointerDown={() => {
                        accentBefore.current = colors.accent;
                      }}
                      onPointerUp={() => {
                        const before = accentBefore.current;
                        accentBefore.current = null;
                        const now = useThemeStore.getState().colors.accent;
                        if (!before || before === now) return;
                        sounds.save();
                        toast({
                          title: "Акцентный цвет изменён",
                          description: `rgb(${now})`,
                          action: {
                            label: "Отменить",
                            run: () => {
                              const [pr, pg, pb] = before.split(" ").map(Number);
                              setAccentRgb(pr, pg, pb);
                            },
                          },
                        });
                      }}
                    />
                    <span className="text-[12px] text-muted tnum uppercase">{accentInput}</span>
                  </div>
                  <p className="text-[11px] text-faint mt-3 mb-2">Плотность</p>
                  <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-inset border border-line/[0.07]">
                    {DENSITIES.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => {
                          if (d.id === density) return;
                          const previous = density;
                          setDensity(d.id as Density);
                          sounds.save();
                          toast({
                            title: `Плотность: ${d.label}`,
                            action: { label: "Отменить", run: () => setDensity(previous) },
                          });
                        }}
                        className={`h-7 rounded-md text-[12px] transition-colors ${
                          density === d.id ? "bg-surface text-ink shadow-panel" : "text-muted hover:text-ink"
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="h-px bg-line/[0.08] my-1.5" />
                <Row Icon={Settings} label="Все настройки" onClick={() => { setOpen(false); onOpenSettings(); }} />
              </>
            )}

            {view === "pin" && pendingProfile && (
              <>
                <PanelHeader title={`PIN для @${pendingProfile.username}`} onBack={() => setView("accounts")} />
                <div className="px-2.5 py-1">
                  <div className="flex items-center gap-2 mb-2 text-muted text-[12px]">
                    <Lock size={13} /> Локальный PIN — защита от случайного входа
                  </div>
                  <input
                    autoFocus
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    onKeyDown={(e) => e.key === "Enter" && void submitPin()}
                    inputMode="numeric"
                    placeholder="••••"
                    className="w-full h-9 px-3 rounded-lg bg-inset border border-line/[0.09] text-[13px] tracking-[0.3em] outline-none focus:border-accentText/60"
                  />
                  {pinError && <p className="text-[12px] text-red-400 mt-1.5">{pinError}</p>}
                  <button
                    onClick={() => void submitPin()}
                    className="mt-3 w-full h-9 rounded-lg bg-accent text-onAccent text-[13px] font-medium hover:bg-accentHover transition-colors"
                  >
                    Войти
                  </button>
                </div>
              </>
            )}

            {view === "delete" && (
              <>
                <PanelHeader title="Удалить профиль" onBack={() => setView("root")} />
                <div className="px-2.5 py-1">
                  <p className="text-[12px] text-muted leading-relaxed">
                    Профиль @{profile.username}, его плейлисты и статистика будут удалены с этого устройства.
                    Действие нельзя отменить.
                  </p>
                  <label className="flex items-center gap-2 mt-3 text-[12px] text-muted">
                    <input
                      type="checkbox"
                      checked={confirmDelete}
                      onChange={(e) => setConfirmDelete(e.target.checked)}
                      className="accent-red-500"
                    />
                    Понимаю, что данные удалятся
                  </label>
                  <button
                    disabled={!confirmDelete}
                    onClick={async () => {
                      const snapshot = { ...profile };
                      const next = others[0];
                      await remove(profile.id);
                      if (!next) await signOut();
                      setOpen(false);
                      sounds.off();
                      // Профиль можно вернуть: сохраняем его целиком для отката
                      toast({
                        title: `Профиль @${snapshot.username} удалён`,
                        tone: "danger",
                        action: { label: "Отменить", run: () => restore(snapshot) },
                      });
                    }}
                    className="mt-3 w-full h-9 rounded-lg bg-red-500/90 hover:bg-red-500 disabled:opacity-40 disabled:hover:bg-red-500/90 text-white text-[13px] font-medium transition-colors"
                  >
                    Удалить профиль
                  </button>
                </div>
              </>
            )}
        </div>
      )}
    </div>
  );
}

function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-2">
      <button
        onClick={onBack}
        aria-label="Назад"
        className="-ml-1 p-1 rounded-md text-muted hover:text-ink hover:bg-ink/[0.06] transition-colors"
      >
        <ChevronLeft size={15} />
      </button>
      <span className="text-[13px] font-semibold truncate">{title}</span>
    </div>
  );
}
