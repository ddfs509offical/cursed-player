import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
  Play,
  Music2,
  AlertTriangle,
  Heart,
  Download,
  DownloadCloud,
  Loader2,
  Pin,
  Plus,
  Check,
  Search,
} from "lucide-react";
import Cover from "../components/Cover";
import FavoriteButton from "../components/FavoriteButton";
import LibraryToolbar, { normalizeSearch, searchTokens } from "../components/LibraryToolbar";
import { useFavoritesStore, type FavoriteTrack } from "../store/favoritesStore";
import { cardFromTrack, ensurePlaylistsLoaded, usePlaylistsStore } from "../store/playlistsStore";
import EmptyState from "../components/EmptyState";
import { GhostButton, PrimaryButton, DownloadChoiceModal } from "../components/Modal";
import { ArtistLink } from "../components/ArtistWindow";
import { useLibraryStore } from "../store/libraryStore";
import { usePlayerStore, trackFromLocal, markFreshStream, type Track } from "../store/playerStore";
import {
  useSettingsStore,
  choiceWantsLyrics,
  choiceWantsTrack,
  type DownloadChoice,
  type LibraryGroup,
  type LibrarySortDir,
  type LibrarySortKey,
} from "../store/settingsStore";
import { pickFolder, scanFolder } from "../services/player";
import { formatDuration, getServiceToken, refreshServiceStream, soundcloudTracks, soundcloudPermalink } from "../services/catalog";
import {
  cleanupOffline,
  formatHint,
  formatSavedAt,
  formatSize,
  methodHint,
  methodLabel,
  offlineStats,
  offlineReason,
  removeOfflineFile,
  saveTrackOffline,
  setOfflineKept,
  soundcloudDownloadInfo,
  trackFromSaved,
  type OfflineBaseKind,
  type OfflineStats,
  type SavedFile,
  type SoundcloudDownloadInfo,
} from "../services/downloads";
import { useOfflineStore, findOfflineCopy } from "../store/offlineStore";
import { saveLyricsForTrack, savedOutcomeTitle, type SaveLyricsStatus } from "../store/lyricsStore";
import { lyricsHasLocal } from "../services/lyrics";
import { externalSaveTrack } from "../services/externalDownload";
import { kindHint, kindLabel, offlineKey, offlineFailureMessage } from "../lib/offline";
import { favoriteKeyFor } from "../lib/favoriteKey";
import { serviceFromTrackId } from "../lib/services";
import { toast } from "../store/toastStore";
import { logError, errorText } from "../store/errorStore";
import { sounds } from "../lib/sounds";

interface Props {
  onOpenSearch: () => void;
}

/** Русские склонения: plural(1, ["трек", "трека", "треков"]) → «1 трек». */
function plural(n: number, forms: [string, string, string]): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return `${n} ${forms[2]}`;
  if (mod10 === 1) return `${n} ${forms[0]}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${forms[1]}`;
  return `${n} ${forms[2]}`;
}

/**
 * Трек из сервиса («soundcloud:123») — только у такого бывает офлайн-сохранение
 * и избранное. У локального файла в id лежит путь: он и так на диске, поэтому
 * ни кнопки сохранения, ни сердечка ему не показываем.
 */
function isServiceTrack(id: string): boolean {
  return serviceFromTrackId(id) !== null;
}

/**
 * Локальные списки не разбиваем на страницы — их немного. Но если строк стало
 * больше этой границы, сначала показываем первую сотню и кнопку «Показать все»:
 * длинная простыня тормозит отрисовку, а листать её всё равно никто не станет.
 */
const LOCAL_LIMIT = 100;

/**
 * Панель поиска, сортировки и группировки: показываем её, только если в текущем
 * списке хотя бы столько строк. На коротком списке панель заслоняла бы сами
 * треки, а искать в пяти строках незачем.
 */
const MIN_TOOLBAR_ROWS = 8;

/**
 * Подписи для группировки: пустое поле не должно давать пустой заголовок
 * секции — иначе непонятно, что это за группа.
 */
const UNKNOWN_ARTIST = "Неизвестный исполнитель";
const UNKNOWN_ALBUM = "Без альбома";

/**
 * Строка списка: трек и всё, что нужно для его отрисовки. Собирается один раз
 * в useMemo, поэтому сортировка и фильтр не трогают исходные массивы.
 */
interface LibraryRow {
  track: Track;
  /** Запись офлайн-реестра: размер, способ и дата сохранения (вкладка «Скачанные»). */
  file?: SavedFile;
  /** Номер в отфильтрованном и отсортированном списке — он же индекс для плеера. */
  index: number;
  /** Когда трек появился у пользователя: у «Скачанных» это момент сохранения. */
  addedAt: number;
}

/** Заголовок секции: имя исполнителя или «альбом — исполнитель». */
function sectionTitle(track: Track, group: Exclude<LibraryGroup, "list">): string {
  const artist = track.artist?.trim() || UNKNOWN_ARTIST;
  if (group === "artist") return artist;
  const album = track.album?.trim() || UNKNOWN_ALBUM;
  return `${album} — ${artist}`;
}

/**
 * Сравнение строк по-русски. Пустое значение уходит в конец при любом
 * направлении: «Неизвестный исполнитель» не должен открывать список.
 */
function compareText(a: string, b: string, dir: 1 | -1): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return dir * a.localeCompare(b, "ru", { sensitivity: "base" });
}

/**
 * Имя исполнителя в строке. У треков SoundCloud это ссылка: клик открывает
 * окно артиста, а не включает трек — воспроизведение остаётся на строке.
 */
function artistCell(track: Track): ReactNode {
  const name = track.artist ?? "Неизвестный исполнитель";
  if (!track.artist || serviceFromTrackId(track.id) !== "soundcloud") return name;
  return <ArtistLink name={track.artist} />;
}

/**
 * Поиск ничего не нашёл. Это не пустая библиотека, а фильтр: человек должен
 * видеть запрос и сбросить его одним кликом, иначе решит, что треки пропали.
 */
function NotFound({ query, onReset }: { query: string; onReset: () => void }) {
  return (
    <div className="rounded-xl border border-line/[0.07] bg-surface px-4 py-8 text-center">
      <Search size={20} className="mx-auto text-faint mb-2" />
      <p className="text-[13px] text-ink">Ничего не найдено</p>
      <p className="text-[12px] text-muted mt-1 break-words">
        По запросу «{query.trim()}» в этом списке треков нет
      </p>
      <div className="flex justify-center mt-3">
        <GhostButton onClick={onReset}>Сбросить поиск</GhostButton>
      </div>
    </div>
  );
}

/**
 * Липкий заголовок секции при группировке. Прилипает к верху прокрутки, пока
 * видна хоть одна строка своей секции, — по нему понятно, где кончается один
 * исполнитель и начинается другой. Счётчик в заголовке — сколько треков в
 * секции (после поиска), а не в списке вообще.
 */
function GroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="sticky top-0 z-[5] flex items-center gap-2 px-3 py-1.5 bg-app/95 backdrop-blur-sm border-b border-line/[0.06]">
      <span className="text-[12px] font-medium text-ink truncate">{title}</span>
      <span className="text-[11px] text-faint tnum shrink-0">
        {plural(count, ["трек", "трека", "треков"])}
      </span>
    </div>
  );
}

/**
 * Подвал длинного списка: «Показать все» вместо пагинации. Пока список свёрнут,
 * видно ровно LOCAL_LIMIT строк — по кнопке показываем остальное, и её же
 * можно свернуть обратно.
 */
function ShowAllRow({
  shown,
  total,
  open,
  onOpen,
  onCollapse,
}: {
  shown: number;
  total: number;
  open: boolean;
  onOpen: () => void;
  onCollapse: () => void;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap pt-3">
      {open ? (
        <GhostButton onClick={onCollapse}>Свернуть список</GhostButton>
      ) : (
        <GhostButton onClick={onOpen}>Показать все ({total})</GhostButton>
      )}
      <span className="text-[12px] text-faint">
        {open
          ? `Показаны все ${plural(total, ["трек", "трека", "треков"])}`
          : `Показаны первые ${shown} из ${total} — список не разбит на страницы`}
      </span>
    </div>
  );
}

