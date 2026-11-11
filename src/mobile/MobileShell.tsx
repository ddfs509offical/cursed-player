/**
 * Мобильная оболочка: экраны, нижняя навигация и мини-плеер.
 *
 * Включается по ширине окна (см. `useIsMobile`), поэтому на десктопе всё
 * остаётся как было, а на телефоне вместо настольных панелей показывается
 * этот каркас. Данные и плеер общие: те же сторы, что у большой версии.
 */
import { useState } from "react";
import { Heart, Home, Library, ListMusic, Search } from "lucide-react";
import { usePlayerStore, type Track } from "../store/playerStore";
import MobileHome from "./MobileHome";
import MobileList from "./MobileList";
import MobileNowPlaying from "./MobileNowPlaying";
import MobilePlayer from "./MobilePlayer";
import { MOBILE_TABS, type MobileTab } from "./shared";
import "./mobile.css";

const ICONS = {
  home: Home,
  library: Library,
  search: Search,
  favorites: Heart,
  playlists: ListMusic,
} as const;

export default function MobileShell({ onSettings }: { onSettings: () => void }) {
  const [tab, setTab] = useState<MobileTab>("home");
  const [nowOpen, setNowOpen] = useState(false);
  const playLocal = usePlayerStore((s) => s.playLocal);

  function play(tracks: Track[], index: number) {
    if (!tracks.length) return;
    playLocal(tracks, index);
    setNowOpen(true);
  }

  return (
    <div className="m-shell" style={{ ["--m-player-h" as string]: "70px" }}>
      {tab === "home" && <MobileHome onTab={setTab} onSettings={onSettings} onPlay={play} />}
      {tab === "library" && <MobileList kind="library" onPlay={play} />}
      {tab === "search" && <MobileList kind="search" onPlay={play} />}
      {tab === "favorites" && <MobileList kind="favorites" onPlay={play} />}
      {tab === "playlists" && <MobileList kind="playlists" onPlay={play} />}

      <MobilePlayer onOpen={() => setNowOpen(true)} />

      <nav className="m-tabs" aria-label="Разделы">
        {MOBILE_TABS.map((item) => {
          const Icon = ICONS[item.id];
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              className={`m-tab ${active ? "m-tab--active" : ""}`}
              onClick={() => setTab(item.id)}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {nowOpen && <MobileNowPlaying onClose={() => setNowOpen(false)} />}
    </div>
  );
}
