import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Check,
  Download,
  Ellipsis,
  GripVertical,
  Image,
  ListMusic,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import Cover from "../components/Cover";
import EmptyState from "../components/EmptyState";
import Modal, { DangerButton, GhostButton, PrimaryButton } from "../components/Modal";
import {
  cardFromTrack,
  mergeTrackCard,
  usePlaylistsStore,
  type Playlist,
  type PlaylistTrack,
} from "../store/playlistsStore";
import { useActiveProfile } from "../store/profileStore";
import { useLibraryStore } from "../store/libraryStore";
import { useFavoritesStore } from "../store/favoritesStore";
import { findOfflineCopy, useOfflineStore } from "../store/offlineStore";
import { markFreshStream, usePlayerStore, type Track } from "../store/playerStore";
import { formatDuration, refreshServiceStream, soundcloudTracks } from "../services/catalog";
import { offlineFailureMessage, offlineKey } from "../lib/offline";
import { savePlaylistOffline } from "../services/playlistOffline";
import { serviceFromTrackId } from "../lib/services";
import { seedFromString, themeCover } from "../lib/coverTone";
import { toPlayableUrl } from "../player/audio";
import { toast } from "../store/toastStore";
import { errorText, logError } from "../store/errorStore";
import { sounds } from "../lib/sounds";

/**
 * Плейлисты: свои списки треков с обложкой, порядком и переименованием.
 *
 * Сам плейлист хранит только идентификаторы треков (см. playlistsStore), а
 * название, исполнитель, длительность и обложка берутся из общей картотеки
 * и из того, что уже известно библиотеке, избранному, офлайн-файлам и очереди
 * плеера. Неизвестные треки из сервиса догружаются одним запросом по id.
 */

/** Русские склонения: plural(1, ["трек", "трека", "треков"]) → «1 трек». */
function plural(n: number, forms: [string, string, string]): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return `${n} ${forms[2]}`;
  if (mod10 === 1) return `${n} ${forms[0]}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${forms[1]}`;
  return `${n} ${forms[2]}`;
}

/** Инициалы для обложки-заглушки: «Летний плейлист» → «ЛП». */
function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "♪";
}

function coverFor(playlist: Playlist): string {
  return themeCover(seedFromString(playlist.id));
}

/** Заглушка карточки: о треке известен только идентификатор. */
function fallbackCard(id: string): PlaylistTrack {
  const service = serviceFromTrackId(id) !== null;
  return {
    id,
    title: id,
    artist: null,
    album: null,
    durationMs: 0,
    cover: null,
    source: service ? "service" : "local",
    path: service ? "" : id,
  };
}

/** Карточка → трек для плеера. */
function toTrack(card: PlaylistTrack): Track {
  return {
    id: card.id,
    // Сервисный трек играет по ссылке, которую выдаёт плеер: сохранённая истекает
    path: card.source === "service" ? "" : card.path || card.id,
    title: card.title,
    artist: card.artist,
    album: card.album,
    durationMs: card.durationMs,
    source: card.source,
    cover: card.cover,
  };
}

/** Первая обложка среди треков плейлиста — если своя не выбрана. */
function trackCover(playlist: Playlist, cards: Map<string, PlaylistTrack>): string | null {
  for (const id of playlist.trackIds) {
    const cover = cards.get(id)?.cover;
    if (cover) return cover;
  }
  return null;
}

interface MenuItem {
  label: string;
  icon: ReactNode;
  run: () => void;
  danger?: boolean;
}

/** Небольшое выпадающее меню: подложка, пункты, закрытие по клику мимо и Esc. */
function DropdownMenu({ items, up, onClose }: { items: MenuItem[]; up: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      role="menu"
      initial={{ y: up ? 6 : -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: up ? 6 : -6, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0, 0, 0.2, 1] }}
      style={{ transformOrigin: up ? "bottom right" : "top right" }}
      className={`glass-float absolute right-0 z-30 w-52 p-1 rounded-xl bg-surface3/85 backdrop-blur-[16px] border border-line/10 ${
        up ? "bottom-full mb-1" : "top-full mt-1"
      }`}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          onClick={() => {
            onClose();
            item.run();
          }}
          className={`w-full flex items-center gap-2 h-8 px-2.5 rounded-lg text-[12px] text-left transition-colors ${
            item.danger ? "text-red-400 hover:bg-red-500/10" : "text-ink/85 hover:bg-ink/[0.06] hover:text-ink"
          }`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </motion.div>
  );
}

