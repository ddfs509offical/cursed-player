import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  UserRoundPlus,
  Ghost,
  ShieldCheck,
  HardDrive,
  Users,
  LogIn,
  Mail,
  Lock,
  ChevronRight,
  KeyRound,
  Loader2,
} from "lucide-react";
import { GhostButton, PrimaryButton } from "../components/Modal";
import Avatar from "../components/Avatar";
import { useProfileStore } from "../store/profileStore";
import { useSyncStore } from "../store/syncStore";
import { suggestUsername, validateEmail, validateUsername, type Profile } from "../services/profiles";
import {
  inviteCheck,
  isInvitesUnsupported,
  machineHwid,
  deviceLookup,
  recoverPassword,
  registrationOpen,
  type DeviceAccount,
} from "../services/supabase";
import { pickImage } from "../services/media";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import { APP_NAME, APP_VERSION } from "../lib/app";
import { useAppIcon } from "../lib/appIcon";

interface Props {
  mode: "first" | "add";
  /** Вызывается, когда действие выполнено: приложение покажет заставку. */
  onDone: (status: string) => void;
  onBack?: () => void;
}

type Step = "key" | "signup" | "confirm" | "cloudLogin" | "recover" | "register" | "login" | "pin";

/**
 * Первый запуск — доступ по ключу.
 *
 * Раньше здесь предлагалось «создать аккаунт» с юзернеймом и аватаром и можно
 * было войти гостем: профиль жил только на устройстве. Теперь вход один —
 * приглашение: ключ проверяется на сервере (RPC `invite_check`), аккаунт
 * создаётся там же, а серверный триггер `enforce_registration_invite` не даст
 * зарегистрироваться без действующего ключа даже в обход приложения.
 *
 * Юзернейм больше не спрашиваем: он собирается из почты (до первой точки),
 * поменять можно в профиле. Экраны «добавить ещё профиль» внутри приложения
 * остались прежними — там по-прежнему своя форма с ником.
 */
