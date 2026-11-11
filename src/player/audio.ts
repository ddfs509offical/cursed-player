import { convertFileSrc } from "@tauri-apps/api/core";
import Hls from "hls.js";

/**
 * Один аудиоэлемент на всё приложение: так проще синхронизировать состояние
 * (позиция, громкость, конец трека) и не плодить плееры в разных компонентах.
 */
export const playerAudio: HTMLAudioElement | null =
  typeof Audio !== "undefined" ? new Audio() : null;

/**
 * Режим повтора, который читает сам аудиоэлемент.
 *
 * Обработчик `ended` в компоненте подписан на конкретный элемент и при
 * перемонтировании эффектов может отвалиться — тогда трек заканчивается
 * и молчит, хотя повтор включён. Здесь, в модуле, который владеет элементом,
 * подписка живёт столько же, сколько аудио.
 */
let repeatMode: "off" | "all" | "one" = "off";

/** Вызывается хранилищем при смене режима повтора. */
export function setRepeatMode(mode: "off" | "all" | "one"): void {
  repeatMode = mode;
}

// Повтор одного трека: перемотка в начало и запуск.
playerAudio?.addEventListener("ended", () => {
  if (repeatMode !== "one" || !playerAudio) return;
  playerAudio.currentTime = 0;
  void playerAudio.play().catch(() => {});
});

let hls: Hls | null = null;
let currentSource = "";

if (playerAudio) {
  playerAudio.preload = "metadata";
  // Элемент живёт в DOM скрытым: так он доступен системным медиа-клавишам,
  // а плеер остаётся управляемым из одного места.
  playerAudio.style.display = "none";
  if (typeof document !== "undefined") {
    const attach = () => document.body.appendChild(playerAudio);
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  }
}

/** Элемент или контекст с поддержкой выбора устройства вывода. */
type Sinkable = { setSinkId?: (deviceId: string) => Promise<void> };

/**
 * Умеет ли движок направлять звук на выбранное устройство. В старых WebView
 * `setSinkId` нет — тогда честно показываем, что играет системное устройство,
 * и ничего не ломаем.
 */
export function audioOutputSupported(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as Sinkable).setSinkId === "function"
  );
}

/**
 * Направляет звук плеера на устройство `deviceId` (пустая строка — системное
 * по умолчанию). Бросает ошибку, если движок так не умеет или устройство
 * больше не подключено: вызывающий сам решает, что показать пользователю.
 */
export async function setAudioOutput(deviceId: string): Promise<void> {
  const audio = playerAudio as (HTMLAudioElement & Sinkable) | null;
  if (!audio) throw new Error("Аудиоэлемент плеера недоступен");
  if (typeof audio.setSinkId !== "function") {
    throw new Error("Выбор устройства вывода не поддерживается этим движком");
  }
  await audio.setSinkId(deviceId);
}

/** Локальный путь превращаем в ссылку, которую умеет играть WebView. */
export function toPlayableUrl(path: string): string {
  if (!path) return "";
  if (/^(https?|asset|blob|data):/.test(path)) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/** HLS-поток (m3u8) WebView сам не играет — его подключаем через hls.js. */
export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url);
}

/**
 * Загружает источник в плеер. Обычный файл или mp3-поток идёт напрямую,
 * HLS — через hls.js (например, часть треков SoundCloud).
 *
 * Возвращает true, если источник действительно поставлен. Пустой url — это
 * не «уже загружено»: ничего не подставляем и не пишем пустую строку в
 * currentSource, иначе следующий настоящий трек сочтётся повтором текущего
 * и не заиграет (у сервисных треков из «Избранного» путь как раз пустой).
 */
export function loadSource(url: string): boolean {
  if (!playerAudio) return false;
  if (!url) return false;
  if (url === currentSource) return false;
  currentSource = url;

  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (isHlsUrl(url) && Hls.isSupported()) {
    hls = new Hls({ enableWorker: false });
    hls.loadSource(url);
    hls.attachMedia(playerAudio);
    return true;
  }

  playerAudio.src = url;
  try {
    playerAudio.currentTime = 0;
  } catch {
    // до загрузки метаданных позицию выставлять нельзя — не страшно
  }
  return true;
}

/**
 * Полный сброс источника (выход из профиля, смена аккаунта): забываем
 * загруженную ссылку, чтобы следующий трек гарантированно загрузился заново.
 */
export function clearSource(): void {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  currentSource = "";
  if (!playerAudio) return;
  playerAudio.pause();
  playerAudio.removeAttribute("src");
}
