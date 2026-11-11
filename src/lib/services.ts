/**
 * Реестр музыкальных сервисов: одно место, где описаны id, названия и ключи
 * токенов, а также то, поддерживается ли сервис.
 *
 * `supported` — сервис доступен в поиске и воспроизведении.
 * Сервисы без поддержки остаются в настройках с объяснением причины.
 */

export type ServiceId = "spotify" | "soundcloud" | "yandex" | "vk";

export interface ServiceInfo {
  id: ServiceId;
  name: string;
  /** Короткая подпись для кнопок. */
  short: string;
  /** Ключ, под которым токен лежит в localStorage (см. lib/tokens.ts). */
  tokenKey: string;
  /** Может ли сервис искать треки. */
  searchable: boolean;
  /** Доступен ли сервис в выборе поиска. */
  supported: boolean;
  /** Подсказка, если сервис недоступен. */
  note?: string;
}

export const SERVICES: ServiceInfo[] = [
  {
    id: "soundcloud",
    name: "SoundCloud",
    short: "SoundCloud",
    tokenKey: "SoundCloud",
    searchable: true,
    supported: true,
  },
  {
    id: "spotify",
    name: "Spotify",
    short: "Spotify",
    tokenKey: "Spotify",
    searchable: true,
    supported: false,
    note: "Воспроизведение возможно только с Premium и их SDK",
  },
  {
    id: "yandex",
    name: "Яндекс Музыка",
    short: "Яндекс",
    tokenKey: "Яндекс Музыка",
    searchable: false,
    supported: false,
    note: "Публичного API нет, а полное аудио сервис отдаёт только своим приложениям",
  },
  {
    id: "vk",
    name: "VK Музыка",
    short: "VK",
    tokenKey: "VK Музыка",
    searchable: false,
    supported: false,
    note: "VK с 2021 не отдаёт музыку через API",
  },
];

/** Сервисы, доступные в выборе поиска. */
export const SEARCH_SERVICES = SERVICES.filter((service) => service.supported);

export function serviceInfo(id: ServiceId): ServiceInfo {
  return SERVICES.find((service) => service.id === id) ?? SEARCH_SERVICES[0];
}

/** Из идентификатора трека вида «soundcloud:123» достаём сервис. */
export function serviceFromTrackId(id: string): ServiceId | null {
  const prefix = id.split(":")[0];
  return SERVICES.some((service) => service.id === prefix) ? (prefix as ServiceId) : null;
}

export function isServiceId(value: unknown): value is ServiceId {
  return value === "spotify" || value === "soundcloud" || value === "yandex" || value === "vk";
}
