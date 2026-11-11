/**
 * Офлайн-треки: файлы, сохранённые, чтобы музыка играла без интернета.
 *
 * Два честных режима плюс флаг «держу офлайн»:
 * * «download» — автор трека разрешил скачивание (`downloadable` в SoundCloud);
 * * «cache» — автор не разрешил, поэтому лежит временная офлайн-копия потока;
 * * «keep» — копию просили держать офлайн, уборка её не удалит.
 *
 * Режим и способ (`method`) — разные вещи, и интерфейс показывает оба: режим
 * говорит, что это за копия, а способ — откуда файл взялся («download» — файл
 * автора, «stream» — наш поток, в том числе склейка HLS с пересборкой,
 * «external» — сторонний сервис, «import» — файл принесён вручную).
 *
 * Режим, способ и исходный идентификатор трека («soundcloud:123») приходят с
 * бэкенда из реестра `index.json`, поэтому интерфейс всегда может честно
 * подписать, что именно лежит на диске, а плеер — найти копию по id из очереди.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  OfflineBaseKind,
  OfflineEntry,
  OfflineKind,
} from "../lib/offline";
import type { Track } from "../store/playerStore";
import { isTauri } from "./profiles";

export type { OfflineBaseKind, OfflineKind };

/** Способ, которым файл попал в офлайн-реестр. */
export type OfflineMethod = "download" | "stream" | "external" | "import";

/** Сохранённый офлайн-файл: реестр плюс теги самого файла. */
export interface SavedFile extends OfflineEntry {
  kind: OfflineKind;
  baseKind: OfflineBaseKind;
  /**
   * Как файл получен. Приходит из реестра вместе с режимом: у записей прошлой
   * версии поля не было, и бэкенд выводит способ из режима, поэтому здесь
   * всегда одно из значений `OfflineMethod`.
   */
  method: OfflineMethod;
  fileName: string;
  /** Дата сохранения в миллисекундах Unix и та же дата в RFC3339. */
  savedAtMs: number;
  savedAt: string;
}

/** Ответ SoundCloud: разрешено ли скачивание и ссылка на файл. */
export interface SoundcloudDownloadInfo {
  downloadable: boolean;
  url: string | null;
}

/** Сколько занимают офлайн-файлы и сколько свободно на диске. */
export interface OfflineStats {
  totalBytes: number;
  freeBytes: number;
}

/** Что известно о треке в момент сохранения — из сервиса, а не из файла. */
export interface OfflineMeta {
  title?: string;
  artist?: string | null;
  cover?: string | null;
}

/**
 * Сохраняет трек офлайн. `kind` = «download», когда автор разрешил скачивание,
 * и «cache», когда это офлайн-копия потока. Название, исполнитель и обложка
 * из сервиса кладутся в реестр: у скачанного потока тегов обычно нет.
 *
 * `url` может вести и на обычный файл (mp3/m4a), и на HLS-плейлист
 * (`.m3u8`): часть треков SoundCloud отдаётся только так. Бэкенд сам
 * скачивает сегменты и склеивает их в один играемый файл `.m4a`, поэтому
 * интерфейсу ничего разбирать не нужно — расширение всё равно выбирает Rust.
 *
 * Способ бэкенд выводит из режима: «download» — файл автора, «cache» — наш
 * поток (в том числе склейка HLS с пересборкой). Отдельным аргументом он не
 * передаётся: режим уже отвечает на этот вопрос однозначно.
 */
export async function saveTrackOffline(
  url: string,
  id: string,
  kind: OfflineBaseKind,
  meta: OfflineMeta = {}
): Promise<SavedFile> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  return invoke<SavedFile>("save_track_offline", {
    url,
    id,
    kind,
    title: meta.title ?? "",
    artist: meta.artist ?? null,
    cover: meta.cover ?? null,
  });
}

/** Список сохранённых файлов: свежие сверху, с исходным id каждого трека. */
export async function offlineFiles(): Promise<SavedFile[]> {
  if (!isTauri()) return [];
  return invoke<SavedFile[]>("offline_files");
}

/**
 * Догружает метаданные одной офлайн-копии: теги файла читаются один раз и
 * запоминаются в реестре. Список (`offlineFiles`) их не читает — это держит
 * старт приложения быстрым.
 */
export async function offlineMeta(trackId: string): Promise<SavedFile> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  return invoke<SavedFile>("offline_meta", { trackId });
}

/** Удаляет файл с диска (только из папки офлайн-треков). */
export async function removeOfflineFile(path: string): Promise<void> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  await invoke("remove_offline_file", { path });
}

