#!/usr/bin/env node
/**
 * Склеивает SQL-файлы для Supabase из исходных миграций.
 *
 * Зачем скрипт, а не PowerShell: однажды склейка через Get-Content/Set-Content
 * прочитала UTF-8 как ANSI и записала в файл «кракозябры» — в SQL Editor это
 * выглядело мусором. Node читает и пишет строго UTF-8, а в конце скрипт сам
 * проверяет, что русский текст остался русским.
 *
 * Запуск: npm run sql   (или node scripts/build-sql.mjs)
 * Пишет: supabase/FRESH-PROJECT.sql (новый проект), supabase/INVITES-setup.sql
 *        (только приглашения), и копирует оба на рабочий стол.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const supabase = join(root, "supabase");

const read = (name) => readFileSync(join(supabase, name), "utf8");

const base = read("base-schema.sql");
const invites = read("migrations/20261023_invites.sql");
const owner = read("migrations/20261028_owner_admin.sql");
const tools = read("migrations/20261029_owner_tools.sql");
const updates = read("migrations/20261030_registration_updates.sql");

const separator = (label) =>
  `\n\n-- ===================== ${label} =====================\n\n`;

const freshHeader = `-- Cursed player · ПОЛНАЯ СХЕМА ДЛЯ НОВОГО ПРОЕКТА SUPABASE
--
-- Как применить (≈15 секунд):
--   1. Создать пустой проект на supabase.com (регион — Central EU / Frankfurt).
--   2. Открыть SQL Editor этого проекта.
--   3. Вставить весь файл и нажать Run.
--
-- После этого прислать владельцу разработки: Project URL и ПУБЛИЧНЫЙ ключ
-- sb_publishable_… (Settings → API). Секретный sb_secret_… не нужен.
--
-- Что внутри: базовая схема (user_data, profiles, app_config, RLS) + система
-- приглашений (invites, app_admins, триггер регистрации) + владелец в app_admins.
`;

const invitesHeader = `-- Cursed player · ПРИГЛАШЕНИЯ ДЛЯ УЖЕ РАБОТАЮЩЕГО ПРОЕКТА
--
-- Как применить (≈10 секунд):
--   1. Открыть SQL Editor своего проекта.
--   2. Вставить весь файл и нажать Run. Скрипт идемпотентный.
--
-- Нужен, только если база уже есть (user_data, profiles, app_config на месте).
-- Для нового пустого проекта — FRESH-PROJECT.sql: там базовая схема тоже.
`;

const fresh =
  freshHeader +
  separator("1/4 · базовая схема") +
  base +
  separator("2/4 · приглашения (23.10)") +
  invites +
  separator("3/4 · владелец в app_admins (28.10)") +
  owner +
  separator("4/5 · HWID и админ-панель (29.10)") +
  tools +
  separator("5/5 · регистрация и обновления (30.10)") +
  updates;

const invitesOnly =
  invitesHeader +
  separator("1/2 · приглашения (23.10)") +
  invites +
  separator("2/2 · владелец в app_admins (28.10)") +
  owner;

const toolsHeader = `-- Cursed player · HWID и админ-панель для УЖЕ РАБОТАЮЩЕГО проекта
--
-- Как применить (≈10 секунд):
--   1. Открыть SQL Editor своего проекта.
--   2. Вставить весь файл и нажать Run. Скрипт идемпотентный.
--
-- Что появляется: привязка аккаунта к компьютеру (device_links, device_bind,
-- device_lookup), роль владельца для клиента (is_owner) и функции админ-панели
-- (admin_stats, admin_users, admin_devices, admin_invite_uses, admin_set_open).
`;

const toolsOnly = toolsHeader + separator("HWID и админ-панель (29.10)") + tools;

/** Признаки «UTF-8 прочитали как ANSI»: таких сочетаний в живом русском нет. */
const MOJIBAKE = [/\u0432\u0402/, /\u0420\u0405/, /\u0420\u0451\u0402/, /\u0421\u0403\u0432\u0402/, /\uFFFD/];

function assertClean(name, text) {
  for (const re of MOJIBAKE) {
    if (re.test(text)) {
      console.error(`ОШИБКА: в ${name} битая кодировка (${re})`);
      process.exit(1);
    }
  }
}

assertClean("base-schema.sql", base);
assertClean("20261023_invites.sql", invites);
assertClean("20261028_owner_admin.sql", owner);
assertClean("20261029_owner_tools.sql", tools);
assertClean("20261030_registration_updates.sql", updates);
assertClean("FRESH-PROJECT.sql", fresh);
assertClean("INVITES-setup.sql", invitesOnly);
assertClean("OWNER-TOOLS.sql", toolsOnly);

const updatesHeader = `-- Cursed player · открытая регистрация для клиента и бакет обновлений
--
-- Как применить: SQL Editor проекта → вставить весь файл → Run. Идемпотентно.
--
-- Что появляется: app_registration_state() (клиент узнаёт, что регистрация
-- открыта, и не просит ключ) и публичный бакет storage «updates» для latest.json
-- и установщика.
`;

const updatesOnly = updatesHeader + separator("регистрация и обновления (30.10)") + updates;

const targets = [
  ["FRESH-PROJECT.sql", fresh],
  ["INVITES-setup.sql", invitesOnly],
  ["OWNER-TOOLS.sql", toolsOnly],
  ["REGISTRATION-UPDATES.sql", updatesOnly],
];

const desktop = join(homedir(), "Desktop");
for (const [name, text] of targets) {
  const path = join(supabase, name);
  writeFileSync(path, text, "utf8");
  try {
    copyFileSync(path, join(desktop, name));
  } catch {
    // рабочего стола может не быть — файл всё равно лежит в проекте
  }
  const firstLine = text.split("\n")[0];
  console.log(`${name}: ${Buffer.byteLength(text)} байт · ${text.split("\n").length} строк`);
  console.log(`   первая строка: ${firstLine}`);
}
