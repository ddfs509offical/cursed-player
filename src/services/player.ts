/**
 * Локальная музыка: выбор файлов, папки и чтение тегов (Rust-команды).
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./profiles";

export interface LocalTrack {
  path: string;
  fileName: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number;
  /** Путь к обложке, извлечённой из тегов файла. */
  cover: string | null;
}

/** Диалог выбора: можно выбрать сразу несколько файлов. */
export async function pickAudioFiles(): Promise<LocalTrack[]> {
  if (!isTauri()) return [];
  return invoke<LocalTrack[]>("player_pick_files");
}

/** Диалог выбора папки. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("player_pick_folder");
}

/** Обход папки: все аудиофайлы с тегами. */
export async function scanFolder(path: string): Promise<LocalTrack[]> {
  if (!isTauri()) return [];
  return invoke<LocalTrack[]>("player_scan_folder", { path });
}

/** Метаданные по готовым путям. */
export async function readFiles(paths: string[]): Promise<LocalTrack[]> {
  if (!isTauri() || !paths.length) return [];
  return invoke<LocalTrack[]>("player_read_files", { paths });
}

/** Прямая ссылка на поток трека Яндекс.Музыки. */
export interface StreamInfo {
  url: string;
  /** true — Яндекс отдал только 30-секундный фрагмент (нет активного Плюса). */
  preview: boolean;
}

export async function yandexTrackUrl(token: string, trackId: string): Promise<StreamInfo> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  return invoke<StreamInfo>("yandex_track_url", { token, trackId });
}

/** Свернуть окно в трей / вернуть обратно. */
export async function hideToTray(): Promise<void> {
  if (!isTauri()) return;
  await invoke("window_hide_to_tray");
}

export async function showFromTray(): Promise<void> {
  if (!isTauri()) return;
  await invoke("window_show_from_tray");
}
