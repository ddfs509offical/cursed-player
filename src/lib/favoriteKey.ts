/**
 * Единый ключ лайка: один трек — один ключ, из какого бы списка его ни
 * лайкнули. Раньше каждая вкладка решала это по-своему, и один и тот же трек
 * лежал в избранном дважды: как «soundcloud:123» и как путь к офлайн-копии
 * (`…\cache\soundcloud_123__cache.m4a`) — сердечко в «Скачанных» и в очереди
 * ставило то один, то другой ключ.
 *
 * Правила простые:
 * * сервисный трек — всегда `сервис:id` («soundcloud:123»);
 * * локальный файл — всегда путь к аудиофайлу (тот же, что даёт
 *   `trackFromLocal` и запись офлайна).
 *
 * Старые форматы (`soundcloud_123`, `soundcloud-123`, `soundcloud123`, а также
 * имя файла офлайн-копии `soundcloud_123__cache.m4a`) при чтении приводим к
 * каноническому виду — поэтому лайки прошлых версий не теряются.
 */

import { SERVICES, serviceFromTrackId } from "./services";
import { offlineKey } from "./offline";

/** Хвост служебного имени файла офлайн-копии: `soundcloud_123__cache.m4a`. */
const OFFLINE_SUFFIX = /__(?:cache|download|keep|external|import)$/i;
/** Расширение файла: `.mp3`, `.m4a`, `.flac`. */
const EXTENSION = /\.[a-z0-9]{1,5}$/i;

/** Имя файла без каталогов: у локального трека в id лежит весь путь. */
function baseName(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

/** Сервис по имени: «soundcloud» в любом регистре. */
function serviceByName(name: string) {
  const lower = name.toLowerCase();
  return SERVICES.find((service) => service.id === lower) ?? null;
}

/**
 * Канонический сервисный ключ «сервис:id» или null, если значение сервисным
 * треком не является. Понимает id в любом историческом виде и путь к
 * офлайн-копии: у копии в имени файла зашит исходный id.
 */
export function canonicalServiceId(value: string): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  // Уже канонический вид («soundcloud:123») — его и возвращаем
  if (serviceFromTrackId(raw)) return raw;

  const isPath = /[\\/]/.test(raw);
  const name = baseName(raw).replace(EXTENSION, "").replace(OFFLINE_SUFFIX, "").trim();
  if (!name) return null;

  // «soundcloud_123», «soundcloud-123»; у id допускаем и нечисловой остаток,
  // у пути — только номер: иначе «soundcloud_mix.mp3» станет сервисным треком
  const separated = /^([a-z]+)[-_\s]+(.+)$/i.exec(name);
  if (separated) {
    const service = serviceByName(separated[1]);
    const rest = separated[2].trim();
    const looksLikeId = !isPath || /^\d+$/.test(rest);
    if (service && rest && looksLikeId) return `${service.id}:${rest}`;
  }

  // «soundcloud123» — без разделителя
  const glued = /^([a-z]+)(\d+)$/i.exec(name);
  if (glued) {
    const service = serviceByName(glued[1]);
    if (service) return `${service.id}:${glued[2]}`;
  }

  // Последняя попытка: точки и прочие разделители, которые срезает offlineKey
  const squeezed = offlineKey(name);
  for (const service of SERVICES) {
    if (!squeezed.startsWith(service.id)) continue;
    const rest = squeezed.slice(service.id.length);
    if (/^\d+$/.test(rest)) return `${service.id}:${rest}`;
  }
  return null;
}

/** Что-то, что описывает трек: id, путь и признак источника. */
export interface FavoriteKeySource {
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
 * Ключ лайка для любого представления трека: карточки плеера, записи офлайна,
 * строки библиотеки или просто идентификатора. Только этой функцией и должны
 * пользоваться все списки — дублировать правила больше негде.
 */
export function favoriteKeyFor(value: string | FavoriteKeySource): string {
  if (typeof value === "string") return canonicalServiceId(value) ?? value;

  // Порядок важен: у записи офлайна исходный id точнее имени файла копии
  for (const candidate of [value.trackId, value.id, value.path]) {
    if (typeof candidate !== "string" || !candidate) continue;
    const canonical = canonicalServiceId(candidate);
    if (canonical) return canonical;
  }
  return value.path || value.id || value.trackId || "";
}

/** Сервисный ли это ключ лайка (а значит, и трек из сервиса). */
export function isServiceFavoriteKey(key: string): boolean {
  return serviceFromTrackId(key) !== null;
}
