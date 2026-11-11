/**
 * Название и версия приложения — в одном месте, чтобы не расползались
 * по интерфейсу, конфигу Tauri и README.
 */
export const APP_NAME = "Cursed player";
export const APP_VERSION = "beta test v1";
/**
 * Номер сборки: целое, растёт с каждым релизом. По нему приложение сравнивает
 * себя с `latest.json` из бакета `updates` и решает, показывать ли обновление.
 * Руками не трогать — его поднимает `npm run release`.
 */
export const APP_BUILD = 73;
export const APP_TAGLINE = "Локальный музыкальный плеер";

/** Сколько держится заставка после входа или создания профиля. */
export const SPLASH_DURATION_MS = 3200;
