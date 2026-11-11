/**
 * Пропуск тишины в конце трека: где заканчивается полезный звук.
 *
 * Почему анализ только для локальных файлов. Тишину хвоста нельзя честно
 * измерить у потока: `AnalyserNode` для аудио без CORS-заголовков отдаёт нули,
 * а нули выглядят как абсолютная тишина — плеер начал бы проматывать треки
 * целиком. Поэтому единственный надёжный путь — декодировать файл, который уже
 * лежит на диске (офлайн-копия или файл библиотеки), через
 * `AudioContext.decodeAudioData` и пройти по нему с конца. У потоковых треков
 * локального файла нет, разбора тоже нет — и ничего не применяется.
 *
 * Здесь нет ни React, ни обращения к состоянию плеера: измерение и решение
 * живут отдельно, а плеер только спрашивает готовый результат.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

/** Длина окна анализа. 50 мс — компромисс: короче ловит щелчки, длиннее мажет границу. */
export const SILENCE_WINDOW_MS = 50;

/**
 * Порог тишины в dBFS: окно считается тихим, если его RMS ниже -50 dBFS.
 * Это примерно -50 дБ от полной шкалы — тише шума паузы в обычной записи
 * (у неё хвост обычно -60…-80 dBFS), но выше цифрового нуля и очень тихих
 * «дыханий» зала, которые пользователь всё же ждёт услышать. Занизить порог
 * (например, до -70 dBFS) — значит не увидеть тишину там, где она есть;
 * завысить (до -40 dBFS) — значит отрезать затухание живой записи.
 */
export const SILENCE_THRESHOLD_DBFS = -50;

/** Короче этого трек не считаем достойным анализа: у миниатюр хвост неотличим от самого трека. */
export const MIN_TRACK_MS = 60_000;

/** Меньше двух секунд тишины пропускать не за чем: выигрыш незаметен, а риск ошибки есть. */
export const MIN_TAIL_SILENCE_MS = 2_000;

/**
 * Если «тишина» заняла больше 40% трека, это почти наверняка не хвост, а
 * тихая запись (эмбиент, речь с паузами, битый файл). Пропускать её целиком
 * нельзя — разбор считается неудачным.
 */
export const MAX_TAIL_SILENCE_RATIO = 0.4;

/**
 * Потолок размера файла для декодирования. Декодер разворачивает сжатый файл в
 * несжатый PCM, и очень большой файл съел бы память целиком; такие треки просто
 * остаются без разбора.
 */
const MAX_ANALYZE_BYTES = 80 * 1024 * 1024;

/** Результат разбора: где начинается хвостовая тишина и какова длина трека. */
export interface TailSilence {
  /** Начало хвостовой тишины, мс от начала трека. */
  silenceStartMs: number;
  /** Полная длительность разобранного аудио, мс. */
  durationMs: number;
}

/** Настройки разбора — нужны тестам, в приложении берутся значения по умолчанию. */
export interface TailSilenceOptions {
  windowMs?: number;
  thresholdDb?: number;
  minDurationMs?: number;
  minSilenceMs?: number;
  maxSilenceRatio?: number;
}

/**
 * RMS по окнам, сразу в dBFS. На вход — каналы декодированного аудио: мощность
 * усредняется по всем каналам, иначе тихий канал в стерео выглядел бы тишиной
 * при звуке во втором. Полная тишина даёт `-Infinity` — сравнение с порогом от
 * этого не ломается.
 */
export function rmsWindowsDb(
  channels: readonly Float32Array[],
  sampleRate: number,
  windowMs: number = SILENCE_WINDOW_MS
): number[] {
  const frames = channels[0]?.length ?? 0;
  if (!frames || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];
  if (!Number.isFinite(windowMs) || windowMs <= 0) return [];
  const perWindow = Math.max(1, Math.round((sampleRate * windowMs) / 1000));

  const windows: number[] = [];
  for (let start = 0; start < frames; start += perWindow) {
    const end = Math.min(frames, start + perWindow);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i += 1) {
      for (const channel of channels) {
        const value = channel[i];
        if (!Number.isFinite(value)) continue;
        sum += value * value;
        count += 1;
      }
    }
    const rms = count > 0 ? Math.sqrt(sum / count) : 0;
    windows.push(rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY);
  }
  return windows;
}

