#!/usr/bin/env node
/**
 * Релиз: поднять номер сборки, собрать установщик, разложить файлы и собрать
 * `latest.json` для автообновления.
 *
 * Запуск: npm run release
 *
 * Что делает:
 *  1. увеличивает APP_BUILD в src/lib/app.ts (по нему приложение понимает,
 *     что вышла новая сборка);
 *  2. собирает NSIS-установщик (`tauri build --bundles nsis`);
 *  3. кладёт exe, установщик и zip на рабочий стол;
 *  4. пишет `dist-update/latest.json` и копирует туда установщик.
 *
 * Последний шаг — руками: загрузить оба файла из `dist-update/` в Supabase →
 * Storage → бакет `updates`. После загрузки приложения у людей сами предложат
 * обновление (проверка раз в 6 часов и кнопка «Проверить» в настройках).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const appFile = join(root, "src", "lib", "app.ts");

const BUILD_RE = /export const APP_BUILD = (\d+);/;
const source = readFileSync(appFile, "utf8");
const match = source.match(BUILD_RE);
if (!match) {
  console.error("Не нашёл APP_BUILD в src/lib/app.ts");
  process.exit(1);
}
const current = Number(match[1]);
const next = current + 1;
writeFileSync(appFile, source.replace(BUILD_RE, `export const APP_BUILD = ${next};`), "utf8");
console.log(`Сборка: ${current} → ${next}`);

console.log("Собираю установщик…");
const build = spawnSync(
  process.execPath,
  [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build", "--bundles", "nsis"],
  { cwd: root, stdio: "inherit" }
);
if (build.status !== 0) {
  console.error("Сборка не удалась — номер сборки уже поднят, поправь и повтори");
  process.exit(build.status ?? 1);
}

const release = join(root, "src-tauri", "target", "release");
const exePath = join(release, "music_hub.exe");
const setupDir = join(release, "bundle", "nsis");
const setupName = "Cursed player setup.exe";

if (!existsSync(exePath)) {
  console.error(`Нет собранного exe: ${exePath}`);
  process.exit(1);
}
const setupFile = (() => {
  const list = readdirSync(setupDir).filter((name) => name.toLowerCase().endsWith(".exe"));
  return list.length ? join(setupDir, list[0]) : null;
})();
if (!setupFile) {
  console.error("В bundle/nsis нет установщика");
  process.exit(1);
}

const desktop = [join(homedir(), "Desktop"), join(homedir(), "Рабочий стол")].find((path) => existsSync(path));
if (desktop) {
  // Запущенное приложение держит файл — не валим релиз, просто предупреждаем.
  try {
    copyFileSync(exePath, join(desktop, "Cursed player.exe"));
    copyFileSync(setupFile, join(desktop, setupName));
    console.log(`Разложено на рабочий стол: ${desktop}`);
  } catch (error) {
    console.warn(`Не удалось обновить файлы на рабочем столе (${error.code ?? error.message}).`);
    console.warn("Закрой приложение и скопируй exe/установщик вручную.");
  }
}

const updateDir = join(root, "dist-update");
mkdirSync(updateDir, { recursive: true });
const updateSetup = join(updateDir, "Cursed player setup.exe");
copyFileSync(setupFile, updateSetup);

const size = statSync(updateSetup).size;
const latest = {
  version: String(next),
  notes: "",
  size,
  file: "Cursed player setup.exe",
};
writeFileSync(join(updateDir, "latest.json"), JSON.stringify(latest, null, 2) + "\n", "utf8");

console.log(`\nГотово. Сборка ${next}, установщик ${(size / 1024 / 1024).toFixed(1)} МБ.`);
console.log("Осталось загрузить в Supabase → Storage → бакет `updates` два файла:");
console.log(`  ${join(updateDir, "latest.json")}`);
console.log(`  ${updateSetup}`);
console.log("\nПосле загрузки приложение предложит обновление само (проверка раз в 6 часов).");