/** Помечает офлайн-копию как «держу офлайн» (или снимает пометку). */
export async function setOfflineKept(trackId: string, kept: boolean): Promise<void> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  await invoke("offline_set_kept", { trackId, kept });
}

/** Убирает временные офлайн-копии старше указанного числа дней. */
export async function cleanupOffline(maxAgeDays: number): Promise<number> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  const days = Math.max(0, Math.floor(maxAgeDays));
  return invoke<number>("offline_cleanup", { maxAgeDays: days });
}

/** Суммарный размер офлайн-файлов и свободное место на диске. */
export async function offlineStats(): Promise<OfflineStats> {
  if (!isTauri()) return { totalBytes: 0, freeBytes: 0 };
  const [totalBytes, freeBytes] = await invoke<[number, number]>("offline_stats");
  return { totalBytes: totalBytes ?? 0, freeBytes: freeBytes ?? 0 };
}

/** Разрешил ли автор скачивание и есть ли прямая ссылка на файл. */
export async function soundcloudDownloadInfo(
  clientId: string,
  trackId: string
): Promise<SoundcloudDownloadInfo> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  return invoke<SoundcloudDownloadInfo>("soundcloud_download_info", { clientId, trackId });
}

/**
 * Сохранённый файл как обычный локальный трек: так его показывает вкладка
 * «Скачанные» и играет `playLocal` — файл лежит на диске и сети не требует.
 */
export function trackFromSaved(file: SavedFile): Track {
  return {
    id: file.path,
    path: file.path,
    title: file.title,
    artist: file.artist,
    album: file.album,
    durationMs: file.durationMs,
    source: "local",
    cover: file.cover,
  };
}

/** Размер по-русски: «12,4 МБ», «820 КБ» или «1,8 ГБ». */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1).replace(".", ",")} ГБ`;
  if (megabytes >= 1) return `${megabytes.toFixed(1).replace(".", ",")} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Дата сохранения: «12.05.2026, 18:40». */
export function formatSavedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Короткая подпись способа для интерфейса: способ и режим — разные вещи, и
 * пользователь видит оба. Неизвестное значение показываем как «из потока»: это
 * самый частый способ, и пугать пустой подписью не за что.
 */
export function methodLabel(method: string): string {
  if (method === "download") return "Скачано";
  if (method === "external") return "Через внешний сервис";
  if (method === "import") return "Импорт файла";
  return "Из потока (офлайн-копия)";
}

/** Пояснение способа — для подсказки при наведении. */
export function methodHint(method: string): string {
  if (method === "download") {
    return "Автор разрешил скачивание: это файл трека, а не копия потока";
  }
  if (method === "external") {
    return "Файл добыт сторонним сервисом: он работал без гарантий";
  }
  if (method === "import") {
    return "Файл принесён вручную и принят в офлайн-реестр";
  }
  return "Наш поток: приложение само скачало его и, если формат не играл, пересобрало в m4a";
}

/**
 * Формат файла словами — но только когда он не mp3: «m4a после пересборки».
 * MP3 не подписываем (это обычный файл), прочие форматы называем прямо, чтобы
 * пользователь видел, что именно лежит на диске. «После пересборки» говорим
 * только про наш поток: HLS приходит сегментами, и ADTS-AAC с MPEG-TS
 * собираются муксером в m4a — файл автора или внешнего сервиса так не появлялся.
 */
export function formatHint(
  file: Pick<SavedFile, "fileName" | "path" | "method">
): string | null {
  const name = (file.fileName || file.path || "").split(/[\\/]/).pop() ?? "";
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!extension || extension === "mp3") return null;
  if (extension === "m4a" && file.method === "stream") return "m4a после пересборки";
  return extension;
}

/** Сколько символов причины помещается в тост: остальное остаётся в журнале. */
const MAX_REASON = 180;

/**
 * Короткая причина ошибки сохранения для тоста. Бэкенд складывает причины
 * вложенно («SoundCloud не отдал файл… : не скачался сегмент… : …»), а
 * пользователю нужна одна понятная фраза — поэтому берём первую непустую
 * строку, схлопываем пробелы и обрезаем длинный хвост. Полный текст по-прежнему
 * уходит в журнал ошибок через `logError` и `errorText`.
 */
export function offlineReason(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const line = raw
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  const reason = (line ?? "").replace(/^error:\s*/i, "").replace(/\s+/g, " ").trim();
  if (!reason) return "причина неизвестна";
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1).trimEnd()}…` : reason;
}
