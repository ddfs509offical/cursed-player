import { useRef } from "react";
import { Film, ImagePlus, Layers, Loader2, Trash2 } from "lucide-react";
import { GhostButton, SettingNote, SettingPanel, SettingRow } from "./Modal";
import { useSettingsStore } from "../store/settingsStore";
import { useWallpaperSource, useWallpaperStore } from "../store/wallpaperStore";
// Фото по умолчанию: та же картинка, что раньше открывалась в плеере.
import defaultBackdrop from "../assets/player-backdrop.jpg";
/**
 * Обои в настройках (раздел «Интерфейс → Вид»).
 * Раньше кнопка жила в полноэкранном плеере — там её искали и не находили.
 * Теперь это обычная карточка настроек: превью с настоящим затемнением,
 * выбор/замена одним кликом, гифка сохраняется вместе с анимацией.
 */
export default function WallpaperSetting() {
  const source = useWallpaperSource();
  const animated = useWallpaperStore((s) => s.animated);
  const busy = useWallpaperStore((s) => s.busy);
  const error = useWallpaperStore((s) => s.error);
  const setFromFile = useWallpaperStore((s) => s.setFromFile);
  const remove = useWallpaperStore((s) => s.remove);

  const panelAlpha = useSettingsStore((s) => s.panelAlpha);
  const windowAlpha = useSettingsStore((s) => s.windowAlpha);
  const setPanelAlpha = useSettingsStore((s) => s.setPanelAlpha);
  const setWindowAlpha = useSettingsStore((s) => s.setWindowAlpha);
  const dim = useSettingsStore((s) => s.playerWallpaperDim);
  const setDim = useSettingsStore((s) => s.setPlayerWallpaperDim);

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <SettingPanel title="Обои" hint="Фон всего приложения и полноэкранного плеера">
      <SettingRow
        icon={ImagePlus}
        title={source ? "Текущие обои" : "Обои по умолчанию"}
        hint={
          source
            ? animated
              ? "Анимированная гифка: живёт в базе медиа на этом устройстве и в облако не уезжает"
              : "Картинка сжата до 1920 px и хранится локально — в облако не уезжает"
            : "Стоит фото по умолчанию — то же, что было в плеере раньше. Можно поставить своё фото или гифку"
        }
        stacked
        control={
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => inputRef.current?.click()} disabled={busy}>
              {busy ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" /> Готовлю…
                </span>
              ) : source ? (
                "Заменить"
              ) : (
                "Выбрать файл"
              )}
            </GhostButton>
            {source && (
              <button
                type="button"
                onClick={() => void remove()}
                aria-label="Убрать обои"
                title="Убрать обои"
                className="w-9 h-9 ui-control bg-inset border border-line/[0.07] flex items-center justify-center text-muted hover:text-ink hover:border-line/20 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        }
      >
        {/* Превью в пропорциях окна: видно и картинку, и реальное затемнение.
            Гифка здесь тоже анимируется — это и есть проверка «как будет». */}
        <div
          className="relative w-full h-40 ui-tile border border-line/[0.09] overflow-hidden bg-inset bg-cover bg-center"
          style={{ backgroundImage: `url(${source ?? defaultBackdrop})` }}
        >
          {source ? (
            <span className="absolute inset-0" style={{ background: `rgb(var(--color-app) / ${dim})` }} />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-[12px] text-faint">
              Обоев нет — стоит фото по умолчанию, как раньше
            </span>
          )}
          {animated && (
            <span className="absolute left-2.5 top-2.5 flex items-center gap-1 h-6 px-2 rounded-full bg-app/80 border border-line/[0.10] text-[11px] text-ink">
              <Film size={11} /> GIF
            </span>
          )}
        </div>

        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void setFromFile(file);
            event.target.value = "";
          }}
        />
      </SettingRow>

      <SettingRow
        icon={Film}
        title="Затемнение"
        hint={`${Math.round(dim * 100)}%: обложка и текст должны читаться на любом фоне`}
        control={
          <div className="flex items-center gap-2 w-44">
            <input
              type="range"
              min={0}
              max={0.85}
              step={0.05}
              value={dim}
              disabled={!source}
              onChange={(event) => setDim(Number(event.target.value))}
              aria-label="Затемнение обоев"
              className="flex-1 min-w-0 cursor-pointer accent-[rgb(var(--color-accent))] disabled:opacity-40"
            />
            <span className="w-9 text-[12px] text-muted text-right tnum">{Math.round(dim * 100)}%</span>
          </div>
        }
      />

      {/* Прозрачность: панели отдельно от окна. 100% — как было всегда. */}
      <SettingRow
        icon={Layers}
        title="Прозрачность панелей"
        hint={`${Math.round(panelAlpha * 100)}%: через карточки и меню видно обои`}
        control={
          <div className="flex items-center gap-2 w-44">
            <input
              type="range"
              min={0.3}
              max={1}
              step={0.05}
              value={panelAlpha}
              onChange={(event) => setPanelAlpha(Number(event.target.value))}
              aria-label="Прозрачность панелей"
              className="flex-1 min-w-0 cursor-pointer accent-[rgb(var(--color-accent))]"
            />
            <span className="w-9 text-[12px] text-muted text-right tnum">
              {Math.round(panelAlpha * 100)}%
            </span>
          </div>
        }
      />

      <SettingRow
        icon={Layers}
        title="Прозрачность окна"
        hint={`${Math.round(windowAlpha * 100)}%: окно пропускает рабочий стол`}
        control={
          <div className="flex items-center gap-2 w-44">
            <input
              type="range"
              min={0.35}
              max={1}
              step={0.05}
              value={windowAlpha}
              onChange={(event) => setWindowAlpha(Number(event.target.value))}
              aria-label="Прозрачность окна"
              className="flex-1 min-w-0 cursor-pointer accent-[rgb(var(--color-accent))]"
            />
            <span className="w-9 text-[12px] text-muted text-right tnum">
              {Math.round(windowAlpha * 100)}%
            </span>
          </div>
        }
      />
      <SettingNote>
        Фото уменьшается до 1920×1200 и сжимается в JPEG, гифка ставится как есть — вместе
        с анимацией, до 16 МБ. Обе хранятся в базе медиа на этом устройстве и в облачную
        синхронизацию не попадают. Замена — той же кнопкой «Заменить».
      </SettingNote>
    </SettingPanel>
  );
}