export default function Welcome({ mode, onDone, onBack }: Props) {
  const appIcon = useAppIcon();
  const profiles = useProfileStore((s) => s.profiles);
  const create = useProfileStore((s) => s.create);
  const remove = useProfileStore((s) => s.remove);
  const switchTo = useProfileStore((s) => s.switchTo);

  const [step, setStep] = useState<Step>(mode === "add" ? "register" : "key");
  const [pendingProfile, setPendingProfile] = useState<Profile | null>(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  // Доступ по ключу: код, будущая почта/пароль аккаунта и состояние запросов
  const [gateCode, setGateCode] = useState("");
  const [gateEmail, setGateEmail] = useState("");
  const [gatePassword, setGatePassword] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  /** Аккаунт, привязанный к этому компьютеру (для «забыл пароль и ник»). */
  const [deviceAccount, setDeviceAccount] = useState<DeviceAccount | null>(null);
  const [deviceChecked, setDeviceChecked] = useState(false);
  const [deviceUnsupported, setDeviceUnsupported] = useState(false);
  const [recoverSent, setRecoverSent] = useState(false);
  /**
   * Регистрация открыта владельцем: тогда ключ не нужен, форма создания
   * аккаунта показывается сразу. Флаг спрашиваем у сервера — раньше он жил
   * только в базе, и экран всё равно требовал код.
   */
  const [openRegistration, setOpenRegistration] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState(suggestUsername());
  const [email, setEmail] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Временное ограничение беты: пока на устройстве есть профиль @developer,
   * новые локальные профили создавать нельзя. Кнопка «У меня есть доступ»
   * снимает блюр без пароля: профили и так лежат только на этом устройстве.
   */
  const [profilesUnlocked, setProfilesUnlocked] = useState(false);

  /** Есть ли уже профиль владельца — по нему и определяется блокировка. */
  const developerExists = profiles.some((profile) => profile.username.trim().toLowerCase() === "developer");
  const profilesLocked = developerExists && !profilesUnlocked;

  useEffect(() => {
    sounds.open();
  }, []);

  /**
   * Узнаём у сервера, открыта ли регистрация. Если открыта — сразу показываем
   * форму создания аккаунта, без ключа: флаг ставит владелец в админ-панели.
   */
  useEffect(() => {
    if (mode !== "first") return;
    let cancelled = false;
    void registrationOpen().then((open) => {
      if (cancelled || !open) return;
      setOpenRegistration(true);
      setStep("signup");
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  /** Выполняет действие и отдаёт приложению текст для заставки. */
  async function run(status: string, action: () => Promise<void>) {
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      sounds.error();
      setStep(mode === "add" ? "register" : "key");
      return;
    }
    onDone(status);
  }

  async function chooseAvatar() {
    setError(null);
    sounds.open();
    try {
      const picked = await pickImage("avatar");
      if (picked) setAvatar(picked);
    } catch (e) {
      sounds.error();
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function goRegister() {
    sounds.open();
    setError(null);
    setStep("register");
  }

  function goLogin() {
    sounds.open();
    setPin("");
    setPinError(null);
    setStep("login");
  }

  /* ───────────────────── Доступ по ключу (первый запуск) ───────────────────── */

  /**
   * Юзернейм из почты: до первой точки, только допустимые символы, 3–20 знаков.
   * Спрашивать его отдельно больше не нужно — поменять можно в профиле.
   */
  function usernameFromEmail(address: string): string {
    const base = address
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9._]/g, "")
      .slice(0, 20);
    const candidate = base.length >= 3 ? base : `listener${Math.floor(Math.random() * 900 + 100)}`;
    const taken = new Set(profiles.map((item) => item.username.toLowerCase()));
    let name = candidate;
    let suffix = 1;
    while (taken.has(name)) {
      name = `${candidate.slice(0, 18)}${suffix}`;
      suffix += 1;
    }
    return name;
  }

  /** Шаг 1: код проверяем на сервере — он же спишет использование при регистрации. */
  async function submitKey() {
    const code = gateCode.trim().toUpperCase();
    setGateError(null);
    if (code.replace(/-/g, "").length < 8) {
      sounds.error();
      setGateError("Введи ключ целиком: 12 символов, обычно с дефисами");
      return;
    }
    setGateBusy(true);
    try {
      const ok = await inviteCheck(code);
      if (!ok) {
        sounds.error();
        setGateError("Ключ не подходит: он истёк, отозван или уже использован. Попроси новый");
        return;
      }
      sounds.save();
      setGateCode(code);
      setStep("signup");
    } catch (e) {
      sounds.error();
      const text = e instanceof Error ? e.message : String(e);
      setGateError(
        isInvitesUnsupported(text)
          ? "Сервер пока не принимает ключи: на проекте не применена миграция приглашений"
          : `Не удалось проверить ключ: ${text}`
      );
    } finally {
      setGateBusy(false);
    }
  }

  /**
   * Общая часть после успешного входа в аккаунт: локальный профиль этого
   * устройства. Ник берём из почты, аватар и био человек поставит сам.
   */
  async function finishAccount(address: string, nick?: string) {
    const username = nick ?? usernameFromEmail(address);
    const profile = await create({
      username,
      displayName: username,
      email: address,
      avatar: null,
      guest: false,
    });
    // Профиль в облаке: по нику человека найдут в разделе «Люди»
    await useSyncStore.getState().saveProfileToCloud().catch(() => undefined);
    sounds.save();
    toast({
      title: "Аккаунт готов",
      description: `@${profile.username} · ключ принят`,
    });
    onDone("Входим…");
  }

  /** Шаг 2: аккаунт на сервере. Ключ уезжает в метаданных регистрации. */
  async function submitGateSignUp() {
    setGateError(null);
    const emailCheck = validateEmail(gateEmail);
    if (!emailCheck.ok || !emailCheck.value) {
      sounds.error();
      setGateError(emailCheck.error ?? "Нужна почта — на неё придёт подтверждение");
      return;
    }
    if (gatePassword.length < 6) {
      sounds.error();
      setGateError("Пароль минимум 6 символов");
      return;
    }
    setGateBusy(true);
    try {
      const result = await useSyncStore
        .getState()
        .signUp(emailCheck.value, gatePassword, usernameFromEmail(emailCheck.value), gateCode);
      if (result.needsConfirmation) {
        setStep("confirm");
        return;
      }
      if (!result.ok) {
        sounds.error();
        setGateError(
          result.registrationClosed
            ? "Сервер не принял ключ: он истёк или уже использован"
            : result.error || "Не удалось создать аккаунт"
        );
        return;
      }
      await finishAccount(emailCheck.value);
    } catch (e) {
      sounds.error();
      setGateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGateBusy(false);
    }
  }

  /**
   * «Забыл пароль и ник»: спрашиваем сервер, к какому аккаунту привязан этот
   * компьютер (по HWID), и показываем почту. Дальше — обычное письмо сброса.
   */
  async function lookupDevice() {
    sounds.open();
    setGateError(null);
    setDeviceChecked(false);
    setDeviceUnsupported(false);
    setGateBusy(true);
    setStep("recover");
    try {
      const hwid = await machineHwid();
      if (!hwid) {
        setGateError("Не удалось определить устройство: привязки на этой системе нет");
        setDeviceChecked(true);
        return;
      }
      const found = await deviceLookup(hwid);
      setDeviceAccount(found);
      setDeviceChecked(true);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (isInvitesUnsupported(text)) {
        setDeviceUnsupported(true);
      } else {
        setGateError(text);
      }
      setDeviceChecked(true);
    } finally {
      setGateBusy(false);
    }
  }

  /** Письмо со ссылкой сброса пароля на почту привязанного аккаунта. */
  async function sendRecover() {
    if (!deviceAccount?.email) return;
    setGateBusy(true);
    setGateError(null);
    try {
      await recoverPassword(deviceAccount.email);
      sounds.save();
      setRecoverSent(true);
    } catch (e) {
      sounds.error();
      setGateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGateBusy(false);
    }
  }

  /** Вход в уже существующий аккаунт — ключ для этого не нужен. */
  async function submitGateSignIn() {
    setGateError(null);
    const emailCheck = validateEmail(gateEmail);
    if (!emailCheck.ok || !emailCheck.value) {
      sounds.error();
      setGateError("Введи почту аккаунта");
      return;
    }
    if (!gatePassword) {
      sounds.error();
      setGateError("Введи пароль");
      return;
    }
    setGateBusy(true);
    try {
      const result = await useSyncStore.getState().signIn(emailCheck.value, gatePassword);
      if (!result.ok) {
        sounds.error();
        setGateError(result.error || "Не удалось войти: проверь почту и пароль");
        return;
      }
      // Если облачного профиля ещё нет, локальный создаём сами
      if (!useProfileStore.getState().profiles.length) {
        await finishAccount(emailCheck.value);
      } else {
        sounds.save();
        onDone("Входим…");
      }
    } catch (e) {
      sounds.error();
      setGateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGateBusy(false);
    }
  }

  async function submitRegister(guest: boolean) {
    setError(null);
    const finalUsername = guest ? `guest${Math.floor(Math.random() * 9000 + 1000)}` : username;
    const usernameCheck = validateUsername(finalUsername);
    if (!usernameCheck.ok) {
      sounds.error();
      setError(usernameCheck.error ?? "Проверь имя пользователя");
      return;
    }
    const emailCheck = validateEmail(guest ? "" : email);
    if (!emailCheck.ok) {
      sounds.error();
      setError(emailCheck.error ?? "Проверь почту");
      return;
    }

    setBusy(true);
    await run(guest ? "Входим как гость…" : "Создаём профиль…", async () => {
      const profile = await create({
        username: usernameCheck.value,
        displayName: guest ? "Гость" : displayName.trim() || usernameCheck.value,
        bio: guest ? "" : bio.trim(),
        email: guest ? null : emailCheck.value || null,
        avatar: avatar.trim() || null,
        guest,
      });
      sounds.save();
      toast({
        title: `Профиль @${profile.username} создан`,
        description: guest ? "Гостевой режим без сохранения истории" : "Данные хранятся только на этом устройстве",
        action: { label: "Отменить", run: () => void remove(profile.id) },
      });
    });
    setBusy(false);
  }

  async function pickProfile(profile: Profile) {
    setPendingProfile(profile);
    if (profile.pin) {
      setPin("");
      setPinError(null);
      setStep("pin");
      return;
    }
    await run(`Входим в @${profile.username}…`, () => switchTo(profile.id));
  }

  async function submitPin() {
    if (!pendingProfile) return;
    if (pin !== pendingProfile.pin) {
      setPinError("Неверный PIN");
      sounds.error();
      return;
    }
    await run(`Входим в @${pendingProfile.username}…`, () => switchTo(pendingProfile.id));
  }

  // Первый запуск: пока нет аккаунта, приложение пускает только по ключу.
  if (mode === "first") {
    const heading =
      step === "key"
        ? "Ключ приглашения"
        : step === "signup"
          ? "Создать аккаунт"
          : step === "confirm"
            ? "Подтверди почту"
            : step === "recover"
              ? "Вспомнить аккаунт"
              : "Вход";
    const subtitle =
      step === "key"
        ? "Проект только по приглашениям. Ключ выдаёт владелец: без него аккаунт создать нельзя."
        : step === "signup"
          ? openRegistration
            ? "Регистрация открыта — ключ не нужен. Почта и пароль, имя пользователя подставим из почты."
            : "Ключ принят. Остались почта и пароль — имя пользователя подставим из почты."
          : step === "confirm"
            ? `Письмо ушло на ${gateEmail}. Открой ссылку из письма и вернись сюда.`
            : step === "recover"
              ? "Проверяем, к какому аккаунту привязан этот компьютер. Пароль при этом не нужен."
              : "Введи почту и пароль аккаунта — ключ для входа не нужен.";

    return (
      <div className="h-screen bg-app text-ink flex flex-col items-center px-6 pb-8 relative overflow-hidden">
        <DragBar />

        <div className="relative w-full max-w-[420px] my-auto">
          <div className="flex items-center gap-2 mb-7">
            <img src={appIcon} alt="" className="w-9 h-9 rounded-xl border border-line/[0.08]" />
            <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
            <span className="ml-1 text-[10px] text-faint border border-line/[0.12] rounded px-1.5 py-0.5">
              {APP_VERSION}
            </span>
          </div>

          <motion.div
            key={step}
            initial={{ y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
          >
              <h1 className="title-page">{heading}</h1>
            <p className="text-[13px] text-muted mt-2 leading-relaxed">{subtitle}</p>

            <div className="mt-6 ui-panel hairline bg-surface p-5">
              {step === "key" && (
                <div className="space-y-3">
                  <label className="block">
                    <span className="block text-[12px] text-muted mb-1.5">Ключ</span>
                    <div className="flex items-center gap-2">
                      <KeyRound size={15} className="text-faint shrink-0" />
                      <input
                        autoFocus
                        value={gateCode}
                        onChange={(event) => setGateCode(event.target.value.toUpperCase())}
                        onKeyDown={(event) => event.key === "Enter" && void submitKey()}
                        placeholder="ABCD-EFGH-JKLM"
                        spellCheck={false}
                        autoComplete="off"
                        className="input h-11 flex-1 font-mono tracking-[0.08em]"
                      />
                    </div>
                  </label>
                  {gateError && <p className="text-[12px] text-red-400 leading-snug">{gateError}</p>}
                  <PrimaryButton
                    onClick={() => void submitKey()}
                    disabled={gateBusy}
                    className="press w-full h-11 ui-control flex items-center justify-center gap-2"
                  >
                    {gateBusy ? <Loader2 size={15} className="animate-spin" /> : null}
                    {gateBusy ? "Проверяю…" : "Продолжить"}
                  </PrimaryButton>
                  <button
                    onClick={() => {
                      sounds.open();
                      setGateError(null);
                      setStep("cloudLogin");
                    }}
                    className="w-full text-[12px] text-muted hover:text-ink transition-colors flex items-center justify-center gap-1.5"
                  >
                    <LogIn size={13} /> Уже есть аккаунт — войти
                  </button>
                  {/* Профили, созданные раньше, никуда не делись: человек мог
                      выйти из профиля на этом устройстве. Ключ нужен только
                      новым, поэтому старым оставляем короткий путь назад. */}
                  {profiles.length > 0 && (
                    <button
                      onClick={goLogin}
                      className="w-full text-[12px] text-faint hover:text-ink transition-colors"
                    >
                      Профиль на этом устройстве · {profiles.length}
                    </button>
                  )}
                  <button
                    onClick={() => void lookupDevice()}
                    className="w-full text-[12px] text-faint hover:text-ink transition-colors"
                  >
                    Забыл пароль и ник — вспомнить по компьютеру
                  </button>
                </div>
              )}

              {step === "signup" && (
                <div className="space-y-3">
                  <label className="block">
                    <span className="block text-[12px] text-muted mb-1.5">Почта</span>
                    <div className="flex items-center gap-2">
                      <Mail size={15} className="text-faint shrink-0" />
                      <input
                        autoFocus
                        value={gateEmail}
                        onChange={(event) => setGateEmail(event.target.value)}
                        placeholder="you@example.com"
                        spellCheck={false}
                        autoComplete="email"
                        className="input h-11 flex-1"
                      />
                    </div>
                  </label>
                  <label className="block">
                    <span className="block text-[12px] text-muted mb-1.5">Пароль</span>
                    <div className="flex items-center gap-2">
                      <Lock size={15} className="text-faint shrink-0" />
                      <input
                        type="password"
                        value={gatePassword}
                        onChange={(event) => setGatePassword(event.target.value)}
                        onKeyDown={(event) => event.key === "Enter" && void submitGateSignUp()}
                        placeholder="Минимум 6 символов"
                        autoComplete="new-password"
                        className="input h-11 flex-1"
                      />
                    </div>
                  </label>
                  {gateError && <p className="text-[12px] text-red-400 leading-snug">{gateError}</p>}
                  <PrimaryButton
                    onClick={() => void submitGateSignUp()}
                    disabled={gateBusy}
                    className="press w-full h-11 ui-control flex items-center justify-center gap-2"
                  >
                    {gateBusy ? <Loader2 size={15} className="animate-spin" /> : null}
                    {gateBusy ? "Создаю…" : "Создать аккаунт"}
                  </PrimaryButton>
                  <p className="text-[11px] text-faint leading-relaxed">
                    Ник будет @{gateEmail ? usernameFromEmail(gateEmail) : "из-почты"} — поменять можно в
                    профиле. Пароль хранится только на сервере, в приложении его нет.
                  </p>
                  {/* Регистрация может быть открыта владельцем — тогда экран
                      ключа пропускается, и войти существующему аккаунту надо
                      дать путь отсюда. */}
                  <button
                    onClick={() => {
                      sounds.open();
                      setGateError(null);
                      setStep("cloudLogin");
                    }}
                    className="w-full text-[12px] text-muted hover:text-ink transition-colors"
                  >
                    Уже есть аккаунт — войти
                  </button>
                  {!openRegistration && (
                    <button
                      onClick={() => {
                        sounds.close();
                        setGateError(null);
                        setStep("key");
                      }}
                      className="w-full text-[12px] text-faint hover:text-ink transition-colors"
                    >
                      Назад к ключу
                    </button>
                  )}
                </div>
              )}

              {step === "confirm" && (
                <div className="space-y-3">
                  <p className="text-[12px] text-muted leading-relaxed">
                    Аккаунт создан, но пока не подтверждён. Пока почта не подтверждена, вход не
                    выполнится — так проект не пускает случайные адреса.
                  </p>
                  {gateError && <p className="text-[12px] text-red-400 leading-snug">{gateError}</p>}
                  <PrimaryButton
                    onClick={() => void submitGateSignIn()}
                    disabled={gateBusy}
                    className="press w-full h-11 ui-control flex items-center justify-center gap-2"
                  >
                    {gateBusy ? <Loader2 size={15} className="animate-spin" /> : null}
                    {gateBusy ? "Вхожу…" : "Я подтвердил — войти"}
                  </PrimaryButton>
                </div>
              )}

              {step === "cloudLogin" && (
                <div className="space-y-3">
                  <label className="block">
                    <span className="block text-[12px] text-muted mb-1.5">Почта</span>
                    <div className="flex items-center gap-2">
                      <Mail size={15} className="text-faint shrink-0" />
                      <input
                        autoFocus
                        value={gateEmail}
                        onChange={(event) => setGateEmail(event.target.value)}
                        placeholder="you@example.com"
                        spellCheck={false}
                        autoComplete="email"
                        className="input h-11 flex-1"
                      />
                    </div>
                  </label>
                  <label className="block">
                    <span className="block text-[12px] text-muted mb-1.5">Пароль</span>
                    <div className="flex items-center gap-2">
                      <Lock size={15} className="text-faint shrink-0" />
                      <input
                        type="password"
                        value={gatePassword}
                        onChange={(event) => setGatePassword(event.target.value)}
                        onKeyDown={(event) => event.key === "Enter" && void submitGateSignIn()}
                        placeholder="Пароль от аккаунта"
                        autoComplete="current-password"
                        className="input h-11 flex-1"
                      />
                    </div>
                  </label>
                  {gateError && <p className="text-[12px] text-red-400 leading-snug">{gateError}</p>}
                  <PrimaryButton
                    onClick={() => void submitGateSignIn()}
                    disabled={gateBusy}
                    className="press w-full h-11 ui-control flex items-center justify-center gap-2"
                  >
                    {gateBusy ? <Loader2 size={15} className="animate-spin" /> : null}
                    {gateBusy ? "Вхожу…" : "Войти"}
                  </PrimaryButton>
                  <button
                    onClick={() => {
                      sounds.close();
                      setGateError(null);
                      setStep("key");
                    }}
                    className="w-full text-[12px] text-muted hover:text-ink transition-colors"
                  >
                    Нужен ключ — назад
                  </button>
                </div>
              )}

              {step === "recover" && (
                <div className="space-y-3">
                  {!deviceChecked ? (
                    <p className="text-[12px] text-muted flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin text-faint" />
                      Смотрю привязку устройства…
                    </p>
                  ) : deviceUnsupported ? (
                    <p className="text-[12px] text-muted leading-relaxed">
                      Сервер пока не умеет привязку устройства: в проекте не применён
                      <span className="text-ink"> OWNER-TOOLS.sql</span>. Это делает владелец — в SQL
                      Editor проекта.
                    </p>
                  ) : deviceAccount ? (
                    <>
                      <div className="ui-tile border border-line/[0.10] bg-inset px-3.5 py-3">
                        <p className="text-[13px] text-ink truncate">
                          {deviceAccount.username ? `@${deviceAccount.username}` : "Аккаунт без ника"}
                        </p>
                        <p className="text-[12px] text-muted mt-0.5 truncate">
                          {deviceAccount.email || "почта не указана"}
                        </p>
                      </div>
                      {recoverSent ? (
                        <p className="text-[12px] text-emerald-300 leading-relaxed">
                          Письмо отправлено. Открой ссылку из него, задай новый пароль — и войди
                          здесь с этой почтой.
                        </p>
                      ) : (
                        <PrimaryButton
                          onClick={() => void sendRecover()}
                          disabled={gateBusy || !deviceAccount.email}
                          className="press w-full h-11 ui-control flex items-center justify-center gap-2"
                        >
                          {gateBusy ? <Loader2 size={15} className="animate-spin" /> : null}
                          Отправить ссылку для сброса пароля
                        </PrimaryButton>
                      )}
                      <button
                        onClick={() => {
                          sounds.open();
                          setGateEmail(deviceAccount.email);
                          setGatePassword("");
                          setGateError(null);
                          setStep("cloudLogin");
                        }}
                        className="w-full text-[12px] text-muted hover:text-ink transition-colors"
                      >
                        Помню пароль — войти с этой почтой
                      </button>
                    </>
                  ) : (
                    <p className="text-[12px] text-muted leading-relaxed">
                      Этот компьютер не привязан ни к одному аккаунту. Привязка появляется после
                      первого входа: если аккаунт был, но данные на устройстве стёрты — попроси у
                      владельца новый ключ и создай аккаунт заново.
                    </p>
                  )}

                  {gateError && <p className="text-[12px] text-red-400 leading-snug">{gateError}</p>}

                  <button
                    onClick={() => {
                      sounds.close();
                      setGateError(null);
                      setRecoverSent(false);
                      setDeviceChecked(false);
                      setDeviceUnsupported(false);
                      setDeviceAccount(null);
                      setStep("key");
                    }}
                    className="w-full text-[12px] text-muted hover:text-ink transition-colors"
                  >
                    Назад
                  </button>
                </div>
              )}
            </div>

          </motion.div>
        </div>
      </div>
    );
  }

  if (step === "login" || step === "pin") {
    return (
      <div className="h-screen bg-app text-ink flex flex-col items-center px-8 pb-8 relative overflow-hidden">
        <DragBar />

        <motion.div
          initial={{ y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 28 }}
          className="relative w-full max-w-sm my-auto"
        >
          <button
            onClick={() => {
              sounds.close();
              if (mode === "add" && onBack) onBack();
              else setStep("key");
            }}
            className="flex items-center gap-1 text-[12px] text-muted hover:text-ink transition-colors mb-5"
          >
            <ArrowLeft size={13} /> Назад
          </button>

          <div className="ui-panel hairline bg-surface p-6">
            <h1 className="text-[22px] font-semibold tracking-tight">
              {step === "pin" ? `PIN для @${pendingProfile?.username}` : "Выбери аккаунт"}
            </h1>
            <p className="text-[13px] text-muted mt-1.5">
              {step === "pin"
                ? "Локальный PIN — защита от случайного входа, не шифрование."
                : "Профили хранятся на этом устройстве."}
            </p>

            {step === "pin" ? (
              <div className="mt-6">
                <div className="flex items-center gap-2 mb-3 text-muted text-[12px]">
                  <Lock size={13} /> Введи PIN профиля
                </div>
                <input
                  autoFocus
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && void submitPin()}
                  inputMode="numeric"
                  placeholder="••••"
                  className="input h-12 rounded-xl tracking-[0.3em]"
                />
                {pinError && (
                  <motion.p
                    initial={{ y: -2 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                    className="text-[12px] text-red-400 mt-2"
                  >
                    {pinError}
                  </motion.p>
                )}
                <PrimaryButton onClick={() => void submitPin()} className="press w-full h-11 rounded-xl mt-4">
                  Войти
                </PrimaryButton>
              </div>
            ) : (
              <div className="mt-6 space-y-2">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    onClick={() => void pickProfile(profile)}
                    className="press w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-line/[0.07] bg-surface/40 hover:border-line/20 hover:bg-surface2/60 transition-colors text-left"
                  >
                    <Avatar profile={profile} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium truncate">{profile.displayName}</span>
                      <span className="block text-[12px] text-muted truncate">
                        @{profile.username}
                        {profile.email ? ` · ${profile.email}` : ""}
                        {profile.guest ? " · гость" : ""}
                      </span>
                    </span>
                    {profile.pin && <Lock size={13} className="text-faint shrink-0" />}
                    <ChevronRight size={15} className="text-faint shrink-0" />
                  </button>
                ))}

                {!profiles.length && (
                  <p className="text-[13px] text-muted text-center py-6">
                    Профилей пока нет — сначала создай аккаунт.
                  </p>
                )}

                <button
                  onClick={goRegister}
                  className="press w-full h-11 rounded-xl border border-line/[0.12] text-[13px] text-ink/85 hover:bg-ink/[0.06] transition-colors flex items-center justify-center gap-2"
                >
                  <UserRoundPlus size={15} /> Создать новый аккаунт
                </button>
              </div>
          )}
          </div>
        </motion.div>
      </div>
    );
  }

  // Шаг регистрации — тот же двухколоночный экран, что и раньше
  const initial = (displayName.trim() || username).charAt(0).toUpperCase();

  return (
    <div className="h-screen bg-app text-ink overflow-hidden grid grid-rows-[auto_1fr] grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
      <DragBar className="col-span-full" />
      <div className="relative hidden lg:flex flex-col justify-between p-10 border-r border-line/[0.07] overflow-hidden">

        <div className="relative flex items-center gap-2">
          <img src={appIcon} alt="" className="w-8 h-8 rounded-lg shrink-0" />
          <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
          <span className="ml-2 text-[10px] text-faint border border-line/[0.12] rounded px-1.5 py-0.5">
            {APP_VERSION}
          </span>
        </div>

        <motion.div
          initial={{ y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 240, damping: 28 }}
          className="relative max-w-md"
        >
          <h1 className="text-[30px] leading-tight font-semibold tracking-tight">Ещё один профиль</h1>
          <p className="text-[14px] text-muted mt-3 leading-relaxed">
            Дополнительный профиль на этом устройстве: свой список лайков и плейлистов. Аккаунт
            приложения уже создан — здесь только локальные данные.
          </p>

          <ul className="mt-7 space-y-3.5">
            <Feature Icon={HardDrive} title="Всё локально" text="Профили, настройки и картинки хранятся в SQLite" />
            <Feature
              Icon={Users}
              title="Несколько аккаунтов"
              text="Рабочий и личный профиль — переключение в один клик"
            />
            <Feature
              Icon={ShieldCheck}
              title="PIN по желанию"
              text="Локальная защита от случайного входа, не шифрование"
            />
          </ul>
        </motion.div>

        <p className="relative text-[11px] text-faint">
          Почта нужна только для профиля: подтверждение появится, когда будет сервер.
        </p>
      </div>

      <div className="relative flex flex-col justify-center px-8 py-10 overflow-y-auto overflow-x-hidden">
        {/* Пятна под стеклом: без них blur на ровном фоне читается серой плашкой */}

        <div className="lg:hidden flex items-center gap-2 mb-8">
          <img src={appIcon} alt="" className="w-8 h-8 rounded-lg shrink-0" />
          <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
        </div>

        <button
          onClick={() => {
            sounds.close();
            if (mode === "add" && onBack) onBack();
            else setStep("key");
          }}
          className="absolute top-6 right-8 flex items-center gap-1 text-[12px] text-muted hover:text-ink transition-colors"
        >
          <ArrowLeft size={13} /> Назад
        </button>

        <motion.div
          initial={{ y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 28, delay: 0.05 }}
          className="ui-panel hairline bg-surface w-full max-w-md mx-auto p-6"
        >
          <h2 className="text-[22px] font-semibold tracking-tight">Новый профиль</h2>
          <p className="text-[13px] text-muted mt-1.5 mb-6">
            Имя пользователя нужно для входа, остальное можно заполнить позже.
          </p>

          {/* Пока на устройстве есть @developer, форма создания закрыта: поля
              гасятся pointer-events-none, сверху лежит слой блюра с замком.
              «Как гость», «Войти» и «У меня есть доступ» — вне слоя. */}
          <div className={`relative ${profilesLocked ? "pointer-events-none select-none" : ""}`}>
            <div className="flex items-center gap-4 mb-5">
              {avatar ? (
                <img src={avatar} alt="" className="w-16 h-16 rounded-full object-cover border border-line/10" />
              ) : (
                <div className="w-16 h-16 rounded-full bg-inset border border-line/[0.09] flex items-center justify-center text-[20px] font-semibold text-faint">
                  {initial || <UserRoundPlus size={20} />}
                </div>
              )}
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => void chooseAvatar()}
                  className="press h-11 px-4 rounded-xl border border-line/[0.12] text-[13px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors"
                >
                  Выбрать фото
                </button>
                {avatar && (
                  <button
                    type="button"
                    onClick={() => setAvatar("")}
                    className="ml-2 text-[12px] text-muted hover:text-ink transition-colors"
                  >
                    Убрать
                  </button>
                )}
                <p className="text-[11px] text-faint mt-1.5">PNG, JPEG или WebP до 12 МБ</p>
              </div>
            </div>

            <div className="space-y-3.5">
              <label className="block">
                <span className="block text-[12px] text-muted mb-1.5">Отображаемое имя</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Как тебя показывать"
                  className="input h-11 rounded-xl"
                />
              </label>

              <label className="block">
                <span className="block text-[12px] text-muted mb-1.5">@username</span>
                <div className="flex items-center gap-2">
                  <span className="text-faint text-[13px]">@</span>
                  <input value={username} onChange={(event) => setUsername(event.target.value)} className="input h-11 rounded-xl flex-1" />
                </div>
                <span className="block text-[11px] text-faint mt-1">
                  Латиница, цифры, «_» и «.», 3–20 символов. Имя уникально на этом устройстве.
                </span>
              </label>

              <label className="block">
                <span className="block text-[12px] text-muted mb-1.5">Почта (необязательно)</span>
                <div className="flex items-center gap-2">
                  <Mail size={14} className="text-faint shrink-0" />
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    className="input h-11 rounded-xl flex-1"
                  />
                </div>
                <span className="block text-[11px] text-faint mt-1">
                  Хранится локально и видна только тебе; подтверждение появится вместе с сервером.
                </span>
              </label>

              <label className="block">
                <span className="block text-[12px] text-muted mb-1.5">О себе</span>
                <textarea
                  value={bio}
                  rows={2}
                  maxLength={200}
                  onChange={(event) => setBio(event.target.value)}
                  placeholder="Пара слов о вкусах"
                  className="input h-11 rounded-xl resize-none"
                />
              </label>

              <label className="block">
                <span className="block text-[12px] text-muted mb-1.5">PIN (необязательно)</span>
                <input
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  placeholder="4–6 цифр"
                  className="input h-11 rounded-xl"
                />
              </label>

              {error && (
                <motion.p
                  initial={{ y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                  className="text-[12px] text-red-400"
                >
                  {error}
                </motion.p>
              )}

              <div className="flex items-center gap-2 pt-1">
                <PrimaryButton
                  disabled={busy}
                  onClick={() => void submitRegister(false)}
                  className="press h-11 rounded-xl flex items-center gap-1.5"
                >
                  <UserRoundPlus size={15} /> Создать профиль
                </PrimaryButton>
                {!profilesLocked && (
                  <GhostButton
                    disabled={busy}
                    onClick={() => void submitRegister(true)}
                    className="press h-11 rounded-xl flex items-center gap-1.5"
                  >
                    <Ghost size={15} /> Как гость
                  </GhostButton>
                )}
              </div>

              {!profilesLocked && (
                <div className="pt-3 border-t border-line/[0.07]">
                  <button
                    onClick={goLogin}
                    className="text-[12px] text-muted hover:text-ink transition-colors"
                  >
                    Уже есть аккаунт? <span className="text-accentText">Войти</span>
                  </button>
                </div>
              )}
            </div>

            {/* Слой не перехватывает клики: под ним уже ничего не нажать —
                поля выключены pointer-events-none. */}
            {profilesLocked && (
              <div className="absolute inset-0 rounded-2xl bg-app/60 backdrop-blur-[6px] pointer-events-none flex flex-col items-center justify-center gap-1.5 px-6 text-center">
                <Lock size={22} className="text-muted" />
                <p className="text-[14px] font-medium">Создание профилей временно закрыто</p>
                <p className="text-[12px] text-muted max-w-[420px]">
                  Проект в бете: разрешён один профиль — @developer. По мере развития проекта ограничение будет
                  сниматься, и профилей можно будет создавать сколько угодно.
                </p>
              </div>
            )}
          </div>

          {/* Доступное и при закрытой форме: вход в существующий профиль, гость
              и снятие ограничения владельцем. */}
          {profilesLocked && (
            <div className="mt-4 flex flex-col items-center gap-2">
              <GhostButton
                disabled={busy}
                onClick={() => void submitRegister(true)}
                className="press h-11 rounded-xl flex items-center gap-1.5"
              >
                <Ghost size={15} /> Как гость
              </GhostButton>
              <button
                onClick={goLogin}
                className="text-[12px] text-muted hover:text-ink transition-colors"
              >
                Уже есть аккаунт? <span className="text-accentText">Войти</span>
              </button>
              <button
                onClick={() => {
                  sounds.open();
                  setProfilesUnlocked(true);
                }}
                className="text-[12px] text-muted hover:text-ink transition-colors"
              >
                У меня есть доступ
              </button>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

/**
 * Полоса перетаскивания окна. У окна нет системной рамки (decorations: false),
 * поэтому таскать его можно только за такие области. Работает как в TitleBar:
 * своя команда window_start_drag, потому что права плагина window закрыты ACL.
 * Кнопки и поля внутри полосы остаются кликабельными — перетаскивание с них
 * не начинается.
 */
function DragBar({ className = "" }: { className?: string }) {
  return (
    <div
      data-tauri-drag-region
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button, input, textarea, select, a, label")) return;
        // Гасим встроенный обработчик drag-region: он ходит в плагин window,
        // которому ACL права не выдаёт, и в консоли остаётся ошибка
        event.preventDefault();
        event.stopPropagation();
        void invoke("window_start_drag").catch(() => {});
      }}
      className={`h-12 w-full shrink-0 cursor-default select-none ${className}`}
    />
  );
}

function Feature({ Icon, title, text }: { Icon: typeof HardDrive; title: string; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="w-8 h-8 rounded-lg bg-ink/[0.06] text-ink/70 flex items-center justify-center shrink-0 mt-0.5">
        <Icon size={15} strokeWidth={1.9} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block text-[12px] text-muted leading-relaxed">{text}</span>
      </span>
    </li>
  );
}
