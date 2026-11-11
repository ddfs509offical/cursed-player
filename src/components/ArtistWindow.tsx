import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  Music2,
  Pin,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import Cover from "./Cover";
import FavoriteButton from "./FavoriteButton";
import { DownloadChoiceModal, GhostButton } from "./Modal";
import { ARTIST_PAGE_SIZE, useArtistStore } from "../store/artistStore";
import {
  formatDuration,
  formatPlaybackCount,
  getServiceToken,
  soundcloudPermalink,
  soundcloudStreamUrl,
  type SearchTrack,
} from "../services/catalog";
import {
  offlineReason,
  saveTrackOffline,
  setOfflineKept,
  soundcloudDownloadInfo,
  type SavedFile,
} from "../services/downloads";
import { externalSaveTrack } from "../services/externalDownload";
import { lyricsHasLocal } from "../services/lyrics";
import { offlineFailureMessage, offlineKey } from "../lib/offline";
import { sounds } from "../lib/sounds";
import { errorText, logError } from "../store/errorStore";
import { useExitGuard } from "../lib/useExitGuard";
import { savedOutcomeTitle, saveLyricsForTrack, type SaveLyricsStatus } from "../store/lyricsStore";
import { findOfflineCopy, useOfflineStore } from "../store/offlineStore";
import { cardFromTrack, ensurePlaylistsLoaded, usePlaylistsStore } from "../store/playlistsStore";
import { usePlayerStore, type Track } from "../store/playerStore";
import {
  choiceWantsLyrics,
  choiceWantsTrack,
  useSettingsStore,
  type DownloadChoice,
} from "../store/settingsStore";
import { toast } from "../store/toastStore";

/**
 * Окно артиста SoundCloud: шапка с баннером, аватером и счётчиками, затем
 * треки артиста страницами по 25. Список строк — как в поиске и библиотеке:
 * обложка, название, длительность, сердечко, скачивание с окном выбора,
 * «＋ в плейлист» и воспроизведение по клику.
 *
 * Здесь же живут общие мелочи списков, чтобы не дублировать их по страницам:
 * `PaginationBar` (его использует и поиск) и `ArtistLink` — имя исполнителя,
 * по которому открывается это окно.
 */

/** Трек сервиса в форме, которую понимают плеер, лайки и плейлисты. */
export function serviceTrack(track: SearchTrack): Track {
  return {
    id: `${track.service}:${track.id}`,
    // Ссылку на поток плеер спросит сам: сохранённая успевает истечь
    path: "",
    title: track.title,
    artist: track.artists || null,
    album: track.album,
    durationMs: track.durationMs,
    source: "service",
    cover: track.cover,
  };
}

/** Идентификатор трека в приложении: «soundcloud:123». */
function trackKey(track: SearchTrack): string {
  return `${track.service}:${track.id}`;
}

/** Число для счётчиков шапки: 1234 → «1,2 тыс.», 2 500 000 → «2,5 млн». */
function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 1000) return value.toLocaleString("ru-RU");
  const short = (scaled: number) =>
    scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(".0", "").replace(".", ",");
  return value < 1_000_000 ? `${short(value / 1000)} тыс.` : `${short(value / 1_000_000)} млн`;
}

/**
 * Номера страниц для панели: не больше `max` кнопок, лишние прячем за «…».
 * «…» — не кнопка, поэтому кнопок действительно не больше семи.
 */
export function pageWindow(current: number, total: number, max = 7): (number | "…")[] {
  const last = Math.max(Math.floor(total) || 1, Math.floor(current) || 1, 1);
  if (last <= max) return Array.from({ length: last }, (_, index) => index + 1);

  const room = max - 3; // место вокруг текущей страницы без первой и последней
  let start = Math.max(2, Math.floor(current) - Math.floor(room / 2));
  const end = Math.min(last - 1, start + room);
  start = Math.max(2, end - room);

  const numbers: (number | "…")[] = [1];
  if (start > 2) numbers.push("…");
  for (let value = start; value <= end; value += 1) numbers.push(value);
  if (end < last - 1) numbers.push("…");
  numbers.push(last);
  return numbers;
}

const PAGE_BUTTON = "h-8 min-w-8 px-2 rounded-lg text-[12px] tnum transition-colors";
const NAV_BUTTON =
  "h-8 px-2.5 rounded-lg border border-line/[0.10] text-[12px] text-ink/80 hover:bg-ink/[0.06] hover:text-ink transition-colors disabled:opacity-40 disabled:hover:bg-transparent";

