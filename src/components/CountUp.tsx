import { useEffect, useState } from "react";

/**
 * Анимированный счётчик (приём из Magic UI / SmoothUI): число набегает
 * от нуля за долю секунды. Без библиотек — только requestAnimationFrame.
 */
export default function CountUp({ value, duration = 700 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (value <= 0) {
      setShown(0);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // easeOutCubic — движение замедляется к концу
      setShown(Math.round(value * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return <>{shown}</>;
}
