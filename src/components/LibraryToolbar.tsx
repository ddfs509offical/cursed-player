import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  Disc3,
  LayoutList,
  Search,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { LibraryGroup, LibrarySortDir, LibrarySortKey } from "../store/settingsStore";

/**
 * Панель инструментов «Моей музыки»: поиск внутри списка, сортировка и
 * группировка. Показывается только на длинных списках (см. `MIN_TOOLBAR_ROWS`
 * в странице): на трёх треках она заслоняла бы сами треки.
 *
 * Здесь же лежит единственная функция нормализации запроса — страница берёт
 * её, чтобы фильтр и подсветка считали «Ёлка» и «елка» одним словом.
 */

/** Сортировка: в данных нет счётчика прослушиваний, поэтому популярности нет. */
export const SORT_OPTIONS: { id: LibrarySortKey; label: string }[] = [
  { id: "title", label: "По названию" },
  { id: "artist", label: "По исполнителю" },
  { id: "duration", label: "По длительности" },
  { id: "added", label: "По дате добавления" },
];

/** Группировка строк: плоский список или секции с липкими заголовками. */
export const GROUP_OPTIONS: { id: LibraryGroup; label: string; Icon: LucideIcon }[] = [
  { id: "list", label: "Списком", Icon: LayoutList },
  { id: "artist", label: "По исполнителям", Icon: Users },
  { id: "album", label: "По альбомам", Icon: Disc3 },
];

/**
 * Нормализация строки для поиска: нижний регистр, ё→е и схлопнутые пробелы.
 * Без неё «Ёлка» не находилась бы по «елка», а лишний пробел ломал бы запрос.
 */
export function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/** Запрос, разбитый на слова: каждое должно найтись в строке трека. */
export function searchTokens(query: string): string[] {
  const normalized = normalizeSearch(query);
  return normalized ? normalized.split(" ") : [];
}

/** Вид выпадающего меню панели: сорт, группа или ничего. */
type Menu = "sort" | "group" | null;

interface Props {
  /** Сколько треков на вкладке всего и сколько осталось после поиска. */
  total: number;
  shown: number;
  /** Готовая подпись счётчика: «55 треков» или «12 из 55». */
  countLabel: string;

  query: string;
  onQueryChange: (value: string) => void;
  onClearQuery: () => void;

  sort: LibrarySortKey;
  onSort: (value: LibrarySortKey) => void;
  dir: LibrarySortDir;
  onDir: (value: LibrarySortDir) => void;

  group: LibraryGroup;
  onGroup: (value: LibraryGroup) => void;
}

/** Общая кнопка панели: плоская поверхность, без заливки. */
const BUTTON =
  "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line/[0.10] bg-ink/[0.03] text-[12px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors";

