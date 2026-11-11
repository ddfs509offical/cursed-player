import { useEffect, useState } from "react";

/**
 * Страховка для полноэкранных слоёв (модалка, окно артиста, плеер, настройки).
 *
 * Уход слоя рисует framer-motion, а кадры анимации могут не прийти: окно
 * свернули в трей, система загружена, WebView2 не отдаёт кадры. Тогда
 * `exit`-анимация не доигрывает, слой остаётся в DOM невидимым — но клики он
 * всё равно ловит, и приложение выглядит «замершим»: кнопки и меню под ним не
 * нажимаются.
 *
 * Хук делает две вещи:
 *  1) как только слой закрывают, с него сразу снимаются клики (`leaving`);
 *  2) из DOM слой убирает таймер, а не конец анимации — невидимый слой не
 *     может остаться поверх интерфейса ни при каких кадрах.
 *
 * Возвращает, держать ли слой в дереве и находится ли он на уходе.
 */
export function useExitGuard(open: boolean, ms = 260): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(!open);

  useEffect(() => {
    if (open) {
      setLeaving(false);
      setMounted(true);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);

  return { mounted, leaving };
}
