/**
 * Обои приложения: подготовка картинки и хранение в IndexedDB.
 *
 * Почему не в настройках: настройки лежат одной строкой в localStorage
 * (5–10 МБ на всё приложение). Анимированная гифка весит мегабайты, и одна
 * такая картинка выбивала квоту — тогда падала запись ВСЕХ настроек сразу.
 * Поэтому байты обоев живут в IndexedDB, а в настройках остаётся короткая
 * ссылка WALLPAPER_MEDIA_REF.
 */

const DB_NAME = "music_hub_media";
const DB_VERSION = 1;
const STORE = "wallpapers";
const KEY = "app-wallpaper";

/** Значение `playerWallpaper` в настройках: обои лежат в базе медиа. */
export const WALLPAPER_MEDIA_REF = "media:wallpaper";

/** Предел для гифки: больше — уже не обои, а тормоза при каждой отрисовке. */
export const GIF_MAX_BYTES = 16 * 1024 * 1024;

/** Статичные картинки сжимаются: 1920×1200 и JPEG 0.85 — как было раньше. */
const MAX_W = 1920;
const MAX_H = 1200;
const QUALITY = 0.85;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB недоступна"));
  });
}

/** Прочитать сохранённые обои. null — обоев нет. */
export async function readWallpaperMedia(): Promise<Blob | null> {
  const db = await openDb();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error("Не удалось прочитать обои"));
    });
  } finally {
    db.close();
  }
}

export async function writeWallpaperMedia(blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Не удалось сохранить обои"));
    });
  } finally {
    db.close();
  }
}

export async function clearWallpaperMedia(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Не удалось убрать обои"));
    });
  } finally {
    db.close();
  }
}

function isGif(file: File): boolean {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Не удалось прочитать изображение"));
    image.src = src;
  });
}

/**
 * Готовит файл к хранению.
 *
 * Гифка сохраняется как есть — вместе с анимацией; canvas её не переживёт.
 * Остальные картинки уменьшаются до 1920×1200 и сжимаются в JPEG: так обои
 * занимают сотни килобайт вместо десятков мегабайт.
 */
export async function prepareWallpaperBlob(file: File): Promise<Blob> {
  const looksLikeImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|avif|gif|bmp)$/i.test(file.name);
  if (!looksLikeImage) throw new Error("Нужна картинка или анимированная гифка");

  if (isGif(file)) {
    if (file.size > GIF_MAX_BYTES) {
      throw new Error(
        `Гифка больше ${Math.round(GIF_MAX_BYTES / 1024 / 1024)} МБ — уменьшите её или выберите другую`
      );
    }
    return file;
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, MAX_W / image.naturalWidth, MAX_H / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Нет 2D-контекста");
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((value) => resolve(value), "image/jpeg", QUALITY)
    );
    if (!blob) throw new Error("Не удалось сжать картинку");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
