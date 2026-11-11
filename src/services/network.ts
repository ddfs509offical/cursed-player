/**
 * Сеть: маршрут (прямой / локальный прокси / авто), поиск локального прокси и
 * проверка выбранного маршрута. Вся работа с сетью — в Rust; здесь только
 * тонкая обёртка над командами и понятные подписи для интерфейса.
 *
 * Публичные прокси-листы не поддерживаются: приложение принимает только адрес,
 * который ввёл пользователь, или тот, что нашёлся на 127.0.0.1.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./profiles";
import {
  NETWORK_ROUTE_OPTIONS,
  useSettingsStore,
  type NetworkRoute,
} from "../store/settingsStore";

/** Итог проверки маршрута: ответил ли и за сколько миллисекунд. */
export interface RouteCheck {
  ok: boolean;
  ms: number;
}

/** Подпись маршрута для интерфейса и уведомлений. */
export function routeLabel(route: NetworkRoute): string {
  return NETWORK_ROUTE_OPTIONS.find((option) => option.id === route)?.label ?? route;
}

/**
 * Передать выбранный маршрут в Rust. Вызывается при старте и при изменении
 * настройки: сетевой слой живёт в процессе и не читает localStorage сам.
 */
export async function networkConfigure(
  route: NetworkRoute,
  proxyUrl: string
): Promise<void> {
  if (!isTauri()) return;
  await invoke("network_configure", { route, proxyUrl: proxyUrl.trim() || null });
}

/** Применить текущие настройки из store — без аргументов. */
export async function applyNetworkSettings(): Promise<void> {
  const { networkRoute, proxyUrl } = useSettingsStore.getState();
  await networkConfigure(networkRoute, proxyUrl);
}

/**
 * Найти локальный прокси: приложение проверяет только 127.0.0.1 и коротким
 * таймаутом, наружу не ходит.
 */
export async function detectLocalProxy(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("detect_local_proxy");
}

/**
 * Проверить маршрут живым запросом к SoundCloud. `proxyUrl` можно передать
 * черновиком из поля — сохранять его до проверки не нужно.
 */
export async function testRoute(
  route: NetworkRoute,
  proxyUrl?: string
): Promise<RouteCheck> {
  if (!isTauri()) {
    throw new Error("Проверка маршрута доступна только в приложении");
  }
  return invoke<RouteCheck>("test_route", {
    route,
    proxyUrl: proxyUrl?.trim() || null,
  });
}

/** Сбросить кэш DNS в процессе: после смены маршрута или обхода блокировок. */
export async function clearDnsCache(): Promise<void> {
  if (!isTauri()) return;
  await invoke("clear_dns_cache");
}
