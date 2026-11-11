const TONES = [
  "rgb(var(--color-cover-a))",
  "rgb(var(--color-cover-b))",
  "rgb(var(--color-cover-c))",
  "rgb(var(--color-surface-3))",
];

/**
 * Ровный тон обложки вместо градиента.
 *
 * Градиенты выдавали интерфейс с головой: радужные заливки на аватарах,
 * плитках и плейлистах выглядели как обои из генератора картинок. Теперь
 * подставляется один спокойный тон из палитры темы — обложка остаётся
 * узнаваемой по цвету, но не спорит с настоящими обложками треков.
 *
 * Тона берутся из токенов `--color-cover-*` и `--color-surface-3`: они всегда
 * лежат в средне-тёмном диапазоне, поэтому белый текст поверх читается в любой
 * теме и при любом акценте.
 */
export function themeCover(seed: number): string {
  return TONES[((seed % TONES.length) + TONES.length) % TONES.length];
}

/** Стабильный числовой хеш строки — для детерминированных обложек. */
export function seedFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 100000;
  return hash;
}
