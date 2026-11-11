import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Pencil,
  ImagePlus,
  Clock,
  Headphones,
  Disc3,
  ListMusic,
  Link2,
  ExternalLink,
  BadgeCheck,
  Lock,
  Copy,
  Mail,
  EyeOff,
  Heart,
  Music2,
  AtSign,
  Image as ImageIcon,
  UserRound,
  Palette,
  Pin,
  Plus,
  Trash2,
  Check,
} from "lucide-react";
import Avatar from "../components/Avatar";
import Cover from "../components/Cover";
import Modal, { GhostButton, PrimaryButton, SettingRow, SettingPanel } from "../components/Modal";
import { useProfileStore, useProfilePrivacy, type ProfilePrivacy } from "../store/profileStore";
import { useThemeStore } from "../store/themeStore";
import { usePlayerStore, markFreshStream } from "../store/playerStore";
import { useFavoritesStore } from "../store/favoritesStore";
import { useLibraryStore } from "../store/libraryStore";
import {
  useHistoryStore,
  computeHistoryStats,
  durationsFromLibrary,
  type HistoryEntry,
} from "../store/historyStore";
import { findOfflineCopy } from "../store/offlineStore";
import { refreshServiceStream } from "../services/catalog";
import { offlineFailureMessage } from "../lib/offline";
import { errorText, logError } from "../store/errorStore";
import { seedFromString, themeCover } from "../lib/coverTone";
import { validateEmail, validateUsername, type Profile } from "../services/profiles";
import { fetchImage, pickImage } from "../services/media";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import { useSyncStore } from "../store/syncStore";

interface Props {
  profile: Profile;
  /** Открыть раздел «Люди»: поиск по юзернейму и чужие профили. */
  onOpenPeople?: () => void;
}

/**
 * Свой профиль владелец видит целиком: приватность управляет только чужим
 * взглядом, а не тем, что видит сам владелец.
 */
const OWNER_VIEW: ProfilePrivacy = {
  showStats: true,
  showRecent: true,
  showTopArtists: true,
  showLikes: true,
  showPlaylists: true,
  showBio: true,
  showAvatar: true,
  discoverable: true,
};

/**
 * Цвета профиля. Отдельной палитры у профиля нет: выбранный цвет — это акцент
 * приложения, поэтому он применяется сразу везде и сохраняется вместе с темой.
 */
const PROFILE_COLORS: { label: string; rgb: [number, number, number] }[] = [
  { label: "Фиолетовый", rgb: [109, 74, 238] },
  { label: "Синий", rgb: [56, 132, 255] },
  { label: "Бирюзовый", rgb: [45, 196, 190] },
  { label: "Зелёный", rgb: [52, 199, 123] },
  { label: "Янтарный", rgb: [245, 176, 65] },
  { label: "Оранжевый", rgb: [251, 146, 60] },
  { label: "Красный", rgb: [225, 29, 72] },
  { label: "Розовый", rgb: [244, 114, 182] },
];

/**
 * Значки профиля.
 *
 * Пока это витрина: условия получения ещё не написаны, поэтому в подсказке
 * стоит одна честная строка «тест» — вместо выдуманных правил. Когда правила
 * появятся, поменяется только поле `hint`.
 */
const BADGES: { id: string; label: string; Icon: typeof Clock }[] = [
  { id: "first-track", label: "Первый трек", Icon: Music2 },
  { id: "hundred", label: "100 прослушиваний", Icon: Disc3 },
  { id: "night", label: "Ночной слушатель", Icon: Clock },
  { id: "collector", label: "Собиратель", Icon: ListMusic },
  { id: "heart", label: "Щедрый на лайки", Icon: Heart },
  { id: "marathon", label: "Марафонец", Icon: Headphones },
];

