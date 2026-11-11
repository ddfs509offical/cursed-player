import { motion } from "framer-motion";
import {
  SkipBack,
  SkipForward,
  Play,
  Pause,
  Volume2,
  Maximize2,
  Shuffle,
  Repeat,
  Repeat1,
  FolderOpen,
  ListMusic,
  Waves,
} from "lucide-react";
import { usePlayerStore } from "../store/playerStore";
import { useRadioStore } from "../store/radioStore";
import { useSettingsStore } from "../store/settingsStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import { formatDuration } from "../services/catalog";
import Cover from "./Cover";
import { serviceFromTrackId } from "../lib/services";
import FavoriteButton from "./FavoriteButton";
import SeekBar from "./SeekBar";
import IconButton from "./IconButton";

interface Props {
  onExpand: () => void;
  onQueue: () => void;
}

/** Полоски эквалайзера — визуальный признак «сейчас играет». */
export function Equalizer({ active }: { active: boolean }) {
  const bars = [0.45, 0.9, 0.65];
  return (
    <span className="flex items-end gap-[2px] h-3" aria-hidden>
      {bars.map((height, i) => (
        <motion.span
          key={i}
          className="w-[2px] rounded-full bg-accentText"
          animate={active ? { height: [4, 12 * height + 4, 5, 10] } : { height: 4 }}
          transition={
            active
              ? { duration: 1.1 + i * 0.25, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }
              : { duration: 0.2 }
          }
          style={{ height: 4 }}
        />
      ))}
    </span>
  );
}

/**
 * Нижняя панель плеера: транспорт, позиция, громкость музыки и переключатели.
 * Позиция и громкость управляют настоящим аудиоэлементом (см. AudioEngine).
 */
export default function MiniPlayer({ onExpand, onQueue }: Props) {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const progress = usePlayerStore((s) => s.progress);
  const position = usePlayerStore((s) => s.position);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const volume = usePlayerStore((s) => s.volume);
  const trackTitle = usePlayerStore((s) => s.trackTitle);
  const trackArtist = usePlayerStore((s) => s.trackArtist);
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setMusicVolume = useSettingsStore((s) => s.setPlayerVolume);
  const previous = usePlayerStore((s) => s.previous);
  const next = usePlayerStore((s) => s.next);
  const seekFraction = usePlayerStore((s) => s.seekFraction);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const openFiles = usePlayerStore((s) => s.openFiles);
  const waveEnabled = useRadioStore((s) => s.enabled);

  const empty = queue.length === 0;
  const currentTrack = queue[index];
  const currentCover = currentTrack?.cover ?? null;

  async function chooseFiles() {
    sounds.open();
    const added = await openFiles();
    if (added > 0) {
      sounds.save();
      toast({ title: `Добавлено треков: ${added}`, description: "Файлы не копируются — играем из исходной папки" });
    }
  }

  return (
    <div className="glass h-[84px] shrink-0 border-t border-line/[0.07] bg-surface/70 backdrop-blur-[16px] flex items-center gap-4 px-4">
      <div className="flex items-center gap-3 min-w-0 w-64 shrink-0">
        <button
          onClick={onExpand}
          disabled={empty}
          className="flex items-center gap-3 text-left min-w-0 rounded-xl p-1.5 -m-1.5 hover:bg-ink/[0.05] transition-colors disabled:hover:bg-transparent"
          title={empty ? "Плеер пуст" : "Развернуть плеер"}
        >
          <motion.div layoutId="player-cover" className="relative shrink-0">
            <Cover
              src={currentCover}
              size={48}
              rounded="rounded-lg"
              service={currentTrack ? serviceFromTrackId(currentTrack.id) : null}
            />
            <span className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/[0.08]" />
          </motion.div>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-[13px] font-medium truncate">{trackTitle || "Ничего не играет"}</span>
              <Equalizer active={isPlaying} />
              {/* Волна включена: маленький индикатор рядом с названием */}
              {waveEnabled && (
                <span
                  className="shrink-0 flex items-center gap-1 text-[10px] font-medium text-accentText"
                  title="Wave включена: очередь пополняется похожими треками"
                >
                  <Waves size={11} /> Wave
                </span>
              )}
            </span>
            <span className="block text-[12px] text-muted truncate">
              {trackArtist || (empty ? "Открой файлы, чтобы начать" : "Выбери трек")}
            </span>
          </span>
        </button>
        {empty && (
          <button
            onClick={() => void chooseFiles()}
            className="shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line/[0.12] text-[12px] text-ink/85 hover:bg-ink/[0.06] transition-colors"
          >
            <FolderOpen size={13} /> Открыть
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col items-center gap-1.5 max-w-2xl mx-auto min-w-0">
        <div className="flex items-center gap-1">
          <IconButton
            Icon={Shuffle}
            label="Перемешать"
            active={shuffle}
            className="neu"
            onClick={() => {
              toggleShuffle();
              sounds.open();
            }}
          />
          <IconButton Icon={SkipBack} label="Предыдущий" onClick={previous} className="neu" />
          <button
            onClick={togglePlay}
            aria-label={isPlaying ? "Пауза" : "Играть"}
            className="w-9 h-9 rounded-full bg-accent text-onAccent flex items-center justify-center hover:bg-accentHover transition-colors shadow-lift"
          >
            {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
          </button>
          <IconButton Icon={SkipForward} label="Следующий" onClick={next} className="neu" />
          <IconButton
            Icon={repeat === "one" ? Repeat1 : Repeat}
            label={repeat === "off" ? "Повтор выключен" : repeat === "all" ? "Повтор списка" : "Повтор трека"}
            active={repeat !== "off"}
            className="neu"
            onClick={() => {
              cycleRepeat();
              sounds.open();
            }}
          />
        </div>

        <div className="w-full flex items-center gap-2">
          <span className="text-[11px] text-faint tnum w-9 text-right shrink-0">
            {formatDuration(position * 1000)}
          </span>
          <SeekBar
            progress={progress}
            onSeek={seekFraction}
            disabled={durationMs <= 0}
            className="flex-1 min-w-0"
          />
          <span className="text-[11px] text-faint tnum w-9 shrink-0">{formatDuration(durationMs)}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 w-44 shrink-0">
        {currentTrack && <FavoriteButton track={currentTrack} size={15} />}
        <IconButton
          Icon={ListMusic}
          label={`Очередь: ${queue.length}`}
          onClick={onQueue}
          className="shrink-0"
        />
        <Volume2 size={15} className="text-faint shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(event) => {
            const value = Number(event.target.value);
            setVolume(value);
            setMusicVolume(value);
          }}
          onPointerUp={() => sounds.save()}
          aria-label="Громкость музыки"
          className="w-full h-1 accent-accent cursor-pointer"
        />
      </div>

      <IconButton Icon={Maximize2} label="Развернуть" onClick={onExpand} className="shrink-0" />
    </div>
  );
}
