import { motion } from "framer-motion";
import { X, Play, Pause, Trash2, ListMusic } from "lucide-react";
import { usePlayerStore } from "../store/playerStore";
import { formatDuration } from "../services/catalog";
import { serviceFromTrackId } from "../lib/services";
import { ArtistLink } from "./ArtistWindow";
import { sounds } from "../lib/sounds";
import { useExitGuard } from "../lib/useExitGuard";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Очередь воспроизведения: что играет дальше, с переходом и удалением. */
export default function QueuePanel({ open, onClose }: Props) {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const jumpTo = usePlayerStore((s) => s.jumpTo);
  const removeAt = usePlayerStore((s) => s.removeAt);
  const clearQueue = usePlayerStore((s) => s.clearQueue);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  /** Панель уходит по таймеру и сразу перестаёт ловить клики (см. useExitGuard). */
  const { mounted, leaving } = useExitGuard(open);

  if (!mounted) return null;

  const total = queue.reduce((sum, track) => sum + track.durationMs, 0);

  return (
    <motion.aside
      initial={{ x: 320 }}
      animate={leaving ? { x: 320, opacity: 0 } : { x: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      style={leaving ? { pointerEvents: "none" } : undefined}
      className="glass-raised absolute right-0 top-0 bottom-0 w-80 z-40 border-l border-line/[0.07] bg-surface/70 backdrop-blur-[16px] flex flex-col"
    >
      <div className="flex items-center gap-2 px-4 h-14 shrink-0 border-b border-line/[0.06]">
        <ListMusic size={15} className="text-faint" />
        <span className="text-[13px] font-medium">Очередь</span>
        <span className="text-[12px] text-muted">{queue.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => {
              clearQueue();
              sounds.off();
              onClose();
            }}
            title="Очистить очередь"
            aria-label="Очистить очередь"
            className="p-1.5 rounded-lg text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
          >
            <Trash2 size={13} />
          </button>
          <button
            onClick={() => {
              sounds.close();
              onClose();
            }}
            aria-label="Закрыть очередь"
            className="p-1.5 rounded-lg text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <p className="px-4 py-2 text-[11px] text-faint border-b border-line/[0.06]">
        Всего {formatDuration(total)} · {queue.filter((t) => t.source === "local").length} локальных,{" "}
        {queue.filter((t) => t.source === "service").length} из сервиса
      </p>

      <div className="flex-1 overflow-y-auto py-1">
        {queue.length === 0 && (
          <p className="text-[13px] text-muted text-center py-10 px-6">
            Очередь пуста. Открой файлы или включи трек из поиска.
          </p>
        )}
        {queue.map((track, position) => {
          const active = position === index;
          /**
           * У сервисного трека SoundCloud имя исполнителя — ссылка: клик по ней
           * открывает окно артиста и строку не включает (ArtistLink сам гасит
           * всплытие). Клик по остальной части строки работает как раньше.
           */
          const artistForLink =
            track.artist?.trim() && serviceFromTrackId(track.id) === "soundcloud" ? track.artist : null;
          return (
            <div
              key={`${track.id}-${position}`}
              className={`group flex items-center gap-2 px-3 py-2 ${active ? "bg-accent/10" : "hover:bg-ink/[0.04]"}`}
            >
              <button
                onClick={() => {
                  if (active) togglePlay();
                  else jumpTo(position);
                }}
                aria-label={active && isPlaying ? "Пауза" : "Играть"}
                className="w-5 shrink-0 text-faint hover:text-ink transition-colors"
              >
                {active && isPlaying ? <Pause size={12} /> : <Play size={12} />}
              </button>
              <button
                onClick={() => (active ? togglePlay() : jumpTo(position))}
                className="min-w-0 flex-1 text-left"
              >
                <span className={`block text-[12px] truncate ${active ? "text-accentText" : ""}`}>
                  {track.title}
                </span>
                <span className="block text-[11px] text-muted truncate">
                  {artistForLink ? <ArtistLink name={artistForLink} /> : (track.artist ?? "Неизвестный исполнитель")}
                  {track.source === "service" ? " · сервис" : ""}
                </span>
              </button>
              <span className="text-[11px] text-faint tnum shrink-0">{formatDuration(track.durationMs)}</span>
              <button
                onClick={() => removeAt(position)}
                aria-label="Убрать из очереди"
                className="p-1 rounded text-faint opacity-0 group-hover:opacity-100 hover:text-ink transition-all shrink-0"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </motion.aside>
  );
}
