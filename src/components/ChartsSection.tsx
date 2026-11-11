import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, RefreshCw, TrendingUp } from "lucide-react";
import Cover from "./Cover";
import {
  SOUNDCLOUD_GENRES,
  formatDuration,
  getServiceToken,
  soundcloudChartsCached,
  soundcloudStreamUrl,
  type CachedTracks,
  type SearchTrack,
} from "../services/catalog";
import { usePlayerStore } from "../store/playerStore";
import { findOfflineCopy } from "../store/offlineStore";
import { offlineFailureMessage } from "../lib/offline";
import { useServiceStore } from "../store/serviceStore";
import { logError, errorText } from "../store/errorStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";

/** Регион трендов: западные — общемировые, русские — с параметром region=RU. */
const REGIONS = [
  { id: "world", label: "Западные", region: "" },
  { id: "ru", label: "Русские", region: "RU" },
] as const;

type RegionId = (typeof REGIONS)[number]["id"];

/** SoundCloud отдаёт региональные тренды не всегда — говорим об этом прямо. */
const REGION_FALLBACK_NOTE = "SoundCloud не отдаёт региональные тренды — это общий список";

/** Совпадают ли два списка трендов по идентификаторам треков и их порядку. */
function sameTracks(a: SearchTrack[], b: SearchTrack[]): boolean {
  return a.length === b.length && a.every((track, index) => track.id === b[index].id);
}

/** «Предполагаемый альбом»: треки одного исполнителя, идущие подряд. */
interface AlbumGroup {
  id: string;
  artist: string;
  cover: string | null;
  tracks: SearchTrack[];
}

/**
 * SoundCloud не отдаёт альбомы в трендах, поэтому «Альбомы» собираем сами:
 * идущие подряд треки одного исполнителя схлопываем в один пункт.
 */
function groupByArtist(tracks: SearchTrack[]): AlbumGroup[] {
  const groups: AlbumGroup[] = [];
  tracks.forEach((track) => {
    const artist = track.artists || "SoundCloud";
    const last = groups[groups.length - 1];
    if (last && last.artist === artist) {
      last.tracks.push(track);
      return;
    }
    groups.push({ id: `${artist}-${groups.length}`, artist, cover: track.cover, tracks: [track] });
  });
  return groups;
}

/** «1 трек», «3 трека», «11 треков». */
function tracksLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} трек`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} трека`;
  return `${count} треков`;
}

/**
 * Тренды SoundCloud на главной: то, что сервис продвигает прямо сейчас.
 * Можно смотреть западные или русские тренды, а также «Альбомы» —
 * те же тренды, сгруппированные по исполнителю.
 */
