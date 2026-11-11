import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Ticket,
  Trash2,
  Users,
} from "lucide-react";
import { GhostButton, PrimaryButton } from "../components/Modal";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import {
  adminDevices,
  adminInviteUses,
  adminSetOpen,
  adminStats,
  adminUsers,
  inviteCreate,
  inviteList,
  inviteRevoke,
  type AdminDevice,
  type AdminStats,
  type AdminUser,
  type Invite,
  type InviteUse,
} from "../services/supabase";

type Tab = "overview" | "people" | "devices" | "codes";

interface Props {
  onClose: () => void;
}

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "overview", label: "Обзор", icon: ShieldCheck },
  { id: "people", label: "Люди", icon: Users },
  { id: "devices", label: "Устройства", icon: Laptop },
  { id: "codes", label: "Коды", icon: Ticket },
];

/**
 * Админ-панель владельца.
 *
 * Доступ решает сервер: все `admin_*` функции начинаются с проверки
 * `is_app_owner()` и отвечают `not_allowed` всем остальным, даже если экран
 * как-то открыть. Здесь только показ данных и действия владельца: сводка,
 * список людей, привязки компьютеров и коды приглашений.
 */
export default function AdminPanel({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [people, setPeople] = useState<AdminUser[] | null>(null);
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [uses, setUses] = useState<InviteUse[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [note, setNote] = useState("");
  const [days, setDays] = useState(14);
  const [maxUses, setMaxUses] = useState(1);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [nextStats, nextPeople, nextDevices, nextUses, nextInvites] = await Promise.all([
        adminStats(),
        adminUsers(),
        adminDevices(),
        adminInviteUses(),
        inviteList(),
      ]);
      setStats(nextStats);
      setPeople(nextPeople);
      setDevices(nextDevices);
      setUses(nextUses);
      setInvites(nextInvites);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setError(
        text.toLowerCase().includes("not_allowed")
          ? "Сервер не признал тебя владельцем: проверь, что почта аккаунта внесена в app_admins"
          : text
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const date = (value: string | null | undefined) => {
    if (!value) return "—";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "—";
    return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
  };

  const createCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await inviteCreate(note.trim() || null, days, maxUses);
      sounds.save();
      setInvites((current) => [created, ...(current ?? [])]);
      setNote("");
      setStats((current) =>
        current ? { ...current, invitesActive: current.invitesActive + 1 } : current
      );
      toast({ title: "Код создан", description: created.code });
    } catch (e) {
      sounds.error();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    setBusy(true);
    try {
      const changed = await inviteRevoke(code);
      if (changed) {
        sounds.close();
        setInvites((current) =>
          (current ?? []).map((item) => (item.code === code ? { ...item, status: "revoked" } : item))
        );
        toast({ title: "Код отозван", description: code });
      }
    } catch (e) {
      sounds.error();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      sounds.save();
      toast({ title: "Код скопирован", description: code });
    } catch {
      toast({ title: "Не удалось скопировать", description: code });
    }
  };

  const toggleOpen = async () => {
    if (!stats) return;
    setBusy(true);
    try {
      const next = await adminSetOpen(!stats.registrationOpen);
      sounds.save();
      setStats({ ...stats, registrationOpen: next });
      toast({
        title: next ? "Регистрация открыта всем" : "Регистрация только по кодам",
        description: next ? "Кто угодно может создать аккаунт" : "Без кода не войти",
      });
    } catch (e) {
      sounds.error();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cards = useMemo(
    () =>
      stats
        ? [
            { label: "Аккаунтов", value: stats.users },
            { label: "Активных кодов", value: stats.invitesActive },
            { label: "Регистраций по кодам", value: stats.invitesUsed },
            { label: "Привязанных устройств", value: stats.devices },
          ]
        : [],
    [stats]
  );

  return (
    <div className="absolute inset-0 z-[60] bg-app overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-5 h-14 bg-app/95 backdrop-blur-[12px] border-b border-line/[0.06]">
        <button
          type="button"
          onClick={() => {
            sounds.close();
            onClose();
          }}
          className="group flex items-center gap-1.5 h-9 pl-2 pr-3.5 ui-control hairline text-[13px] text-muted hover:text-ink hover:border-line/20 transition-colors"
        >
          <KeyRound size={14} className="text-faint group-hover:text-ink transition-colors" />
          Назад
        </button>
        <span className="text-[12px] text-faint hidden sm:block">Админ-панель · только владелец</span>
        <GhostButton
          onClick={() => void refresh()}
          disabled={busy}
          className="ml-auto flex items-center gap-1.5"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Обновить
        </GhostButton>
      </div>

      <div className="px-5 py-6 max-w-[1040px]">
              <h1 className="title-page">Админ-панель</h1>

        <div className="mt-4 flex flex-wrap items-center gap-1">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = id === tab;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  sounds.open();
                  setTab(id);
                }}
                aria-pressed={active}
                className={`flex items-center gap-1.5 h-9 px-3 ui-control text-[13px] transition-colors ${
                  active ? "bg-accent/[0.12] text-ink" : "text-muted hover:text-ink"
                }`}
              >
                <Icon size={14} className={active ? "text-accentText" : "text-faint"} />
                {label}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mt-4 ui-tile hairline bg-surface px-4 py-3 text-[12px] text-red-400 leading-relaxed">
            {error}
          </div>
        )}

        {tab === "overview" && (
          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {cards.map((card) => (
                <div key={card.label} className="ui-tile hairline bg-surface px-4 py-3">
                  <p className="text-[11px] text-faint">{card.label}</p>
                  <p className="text-[22px] font-semibold tnum mt-1">{card.value}</p>
                </div>
              ))}
            </div>

            <div className="ui-panel hairline bg-surface px-4 py-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] text-ink">Регистрация для всех</p>
                <p className="text-[12px] text-muted mt-0.5 leading-snug">
                  {stats?.registrationOpen
                    ? "Включена: аккаунт может создать кто угодно, код не нужен"
                    : "Выключена: пускает только действующий код приглашения"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void toggleOpen()}
                disabled={busy || !stats}
                aria-pressed={!!stats?.registrationOpen}
                className={`shrink-0 h-9 px-4 ui-control text-[13px] border transition-colors ${
                  stats?.registrationOpen
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
                    : "border-line/[0.12] text-ink/85 hover:bg-ink/[0.06]"
                }`}
              >
                {stats?.registrationOpen ? "Закрыть" : "Открыть всем"}
              </button>
            </div>

            <p className="text-[11px] text-faint leading-relaxed">
              Открытая регистрация отключает защиту приглашений: любой, у кого есть сборка, создаст
              аккаунт. Держи закрытой, пока не попросишь об этом.
            </p>
          </div>
        )}

        {tab === "people" && (
          <div className="mt-5 ui-panel hairline bg-surface overflow-hidden">
            <div className="grid grid-cols-[1.2fr_1.2fr_0.7fr_0.5fr] gap-3 px-4 py-2.5 text-[11px] text-faint border-b border-line/[0.06]">
              <span>Аккаунт</span>
              <span>Почта</span>
              <span>Регистрация</span>
              <span className="text-right">Устройств</span>
            </div>
            {(people ?? []).length === 0 && (
              <p className="px-4 py-6 text-[12px] text-faint">Пока никого — кроме тебя</p>
            )}
            {(people ?? []).map((person) => (
              <div
                key={person.userId}
                className="grid grid-cols-[1.2fr_1.2fr_0.7fr_0.5fr] gap-3 px-4 py-3 text-[12px] setting-row items-center"
              >
                <span className="min-w-0 truncate">
                  {person.username ? `@${person.username}` : "—"}
                  {person.displayName && person.displayName !== person.username && (
                    <span className="text-muted"> · {person.displayName}</span>
                  )}
                </span>
                <span className="min-w-0 truncate text-muted">{person.email || "—"}</span>
                <span className="text-muted">{date(person.createdAt)}</span>
                <span className="text-right tnum text-muted">{person.devices}</span>
              </div>
            ))}
          </div>
        )}

        {tab === "devices" && (
          <div className="mt-5 ui-panel hairline bg-surface overflow-hidden">
            <p className="px-4 py-3 text-[12px] text-muted leading-relaxed setting-row">
              HWID — отпечаток компьютера (SHA-256, сам GUID в базу не попадает). По нему человек
              может вспомнить аккаунт, если забыл пароль и ник.
            </p>
            {(devices ?? []).length === 0 && (
              <p className="px-4 py-6 text-[12px] text-faint">Устройства ещё не привязывались</p>
            )}
            {(devices ?? []).map((device, index) => (
              <div
                key={`${device.hwid}-${index}`}
                className="px-4 py-3 setting-row flex items-center gap-3 text-[12px]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    {device.username ? `@${device.username}` : "—"}
                    <span className="text-muted"> · {device.email || "без почты"}</span>
                  </p>
                  <p className="text-[11px] text-faint mt-0.5 font-mono truncate">{device.hwid}</p>
                </div>
                <div className="text-right text-[11px] text-faint shrink-0">
                  <p>привязан {date(device.createdAt)}</p>
                  <p>видели {date(device.lastSeenAt)}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "codes" && (
          <div className="mt-5 space-y-4">
            <div className="ui-panel hairline bg-surface p-4 space-y-3">
              <label className="block">
                <span className="block text-[12px] text-muted mb-1">Заметка (кому)</span>
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="например: другу на работу"
                  spellCheck={false}
                  className="input h-11 w-full"
                />
              </label>
              <div className="flex items-end gap-3">
                <label className="block w-28">
                  <span className="block text-[12px] text-muted mb-1">Срок, дней</span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={days}
                    onChange={(event) => setDays(Math.max(1, Math.min(365, Number(event.target.value) || 1)))}
                    className="input h-11 w-full"
                  />
                </label>
                <label className="block w-36">
                  <span className="block text-[12px] text-muted mb-1">Использований</span>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={maxUses}
                    onChange={(event) =>
                      setMaxUses(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))
                    }
                    className="input h-11 w-full"
                  />
                </label>
                <PrimaryButton
                  onClick={() => void createCode()}
                  disabled={busy}
                  className="press h-11 ui-control flex items-center gap-1.5"
                >
                  <Ticket size={14} /> Создать код
                </PrimaryButton>
              </div>
            </div>

            <div className="space-y-2">
              {(invites ?? []).map((invite) => (
                <div
                  key={invite.code}
                  className="ui-tile border border-line/[0.10] bg-inset px-3.5 py-3 flex items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] tracking-wide truncate">{invite.code}</span>
                      <span
                        className={`text-[11px] px-1.5 py-0.5 rounded-full shrink-0 ${
                          invite.status === "active"
                            ? "bg-emerald-400/15 text-emerald-300"
                            : "bg-ink/[0.06] text-faint"
                        }`}
                      >
                        {invite.status === "active"
                          ? "активен"
                          : invite.status === "used"
                            ? "использован"
                            : invite.status === "expired"
                              ? "истёк"
                              : "отозван"}
                      </span>
                    </div>
                    <p className="text-[11px] text-faint mt-0.5 truncate">
                      {invite.usedCount}/{invite.maxUses} · до {date(invite.expiresAt)}
                      {invite.note ? ` · ${invite.note}` : ""}
                    </p>
                  </div>
                  <GhostButton
                    onClick={() => void copy(invite.code)}
                    aria-label="Скопировать код"
                    title="Скопировать код"
                    className="flex items-center gap-1.5 shrink-0"
                  >
                    <Copy size={13} />
                  </GhostButton>
                  {invite.status === "active" && (
                    <button
                      type="button"
                      onClick={() => void revoke(invite.code)}
                      disabled={busy}
                      aria-label="Отозвать"
                      title="Отозвать"
                      className="w-9 h-9 ui-control bg-inset border border-line/[0.07] flex items-center justify-center text-muted hover:text-ink hover:border-line/20 transition-colors disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              {(invites ?? []).length === 0 && (
                <p className="text-[12px] text-faint">Кодов пока нет</p>
              )}
            </div>

            <div className="ui-panel hairline bg-surface overflow-hidden">
              <p className="title-section px-4 pt-3.5 pb-2">Журнал регистраций</p>
              {(uses ?? []).length === 0 && (
                <p className="px-4 pb-4 text-[12px] text-faint">Пока никто не регистрировался</p>
              )}
              {(uses ?? []).map((use, index) => (
                <div
                  key={`${use.code}-${index}`}
                  className="px-4 py-2.5 setting-row flex items-center gap-3 text-[12px]"
                >
                  <span className="font-mono text-[12px] text-muted shrink-0">{use.code}</span>
                  <span className="min-w-0 flex-1 truncate">{use.email || "—"}</span>
                  <span className="text-[11px] text-faint shrink-0">{date(use.usedAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