interface PaginationBarProps {
  /** Текущая страница (1..). */
  page: number;
  /** Сколько всего страниц; null — пока неизвестно, тогда «Страница N». */
  total: number | null;
  /** За загруженным набором есть ещё порции — «Вперёд» работает. */
  hasMore: boolean;
  /** Идёт догрузка: кнопки гаснут, список показывает плейсхолдеры. */
  busy?: boolean;
  onGo: (page: number) => void;
  className?: string;
}

/**
 * Постраничная навигация: «← Назад», номера страниц, «Вперёд →» и подпись
 * «Страница N из M» (или «Страница N», пока число страниц неизвестно).
 * Показывает только загруженный набор: страницы внутри него — мгновенно.
 */
export function PaginationBar({
  page,
  total,
  hasMore,
  busy = false,
  onGo,
  className = "",
}: PaginationBarProps) {
  const loadedPages = Math.max(total ?? 1, page);
  const numbers = pageWindow(page, loadedPages);
  const canBack = page > 1 && !busy;
  const canForward = !busy && (page < loadedPages || hasMore);

  return (
    <div className={`flex items-center gap-1.5 flex-wrap pt-4 ${className}`}>
      <button type="button" onClick={() => onGo(page - 1)} disabled={!canBack} className={NAV_BUTTON}>
        ← Назад
      </button>

      {numbers.map((item, index) =>
        item === "…" ? (
          <span key={`gap-${index}`} className="px-1 text-[12px] text-faint">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            onClick={() => onGo(item)}
            aria-current={item === page ? "page" : undefined}
            className={`${PAGE_BUTTON} ${
              item === page
                ? "bg-accent text-onAccent font-medium"
                : "border border-line/[0.10] text-ink/80 hover:bg-ink/[0.06] hover:text-ink"
            }`}
          >
            {item}
          </button>
        )
      )}

      <button type="button" onClick={() => onGo(page + 1)} disabled={!canForward} className={NAV_BUTTON}>
        Вперёд →
      </button>

      <span className="text-[12px] text-muted ml-1">
        {total === null ? `Страница ${page}` : `Страница ${page} из ${total}`}
      </span>
      {busy && (
        <span className="flex items-center gap-1.5 text-[12px] text-faint">
          <Loader2 size={12} className="animate-spin" /> загружаю дальше…
        </span>
      )}
    </div>
  );
}

/**
 * Имя исполнителя как ссылка: открывает окно артиста. Клик по строке при этом
 * не срабатывает — трек не включается, воспроизведение остаётся отдельным
 * действием (клик по самой строке).
 */
