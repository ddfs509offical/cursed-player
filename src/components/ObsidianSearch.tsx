/**
 * «Обсидиан», поиск в шапке.
 *
 * Раньше поиск был заперт в отдельном разделе: чтобы что-то включить, надо
 * было уйти с текущего экрана. Здесь поле живёт в шапке и отправляет в
 * раздел поиска — привычка из любого каталога.
 */
import { useEffect, useRef, useState } from "react";
import { Search as SearchIcon } from "lucide-react";

interface Props {
  onSubmit: (value: string) => void;
  /** Скрыть на экране поиска: там своё поле. */
  hidden?: boolean;
}

export default function ObsidianSearch({ onSubmit, hidden }: Props) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // «/» из любого места фокусирует поиск — привычная клавиша в библиотеках.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing || hidden) return;
      if (event.key === "/") {
        event.preventDefault();
        input.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);

  if (hidden) return null;

  return (
    <form
      className="obs-search"
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (!query) return;
        onSubmit(query);
        input.current?.blur();
      }}
    >
      <SearchIcon size={15} strokeWidth={1.9} className="obs-search__icon" />
      <input
        ref={input}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Трек, исполнитель, альбом"
        aria-label="Поиск музыки"
        spellCheck={false}
      />
      <kbd className="obs-search__hint">/</kbd>
    </form>
  );
}