/**
 * «＋» в строке трека: добавить его в плейлист. Список плейлистов открывается
 * рядом с кнопкой, трек, который уже лежит в плейлисте, отмечен галочкой —
 * повторный клик убирает его оттуда. Здесь же можно завести новый плейлист,
 * чтобы не уходить со страницы.
 *
 * Клики и клавиши внутри кнопки не отдаём строке: строка включает трек по
 * клику, и без этого добавление в плейлист сразу начинало бы воспроизведение.
 */
function AddToPlaylistMenu({ track }: { track: Track }) {
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
  const card = cardFromTrack(track);

  // Плейлисты читаются лениво: страницу «Плейлисты» могли ещё не открывать
  useEffect(() => {
    if (!open) return;
    ensurePlaylistsLoaded();
    const rect = wrapRef.current?.getBoundingClientRect();
    // У нижних строк список раскрываем вверх: снизу его обрежет прокрутка
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
              onClick={() => setCreating((value) => !value)}
              aria-expanded={creating}
              className="w-full flex items-center gap-2 h-8 px-2 rounded-lg text-[12px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors mt-1 pt-1 border-t border-line/[0.06]"
            >
              <span className="w-4 flex justify-center shrink-0">
                <Plus size={13} />
              </span>
              <span className="flex-1 text-left">Новый плейлист…</span>
              {/* Шеврон разворачивается, когда под пунктом раскрылась форма */}
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
                    onClick={submitCreate}
                    disabled={!name.trim()}
                    className="flex-1 h-7 rounded-lg bg-accent text-onAccent text-[12px] font-medium hover:bg-accentHover transition-colors disabled:opacity-40"
                  >
                    Создать и добавить
                  </button>
                  <button
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

/**
 * Моя музыка: локальные файлы. Пути и теги хранятся локально, файлы
 * не копируются — плеер играет прямо из исходных папок.
 */
export default function Library({ onOpenSearch }: Props) {
  const tracks = useLibraryStore((s) => s.tracks);
  const addFolder = useLibraryStore((s) => s.addFolder);
  const addFiles = useLibraryStore((s) => s.addFiles);
  const setTracks = useLibraryStore((s) => s.setTracks);
  const clearLibrary = useLibraryStore((s) => s.clear);
  const folders = useSettingsStore((s) => s.libraryFolders);
  const addLibraryFolder = useSettingsStore((s) => s.addLibraryFolder);
  const removeLibraryFolder = useSettingsStore((s) => s.removeLibraryFolder);
  /** Запасной путь включён: предлагаем его только тогда и только вручную. */
  const externalEnabled = useSettingsStore((s) => s.externalDownloaderEnabled);
  /** Что сохранять: выбор, запомненный в окне «Что сохранить?». */
  const downloadChoice = useSettingsStore((s) => s.downloadChoice);
  const choiceRemembered = useSettingsStore((s) => s.downloadChoiceRemembered);
  const setDownloadChoice = useSettingsStore((s) => s.setDownloadChoice);
  /**
   * Сортировка и группировка живут в настройках, а не в состоянии страницы:
   * выбранный порядок переживает перезапуск. Выбор общий для всех трёх вкладок —
   * «по названию» везде значит одно и то же.
   */
  const sortKey: LibrarySortKey = useSettingsStore((s) => s.librarySort);
  const sortDir: LibrarySortDir = useSettingsStore((s) => s.librarySortDir);
  const group: LibraryGroup = useSettingsStore((s) => s.libraryGroup);
  const setSortKey = useSettingsStore((s) => s.setLibrarySort);
  const setSortDir = useSettingsStore((s) => s.setLibrarySortDir);
  const setGroup = useSettingsStore((s) => s.setLibraryGroup);

  const playLocal = usePlayerStore((s) => s.playLocal);
  const queue = usePlayerStore((s) => s.queue);
  const currentId = queue[usePlayerStore((s) => s.index)]?.id;
  const openFiles = usePlayerStore((s) => s.openFiles);
  const patchTracks = usePlayerStore((s) => s.patchTracks);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "liked" | "downloaded">("all");
  /** Показать весь длинный список, а не первые сто строк (см. LOCAL_LIMIT). */
  const [showAll, setShowAll] = useState(false);
  /**
   * Поиск: `query` — то, что человек печатает, `appliedQuery` — то, по чему
   * реально считается фильтр. Между ними 150 мс: на 500+ треках список
   * пересчитывался бы на каждую букву.
   */
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  /** id трека, который сейчас сохраняется офлайн: блокирует повторный клик. */
  const [savingId, setSavingId] = useState<string | null>(null);

  /** Сохранённые офлайн-файлы: список живёт в offlineStore, его читает и плеер. */
  const saved = useOfflineStore((s) => s.list);
  const offlineRecords = useOfflineStore((s) => s.records);
  const [savedBusy, setSavedBusy] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  /** Занято офлайн-файлами и свободно на диске. */
  const [stats, setStats] = useState<OfflineStats | null>(null);
  /** Выбор срока уборки кеша: простая панель вместо отдельного окна. */
  const [cleanupOpen, setCleanupOpen] = useState(false);
  /** Проход по избранному: сколько сохранено, сколько не вышло и текстов. */
  const [favProgress, setFavProgress] = useState<{
    done: number;
    total: number;
    failed: number;
    lyrics: number;
  } | null>(null);
  /** id треков, текст которых уже сохранён файлом: для состояния «сохранено». */
  const [lyricsSavedIds, setLyricsSavedIds] = useState<Record<string, boolean>>({});
  /** Открытое окно выбора: для какого трека и что уже сделано. */
  const [choiceFor, setChoiceFor] = useState<{
    track: Track;
    trackSaved: boolean;
    lyricsSaved: boolean;
  } | null>(null);

  /**
   * Ввод откладываем на 150 мс. Пустой запрос применяем сразу: очистка должна
   * чувствоваться мгновенной, а не «через мгновение после крестика».
   */
  useEffect(() => {
    if (!query) {
      setAppliedQuery("");
      return;
    }
    const timer = window.setTimeout(() => setAppliedQuery(query), 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  /** Сброс поиска: чистим и поле, и уже применённый фильтр, и «Показать все». */
  function resetSearch() {
    setQuery("");
    setAppliedQuery("");
    setShowAll(false);
  }

  const favoriteItems = useFavoritesStore((s) => s.items);
  const updateFavorites = useFavoritesStore((s) => s.update);
  /**
   * «Избранное» строится из хранилища лайков, а не из пересечения библиотеки
   * и очереди: иначе треки из сервиса исчезали после перезапуска. Название,
   * исполнитель и обложка лежат в самой карточке, а альбом, длительность и
   * свежий путь подтягиваем из библиотеки или очереди, если трек там есть.
   */
  const likedTracks: Track[] = useMemo(
    () =>
      favoriteItems.map((item) => {
        const known = (item.source === "local" ? tracks : queue).find((track) => track.id === item.id);
        /**
         * Название берём из карточки избранного: после фоновой догрузки метаданных
         * там лежит настоящее имя. Очередь и библиотека подходят только как запасной
         * источник — в очереди у сервисного трека вместо названия может остаться
         * идентификатор («soundcloud:2398675908»), и он перекрывал настоящее имя.
         */
        const title =
          item.source === "service" && item.title && item.title !== item.id
            ? item.title
            : known?.title || item.title;
        return {
          id: item.id,
          path: known?.path ?? item.path,
          title,
          artist: known?.artist ?? item.artist,
          album: known?.album ?? null,
          durationMs: known?.durationMs ?? 0,
          source: item.source,
          cover: known?.cover ?? item.cover,
        };
      }),
    [favoriteItems, tracks, queue]
  );
  /** Скачанные файлы как обычные локальные треки — играются через playLocal. */
  const offlineTracks: Track[] = useMemo(() => saved.map(trackFromSaved), [saved]);

  /**
   * Вкладка «Все треки»: вся музыка приложения, а не только локальная
   * библиотека. Сначала локальные файлы (их строки умеют всё), затем сервисные
   * треки, которые пользователь уже добавил: избранное, офлайн-записи и
   * очередь. Дубли отсекаем по единому ключу трека (`favoriteKeyFor`), поэтому
   * один и тот же трек не показывается дважды.
   *
   * Сборка в useMemo: иначе массив пересобирался бы на каждый рендер и тянул
   * за собой пересчёт фильтра и сортировки всего списка.
   */
  const allTracks: Track[] = useMemo(() => {
    const merged: Track[] = [];
    const seen = new Set<string>();
    const push = (track: Track, key: string) => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(track);
    };

    // Локальные: библиотека, затем подхваченные локальные офлайн-файлы
    for (const track of tracks) push(track, favoriteKeyFor(track));
    for (const file of saved) {
      const key = favoriteKeyFor(file);
      if (isServiceTrack(key)) continue;
      push(trackFromSaved(file), key);
    }
    // Сервисные: избранное, затем офлайн-записи и очередь плеера
    for (const track of likedTracks) {
      const key = favoriteKeyFor(track);
      if (!isServiceTrack(key)) continue;
      push(track, key);
    }
    for (const file of saved) {
      const key = favoriteKeyFor(file);
      if (!isServiceTrack(key)) continue;
      push(
        {
          // Играет сервисный трек: ссылку или офлайн-копию найдёт playFrom
          id: key,
          path: "",
          title: file.title || key,
          artist: file.artist,
          album: file.album,
          durationMs: file.durationMs,
          source: "service",
          cover: file.cover,
        },
        key
      );
    }
    for (const track of queue) push(track, favoriteKeyFor(track));
    return merged;
  }, [tracks, saved, likedTracks, queue]);

  /** Список текущей вкладки до поиска: по нему же решается, нужна ли панель. */
  const base: Track[] = filter === "liked" ? likedTracks : filter === "downloaded" ? offlineTracks : allTracks;

  /**
   * Поиск и сортировка — один проход в useMemo по зависимостям (список, запрос,
   * вариант, направление). Сортировка стабильная: Array.sort в JS таков, при
   * равенстве ключей исходный порядок сохраняется. Направление меняет только
   * знак сравнения, поэтому и при убывании равенство остаётся равенством.
   */
  const rows: LibraryRow[] = useMemo(() => {
    const tokens = searchTokens(appliedQuery);
    const matched: LibraryRow[] = [];
    for (let position = 0; position < base.length; position += 1) {
      const track = base[position];
      // В «Скачанных» файл и трек лежат в разных массивах с общим индексом
      const file = filter === "downloaded" ? saved[position] : undefined;
      if (tokens.length) {
        // Ищем по названию, исполнителю и альбому: каждое слово запроса должно
        // найтись хотя бы в одном из полей
        const haystack = normalizeSearch(`${track.title} ${track.artist ?? ""} ${track.album ?? ""}`);
        if (!tokens.every((token) => haystack.includes(token))) continue;
      }
      matched.push({ track, file, index: 0, addedAt: file?.savedAtMs ?? 0 });
    }

    const dir: 1 | -1 = sortDir === "asc" ? 1 : -1;
    matched.sort((a, b) => {
      switch (sortKey) {
        case "artist":
          return compareText(a.track.artist ?? "", b.track.artist ?? "", dir);
        case "duration":
          return dir * (a.track.durationMs - b.track.durationMs);
        case "added":
          // Дату знаем только у скачанных: у остальных нули, и они равны между
          // собой — то есть порядок остаётся исходным, а не случайным
          return dir * (a.addedAt - b.addedAt);
        case "title":
        default:
          return compareText(a.track.title ?? "", b.track.title ?? "", dir);
      }
    });

    return matched.map((row, position) => ({ ...row, index: position }));
  }, [base, filter, saved, appliedQuery, sortKey, sortDir]);

  /**
   * Секции группировки. Строятся по уже отсортированным строкам, поэтому внутри
   * секции порядок тот же, что задаёт сортировка, а сами секции идут в порядке
   * первого появления. При поиске группировка никуда не девается: заголовки
   * просто остаются от тех секций, где что-то нашлось.
   */
  const sections = useMemo(() => {
    if (group === "list") return [{ key: "all", title: null as string | null, rows, total: rows.length }];
    const map = new Map<string, { key: string; title: string | null; rows: LibraryRow[]; total: number }>();
    for (const row of rows) {
      const title = sectionTitle(row.track, group);
      const key = `${group}:${title}`;
      const existing = map.get(key);
      if (existing) existing.rows.push(row);
      else map.set(key, { key, title, rows: [row], total: 0 });
    }
    // Счётчик в заголовке — сколько треков в секции после поиска, а не сколько
    // поместилось до «Показать все»
    for (const section of map.values()) section.total = section.rows.length;
    return [...map.values()];
  }, [rows, group]);

  /**
   * Порядок отрисовки: секции подряд. Он же порядок воспроизведения и нумерации
   * строк — иначе в сгруппированном списке «следующий трек» прыгал бы через
   * секцию. Индекс строки пересчитывается здесь, после группировки.
   */
  const ordered = useMemo(() => {
    const flat: LibraryRow[] = [];
    for (const section of sections) {
      for (const row of section.rows) flat.push({ ...row, index: flat.length });
    }
    return flat;
  }, [sections]);

  /** Список для плеера: играем ровно то, что видно, и в том же порядке. */
  const visible = useMemo(() => ordered.map((row) => row.track), [ordered]);

  /**
   * Лимит считается по отфильтрованным строкам: после поиска «Показать все»
   * появляется, только если найденного всё ещё больше сотни, и не предлагается
   * зря, когда фильтр оставил десяток.
   */
  const shownCount = ordered.length > LOCAL_LIMIT && !showAll ? LOCAL_LIMIT : ordered.length;

  /** Что рисуем: те же секции, обрезанные по лимиту, — без второй группировки. */
  const shownSections = useMemo(() => {
    const out: { key: string; title: string | null; rows: LibraryRow[]; total: number }[] = [];
    let left = shownCount;
    for (const section of sections) {
      if (left <= 0) break;
      const rows = section.rows.slice(0, left);
      left -= rows.length;
      out.push({ ...section, rows });
    }
    return out;
  }, [sections, shownCount]);

  /**
   * Текст на диске проверяем только у сервисных треков, которые уже лежат
   * офлайн: именно их кнопка скачивания может показать «сохранено».
   * Зависимость — строка id, а не массив: эффект не должен зацикливаться.
   */
  const lyricsCandidates = visible
    .filter((track) => isServiceTrack(track.id) && offlineRecords[offlineKey(track.id)])
    .map((track) => track.id)
    .join("|");

  useEffect(() => {
    let alive = true;
    const ids = lyricsCandidates ? lyricsCandidates.split("|") : [];
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
  }, [lyricsCandidates]);

  /**
   * Фоновая догрузка метаданных старых лайков SoundCloud: у них в карточке
   * сохранён только id, поэтому в списке видно «soundcloud:2398675908» и
   * «Неизвестный исполнитель». Один раз за открытие страницы (и при переходе
   * на вкладку «Избранное») тянем треки пачкой и дописываем их в хранилище.
   */
  const enrichRequested = useRef(false);
  useEffect(() => {
    if (enrichRequested.current) return;
    const ids = favoriteItems
      .filter((item) => item.source === "service" && (item.title === item.id || !item.artist))
      .map((item) => item.id)
      .filter((id) => id.startsWith("soundcloud:"))
      .map((id) => id.slice("soundcloud:".length))
      .filter((id) => /^\d+$/.test(id));
    if (!ids.length) return;
    enrichRequested.current = true;

    void (async () => {
      try {
        const found = await soundcloudTracks([...new Set(ids)]);
        if (!found.length) return;
        const cards: FavoriteTrack[] = found.map((track) => ({
          id: `soundcloud:${track.id}`,
          title: track.title,
          artist: track.artists || null,
          cover: track.cover,
          source: "service",
          path: "",
        }));
        updateFavorites(cards);
        /**
         * Очередь хранится в localStorage со старыми названиями: у лайков,
         * добавленных давно, вместо имени лежит идентификатор. Панель очереди
         * и строка «сейчас играет» берут данные именно оттуда, поэтому
         * дописываем догруженные метаданные и в плеер.
         */
        patchTracks(cards.map((card) => ({ id: card.id, title: card.title, artist: card.artist, cover: card.cover })));
      } catch (e) {
        // Это фоновая догрузка: пользователя не тревожим, пишем в журнал
        logError(
          "Не удалось догрузить метаданные избранного",
          "Старые лайки SoundCloud остались без названий и обложек",
          "избранное",
          errorText(e)
        );
      }
    })();
  }, [filter, favoriteItems, updateFavorites, patchTracks]);

  /**
   * Список скачанного. Записи читает Rust из реестра `index.json`, а теги,
   * длительность и обложку — прямо из файлов, как для локальной музыки.
   * Хранилище то же самое, по которому плеер находит копию офлайн.
   */
  async function loadSaved(notify = false) {
    setSavedBusy(true);
    try {
      const files = await useOfflineStore.getState().refresh();
      setSavedError(null);
      void loadStats();
      if (notify) {
        toast({
          title: files.length
            ? `Скачанных файлов: ${plural(files.length, ["файл", "файла", "файлов"])}`
            : "Скачанных файлов пока нет",
        });
      }
    } catch (e) {
      sounds.error();
      setSavedError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavedBusy(false);
    }
  }

  /** Занято и свободно: цифры для шапки вкладки «Скачанные». */
  async function loadStats() {
    try {
      setStats(await offlineStats());
    } catch {
      // Цифры не критичны: список и воспроизведение от них не зависят
    }
  }

  // Список читаем при открытии страницы: файлы могли появиться из поиска
  useEffect(() => {
    void loadSaved();
    void loadStats();
  }, []);

  /** Удаление файла с диска: очередь и избранное не трогаем, они независимы. */
  async function removeSaved(file: SavedFile) {
    try {
      await removeOfflineFile(file.path);
      useOfflineStore.getState().forget(file.trackId);
      void loadStats();
      sounds.off();
      toast({ title: "Файл удалён с диска", description: file.title });
    } catch (e) {
      sounds.error();
      logError("Не удалось удалить скачанный файл", file.title, "офлайн", errorText(e));
      toast({
        title: "Не удалось удалить файл",
        description: offlineReason(e),
        tone: "danger",
      });
    }
  }

  /**
   * «Держать офлайн»: файл остаётся на месте, меняется только пометка в
   * реестре — уборка кеша такую копию не удаляет.
   */
  async function toggleKeep(file: SavedFile) {
    const kept = !file.kept;
    try {
      await setOfflineKept(file.trackId, kept);
      useOfflineStore.getState().upsert({
        ...file,
        kept,
        kind: kept ? "keep" : file.baseKind,
      });
      sounds.save();
      toast({
        title: kept ? "Держу офлайн" : "Пометка снята",
        description: kept
          ? `${file.title} не удалится при очистке кеша`
          : `${file.title} снова может уйти при очистке кеша`,
      });
    } catch (e) {
      sounds.error();
      logError("Не удалось изменить пометку офлайн", file.title, "офлайн", errorText(e));
      toast({
        title: "Не удалось изменить пометку",
        description: offlineReason(e),
        tone: "danger",
      });
    }
  }

  /**
   * Уборка кеша: удаляются только временные офлайн-копии старше выбранного
   * срока. Настоящие скачивания и копии «держу офлайн» остаются на диске.
   */
  async function clearCache(maxAgeDays: number) {
    setCleanupOpen(false);
    setSavedBusy(true);
    try {
      const removed = await cleanupOffline(maxAgeDays);
      await useOfflineStore.getState().refresh();
      void loadStats();
      sounds.off();
      toast({
        title: removed ? `Удалено копий: ${removed}` : "Удалять нечего",
        description:
          maxAgeDays > 0
            ? `Убраны офлайн-копии старше ${plural(maxAgeDays, ["дня", "дней", "дней"])}. Скачанное и «держу офлайн» не тронуты.`
            : "Временный кеш очищен полностью. Скачанное и «держу офлайн» не тронуты.",
      });
    } catch (e) {
      sounds.error();
      logError("Не удалось очистить кеш офлайн-треков", "Папка кеша приложения", "офлайн", errorText(e));
      toast({
        title: "Не удалось очистить кеш",
        description: offlineReason(e),
        tone: "danger",
      });
    } finally {
      setSavedBusy(false);
    }
  }

  /**
   * «Сохранить избранное офлайн»: проходит по всем сервисным лайкам, берёт
   * свежую ссылку и кладёт файл на диск. Уже сохранённые пропускаются, ошибка
   * одного трека не прерывает проход — она просто считается.
   *
   * Окно выбора здесь не показывается: массовое сохранение идёт по уже
   * запомненному варианту (`downloadChoice`), а по умолчанию — с текстами.
   */
  async function saveFavoritesOffline() {
    if (favProgress) return;
    const wantTrack = choiceWantsTrack(downloadChoice);
    const wantLyrics = choiceWantsLyrics(downloadChoice);
    const serviceLikes = favoriteItems.filter(
      (item) => item.source === "service" && item.id.includes(":")
    );
    if (!serviceLikes.length) {
      toast({
        title: "В избранном нет треков из сервиса",
        description: "Локальные файлы и так лежат на диске",
      });
      return;
    }

    const missing = serviceLikes.filter((item) => {
      if (!wantTrack) return true;
      return !offlineRecords[offlineKey(item.id)];
    });
    const skipped = serviceLikes.length - missing.length;
    if (!missing.length) {
      toast({
        title: "Всё избранное уже офлайн",
        description: `Сохранено треков: ${serviceLikes.length} — играть можно без интернета`,
      });
      return;
    }

    setFavProgress({ done: 0, total: missing.length, failed: 0, lyrics: 0 });
    sounds.save();
    let done = 0;
    let failed = 0;
    let lyricsSaved = 0;
    // Первая причина отказа: пользователь должен видеть не только счётчик
    let firstReason = "";
    // Кто именно не сохранился: запасной путь предлагаем только для одного
    const failedItems: FavoriteTrack[] = [];

    for (const item of missing) {
      if (wantTrack) {
        try {
          const track: Track = {
            id: item.id,
            // Ссылку на поток даёт сервис: сохранённая успевает истечь
            path: "",
            title: item.title,
            artist: item.artist,
            album: null,
            durationMs: 0,
            source: "service",
            cover: item.cover,
          };
          const fresh = await refreshServiceStream(track);
          let url = fresh.path;
          if (!url) {
            throw new Error("Сервис не отдал ссылку на поток — проверь подключение сервиса в настройках");
          }

          // Разрешил ли автор скачивание: тогда это честный файл, а не кеш
          let kind: OfflineBaseKind = "cache";
          const trackId = item.id.split(":")[1] ?? "";
          if (trackId) {
            try {
              const clientId = await getServiceToken("soundcloud");
              if (clientId) {
                const info = await soundcloudDownloadInfo(clientId, trackId);
                if (info.downloadable && info.url) {
                  url = info.url;
                  kind = "download";
                }
              }
            } catch {
              // Разрешение спросить не вышло — сохраним офлайн-копию потока
            }
          }

          const file = await saveTrackOffline(url, item.id, kind, {
            title: item.title,
            artist: item.artist,
            cover: item.cover,
          });
          useOfflineStore.getState().upsert(file);
        } catch (e) {
          failed += 1;
          failedItems.push(item);
          if (!firstReason) firstReason = offlineReason(e);
          logError(
            "Не удалось сохранить лайк офлайн",
            `${item.title} — ${item.artist ?? "неизвестный исполнитель"}`,
            "офлайн",
            errorText(e)
          );
        }
      }

      // Текст — независимо от файла: одно другому не мешает
      if (wantLyrics) {
        const result = await saveLyricsForTrack({
          id: item.id,
          path: "",
          title: item.title,
          artist: item.artist,
          album: null,
          durationMs: 0,
          source: "service",
          cover: item.cover,
        });
        if (result.status === "saved") lyricsSaved += 1;
      }

      done += 1;
      setFavProgress({ done, total: missing.length, failed, lyrics: lyricsSaved });
    }

    setFavProgress(null);
    void loadStats();
    if (failed) sounds.error();
    else sounds.save();
    const okCount = done - failed;
    toast({
      title: `Сохранено ${okCount} из ${missing.length} (текстов: ${lyricsSaved})`,
      description:
        [
          skipped ? `уже было офлайн: ${skipped}` : "",
          // Причина важнее счётчика: иначе непонятно, что именно чинить
          failed ? `не удалось: ${failed}${firstReason ? ` — ${firstReason}` : ""}` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "Избранное лежит на диске и заиграет без интернета",
      tone: failed > 0 ? "danger" : "default",
    });

    // Запасной путь предлагаем, только если не сохранился ровно один трек:
    // для пачки отказов «попробовать иначе» непонятно к чему относится.
    if (externalEnabled && failedItems.length === 1) {
      const item = failedItems[0];
      toast({
        title: `Не сохранился: ${item.title}`,
        description: "Можно попробовать запасной путь — сторонний сервис",
        tone: "danger",
        action: {
          label: "Попробовать через внешний сервис",
          run: () => void saveFavoriteExternally(item),
        },
      });
    }
  }

  /**
   * Запасной путь для одного лайка: трек уходит на внешний сервис
   * soundloadmate. Вызывается только из тоста об ошибке — то есть когда
   * нативный способ уже не справился и пользователь сам попросил иначе.
   */
  async function saveFavoriteExternally(item: FavoriteTrack) {
    try {
      const clientId = await getServiceToken("soundcloud");
      if (!clientId) throw new Error("SoundCloud: нужен client_id — вставь в настройках");
      const trackId = item.id.split(":")[1] ?? "";
      if (!trackId) throw new Error("У трека нет идентификатора SoundCloud");

      // Сервису нужен адрес страницы, а не числовой id: голые цифры он
      // понимает как поисковую строку и вернул бы чужие треки.
      const page = await soundcloudPermalink(clientId, trackId);
      const file = await externalSaveTrack(page, item.id, {
        title: item.title,
        artist: item.artist,
        cover: item.cover,
      });
      useOfflineStore.getState().upsert(file);
      void loadStats();
      sounds.save();
      toast({
        title: `Сохранено через внешний сервис: ${item.title}`,
        description:
          "Офлайн-копия лежит на вкладке «Скачанные». Сервис сторонний: работал без гарантий",
      });
    } catch (e) {
      sounds.error();
      logError(
        "Не удалось сохранить лайк через внешний сервис",
        `${item.title} — ${item.artist ?? "неизвестный исполнитель"}`,
        "офлайн",
        errorText(e)
      );
      toast({
        title: "Внешний сервис не справился",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    }
  }

  /**
   * Кнопка скачивания в строке. Что именно сохранять, решает окно «Что
   * сохранить?»: пока выбор не запомнен, оно спрашивается всегда, а у трека,
   * который уже лежит на диске без текста, — ещё и независимо от запомненного
   * выбора: «только трек» там неактивно, зато докачивается текст. Полностью
   * сохранённое окно не открывает вовсе — там нечего предлагать.
   */
  async function startRowDownload(track: Track) {
    if (savingId) return;
    const trackSaved = Boolean(offlineRecords[offlineKey(track.id)]);
    const lyricsSaved = await lyricsHasLocal(track.id);

    if (trackSaved && lyricsSaved) {
      toast({
        title: "Уже сохранено полностью",
        description: `${track.title} — и трек, и текст лежат на диске`,
      });
      return;
    }

    /**
     * Трек уже на диске, а текста нет: окно выбора показываем всегда, даже если
     * выбор запомнен. «Только трек» в нём уже неактивно, зато можно докачать
     * текст — именно этого и ждут от значка облачка.
     */
    if (trackSaved) {
      setChoiceFor({ track, trackSaved, lyricsSaved });
      return;
    }

    if (choiceRemembered) {
      await saveRowOffline(track, downloadChoice);
      return;
    }
    setChoiceFor({ track, trackSaved, lyricsSaved });
  }

  /** Обновить отметку «текст сохранён» для строки сразу после скачивания. */
  function markLyricsSaved(id: string, saved: boolean) {
    if (!saved) return;
    setLyricsSavedIds((current) => ({ ...current, [id]: true }));
  }

  /**
   * Сохранить трек офлайн прямо из списка — тем же порядком, что в поиске:
   * сначала спрашиваем SoundCloud, разрешил ли автор скачивание (тогда это
   * настоящий файл трека), иначе берём свежую ссылку на поток и кладём
   * офлайн-копию в кеш. Выбор способа целиком за сервисом: интерфейс лишь
   * честно называет результат.
   *
   * Текст сохраняется отдельно от аудио: файл мог не взяться, а текст — вещь
   * самостоятельная, и панель текста работает сама по себе.
   */
  async function saveRowOffline(track: Track, choice: DownloadChoice) {
    if (savingId) return;
    setSavingId(track.id);
    try {
      const alreadySaved = Boolean(useOfflineStore.getState().records[offlineKey(track.id)]);
      const wantTrack = choiceWantsTrack(choice) && !alreadySaved;
      const wantLyrics = choiceWantsLyrics(choice);
      let trackSaved = alreadySaved;
      // Способ уже сохранённой копии: по нему честно подписываем тост
      let method: string | null =
        useOfflineStore.getState().records[offlineKey(track.id)]?.method ?? null;
      let trackError: unknown = null;

      if (wantTrack) {
        try {
          const trackId = track.id.split(":")[1] ?? "";
          if (!trackId) throw new Error("У трека нет идентификатора SoundCloud");
          const meta = { title: track.title, artist: track.artist, cover: track.cover ?? null };

          /**
           * Разрешение автора спрашиваем мягко: не ответил сервис — это не повод
           * отказываться от сохранения, просто положим офлайн-копию потока.
           */
          let info: SoundcloudDownloadInfo | null = null;
          try {
            const clientId = await getServiceToken("soundcloud");
            if (clientId) info = await soundcloudDownloadInfo(clientId, trackId);
          } catch {
            info = null;
          }

          let file: SavedFile;
          if (info?.downloadable && info.url) {
            file = await saveTrackOffline(info.url, track.id, "download", meta);
          } else {
            const fresh = await refreshServiceStream(track);
            if (!fresh.path) {
              throw new Error("Сервис не отдал ссылку на поток — проверь подключение сервиса в настройках");
            }
            file = await saveTrackOffline(fresh.path, track.id, "cache", meta);
          }

          useOfflineStore.getState().upsert(file);
          method = file.method;
          trackSaved = true;
        } catch (e) {
          trackError = e;
        }
      }

      let lyricsStatus: SaveLyricsStatus | null = null;
      if (wantLyrics) {
        lyricsStatus = (await saveLyricsForTrack(track)).status;
      }

      if (trackError) {
        sounds.error();
        logError(
          "Не удалось сохранить трек офлайн",
          `${track.title} — ${track.artist ?? "неизвестный исполнитель"}`,
          "офлайн",
          errorText(trackError)
        );
        toast({
          title: "Не удалось сохранить трек",
          // Короткая причина: полный текст остался в журнале
          description: offlineReason(trackError),
          tone: "danger",
        });
        return;
      }

      void loadStats();
      sounds.save();
      markLyricsSaved(track.id, lyricsStatus === "saved");
      toast({
        title: savedOutcomeTitle(trackSaved, lyricsStatus),
        description: trackSaved
          ? `${track.title} — ${methodLabel(method ?? "stream")}, файл лежит на вкладке «Скачанные»`
          : lyricsStatus === "saved"
            ? `${track.title} — текст сохранён файлом рядом с треком`
            : `${track.title} — текст не нашёлся ни в одном источнике`,
      });
    } finally {
      setSavingId(null);
    }
  }

  async function chooseFiles() {
    setError(null);
    sounds.open();
    const added = await openFiles();
    if (added > 0) {
      sounds.save();
      toast({ title: `Добавлено треков: ${added}` });
    }
  }

  async function chooseFolder() {
    setBusy(true);
    setError(null);
    try {
      const folder = await pickFolder();
      if (!folder) return;
      const added = await addFolder(folder);
      addLibraryFolder(folder);
      sounds.save();
      toast({
        title: added > 0 ? `В библиотеке +${added} треков` : "Новых треков не нашлось",
        description: folder,
      });
    } catch (e) {
      sounds.error();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rescan() {
    if (!folders.length) return;
    setBusy(true);
    setError(null);
    try {
      const found = [];
      for (const folder of folders) found.push(...(await scanFolder(folder)));
      setTracks(found.map(trackFromLocal));
      sounds.save();
      toast({ title: `Библиотека обновлена: ${found.length} треков` });
    } catch (e) {
      sounds.error();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function playFrom(startIndex: number) {
    const track = visible[startIndex];
    // Трек из сервиса: ссылка на поток живёт недолго, берём свежую
    if (track?.source === "service") {
      sounds.save();
      /**
       * Сохранённая копия важнее сети: если трек уже офлайн, ссылку не
       * спрашиваем — плеер сам сыграет файл с диска (и так работает без
       * интернета). Заодно это не даёт «Избранному» зависеть от сети.
       */
      if (await findOfflineCopy(track.id)) {
        playLocal(visible, startIndex);
        return;
      }
      try {
        const fresh = await refreshServiceStream(track);
        if (!fresh.path) {
          throw new Error("Ссылку на трек получить не удалось — проверь подключение сервиса в настройках");
        }
        // Ссылка уже добыта: помечаем свежей, чтобы плеер не спросил её второй раз
        markFreshStream(fresh);
        const updated = visible.map((item, i) => (i === startIndex ? fresh : item));
        playLocal(updated, startIndex);
      } catch (e) {
        sounds.error();
        // Нет копии и сеть не ответила — говорим об этом прямо
        const message = offlineFailureMessage(e, false);
        logError(
          "Не удалось включить трек",
          `${track.title} — ${track.artist ?? "неизвестный исполнитель"}: ${message}`,
          "воспроизведение",
          errorText(e)
        );
        toast({
          title: "Не удалось включить трек",
          description: message,
          tone: "danger",
        });
      }
      return;
    }
    playLocal(visible, startIndex);
    sounds.save();
  }

  async function attachFiles() {
    // Выбор отдельных файлов кладём и в библиотеку, и в очередь
    setError(null);
    sounds.open();
    const before = useLibraryStore.getState().tracks.length;
    const added = await openFiles();
    if (!added) return;
    const paths = usePlayerStore
      .getState()
      .queue.slice(-added)
      .map((track) => track.path);
    await addFiles(paths);
    if (useLibraryStore.getState().tracks.length > before) {
      sounds.save();
      toast({ title: `В библиотеке +${useLibraryStore.getState().tracks.length - before} треков` });
    }
  }

  /**
   * Шапка вкладки «Скачанные»: сколько занято офлайн-файлами, сколько свободно
   * на диске, уборка временного кеша и сохранение всего избранного офлайн.
   */
  const downloadsPanel = (
    <div className="rounded-xl border border-line/[0.07] bg-surface mb-4">
      <div className="flex items-center gap-3 flex-wrap px-4 py-3">
        <span className="text-[12px] text-muted">
          Офлайн-файлы:{" "}
          <span className="text-ink tnum">{formatSize(stats?.totalBytes ?? 0)}</span>
          {" · "}
          Свободно на диске:{" "}
          <span className="text-ink tnum">
            {stats && stats.freeBytes > 0 ? formatSize(stats.freeBytes) : "неизвестно"}
          </span>
        </span>
        <span className="flex-1" />
        <GhostButton
          onClick={() => {
            sounds.open();
            setCleanupOpen((open) => !open);
          }}
          disabled={savedBusy}
          className="flex items-center gap-1.5"
        >
          <Trash2 size={13} /> Очистить кеш
        </GhostButton>
        <PrimaryButton
          onClick={() => void saveFavoritesOffline()}
          disabled={!!favProgress}
          className="flex items-center gap-1.5"
        >
          {favProgress ? <RefreshCw size={13} className="animate-spin" /> : <Heart size={13} />}
          Сохранить избранное офлайн
        </PrimaryButton>
      </div>

      {favProgress && (
        <p className="px-4 pb-3 text-[12px] text-muted">
          Сохранено {favProgress.done - favProgress.failed} из {favProgress.total} (текстов:{" "}
          {favProgress.lyrics})…
          {favProgress.failed > 0 ? ` · не удалось: ${favProgress.failed}` : ""}
        </p>
      )}

      {cleanupOpen && (
        <div className="px-4 py-3 border-t border-line/[0.06] flex items-center gap-2 flex-wrap">
          <span className="text-[12px] text-muted">Удалить временные офлайн-копии старше:</span>
          {[7, 30].map((days) => (
            <button
              key={days}
              onClick={() => void clearCache(days)}
              className="h-7 px-3 rounded-lg bg-inset border border-line/[0.07] text-[12px] hover:text-ink hover:border-line/20 transition-colors"
            >
              {days} дней
            </button>
          ))}
          <button
            onClick={() => void clearCache(0)}
            title="Убрать весь временный кеш"
            className="h-7 px-3 rounded-lg bg-inset border border-line/[0.07] text-[12px] hover:text-ink hover:border-line/20 transition-colors"
          >
            весь кеш
          </button>
          <GhostButton onClick={() => setCleanupOpen(false)}>Отмена</GhostButton>
          <span className="text-[11px] text-faint w-full">
            Скачанное и копии «держу офлайн» уборка не трогает
          </span>
        </div>
      )}
    </div>
  );

  /**
   * Панель над списком: поиск, сортировка, группировка и счётчик. Показывается
   * на длинных списках (от MIN_TOOLBAR_ROWS строк), но при активном поиске —
   * всегда: иначе из «Ничего не найдено» некуда было бы снять запрос.
   */
  const searchActive = normalizeSearch(appliedQuery) !== "";
  const countLabel = searchActive
    ? `${rows.length} из ${base.length}`
    : plural(rows.length, ["трек", "трека", "треков"]);
  const toolbar =
    base.length >= MIN_TOOLBAR_ROWS || searchActive ? (
      <LibraryToolbar
        total={base.length}
        shown={rows.length}
        countLabel={countLabel}
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          // Новый запрос — снова первая сотня найденного, а не «показать все»
          setShowAll(false);
        }}
        onClearQuery={resetSearch}
        sort={sortKey}
        onSort={setSortKey}
        dir={sortDir}
        onDir={setSortDir}
        group={group}
        onGroup={setGroup}
      />
    ) : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-4 flex-wrap mb-5">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Моя музыка</h1>
          <p className="text-[13px] text-muted mt-1">
            {plural(tracks.length, ["трек", "трека", "треков"])} ·{" "}
            {plural(folders.length, ["папка", "папки", "папок"])}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <GhostButton onClick={() => void chooseFolder()} disabled={busy} className="flex items-center gap-1.5">
            <FolderPlus size={14} /> {busy ? "Сканирую…" : "Добавить папку"}
          </GhostButton>
          <PrimaryButton onClick={() => void attachFiles()} className="flex items-center gap-1.5">
            <FolderOpen size={14} /> Открыть файлы
          </PrimaryButton>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-inset border border-line/[0.07]">
          {(
            [
              ["all", `Все треки${allTracks.length ? ` · ${allTracks.length}` : ""}`],
              ["liked", `Избранное${favoriteItems.length ? ` · ${favoriteItems.length}` : ""}`],
              ["downloaded", `Скачанные${saved.length ? ` · ${saved.length}` : ""}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => {
                sounds.open();
                setFilter(value);
                // Другая вкладка — свой список: «Показать все» снова свёрнуто
                setShowAll(false);
                // Файлы могли появиться из поиска, пока страница была открыта
                if (value === "downloaded") void loadSaved();
              }}
              aria-pressed={filter === value}
              className={`relative h-8 px-3 rounded-md text-[12px] transition-colors ${
                filter === value ? "text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {filter === value && (
                <motion.span
                  layoutId="library-tab-pill"
                  className="absolute inset-0 rounded-md bg-surface shadow-panel"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <span className="relative z-10">{label}</span>
            </button>
          ))}
        </div>
        {filter === "liked" && visible.length > 0 && (
          <GhostButton onClick={() => playFrom(0)} className="flex items-center gap-1.5">
            <Play size={13} /> Играть избранное
          </GhostButton>
        )}
        {filter === "downloaded" && saved.length > 0 && (
          <GhostButton
            onClick={() => void loadSaved(true)}
            disabled={savedBusy}
            className="flex items-center gap-1.5"
          >
            <RefreshCw size={13} className={savedBusy ? "animate-spin" : ""} /> Обновить список
          </GhostButton>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-3 p-3.5 rounded-xl border border-red-500/25 bg-red-500/[0.06] mb-4">
          <AlertTriangle size={15} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-[12px] text-muted break-words">{error}</p>
        </div>
      )}

      {folders.length > 0 && (
        <div className="rounded-xl border border-line/[0.07] bg-surface p-1.5 mb-4">
          {folders.map((folder) => (
            <div key={folder} className="flex items-center gap-2 px-2.5 py-1.5">
              <FolderOpen size={13} className="text-faint shrink-0" />
              <span className="text-[12px] text-muted truncate flex-1 min-w-0">{folder}</span>
              <button
                onClick={() => {
                  removeLibraryFolder(folder);
                  sounds.off();
                  toast({ title: "Папка убрана из библиотеки", description: folder });
                }}
                aria-label="Убрать папку"
                className="p-1 rounded-md text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors shrink-0"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 px-2.5 py-2 border-t border-line/[0.06]">
            <GhostButton onClick={() => void rescan()} disabled={busy} className="flex items-center gap-1.5">
              <RefreshCw size={13} /> Пересканировать
            </GhostButton>
            <GhostButton
              onClick={() => {
                clearLibrary();
                sounds.off();
                toast({ title: "Библиотека очищена", description: "Файлы на диске не тронуты" });
              }}
              className="flex items-center gap-1.5"
            >
              <Trash2 size={13} /> Очистить список
            </GhostButton>
          </div>
        </div>
      )}

      {savedError && (
        <div className="flex items-start gap-3 p-3.5 rounded-xl border border-red-500/25 bg-red-500/[0.06] mb-4">
          <AlertTriangle size={15} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-[12px] text-muted break-words">Скачанные треки: {savedError}</p>
        </div>
      )}

      {/* Панель одна на все три вкладки: она стоит над любым списком */}
      {toolbar}

      {filter === "downloaded" ? (
        <div>
          {downloadsPanel}
          {saved.length === 0 ? (
            <EmptyState
              Icon={Download}
              title="Скачанных треков пока нет"
              description="В поиске у трека есть кнопка «Скачать» — она появляется, когда автор разрешил скачивание файла. Если автор запретил, приложение честно кладёт офлайн-копию в кеш: кнопка «Сохранить в кеш». Прослушанные треки сохраняются сами, если включён автокеш."
              action={
                <div className="flex items-center gap-2">
                  <PrimaryButton onClick={onOpenSearch} className="flex items-center gap-1.5">
                    <Download size={14} /> Найти треки
                  </PrimaryButton>
                  {savedBusy && <span className="text-[12px] text-faint">Читаю папку…</span>}
                </div>
              }
            />
          ) : rows.length === 0 ? (
            <NotFound query={query} onReset={resetSearch} />
          ) : (
            <div className="space-y-0.5">
              <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] text-faint border-b border-line/[0.06]">
                <span className="w-6 text-right">№</span>
                <span className="flex-1">Название</span>
                <span className="w-28 hidden md:block">Тип</span>
                {/* Способ — не то же, что тип: тип говорит, что это за копия,
                    способ — откуда файл взялся. Обе подписи видны рядом */}
                <span className="w-44 hidden lg:block">Способ</span>
                <span className="w-20 hidden md:block">Размер</span>
                <span className="w-32 hidden lg:block">Сохранено</span>
                <span className="w-10 text-right">Время</span>
                <span className="w-24 text-right">Офлайн</span>
                {/* Сердечко, «＋» и удаление: узкие колонки действий */}
                <span className="w-20" />
              </div>
              {shownSections.map((section) => (
                <div key={section.key}>
                  {section.title && <GroupHeader title={section.title} count={section.total} />}
                  {section.rows.map((row) => {
                const file = row.file;
                if (!file) return null;
                const track = row.track;
                const position = row.index;
                const active = track.id === currentId;
                const savedAtLabel = formatSavedAt(file.savedAt);
                const format = formatHint(file);
                const badgeClass =
                  file.kind === "download"
                    ? "border-accent/25 bg-accent/[0.08] text-accentText"
                    : file.kind === "keep"
                      ? "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-300"
                      : "border-line/[0.12] bg-ink/[0.05] text-muted";
                /**
                 * Сердечко — только для треков из сервиса: у локального
                 * импортированного файла в id лежит путь, и в избранном ему
                 * делать нечего. Ключ лайка — единый (`favoriteKeyFor`): тот
                 * же, что в «Избранном» и в библиотеке, поэтому лайк здесь и
                 * там один и тот же, а не два независимых.
                 */
                const favoriteKey = favoriteKeyFor(file);
                const serviceTrack = isServiceTrack(favoriteKey);
                const favorited = serviceTrack && favoriteItems.some((item) => item.id === favoriteKey);
                return (
                  <div
                    key={file.path}
                    role="button"
                    tabIndex={0}
                    onDoubleClick={() => playFrom(position)}
                    onClick={() => (active ? undefined : playFrom(position))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") playFrom(position);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors group cursor-pointer ${
                      active ? "bg-accent/10" : "hover:bg-ink/[0.05]"
                    }`}
                  >
                    <span className="w-6 text-right text-[12px] text-faint tnum shrink-0">{position + 1}</span>
                    <Cover src={track.cover} size={32} hoverIcon />
                    <span className="flex-1 min-w-0">
                      <span className={`block text-[13px] truncate ${active ? "text-accentText" : ""}`}>
                        {track.title}
                      </span>
                      <span className="block text-[12px] text-muted truncate">
                        {artistCell({ ...track, id: favoriteKey })}
                      </span>
                    </span>
                    <span className="w-28 hidden md:block">
                      <span
                        title={`${kindHint(file.kind)}${
                          savedAtLabel ? ` · сохранено ${savedAtLabel}` : ""
                        }`}
                        className={`inline-flex items-center h-6 px-2 rounded-md border text-[11px] ${badgeClass}`}
                      >
                        {kindLabel(file.kind)}
                      </span>
                    </span>
                    {/* Способ, которым трек сохранён: отдельно от режима.
                        У не-mp3 под бейджем видно формат — «m4a после пересборки»:
                        строкой ниже он помещается целиком и не режет подпись */}
                    <span className="w-44 hidden lg:block min-w-0">
                      <span className="flex flex-col items-start gap-0.5 min-w-0">
                        <span
                          title={`${methodHint(file.method)}${format ? ` · формат на диске: ${format}` : ""}`}
                          className="inline-flex items-center h-6 px-2 rounded-md border border-sky-500/25 bg-sky-500/[0.08] text-[11px] text-sky-300 whitespace-nowrap"
                        >
                          {methodLabel(file.method)}
                        </span>
                        {format && (
                          <span
                            className="text-[10px] text-faint whitespace-nowrap"
                            title={`Формат файла: ${format}`}
                          >
                            {format}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="w-20 hidden md:block text-[12px] text-muted tnum">
                      {formatSize(file.size)}
                    </span>
                    <span className="w-32 hidden lg:block text-[12px] text-muted tnum">
                      {savedAtLabel || "—"}
                    </span>
                    <span className="w-10 text-right text-[12px] text-muted tnum shrink-0">
                      {formatDuration(track.durationMs)}
                    </span>
                    <span className="w-24 flex justify-end shrink-0">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleKeep(file);
                        }}
                        aria-pressed={file.kept}
                        aria-label={file.kept ? "Снять «держать офлайн»" : "Держать офлайн"}
                        title={
                          file.kept
                            ? "Держу офлайн: уборка кеша эту копию не удалит"
                            : "Держать офлайн: не удалять копию при очистке кеша"
                        }
                        className={`inline-flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] transition-colors ${
                          file.kept
                            ? "border-emerald-500/30 bg-emerald-500/[0.10] text-emerald-300"
                            : "border-line/[0.10] bg-ink/[0.04] text-muted hover:text-ink"
                        }`}
                      >
                        <Pin size={11} className={file.kept ? "fill-current" : ""} />
                        <span className="hidden lg:inline">
                          {file.kept ? "держу офлайн" : "держать офлайн"}
                        </span>
                      </button>
                    </span>
                    {/* Избранное: у сервисного трека то же сердечко, что и в
                        других списках. Лайк виден сразу, у остальных — при
                        наведении, чтобы список не пестрел пустыми сердцами */}
                    <span className="w-7 flex justify-end shrink-0">
                      {serviceTrack && (
                        <FavoriteButton
                          track={{
                            id: favoriteKey,
                            title: file.title,
                            artist: file.artist,
                            cover: file.cover,
                            source: "service",
                            // Ссылку на поток плеер спросит сам: сохранённая истекает
                            path: "",
                          }}
                          className={favorited ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}
                        />
                      )}
                    </span>
                    {/* В плейлист кладём трек сервиса по единому ключу, а не по
                        пути копии: файл кеша могут убрать, а трек останется */}
                    <AddToPlaylistMenu
                      track={
                        serviceTrack
                          ? { ...track, id: favoriteKey, path: "", source: "service" }
                          : track
                      }
                    />
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeSaved(file);
                      }}
                      aria-label="Удалить файл с диска"
                      title="Удалить файл с диска"
                      className="p-1.5 rounded-lg text-faint hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* Длинный список: показываем первую сотню, остальное — по кнопке.
              Пагинации здесь нет: локальных треков немного, а листать их
              удобнее одной простынёй. Лимит считается по найденному: если
              поиск оставил десять строк, кнопка не появляется */}
          {rows.length > LOCAL_LIMIT && (
            <ShowAllRow
              shown={shownCount}
              total={rows.length}
              open={showAll}
              onOpen={() => setShowAll(true)}
              onCollapse={() => setShowAll(false)}
            />
          )}
        </div>
      ) : base.length === 0 ? (
        filter === "liked" ? (
          <EmptyState
            Icon={Heart}
            title="В избранном пока пусто"
            description="Лайки сохраняются отдельно для каждого профиля."
            action={<GhostButton onClick={() => setFilter("all")}>Показать все треки</GhostButton>}
          />
        ) : (
        <EmptyState
          Icon={Music2}
          title="Локальных треков пока нет"
          description="Добавь папку с музыкой или открой отдельные файлы: FLAC, MP3, WAV, OGG, M4A. Теги читаются из файлов, сами файлы никуда не копируются."
          action={
            <div className="flex items-center gap-2">
              <PrimaryButton onClick={() => void chooseFolder()} className="flex items-center gap-1.5">
                <FolderPlus size={14} /> Добавить папку
              </PrimaryButton>
              <GhostButton onClick={onOpenSearch}>Найти в сервисе</GhostButton>
            </div>
          }
        />
        )
      ) : rows.length === 0 ? (
        /* Список не пуст, просто поиск ничего не нашёл: не выдаём это за
           пустую библиотеку и даём сбросить запрос */
        <NotFound query={query} onReset={resetSearch} />
      ) : (
        <div className="space-y-0.5">
          <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] text-faint border-b border-line/[0.06]">
            <span className="w-6 text-right">№</span>
            <span className="flex-1">Название</span>
            <span className="w-48 hidden md:block">Альбом</span>
            <span className="w-10 text-right">Время</span>
            {/* Офлайн, «＋» и сердечко: узкие колонки действий */}
            <span className="w-20" />
          </div>
          {shownSections.map((section) => (
            <div key={section.key}>
              {section.title && <GroupHeader title={section.title} count={section.total} />}
              {section.rows.map((row) => {
            const track = row.track;
            const position = row.index;
            const active = track.id === currentId;
            /**
             * Сохранять офлайн умеем только треки SoundCloud: у локального
             * файла и у сервиса без поддержки предлагать нечего. Сохранённая
             * копия важнее кнопки: заново качать не предлагаем.
             */
            const service = isServiceTrack(track.id);
            const soundcloud = serviceFromTrackId(track.id) === "soundcloud";
            const copy = service ? offlineRecords[offlineKey(track.id)] : undefined;
            const saving = savingId === track.id;
            return (
              <div
                key={track.id}
                role="button"
                tabIndex={0}
                onDoubleClick={() => playFrom(position)}
                onClick={() => (active ? undefined : playFrom(position))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") playFrom(position);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors group cursor-pointer ${
                  active ? "bg-accent/10" : "hover:bg-ink/[0.05]"
                }`}
              >
                <span className="w-6 text-right text-[12px] text-faint tnum shrink-0">{position + 1}</span>
                <Cover src={track.cover} size={32} hoverIcon />
                <span className="flex-1 min-w-0">
                  <span className={`block text-[13px] truncate ${active ? "text-accentText" : ""}`}>
                    {track.title}
                  </span>
                  <span className="block text-[12px] text-muted truncate">{artistCell(track)}</span>
                </span>
                <span className="w-48 hidden md:block text-[12px] text-muted truncate">
                  {track.album ?? "—"}
                </span>
                <span className="w-10 text-right text-[12px] text-muted tnum shrink-0">
                  {formatDuration(track.durationMs)}
                </span>
                {/* Офлайн: копия уже есть — показываем это, а не кнопку заново.
                    Когда сохранены и трек, и текст, предлагать больше нечего */}
                {service && (copy || soundcloud) && (
                  <span className="flex items-center justify-end shrink-0 min-w-[28px]">
                    {copy && lyricsSavedIds[track.id] ? (
                      <span
                        aria-label="Уже сохранено: трек и текст"
                        title="Уже сохранено: и трек, и текст лежат на диске"
                        className="flex items-center gap-1 text-[11px] text-accentText px-1 whitespace-nowrap"
                      >
                        <Check size={13} strokeWidth={2.2} /> сохранено
                      </span>
                    ) : copy ? (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          // Трек есть, текста нет — открываем окно выбора:
                          // «только трек» в нём уже неактивно, текст докачается
                          void startRowDownload(track);
                        }}
                        aria-label="Трек уже сохранён офлайн — докачать текст"
                        title={`Трек уже сохранён офлайн (${methodLabel(copy.method)}) — можно докачать текст`}
                        className="p-1.5 rounded-lg text-accentText hover:bg-ink/[0.06] transition-colors"
                      >
                        <DownloadCloud size={14} strokeWidth={1.9} />
                      </button>
                    ) : saving ? (
                      <span className="flex items-center gap-1.5 text-[12px] text-accentText px-1.5 whitespace-nowrap">
                        <Loader2 size={13} className="animate-spin" /> Сохраняю…
                      </span>
                    ) : (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void startRowDownload(track);
                        }}
                        aria-label="Сохранить офлайн"
                        title="Сохранить офлайн: файл автора, если он разрешил скачивание, иначе офлайн-копия потока"
                        className="p-1.5 rounded-lg text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                      >
                        <Download size={14} strokeWidth={1.9} />
                      </button>
                    )}
                  </span>
                )}
                <AddToPlaylistMenu track={track} />
                <FavoriteButton track={track} />
              </div>
            );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Длинный список «Все треки» / «Избранное»: та же кнопка вместо страниц */}
      {filter !== "downloaded" && rows.length > LOCAL_LIMIT && (
        <ShowAllRow
          shown={shownCount}
          total={rows.length}
          open={showAll}
          onOpen={() => setShowAll(true)}
          onCollapse={() => setShowAll(false)}
        />
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
          const target = choiceFor?.track;
          setChoiceFor(null);
          if (remember) setDownloadChoice(choice, true);
          if (target) void saveRowOffline(target, choice);
        }}
      />

    </div>
  );
}
