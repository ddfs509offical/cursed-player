/**
 * Автокеш прослушанного: когда играет сервисный трек, у которого нет локальной
 * копии, тихо сохраняем поток в кеш (режим «cache»). Это и есть обещание
 * «зайти без интернета и послушать трек»: то, что человек уже слушал, остаётся
 * на диске само.
 *
 * Автокеш уступчив воспроизведению, потому что сохранение — фоновая задача:
 * 1. по умолчанию он выключен (см. `autoCacheEnabled` в настройках);
 * 2. сохранение стартует не раньше, чем трек играет 20 секунд: получение
 *    потока для только что включённого трека ни с чем не делит соединение;
 * 3. пока плеер грузит или буферизует поток, скачивание не начинается — оно
 *    подождёт и попробует позже;
 * 4. одновременно работает ровно одно сохранение, очередь — по одному треку;
 * 5. качается только текущий трек: если его перелистнули, качать «вчерашний»
 *    никто не просил.
 *
 * Тост не показываем — сохранение фоновое; ошибки уходят в журнал.
 */

import { saveTrackOffline } from "./downloads";
import { ensureOfflineLoaded, useOfflineStore } from "../store/offlineStore";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { playerAudio } from "../player/audio";
import { errorText, logError } from "../store/errorStore";
import { shouldAutoCache } from "../lib/offline";
import type { Track } from "../store/playerStore";

/** Сколько трек должен отыграть, прежде чем его сохранение никому не помешает. */
export const AUTO_CACHE_DELAY_MS = 20_000;
/** Пауза перед повторной попыткой, если плеер в этот момент буферизует. */
const AUTO_CACHE_RETRY_MS = 10_000;
/** Сколько раз откладывать сохранение из-за буферизации, прежде чем отказаться. */
const AUTO_CACHE_MAX_RETRIES = 6;

/** Треки, которые уже сохраняются, ждут своей очереди или пробовали сохраниться. */
const handled = new Set<string>();
/** Таймеры ожидания: id трека → отложенный запуск. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Очередь сохранений: одновременно работает ровно одно. */
let chain: Promise<void> = Promise.resolve();

/** Стоит ли сейчас вообще что-то качать: не мешаем получению потока. */
function playerIsBusy(): boolean {
  if (usePlayerStore.getState().isLoading) return true;
  const audio = playerAudio;
  // Не играет или ещё не набрало буфер — не время занимать соединение
  if (!audio || audio.paused) return true;
  return audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
}

/** Играет ли сейчас именно этот трек: качаем только текущий. */
function isCurrent(trackId: string): boolean {
  const state = usePlayerStore.getState();
  const current = state.index >= 0 ? state.queue[state.index] : undefined;
  return current?.id === trackId;
}

/**
 * Тихо кладёт играющий сервисный трек в кеш. Вызывается на событие «play»:
 * сначала трек должен отыграть `AUTO_CACHE_DELAY_MS`, и только потом фоновое
 * сохранение начинается — важнее всего, что музыка уже звучит без помех.
 */
export function maybeAutoCache(track: Track | undefined): void {
  if (!track || track.source !== "service") return;
  // Скачивать можно только ссылку на поток, а не пустой путь из очереди
  if (!/^https?:\/\//i.test(track.path)) return;
  if (!useSettingsStore.getState().autoCacheEnabled) return;
  if (handled.has(track.id) || timers.has(track.id)) return;

  schedule(track, AUTO_CACHE_DELAY_MS, 0);
}

/** Откладывает попытку сохранения: одна на трек, повторный вызов её не дублирует. */
function schedule(track: Track, delay: number, attempt: number): void {
  const existing = timers.get(track.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(track.id);
    consider(track, attempt);
  }, delay);
  timers.set(track.id, timer);
}

/**
 * Решает, можно ли начинать сохранение прямо сейчас. Если плеер ещё тянет
 * поток — попытка переносится, а не отменяется: трек уже играет, спешить некуда.
 */
function consider(track: Track, attempt: number): void {
  if (!useSettingsStore.getState().autoCacheEnabled) return;
  // Трек перелистнули: сохранять нечего, качаем только текущий
  if (!isCurrent(track.id)) return;
  if (playerIsBusy()) {
    if (attempt < AUTO_CACHE_MAX_RETRIES) schedule(track, AUTO_CACHE_RETRY_MS, attempt + 1);
    return;
  }

  handled.add(track.id);
  chain = chain.then(() => run(track)).catch(() => undefined);
}

/** Фоновая попытка сохранения: молча, с проверкой копии и лимита. */
async function run(track: Track): Promise<void> {
  // Список сохранённого мог ещё не прочитаться — иначе сохраним дважды
  await ensureOfflineLoaded();

  const store = useOfflineStore.getState();
  if (store.record(track.id)) return;

  const { autoCacheEnabled, cacheLimitMb } = useSettingsStore.getState();
  const allowed = shouldAutoCache({
    enabled: autoCacheEnabled,
    hasCopy: false,
    totalBytes: store.totalBytes,
    limitMb: cacheLimitMb,
  });
  if (!allowed) return;

  try {
    const file = await saveTrackOffline(track.path, track.id, "cache", {
      title: track.title,
      artist: track.artist,
      cover: track.cover ?? null,
    });
    // Список обновляем сразу: следующий запуск без сети найдёт эту копию
    useOfflineStore.getState().upsert(file);
  } catch (e) {
    // Фоновое сохранение не должно тревожить пользователя тостом
    logError(
      "Не удалось сохранить прослушанный трек в кеш",
      `${track.title} — ${track.artist ?? "неизвестный исполнитель"}`,
      "офлайн",
      errorText(e)
    );
  }
}
