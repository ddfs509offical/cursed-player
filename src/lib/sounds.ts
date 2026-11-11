import { useSettingsStore } from "../store/settingsStore";

/**
 * Короткие тихие звуки интерфейса. Синтезируются через WebAudio, поэтому
 * в проект не нужно тащить аудиофайлы: набор задаётся кодом, а пользователь
 * выбирает характер звуков в настройках.
 */

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }
  if (context.state === "suspended") void context.resume();
  return context;
}

/** Наборы звуков: характер, высота, длина и громкость. */
const PACKS = {
  soft: { wave: "sine" as OscillatorType, pitch: 1, length: 1, peak: 1 },
  classic: { wave: "triangle" as OscillatorType, pitch: 1.5, length: 0.85, peak: 0.9 },
  minimal: { wave: "square" as OscillatorType, pitch: 2.1, length: 0.5, peak: 0.5 },
};

export type SoundPack = keyof typeof PACKS;
export const SOUND_PACKS: { id: SoundPack; label: string; hint: string }[] = [
  { id: "soft", label: "Мягкие", hint: "Тихие синусоидальные сигналы — по умолчанию" },
  { id: "classic", label: "Классические", hint: "Чуть выше и звонче, треугольная волна" },
  { id: "minimal", label: "Минимальные", hint: "Короткие щелчки, почти незаметные" },
];

function tone(frequency: number, offset: number, duration: number, peak: number, type: OscillatorType) {
  const ctx = audio();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;

  const start = ctx.currentTime + offset;
  // Мягкая атака и затухание: без щелчков на старте и в конце
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

type Note = [frequency: number, offset: number, duration: number];

function play(notes: Note[], type?: OscillatorType) {
  const { soundEnabled, soundVolume, soundPack } = useSettingsStore.getState();
  if (!soundEnabled || soundVolume <= 0) return;

  const pack = PACKS[soundPack] ?? PACKS.soft;
  const peak = 0.05 * soundVolume * pack.peak;
  notes.forEach(([frequency, offset, duration]) =>
    tone(frequency * pack.pitch, offset, duration * pack.length, peak, type ?? pack.wave)
  );
}

export const sounds = {
  /** Что-то включили. */
  on: () => play([[659.25, 0, 0.1], [880, 0.06, 0.14]]),
  /** Что-то выключили. */
  off: () => play([[880, 0, 0.09], [587.33, 0.05, 0.13]]),
  /** Сохранение. */
  save: () => play([[783.99, 0, 0.12], [1046.5, 0.055, 0.16]]),
  /** Открытие меню или модалки. */
  open: () => play([[1174.66, 0, 0.05]]),
  /** Закрытие. */
  close: () => play([[587.33, 0, 0.06]]),
  /** Откат действия. */
  undo: () => play([[587.33, 0, 0.09], [880, 0.055, 0.13]]),
  /** Ошибка. */
  error: () => play([[311.13, 0, 0.14], [233.08, 0.08, 0.18]]),
};
