/**
 * Вход в Яндекс по OAuth: браузер → локальный порт → refresh-токен,
 * который продлевается автоматически (как у Spotify).
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./profiles";

export interface YandexStatus {
  connected: boolean;
  expiresAt: number;
  hasRefresh: boolean;
}

export interface YandexAccount {
  hasPlus: boolean;
  hasMusicSubscription: boolean;
  uid: string | null;
  displayName: string | null;
  /** Функциональная проверка: отдаёт ли Яндекс полный трек. */
  streamFull: boolean | null;
  note: string;
}

const EMPTY: YandexStatus = { connected: false, expiresAt: 0, hasRefresh: false };

/** Адрес возврата: его нужно добавить в приложении Яндекса один раз. */
export async function yandexRedirectUri(host = "127.0.0.1"): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("yandex_redirect_uri", { host });
}

export async function yandexStatus(): Promise<YandexStatus> {
  if (!isTauri()) return EMPTY;
  return invoke<YandexStatus>("yandex_status");
}

export async function yandexConnect(
  clientId: string,
  clientSecret: string,
  host = "127.0.0.1"
): Promise<YandexStatus> {
  if (!isTauri()) throw new Error("Вход доступен только в приложении");
  return invoke<YandexStatus>("yandex_connect", { clientId, clientSecret, host });
}

export async function yandexAccessToken(clientId: string, clientSecret: string): Promise<string> {
  if (!isTauri()) throw new Error("Яндекс доступен только в приложении");
  return invoke<string>("yandex_access_token", { clientId, clientSecret });
}

export async function yandexDisconnect(): Promise<void> {
  if (!isTauri()) return;
  await invoke("yandex_disconnect");
}

/** Проверка: есть ли на токене Плюс и к какому аккаунту он относится. */
export async function yandexAccountInfo(token: string): Promise<YandexAccount> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  return invoke<YandexAccount>("yandex_account_info", { token });
}
