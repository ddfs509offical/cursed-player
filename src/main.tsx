import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import Island from "./Island";
import "./styles.css";
// Новый слой оформления «Обсидиан»: идёт после общих стилей, чтобы перекрывать их.
import "./obsidian.css";
import "./obsidian-layout.css";
import "./obsidian-shell.css";
import "./obsidian-transport.css";
import "./obsidian-home.css";
import "./obsidian-motion.css";
import "./obsidian-window.css";

/**
 * Островок поверх игры — то же приложение, но во втором окне.
 *
 * Отличаем его по метке окна: адрес с `?island=1` WebView не резолвит, и окно
 * открывалось пустым, а метка окна есть всегда. Один бандл обслуживает оба
 * окна, вторая сборка не нужна.
 */
function detectIsland(): boolean {
  try {
    if (getCurrentWindow().label === "island") return true;
  } catch {
    // Вне Tauri (браузер, тесты) метки нет — остаёмся обычным окном
  }
  return new URLSearchParams(window.location.search).has("island");
}

const isIsland = detectIsland();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isIsland ? <Island /> : <App />}</React.StrictMode>
);
