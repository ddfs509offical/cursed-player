import { useEffect, useRef } from "react";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { discordClear, discordIdle, discordSetActivity } from "../services/integrations";
import { APP_NAME, APP_VERSION } from "../lib/app";

/**
 * Discord Rich Presence: показываем текущий трек, а когда ничего не играет —
 * иконку приложения (ассет `logo`).
 *
 * Важная деталь: при повторе трека или переходе между треками плеер на долю
 * секунды сообщает «не играет». Если сразу отправить это в Discord, статус
 * мигает и застревает на «Ничего не играет». Поэтому сброс отложен на пару
 * секунд, а таймер трека продолжается, пока название то же.
 */
const REASSERT_MS = 15000;
const IDLE_DELAY_MS = 2500;

export function useDiscordPresence() {
  const discordEnabled = useSettingsStore((s) => s.discordEnabled);
  const clientId = useSettingsStore((s) => s.discordClientId);
  const trackTitle = usePlayerStore((s) => s.trackTitle);
  const trackArtist = usePlayerStore((s) => s.trackArtist);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const cover = usePlayerStore((s) => s.queue[s.index]?.cover ?? null);
  const startedAt = useRef<number | null>(null);
  const lastTitle = useRef<string>("");

  const active = discordEnabled && clientId.trim().length > 0;
  const artUrl = cover && /^https?:\/\//.test(cover) ? cover : "logo";

  useEffect(() => {
    if (!active) {
      void discordClear();
      return;
    }

    // Ничего не играет: показываем иконку приложения, но не мгновенно —
    // иначе при повторе трека статус успевает мигнуть «ничего не играет»
    if (!isPlaying || !trackTitle) {
      const idleTimer = window.setTimeout(() => {
        void discordIdle(clientId, "logo").catch(() => {});
      }, IDLE_DELAY_MS);
      return () => window.clearTimeout(idleTimer);
    }

    // Новый трек — новый отсчёт времени; при повторе того же трека отсчёт идёт дальше
    if (lastTitle.current !== trackTitle || startedAt.current === null) {
      lastTitle.current = trackTitle;
      startedAt.current = Date.now();
    }

    const push = () => {
      void discordSetActivity({
        clientId,
        details: trackTitle,
        stateLine: trackArtist || APP_VERSION,
        startedAtMs: startedAt.current,
        largeImage: artUrl,
        largeText: artUrl === "logo" ? APP_NAME : `${trackTitle}${trackArtist ? ` — ${trackArtist}` : ""}`,
      }).catch(() => {
        // Discord закрыт или ID неверный — молча ждём следующей попытки
      });
    };

    push();
    const timer = window.setInterval(push, REASSERT_MS);
    return () => window.clearInterval(timer);
  }, [active, clientId, isPlaying, trackTitle, trackArtist, artUrl]);
}