export function ArtistLink({ name, className = "" }: { name: string; className?: string }) {
  const openArtist = useArtistStore((s) => s.openArtist);
  if (!name.trim()) return null;

  function activate() {
    sounds.open();
    openArtist(name);
  }

  return (
    <span
      role="link"
      tabIndex={0}
      title={`Открыть артиста: ${name}`}
      onClick={(event) => {
        event.stopPropagation();
        activate();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      className={`cursor-pointer hover:underline hover:text-ink transition-colors ${className}`}
    >
      {name}
    </span>
  );
}

/**
 * «＋» в строке трека артиста: положить его в плейлист, не уходя из окна.
 * Список плейлистов читается лениво, повторный клик убирает трек оттуда.
 */
function AddToPlaylistMenu({ track }: { track: SearchTrack }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [up, setUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const playlists = usePlaylistsStore((s) => s.items);
  const createPlaylist = usePlaylistsStore((s) => s.create);
  const addTrack = usePlaylistsStore((s) => s.addTrack);
  const toggleTrack = usePlaylistsStore((s) => s.toggleTrack);
  const card = cardFromTrack(serviceTrack(track));

  useEffect(() => {
    if (!open) return;
    ensurePlaylistsLoaded();
    // У нижних строк список раскрываем вверх: снизу его обрежет прокрутка окна
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setUp(window.innerHeight - rect.bottom < 320);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setCreating(false);
    setName("");
  }

  function pick(id: string, title: string) {
    const inside = toggleTrack(id, card);
    if (inside) {
      sounds.save();
      toast({
        title: `Добавлено в «${title}»`,
        description: card.title,
        action: { label: "Отменить", run: () => void toggleTrack(id, card) },
      });
    } else {
      sounds.off();
      toast({ title: `Убрано из «${title}»`, description: card.title });
    }
  }

  function submitCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const playlist = createPlaylist(trimmed);
    addTrack(playlist.id, card);
    sounds.save();
    toast({
      title: `Создан плейлист «${playlist.name}»`,
      description: card.title,
      action: { label: "Отменить", run: () => usePlaylistsStore.getState().remove(playlist.id) },
    });
    setCreating(false);
    setName("");
  }

  return (
    <div
      ref={wrapRef}
      className="relative inline-flex shrink-0"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => (open ? close() : setOpen(true))}
        aria-label="Добавить в плейлист"
        aria-expanded={open}
        title="Добавить в плейлист"
        className={`p-1.5 rounded-lg transition-colors ${
          open ? "text-ink bg-ink/[0.06]" : "text-faint hover:text-ink hover:bg-ink/[0.06]"
        } ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
      >
        <Plus size={14} strokeWidth={1.9} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={popupRef}
            role="menu"
            initial={{ y: up ? 6 : -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: up ? 6 : -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0, 0, 0.2, 1] }}
            style={{ transformOrigin: up ? "bottom right" : "top right" }}
            className={`glass-float absolute right-0 z-40 w-60 p-1 rounded-xl bg-surface3/85 backdrop-blur-[16px] border border-line/10 ${
              up ? "bottom-full mb-1" : "top-full mt-1"
            }`}
          >
            <p className="px-2.5 pt-1 pb-1 text-[11px] text-faint">Добавить в:</p>

            <div className="max-h-56 overflow-y-auto">
              {playlists.length === 0 && !creating && (
                <p className="px-2.5 py-1.5 text-[12px] text-muted">Плейлистов пока нет</p>
              )}
              {playlists.map((playlist) => {
                const inside = playlist.trackIds.includes(card.id);
                return (
                  <button
                    key={playlist.id}
                    type="button"
                    role="menuitem"
                    onClick={() => pick(playlist.id, playlist.name)}
                    className="w-full flex items-center gap-2 h-8 px-2 rounded-lg text-[12px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors"
                  >
                    <span className="w-4 flex justify-center shrink-0">
                      {inside && <Check size={13} className="text-accentText" strokeWidth={2.2} />}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-left">{playlist.name}</span>
                    <span className="text-[11px] text-faint tnum shrink-0">{playlist.trackIds.length}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setCreating((value) => !value)}
              aria-expanded={creating}
              className="w-full flex items-center gap-2 h-8 px-2 rounded-lg text-[12px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors mt-1 pt-1 border-t border-line/[0.06]"
            >
              <span className="w-4 flex justify-center shrink-0">
                <Plus size={13} />
              </span>
              <span className="flex-1 text-left">Новый плейлист…</span>
              <ChevronDown
                size={13}
                className={`shrink-0 text-faint transition-transform duration-200 ${creating ? "rotate-180" : ""}`}
              />
            </button>

            {creating && (
              <div className="px-1 pb-0.5">
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitCreate();
                  }}
                  maxLength={80}
                  placeholder="Название плейлиста"
                  className="w-full h-8 px-2 rounded-lg bg-inset border border-line/[0.10] text-[12px] outline-none focus:border-accent/40 transition-colors"
                />
                <div className="flex items-center gap-1.5 mt-1.5 mb-0.5">
                  <button
                    type="button"
                    onClick={submitCreate}
                    disabled={!name.trim()}
                    className="flex-1 h-7 rounded-lg bg-accent text-onAccent text-[12px] font-medium hover:bg-accentHover transition-colors disabled:opacity-40"
                  >
                    Создать и добавить
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setName("");
                    }}
                    className="h-7 px-2.5 rounded-lg border border-line/[0.12] text-[12px] text-ink/85 hover:bg-ink/[0.06] transition-colors"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Скелетоны строк: видно, что список грузится, и окно при этом не блокируется. */
function RowSkeletons({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-1 pt-1">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-2">
          <div className="w-9 h-9 rounded-md bg-ink/[0.05] animate-pulse" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-40 rounded bg-ink/[0.06] animate-pulse" />
            <div className="h-2.5 w-24 rounded bg-ink/[0.05] animate-pulse" />
          </div>
          <div className="h-3 w-8 rounded bg-ink/[0.05] animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/**
 * Окно артиста: открывается кликом по имени исполнителя в списках. Состояние
 * (кто открыт, что уже загружено) держит `artistStore`, поэтому окно можно
 * смонтировать на любой странице — оно само знает, показывать себя или нет.
 */
export default function ArtistWindow() {
  const open = useArtistStore((s) => s.open);
  const key = useArtistStore((s) => s.key);
  const target = useArtistStore((s) => s.target);
  const profile = useArtistStore((s) => s.profile);
  const tracks = useArtistStore((s) => s.tracks);
  const page = useArtistStore((s) => s.page);
  const loading = useArtistStore((s) => s.loading);
  const loadingMore = useArtistStore((s) => s.loadingMore);
  const error = useArtistStore((s) => s.error);
  const exhausted = useArtistStore((s) => s.exhausted);
  const close = useArtistStore((s) => s.close);
  const setPage = useArtistStore((s) => s.setPage);
  const loadMore = useArtistStore((s) => s.loadMore);
  const retry = useArtistStore((s) => s.retry);

  /** Описание: длинное сворачиваем, «показать ещё» раскрывает. */
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  /** Баннер мог не загрузиться — тогда показываем градиент. */
  const [bannerBroken, setBannerBroken] = useState(false);

  const [savingId, setSavingId] = useState<string | null>(null);
  const [lyricsSavedIds, setLyricsSavedIds] = useState<Record<string, boolean>>({});
  /** Открытое окно «Что сохранить?»: для какого трека и что уже сделано. */
  const [choiceFor, setChoiceFor] = useState<{
    track: SearchTrack;
    trackSaved: boolean;
    lyricsSaved: boolean;
  } | null>(null);

  const offlineRecords = useOfflineStore((s) => s.records);
  const downloadChoice = useSettingsStore((s) => s.downloadChoice);
  const choiceRemembered = useSettingsStore((s) => s.downloadChoiceRemembered);
  const setDownloadChoice = useSettingsStore((s) => s.setDownloadChoice);
  const externalEnabled = useSettingsStore((s) => s.externalDownloaderEnabled);
  const playNow = usePlayerStore((s) => s.playNow);

  /** Esc закрывает окно; окно выбора поверх — сначала оно. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || choiceFor) return;
      sounds.close();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, choiceFor, close]);

  // Другой артист — описание снова свёрнуто, баннер проверяем заново
  useEffect(() => {
    setDescriptionOpen(false);
    setBannerBroken(false);
  }, [key]);

  /**
   * Текст на диске проверяем только у треков, которые уже лежат офлайн:
   * именно их кнопка скачивания может показать «сохранено». Зависимость —
   * строка id, а не массив: список пересобирается на каждый рендер.
   */
  const savedCandidates = tracks
    .map(trackKey)
    .filter((id) => offlineRecords[offlineKey(id)])
    .join("|");

  useEffect(() => {
    let alive = true;
    const ids = savedCandidates ? savedCandidates.split("|") : [];
    if (!ids.length) {
      setLyricsSavedIds({});
      return () => {
        alive = false;
      };
    }
    void Promise.all(ids.map(async (id) => [id, await lyricsHasLocal(id)] as const)).then((pairs) => {
      if (alive) setLyricsSavedIds(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [savedCandidates]);

  /** Воспроизведение: сохранённая копия важнее сети, иначе берём свежий поток. */
  async function playTrack(track: SearchTrack) {
    const id = trackKey(track);
    const copy = await findOfflineCopy(id);
    if (copy) {
      playNow(copy);
      sounds.save();
      toast({ title: `Играю: ${copy.title}`, description: "Офлайн-копия с диска" });
      return;
    }
    try {
      const clientId = await getServiceToken("soundcloud");
      if (!clientId) throw new Error("SoundCloud: нужен client_id — вставь в настройках");
      const url = await soundcloudStreamUrl(clientId, track.id);
      // Ссылка уже добыта и живёт недолго: помечаем свежей и включаем сразу
      playNow({ ...serviceTrack(track), path: url });
      sounds.save();
      toast({ title: `Играю: ${track.title}`, description: `${track.artists} · SoundCloud` });
    } catch (e) {
      sounds.error();
      const message = offlineFailureMessage(e, false);
      logError(
        "Не удалось включить трек",
        `${track.title} — ${track.artists}: ${message}`,
        "воспроизведение",
        errorText(e)
      );
      toast({ title: "Не удалось включить трек", description: message, tone: "danger" });
    }
  }

  /**
   * Кнопка скачивания: что именно сохранять, решает окно «Что сохранить?».
   * Пока выбор не запомнен, оно спрашивается всегда, а у трека, уже лежащего
   * на диске без текста, — ещё и независимо от запомненного выбора.
   */
  async function startDownload(track: SearchTrack) {
    if (savingId) return;
    const id = trackKey(track);
    const trackSaved = Boolean(offlineRecords[offlineKey(id)]);
    const lyricsSaved = await lyricsHasLocal(id);

    if (trackSaved && lyricsSaved) {
      toast({
        title: "Уже сохранено полностью",
        description: `${track.title} — и трек, и текст лежат на диске`,
      });
      return;
    }
    if (trackSaved) {
      setChoiceFor({ track, trackSaved, lyricsSaved });
      return;
    }
    if (choiceRemembered) {
      await saveOffline(track, downloadChoice);
      return;
    }
    setChoiceFor({ track, trackSaved, lyricsSaved });
  }

  /**
   * Офлайн-трек: сначала спрашиваем SoundCloud, разрешил ли автор скачивание.
   * Разрешил — сохраняем сам файл; не разрешил — кладём офлайн-копию потока.
   * Текст сохраняется отдельно: панель текста работает сама по себе.
   */
  async function saveOffline(track: SearchTrack, choice: DownloadChoice) {
    if (savingId) return;
    setSavingId(track.id);
    const id = trackKey(track);
    try {
      const alreadySaved = Boolean(useOfflineStore.getState().records[offlineKey(id)]);
      const wantTrack = choiceWantsTrack(choice) && !alreadySaved;
      const wantLyrics = choiceWantsLyrics(choice);
      let trackSaved = alreadySaved;
      let method: string | null =
        useOfflineStore.getState().records[offlineKey(id)]?.method ?? null;
      let trackError: unknown = null;

      if (wantTrack) {
        try {
          const clientId = await getServiceToken("soundcloud");
          if (!clientId) throw new Error("SoundCloud: нужен client_id — вставь в настройках");

          const meta = { title: track.title, artist: track.artists || null, cover: track.cover };
          const info = await soundcloudDownloadInfo(clientId, track.id);
          if (info.downloadable && info.url) {
            const file = await saveTrackOffline(info.url, id, "download", meta);
            useOfflineStore.getState().upsert(file);
            method = file.method;
          } else {
            const stream = await soundcloudStreamUrl(clientId, track.id);
            const file = await saveTrackOffline(stream, id, "cache", meta);
            useOfflineStore.getState().upsert(file);
            method = file.method;
          }
          trackSaved = true;
        } catch (e) {
          trackError = e;
        }
      }

      let lyricsStatus: SaveLyricsStatus | null = null;
      if (wantLyrics) {
        lyricsStatus = (
          await saveLyricsForTrack({
            id,
            path: "",
            title: track.title,
            artist: track.artists || null,
            album: track.album ?? null,
            durationMs: track.durationMs,
            source: "service",
            cover: track.cover,
          })
        ).status;
      }

      if (trackError) {
        sounds.error();
        logError(
          "Не удалось сохранить трек для офлайна",
          `${track.title} — ${track.artists}`,
          "офлайн",
          errorText(trackError)
        );
        toast({
          title: "Не удалось сохранить трек",
          description: externalEnabled
            ? `${offlineReason(trackError)}. Можно попробовать запасной путь — сторонний сервис`
            : offlineReason(trackError),
          tone: "danger",
          action: externalEnabled
            ? { label: "Попробовать через внешний сервис", run: () => void saveExternally(track) }
            : { label: "Повторить", run: () => void saveOffline(track, choice) },
        });
        return;
      }

      sounds.save();
      if (lyricsStatus === "saved") {
        setLyricsSavedIds((current) => ({ ...current, [id]: true }));
      }
      toast({
        title: savedOutcomeTitle(trackSaved, lyricsStatus),
        description: trackSaved
          ? method === "download"
            ? `${track.title} — файл лежит в «Моей музыке» на вкладке «Скачанные»`
            : `${track.title} — офлайн-копия: автор не разрешил скачивание, файл лежит во временном хранилище приложения`
          : lyricsStatus === "saved"
            ? `${track.title} — текст сохранён файлом рядом с треком`
            : `${track.title} — текст не нашёлся ни в одном источнике`,
      });
    } finally {
      setSavingId(null);
    }
  }

  /**
   * Запасной путь сохранения: трек уходит на внешний сервис. Вызывается только
   * из тоста об ошибке, то есть по явной просьбе пользователя.
   */
  async function saveExternally(track: SearchTrack) {
    if (savingId) return;
    setSavingId(track.id);
    try {
      const clientId = await getServiceToken("soundcloud");
      if (!clientId) throw new Error("SoundCloud: нужен client_id — вставь в настройках");
      const id = trackKey(track);
      const page = await soundcloudPermalink(clientId, track.id);
      const file = await externalSaveTrack(page, id, {
        title: track.title,
        artist: track.artists || null,
        cover: track.cover,
      });
      useOfflineStore.getState().upsert(file);
      sounds.save();
      toast({
        title: `Сохранено через внешний сервис: ${track.title}`,
        description:
          "Офлайн-копия лежит в «Моей музыке» на вкладке «Скачанные». Сервис сторонний: работал без гарантий",
      });
    } catch (e) {
      sounds.error();
      logError(
        "Не удалось сохранить трек через внешний сервис",
        `${track.title} — ${track.artists}`,
        "офлайн",
        errorText(e)
      );
      toast({
        title: "Внешний сервис не справился",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    } finally {
      setSavingId(null);
    }
  }

  /** «Держать офлайн»: файл на месте, меняется только пометка в реестре. */
  async function toggleKeep(record: SavedFile) {
    const kept = !record.kept;
    try {
      await setOfflineKept(record.trackId, kept);
      useOfflineStore.getState().upsert({ ...record, kept, kind: kept ? "keep" : record.baseKind });
      sounds.save();
      toast({
        title: kept ? "Держу офлайн" : "Пометка снята",
        description: kept
          ? `${record.title} не удалится при очистке кеша`
          : `${record.title} снова может уйти при очистке кеша`,
      });
    } catch (e) {
      sounds.error();
      logError("Не удалось изменить пометку офлайн", record.title, "офлайн", errorText(e));
      toast({ title: "Не удалось изменить пометку", description: offlineReason(e), tone: "danger" });
    }
  }

  const pageTracks = tracks.slice((page - 1) * ARTIST_PAGE_SIZE, page * ARTIST_PAGE_SIZE);
  const loadedPages = Math.max(1, Math.ceil(tracks.length / ARTIST_PAGE_SIZE));
  /** Окно уходит по таймеру и сразу перестаёт ловить клики (см. useExitGuard). */
  const { mounted, leaving } = useExitGuard(open);
  /** Число страниц известно только тогда, когда список закончился. */
  const totalPages = exhausted ? loadedPages : null;
  const pageUrl = profile?.permalinkUrl ?? (profile?.permalink ? `https://soundcloud.com/${profile.permalink}` : null);

  /**
   * Переход по страницам: внутри загруженного — мгновенно; за его пределами
   * просим следующую порцию и встаём на неё, когда она действительно пришла.
   */
  async function goToPage(next: number) {
    if (next < 1 || loading || loadingMore) return;
    if (next <= loadedPages) {
      setPage(next);
      return;
    }
    if (exhausted || next > loadedPages + 1) return;
    await loadMore();
    const after = useArtistStore.getState();
    const pagesAfter = Math.max(1, Math.ceil(after.tracks.length / ARTIST_PAGE_SIZE));
    setPage(Math.min(next, pagesAfter));
  }

  const title = profile?.username ?? target ?? "Артист";

  return (
    /*
      Слой живёт по состоянию (`mounted` снимается таймером), а framer только
      рисует появление и уход: иначе окно артиста оставалось поверх приложения,
      если анимация выхода не доиграла.
    */
    <>
      {mounted && (
        <motion.div
          initial={{ opacity: 0.9 }}
          animate={leaving ? { opacity: 0 } : { opacity: 1 }}
          transition={{ duration: 0.15 }}
          style={leaving ? { pointerEvents: "none" } : undefined}
          className="fixed inset-0 z-[60] bg-app/75 flex items-center justify-center p-6"
          onClick={close}
        >
          <motion.div
            initial={{ scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Артист ${title}`}
            className="glass-float w-[780px] max-w-full max-h-[86vh] flex flex-col rounded-2xl border border-line/10 bg-surface3/60 backdrop-blur-[18px] overflow-hidden"
          >
            {/* Шапка: баннер (или градиент), аватар, имя и счётчики */}
            <div className="relative shrink-0">
              <div className="h-32 w-full overflow-hidden">
                {profile?.bannerUrl && !bannerBroken ? (
                  <img
                    src={profile.bannerUrl}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={() => setBannerBroken(true)}
                  />
                ) : (
                  <div className="w-full h-full bg-coverC" />
                )}
              </div>

              <div className="absolute top-3 right-3 flex items-center gap-2">
                {pageUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      sounds.open();
                      void openExternal(pageUrl);
                    }}
                    className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-app/55 backdrop-blur-[12px] border border-line/[0.12] text-[12px] text-ink/90 hover:bg-app/75 transition-colors"
                  >
                    <ExternalLink size={13} /> Открыть в SoundCloud
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    sounds.close();
                    close();
                  }}
                  aria-label="Закрыть"
                  className="p-1.5 rounded-lg bg-app/55 backdrop-blur-[12px] text-ink/80 hover:text-ink hover:bg-app/75 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="px-5 pb-4 -mt-10 relative">
                <div className="flex items-end gap-4">
                  <span className="w-20 h-20 rounded-2xl overflow-hidden ring-2 ring-surface3/80 bg-inset shrink-0">
                    {profile?.avatarUrl ? (
                      <img src={profile.avatarUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="w-full h-full flex items-center justify-center text-faint">
                        <Music2 size={24} />
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1 pb-1">
                    <h2 className="text-[18px] font-semibold tracking-tight truncate flex items-center gap-1.5">
                      <span className="truncate">{title}</span>
                      {profile?.verified && (
                        <BadgeCheck size={15} strokeWidth={2.2} className="text-sky-400 shrink-0" />
                      )}
                    </h2>
                    <p className="text-[12px] text-muted truncate">
                      @{profile?.permalink ?? profile?.username ?? target}
                      {profile?.fullName ? ` · ${profile.fullName}` : ""}
                    </p>
                  </div>
                </div>

                {profile && (
                  <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-3 text-[12px] text-muted">
                    <span>
                      <span className="text-ink tnum">{formatCount(profile.followersCount)}</span> подписчиков
                    </span>
                    <span>
                      <span className="text-ink tnum">{formatCount(profile.followingsCount)}</span> подписок
                    </span>
                    <span>
                      <span className="text-ink tnum">{formatCount(profile.trackCount)}</span> треков
                    </span>
                    <span>
                      <span className="text-ink tnum">{formatCount(profile.playlistCount)}</span> плейлистов
                    </span>
                    {(profile.city || profile.countryCode) && (
                      <span className="text-faint">
                        {[profile.city, profile.countryCode].filter(Boolean).join(", ")}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Тело: описание и треки артиста страницами по 25 */}
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
              {loading && !profile && <RowSkeletons />}

              {!loading && error && !profile && (
                <div className="flex items-start gap-3 p-4 rounded-xl border border-red-500/25 bg-red-500/[0.06] mt-2">
                  <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">Артист не открылся</p>
                    <p className="text-[12px] text-muted mt-1 break-words">{error}</p>
                    <GhostButton onClick={() => void retry()} className="mt-3 flex items-center gap-1.5">
                      <RefreshCw size={13} /> Повторить
                    </GhostButton>
                  </div>
                </div>
              )}

              {profile?.description && (
                <div className="mb-4">
                  <p
                    className={`text-[12px] text-muted leading-relaxed whitespace-pre-line ${
                      descriptionOpen ? "" : "line-clamp-3"
                    }`}
                  >
                    {profile.description}
                  </p>
                  {profile.description.length > 180 && (
                    <button
                      type="button"
                      onClick={() => setDescriptionOpen((value) => !value)}
                      className="mt-1 text-[12px] text-accentText hover:underline"
                    >
                      {descriptionOpen ? "Свернуть" : "Показать ещё"}
                    </button>
                  )}
                </div>
              )}

              {/* Профиль есть, а треки не догрузились: список важнее ошибки */}
              {profile && error && (
                <div className="flex items-center gap-2 mb-3 text-[12px] text-muted">
                  <AlertTriangle size={13} className="text-red-400 shrink-0" />
                  <span className="min-w-0 break-words">Не удалось догрузить треки: {error}</span>
                  <button
                    type="button"
                    onClick={() => void retry()}
                    className="text-accentText hover:underline shrink-0"
                  >
                    Повторить
                  </button>
                </div>
              )}

              {profile && (
                <div className="flex items-center justify-between gap-3 mb-1">
                  <p className="text-[12px] text-muted">
                    Треки{profile.trackCount ? ` · всего ${formatCount(profile.trackCount)}` : ""}
                  </p>
                </div>
              )}

              <div className="space-y-0.5">
                {pageTracks.map((track) => {
                  const id = trackKey(track);
                  const record = offlineRecords[offlineKey(id)];
                  const fullySaved = Boolean(record) && Boolean(lyricsSavedIds[id]);
                  const plays = formatPlaybackCount(track.playbackCount);
                  const subtitle = [plays, track.album].filter(Boolean).join(" · ");
                  return (
                    <div
                      key={id}
                      role="button"
                      tabIndex={0}
                      onClick={() => void playTrack(track)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void playTrack(track);
                      }}
                      className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-ink/[0.05] transition-colors text-left group cursor-pointer"
                    >
                      <Cover src={track.cover} size={36} hoverIcon />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium truncate">{track.title}</span>
                        {subtitle && (
                          <span className="block text-[11px] text-faint truncate">{subtitle}</span>
                        )}
                      </span>
                      <span className="text-[12px] text-muted shrink-0 tnum">
                        {formatDuration(track.durationMs)}
                      </span>

                      {/* Офлайн: сохранённое и то и другое больше не предлагаем */}
                      {savingId === track.id ? (
                        <span className="flex items-center gap-1.5 text-[12px] text-accentText shrink-0 px-1.5">
                          <Loader2 size={13} className="animate-spin" /> Сохраняю…
                        </span>
                      ) : fullySaved ? (
                        <span
                          aria-label="Уже сохранено: трек и текст"
                          title="Уже сохранено: и трек, и текст лежат на диске"
                          className="flex items-center gap-1 text-[12px] text-accentText shrink-0 px-1.5"
                        >
                          <Check size={13} strokeWidth={2.2} /> Сохранено
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void startDownload(track);
                          }}
                          aria-label={track.downloadable ? "Скачать" : "Сохранить в кеш"}
                          title={
                            record
                              ? "Трек уже сохранён офлайн — можно докачать текст"
                              : track.downloadable
                                ? "Скачать: автор разрешил скачивание файла"
                                : "Сохранить в кеш: автор не разрешил скачивание — это офлайн-копия"
                          }
                          className={`p-1.5 rounded-lg transition-colors shrink-0 ${
                            record
                              ? "text-accentText hover:bg-ink/[0.06]"
                              : "text-faint hover:text-ink hover:bg-ink/[0.06]"
                          }`}
                        >
                          <Download size={14} strokeWidth={1.9} />
                        </button>
                      )}

                      {/* Трек уже сохранён: можно попросить держать копию офлайн */}
                      {record && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void toggleKeep(record);
                          }}
                          aria-label={record.kept ? "Снять «держать офлайн»" : "Держать офлайн"}
                          title={
                            record.kept
                              ? "Держу офлайн: уборка кеша эту копию не удалит"
                              : "Держать офлайн: не удалять копию при очистке кеша"
                          }
                          className={`p-1.5 rounded-lg transition-colors shrink-0 ${
                            record.kept
                              ? "text-accentText"
                              : "text-faint hover:text-ink hover:bg-ink/[0.06] opacity-0 group-hover:opacity-100 focus:opacity-100"
                          }`}
                        >
                          <Pin size={14} strokeWidth={1.9} className={record.kept ? "fill-current" : ""} />
                        </button>
                      )}

                      <AddToPlaylistMenu track={track} />
                      <FavoriteButton
                        track={{
                          id,
                          title: track.title,
                          artist: track.artists || null,
                          cover: track.cover,
                          source: "service",
                          path: "",
                        }}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                      />
                    </div>
                  );
                })}
              </div>

              {loadingMore && <RowSkeletons rows={3} />}

              {profile && !loading && tracks.length === 0 && !error && (
                <p className="text-[13px] text-muted py-6 text-center">
                  У этого артиста нет треков, доступных через API.
                </p>
              )}

              {tracks.length > 0 && (
                <PaginationBar
                  page={page}
                  total={totalPages}
                  hasMore={!exhausted}
                  busy={loadingMore || loading}
                  onGo={(next) => void goToPage(next)}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* Окно выбора: спрашивается, только пока выбор не запомнен */}
      <DownloadChoiceModal
        open={choiceFor !== null}
        trackTitle={choiceFor?.track.title}
        trackSaved={choiceFor?.trackSaved ?? false}
        lyricsSaved={choiceFor?.lyricsSaved ?? false}
        defaultChoice={downloadChoice}
        remembered={choiceRemembered}
        onClose={() => setChoiceFor(null)}
        onConfirm={(choice, remember) => {
          const target_ = choiceFor?.track;
          setChoiceFor(null);
          if (remember) setDownloadChoice(choice, true);
          if (target_) void saveOffline(target_, choice);
        }}
      />
    </>
  );
}
