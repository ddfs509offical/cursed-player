import { motion } from "framer-motion";
import { APP_NAME, APP_TAGLINE, APP_VERSION } from "../lib/app";
import { useAppIcon } from "../lib/appIcon";

/**
 * Заставка при входе и создании профиля: логотип, название и версия.
 * Держится минимум секунду, чтобы не мигала на быстрых действиях.
 */
export default function Splash({ status }: { status: string }) {
  const appIcon = useAppIcon();
  return (
    <div className="h-screen bg-app text-ink flex flex-col items-center justify-center gap-6 relative overflow-hidden">
      <motion.div
        initial={{ scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 240, damping: 26 }}
        className="relative flex flex-col items-center gap-4"
      >
        <img src={appIcon} alt="" className="w-16 h-16 rounded-2xl border border-line/[0.08] shadow-lift" />
        <div className="text-center">
          <h1 className="text-[24px] font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="text-[12px] text-muted mt-1">
            {APP_VERSION} · {APP_TAGLINE}
          </p>
        </div>
      </motion.div>

      <div className="relative w-56">
        <div className="h-1 rounded-full bg-ink/10 overflow-hidden">
          <motion.div
            className="h-full bg-accentText rounded-full"
            initial={{ width: "8%" }}
            animate={{ width: "100%" }}
            transition={{ duration: 1.4, ease: [0.2, 0, 0, 1] }}
          />
        </div>
        <p className="text-[12px] text-muted text-center mt-3">{status}</p>
      </div>
    </div>
  );
}
