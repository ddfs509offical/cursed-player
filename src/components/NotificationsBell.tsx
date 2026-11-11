import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bell, CheckCheck, Cloud, Download, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useErrorStore } from "../store/errorStore";
import { useOfflineStore } from "../store/offlineStore";
import { useSyncStore } from "../store/syncStore";
import { useProfileStore } from "../store/profileStore";
import { sounds } from "../lib/sounds";

/** Отметка последнего прочтения: всё, что новее, показываем точкой. */
const SEEN_KEY = "music_hub_notices_seen_at";

type NoticeKind = "error" | "offline" | "sync" | "account";

interface Notice {
  id: string;
  at: number;
  kind: NoticeKind;
  title: string;
  description: string;
  /** Запись ведёт в журнал ошибок: Настройки → Ошибки. */
  opensErrors?: boolean;
}

const ICONS: Record<NoticeKind, LucideIcon> = {
  error: AlertTriangle,
  offline: Download,
  sync: Cloud,
  account: UserRound,
};

/** Свечение иконки по типу события — как у остальных акцентов приложения. */
const TONES: Record<NoticeKind, string> = {
  error: "bg-red-500/15 text-red-400",
  offline: "bg-accent/15 text-accentText",
  sync: "bg-emerald-500/15 text-emerald-400",
  account: "bg-ink/[0.08] text-ink/80",
};

/** «5 минут назад», «вчера», «3 дня назад», дальше — дата. */
function relativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, "час", "часа", "часов")} назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} ${plural(days, "день", "дня", "дней")} назад`;
  return new Date(at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function plural(value: number, one: string, few: string, many: string): string {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * Колокольчик уведомлений в верхней панели. События берём только из того, что
 * приложение действительно записывает: журнал ошибок, реестр офлайн-файлов,
 * состояние синхронизации с облаком и профили. Ничего не выдумываем — если
 * события в системе нет, его здесь тоже нет.
 */
export default function NotificationsBell({ onOpenErrors }: { onOpenErrors: () => void }) {
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(() => {
    const raw = localStorage.getItem(SEEN_KEY);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  });
  const ref = useRef<HTMLDivElement>(null);

  const errors = useErrorStore((s) => s.errors);
  const offline = useOfflineStore((s) => s.list);
  const syncStatus = useSyncStore((s) => s.status);
  const profiles = useProfileStore((s) => s.profiles);

  const notices = useMemo(() => {
    const items: Notice[] = [];

    for (const error of errors) {
      items.push({
        id: `err-${error.id}`,
        at: error.at,
        kind: "error",
        title: error.title,
        description: [error.source, error.description].filter(Boolean).join(" · "),
        opensErrors: true,
      });
    }

    for (const file of offline) {
      const label = file.title?.trim() || file.fileName;
      items.push({
        id: `off-${file.trackId || file.path}`,
        at: file.savedAtMs,
        kind: "offline",
        title: "Трек сохранён офлайн",
        description: file.artist ? `${label} — ${file.artist}` : label,
      });
    }

    if (syncStatus.lastError) {
      items.push({
        id: "sync-error",
        at: syncStatus.lastSyncAtMs ?? 0,
        kind: "error",
        title: "Синхронизация с облаком не удалась",
        description: syncStatus.lastError,
        opensErrors: true,
      });
    } else if (syncStatus.lastSyncAtMs) {
      items.push({
        id: `sync-${syncStatus.lastSyncAtMs}`,
        at: syncStatus.lastSyncAtMs,
        kind: "sync",
        title: "Синхронизация с облаком завершена",
        description: syncStatus.email ? `Аккаунт: ${syncStatus.email}` : "Данные перенесены",
      });
    }

    for (const profile of profiles) {
      const at = Date.parse(profile.createdAt);
      if (!Number.isFinite(at)) continue;
      items.push({
        id: `acc-${profile.id}`,
        at,
        kind: "account",
        title: `Профиль @${profile.username} создан`,
        description: "Локальный аккаунт на этом устройстве",
      });
    }

    // Без времени запись показывать негде: сортировка и подписи времени
    return items.filter((item) => item.at > 0).sort((a, b) => b.at - a.at).slice(0, 30);
  }, [errors, offline, syncStatus, profiles]);

  const unread = notices.some((item) => item.at > seenAt);

  // Закрытие по клику вне панели и по Esc — как у остальных меню приложения
  useEffect(() => {
    if (!open) return;
    const close = () => {
      // Отметку прочтения ставим при закрытии: пока панель открыта, видно,
      // какие события новые
      markSeen();
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function markSeen() {
    const stamp = Date.now();
    try {
      localStorage.setItem(SEEN_KEY, String(stamp));
    } catch {
      // приватный режим: точка просто останется — это не повод падать
    }
    setSeenAt(stamp);
  }

  function toggle() {
    if (open) {
      sounds.close();
      markSeen();
      setOpen(false);
      return;
    }
    sounds.open();
    setOpen(true);
  }

  const now = Date.now();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        title="Уведомления"
        aria-label="Уведомления"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
          open ? "bg-ink/[0.08] text-ink" : "text-muted hover:text-ink hover:bg-ink/[0.06]"
        }`}
      >
        <Bell size={16} strokeWidth={1.9} />
        {unread && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accentText" />}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Уведомления"
          className="pop-in glass-float absolute right-0 top-[calc(100%+8px)] w-80 z-50 p-1.5 rounded-xl bg-surface2/85 backdrop-blur-[16px] border border-line/10"
        >
            <div className="flex items-center gap-2 px-2.5 py-2">
              <span className="text-[13px] font-semibold">Уведомления</span>
              {notices.length > 0 && (
                <button
                  onClick={markSeen}
                  className="ml-auto flex items-center gap-1 text-[11px] text-faint hover:text-ink transition-colors"
                >
                  <CheckCheck size={12} /> Прочитано
                </button>
              )}
            </div>
            <div className="h-px bg-line/[0.08] my-1" />

            {notices.length === 0 && (
              <p className="px-2.5 py-6 text-center text-[12px] text-faint">
                Пока ничего не происходило
              </p>
            )}

            <div className="max-h-80 overflow-y-auto">
              {notices.map((item) => {
                const Icon = ICONS[item.kind];
                const fresh = item.at > seenAt;
                return (
                  <button
                    key={item.id}
                    role="menuitem"
                    onClick={() => {
                      if (item.opensErrors) {
                        setOpen(false);
                        onOpenErrors();
                      }
                    }}
                    className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                      item.opensErrors ? "hover:bg-ink/[0.06]" : "cursor-default"
                    }`}
                  >
                    <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${TONES[item.kind]}`}>
                      <Icon size={14} strokeWidth={1.9} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={`flex-1 text-[12.5px] truncate ${fresh ? "font-medium" : ""}`}>
                          {item.title}
                        </span>
                        {fresh && <span className="w-1.5 h-1.5 rounded-full bg-accentText shrink-0" />}
                      </span>
                      <span className="block text-[11.5px] text-muted truncate">{item.description}</span>
                      <span className="block text-[11px] text-faint mt-0.5">{relativeTime(item.at, now)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
        </div>
      )}
    </div>
  );
}
