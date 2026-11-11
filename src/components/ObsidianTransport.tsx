/**
 * Транспорт «Обсидиан»: полоса под рабочей поверхностью.
 *
 * Четыре зоны, как у студийного пульта: слева — что играет (этикетка),
 * в центре — управление, справа — громкость. Полоска прогресса идёт по
 * верхнему краю полосы, а не занимает отдельную строку: содержимое остаётся
 * главным, а положение видно всегда.
 *
 * Ведёт себя как обычный мини-плеер приложения: всё состояние берётся из
 * playerStore, настройки — из settingsStore. Никаких вторых источников правды.
 */
import { FolderOpen, ListMusic, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, Waves } from "lucide-react";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { useRadioStore } from "../store/radioStore";
import { sounds } from "../lib/sounds";
import { toast } from "../store/toastStore";
import { formatDuration } from "../services/catalog";
import { serviceFromTrackId } from "../lib/services";
import Cover from "./Cover";
import FavoriteButton from "./FavoriteButton";
import SeekBar from "./SeekBar";

interface Props {
  onExpand: () => void;
  onQueue: () => void;
}

export default function ObsidianTransport({ onExpand, onQueue }: Props) {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const progress = usePlayerStore((s) => s.progress);
  const position = usePlayerStore((s) => s.position);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const trackTitle = usePlayerStore((s) => s.trackTitle);
  const trackArtist = usePlayerStore((s) => s.trackArtist);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const volume = usePlayerStore((s) => s.volume);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const seekFraction = usePlayerStore((s) => s.seekFraction);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const openFiles = usePlayerStore((s) => s.openFiles);
  const setMusicVolume = useSettingsStore((s) => s.setSoundVolume);
  const waveEnabled = useRadioStore((s) => s.enabled);

  /**
   * Длительность: у потокового трека состояние не всегда её знает, но
   * аудиоэлемент знает — берём запасным источником, иначе полоска стоит.
   */
  const [audioDurationMs, setAudioDurationMs] = useState(0);
  useEffect(() => {
    const audio = document.querySelector("audio");
    if (!audio) return undefined;
    const read = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setAudioDurationMs(Math.round(audio.duration * 1000));
      }
    };
    read();
    audio.addEventListener("loadedmetadata", read);
    audio.addEventListener("durationchange", read);
    return () => {
      audio.removeEventListener("loadedmetadata", read);
      audio.removeEventListener("durationchange", read);
    };
  }, [trackTitle]);

  const totalMs = durationMs > 0 ? durationMs : audioDurationMs;

  /**
   * Живая позиция для подписи времени.
   *
   * `position` в состоянии обновляется событиями `timeupdate`, а они идут
   * редко — подпись слева успевала показывать прочерк, пока полоска уже
   * двигалась. Полоска сообщает положение на каждом кадре, здесь его и печатаем.
   */
  const [liveSeconds, setLiveSeconds] = useState(0);
  useEffect(() => setLiveSeconds(position), [position]);

  const track = index >= 0 ? queue[index] : null;
  const empty = !track && !trackTitle;

  async function chooseFiles() {
    const added = await openFiles();
    if (added > 0) {
      sounds.save();
      toast({
        title: `Добавлено треков: ${added}`,
        description: "Файлы не копируются — играем из исходной папки",
      });
    }
  }

  return (
    <div
      className="obs-transport"
      style={{ ["--p" as string]: String(Math.max(0, Math.min(1, progress))) }}
    >
      {/* Слева: этикетка трека. Нажатие разворачивает плеер. */}
      <div className="obs-transport__label">
        <button
          onClick={onExpand}
          disabled={empty}
          className="obs-transport__track"
          title={empty ? "Плеер пуст" : "Развернуть плеер"}
        >
          <motion.div layoutId="player-cover" className="obs-transport__thumb">
            <Cover
              src={track?.cover ?? null}
              size={42}
              rounded="rounded-[9px]"
              service={track ? serviceFromTrackId(track.id) : null}
            />
          </motion.div>
          <span className="obs-transport__meta">
            <span className="obs-transport__title">
              {trackTitle || "Ничего не играет"}
              {!empty && isPlaying && (
                <span className="obs-transport__eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {waveEnabled && !empty && (
                <span className="obs-transport__wave" title="Волна включена: очередь пополняется похожими треками">
                  <Waves size={11} /> Волна
                </span>
              )}
            </span>
            <span className="obs-transport__artist">
              {trackArtist || (empty ? "Открой файлы, чтобы начать" : "Выбери трек")}
            </span>
          </span>
        </button>

        {empty && (
          <button onClick={() => void chooseFiles()} className="obs-btn obs-btn--sm">
            <FolderOpen size={13} /> Открыть
          </button>
        )}
      </div>

      {/* Центр: управление. Главная кнопка — единственный белый круг. */}
      <div className="obs-transport__center">
        <button
          className="obs-icon"
          data-on={shuffle}
          aria-label="Перемешать"
          title="Перемешать"
          onClick={() => {
            toggleShuffle();
            sounds.open();
          }}
        >
          <Shuffle size={15} />
        </button>
        <button className="obs-icon" aria-label="Предыдущий" title="Предыдущий" onClick={previous}>
          <SkipBack size={16} fill="currentColor" />
        </button>
        <button
          onClick={togglePlay}
          aria-label={isPlaying ? "Пауза" : "Играть"}
          className="obs-play"
        >
          {isPlaying ? (
            <Pause size={16} fill="currentColor" />
          ) : (
            <Play size={16} fill="currentColor" style={{ marginLeft: 2 }} />
          )}
        </button>
        <button className="obs-icon" aria-label="Следующий" title="Следующий" onClick={next}>
          <SkipForward size={16} fill="currentColor" />
        </button>
        <button
          className="obs-icon"
          data-on={repeat !== "off"}
          aria-label={repeat === "off" ? "Повтор выключен" : repeat === "all" ? "Повтор списка" : "Повтор трека"}
          title={repeat === "off" ? "Повтор выключен" : repeat === "all" ? "Повтор списка" : "Повтор трека"}
          onClick={() => {
            cycleRepeat();
            sounds.open();
          }}
        >
          {repeat === "one" ? <Repeat1 size={15} /> : <Repeat size={15} />}
        </button>
      </div>

      {/* Справа: лайк, очередь и громкость. */}
      <div className="obs-transport__right">
        {track && <FavoriteButton track={track} size={15} />}
        <button
          className="obs-icon"
          onClick={onQueue}
          aria-label={`Очередь: ${queue.length}`}
          title={`Очередь: ${queue.length}`}
        >
          <ListMusic size={15} />
        </button>
        <Volume2 size={14} className="obs-transport__volicon" />
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
          className="obs-volume"
        />
      </div>

      {/* Полоса перемотки: под этикеткой и управлением, тонкая. */}
      <div className="obs-transport__seek">
        <span className="obs-transport__time obs-num">{formatDuration(liveSeconds * 1000)}</span>
        {/* Полоска досчитывает время в кадре: данные приходят редко. */}
        <SeekBar
          progress={progress}
          onSeek={seekFraction}
          disabled={totalMs <= 0}
          playing={isPlaying}
          durationMs={totalMs}
          onPosition={setLiveSeconds}
          className="obs-transport__seekbar"
        />
        <span className="obs-transport__time obs-num">
          {totalMs > 0 ? formatDuration(totalMs) : "—:—"}
        </span>
      </div>
    </div>
  );
}
