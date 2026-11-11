/**
 * Единый ключ текста песни: один трек — один ключ, из какого бы списка его ни
 * включили. Раньше ключом был сырой `id` трека, и один и тот же трек жил под
 * двумя ключами: `soundcloud:123` (карточка сервиса, сохранение текста при
 * скачивании) и путь к офлайн-копии
 * (`…\cache\soundcloud_123__cache.m4a`, воспроизведение из «Скачанных»).
 * Файл `.lrc` пишется Rust по имени `<безопасный id>__<хеш исходного id>`,
 * поэтому ключи давали РАЗНЫЕ файлы: текст лежал на диске, а панель шла в сеть.
 *
 * Правила те же, что у лайков (`favoriteKeyFor`), но со своим исключением:
 * * сервисный трек — всегда `сервис:id` («soundcloud:123»), в каком бы
 *   историческом виде id ни пришёл: `soundcloud_123`, `soundcloud-123`,
 *   `soundcloud123`, `soundcloud_123__cache.m4a`;
 * * локальная копия сервисного трека — тот же `сервис:id`: исходный id берём из
 *   реестра офлайна, а если реестр ещё не прочитан — из имени файла копии;
 * * настоящий локальный файл — путь к нему;
 * * неоднозначно (имя похоже на сервисное, но это не служебная копия и реестр
 *   молчит) — путь: лучше два разных файла текста, чем текст чужой песни.
 *
 * Канонизацию `сервис:id` не дублируем: она уже написана и покрыта тестами в
 * `favoriteKey.ts`, здесь только правило «это копия или настоящий файл».
 */

import { canonicalServiceId } from "./favoriteKey";

/** Служебный хвост имени файла офлайн-копии: `__cache`, `__download`, `__keep`. */
const KIND_SUFFIX = /__(?:cache|download|keep)$/i;
/** Расширение файла: `.mp3`, `.m4a`, `.flac`. */
const EXTENSION = /\.[a-z0-9]{1,5}$/i;

/** Имя файла без каталогов: у локального трека в id лежит весь путь. */
function baseName(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

/** Имя файла без расширения. */
function stemOf(value: string): string {
  return baseName(value).replace(EXTENSION, "");
}

/**
 * Служебный хвост режима в имени файла. Он есть только у наших офлайн-копий
 * (`downloads.rs`: `<безопасный id>__<режим>.<расширение>`), поэтому по нему
 * путь к копии отличается от обычного локального файла с похожим именем.
 */
function hasKindSuffix(value: string): boolean {
  return KIND_SUFFIX.test(stemOf(value));
}

/** Что-то, что описывает трек: id, путь и признак источника. */
export interface LyricsKeySource {
  /** id трека: «soundcloud:123» или путь к локальному файлу. */
  id?: string;
  /** Путь к аудиофайлу: у офлайн-копии здесь лежит файл кеша. */
  path?: string;
  /** Источник трека, если он известен. */
  source?: "local" | "service";
  /** Исходный id записи офлайна (`SavedFile.trackId`). */
  trackId?: string;
}

/**
 * Что резолвер знает об офлайн-реестре. Обе функции — чистые чтения уже
 * прочитанного списка (без диска и сети), поэтому ключ можно считать
 * синхронно, в том числе при отрисовке.
 */
export interface LyricsOfflineKeys {
  /** Исходный id трека по пути к офлайн-копии (или по самому id). */
  trackIdFor(value: string): string | null;
  /** Путь к офлайн-копии по сервисному id — для лечения старых файлов. */
  pathFor(trackId: string): string | null;
}

/**
 * Реестр подключает `lyricsStore`: сам `lib` не имеет права тянуть store и
 * Tauri, иначе его нельзя проверить отдельным скриптом. Пока реестр не
 * подключён (или пуст), резолвер работает по имени файла.
 */
let offlineKeys: LyricsOfflineKeys | null = null;

/** Подключить (или отключить, `null`) знание офлайн-реестра. */
export function setLyricsOfflineKeys(keys: LyricsOfflineKeys | null): void {
  offlineKeys = keys;
}

/** Путь к офлайн-копии сервисного трека, если реестр его знает. */
export function lyricsOfflinePath(trackId: string): string | null {
  const id = trackId?.trim();
  if (!id || !offlineKeys) return null;
  return offlineKeys.pathFor(id);
}

/**
 * Сервисный ключ «сервис:id» из одного значения или null, если значение
 * сервисным треком не является.
 *
 * `trusted` — вызывающий уже знает, что трек сервисный (`source: "service"`):
 * тогда путь без служебного хвоста тоже считается копией сервисного трека.
 */
function serviceKeyOf(value: string, trusted: boolean): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const canonical = canonicalServiceId(raw);
  if (!canonical) return null;

  // «soundcloud:123» и «soundcloud_123» — это id, а не файл: вопросов нет
  if (!/[\\/]/.test(raw)) return canonical;

  // Путь: копия, только если в имени есть служебный хвост режима. Иначе это
  // может быть настоящий файл `C:\Music\soundcloud_123.mp3` — неоднозначно.
  if (hasKindSuffix(raw) || trusted) return canonical;
  return null;
}

/** Настоящий локальный файл: путь, а если пути нет — id. */
function localValueOf(value: string | LyricsKeySource, cleaned: string[]): string {
  if (typeof value === "string") return value.trim();
  const path = value.path?.trim();
  if (path) return path;
  const id = value.id?.trim();
  if (id) return id;
  return cleaned[0] ?? "";
}

/**
 * Ключ текста для любого представления трека: карточки плеера, строки
 * «Скачанных», записи офлайна или просто идентификатора. Только этой функцией
 * и должны пользоваться сохранение, чтение и кеш текста.
 */
export function lyricsKeyFor(value: string | LyricsKeySource): string {
  // Порядок как у лайков: исходный id записи офлайна точнее имени файла копии
  const candidates =
    typeof value === "string" ? [value] : [value.trackId, value.id, value.path];
  const trusted = typeof value === "string" ? false : value.source === "service";
  const cleaned: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const raw = candidate.trim();
    if (raw && !cleaned.includes(raw)) cleaned.push(raw);
  }
  if (!cleaned.length) return "";

  // 1. Реестр офлайна: он знает исходный id, даже если имя файла искажено
  //    (обрезано по длине, содержит нечисловой остаток, принесено вручную).
  if (offlineKeys) {
    for (const raw of cleaned) {
      const known = offlineKeys.trackIdFor(raw)?.trim();
      if (!known) continue;
      return serviceKeyOf(known, true) ?? known;
    }
  }

  // 2. Сам id или имя файла копии
  const serviceKeys = new Set<string>();
  for (const raw of cleaned) {
    const key = serviceKeyOf(raw, trusted);
    if (key) serviceKeys.add(key);
  }
  if (serviceKeys.size === 1) return [...serviceKeys][0];
  // Больше одного сервисного ключа — подсказки расходятся (например, id от
  // одного сервиса, а имя файла от другого): не угадываем, берём путь.

  // 3. Настоящий локальный файл
  return localValueOf(value, cleaned);
}
