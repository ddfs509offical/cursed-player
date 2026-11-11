/**
 * Сохранение плейлиста офлайн целиком.
 *
 * Плейлист сам по себе лежит в localStorage и доступен без сети; офлайн ему
 * не хватает только файлов треков. Поэтому задача — пройти список, пропустить
 * локальные и уже сохранённые треки и докачать остальные тем же способом, что
 * и одиночный трек: файл автора (`download`), а если автор запретил — копия
 * потока (`cache`).
 *
 * Скачиваем последовательно: так меньше риск, что SoundCloud ответит отказом
 * на пачку запросов, а прогресс всё равно виден по одному треку. Уже
 * сохранённые треки не перекачиваются, поэтому повторный запуск после обрыва
 * продолжает с места остановки.
 */

import { getServiceToken, refreshServiceStream } from "./catalog";
import {
  offlineReason,
  saveTrackOffline,
  soundcloudDownloadInfo,
  type SavedFile,
  type SoundcloudDownloadInfo,
} from "./downloads";
import { errorText, logError } from "../store/errorStore";
import { useOfflineStore } from "../store/offlineStore";
import type { PlaylistTrack } from "../store/playlistsStore";
import type { Track } from "../store/playerStore";

/** Что показать в интерфейсе во время сохранения. */
export interface PlaylistOfflineProgress {
  /** Сколько треков уже обработано (успех + ошибка). */
  done: number;
  /** Сколько треков нужно было скачать. */
  total: number;
  /** Сколько из обработанных не удалось. */
  failed: number;
  /** Название трека, который сохраняется сейчас. */
  current: string | null;
}

/** Итог сохранения плейлиста. */
export interface PlaylistOfflineResult {
  /** Сколько треков скачано сейчас. */
  saved: number;
  /** Локальные и уже сохранённые — их качать не пришлось. */
  skipped: number;
  /** Сколько треков не удалось сохранить. */
  failed: number;
  /** Первая причина ошибки — для тоста; полный текст уходит в журнал. */
  firstError: string | null;
}

/** Карточка плейлиста как трек для `refreshServiceStream`. */
function asTrack(card: PlaylistTrack): Track {
  return {
    id: card.id,
    path: card.path || "",
    title: card.title,
    artist: card.artist,
    album: card.album,
    durationMs: card.durationMs,
    source: card.source,
    cover: card.cover,
  };
}

/** Идентификатор SoundCloud из `soundcloud:123` или null для чужих сервисов. */
function soundcloudId(trackId: string): string | null {
  if (!trackId.startsWith("soundcloud:")) return null;
  const id = trackId.slice("soundcloud:".length);
  return /^\d+$/.test(id) ? id : null;
}

/**
 * Докачать недостающие треки плейлиста. Ошибка одного трека не останавливает
 * остальные: в результате честно будет и `failed`, и причина.
 */
export async function savePlaylistOffline(
  tracks: readonly PlaylistTrack[],
  onProgress?: (progress: PlaylistOfflineProgress) => void
): Promise<PlaylistOfflineResult> {
  await useOfflineStore.getState().ensureLoaded();

  let skipped = 0;
  const pending: PlaylistTrack[] = [];

  for (const track of tracks) {
    if (track.source !== "service") {
      skipped += 1;
      continue;
    }
    if (useOfflineStore.getState().record(track.id)) {
      skipped += 1;
      continue;
    }
    pending.push(track);
  }

  const result: PlaylistOfflineResult = {
    saved: 0,
    skipped,
    failed: 0,
    firstError: null,
  };

  let done = 0;
  const report = (current: string | null) =>
    onProgress?.({ done, total: pending.length, failed: result.failed, current });

  report(null);

  for (const card of pending) {
    try {
      const trackId = soundcloudId(card.id);
      if (!trackId) {
        throw new Error("Офлайн пока поддерживается только для треков SoundCloud");
      }

      const meta = {
        title: card.title,
        artist: card.artist,
        cover: card.cover,
      };

      // Разрешение автора спрашиваем мягко: молчание сервиса — не повод
      // отказываться от сохранения, просто положим копию потока.
      let info: SoundcloudDownloadInfo | null = null;
      try {
        const clientId = await getServiceToken("soundcloud");
        if (clientId) info = await soundcloudDownloadInfo(clientId, trackId);
      } catch {
        info = null;
      }

      let file: SavedFile;
      if (info?.downloadable && info.url) {
        file = await saveTrackOffline(info.url, card.id, "download", meta);
      } else {
        const fresh = await refreshServiceStream(asTrack(card));
        if (!fresh.path) {
          throw new Error(
            "Сервис не отдал ссылку на поток — проверь подключение SoundCloud в настройках"
          );
        }
        file = await saveTrackOffline(fresh.path, card.id, "cache", meta);
      }

      useOfflineStore.getState().upsert(file);
      result.saved += 1;
    } catch (e) {
      result.failed += 1;
      if (!result.firstError) result.firstError = offlineReason(e);
      logError(
        "Не удалось сохранить трек плейлиста офлайн",
        `${card.title} — ${card.artist ?? "неизвестный исполнитель"}`,
        "офлайн",
        errorText(e)
      );
    }

    done += 1;
    report(card.title);
  }

  report(null);
  return result;
}
