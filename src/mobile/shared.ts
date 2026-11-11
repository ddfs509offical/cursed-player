/**
 * Мобильные вспомогательные функции.
 *
 * Две вещи, которых нет в настольном интерфейсе: проверка «мы на телефоне»
 * и переход по разделам нижней навигацией. Держим отдельно, чтобы не
 * размазывать условия по экранам.
 */
import { useEffect, useState } from "react";

/** Экран узкий настолько, что вёрстка должна быть мобильной. */
export const MOBILE_BREAKPOINT = 900;

/**
 * Смотрим на ширину окна, а не на user-agent: на Android WebView её можно
 * менять поворотом, а в браузере — просто сузить окно. Проверять платформу
 * отдельно не нужно.
 */
export function useIsMobile(): boolean {
  const read = () => typeof window !== "undefined" && window.innerWidth <= MOBILE_BREAKPOINT;
  const [mobile, setMobile] = useState(read);

  useEffect(() => {
    const onResize = () => setMobile(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return mobile;
}

/** Разделы мобильной навигации: те же, что в референсе. */
export type MobileTab = "home" | "library" | "search" | "favorites" | "playlists";

export const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: "home", label: "Главная" },
  { id: "library", label: "Библиотека" },
  { id: "search", label: "Поиск" },
  { id: "favorites", label: "Избранное" },
  { id: "playlists", label: "Плейлисты" },
];

/** Миллисекунды в «2:31» и «1:02:03». */
export function formatTime(ms: number): string {
  if (!ms || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