/**
 * Куда открывать выпадашку. Страница живёт в контейнере с прокруткой, поэтому
 * у нижних карточек меню раскрывается вверх — иначе оно обрезалось бы.
 */
function useMenuPlacement(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);

  useEffect(() => {
    if (!open) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setUp(window.innerHeight - rect.bottom < 220);
  }, [open]);

  return { ref, up };
}

export default function Playlists() {
  const active = useActiveProfile();
  const profileId = active?.id ?? null;

  const items = usePlaylistsStore((s) => s.items);
  const cards = usePlaylistsStore((s) => s.cards);
  const load = usePlaylistsStore((s) => s.load);
  const createPlaylist = usePlaylistsStore((s) => s.create);
  const renamePlaylist = usePlaylistsStore((s) => s.rename);
  const updatePlaylist = usePlaylistsStore((s) => s.update);
  const removePlaylist = usePlaylistsStore((s) => s.remove);
  const addTrack = usePlaylistsStore((s) => s.addTrack);
  const removeTrack = usePlaylistsStore((s) => s.removeTrack);
  const reorderPlaylist = usePlaylistsStore((s) => s.reorder);
  const rememberTracks = usePlaylistsStore((s) => s.rememberTracks);

  const libraryTracks = useLibraryStore((s) => s.tracks);
  const favoriteItems = useFavoritesStore((s) => s.items);
  const offlineList = useOfflineStore((s) => s.list);
  const offlineRecords = useOfflineStore((s) => s.records);
  const queue = usePlayerStore((s) => s.queue);
  const currentId = queue[usePlayerStore((s) => s.index)]?.id;
  const playLocal = usePlayerStore((s) => s.playLocal);

  // Плейлисты привязаны к профилю: при переключении читаем его список
  useEffect(() => {
    load(profileId);
  }, [load, profileId]);

  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [renameTarget, setRenameTarget] = useState<Playlist | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [coverTarget, setCoverTarget] = useState<Playlist | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Playlist | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  /** Идущее сохранение плейлиста офлайн: id, прогресс и число ошибок. */
  const [offlineJob, setOfflineJob] = useState<{
    id: string;
    done: number;
    total: number;
    failed: number;
  } | null>(null);
  /** Защита от второго запуска до перерисовки: state обновляется не сразу. */
  const offlineBusy = useRef(false);

  const open = openId ? items.find((playlist) => playlist.id === openId) ?? null : null;

  /**
   * Что известно о треках. Источники идут от менее точного к более точному:
   * картотека плейлистов перекрывает очередь, где у старых сервисных треков
   * вместо названия лежит идентификатор.
   */
  const known = useMemo(() => {
    const map = new Map<string, PlaylistTrack>();
    const put = (card: PlaylistTrack) => {
      if (!card.id) return;
      map.set(card.id, mergeTrackCard(map.get(card.id), card));
    };
    for (const track of libraryTracks) put(cardFromTrack(track));
    for (const file of offlineList) {
      const service = serviceFromTrackId(file.trackId) !== null;
      put({
        id: file.trackId,
        title: file.title?.trim() ? file.title : file.trackId,
        artist: file.artist,
        album: file.album,
        durationMs: file.durationMs,
        cover: file.cover,
        source: service ? "service" : "local",
        path: service ? "" : file.path,
      });
    }
    for (const favorite of favoriteItems) {
      put({
        id: favorite.id,
        title: favorite.title,
        artist: favorite.artist,
        album: null,
        durationMs: 0,
        cover: favorite.cover,
        source: favorite.source,
        path: favorite.path,
      });
    }
    for (const track of queue) put(cardFromTrack(track));
    for (const card of Object.values(cards)) put(card);
    return map;
  }, [libraryTracks, offlineList, favoriteItems, queue, cards]);

  const openCards = useMemo(
    () => (open ? open.trackIds.map((id) => known.get(id) ?? fallbackCard(id)) : []),
    [open, known]
  );
  const openTracks = useMemo(() => openCards.map(toTrack), [openCards]);
  /**
   * Длительность плейлиста считаем по УНИКАЛЬНЫМ трекам: один и тот же файл
   * может встречаться в списке дважды (добавили повторно, пришёл из очереди),
   * и тогда время удваивалось — «длительность перемножается». Порядок строк на
   * это не влияет, сумма просто перестаёт зависеть от повторов.
   */
  const totalMs = useMemo(() => {
    const seen = new Set<string>();
    let sum = 0;
    for (const card of openCards) {
      if (card.durationMs > 0 && card.id && seen.has(card.id)) continue;
      if (card.id && card.durationMs > 0) seen.add(card.id);
      sum += card.durationMs || 0;
    }
    return sum;
  }, [openCards]);

  /**
   * Что уже доступно без интернета. Локальный трек офлайновый по определению,
   * сервисный — только если для него есть запись в офлайн-реестре. Статус
   * считается, а не хранится флагом: удалил трек из офлайна — плейлист сразу
   * перестал быть «полностью скачанным».
   */
  const coverage = useMemo(() => {
    const map = new Map<string, { saved: number; total: number; missing: PlaylistTrack[] }>();
    for (const playlist of items) {
      let saved = 0;
      const missing: PlaylistTrack[] = [];
      for (const id of playlist.trackIds) {
        const card = known.get(id) ?? fallbackCard(id);
        if (card.source !== "service" || offlineRecords[offlineKey(card.id)]) saved += 1;
        else missing.push(card);
      }
      map.set(playlist.id, { saved, total: playlist.trackIds.length, missing });
    }
    return map;
  }, [items, known, offlineRecords]);

  const openCoverage = open ? coverage.get(open.id) ?? null : null;

  /**
   * У трека из сервиса может не быть карточки: плейлист создавали на другом
   * устройстве или трек добавлен давно. Один раз за открытие спрашиваем
   * метаданные пачкой — название, исполнителя, обложку и длительность.
   */
  const enriched = useRef(new Set<string>());
  const missing = useMemo(
    () =>
      open
        ? open.trackIds.filter(
            (id) =>
              !cards[id] &&
              !enriched.current.has(id) &&
              id.startsWith("soundcloud:") &&
              /^\d+$/.test(id.slice("soundcloud:".length))
          )
        : [],
    [open, cards]
  );
  useEffect(() => {
    if (!missing.length) return;
    const ids = missing.map((id) => id.slice("soundcloud:".length));
    for (const id of missing) enriched.current.add(id);
    let cancelled = false;
    void (async () => {
      try {
        const found = await soundcloudTracks(ids);
        if (cancelled || !found.length) return;
        rememberTracks(
          found.map((track) => ({
            id: `soundcloud:${track.id}`,
            title: track.title,
            artist: track.artists || null,
            album: track.album,
            durationMs: track.durationMs,
            cover: track.cover,
            source: "service" as const,
            path: "",
          }))
        );
      } catch {
        // Фоновая догрузка: пользователя не тревожим, строка покажет id
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missing, rememberTracks]);

  /** Уникальные обложки треков плейлиста — из чего выбирать свою. */
  const coverOptions = useMemo(() => {
    if (!coverTarget) return [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const id of coverTarget.trackIds) {
      const cover = known.get(id)?.cover;
      if (cover && !seen.has(cover)) {
        seen.add(cover);
        list.push(cover);
      }
    }
    return list;
  }, [coverTarget, known]);

  /** Воспроизведение с любого места: у сервисного трека берём свежую ссылку. */
  async function playFrom(index: number) {
    const track = openTracks[index];
    if (!track || !open) return;
    if (track.source === "service") {
      /**
       * Сохранённая копия важнее сети: плеер сам сыграет файл с диска. Ссылку
       * спрашиваем только тогда, когда копии нет.
       */
      if (await findOfflineCopy(track.id)) {
        sounds.save();
        playLocal(openTracks, index);
        return;
      }
      setPlaying(true);
      try {
        const fresh = await refreshServiceStream(track);
        if (!fresh.path) {
          throw new Error("Ссылку на трек получить не удалось — проверь подключение сервиса в настройках");
        }
        // Ссылка уже добыта: помечаем свежей, чтобы плеер не спросил её второй раз
        markFreshStream(fresh);
        rememberTracks([cardFromTrack(fresh)]);
        playLocal(
          openTracks.map((item, i) => (i === index ? fresh : item)),
          index
        );
        sounds.save();
      } catch (e) {
        sounds.error();
        const message = offlineFailureMessage(e, false);
        logError(
          "Не удалось включить трек из плейлиста",
          `${track.title} — ${track.artist ?? "неизвестный исполнитель"}: ${message}`,
          "плейлисты",
          errorText(e)
        );
        toast({ title: "Не удалось включить трек", description: message, tone: "danger" });
      } finally {
        setPlaying(false);
      }
      return;
    }
    sounds.save();
    playLocal(openTracks, index);
  }

  /**
   * Сохранить плейлист офлайн целиком. Один плейлист за раз: параллельные
   * загрузки только мешают друг другу и сервису, а прогресс должен быть
   * однозначным.
   */
  async function downloadPlaylist(playlist: Playlist) {
    if (offlineBusy.current) {
      toast({ title: "Сохранение уже идёт", description: "Дождись окончания текущего плейлиста" });
      return;
    }
    if (!playlist.trackIds.length) return;

    const tracks = playlist.trackIds.map((id) => known.get(id) ?? fallbackCard(id));
    offlineBusy.current = true;
    setOfflineJob({ id: playlist.id, done: 0, total: 0, failed: 0 });
    sounds.save();

    try {
      const result = await savePlaylistOffline(tracks, (progress) => {
        setOfflineJob({
          id: playlist.id,
          done: progress.done,
          total: progress.total,
          failed: progress.failed,
        });
      });

      if (result.failed > 0) {
        sounds.error();
        toast({
          title: "Плейлист сохранён не полностью",
          description: `Сохранено ${result.saved}, ошибок ${result.failed}${
            result.firstError ? `: ${result.firstError}` : ""
          }`,
          tone: "danger",
        });
      } else if (result.saved === 0) {
        toast({
          title: "Всё уже офлайн",
          description: `${playlist.name}: скачивать нечего`,
        });
      } else {
        toast({
          title: "Плейлист сохранён офлайн",
          description: `${playlist.name}: ${plural(result.saved, ["трек", "трека", "треков"])}`,
        });
      }
    } catch (e) {
      sounds.error();
      toast({
        title: "Не удалось сохранить плейлист",
        description: offlineFailureMessage(e, false),
        tone: "danger",
      });
    } finally {
      offlineBusy.current = false;
      setOfflineJob(null);
    }
  }

  function submitCreate() {
    const playlist = createPlaylist(draftName, draftNote);
    sounds.save();
    setCreateOpen(false);
    setDraftName("");
    setDraftNote("");
    setOpenId(playlist.id);
    toast({ title: "Плейлист создан", description: playlist.name });
  }

  function startRename(playlist: Playlist) {
    setRenameTarget(playlist);
    setRenameValue(playlist.name);
  }

  function submitRename() {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    renamePlaylist(renameTarget.id, name);
    sounds.save();
    toast({ title: "Плейлист переименован", description: name });
    setRenameTarget(null);
  }

  function submitDelete() {
    if (!deleteTarget) return;
    const name = deleteTarget.name;
    removePlaylist(deleteTarget.id);
    sounds.off();
    if (openId === deleteTarget.id) setOpenId(null);
    toast({ title: "Плейлист удалён", description: name });
    setDeleteTarget(null);
  }

  function pickCover(cover: string | null) {
    if (!coverTarget) return;
    updatePlaylist(coverTarget.id, { cover });
    sounds.save();
    toast({ title: cover ? "Обложка обновлена" : "Обложка убрана", description: coverTarget.name });
    setCoverTarget(null);
  }

  /** Убрать трек и предложить вернуть его на прежнее место. */
  function dropTrack(position: number) {
    if (!open) return;
    const trackId = open.trackIds[position];
    const track = openTracks[position];
    if (!trackId || !track) return;
    const lastIndex = open.trackIds.length - 1;
    removeTrack(open.id, trackId);
    sounds.off();
    toast({
      title: "Трек убран из плейлиста",
      description: track.title,
      action: {
        label: "Вернуть",
        run: () => {
          addTrack(open.id, cardFromTrack(track));
          reorderPlaylist(open.id, lastIndex, position);
        },
      },
    });
  }

  function dropOn(index: number) {
    const state = drag;
    setDrag(null);
    if (!state || !open || state.from === index) return;
    reorderPlaylist(open.id, state.from, index);
    sounds.open();
  }

  const cardMenu = useMenuPlacement(menuId !== null);

  return (
    <div>
      {open ? (
        /* ─────────────── Один плейлист ─────────────── */
        <div>
          <button
            onClick={() => {
              sounds.close();
              setOpenId(null);
            }}
            className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors mb-5"
          >
            <ArrowLeft size={14} /> Все плейлисты
          </button>

          <div className="flex items-end gap-5 flex-wrap mb-6">
            <PlaylistCover playlist={open} cover={open.cover ?? trackCover(open, known)} size={168} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wider text-faint">Плейлист</p>
              <h1 className="text-[24px] font-semibold tracking-tight truncate mt-0.5">{open.name}</h1>
              {open.description && <p className="text-[13px] text-muted mt-1 leading-relaxed">{open.description}</p>}
              <p className="text-[12px] text-muted mt-1">
                {plural(open.trackIds.length, ["трек", "трека", "треков"])}
                {totalMs > 0 ? ` · ${formatDuration(totalMs)}` : open.trackIds.length > 0 ? " · длительность неизвестна" : ""}
              </p>
              {openCoverage && open.trackIds.length > 0 && openCoverage.missing.length > 0 && (
                <p className="text-[11px] text-faint mt-0.5">
                  Без интернета доступно {openCoverage.saved} из {openCoverage.total}
                </p>
              )}
              <div className="flex items-center gap-2 flex-wrap mt-3">
                <PrimaryButton
                  onClick={() => void playFrom(0)}
                  disabled={!open.trackIds.length || playing}
                  className="flex items-center gap-1.5"
                >
                  <Play size={14} fill="currentColor" /> {playing ? "Включаю…" : "Играть"}
                </PrimaryButton>
                {openCoverage && open.trackIds.length > 0 &&
                  (openCoverage.missing.length === 0 ? (
                    <GhostButton
                      disabled
                      title="Все треки плейлиста сохранены на диск"
                      className="flex items-center gap-1.5"
                    >
                      <Check size={13} /> Скачано офлайн
                    </GhostButton>
                  ) : (
                    <GhostButton
                      onClick={() => void downloadPlaylist(open)}
                      disabled={offlineJob !== null}
                      title="Сохранить все треки плейлиста на диск"
                      className="flex items-center gap-1.5"
                    >
                      {offlineJob?.id === open.id ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          {offlineJob.total > 0
                            ? `Сохраняю ${offlineJob.done}/${offlineJob.total}`
                            : "Готовлю…"}
                        </>
                      ) : (
                        <>
                          <Download size={13} /> Скачать офлайн
                          {openCoverage.saved > 0 ? ` · ${openCoverage.missing.length}` : ""}
                        </>
                      )}
                    </GhostButton>
                  ))}
                <GhostButton onClick={() => startRename(open)} className="flex items-center gap-1.5">
                  <Pencil size={13} /> Переименовать
                </GhostButton>
                <GhostButton onClick={() => setCoverTarget(open)} className="flex items-center gap-1.5">
                  <Image size={13} /> Обложка
                </GhostButton>
                <GhostButton
                  onClick={() => setDeleteTarget(open)}
                  className="flex items-center gap-1.5 text-red-400 border-red-500/25 hover:bg-red-500/10"
                >
                  <Trash2 size={13} /> Удалить
                </GhostButton>
              </div>
            </div>
          </div>

          {open.trackIds.length === 0 ? (
            <EmptyState
              Icon={ListMusic}
              title="В плейлисте пусто"
              description="Добавь треки из поиска или библиотеки: в «Моей музыке» у строки есть кнопка «＋» — она предложит этот плейлист. Порядок треков меняется перетаскиванием."
            />
          ) : (
            <div className="space-y-0.5">
              <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] text-faint border-b border-line/[0.06]">
                <span className="w-6 text-right">№</span>
                <span className="flex-1">Название</span>
                <span className="w-10 text-right">Время</span>
                <span className="w-14" />
              </div>
              {openCards.map((card, position) => {
                const track = openTracks[position];
                const active = track.id === currentId;
                const dropping = drag !== null && drag.over === position && drag.from !== position;
                return (
                  <div
                    key={card.id}
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={(event) => {
                      // С кнопок строки перетаскивание не начинаем: там свои клики
                      if ((event.target as HTMLElement).closest("button")) {
                        event.preventDefault();
                        return;
                      }
                      setDrag({ from: position, over: position });
                      event.dataTransfer.effectAllowed = "move";
                      // Без данных часть движков не начинает перетаскивание вовсе
                      event.dataTransfer.setData("text/plain", String(position));
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      if (drag && drag.over !== position) setDrag({ ...drag, over: position });
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      dropOn(position);
                    }}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => (active ? undefined : void playFrom(position))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void playFrom(position);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors group cursor-pointer border-t-2 ${
                      dropping
                        ? "border-accent bg-accent/[0.06]"
                        : active
                          ? "border-transparent bg-accent/10"
                          : "border-transparent hover:bg-ink/[0.05]"
                    }`}
                  >
                    <span className="w-6 text-right text-[12px] text-faint tnum shrink-0">{position + 1}</span>
                    <GripVertical
                      size={14}
                      className="text-faint opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing shrink-0"
                    />
                    <Cover src={card.cover} size={32} hoverIcon service={serviceFromTrackId(card.id)} />
                    <span className="flex-1 min-w-0">
                      <span className={`block text-[13px] truncate ${active ? "text-accentText" : ""}`}>
                        {card.title}
                      </span>
                      <span className="block text-[12px] text-muted truncate">
                        {card.artist ?? "Неизвестный исполнитель"}
                      </span>
                    </span>
                    <span className="w-10 text-right text-[12px] text-muted tnum shrink-0">
                      {formatDuration(card.durationMs)}
                    </span>
                    <span className="w-14 flex items-center justify-end gap-0.5 shrink-0">
                      {/* Текущий трек не перезапускаем: индикатор вместо кнопки */}
                      {active ? (
                        <span title="Играет сейчас" className="p-1.5 text-accentText">
                          <Check size={14} strokeWidth={2.2} />
                        </span>
                      ) : (
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void playFrom(position);
                          }}
                          aria-label="Включить трек"
                          title="Включить"
                          className="p-1.5 rounded-lg text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
                        >
                          <Play size={14} />
                        </button>
                      )}
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          dropTrack(position);
                        }}
                        aria-label="Убрать из плейлиста"
                        title="Убрать из плейлиста"
                        className="p-1.5 rounded-lg text-faint hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                      >
                        <X size={14} />
                      </button>
                    </span>
                  </div>
                );
              })}
              <p className="px-3 pt-2 text-[11px] text-faint">
                Перетаскивай строки за любую свободную часть — порядок сохранится сразу
              </p>
            </div>
          )}
        </div>
      ) : (
        /* ─────────────── Сетка плейлистов ─────────────── */
        <div>
          <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
            <div>
              <h1 className="text-[20px] font-semibold tracking-tight">Плейлисты</h1>
              <p className="text-[13px] text-muted mt-1">
                {items.length > 0
                  ? `${plural(items.length, ["плейлист", "плейлиста", "плейлистов"])} · порядок треков сохраняется`
                  : "Свои подборки треков: обложка, порядок и переименование"}
              </p>
            </div>
            <PrimaryButton
              onClick={() => {
                sounds.open();
                setCreateOpen(true);
              }}
              className="flex items-center gap-1.5"
            >
              <Plus size={15} /> Новый плейлист
            </PrimaryButton>
          </div>

          {items.length === 0 ? (
            <EmptyState
              Icon={ListMusic}
              title="Плейлистов пока нет"
              description="Создай первый плейлист, а треки добавь из «Моей музыки» или из поиска — у каждой строки есть кнопка «＋»."
              action={
                <PrimaryButton
                  onClick={() => {
                    sounds.open();
                    setCreateOpen(true);
                  }}
                  className="flex items-center gap-1.5"
                >
                  <Plus size={14} /> Новый плейлист
                </PrimaryButton>
              }
            />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {items.map((playlist, index) => {
                const cover = playlist.cover ?? trackCover(playlist, known);
                const itemCoverage = coverage.get(playlist.id);
                return (
                  <motion.div
                    key={playlist.id}
                    initial={{ y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(index, 8) * 0.02 }}
                    className="group relative"
                  >
                    <button
                      onClick={() => {
                        sounds.open();
                        setOpenId(playlist.id);
                      }}
                      className="w-full text-left"
                    >
                      <span className="relative block aspect-square rounded-xl overflow-hidden border border-line/[0.07] bg-inset">
                        {cover ? (
                          <img
                            src={toPlayableUrl(cover)}
                            alt=""
                            draggable={false}
                            className="absolute inset-0 w-full h-full object-cover"
                          />
                        ) : (
                          <span
                            className="absolute inset-0 flex items-center justify-center text-coverInk text-[26px] font-semibold"
                            style={{ background: coverFor(playlist) }}
                          >
                            {initials(playlist.name)}
                          </span>
                        )}
                        <span className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <span className="w-11 h-11 rounded-full bg-accent text-onAccent flex items-center justify-center shadow-lift">
                            <Play size={18} fill="currentColor" className="ml-0.5" />
                          </span>
                        </span>
                        {itemCoverage &&
                          playlist.trackIds.length > 0 &&
                          itemCoverage.missing.length === 0 && (
                            <span className="absolute top-2 left-2 z-10 flex items-center gap-1 rounded-md bg-app/80 backdrop-blur-sm px-1.5 py-0.5 text-[10px] text-emerald-400 border border-emerald-500/20">
                              <Check size={11} /> офлайн
                            </span>
                          )}
                        {offlineJob?.id === playlist.id && (
                          <span className="absolute inset-x-2 bottom-2 z-10 rounded-md bg-black/75 px-2 py-1 text-[10px] text-white flex items-center gap-1.5">
                            <Loader2 size={11} className="animate-spin" />
                            {offlineJob.total > 0
                              ? `${offlineJob.done}/${offlineJob.total}`
                              : "Готовлю…"}
                          </span>
                        )}
                      </span>
                      <span className="block mt-2.5 text-[13px] font-medium truncate">{playlist.name}</span>
                      <span className="block text-[12px] text-muted truncate">
                        {plural(playlist.trackIds.length, ["трек", "трека", "треков"])}
                      </span>
                    </button>

                    <div className="absolute top-2 right-2 z-20" ref={menuId === playlist.id ? cardMenu.ref : undefined}>
                      <button
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          sounds.open();
                          setMenuId(menuId === playlist.id ? null : playlist.id);
                        }}
                        aria-label="Действия с плейлистом"
                        title="Действия"
                        className={`p-1.5 rounded-lg bg-app/70 backdrop-blur-sm text-muted hover:text-ink transition-all ${
                          menuId === playlist.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                        }`}
                      >
                        <Ellipsis size={15} />
                      </button>
                      <AnimatePresence>
                        {menuId === playlist.id && (
                          <DropdownMenu
                            up={cardMenu.up}
                            onClose={() => setMenuId(null)}
                            items={[
                              { label: "Переименовать", icon: <Pencil size={13} />, run: () => startRename(playlist) },
                              {
                                label: "Сменить обложку",
                                icon: <Image size={13} />,
                                run: () => setCoverTarget(playlist),
                              },
                              ...(itemCoverage && itemCoverage.missing.length > 0
                                ? [
                                    {
                                      label:
                                        offlineJob?.id === playlist.id
                                          ? "Сохраняется…"
                                          : "Скачать офлайн",
                                      icon: <Download size={13} />,
                                      run: () => void downloadPlaylist(playlist),
                                    },
                                  ]
                                : []),
                              {
                                label: "Удалить",
                                icon: <Trash2 size={13} />,
                                run: () => setDeleteTarget(playlist),
                                danger: true,
                              },
                            ]}
                          />
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─────────────── Модалки ─────────────── */}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Новый плейлист"
        description="Название и описание можно поменять в любой момент."
        footer={
          <>
            <GhostButton onClick={() => setCreateOpen(false)}>Отмена</GhostButton>
            <PrimaryButton onClick={submitCreate}>Создать и открыть</PrimaryButton>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="block text-[12px] text-muted mb-1.5">Название</span>
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitCreate();
              }}
              maxLength={80}
              placeholder="Мой плейлист"
              className="w-full h-9 px-3 rounded-lg bg-inset border border-line/[0.10] text-[13px] outline-none focus:border-accent/40 transition-colors"
            />
          </label>
          <label className="block">
            <span className="block text-[12px] text-muted mb-1.5">Описание (необязательно)</span>
            <textarea
              value={draftNote}
              onChange={(event) => setDraftNote(event.target.value)}
              rows={2}
              maxLength={200}
              placeholder="Например: для дороги"
              className="w-full px-3 py-2 rounded-lg bg-inset border border-line/[0.10] text-[13px] outline-none focus:border-accent/40 transition-colors resize-none"
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Переименовать плейлист"
        footer={
          <>
            <GhostButton onClick={() => setRenameTarget(null)}>Отмена</GhostButton>
            <PrimaryButton onClick={submitRename} disabled={!renameValue.trim()}>
              Сохранить
            </PrimaryButton>
          </>
        }
      >
        <input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitRename();
          }}
          maxLength={80}
          placeholder="Название плейлиста"
          className="w-full h-9 px-3 rounded-lg bg-inset border border-line/[0.10] text-[13px] outline-none focus:border-accent/40 transition-colors"
        />
      </Modal>

      <Modal
        open={coverTarget !== null}
        onClose={() => setCoverTarget(null)}
        title="Обложка плейлиста"
        description="Выбери обложку одного из треков — или оставь градиент с инициалами."
        footer={<GhostButton onClick={() => setCoverTarget(null)}>Закрыть</GhostButton>}
      >
        {coverOptions.length === 0 ? (
          <p className="text-[12px] text-muted">
            У треков этого плейлиста нет обложек — покажем градиент с инициалами названия.
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-2 max-h-64 overflow-y-auto pr-1">
            {coverOptions.map((option) => {
              const selected = coverTarget?.cover === option;
              return (
                <button
                  key={option}
                  onClick={() => pickCover(option)}
                  aria-pressed={selected}
                  className={`relative aspect-square rounded-lg overflow-hidden border transition-colors ${
                    selected ? "border-accent" : "border-line/[0.10] hover:border-line/25"
                  }`}
                >
                  <img
                    src={toPlayableUrl(option)}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {selected && (
                    <span className="absolute inset-0 bg-accent/25 flex items-center justify-center text-white">
                      <Check size={18} strokeWidth={2.4} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {coverTarget?.cover && (
          <GhostButton onClick={() => pickCover(null)} className="mt-3 w-full">
            Убрать обложку
          </GhostButton>
        )}
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Удалить плейлист «${deleteTarget?.name ?? ""}»?`}
        description="Сами треки останутся в библиотеке и в избранном — пропадёт только список."
        footer={
          <>
            <GhostButton onClick={() => setDeleteTarget(null)}>Отмена</GhostButton>
            <DangerButton onClick={submitDelete}>Удалить</DangerButton>
          </>
        }
      >
        <p className="text-[12px] text-muted">
          В плейлисте {plural(deleteTarget?.trackIds.length ?? 0, ["трек", "трека", "треков"])}. Отменить удаление
          будет нельзя.
        </p>
      </Modal>
    </div>
  );
}

/** Обложка плейлиста: своя, из трека или градиент с инициалами. */
function PlaylistCover({
  playlist,
  cover,
  size,
}: {
  playlist: Playlist;
  cover: string | null;
  size: number;
}) {
  return (
    <span
      className="relative rounded-2xl overflow-hidden border border-line/[0.07] bg-inset shrink-0 shadow-lift"
      style={{ width: size, height: size }}
    >
      {cover ? (
        <img src={toPlayableUrl(cover)} alt="" draggable={false} className="w-full h-full object-cover" />
      ) : (
        <span
          className="w-full h-full flex items-center justify-center text-coverInk font-semibold"
          style={{ background: coverFor(playlist), fontSize: Math.round(size * 0.28) }}
        >
          {initials(playlist.name)}
        </span>
      )}
    </span>
  );
}