/**
 * Где начинается хвостовая тишина — индекс первого тихого окна с конца.
 * `null` означает «применять нечего»: разбор неудачен или тишины нет.
 *
 * Защита от ложных срабатываний обязательна: без неё тихая запись или битый
 * файл заставили бы плеер проматывать трек целиком. Поэтому отказываемся, если
 * трек короче минуты, хвост короче двух секунд, хвост занимает больше 40%
 * длительности или тишина — это весь трек.
 */
export function findTailSilenceStart(
  rmsWindows: readonly number[],
  options: TailSilenceOptions = {}
): number | null {
  const windowMs = options.windowMs ?? SILENCE_WINDOW_MS;
  const thresholdDb = options.thresholdDb ?? SILENCE_THRESHOLD_DBFS;
  const minDurationMs = options.minDurationMs ?? MIN_TRACK_MS;
  const minSilenceMs = options.minSilenceMs ?? MIN_TAIL_SILENCE_MS;
  const maxSilenceRatio = options.maxSilenceRatio ?? MAX_TAIL_SILENCE_RATIO;

  const total = rmsWindows.length;
  if (total === 0 || !Number.isFinite(windowMs) || windowMs <= 0) return null;

  const durationMs = total * windowMs;
  if (durationMs < minDurationMs) return null;

  let tail = 0;
  for (let i = total - 1; i >= 0; i -= 1) {
    const db = rmsWindows[i];
    // Строгое сравнение: NaN (нечитаемая мощность) тишиной не считается
    if (!(db < thresholdDb)) break;
    tail += 1;
  }

  if (tail === 0) return null;
  if (tail >= total) return null; // в файле одна тишина

  const silenceMs = tail * windowMs;
  if (silenceMs < minSilenceMs) return null;
  if (silenceMs > durationMs * maxSilenceRatio) return null;

  return total - tail;
}

/* ─────────────── Кеш по треку ─────────────── */

const CACHE_PREFIX = "music_hub_tail_silence_";
/** Версия записи кеша: старые данные после смены правил не используем. */
const CACHE_VERSION = 1;

interface CacheEnvelope {
  v: number;
  /** Разбор удался. `false` — отрицательный результат: повторно не анализируем. */
  ok: boolean;
  silenceStartMs?: number;
  durationMs?: number;
}

/**
 * Разборы текущего сеанса. Тик позиции случается несколько раз в секунду, и
 * читать `localStorage` на каждом нельзя — поэтому память первая, хранилище
 * лишь носитель между запусками. `null` в значении — тоже знание (см. `known`).
 */
const memory = new Map<string, TailSilence | null>();

function cacheKey(trackId: string): string {
  return `${CACHE_PREFIX}${trackId}`;
}

/**
 * Что уже известно о треке. `known: false` — разбора не было; `known: true,
 * value: null` — разбор был и он отрицательный. Различать это обязательно,
 * иначе неудачный анализ повторялся бы при каждом включении.
 */
export function cachedTailSilence(trackId: string): { known: boolean; value: TailSilence | null } {
  if (!trackId) return { known: false, value: null };
  if (memory.has(trackId)) return { known: true, value: memory.get(trackId) ?? null };

  try {
    const raw = localStorage.getItem(cacheKey(trackId));
    if (!raw) return { known: false, value: null };
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (!parsed || parsed.v !== CACHE_VERSION) return { known: false, value: null };
    const value: TailSilence | null =
      parsed.ok && typeof parsed.silenceStartMs === "number" && typeof parsed.durationMs === "number"
        ? { silenceStartMs: parsed.silenceStartMs, durationMs: parsed.durationMs }
        : null;
    memory.set(trackId, value);
    return { known: true, value };
  } catch {
    return { known: false, value: null };
  }
}

