/**
 * Внешние интеграции: Discord Rich Presence и Spotify.
 *
 * В браузере (без Tauri) все вызовы no-op — интерфейс продолжает работать.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./profiles";

export interface SpotifyStatus {
  connected: boolean;
  /** Unix-секунды, до которых действует access-токен. */
  expiresAt: number;
  scope: string | null;
  hasRefresh: boolean;
}

const EMPTY_STATUS: SpotifyStatus = { connected: false, expiresAt: 0, scope: null, hasRefresh: false };

/** Адрес возврата, который нужно один раз добавить в кабинете Spotify. */
export async function spotifyRedirectUri(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("spotify_redirect_uri");
}

export async function spotifyStatus(): Promise<SpotifyStatus> {
  if (!isTauri()) return EMPTY_STATUS;
  return invoke<SpotifyStatus>("spotify_status");
}

export async function spotifyConnect(clientId: string): Promise<SpotifyStatus> {
  if (!isTauri()) throw new Error("Вход в Spotify доступен только в приложении");
  return invoke<SpotifyStatus>("spotify_connect", { clientId });
}

export async function spotifyAccessToken(clientId: string): Promise<string> {
  if (!isTauri()) throw new Error("Spotify доступен только в приложении");
  return invoke<string>("spotify_access_token", { clientId });
}

export async function spotifyDisconnect(): Promise<void> {
  if (!isTauri()) return;
  await invoke("spotify_disconnect");
}

export interface DiscordActivity {
  clientId: string;
  details: string;
  stateLine: string;
  startedAtMs?: number | null;
  /** Ключ ассета в Discord (например «logo») или ссылка на картинку. */
  largeImage?: string | null;
  largeText?: string | null;
}

export async function discordSetActivity(activity: DiscordActivity): Promise<void> {
  if (!isTauri()) return;
  await invoke("discord_set_activity", {
    clientId: activity.clientId,
    details: activity.details,
    stateLine: activity.stateLine,
    startedAtMs: activity.startedAtMs ?? null,
    largeImage: activity.largeImage ?? null,
    largeText: activity.largeText ?? null,
  });
}

/** Активность, когда ничего не играет: показываем иконку приложения. */
export async function discordIdle(clientId: string, largeImage = "logo"): Promise<void> {
  if (!isTauri()) return;
  await invoke("discord_idle", { clientId, largeImage });
}

export async function discordTest(clientId: string, largeImage = "logo"): Promise<void> {
  if (!isTauri()) throw new Error("Discord доступен только в приложении");
  await invoke("discord_test", { clientId, largeImage });
}

export async function discordClear(): Promise<void> {
  if (!isTauri()) return;
  await invoke("discord_clear");
}

/** Сохраняет иконку приложения файлом — её загружают в Discord как ассет. */
export async function exportAppIcon(): Promise<string> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  return invoke<string>("export_app_icon");
}