export default function LibraryToolbar({
  total,
  shown,
  countLabel,
  query,
  onQueryChange,
  onClearQuery,
  sort,
  onSort,
  dir,
  onDir,
  group,
  onGroup,
}: Props) {
  const [menu, setMenu] = useState<Menu>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  const sortLabel = SORT_OPTIONS.find((option) => option.id === sort)?.label ?? "По названию";
  const groupLabel = GROUP_OPTIONS.find((option) => option.id === group)?.label ?? "Списком";
  const filtered = shown !== total;

  // Ctrl+F / ⌘F ставит курсор в поиск, Esc очищает запрос — привычные клавиши
  // списка. Esc не мешает окнам: у них свой обработчик на своей же клавише.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.key === "Escape" && query) {
        // Открытое окно закрывает свой Esc: не сбрасываем поиск под ним
        if (document.querySelector('[role="dialog"]')) return;
        onClearQuery();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [query, onClearQuery]);

  // Меню закрываются кликом вне и Esc: как у «＋ в плейлист» в строках
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sortRef.current?.contains(target) || groupRef.current?.contains(target)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div className="flex items-center gap-2 flex-wrap px-2.5 py-2 rounded-xl border border-line/[0.07] bg-surface mb-3">
      {/* Поиск: иконка слева, крестик справа, очистка одним кликом */}
      <div className="relative flex-1 min-w-[180px]">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Поиск по названию или исполнителю"
          aria-label="Поиск по библиотеке"
          className="w-full h-8 pl-8 pr-8 rounded-lg bg-inset border border-line/[0.10] text-[12px] outline-none focus:border-accent/40 transition-colors"
        />
        {query && (
          <button
            onClick={onClearQuery}
            aria-label="Очистить поиск"
            title="Очистить поиск (Esc)"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Сортировка: вариант и направление — два независимых органа */}
      <div ref={sortRef} className="relative inline-flex items-center gap-1">
        <button
          onClick={() => setMenu((current) => (current === "sort" ? null : "sort"))}
          aria-expanded={menu === "sort"}
          title="Сортировка"
          className={BUTTON}
        >
          {sortLabel}
          <ChevronDown
            size={13}
            className={`text-faint transition-transform duration-200 ${menu === "sort" ? "rotate-180" : ""}`}
          />
        </button>
        <button
          onClick={() => onDir(dir === "asc" ? "desc" : "asc")}
          aria-label={dir === "asc" ? "По возрастанию" : "По убыванию"}
          title={dir === "asc" ? "По возрастанию" : "По убыванию"}
          className={BUTTON}
        >
          <ArrowUpDown
            size={13}
            className={`transition-transform duration-200 ${dir === "asc" ? "" : "rotate-180"}`}
          />
          <span className="hidden lg:inline">{dir === "asc" ? "по возрастанию" : "по убыванию"}</span>
        </button>

        <AnimatePresence>
          {menu === "sort" && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0, 0, 0.2, 1] }}
              style={{ transformOrigin: "top left" }}
              className="glass-float absolute left-0 top-full mt-1 z-40 w-48 p-1 rounded-xl bg-surface3/85 backdrop-blur-[16px] border border-line/10"
            >
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  role="menuitem"
                  onClick={() => {
                    onSort(option.id);
                    setMenu(null);
                  }}
                  className="w-full flex items-center gap-2 h-8 px-2 rounded-lg text-[12px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors"
                >
                  <span className="w-4 flex justify-center shrink-0">
                    {sort === option.id && (
                      <Check size={13} className="text-accentText" strokeWidth={2.2} />
                    )}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-left">{option.label}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Группировка: тот же список, но секциями с липкими заголовками */}
      <div ref={groupRef} className="relative">
        <button
          onClick={() => setMenu((current) => (current === "group" ? null : "group"))}
          aria-expanded={menu === "group"}
          title="Группировка"
          className={BUTTON}
        >
          {groupLabel}
          <ChevronDown
            size={13}
            className={`text-faint transition-transform duration-200 ${menu === "group" ? "rotate-180" : ""}`}
          />
        </button>

        <AnimatePresence>
          {menu === "group" && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0, 0, 0.2, 1] }}
              style={{ transformOrigin: "top left" }}
              className="glass-float absolute right-0 top-full mt-1 z-40 w-52 p-1 rounded-xl bg-surface3/85 backdrop-blur-[16px] border border-line/10"
            >
              {GROUP_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  role="menuitem"
                  onClick={() => {
                    onGroup(option.id);
                    setMenu(null);
                  }}
                  className="w-full flex items-center gap-2 h-8 px-2 rounded-lg text-[12px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors"
                >
                  <span className="w-4 flex justify-center shrink-0">
                    {group === option.id ? (
                      <Check size={13} className="text-accentText" strokeWidth={2.2} />
                    ) : (
                      <option.Icon size={13} className="text-faint" strokeWidth={1.9} />
                    )}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-left">{option.label}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Счётчик: с активным поиском видно, сколько осталось из всего списка */}
      <span className={`text-[12px] tnum ml-auto ${filtered ? "text-accentText" : "text-faint"}`}>
        {countLabel}
      </span>
    </div>
  );
}
