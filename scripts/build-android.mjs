#!/usr/bin/env node
/**
 * Выпуск Android: собрать APK, подписать и подготовить файлы для раздачи.
 *
 * Запуск: npm run android
 *
 * Что делает:
 *  1. кросс-компилирует Rust под arm64 (телефоны) и x86_64 (эмулятор);
 *  2. собирает APK через Gradle, минуя символические ссылки, которые на
 *     Windows без режима разработчика создать нельзя;
 *  3. подписывает ключом из `%USERPROFILE%\.android`;
 *  4. кладёт APK в `dist-update/` и пишет `android.json` для проверки
 *     обновлений внутри самого приложения.
 *
 * Ключ подписи:
 *   Создаётся один раз командой
 *     keytool -genkeypair -v -keystore %USERPROFILE%\.android\cursed-debug.keystore \
 *       -storepass android -keypass android -alias cursed -keyalg RSA -keysize 2048 \
 *       -validity 10000 -dname "CN=Cursed Player"
 *   Тот же ключ должен оставаться неизменным: Android не даёт обновлять
 *   приложение, подписанное другим ключом.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const sdk = join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const ndkRoot = join(sdk, "ndk");
/** Самая свежая версия по числовым частям: 35.0.0 новее 34.0.0. */
function latestVersion(parent) {
  // Явный импорт, а не require внутри функции: в ESM-модуле его нет.
  const list = readdirSync(parent);
  list.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return list[0] ?? "";
}

/** Самая свежая подпапка NDK по имени: 27.0.12077973 новее 26.1.10909125. */
function firstDir(parent) {
  return [...readdirSync(parent)].sort().reverse()[0] ?? "";
}

const ndk = existsSync(ndkRoot) ? join(ndkRoot, process.env.NDK_VERSION ?? firstDir(ndkRoot)) : "";
const prebuilt = join(ndk, "toolchains", "llvm", "prebuilt", "windows-x86_64", "bin");
const ANDROID_HOME = sdk;

const BUILD_RE = /export const APP_BUILD = (\d+);/;
const appFile = join(root, "src", "lib", "app.ts");
const build = Number(readFileSync(appFile, "utf8").match(BUILD_RE)?.[1] ?? 0);

if (!ndk) {
  console.error("Не нашёл NDK в", ndkRoot);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    // Рабочий каталог задаёт вызывающий: cargo ищет Cargo.toml там, где
    // запущен, а Gradle — в папке Android-проекта.
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    shell: false,
  });
  return result.status ?? 1;
}

/** Переменные окружения для кросс-компиляции под выбранную архитектуру. */
function cargoEnv(target, clang) {
  const upper = target.toUpperCase().replace(/-/g, "_");
  return {
    ANDROID_HOME,
    ANDROID_SDK_ROOT: ANDROID_HOME,
    NDK_HOME: ndk,
    [`CC_${target.replace(/-/g, "_")}`]: join(prebuilt, `${clang}21-clang.cmd`),
    [`AR_${target.replace(/-/g, "_")}`]: join(prebuilt, "llvm-ar.exe"),
    [`CARGO_TARGET_${upper}_LINKER`]: join(prebuilt, `${clang}21-clang.cmd`),
  };
}

const targets = [
  {
    abi: "arm64-v8a",
    target: "aarch64-linux-android",
    clang: "aarch64-linux-android",
    gradle: "Arm64",
    // Папка вывода Gradle называется иначе, чем ABI.
    out: "arm64",
  },
  {
    abi: "x86_64",
    target: "x86_64-linux-android",
    clang: "x86_64-linux-android",
    gradle: "X86_64",
    out: "x86_64",
  },
];

const only = process.argv.includes("--arm64") ? targets.slice(0, 1) : targets;

for (const item of only) {
  console.log(`\n=== Rust → ${item.abi} ===`);
  const status = run(
    "cargo",
    ["build", "--target", item.target, "--lib", "--release", "--features", "custom-protocol"],
    { cwd: join(root, "src-tauri"), env: cargoEnv(item.target, item.clang) }
  );
  if (status !== 0) {
    console.error("Сборка Rust не удалась");
    process.exit(1);
  }

  const lib = join(root, "src-tauri", "target", item.target, "release", "libmusic_hub_lib.so");
  const dest = join(root, "src-tauri", "gen", "android", "app", "src", "main", "jniLibs", item.abi);
  mkdirSync(dest, { recursive: true });
  copyFileSync(lib, join(dest, "libmusic_hub_lib.so"));
  console.log(`${item.abi}: библиотека на месте`);

  console.log(`\n=== APK → ${item.abi} ===`);
  // .bat на Windows запускается только через оболочку: spawnSync не умеет
  // исполнять пакетные файлы напрямую (EINVAL).
  const gradleStatus = run(
    "cmd",
    [
      "/c",
      join(root, "src-tauri", "gen", "android", "gradlew.bat"),
      `assemble${item.gradle}Release`,
      "--no-daemon",
      "-x",
      `rustBuild${item.gradle}Release`,
    ],
    { cwd: join(root, "src-tauri", "gen", "android") }
  );
  if (gradleStatus !== 0) {
    console.error(`Gradle не собрал APK для ${item.abi}`);
    process.exit(1);
  }
}

// Подпись: один ключ на все выпуски.
const keystore = join(homedir(), ".android", "cursed-debug.keystore");
if (!existsSync(keystore)) {
  console.error("Нет ключа подписи:", keystore);
  console.error("Создай его командой keytool (см. шапку scripts/build-android.mjs).");
  process.exit(1);
}

// Корень build-tools вынесен: `join` с вложенным вызовом терял версию.
const buildToolsRoot = join(sdk, "build-tools");
const buildTools = join(buildToolsRoot, latestVersion(buildToolsRoot));
const outDir = join(root, "dist-update");
mkdirSync(outDir, { recursive: true });

for (const item of only) {
  const apkDir = join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", item.out, "release");
  const unsigned = join(apkDir, `app-${item.out}-release-unsigned.apk`);
  if (!existsSync(unsigned)) {
    console.error("Нет собранного APK:", unsigned);
    process.exit(1);
  }
  const signed = join(apkDir, `cursed-${item.abi}.apk`);
  // apksigner тоже пакетный файл: по той же причине через cmd.
  const signStatus = run("cmd", [
    "/c",
    join(buildTools, "apksigner.bat"),
    "sign",
    "--ks", keystore,
    "--ks-pass", "pass:android",
    "--key-pass", "pass:android",
    "--ks-key-alias", "cursed",
    "--out", signed,
    unsigned,
  ]);
  if (signStatus !== 0) {
    console.error("Подпись не удалась:", item.abi);
    process.exit(1);
  }
  console.log(`подписано: ${signed}`);
}

// Файл для проверки обновлений на телефоне.
const armApk = join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "arm64", "release", "cursed-arm64-v8a.apk");
const source = existsSync(armApk)
  ? armApk
  : join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "x86_64", "release", "cursed-x86_64.apk");

const published = join(outDir, "Cursed Player.apk");
copyFileSync(source, published);

writeFileSync(
  join(outDir, "android.json"),
  JSON.stringify(
    {
      version: String(build),
      notes: "",
      size: statSync(published).size,
      file: "Cursed Player.apk",
    },
    null,
    2
  ) + "\n",
  "utf8"
);

console.log(`\nГотово. Сборка ${build}.`);
console.log("Осталось загрузить в Supabase → Storage → бакет `updates`:");
console.log(`  ${published}`);
console.log(`  ${join(outDir, "android.json")}`);
