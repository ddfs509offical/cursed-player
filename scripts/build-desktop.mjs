#!/usr/bin/env node
/**
 * Собирает release-версию приложения и кладёт отдельный exe на рабочий стол.
 *
 * Запуск:  npm run desktop
 * Быстро, без пересборки:  npm run desktop -- --skip-build
 *
 * Отдельный exe самодостаточен: интерфейс вшит в бинарник, нужен только
 * WebView2 (в Windows 10/11 он уже есть). База профилей лежит в
 * %APPDATA%\com.example.musichub — та же, что у dev-запуска.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const binary = join(projectRoot, "src-tauri", "target", "release", "music_hub.exe");
const exeName = "Cursed player.exe";

const skipBuild = process.argv.includes("--skip-build");

if (!skipBuild) {
  console.log("Собираю release-сборку (tauri build --no-bundle)…");
  const result = spawnSync("npm", ["run", "tauri", "--", "build", "--no-bundle"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    console.error("Сборка не удалась — exe не обновлён");
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(binary)) {
  console.error(`Не нашёл собранный файл: ${binary}`);
  process.exit(1);
}

const desktopCandidates = [
  join(homedir(), "Desktop"),
  join(homedir(), "Рабочий стол"),
  join(homedir(), "OneDrive", "Desktop"),
  join(homedir(), "OneDrive", "Рабочий стол"),
];
const desktop = desktopCandidates.find((path) => existsSync(path));
if (!desktop) {
  console.error("Не нашёл папку рабочего стола");
  process.exit(1);
}

const target = join(desktop, exeName);
copyFileSync(binary, target);
const sizeMb = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`Готово: ${target} (${sizeMb} МБ)`);
