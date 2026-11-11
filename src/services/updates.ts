import { invoke } from "@tauri-apps/api/core";
import { APP_BUILD } from "../lib/app";
import { isTauri } from "./profiles";

/**
 * Автообновление.
 *
 * Сервер (Supabase Storage, бакет `updates`) отдаёт `latest.json` с номером
 * сборки и ссылкой на установщик. Сравниваем номер со своим `APP_BUILD` —
 * его поднимает `npm run release` при каждой сборке. Ничего не устанавливается
 * без подтверждения: приложение скачивает установщик в temp и запускает его,
 * дальше работает обычный NSIS-инсталлятор.
 */

export interface UpdateInfo {
  /** Номер сборки строкой: "12". */
  version: string;
  notes: string | null;
  url: string;
  size: number | null;
}

/** Номер сборки из ответа сервера; NaN, если там мусор. */
function remoteBuild(info: UpdateInfo): number {
  return Number.parseInt(info.version, 10);
}

/** Есть ли более новая сборка. Ошибки сети молчат: это фоновая проверка. */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    if (!info) return null;
    const remote = remoteBuild(info);
    if (!Number.isFinite(remote) || remote <= APP_BUILD) return null;
    return info;
  } catch {
    return null;
  }
}

/** Скачать установщик и открыть его. Дальше NSIS закрывает приложение и ставит новую версию. */
export async function installUpdate(info: UpdateInfo): Promise<string> {
  if (!isTauri()) throw new Error("Обновление доступно только в приложении");
  const path = await invoke<string>("update_download", { url: info.url });
  await invoke("update_launch", { path });
  return path;
}

/** Проверка не чаще раза в 6 часов, чтобы не дёргать сервер на каждый запуск. */
export function shouldCheckNow(): boolean {
  try {
    const last = Number(localStorage.getItem("cursed_update_check_ms") ?? 0);
    if (!Number.isFinite(last)) return true;
    return Date.now() - last > 6 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

export function markCheckedNow(): void {
  try {
    localStorage.setItem("cursed_update_check_ms", String(Date.now()));
  } catch {
    // приватный режим — не беда, проверим в следующий раз
  }
}
