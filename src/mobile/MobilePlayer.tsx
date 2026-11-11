/**
 * Мини-плеер для мобильного интерфейса.
 *
 * Отдельный от настольного: другой размер, другой порядок кнопок и место над
 * нижней навигацией. Логика та же — всё через playerStore, поэтому состояние
 * одно на всё приложение.
 */
import { ChevronUp, Loader2, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { usePlayerStore } from "../store/playerStore";
import { formatTime } from "./shared";

export default function MobilePlayer({ onOpen }: { onOpen: () => void }) {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const progress = usePlayerStore((s) => s.progress);
  const position = usePlayerStore((s) => s.position);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const trackTitle = usePlayerStore((s) => s.trackTitle);
  const trackArtist = usePlayerStore((s) => s.trackArtist);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);

  const track = index >= 0 ? queue[index] : null;
  if (!track && !trackTitle) return null;

  const cover = track?.cover ?? "";

  return (
    <div className="m-player" onClick={onOpen} role="button" tabIndex={0}>
      <div className="m-player__cover">
        {cover ? <img src={cover} alt="" draggable={false} /> : "♪"}
      </div>
      <div className="m-player__meta">
        <div className="m-player__title">{trackTitle || track?.title || "Ничего не играет"}</div>
        <div className="m-player__artist">{trackArtist || "неизвестный исполнитель"}</div>
      </div>
      <div className="m-player__controls" onClick={(event) => event.stopPropagation()}>
        <button className="m-player__btn" aria-label="Предыдущий" onClick={() => previous()}>
          <SkipBack size={18} fill="currentColor" />
        </button>
        <button
          className="m-player__btn"
          aria-label={isPlaying ? "Пауза" : "Играть"}
          onClick={() => togglePlay()}
        >
          {isLoading ? (
            <Loader2 size={20} className="animate-spin" />
          ) : isPlaying ? (
            <Pause size={20} fill="currentColor" />
          ) : (
            <Play size={20} fill="currentColor" />
          )}
        </button>
        <button className="m-player__btn" aria-label="Следующий" onClick={() => next()}>
          <SkipForward size={18} fill="currentColor" />
        </button>
      </div>
      <button
        className="m-player__btn"
        aria-label="Развернуть плеер"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <ChevronUp size={18} />
      </button>
      <div className="m-player__progress">
        <span style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <span className="sr-only">
        {formatTime(position * 1000)} из {formatTime(durationMs)}
      </span>
    </div>
  );
}
