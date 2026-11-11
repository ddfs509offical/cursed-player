import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { toPlayableUrl } from "./player/audio";

/**
 * Островок поверх игры.
 *
 * Это содержимое второго окна (метка окна `island`): маленькая плашка с текущим
 * треком. Своего плеера здесь нет — состояние читаем командой из Rust, куда его
 * пишет главное окно: события между окнами WebView2 доставлял ненадёжно, а
 * команда работает всегда.
 *
 * Плашка не просто висит: клик разворачивает её в карточку с обложкой,
 * длительностью и кнопками переключения. Двигать можно перетаскиванием —
 * положение запоминается и восстанавливается при следующем запуске.
 *
 * Окно прозрачное: видна только сама плашка, остальное — игра.
 */
interface TrackPayload {
  title: string;
  artist: string;
  playing: boolean;
  cover: string;
  durationMs: number;
}

/** Размеры окна: свёрнутое — узкая полоска, развёрнутое — карточка. */
const COLLAPSED = { width: 380, height: 58 };
const EXPANDED = { width: 380, height: 168 };

/** Ключ, под которым запоминается положение плашки. */
const POS_KEY = "island-position";

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "--:--";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function Island() {
  const [track, setTrack] = useState<TrackPayload | null>(null);
  const [open, setOpen] = useState(false);
  /** Куда нажали: по этому признаку отличаем клик от перетаскивания. */
  const pressRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const saveTimer = useRef<number | null>(null);

  // ── Состояние трека: раз в секунду спрашиваем Rust.
  useEffect(() => {
    let alive = true;
    const pull = () => {
      void invoke<TrackPayload>("island_state")
        .then((state) => {
          if (alive) setTrack(state);
        })
        .catch(() => {
          // Окно могли закрыть — просто не обновляемся
        });
    };
    pull();
    const timer = window.setInterval(pull, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // ── Восстановление положения и размера при запуске.
  useEffect(() => {
    const win = getCurrentWindow();
    void win.setSize(new LogicalSize(COLLAPSED.width, COLLAPSED.height)).catch(() => {});
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { x: number; y: number };
        if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          void win.setPosition(new LogicalPosition(parsed.x, parsed.y)).catch(() => {});
        }
      }
    } catch {
      // Битое значение не повод падать: остаёмся на месте по умолчанию
    }

    // Положение запоминаем после любого перемещения, но не чаще раза в 400 мс.
    const unlisten = win.onMoved(() => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void win.outerPosition().then((position) => {
          const scale = window.devicePixelRatio || 1;
          localStorage.setItem(
            POS_KEY,
            JSON.stringify({ x: Math.round(position.x / scale), y: Math.round(position.y / scale) })
          );
        });
      }, 400);
    });
    return () => {
      void unlisten.then((off) => off());
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  // ── Свёрнуто/развёрнуто: окно меняет высоту, плашка — вид.
  useEffect(() => {
    const size = open ? EXPANDED : COLLAPSED;
    void getCurrentWindow().setSize(new LogicalSize(size.width, size.height)).catch(() => {});
  }, [open]);

  /** Перетаскивание начинаем только после заметного сдвига — иначе это клик. */
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    pressRef.current = { x: event.clientX, y: event.clientY, dragging: false };
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press || press.dragging) return;
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (moved > 4) {
      press.dragging = true;
      void getCurrentWindow().startDragging().catch(() => {});
    }
  }, []);

  const onPointerUp = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    if (press && !press.dragging) setOpen((value) => !value);
  }, []);

  const action = useCallback((what: "prev" | "next" | "toggle") => {
    void invoke("island_action", { action: what }).catch(() => {});
  }, []);

  if (!track || (!track.title && !track.artist)) {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  const cover = track.cover ? toPlayableUrl(track.cover) : "";

  return (
    <div className="h-screen w-screen flex items-start justify-center bg-transparent select-none">
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`mt-1.5 w-[352px] border border-white/10 bg-black/[0.82] backdrop-blur-[16px] shadow-[0_10px_28px_rgba(0,0,0,0.55)] transition-all duration-300 ease-[cubic-bezier(0.2,0.9,0.2,1)] ${
          open ? "rounded-2xl px-3 py-2.5" : "rounded-[18px] px-3.5 py-2"
        }`}
      >
        <div className="flex items-center gap-2.5 transition-transform duration-300 ease-[cubic-bezier(0.2,0.9,0.2,1)]">
          {open && (
            <span className="w-11 h-11 shrink-0 rounded-lg overflow-hidden bg-white/[0.08] flex items-center justify-center text-white/40">
              {cover ? (
                <img src={cover} alt="" className="w-full h-full object-cover" draggable={false} />
              ) : (
                <Play size={14} />
              )}
            </span>
          )}

          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-medium leading-tight text-white">
              {track.title || "Ничего не играет"}
            </span>
            <span className="block truncate text-[10px] leading-tight text-white/55 mt-0.5">
              {track.artist || "неизвестный исполнитель"}
              {open && track.durationMs > 0 && ` · ${formatDuration(track.durationMs)}`}
            </span>
          </span>

          {/* Свёрнутая плашка: только состояние. Играет — живые полоски,
              пауза — значок паузы: раньше треугольник «play» стоял и на
              играющем треке, и казалось, что музыка на паузе. */}
          {!open && (
            <span className="w-6 h-6 shrink-0 rounded-full bg-white/10 flex items-center justify-center text-white/85">
              {track.playing ? (
                <span className="flex items-end gap-[2px] h-3" aria-label="Играет">
                  <span className="island-bar w-[2px] h-2 rounded-sm bg-current" />
                  <span className="island-bar w-[2px] h-3 rounded-sm bg-current" />
                  <span className="island-bar w-[2px] h-1.5 rounded-sm bg-current" />
                </span>
              ) : (
                <Pause size={11} fill="currentColor" />
              )}
            </span>
          )}
        </div>

        {open && (
          <div className="mt-2.5 flex items-center justify-center gap-1.5">
            <button
              type="button"
              onClick={() => action("prev")}
              aria-label="Предыдущий трек"
              className="w-8 h-8 rounded-lg bg-white/[0.07] text-white/85 flex items-center justify-center hover:bg-white/[0.14] transition-colors"
            >
              <SkipBack size={14} fill="currentColor" />
            </button>
            <button
              type="button"
              onClick={() => action("toggle")}
              aria-label={track.playing ? "Пауза" : "Играть"}
              className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center hover:bg-white/90 transition-colors"
            >
              {track.playing ? (
                <Pause size={15} fill="currentColor" />
              ) : (
                <Play size={15} fill="currentColor" className="ml-0.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => action("next")}
              aria-label="Следующий трек"
              className="w-8 h-8 rounded-lg bg-white/[0.07] text-white/85 flex items-center justify-center hover:bg-white/[0.14] transition-colors"
            >
              <SkipForward size={14} fill="currentColor" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
