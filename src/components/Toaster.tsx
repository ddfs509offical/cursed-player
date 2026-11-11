import { memo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, X, Undo2 } from "lucide-react";
import { useToastStore, type Toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";

// Сообщение живёт недолго: 3.5 секунды, при наведении таймер останавливается
const LIFETIME = 3500;

/**
 * Всплывающие уведомления сверху. Карточка не перерисовывается при наведении
 * (таймер живёт в ref, а не в состоянии) и анимируется только трансформацией —
 * иначе при частых обновлениях плеера появлялись подлагивания.
 */
export default function Toaster() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div className="fixed top-9 left-1/2 -translate-x-1/2 z-[80] flex flex-col items-center gap-2 pointer-events-none px-4">
      <AnimatePresence initial={false}>
        {toasts.map((item) => (
          <ToastCard key={item.id} toast={item} />
        ))}
      </AnimatePresence>
    </div>
  );
}

const ToastCard = memo(function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const timer = useRef<number | null>(null);
  const startedAt = useRef(Date.now());
  const left = useRef(LIFETIME);

  useEffect(() => {
    timer.current = window.setTimeout(() => dismiss(toast.id), left.current);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [dismiss, toast.id]);

  function pause() {
    if (timer.current) window.clearTimeout(timer.current);
    left.current = Math.max(400, left.current - (Date.now() - startedAt.current));
  }

  function resume() {
    startedAt.current = Date.now();
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => dismiss(toast.id), left.current);
  }

  function runAction() {
    sounds.undo();
    try {
      void toast.action?.run();
    } finally {
      dismiss(toast.id);
    }
  }

  return (
    <motion.div
      initial={{ y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
      onMouseEnter={pause}
      onMouseLeave={resume}
      role="status"
      style={{ willChange: "transform, opacity" }}
      className={`pointer-events-auto w-full max-w-[440px] min-w-[300px] flex items-center gap-3 px-3.5 py-2.5 rounded-xl
        bg-surface2 border shadow-lift ${toast.tone === "danger" ? "border-red-500/30" : "border-line/10"}`}
    >
      <span
        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
          toast.tone === "danger" ? "bg-red-500/15 text-red-400" : "bg-accent/15 text-accentText"
        }`}
      >
        <Bell size={15} strokeWidth={2} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium truncate">{toast.title}</span>
        {toast.description && <span className="block text-[12px] text-muted truncate">{toast.description}</span>}
      </span>

      {toast.action && (
        <button
          onClick={runAction}
          className="shrink-0 h-7 px-2.5 rounded-lg border border-line/[0.14] text-[12px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors flex items-center gap-1.5"
        >
          <Undo2 size={12} />
          {toast.action.label}
        </button>
      )}

      <button
        onClick={() => dismiss(toast.id)}
        aria-label="Скрыть уведомление"
        className="shrink-0 -mr-1 p-1.5 rounded-lg text-muted hover:text-ink hover:bg-ink/[0.06] transition-colors"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
});
