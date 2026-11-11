/**
 * «Обсидиан»: оболочка приложения.
 *
 * Слева — панель навигации, справа — рабочая поверхность, снизу — транспорт.
 * Такое деление знает любой, кто работал со студией звукозаписи или просто
 * с библиотекой: список слева, лист справа, транспорт под рукой. Пользователь
 * просил и «просто слушаю», и «работаю одновременно», а эта раскладка их не
 * разводит: левый столбец узкий и спокойный, правый просторен для обложек и
 * графики, транспорт не прячется.
 *
 * Своего содержимого компонент не рисует: он принимает панели и рабочий
 * экран. Так вся разметка страниц остаётся в `App`, а оболочка — это только
 * материал, рамки и поведение.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Menu } from "lucide-react";

interface Props {
  /** Верхняя полоса окна (кнопки окна и перетаскивание). */
  titlebar: ReactNode;
  /** Панель навигации целиком. */
  nav: ReactNode;
  /** Шапка рабочей поверхности: поиск, профиль, уведомления. */
  header?: ReactNode;
  /** Содержимое раздела. */
  children: ReactNode;
  /** Транспорт внизу: мини-плеер. */
  transport?: ReactNode;
  /** Что рисуется поверх всего: плеер, настройки, меню. */
  overlays?: ReactNode;
}

/**
 * Ширина левой панели запоминается между запусками: на широком мониторе
 * в неё помещаются названия, на узком — она сжимается. Переключатель всегда
 * доступен, потому что для кого-то место дороже понятности.
 */
const RAIL_KEY = "obsidian_rail";
type RailMode = "expanded" | "compact" | "hidden";

export default function AppShell({
  titlebar,
  nav,
  header,
  children,
  transport,
  overlays,
}: Props) {
  const [rail, setRail] = useState<RailMode>(() => {
    try {
      const saved = localStorage.getItem(RAIL_KEY);
      if (saved === "expanded" || saved === "compact" || saved === "hidden") return saved;
    } catch {
      // Приватный режим: настройку не запомним, но работать это не мешает
    }
    return "expanded";
  });

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, rail);
    } catch {
      // см. выше: сохранение необязательно
    }
  }, [rail]);

  /** Какой режим получается следующим при нажатии на переключатель. */
  function cycle() {
    setRail((current) =>
      current === "expanded" ? "compact" : current === "compact" ? "hidden" : "expanded"
    );
  }

  const railWidth = rail === "expanded" ? 224 : rail === "compact" ? 68 : 0;

  return (
    <div className="obs-shell" data-rail={rail}>
      {titlebar}

      <div className="obs-workarea">
        {/* Панель навигации: ширина анимируется, содержимое сжимается
            вместе с ней — иначе подписи «вылезают» за край в узком режиме. */}
        <div
          className="obs-rail-wrap"
          style={{ width: railWidth }}
          aria-hidden={rail === "hidden"}
        >
          {nav}
        </div>

        <div className="obs-main">
          {header ? <div className="obs-header">{header}</div> : null}
          <div className="obs-content" id="obs-content">
            {children}
          </div>
        </div>
      </div>

      {/* Переключатель панели: висит на её правом краю, всегда под рукой. */}
      <button
        onClick={cycle}
        className="obs-rail-toggle"
        style={{ left: rail === "hidden" ? 6 : railWidth - 13 }}
        title={
          rail === "expanded"
            ? "Свернуть панель — останутся иконки"
            : rail === "compact"
              ? "Убрать панель совсем"
              : "Показать панель"
        }
        aria-label="Переключить панель навигации"
      >
        {rail === "expanded" ? (
          <ChevronLeft size={13} strokeWidth={2} />
        ) : rail === "compact" ? (
          <Menu size={13} strokeWidth={2} />
        ) : (
          <ChevronRight size={13} strokeWidth={2} />
        )}
      </button>

      {transport}

      {overlays}
    </div>
  );
}

/** Прокрутка рабочей области вверх: нужна при смене раздела. */
export function scrollContentTop() {
  document.getElementById("obs-content")?.scrollTo({ top: 0 });
}

/** Забираем фокус в рабочую область: клавиатура не должна висеть на панели. */
export function useContentScrollReset(key: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    scrollContentTop();
  }, [key]);
}