export default function ChartsSection() {
  const [genre, setGenre] = useState(SOUNDCLOUD_GENRES[0].id);
  const [regionId, setRegionId] = useState<RegionId>("world");
  const [albums, setAlbums] = useState(false);
  const [tracks, setTracks] = useState<SearchTrack[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Регион не поддержан: показываем общий список и честную подпись. */
  const [regionFallback, setRegionFallback] = useState(false);
  /** Тренды из кеша: сеть не ответила, показываем сохранённое без ошибки. */
  const [stale, setStale] = useState(false);

  const playNow = usePlayerStore((s) => s.playNow);
  const connected = useServiceStore((s) => s.available.soundcloud);

  const region = REGIONS.find((item) => item.id === regionId)?.region ?? "";

  /**
   * Загрузка трендов. Для «Русских» берём региональный список и общий: если
   * регион пуст или отдал тот же список, показываем общий и подписываем это.
   * Для «Западных» регион не запрашиваем вовсе.
   */
  async function load(nextGenre: string, nextRegion: string, force = false) {
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      if (nextRegion) {
        const empty: CachedTracks = { tracks: [], fromCache: false, stale: false };
        const [regional, world] = await Promise.all([
          // Неудача с регионом не должна ронять раздел: сравниваем с общим списком
          soundcloudChartsCached(nextGenre, nextRegion, force).catch(() => empty),
          soundcloudChartsCached(nextGenre, "", force),
        ]);
        const regionalWorks = regional.tracks.length > 0 && !sameTracks(regional.tracks, world.tracks);
        setTracks(regionalWorks ? regional.tracks : world.tracks);
        setRegionFallback(!regionalWorks);
        // Подпись про кеш уместна только для того списка, который показали
        setStale(regionalWorks ? regional.stale : world.stale);
        return;
      }
      setRegionFallback(false);
      const result = await soundcloudChartsCached(nextGenre, "", force);
      setTracks(result.tracks);
      setStale(result.stale);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setStale(false);
      logError("Не удалось загрузить тренды SoundCloud", message, "главная", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (connected) void load(SOUNDCLOUD_GENRES[0].id, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  async function play(track: SearchTrack) {
    const id = `soundcloud:${track.id}`;
    /**
     * Тренды кешируются и видны без интернета: если трек уже сохранён офлайн,
     * играем копию с диска и ссылку у сервиса не спрашиваем.
     */
    const copy = await findOfflineCopy(id);
    if (copy) {
      playNow(copy);
      sounds.save();
      toast({ title: `Играю: ${copy.title}`, description: "Офлайн-копия с диска" });
      return;
    }
    try {
      const clientId = await getServiceToken("soundcloud");
      if (!clientId) throw new Error("SoundCloud: нужен client_id — добавь в настройках");
      const url = await soundcloudStreamUrl(clientId, track.id);
      playNow({
        id,
        path: url,
        title: track.title,
        artist: track.artists || null,
        album: null,
        durationMs: track.durationMs,
        source: "service",
        cover: track.cover,
      });
      sounds.save();
      toast({ title: `Играю: ${track.title}`, description: `${track.artists} · SoundCloud` });
    } catch (e) {
      const message = offlineFailureMessage(e, false);
      sounds.error();
      logError("Не удалось включить трек из трендов", `${track.title}: ${message}`, "главная", errorText(e));
      toast({ title: "Не удалось включить трек", description: message, tone: "danger" });
    }
  }

  if (!connected) return null;

  const groups = groupByArtist(tracks);
  const toggleClass = (active: boolean) =>
    `h-7 px-2.5 rounded-lg text-[12px] transition-colors ${
      active ? "bg-ink/[0.10] text-ink" : "text-muted hover:text-ink hover:bg-ink/[0.05]"
    }`;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <TrendingUp size={14} className="text-faint" />
        <h2 className="text-[13px] font-semibold tracking-tight">Тренды SoundCloud</h2>
        {albums && <span className="text-[11px] text-faint">Предполагаемые альбомы</span>}
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {REGIONS.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                sounds.open();
                setRegionId(item.id);
                void load(genre, item.region);
              }}
              className={toggleClass(regionId === item.id)}
            >
              {item.label}
            </button>
          ))}
          <button
            onClick={() => {
              sounds.open();
              setAlbums((value) => !value);
            }}
            className={toggleClass(albums)}
          >
            Альбомы
          </button>
          <span className="w-px h-4 bg-line/[0.12] mx-0.5" />
          {SOUNDCLOUD_GENRES.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                sounds.open();
                setGenre(item.id);
                void load(item.id, region);
              }}
              className={toggleClass(genre === item.id)}
            >
              {item.label}
            </button>
          ))}
          <button
            onClick={() => {
              sounds.open();
              // Ручное обновление обязано сходить в сеть, минуя кеш
              void load(genre, region, true);
            }}
            aria-label="Обновить тренды"
            className="p-1.5 rounded-lg text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
          >
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {regionFallback && <p className="text-[12px] text-faint mb-2">{REGION_FALLBACK_NOTE}</p>}

      {/* Сеть не ответила, но тренды нашлись в кеше — блок ошибки не показываем */}
      {stale && <p className="text-[12px] text-faint mb-2">Сеть не ответила — показаны сохранённые результаты</p>}

      {error && !stale && (
        <div className="flex items-center gap-3 p-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] mb-2">
          <span className="text-[12px] text-muted flex-1">{error}</span>
          <button
            onClick={() => void load(genre, region)}
            className="h-8 px-3 rounded-lg border border-line/[0.12] text-[12px] hover:bg-ink/[0.06] transition-colors shrink-0"
          >
            Попробовать снова
          </button>
        </div>
      )}

      {busy && tracks.length === 0 && (
        <div className="flex items-center gap-2 text-[12px] text-faint py-6 justify-center">
          <Loader2 size={14} className="animate-spin" /> Загружаю тренды…
        </div>
      )}

      {/* Альбомы: тренды, схлопнутые по исполнителю */}
      {albums && groups.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {groups.slice(0, 12).map((group, index) => (
            <motion.button
              key={group.id}
              initial={{ y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, delay: Math.min(index, 11) * 0.03, ease: [0.2, 0, 0, 1] }}
              onClick={() => void play(group.tracks[0])}
              className="p-2.5 rounded-xl border border-line/[0.07] bg-surface hover:border-line/20 hover:bg-surface2 transition-colors text-left group"
            >
              <Cover src={group.cover} size={140} rounded="rounded-lg" hoverIcon className="w-full mb-2" />
              <span className="block text-[13px] truncate">{group.artist}</span>
              <span className="block text-[12px] text-muted truncate">
                {tracksLabel(group.tracks.length)} · {group.tracks[0].title}
              </span>
            </motion.button>
          ))}
        </div>
      )}

      {!albums && tracks.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {tracks.slice(0, 12).map((track, index) => (
            <motion.button
              key={track.id}
              initial={{ y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, delay: Math.min(index, 11) * 0.03, ease: [0.2, 0, 0, 1] }}
              onClick={() => void play(track)}
              className="p-2.5 rounded-xl border border-line/[0.07] bg-surface hover:border-line/20 hover:bg-surface2 transition-colors text-left group"
            >
              <Cover src={track.cover} size={140} rounded="rounded-lg" hoverIcon className="w-full mb-2" />
              <span className="block text-[13px] truncate">{track.title}</span>
              <span className="block text-[12px] text-muted truncate">
                {track.artists} · {formatDuration(track.durationMs)}
              </span>
            </motion.button>
          ))}
        </div>
      )}
    </section>
  );
}
