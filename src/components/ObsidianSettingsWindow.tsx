/**
 * Окно настроек «Обсидиан».
 *
 * Настройки открываются поверх приложения, а не уводят в отдельный раздел:
 * так видно, что меняется, — включил прозрачность, посмотрел на панели рядом,
 * закрыл. Рамка окна здесь не декоративная: у неё своя тень и свой слой, она
 * явно читается как диалог над музыкой, а не как ещё один экран.
 *
 * Внутри — два столбца: список разделов и содержимое выбранного. На узком
 * окне список превращается в строку вкладок сверху.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";

export interface SettingsTab {
  id: string;
  label: string;
  /** Короткая подпись раздела: что тут настраивается. */
  hint?: string;
  content: ReactNode;
}

interface Props {
  open: boolean;
  onClose: () => void;
  tabs: SettingsTab[];
  /** Раздел, который нужно открыть сразу (например «Ошибки»). */
  requested?: string | null;
}

export default function ObsidianSettingsWindow({ open, onClose, tabs, requested }: Props) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");

  // Запрос внешнего раздела: открываем именно его.
  useEffect(() => {
    if (!open) return;
    if (requested && tabs.some((tab) => tab.id === requested)) setActive(requested);
  }, [open, requested, tabs]);

  // Esc закрывает окно: привычка из любого диалога.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const current = useMemo(() => tabs.find((tab) => tab.id === active) ?? tabs[0], [tabs, active]);

  if (!open) return null;

  return (
    <div className="obs-window-layer" role="dialog" aria-modal="true" aria-label="Настройки">
      {/* Затемнение: приложение видно, но не мешает. */}
      <button className="obs-window-scrim" onClick={onClose} aria-label="Закрыть настройки" tabIndex={-1} />

      <div className="obs-window">
        <header className="obs-window__bar">
          <button className="obs-icon" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть настройки">
            <X size={16} />
          </button>
          <span className="obs-window__title">Настройки</span>
          <span className="obs-window__spacer" />
          <button className="obs-btn obs-press" onClick={onClose}>
            <ArrowLeft size={14} /> Вернуться
          </button>
        </header>

        <div className="obs-window__body">
          <nav className="obs-window__tabs" aria-label="Разделы настроек">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className="obs-window__tab"
                data-active={tab.id === active}
                onClick={() => setActive(tab.id)}
              >
                <span>{tab.label}</span>
                {tab.hint && <span className="obs-window__hint">{tab.hint}</span>}
              </button>
            ))}
          </nav>

          {/* Перерисовка содержимого с анимацией смены: раздел «проявляется». */}
          <div className="obs-window__content obs-swap" key={active}>
            {current?.content}
          </div>
        </div>
      </div>
    </div>
  );
}