/** Подпись к любому значку: правила ещё не заданы. */
const BADGE_HINT = "тест";
export default function ProfilePage({ profile, onOpenPeople }: Props) {
  const update = useProfileStore((s) => s.update);
  const profiles = useProfileStore((s) => s.profiles);
  const { trackTitle, trackArtist, isPlaying } = usePlayerStore();
  /** Цвет профиля = акцент интерфейса: один выбор на всё приложение. */
  const accent = useThemeStore((s) => s.colors.accent);
  const setAccentRgb = useThemeStore((s) => s.setAccentRgb);

  /**
   * Юзернейм и облако. Своя строка в публичной таблице `profiles` — это то,
   * по чему человека находят другие; здесь видно, опубликована ли она.
   */
  const sync = useSyncStore();
  const signedIn = sync.status.signedIn;

  /**
   * Приватность профиля. Свой профиль владелец видит полностью, поэтому
   * правила применяются только к чужому профилю: там выключенный пункт даёт
   * аккуратную заглушку «Скрыто владельцем профиля».
   */
  const activeId = useProfileStore((s) => s.activeId);
  const isOwner = profile.id === activeId;
  const storedPrivacy = useProfilePrivacy(profile.id);
  const privacy = isOwner ? OWNER_VIEW : storedPrivacy;
  const favorites = useFavoritesStore((s) => s.ids.length);
  const history = useHistoryStore((s) => s.entries);
  const libraryTracks = useLibraryStore((s) => s.tracks);

  /**
   * Статистика вычисляется из истории и только при её изменении: пересчёт на
   * каждый кадр здесь не нужен и только грел бы процессор.
   */
  const stats = useMemo(() => {
    const durationOf = durationsFromLibrary(libraryTracks);
    return computeHistoryStats(history, { days: 30, durationOf });
  }, [history, libraryTracks]);
  const week = stats.days.slice(-7);
  const weekPlays = week.reduce((sum, day) => sum + day.plays, 0);
  const weekSeconds = week.reduce((sum, day) => sum + day.minutes, 0) * 60;
  const monthPlays = stats.days.reduce((sum, day) => sum + day.plays, 0);
  const recent = history.slice(0, 8);
  const weekMax = Math.max(1, ...week.map((day) => day.plays));
  const monthMax = Math.max(1, ...stats.days.map((day) => day.plays));

  /** Включение трека прямо из профиля: офлайн-копия или свежая ссылка сервиса. */
  async function playFromHistory(entry: HistoryEntry) {
    const known = usePlayerStore.getState().queue.find((item) => item.id === entry.id);
    const track = known ?? {
      id: entry.id,
      path: entry.path,
      title: entry.title,
      artist: entry.artist,
      album: null,
      durationMs: entry.durationMs ?? 0,
      source: entry.source,
      cover: entry.cover,
    };
    try {
      const copy = track.source === "service" ? await findOfflineCopy(track.id) : null;
      if (track.source === "service" && !copy) {
        // Ссылка на поток живёт недолго: перед включением берём свежую
        const fresh = await refreshServiceStream(track);
        markFreshStream(fresh);
        usePlayerStore.getState().playNow(fresh);
        return;
      }
      usePlayerStore.getState().playNow(copy ?? track);
    } catch (e) {
      const message = offlineFailureMessage(e, false);
      sounds.error();
      logError("Не удалось включить трек из профиля", `${entry.title}: ${message}`, "профиль", errorText(e));
      toast({ title: "Не удалось включить трек", description: message, tone: "danger" });
    }
  }

  const [editOpen, setEditOpen] = useState(false);
  const [imageTarget, setImageTarget] = useState<"avatar" | "banner" | null>(null);
  const [bannerFailed, setBannerFailed] = useState(false);
  /** Открыли картинку из формы профиля — после неё возвращаем форму с черновиком. */
  const reopenEdit = useRef(false);

  // Новая ссылка на обложку должна снова пробовать загрузиться
  useEffect(() => {
    setBannerFailed(false);
  }, [profile.banner]);

  const [imageUrl, setImageUrl] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  /** Файл с диска: Rust отдаёт уже уменьшенный data-URL. */
  async function chooseFile() {
    if (!imageTarget) return;
    setImageError(null);
    sounds.open();
    try {
      const picked = await pickImage(imageTarget);
      if (picked) setImageUrl(picked);
    } catch (e) {
      sounds.error();
      setImageError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Сохранение: ссылку сначала скачиваем (WebView не пустил бы из-за CORS). */
  async function saveImage() {
    if (!imageTarget) return;
    setImageError(null);
    const isBanner = imageTarget === "banner";
    const previous = isBanner ? profile.banner : profile.avatar;
    const raw = imageUrl.trim();
    let value: string | null = raw || null;
    if (raw && /^https?:\/\//i.test(raw)) {
      setImageBusy(true);
      try {
        value = await fetchImage(raw, imageTarget);
      } catch (e) {
        setImageBusy(false);
        sounds.error();
        setImageError(e instanceof Error ? e.message : String(e));
        return;
      }
      setImageBusy(false);
    }
    await update(profile.id, isBanner ? { banner: value } : { avatar: value });
    closeImage();
    sounds.save();
    toast({
      title: isBanner ? "Обложка обновлена" : "Фото профиля обновлено",
      action: {
        label: "Отменить",
        run: () => update(profile.id, isBanner ? { banner: previous } : { avatar: previous }),
      },
    });
  }

  /** Копирование ника в буфер обмена. */
  async function copyUsername() {
    try {
      await navigator.clipboard.writeText(`@${profile.username}`);
      sounds.save();
      toast({ title: "Имя пользователя скопировано", description: `@${profile.username}` });
    } catch {
      sounds.error();
      toast({ title: "Не удалось скопировать", tone: "danger" });
    }
  }

  /**
   * Цвет профиля — это акцент интерфейса: отдельной палитры у профиля нет,
   * поэтому выбор применяется сразу везде и запоминается в настройках темы.
   */
  function chooseAccent(color: { label: string; rgb: [number, number, number] }) {
    const before = useThemeStore.getState().colors.accent;
    if (before === color.rgb.join(" ")) return;
    setAccentRgb(color.rgb[0], color.rgb[1], color.rgb[2]);
    sounds.save();
    toast({
      title: `Цвет профиля: ${color.label}`,
      description: "Тот же акцент — во всём приложении",
      action: {
        label: "Отменить",
        run: () => {
          const [pr, pg, pb] = before.split(" ").map(Number);
          setAccentRgb(pr, pg, pb);
        },
      },
    });
  }

  /** Опубликовать свой профиль в облако сейчас, не дожидаясь автоотправки. */
  async function publishUsername() {
    const ok = await useSyncStore.getState().saveProfileToCloud();
    if (ok) {
      sounds.save();
      toast({ title: "Профиль опубликован", description: `@${profile.username} — тебя найдут в «Людях»` });
    } else {
      sounds.error();
      toast({
        title: "Профиль не опубликован",
        description: useSyncStore.getState().cloudError ?? undefined,
        tone: "danger",
      });
    }
  }
  const [draft, setDraft] = useState({
    displayName: profile.displayName,
    username: profile.username,
    bio: profile.bio,
    email: profile.email ?? "",
    genres: profile.genres.join(", "),
    links: profile.links.map((link) => ({ ...link })),
    pin: profile.pin ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  function openEdit() {
    setDraft({
      displayName: profile.displayName,
      username: profile.username,
      bio: profile.bio,
      email: profile.email ?? "",
      genres: profile.genres.join(", "),
      links: profile.links.map((link) => ({ ...link })),
      pin: profile.pin ?? "",
    });
    setError(null);
    setEditOpen(true);
    sounds.open();
  }

  /** Открыть окно картинки поверх формы и вернуться в форму после сохранения. */
  function openImage(target: "avatar" | "banner", fromForm: boolean) {
    reopenEdit.current = fromForm;
    if (fromForm) setEditOpen(false);
    setImageUrl(target === "banner" ? profile.banner ?? "" : profile.avatar ?? "");
    setImageError(null);
    setImageTarget(target);
    sounds.open();
  }

  /** Закрыть окно картинки: из формы пришли — возвращаемся в форму с черновиком. */
  function closeImage() {
    setImageTarget(null);
    if (reopenEdit.current) {
      reopenEdit.current = false;
      setEditOpen(true);
    }
  }

  /** Ссылки в форме: список строк вместо текста «Название | адрес». */
  function updateLink(index: number, patch: { label?: string; url?: string }) {
    setDraft((current) => ({
      ...current,
      links: current.links.map((link, i) => (i === index ? { ...link, ...patch } : link)),
    }));
  }

  function addLink() {
    setDraft((current) =>
      current.links.length >= 6 ? current : { ...current, links: [...current.links, { label: "", url: "" }] }
    );
  }

  function removeLink(index: number) {
    setDraft((current) => ({ ...current, links: current.links.filter((_, i) => i !== index) }));
  }

  async function saveProfile() {
    const validation = validateUsername(draft.username);
    if (!validation.ok) {
      setError(validation.error ?? "Проверь имя пользователя");
      return;
    }
    const emailCheck = validateEmail(draft.email);
    if (!emailCheck.ok) {
      sounds.error();
      setError(emailCheck.error ?? "Проверь почту");
      return;
    }
    if (profiles.some((p) => p.id !== profile.id && p.username === validation.value)) {
      setError("Это имя уже занято на устройстве");
      return;
    }
    const links = draft.links
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => link.label && link.url)
      .slice(0, 6);

    const before = {
      displayName: profile.displayName,
      username: profile.username,
      bio: profile.bio,
      email: profile.email,
      genres: profile.genres,
      links: profile.links,
      pin: profile.pin,
    };

    await update(profile.id, {
      displayName: draft.displayName.trim() || validation.value,
      username: validation.value,
      bio: draft.bio.trim(),
      email: emailCheck.value || null,
      genres: draft.genres
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean)
        .slice(0, 8),
      links: links.slice(0, 6),
      pin: draft.pin.trim() ? draft.pin.trim() : null,
    });
    setEditOpen(false);
    sounds.save();
    toast({
      title: "Профиль сохранён",
      description: `@${validation.value}`,
      action: { label: "Отменить", run: () => update(profile.id, before) },
    });
  }

  async function openLink(url: string) {
    try {
      const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      await openExternal(normalized);
    } catch {
      // если внешний браузер недоступен — просто игнорируем нажатие
    }
  }

  const bannerBackground = profile.banner ? undefined : themeCover(seedFromString(profile.username));

  return (
    <div className="space-y-[var(--gap-section)]">
      <section>
        <div className="relative h-44 rounded-2xl overflow-hidden border border-line/[0.07] group">
          {profile.banner && !bannerFailed && privacy.showAvatar ? (
            <img
              src={profile.banner}
              alt=""
              onError={() => setBannerFailed(true)}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full" style={{ background: bannerBackground }} />
          )}
          <div className="absolute inset-0 bg-black/35" />
          {!privacy.showAvatar && (
            <span className="absolute top-3 left-3 h-7 px-2.5 rounded-lg bg-black/45 backdrop-blur text-white/85 text-[11px] flex items-center gap-1.5">
              <EyeOff size={12} /> Скрыто владельцем профиля
            </span>
          )}
          <button
            onClick={() => openImage("banner", false)}
            className="absolute top-3 right-3 h-8 px-3 rounded-lg bg-black/45 backdrop-blur text-white text-[12px] flex items-center gap-1.5 opacity-90 hover:opacity-100 hover:bg-black/60 transition-all"
          >
            <ImagePlus size={14} /> Изменить обложку
          </button>
        </div>

        <div className="flex items-end gap-4 px-[var(--page-pad)] -mt-14 relative">
          <div className="relative">
            <Avatar profile={privacy.showAvatar ? profile : { ...profile, avatar: null }} size={112} ring />
            {/* Кнопка правки всегда на виду — иначе её никто не находит */}
            <button
              onClick={() => openImage("avatar", false)}
              aria-label="Изменить фото профиля"
              title="Изменить фото профиля"
              className="absolute -bottom-0.5 -right-0.5 w-9 h-9 rounded-full bg-surface3 border border-line/[0.14] shadow-lift text-ink/80 hover:text-ink hover:bg-surface2 flex items-center justify-center transition-colors"
            >
              <ImagePlus size={15} />
            </button>
          </div>

          <div className="min-w-0 flex-1 pb-1">
            <div className="flex items-center gap-2">
              <h1 className="text-[24px] leading-tight font-semibold tracking-tight truncate">{profile.displayName}</h1>
              {!profile.guest && <BadgeCheck size={17} className="text-accentText shrink-0" />}
              {profile.guest && (
                <span className="text-[11px] text-amber-400/90 border border-amber-400/25 rounded px-1.5 py-0.5 shrink-0">
                  гость
                </span>
              )}
            </div>
            <div className="mt-0.5 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <p className="text-[13px] text-muted">@{profile.username}</p>
                {privacy.discoverable ? (
                  <button
                    onClick={() => void copyUsername()}
                    aria-label="Скопировать имя пользователя"
                    title="Скопировать @username"
                    className="p-1 rounded-md text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
                  >
                    <Copy size={12} />
                  </button>
                ) : (
                  <span className="text-[11px] text-faint" title="Владелец запретил искать его по юзернейму">
                    · ник не для поиска
                  </span>
                )}
              </div>
              {profile.email && (
                <span className="flex items-center gap-1.5 text-[12px] text-faint">
                  <Mail size={12} />
                  {profile.email}
                </span>
              )}
                {/* Значки — сразу под ником, как в Discord: мелкие иконки в
                    строке, без подписей. Что даёт каждый — в подсказке. */}
                <div className="flex items-center gap-1.5 pt-0.5">
                  {BADGES.map((badge) => (
                    <span
                      key={badge.id}
                      title={BADGE_HINT}
                      aria-label={badge.label}
                      className="w-5 h-5 rounded-md bg-surface3/80 border border-line/[0.07] flex items-center justify-center text-faint hover:text-ink transition-colors"
                    >
                      <badge.Icon size={12} strokeWidth={1.9} />
                    </span>
                  ))}
                </div>
            </div>
          </div>

          <div className="flex items-center gap-2 pb-1">
            {profile.pin && (
              <span title="Профиль защищён PIN" className="text-faint">
                <Lock size={14} />
              </span>
            )}
            <GhostButton onClick={openEdit} className="flex items-center gap-1.5">
              <Pencil size={13} /> Редактировать
            </GhostButton>
          </div>
        </div>
      </section>

      <AnimatePresence initial={false}>
        {(isPlaying || profile.nowPlaying) && (
          <motion.div
            initial={{ y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="h-5 flex items-center"
          >
            <div className="flex items-center gap-2 text-[12px] text-muted py-0.5">
              <span className="relative flex w-2 h-2 shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald-400/45 animate-ping" />
                <span className="relative w-2 h-2 rounded-full bg-emerald-400" />
              </span>
              <span className="truncate">
                {isPlaying ? `Слушает сейчас: ${trackTitle}` : `Слушал: ${profile.nowPlaying}`}
                {isPlaying && trackArtist ? <span className="text-faint"> — {trackArtist}</span> : null}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* О себе: владелец может закрыть описание от других */}
      {privacy.showBio ? (
        profile.bio ? (
          <p className="text-[14px] leading-relaxed text-ink/75 max-w-2xl">{profile.bio}</p>
        ) : null
      ) : (
        <HiddenNote what="Описание профиля" />
      )}

      {/* Юзернейм в облаке: по нему находят другие люди (раздел «Люди») */}
      <section className="rounded-xl border border-line/[0.07] bg-surface px-4 py-3.5">
        <div className="flex items-start gap-3">
          <span className="w-8 h-8 rounded-lg bg-inset border border-line/[0.07] flex items-center justify-center text-faint shrink-0">
            <AtSign size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[13px] font-medium truncate">@{profile.username}</p>
              {sync.cloudProfile?.username ? (
                sync.cloudProfile.username === profile.username ? (
                  <span className="text-[11px] text-emerald-400/90">опубликован в облаке</span>
                ) : (
                  <span className="text-[11px] text-amber-300/90">
                    в облаке занят @{sync.cloudProfile.username}
                  </span>
                )
              ) : signedIn ? (
                <span className="text-[11px] text-faint">ещё не в облаке</span>
              ) : null}
            </div>
            <p className="text-[12px] text-muted mt-1 leading-relaxed">
              {!signedIn
                ? "Войди в аккаунт — и тебя найдут по этому нику в «Людях»."
                : privacy.discoverable
                  ? "Другие найдут тебя по этому нику в «Людях»."
                  : "Поиск по нику выключен: в «Людях» тебя не покажут."}
            </p>
            {sync.cloudError && <p className="text-[12px] text-amber-300 mt-1">{sync.cloudError}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {signedIn && sync.cloudProfile?.username !== profile.username && (
              <GhostButton onClick={() => void publishUsername()} disabled={sync.cloudBusy}>
                {sync.cloudBusy ? "Сохраняю…" : "Опубликовать"}
              </GhostButton>
            )}
            {onOpenPeople && <GhostButton onClick={onOpenPeople}>Найти людей</GhostButton>}
          </div>
        </div>
      </section>

      {/* Цвет профиля: тот же акцент, что у интерфейса — ряд плиток вместо пилюль */}
      <section>
        <h2 className="text-[13px] font-semibold tracking-tight mb-3">Цвет профиля</h2>
        <div className="ui-panel border border-line/[0.07] bg-surface p-4">
          <div className="flex items-center gap-2 flex-wrap">
            {PROFILE_COLORS.map((color) => {
              const value = color.rgb.join(" ");
              const active = accent === value;
              return (
                <button
                  key={color.label}
                  onClick={() => chooseAccent(color)}
                  aria-label={`Цвет профиля: ${color.label}`}
                  aria-pressed={active}
                  title={color.label}
                  className={`w-8 h-8 ui-control flex items-center justify-center transition-transform hover:scale-105 ${
                    active ? "ring-2 ring-offset-2 ring-accentText ring-offset-app" : "border border-line/[0.12]"
                  }`}
                  style={{ background: `rgb(${value})` }}
                >
                  {active && <Check size={14} className="text-onAccent" />}
                </button>
              );
            })}
          </div>
          <p className="text-[12px] text-muted mt-3 leading-relaxed">
            Красит кнопки и выделения всего интерфейса. Ещё вариант — в настройках, раздел
            «Интерфейс».
          </p>
        </div>
      </section>

      {/* Недавно слушал: последние треки из истории, без сети */}
      <section>
        <div className="flex items-end justify-between gap-4 mb-3">
          <h2 className="text-[13px] font-semibold tracking-tight">Недавно слушал</h2>
          {privacy.showRecent && recent.length > 0 && (
            <span className="text-[12px] text-faint">
              {recent.length} {plural(recent.length, "трек", "трека", "треков")}
            </span>
          )}
        </div>
        {!privacy.showRecent ? (
          <HiddenNote what="Недавно прослушанное" />
        ) : recent.length === 0 ? (
          <p className="text-[12px] text-faint">
            История пока пуста — включи любой трек, и он появится здесь.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {recent.map((entry, index) => (
              <motion.button
                key={entry.id}
                initial={{ y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, delay: index * 0.03, ease: [0.2, 0, 0, 1] }}
                onClick={() => void playFromHistory(entry)}
                className="flex items-center gap-3 p-2.5 rounded-xl border border-line/[0.07] bg-surface hover:border-line/20 hover:bg-surface2 transition-colors text-left group"
              >
                <Cover src={entry.cover} size={44} rounded="rounded-md" hoverIcon />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] truncate">{entry.title}</span>
                  <span className="block text-[12px] text-muted truncate">
                    {entry.artist ?? "Неизвестный исполнитель"}
                  </span>
                  <span className="block text-[11px] text-faint truncate">
                    {timeAgo(entry.at)} · {entry.plays}×
                  </span>
                </span>
              </motion.button>
            ))}
          </div>
        )}
      </section>

      {/* Статистика: считается из истории, владелец может её скрыть */}
      <section>
        <div className="flex items-end justify-between gap-4 mb-3">
          <h2 className="text-[13px] font-semibold tracking-tight">Статистика</h2>
          {privacy.showStats && stats.lastAt && (
            <span className="text-[12px] text-faint">последнее прослушивание {timeAgo(stats.lastAt)}</span>
          )}
        </div>
        {!privacy.showStats ? (
          <HiddenNote what="Статистика прослушивания" />
        ) : (
          <>
            <div className="rounded-xl border border-line/[0.07] bg-surface p-5 grid grid-cols-4 divide-x divide-line/[0.06]">
              <Stat Icon={Clock} value={formatListenTime(stats.seconds)} label="Прослушано" />
              <Stat Icon={Headphones} value={String(stats.unique)} label="Треков" />
              <Stat Icon={Disc3} value={String(stats.plays)} label="Прослушиваний" />
              {privacy.showTopArtists ? (
                <Stat Icon={Music2} value={stats.topArtist ?? "—"} label="Любимый исполнитель" />
              ) : (
                <StatHidden label="Любимый исполнитель" />
              )}
            </div>

            <div className="mt-2 rounded-xl border border-line/[0.07] bg-surface p-5 grid grid-cols-[1fr_auto_auto] gap-5 items-center">
              <div className="min-w-0 flex items-center gap-3">
                {stats.topTrack ? (
                  <>
                    <Cover src={stats.topTrack.cover} size={44} rounded="rounded-md" />
                    <span className="min-w-0">
                      <span className="block text-[11px] uppercase tracking-[0.1em] text-faint">
                        Любимый трек
                      </span>
                      <span className="block text-[13px] truncate mt-1">{stats.topTrack.title}</span>
                      <span className="block text-[12px] text-muted truncate">
                        {stats.topTrack.artist ?? "Неизвестный исполнитель"} · {stats.topTrackPlays}×
                      </span>
                    </span>
                  </>
                ) : (
                  <span className="text-[12px] text-faint">
                    Любимый трек появится, когда в истории наберётся музыка
                  </span>
                )}
              </div>
              {privacy.showLikes ? (
                <div className="pl-5 border-l border-line/[0.06]">
                  <Stat Icon={Heart} value={String(favorites)} label="В избранном" />
                </div>
              ) : (
                <div className="pl-5 border-l border-line/[0.06]">
                  <StatHidden label="Лайки" />
                </div>
              )}
              {privacy.showPlaylists ? (
                <div className="pl-5 border-l border-line/[0.06]">
                  <Stat Icon={ListMusic} value="0" label="Плейлистов" />
                </div>
              ) : (
                <div className="pl-5 border-l border-line/[0.06]">
                  <StatHidden label="Плейлисты" />
                </div>
              )}
            </div>

            <p className="text-[12px] text-faint mt-2 leading-relaxed">
              Время — фактически прослушанное: паузы, перемотка и обрыв потока не считаются.
              {stats.estimatedSeconds > 0 && (
                <>
                  {" "}Включения прошлых версий приложения времени не знали — они досчитаны по
                  длительности трека, где она известна: {formatListenTime(stats.estimatedSeconds)}.
                </>
              )}
              <br />
              Первое прослушивание: {formatMoment(stats.firstAt)} · последнее: {formatMoment(stats.lastAt)}.
            </p>
          </>
        )}
      </section>
      {/* Полоски по дням: сколько включений пришлось на каждый день */}
      <section>
        <div className="flex items-end justify-between gap-4 mb-3">
          <h2 className="text-[13px] font-semibold tracking-tight">За последние 7 дней</h2>
          {privacy.showStats && (
            <span className="text-[12px] text-faint">
              {weekPlays} включений · {formatListenTime(weekSeconds)}
            </span>
          )}
        </div>
        {!privacy.showStats ? (
          <HiddenNote what="Статистика за последние 7 дней" />
        ) : monthPlays === 0 ? (
          <p className="text-[12px] text-faint">
            Включений пока не было — полоски появятся, когда что-нибудь заиграет.
          </p>
        ) : (
          <>
            <div className="rounded-xl border border-line/[0.07] bg-surface p-4">
              <div className="grid grid-cols-7 gap-2">
                {week.map((day) => {
                  const height = day.plays > 0 ? Math.max(8, Math.round((day.plays / weekMax) * 100)) : 0;
                  return (
                    <div key={day.startMs} className="min-w-0">
                      <div
                        className="h-20 rounded-lg bg-ink/[0.04] flex items-end overflow-hidden"
                        title={`${formatDay(day.startMs)}: ${day.plays} включений · ~${Math.round(day.minutes)} мин`}
                      >
                        <div className="w-full rounded-t bg-accentText/70" style={{ height: `${height}%` }} />
                      </div>
                      <p className="mt-1.5 text-[11px] text-center text-faint truncate">
                        {weekdayShort(day.startMs)}
                      </p>
                      <p className="text-[11px] text-center text-muted tnum">{day.plays}</p>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-3">
              <p className="text-[11px] text-faint mb-1.5">Последние 30 дней</p>
              <div className="flex items-end gap-[3px] h-8">
                {stats.days.map((day) => {
                  const height = day.plays > 0 ? Math.max(10, Math.round((day.plays / monthMax) * 100)) : 4;
                  return (
                    <span
                      key={day.startMs}
                      title={`${formatDay(day.startMs)}: ${day.plays} включений`}
                      className={`flex-1 rounded-sm ${day.plays > 0 ? "bg-accentText/60" : "bg-ink/[0.10]"}`}
                      style={{ height: `${height}%` }}
                    />
                  );
                })}
              </div>
              <p className="text-[11px] text-faint mt-1.5">
                Полоски — включения по дням. Точные отметки времени хранятся для последних
                60 включений каждого трека; у записей прошлых версий включение попадает на день,
                когда трек слушали в последний раз.
              </p>
            </div>
          </>
        )}
      </section>

      <div className="grid grid-cols-2 gap-6">
        <section>
          <h2 className="text-[13px] font-semibold mb-3">Любимые жанры</h2>
          {profile.genres.length ? (
            <div className="flex flex-wrap gap-2">
              {profile.genres.map((genre) => (
                <span
                  key={genre}
                  className="h-7 px-3 rounded-lg bg-ink/[0.05] border border-line/[0.07] text-[12px] flex items-center"
                >
                  {genre}
                </span>
              ))}
            </div>
          ) : (
            <button onClick={openEdit} className="text-[12px] text-faint hover:text-ink transition-colors">
              Жанры не указаны — добавить
            </button>
          )}
        </section>

        <section>
          <h2 className="text-[13px] font-semibold mb-3">Ссылки</h2>
          {profile.links.length ? (
            <div className="flex flex-col gap-1">
              {profile.links.map((link) => (
                <motion.button
                  key={link.url}
                  whileHover={{ x: 2 }}
                  onClick={() => void openLink(link.url)}
                  className="flex items-center gap-2 h-8 text-[12px] text-ink/70 hover:text-ink transition-colors text-left"
                >
                  <Link2 size={13} className="shrink-0 opacity-60" />
                  <span className="truncate">{link.label}</span>
                  <ExternalLink size={11} className="shrink-0 opacity-40" />
                </motion.button>
              ))}
            </div>
          ) : (
            <button onClick={openEdit} className="text-[12px] text-faint hover:text-ink transition-colors">
              Ссылок нет — добавить
            </button>
          )}
        </section>
      </div>

      <p className="text-[12px] text-faint">
        Профиль создан{" "}
        {new Date(profile.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}
      </p>

      {/* Редактирование профиля: разделы, счётчики символов и один крупный акцент */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Редактировать профиль"
        description="@username виден другим; почта и PIN остаются на этом устройстве"
        footer={
          <div className="w-full">
            {/* Главное действие профиля: крупная кнопка во всю ширину формы,
                светлая на тёмном (цвет берётся из темы: ink поверх app) */}
            <button
              type="button"
              onClick={() => void saveProfile()}
              className="press h-12 w-full ui-control bg-ink text-app text-[14px] font-medium hover:bg-ink/90 transition-colors"
            >
              Сохранить профиль
            </button>
            <div className="mt-2 flex justify-center">
              <GhostButton onClick={() => setEditOpen(false)} className="border-0 text-muted hover:text-ink">
                Отмена
              </GhostButton>
            </div>
          </div>
        }
      >
        <div className="space-y-5 max-h-[65vh] overflow-y-auto pr-1">
          <FormSection
            title="Изображения"
            icon={ImageIcon}
            hint="Файл с диска или ссылка: картинка уменьшается и сжимается при сохранении"
          >
            <div className="flex items-center gap-3">
              <Avatar profile={profile} size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink">Аватар</p>
                <p className="text-[11px] text-faint truncate">
                  {profile.avatar ? "Загружен" : "Стандартный"}
                </p>
              </div>
              <GhostButton onClick={() => openImage("avatar", true)} className="flex items-center gap-1.5">
                <ImagePlus size={13} /> Сменить
              </GhostButton>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-16 h-10 ui-control border border-line/[0.09] bg-inset overflow-hidden shrink-0">
                {profile.banner && !bannerFailed ? (
                  <img
                    src={profile.banner}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={() => setBannerFailed(true)}
                  />
                ) : (
                  <span className="block w-full h-full" style={{ background: bannerBackground }} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink">Баннер</p>
                <p className="text-[11px] text-faint truncate">
                  {profile.banner ? "Загружен" : "Градиент по юзернейму"}
                </p>
              </div>
              <GhostButton onClick={() => openImage("banner", true)} className="flex items-center gap-1.5">
                <ImageIcon size={13} /> Сменить
              </GhostButton>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="w-16 h-10 ui-control border border-line/[0.09] shrink-0"
                style={{ background: bannerBackground }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink">Фон без обложки</p>
                <p className="text-[11px] text-faint">Градиент считается из юзернейма</p>
              </div>
              <span className="text-[11px] text-faint shrink-0">авто</span>
            </div>
          </FormSection>

          <FormSection title="Имя и описание" icon={UserRound}>
            <FormRow label="Отображаемое имя" counter={`${draft.displayName.length}/32`}>
              <input
                value={draft.displayName}
                maxLength={32}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                className="input"
              />
            </FormRow>
            <FormRow
              label="@username"
              hint="Латиница, цифры, «_» и «.», 3–20 символов"
              counter={`${draft.username.length}/20`}
            >
              <div className="flex items-center gap-2">
                <AtSign size={13} className="text-faint shrink-0" />
                <input
                  value={draft.username}
                  maxLength={20}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  className="input"
                />
              </div>
            </FormRow>
            <FormRow
              label="Почта"
              icon={Mail}
              hint="Хранится локально; подтверждение появится вместе с сервером"
            >
              <input
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="you@example.com"
                className="input"
              />
            </FormRow>
            <FormRow
              label="О себе"
              counter={`${draft.bio.length}/80`}
              over={draft.bio.length > 80}
              hint={
                draft.bio.length > 80
                  ? "Описание длиннее нового лимита — сократи до 80 символов, старое не обрежется само"
                  : undefined
              }
            >
              <textarea
                value={draft.bio}
                // Старое описание длиннее 80 символов не обрезаем насильно
                maxLength={Math.max(80, profile.bio.length)}
                rows={3}
                onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                className="input resize-none"
              />
            </FormRow>
          </FormSection>

          <FormSection title="Ссылки" icon={Link2} hint="До шести ссылок: подпись и адрес">
            {draft.links.length === 0 && (
              <p className="text-[12px] text-faint">Ссылок пока нет — добавь первую.</p>
            )}
            {draft.links.map((link, index) => (
              <div key={index} className="flex items-start gap-2">
                <Link2 size={13} className="text-faint shrink-0 mt-2.5" />
                <input
                  value={link.label}
                  maxLength={32}
                  onChange={(e) => updateLink(index, { label: e.target.value })}
                  placeholder="Название"
                  aria-label={`Название ссылки ${index + 1}`}
                  className="input w-32 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <input
                    value={link.url}
                    maxLength={100}
                    onChange={(e) => updateLink(index, { url: e.target.value })}
                    placeholder="https://…"
                    aria-label={`Адрес ссылки ${index + 1}`}
                    className="input w-full"
                  />
                  <div className="mt-1 flex items-center justify-end gap-2">
                    {link.url.length >= 90 && (
                      <span className="text-[11px] text-faint">близко к лимиту</span>
                    )}
                    <span
                      className={`text-[11px] tnum ${
                        link.url.length >= 100 ? "text-amber-400" : "text-faint"
                      }`}
                    >
                      {link.url.length}/100
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => removeLink(index)}
                  aria-label={`Удалить ссылку ${index + 1}`}
                  className="mt-0.5 p-1.5 ui-control text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors shrink-0"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {draft.links.length < 6 && (
              <GhostButton onClick={addLink} className="flex items-center gap-1.5">
                <Plus size={13} /> Добавить ссылку
              </GhostButton>
            )}
          </FormSection>

          <FormSection
            title="Закреплено"
            icon={Pin}
            hint="Постоянные блоки профиля: жанры, которые видно сразу, и локальная защита PIN"
          >
            <FormRow label="Любимые жанры" hint="Через запятую, до 8 штук">
              <input
                value={draft.genres}
                onChange={(e) => setDraft({ ...draft, genres: e.target.value })}
                className="input"
              />
            </FormRow>
            <FormRow
              label="PIN"
              icon={Lock}
              hint="4–6 цифр. Локальная защита от случайного входа, не шифрование"
            >
              <input
                value={draft.pin}
                onChange={(e) => setDraft({ ...draft, pin: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                inputMode="numeric"
                placeholder="без PIN"
                className="input"
              />
            </FormRow>
          </FormSection>

          {error && <p className="text-[12px] text-red-400">{error}</p>}
        </div>
      </Modal>

      {/* Аватар и баннер: файл с диска или ссылка */}
      <Modal
        open={imageTarget !== null}
        onClose={closeImage}
        title={imageTarget === "banner" ? "Обложка профиля" : "Фото профиля"}
        description="Выбери файл на диске или вставь ссылку. Картинка уменьшается и сжимается при сохранении."
        footer={
          <>
            {((imageTarget === "avatar" && profile.avatar) || (imageTarget === "banner" && profile.banner)) && (
              <GhostButton
                onClick={async () => {
                  const isBanner = imageTarget === "banner";
                  const previous = isBanner ? profile.banner : profile.avatar;
                  await update(profile.id, isBanner ? { banner: null } : { avatar: null });
                  closeImage();
                  sounds.off();
                  toast({
                    title: isBanner ? "Обложка удалена" : "Фото профиля удалено",
                    action: {
                      label: "Отменить",
                      run: () => update(profile.id, isBanner ? { banner: previous } : { avatar: previous }),
                    },
                  });
                }}
              >
                Удалить
              </GhostButton>
            )}
            <GhostButton onClick={closeImage}>Отмена</GhostButton>
            <PrimaryButton disabled={imageBusy} onClick={() => void saveImage()}>
              {imageBusy ? "Загружаю…" : "Сохранить"}
            </PrimaryButton>
          </>
        }
      >
        <div className="flex items-center gap-2">
          <GhostButton onClick={() => void chooseFile()} disabled={imageBusy} className="flex items-center gap-1.5">
            <ImagePlus size={13} /> Выбрать файл
          </GhostButton>
          <span className="text-[12px] text-faint">PNG, JPEG, WebP до 12 МБ</span>
        </div>
        <div className="flex items-center gap-2 my-3">
          <span className="h-px flex-1 bg-line/[0.08]" />
          <span className="text-[11px] text-faint uppercase tracking-wide">или ссылка</span>
          <span className="h-px flex-1 bg-line/[0.08]" />
        </div>
        <label className="block">
          <span className="flex items-center gap-2 mb-1.5">
            {imageTarget === "banner" ? (
              <ImageIcon size={13} className="text-muted" />
            ) : (
              <ImagePlus size={13} className="text-muted" />
            )}
            <span className="text-[12px] text-muted">
              {imageTarget === "banner" ? "Ссылка на баннер" : "Ссылка на аватар"}
            </span>
          </span>
          <input
            value={imageUrl.startsWith("data:") ? "" : imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://…"
            className="input"
          />
        </label>
        {imageUrl.startsWith("data:") && (
          <p className="text-[12px] text-faint mt-2">Выбран файл с диска — он будет сохранён при нажатии «Сохранить».</p>
        )}
        {imageError && <p className="text-[12px] text-red-400 mt-2">{imageError}</p>}
        {imageUrl && (
          <div className="mt-3 flex items-center gap-3">
            <img
              src={imageUrl}
              alt=""
              onError={() => setImageError("Картинка не открылась — проверь ссылку")}
              className={`bg-inset border border-line/[0.07] ${
                imageTarget === "banner"
                  ? "w-40 h-16 ui-control object-cover"
                  : "w-16 h-16 rounded-full object-cover"
              }`}
            />
            <span className="text-[12px] text-faint">Предпросмотр</span>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Stat({ Icon, value, label }: { Icon: typeof Clock; value: string; label: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-faint">
        <Icon size={13} />
        <span className="text-[11px] uppercase tracking-[0.1em] truncate">{label}</span>
      </div>
      <p
        className={`mt-2 leading-tight font-semibold tracking-tight truncate ${
          value === "—" ? "text-[16px] text-faint" : value.length > 9 ? "text-[16px] tnum" : "text-[20px] tnum"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/** Значение, которое владелец профиля решил не показывать. */
function StatHidden({ label }: { label: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-faint">
        <EyeOff size={13} />
        <span className="text-[11px] uppercase tracking-[0.1em] truncate">{label}</span>
      </div>
      <p className="mt-2 text-[12px] text-faint leading-tight">Скрыто владельцем профиля</p>
    </div>
  );
}

/** Заглушка вместо целого блока данных: пустоты и ошибки здесь быть не должно. */
function HiddenNote({ what }: { what?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line/[0.14] bg-surface px-3.5 py-3 flex items-start gap-2.5">
      <EyeOff size={14} className="text-faint shrink-0 mt-0.5" />
      <span className="min-w-0">
        <span className="block text-[12px] text-muted">Скрыто владельцем профиля</span>
        {what && (
          <span className="block text-[11px] text-faint mt-0.5">
            {what} — владелец профиля решил не показывать это другим
          </span>
        )}
      </span>
    </div>
  );
}

/** «3 часа назад»: относительное время для недавно прослушанного. */
function timeAgo(ms: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, "час", "часа", "часов")} назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 30) return `${days} ${plural(days, "день", "дня", "дней")} назад`;
  return new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Время прослушивания с единицами измерения: меньше часа — минуты, дальше
 * часы и минуты. «3 ч 12 мин» честнее, чем «3,2 ч».
 */
function formatListenTime(seconds: number): string {
  const total = Math.max(0, seconds);
  if (total < 60) return `${Math.round(total)} сек`;
  if (total < 3600) return `${Math.round(total / 60)} мин`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total - hours * 3600) / 60);
  return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

/** Момент прослушивания: дата и время, а не «сколько назад» — так точнее. */
function formatMoment(ms: number | null): string {
  if (!ms) return "нет данных";
  return new Date(ms).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function weekdayShort(ms: number): string {
  return new Date(ms).toLocaleDateString("ru-RU", { weekday: "short" });
}

/**
 * Раздел формы профиля: заголовок с иконкой отделяет одну группу полей от
 * другой, как в образце — без рамок и «карточек в карточке».
 */
function FormSection({
  title,
  hint,
  icon: Icon,
  children,
}: {
  title: string;
  hint?: string;
  icon?: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2">
        {Icon && <Icon size={14} className="text-muted shrink-0" />}
        <h3 className="text-[13px] text-ink">{title}</h3>
      </div>
      {hint && <p className="text-[12px] text-muted mt-1 leading-snug">{hint}</p>}
      {/* Тонкая линия под заголовком: разделы формы читаются как блоки */}
      <div className="mt-2.5 h-px bg-line/[0.08]" />
      <div className="space-y-3 mt-3">{children}</div>
    </section>
  );
}

/**
 * Поле формы: подпись, счётчик символов и подсказка. Счётчик становится
 * янтарным, если текст длиннее нового лимита — это видно до сохранения.
 */
function FormRow({
  label,
  hint,
  counter,
  over = false,
  icon: Icon,
  children,
}: {
  label: string;
  hint?: string;
  counter?: string;
  over?: boolean;
  icon?: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-2 mb-1.5">
        {Icon && <Icon size={13} className="text-muted shrink-0" />}
        <span className="text-[12px] text-muted">{label}</span>
      </span>
      {children}
      {(hint || counter) && (
        <span className="mt-1 flex items-start gap-2">
          {hint && <span className="min-w-0 flex-1 text-[11px] text-faint leading-snug">{hint}</span>}
          {counter && (
            <span
              className={`ml-auto shrink-0 text-[11px] tnum ${over ? "text-amber-400" : "text-faint"}`}
              aria-live="polite"
            >
              {counter}
            </span>
          )}
        </span>
      )}
    </label>
  );
}
