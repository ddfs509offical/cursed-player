/**
 * Картинки профиля.
 *
 * В приложении выбор файла идёт через системный диалог, а картинка по ссылке
 * скачивается на стороне Rust — у WebView свои правила CORS, и обычный fetch
 * на чужой домен из интерфейса не сработает. Обе операции возвращают готовый
 * data-URL: аватар обрезается в квадрат до 512px, баннер вписывается в 1920px.
 *
 * Вне Tauri (обычный браузер) используются запасные пути, чтобы интерфейс
 * не ломался во время разработки фронтенда.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./profiles";

export type MediaKind = "avatar" | "banner";

/** Выбор файла: системный диалог в приложении, <input type=file> в браузере. */
export async function pickImage(kind: MediaKind): Promise<string | null> {
  if (isTauri()) {
    return (await invoke<string | null>("media_pick_image", { kind })) ?? null;
  }
  return pickInBrowser();
}

/** Скачивание по ссылке: через Rust в приложении, как есть — в браузере. */
export async function fetchImage(url: string, kind: MediaKind): Promise<string> {
  if (isTauri()) {
    return invoke<string>("media_fetch_image", { url, kind });
  }
  return url;
}

function pickInBrowser(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(file);
    };
    input.click();
  });
}
