import { useId, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useSettingsStore } from "../store/settingsStore";

/** Предел хранения: больше — уже перебор для localStorage настроек. */
const MAX_W = 1920;
const MAX_H = 1200;
/** JPEG 0.85: фото на 1920 px весит ~250–400 КБ — нормально для настроек. */
const QUALITY = 0.85;

/**
 * Уменьшает выбранную картинку и возвращает data-URL.
 * Хранить оригинал нельзя: 4K-фото в base64 раздувает настройки до десятков
 * мегабайт и роняет запись в localStorage.
 */
async function toDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      element.src = url;
    });
    const scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Нет 2D-контекста");
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Обои полноэкранного плеера: выбор картинки, затемнение и сброс.
 * Хранится в настройках (data-URL), переживает перезапуск и не уезжает в
 * облако — см. `playerWallpaper` в settingsStore.
 */
export default function PlayerWallpaper() {
  const wallpaper = useSettingsStore((s) => s.playerWallpaper);
  const dim = useSettingsStore((s) => s.playerWallpaperDim);
  const setWallpaper = useSettingsStore((s) => s.setPlayerWallpaper);
  const setDim = useSettingsStore((s) => s.setPlayerWallpaperDim);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sliderId = useId();

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await toDataUrl(file);
      setWallpaper(dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не получилось загрузить картинку");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-pressed={open}
        aria-label="Обои плеера"
        title="Обои плеера"
        className={`shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[12px] whitespace-nowrap transition-colors ${
          wallpaper
            ? "border-accent/40 bg-accent/15 text-accentText"
            : "border-transparent text-faint hover:text-ink hover:bg-ink/[0.06]"
        }`}
      >
        <ImagePlus size={13} />
        <span className="hidden min-[960px]:inline">Обои</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[272px] rounded-xl border border-line/[0.1] bg-surface p-3 shadow-lift">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold">Обои плеера</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11px] text-faint hover:text-ink transition-colors"
            >
              Скрыть
            </button>
          </div>

          {wallpaper ? (
            <div
              className="h-[104px] w-full rounded-lg bg-cover bg-center border border-line/[0.08]"
              style={{
                backgroundImage: `linear-gradient(rgb(0 0 0 / ${dim}), rgb(0 0 0 / ${dim})), url(${wallpaper})`,
              }}
            />
          ) : (
            <div className="h-[104px] w-full rounded-lg border border-dashed border-line/[0.16] flex items-center justify-center text-[11px] text-faint">
              Обоев нет — фон штатный
            </div>
          )}

          <label htmlFor={sliderId} className="mt-3 mb-1 flex items-center justify-between text-[11px] text-muted">
            <span>Затемнение</span>
            <span className="tnum">{Math.round(dim * 100)}%</span>
          </label>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={0.85}
            step={0.05}
            value={dim}
            onChange={(e) => setDim(Number(e.target.value))}
            className="w-full accent-[rgb(var(--color-accent))]"
          />

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="flex-1 h-8 rounded-lg bg-ink/[0.07] hover:bg-ink/[0.12] text-[12px] font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              {wallpaper ? "Заменить" : "Выбрать фото"}
            </button>
            {wallpaper && (
              <button
                type="button"
                onClick={() => setWallpaper(null)}
                aria-label="Убрать обои"
                title="Убрать обои"
                className="w-8 h-8 rounded-lg bg-ink/[0.07] hover:bg-ink/[0.12] flex items-center justify-center text-muted hover:text-ink transition-colors"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>

          {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}

          <p className="mt-2 text-[10px] leading-snug text-faint">
            Картинка сжимается до 1920 px и хранится локально, в облако не уезжает.
          </p>

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </div>
      )}
    </div>
  );
}
