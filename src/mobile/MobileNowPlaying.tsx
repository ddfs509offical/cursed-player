/**
 * Полноэкранный плеер для телефона.
 *
 * Обложка во всю ширину, крупные название и исполнитель, перемотка, транспорт
 * и лайк. Свайпом вниз плеер закрывается — на телефоне это привычнее крестика.
 */
import { useRef } from "react";
import {
  ChevronDown,
  Heart,
  Loader2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { usePlayerStore } from "../store/playerStore";
import { useFavoritesStore } from "../store/favoritesStore";
import { formatTime } from "./shared";

export default function MobileNowPlaying({ onClose }: { onClose: () => void }) {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const progress = usePlayerStore((s) => s.progress);
  const position = usePlayerStore((s) => s.position);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const trackTitle = usePlayerStore((s) => s.trackTitle);
  const trackArtist = usePlayerStore((s) => s.trackArtist);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const seekFraction = usePlayerStore((s) => s.seekFraction);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);

  const favoriteIds = useFavoritesStore((s) => s.ids);
  const toggleFavorite = useFavoritesStore((s) => s.toggle);
  const track = index >= 0 ? queue[index] : null;
  const liked = track ? favoriteIds.includes(track.id) : false;

  // Свайп вниз по экрану закрывает плеер.
  const startY = useRef<number | null>(null);
  function onTouchStart(event: React.TouchEvent) {
    startY.current = event.touches[0]?.clientY ?? null;
  }
  function onTouchEnd(event: React.TouchEvent) {
    if (startY.current === null) return;
    const endY = event.changedTouches[0]?.clientY ?? startY.current;
    if (endY - startY.current > 90) onClose();
    startY.current = null;
  }

  return (
    <div className="m-now" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="m-now__bar">
        <button className="m-icon-btn" aria-label="Свернуть плеер" onClick={onClose}>
          <ChevronDown size={20} />
        </button>
        <span style={{ fontSize: 11, letterSpacing: "0.12em", color: "rgb(var(--color-faint))" }}>
          ИГРАЕТ СЕЙЧАС
        </span>
        <button
          className="m-icon-btn"
          aria-label="Перемешать"
          onClick={() => toggleShuffle()}
          style={{ opacity: shuffle ? 1 : 0.45 }}
        >
          <Shuffle size={18} />
        </button>
      </div>

      <div className="m-now__cover">
        {track?.cover ? <img src={track.cover} alt="" draggable={false} /> : "♪"}
      </div>

      <div className="m-now__title">{trackTitle || track?.title || "Ничего не играет"}</div>
      <div className="m-now__artist">{trackArtist || "неизвестный исполнитель"}</div>

      <div
        className="m-now__seek"
        role="slider"
        aria-label="Перемотка"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          seekFraction(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
        }}
      >
        <span style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="m-now__times">
        <span>{formatTime(position * 1000)}</span>
        <span>{formatTime(durationMs)}</span>
      </div>

      <div className="m-now__controls">
        <button
          className="m-icon-btn"
          aria-label="Повтор"
          onClick={() => cycleRepeat()}
          style={{ opacity: repeat === "off" ? 0.45 : 1 }}
        >
          {repeat === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}
        </button>
        <button className="m-now__side" aria-label="Предыдущий" onClick={() => previous()}>
          <SkipBack size={22} fill="currentColor" />
        </button>
        <button
          className="m-now__play"
          aria-label={isPlaying ? "Пауза" : "Играть"}
          onClick={() => togglePlay()}
        >
          {isLoading ? (
            <Loader2 size={26} className="animate-spin" />
          ) : isPlaying ? (
            <Pause size={26} fill="currentColor" />
          ) : (
            <Play size={26} fill="currentColor" />
          )}
        </button>
        <button className="m-now__side" aria-label="Следующий" onClick={() => next()}>
          <SkipForward size={22} fill="currentColor" />
        </button>
        <button
          className="m-icon-btn"
          aria-label={liked ? "Убрать из избранного" : "В избранное"}
          onClick={() => {
            if (!track) return;
            toggleFavorite({
              id: track.id,
              title: track.title,
              artist: track.artist,
              cover: track.cover ?? null,
              source: track.source,
              path: track.source === "service" ? "" : track.path,
            });
          }}
          style={{ color: liked ? "#f87171" : undefined }}
        >
          <Heart size={18} fill={liked ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
  );
}