function rememberTailSilence(trackId: string, value: TailSilence | null): void {
  memory.set(trackId, value);
  const envelope: CacheEnvelope =
    value === null
      ? { v: CACHE_VERSION, ok: false }
      : { v: CACHE_VERSION, ok: true, silenceStartMs: value.silenceStartMs, durationMs: value.durationMs };
  try {
    localStorage.setItem(cacheKey(trackId), JSON.stringify(envelope));
  } catch {
    // Переполнение хранилища не должно ломать воспроизведение
  }
}

/* ─────────────── Сам анализ ─────────────── */

/** Путь ведёт на файл, а не на поток: только такие треки и можно декодировать. */
export function isLocalFilePath(path: string): boolean {
  const value = (path ?? "").trim();
  if (!value) return false;
  return !/^(https?|blob|data):/i.test(value);
}

/** Локальный путь в ссылку, которую умеет читать WebView (тот же механизм, что у плеера). */
export function playableFileUrl(path: string): string {
  const value = (path ?? "").trim();
  if (!value) return "";
  if (/^(https?|asset|blob|data):/i.test(value)) return value;
  try {
    return convertFileSrc(value);
  } catch {
    return value;
  }
}

/** Контекст только для декодирования: звук через него не идёт, поэтому и «немой» тоже годится. */
function createDecodeContext(): AudioContext | null {
  try {
    if (typeof AudioContext === "undefined") return null;
    return new AudioContext();
  } catch {
    return null;
  }
}

/**
 * Разбирает локальный файл и возвращает начало хвостовой тишины.
 *
 * `null` — любой неуспех: файл не читается, не декодируется, короче минуты,
 * тишины нет или она подозрительно большая. Это ожидаемый ответ, а не ошибка:
 * вызывающий просто ничего не пропускает.
 *
 * Кеша здесь нет умышленно: функция делает ровно одну вещь — измеряет. За
 * однократность разбора на трек отвечает `ensureTailSilence`.
 */
export async function analyzeTailSilence(filePathOrUrl: string): Promise<TailSilence | null> {
  const url = playableFileUrl(filePathOrUrl);
  if (!url) return null;

  const context = createDecodeContext();
  if (!context) return null;

  let buffer: AudioBuffer | null = null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    if (!data.byteLength || data.byteLength > MAX_ANALYZE_BYTES) return null;
    buffer = await context.decodeAudioData(data);
  } catch {
    // Формат не поддержан, файл обрезан, ссылка не открылась — разбора нет
    return null;
  } finally {
    // Контекст нужен был один раз: держать открытым незачем
    void context.close().catch(() => {});
  }

  if (!buffer) return null;

  const channels: Float32Array[] = [];
  for (let i = 0; i < buffer.numberOfChannels; i += 1) channels.push(buffer.getChannelData(i));

  const windows = rmsWindowsDb(channels, buffer.sampleRate, SILENCE_WINDOW_MS);
  const start = findTailSilenceStart(windows, { windowMs: SILENCE_WINDOW_MS });
  if (start === null) return null;

  return { silenceStartMs: start * SILENCE_WINDOW_MS, durationMs: windows.length * SILENCE_WINDOW_MS };
}

/**
 * Идущие разборы: `trackId` → промис. Плеер может спросить один и тот же трек
 * дважды (перезапуск, возврат в очередь) — измеряем один раз, оба ждут ответ.
 */
const pending = new Map<string, Promise<TailSilence | null>>();

/**
 * Разбор трека по кешу: уже известное отдаём сразу, неизвестное измеряем один
 * раз и запоминаем — и успех, и неуспех. Вызывается в фоне, не блокируя звук.
 */
export function ensureTailSilence(trackId: string, filePathOrUrl: string): Promise<TailSilence | null> {
  if (!trackId) return Promise.resolve(null);

  const cached = cachedTailSilence(trackId);
  if (cached.known) return Promise.resolve(cached.value);

  const running = pending.get(trackId);
  if (running) return running;

  const request = analyzeTailSilence(filePathOrUrl)
    .catch(() => null)
    .then((value) => {
      rememberTailSilence(trackId, value);
      return value;
    })
    .finally(() => {
      pending.delete(trackId);
    });

  pending.set(trackId, request);
  return request;
}
