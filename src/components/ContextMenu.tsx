import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ClipboardCopy, ClipboardPaste, RotateCw, Scissors, Settings } from "lucide-react";

/**
 * Своё меню по правой кнопке.
 *
 * Почему своё: WebView2 показывает на правый клик меню браузера — «Назад»,
 * «Обновить», «Сохранить как», «Печать», «Другие инструменты». В приложении
 * это выглядит как чужой интерфейс и половина пунктов ничего не делает.
 * Поэтому штатное меню глушим глобально, а рисуем своё — только те действия,
 * которые в плеере действительно есть.
 *
 * Пункты зависят от того, куда нажали: в поле ввода появляются «Вырезать» и
 * «Вставить», при выделенном тексте — «Копировать».
 */
interface Props {
  /** Открыть настройки: пункт меню должен вести туда же, куда кнопка в шапке. */
  onOpenSettings: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: Item[];
}

interface Item {
  id: string;
  label: string;
  Icon: typeof RotateCw;
  run: () => void;
  disabled?: boolean;
}

/** Что можно сделать с полем ввода: нужен доступ к самому элементу. */
type Editable = HTMLInputElement | HTMLTextAreaElement;

function editableFrom(target: EventTarget | null): Editable | null {
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return null;
  if (target instanceof HTMLInputElement && !["text", "search", "url", "email", "password"].includes(target.type)) {
    return null;
  }
  if (target.disabled || target.readOnly) return null;
  return target;
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Буфер может быть занят другим приложением — молча ничего не делаем
  }
}

async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

export default function ContextMenu({ onOpenSettings }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setMenu(null), []);

  /**
   * Собираем пункты под конкретное место нажатия. Меню маленькое и всегда
   * открывается рядом с курсором; за край экрана не выезжает — координаты
   * прижимаются к окну после отрисовки.
   */
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      // Своё меню вместо штатного: без этого WebView2 покажет меню браузера.
      event.preventDefault();

      const editable = editableFrom(event.target);
      const selection = window.getSelection();
      const selectedText = selection && selection.toString().trim() ? selection.toString() : "";
      const items: Item[] = [];

      if (editable) {
        items.push(
          {
            id: "cut",
            label: "Вырезать",
            Icon: Scissors,
            disabled: editable.selectionStart === editable.selectionEnd,
            run: () => {
              const start = editable.selectionStart ?? 0;
              const end = editable.selectionEnd ?? 0;
              if (start === end) return;
              void writeClipboard(editable.value.slice(start, end));
              editable.setRangeText("", start, end, "end");
              editable.dispatchEvent(new Event("input", { bubbles: true }));
            },
          },
          {
            id: "copy",
            label: "Копировать",
            Icon: ClipboardCopy,
            disabled: editable.selectionStart === editable.selectionEnd,
            run: () => {
              const start = editable.selectionStart ?? 0;
              const end = editable.selectionEnd ?? 0;
              void writeClipboard(editable.value.slice(start, end));
            },
          },
          {
            id: "paste",
            label: "Вставить",
            Icon: ClipboardPaste,
            run: () => {
              void readClipboard().then((text) => {
                if (!text) return;
                const start = editable.selectionStart ?? editable.value.length;
                const end = editable.selectionEnd ?? start;
                editable.setRangeText(text, start, end, "end");
                editable.dispatchEvent(new Event("input", { bubbles: true }));
                editable.focus();
              });
            },
          }
        );
      } else if (selectedText) {
        items.push({
          id: "copy-text",
          label: "Копировать",
          Icon: ClipboardCopy,
          run: () => void writeClipboard(selectedText),
        });
      }

      items.push(
        { id: "reload", label: "Обновить", Icon: RotateCw, run: () => window.location.reload() },
        { id: "settings", label: "Настройки", Icon: Settings, run: onOpenSettings }
      );

      setMenu({ x: event.clientX, y: event.clientY, items });
    };

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [onOpenSettings]);

  // Закрытие: клик мимо, Esc, прокрутка и изменение размера окна.
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, close]);

  // Держим меню внутри окна: у правого и нижнего края оно разворачивается внутрь.
  useEffect(() => {
    const node = menuRef.current;
    if (!menu || !node) return;
    const rect = node.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    if (menu.x > maxX || menu.y > maxY) {
      setMenu({ ...menu, x: Math.min(menu.x, Math.max(8, maxX)), y: Math.min(menu.y, Math.max(8, maxY)) });
    }
  }, [menu]);

  if (!menu) return null;

  return (
    <motion.div
      ref={menuRef}
      role="menu"
      aria-label="Действия"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
      style={{ left: menu.x, top: menu.y, transformOrigin: "top left" }}
      className="fixed z-[80] w-52 rounded-xl border border-line/[0.09] bg-surface2/95 p-1 backdrop-blur-[14px] shadow-lift"
    >
      {menu.items.map((item, index) => {
        const previous = menu.items[index - 1];
        // Группы разделяем волосяной линией: действия с текстом и действия с окном.
        const divider = previous && (previous.id === "paste" || previous.id === "copy-text") && item.id !== "copy-text";
        return (
          <div key={item.id}>
            {divider && <div className="my-1 h-px bg-line/[0.07]" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.run();
                close();
              }}
              className="w-full flex items-center gap-2 h-8 px-2 rounded-lg text-[12px] text-ink/90 hover:bg-ink/[0.07] hover:text-ink transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <item.Icon size={13} strokeWidth={1.9} className="text-faint" />
              <span className="flex-1 min-w-0 text-left truncate">{item.label}</span>
            </button>
          </div>
        );
      })}
    </motion.div>
  );
}
