import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Minus, Square, Copy, X } from "lucide-react";
import { sounds } from "../lib/sounds";

/**
 * Своя полоса окна: приложение живёт без системной рамки
 * (`decorations: false` в tauri.conf.json), поэтому свернуть, развернуть и
 * закрыть можно только этими кнопками.
 *
 * Перетаскивание и двойной клик:
 * * полоса помечена `data-tauri-drag-region="deep"` — встроенный обработчик
 *   Tauri сам превращает нажатие в перетаскивание окна, а двойной клик — в
 *   разворот/восстановление (право `core:window:allow-internal-toggle-maximize`
 *   входит в `core:default`, поэтому работает и в dev);
 * * дополнительно нажатие зовёт свою команду `window_start_drag`: право
 *   `core:window:allow-start-dragging` в capabilities не выдано, и встроенный
 *   путь одно нажатие теряет. Своя команда не зависит от ACL (см. main.rs).
 *   На втором нажатии двойного клика перетаскивание не начинаем — иначе оно
 *   спорило бы с разворотом.
 *
 * Кнопки лежат в отдельном контейнере: они не часть drag-региона, гасят
 * всплытие и потому не перетаскивают окно.
 */

/** Размер кнопки и иконки: целиться удобно, полоса не выпирает. */
const BUTTON = "w-7 h-7"; // 28 × 28
const ICON = 14;

export default function TitleBar({ onClose }: { onClose?: () => void }) {
  const [maximized, setMaximized] = useState(false);

  /**
   * Состояние разворота: спрашиваем при монтировании и на каждое изменение
   * размера окна — развернули кнопкой, двойным кликом по полосе или из системы
   * (Win+↑), и иконка обязана смениться на «восстановить».
   */
  useEffect(() => {
    let alive = true;
    const sync = () => {
      void invoke<boolean>("window_is_maximized")
        .then((value) => {
          if (alive) setMaximized(value);
        })
        .catch(() => {});
    };
    sync();
    window.addEventListener("resize", sync);
    return () => {
      alive = false;
      window.removeEventListener("resize", sync);
    };
  }, []);

  async function toggleMaximize() {
    sounds.open();
    try {
      setMaximized(await invoke<boolean>("window_toggle_maximize"));
    } catch {
      // окно недоступно — ничего не делаем
    }
  }

  return (
    <div
      data-tauri-drag-region="deep"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button")) return;
        // Второе нажатие двойного клика — это разворот, а не перетаскивание
        if (event.detail > 1) return;
        void invoke("window_start_drag").catch(() => {});
      }}
      onDoubleClick={(event) => {
        // Встроенный обработчик Tauri уже развернул окно по этому же клику:
        // здесь только синхронизируем иконку, второй раз не переключаем.
        if ((event.target as HTMLElement).closest("button")) return;
        void invoke<boolean>("window_is_maximized")
          .then(setMaximized)
          .catch(() => {});
      }}
      className="h-8 flex items-center justify-end select-none bg-app shrink-0 border-b border-line/[0.05] pr-2"
    >
      {/* Кнопки — не drag-регион: контейнер гасит всплытие нажатий */}
      <div
        className="flex items-center gap-1"
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Свернуть"
          title="Свернуть"
          className={`${BUTTON} rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-ink/[0.08] transition-colors`}
          onClick={() => {
            sounds.close();
            void invoke("window_minimize").catch(() => {});
          }}
        >
          <Minus size={ICON} />
        </button>
        <button
          type="button"
          aria-label={maximized ? "Восстановить" : "Развернуть"}
          title={maximized ? "Восстановить" : "Развернуть"}
          className={`${BUTTON} rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-ink/[0.08] transition-colors`}
          onClick={() => void toggleMaximize()}
        >
          {maximized ? <Copy size={ICON - 1} /> : <Square size={ICON - 2} />}
        </button>
        <button
          type="button"
          aria-label="Закрыть"
          title="Закрыть"
          className={`${BUTTON} rounded-lg flex items-center justify-center text-muted hover:text-white hover:bg-red-600 transition-colors`}
          onClick={() => {
            sounds.close();
            if (onClose) onClose();
            else void invoke("window_close").catch(() => {});
          }}
        >
          <X size={ICON} />
        </button>
      </div>
    </div>
  );
}
