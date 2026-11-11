import { useSettingsStore } from "../store/settingsStore";
import { useWallpaperSource } from "../store/wallpaperStore";

/**
 * Обои всего приложения: фото (или гифка) под всем интерфейсом и слой
 * затемнения поверх. Живёт в первом кадре оболочки (z-0), поэтому видно и на
 * главной, и в библиотеке, и в настройках. В полноэкранном плеере такой же
 * слой рисуется отдельно — плеер перекрывает оболочку целиком.
 *
 * Сама картинка лежит в базе медиа (`store/wallpaperStore`), поэтому гифка не
 * занимает квоту localStorage и не роняет запись настроек.
 */
export default function AppWallpaper() {
  const wallpaper = useWallpaperSource();
  const dim = useSettingsStore((s) => s.playerWallpaperDim);
  if (!wallpaper) return null;
  return (
    <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${wallpaper})` }}
      />
      <div className="absolute inset-0 bg-app" style={{ opacity: dim }} />
    </div>
  );
}
