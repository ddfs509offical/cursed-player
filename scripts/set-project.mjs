#!/usr/bin/env node
/**
 * Переключить вшитый проект Supabase на другой (например, когда старого проекта
 * больше нет и создан новый).
 *
 * Запуск:
 *   npm run project -- --url https://xxxx.supabase.co --key sb_publishable_xxx
 *   npm run project -- --print     # показать, что вшито сейчас
 *
 * Правит ровно две константы в src/services/supabase.ts. Секретные ключи
 * (`sb_secret_…`, `service_role`) не принимаются: им нечего делать в клиенте.
 * После смены — пересборка: `npm run desktop` (или `tauri build --bundles nsis`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(resolve(here, ".."), "src", "services", "supabase.ts");

const args = process.argv.slice(2);
const read = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const source = readFileSync(file, "utf8");
const urlMatch = source.match(/SUPABASE_URL_DEFAULT = "([^"]*)"/);
const keyMatch = source.match(/SUPABASE_ANON_KEY_DEFAULT = "([^"]*)"/);

if (!urlMatch || !keyMatch) {
  console.error("Не нашёл константы SUPABASE_URL_DEFAULT / SUPABASE_ANON_KEY_DEFAULT");
  process.exit(1);
}

const current = { url: urlMatch[1], key: keyMatch[1] };

if (args.includes("--print") || args.length === 0) {
  console.log(`проект: ${current.url}`);
  console.log(`ключ:   ${current.key}`);
  process.exit(0);
}

const url = (read("url") ?? "").trim().replace(/\/+$/, "");
const key = (read("key") ?? "").trim();

if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(url)) {
  console.error(`Адрес проекта должен быть вида https://xxxx.supabase.co — получено: «${url}»`);
  process.exit(1);
}
if (/^sb_secret_|service_role/i.test(key)) {
  console.error("Это секретный ключ: в клиент его вшивать нельзя. Нужен публичный sb_publishable_…");
  process.exit(1);
}
if (!/^(sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+)$/.test(key)) {
  console.error("Не похоже на публичный ключ Supabase (sb_publishable_… или прежний anon-JWT)");
  process.exit(1);
}

const next = source
  .replace('SUPABASE_URL_DEFAULT = "' + current.url + '"', 'SUPABASE_URL_DEFAULT = "' + url + '"')
  .replace('SUPABASE_ANON_KEY_DEFAULT = "' + current.key + '"', 'SUPABASE_ANON_KEY_DEFAULT = "' + key + '"');

if (next === source) {
  console.log("Ничего не изменилось: эти значения уже вшиты");
  process.exit(0);
}

writeFileSync(file, next, "utf8");
console.log(`Вшито: ${url}`);
console.log(`Ключ:  ${key.slice(0, 24)}…`);
console.log("Дальше — пересборка: npm run desktop (или tauri build --bundles nsis)");
