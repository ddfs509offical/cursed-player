import { useEffect } from "react";
import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";
import { errorText, logError } from "./errorStore";
import {
  WALLPAPER_MEDIA_REF,
  clearWallpaperMedia,
  prepareWallpaperBlob,
  readWallpaperMedia,
  writeWallpaperMedia,
} from "../lib/wallpaperMedia";

/**
 * Обои: байты лежат в базе медиа (см. `lib/wallpaperMedia`), здесь — только
 * ссылка на них для отрисовки. `url` — blob-URL живой картинки: в фоне
 * оболочки и в полноэкранном плеере используется один и тот же адрес.
 */
interface WallpaperState {
  url: string | null;
  /** Анимированная гифка: показываем бейдж и предупреждаем про кадры. */
  animated: boolean;
  ready: boolean;
  busy: boolean;
  error: string | null;
  init: () => Promise<void>;
  setFromFile: (file: File) => Promise<void>;
  remove: () => Promise<void>;
}

/** Инициализация одна на всё приложение: два компонента зовут, читаем один раз. */
let started = false;

function release(url: string | null) {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

export const useWallpaperStore = create<WallpaperState>((set, get) => ({
  url: null,
  animated: false,
  ready: false,
  busy: false,
  error: null,

  init: async () => {
    if (started) return;
    started = true;
    try {
      const blob = await readWallpaperMedia();
      if (blob) {
        set({ url: URL.createObjectURL(blob), animated: blob.type === "image/gif" });
      } else {
        // Старый формат: картинка лежала data-URL прямо в настройках.
        // Переносим её в базу медиа, чтобы освободить localStorage.
        const legacy = useSettingsStore.getState().playerWallpaper;
        if (legacy && legacy.startsWith("data:")) {
          try {
            const migrated = await (await fetch(legacy)).blob();
            await writeWallpaperMedia(migrated);
            useSettingsStore.getState().setPlayerWallpaper(WALLPAPER_MEDIA_REF);
            set({ url: legacy, animated: migrated.type === "image/gif" });
          } catch {
            set({ url: legacy });
          }
        }
      }
    } catch (e) {
      logError(
        "Обои не загрузились",
        "Сохранённые обои прочитать не удалось — фон остался штатным.",
        "настройки",
        errorText(e)
      );
    } finally {
      set({ ready: true });
    }
  },

  setFromFile: async (file) => {
    set({ busy: true, error: null });
    try {
      const blob = await prepareWallpaperBlob(file);
      await writeWallpaperMedia(blob);
      const next = URL.createObjectURL(blob);
      release(get().url);
      set({ url: next, animated: blob.type === "image/gif" });
      useSettingsStore.getState().setPlayerWallpaper(WALLPAPER_MEDIA_REF);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Не получилось поставить обои" });
    } finally {
      set({ busy: false });
    }
  },

  remove: async () => {
    try {
      await clearWallpaperMedia();
    } catch {
      // Базы нет или она закрыта — обои всё равно убираем из настроек
    }
    release(get().url);
    set({ url: null, animated: false, error: null });
    useSettingsStore.getState().setPlayerWallpaper(null);
  },
}));

/**
 * Источник обоев для отрисовки. Возвращает blob-URL из базы медиа, а для
 * старых записей — data-URL из настроек. Инициализацию запускает первый
 * вызвавший компонент.
 */
export function useWallpaperSource(): string | null {
  const ref = useSettingsStore((s) => s.playerWallpaper);
  const url = useWallpaperStore((s) => s.url);

  useEffect(() => {
    void useWallpaperStore.getState().init();
  }, []);

  if (!ref) return null;
  if (ref.startsWith("data:")) return ref;
  return url;
}
