/**
 * Тренды SoundCloud для главной «Обсидиан».
 *
 * Та же работа, что у прежнего блока, но подача другая: это лента обложек,
 * а не список с фильтрами сверху. Фильтры (регион, жанр, альбомы) спрятаны в
 * одну строку над лентой и видны только когда нужны.
 */
import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
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
import { useServiceStore } from "../store/serviceStore";
import { findOfflineCopy } from "../store/offlineStore";
import { offlineFailureMessage } from "../lib/offline";
import { logError, errorText } from "../store/errorStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";

const REGIONS = [
  { id: "world", label: "Мир", region: "" },
  { id: "ru", label: "Россия", region: "RU" },
] as const;

function sameTracks(a: SearchTrack[], b: SearchTrack[]): boolean {
  return a.length === b.length && a.every((track, index) => track.id === b[index].id);
}

interface Props {
  onPlay: (track: SearchTrack) => void;
}

export default function ObsidianCharts({ onPlay }: Props) {
  const [genre, setGenre] = useState(SOUNDCLOUD_GENRES[0].id);
  const [regionId, setRegionId] = useState<(typeof REGIONS)[number]["id"]>("world");
  const [tracks, setTracks] = useState<SearchTrack[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const connected = useServiceStore((s) => s.available.soundcloud);
  const region = REGIONS.find((item) => item.id === regionId)?.region ?? "";

  async function load(nextGenre: string, nextRegion: string, force = false) {
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      if (nextRegion) {
        const empty: CachedTracks = { tracks: [], fromCache: false, stale: false };
        const [regional, world] = await Promise.all([
          soundcloudChartsCached(nextGenre, nextRegion, force).catch(() => empty),
          soundcloudChartsCached(nextGenre, "", force),
        ]);
        const regionalWorks = regional.tracks.length > 0 && !sameTracks(regional.tracks, world.tracks);
        setTracks(regionalWorks ? regional.tracks : world.tracks);
        setStale(regionalWorks ? regional.stale : world.stale);
        return;
      }
      const result = await soundcloudChartsCached(nextGenre, "", force);
      setTracks(result.tracks);
      setStale(result.stale);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      logError("Не удалось загрузить тренды SoundCloud", message, "главная", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (connected) void load(SOUNDCLOUD_GENRES[0].id, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  if (!connected) return null;

  return (
    <section className="obs-section-block">
      <header className="obs-section-head">
        <h2 className="obs-title">Тренды SoundCloud</h2>
        {stale && <span className="obs-label">из кеша</span>}
        <span className="obs-section-head__spacer" />
        <div className="obs-chips">
          {REGIONS.map((item) => (
            <button
              key={item.id}
              className="obs-chip"
              data-on={regionId === item.id}
              onClick={() => {
                sounds.open();
                setRegionId(item.id);
                void load(genre, item.region);
              }}
            >
              {item.label}
            </button>
          ))}
          {SOUNDCLOUD_GENRES.slice(0, 5).map((item) => (
            <button
              key={item.id}
              className="obs-chip"
              data-on={genre === item.id}
              onClick={() => {
                sounds.open();
                setGenre(item.id);
                void load(item.id, region);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          className="obs-icon"
          onClick={() => void load(genre, region, true)}
          aria-label="Обновить тренды"
          title="Обновить"
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        </button>
      </header>

      {error && (
        <div className="obs-note">
          <span>{error}</span>
          <button className="obs-chip" onClick={() => void load(genre, region)}>
            Ещё раз
          </button>
        </div>
      )}

      {busy && tracks.length === 0 && (
        <div className="obs-note">
          <Loader2 size={14} className="animate-spin" /> Загружаю тренды…
        </div>
      )}

      {tracks.length > 0 && (
        <div className="obs-row-scroll">
          {tracks.slice(0, 16).map((track) => (
            <button
              key={track.id}
              className="obs-card"
              onClick={() => void play(track)}
              title={`Включить: ${track.title}`}
            >
              <span className="obs-card__plate obs-plate">
                <Cover src={track.cover} size={132} rounded="rounded-none" className="w-full h-full" />
                <span className="obs-card__play" aria-hidden="true">
                  <Play />
                </span>
              </span>
              <span className="obs-card__title">{track.title}</span>
              <span className="obs-card__sub">
                {track.artists || "SoundCloud"} · {formatDuration(track.durationMs)}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );

  /** Включение тренда: офлайн-копия сильнее ссылки, иначе берём свежий поток. */
  async function play(track: SearchTrack) {
    const id = `soundcloud:${track.id}`;
    const copy = await findOfflineCopy(id);
    if (copy) {
      usePlayerStore.getState().playNow(copy);
      sounds.save();
      toast({ title: `Играю: ${copy.title}`, description: "Офлайн-копия с диска" });
      return;
    }
    onPlay(track);
    try {
      const clientId = await getServiceToken("soundcloud");
      if (!clientId) throw new Error("SoundCloud: нужен client_id — добавь в настройках");
      const url = await soundcloudStreamUrl(clientId, track.id);
      usePlayerStore.getState().playNow({
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
    } catch (e) {
      const message = offlineFailureMessage(e, false);
      sounds.error();
      logError("Не удалось включить трек из трендов", `${track.title}: ${message}`, "главная", errorText(e));
      toast({ title: "Не удалось включить трек", description: message, tone: "danger" });
    }
  }
}

function Play() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
