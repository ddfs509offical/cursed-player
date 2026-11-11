/**
 * Запасной путь сохранения трека — внешний сервис soundloadmate.
 *
 * Основной способ сохранить трек офлайн — нативный (`saveTrackOffline`): он
 * тянет поток SoundCloud напрямую. Этот модуль — заплатка на случай, когда
 * нативный путь не справился. Пользователь включает её сам в настройках
 * (по умолчанию выключена) и запускает вручную из тоста об ошибке: молча
 * ходить на чужой сервис приложение не должно.
 *
 * Модуль намеренно изолирован: вся зависимость от чужого сервиса живёт здесь
 * и в `src-tauri/src/external_download.rs`. Отключить затею = удалить эти два
 * файла и упоминания в `Settings.tsx` и `Search.tsx`.
 */

import { invoke } from "@tauri-apps/api/core";
import type { OfflineMeta, SavedFile } from "./downloads";
import { isTauri } from "./profiles";

/**
 * Сохраняет трек офлайн через внешний сервис.
 *
 * `trackUrl` — обычная ссылка на страницу трека в SoundCloud
 * (`https://soundcloud.com/автор/трек`). Именно ссылка, а не числовой id:
 * сервис понимает голые цифры как поисковую строку и вернул бы чужие треки.
 *
 * Файл приходит как офлайн-копия (`cache`): сервис не сообщает, разрешил ли
 * автор скачивание, поэтому называть её «скачанной» было бы обманом. Rust
 * проверяет, что это правда аудио, и лишь потом кладёт файл в реестр.
 */
export async function externalSaveTrack(
  trackUrl: string,
  id: string,
  meta: OfflineMeta = {}
): Promise<SavedFile> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  return invoke<SavedFile>("external_save_track", {
    trackUrl,
    id,
    title: meta.title ?? "",
    artist: meta.artist ?? null,
    cover: meta.cover ?? null,
  });
}
