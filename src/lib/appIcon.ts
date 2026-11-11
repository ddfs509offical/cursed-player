import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../store/settingsStore";
import bundled from "../assets/app-icon.png";

/**
 * Текущая иконка приложения: своя, если пользователь её выбрал, иначе встроенная.
 */
export function useAppIcon(): string {
  return useSettingsStore((s) => s.customAppIcon) || bundled;
}

export function appIconSrc(): string {
  return useSettingsStore.getState().customAppIcon || bundled;
}

/** Выбор своей иконки: PNG, JPEG, WebP или анимированный GIF. */
export async function pickAppIcon(): Promise<string | null> {
  return invoke<string | null>("app_icon_pick");
}

/** Отдаёт иконку в панель задач; для GIF берётся первый кадр. */
export async function applyWindowIcon(dataUrl: string | null): Promise<void> {
  try {
    await invoke("window_set_icon", { dataUrl });
  } catch {
    // Иконка окна — украшение: если Windows не приняла, продолжаем
  }
}

/** Сохраняет иконку файлом (для загрузки в Discord как ассет). */
export async function exportAppIconFile(dataUrl: string | null): Promise<string> {
  return invoke<string>("app_icon_export", { dataUrl });
}
