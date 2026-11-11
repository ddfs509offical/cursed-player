/**
 * Главный экран телефона.
 *
 * Сверху — название, поиск и настройки. Ниже баннер «Твой микс», лента
 * недавнего и список из библиотеки. Всё из настоящих данных приложения:
 * история, библиотека и избранное; ничего демонстрационного.
 *
 * Разметка повторяет референс, но без иллюстраций: вместо картинки микса —
 * тёмная карточка с подписью. Минимализм важнее украшений.
 */
import { useMemo } from "react";
import { ChevronRight, Play, Search, Settings } from "lucide-react";
import { usePlayerStore, type Track } from "../store/playerStore";
import { useLibraryStore } from "../store/libraryStore";
import { useFavoritesStore } from "../store/favoritesStore";
import { useHistoryStore } from "../store/historyStore";
import { formatTime, type MobileTab } from "./shared";

interface Props {
  onTab: (tab: MobileTab) => void;
  onSettings: () => void;
  onPlay: (tracks: Track[], index: number) => void;
}

/** Запись истории в тот же вид, что очередь плеера. */
function fromHistory(entry: {
  id: string;
  title: string;
  artist: string | null;
  cover: string | null;
  source: "local" | "service";
  path: string;
  durationMs?: number;
  at: number;
}): Track {
  return {
    id: entry.id,
    path: entry.path,
    title: entry.title,
    artist: entry.artist,
    album: null,
    durationMs: entry.durationMs ?? 0,
    source: entry.source,
    cover: entry.cover,
  };
}

export default function MobileHome({ onTab, onSettings, onPlay }: Props) {
  const library = useLibraryStore((s) => s.tracks);
  const favorites = useFavoritesStore((s) => s.items);
  const history = useHistoryStore((s) => s.entries);

  // Недавнее: свежие записи истории, затем библиотека. Дубли убираем по id.
  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: Track[] = [];
    const push = (track: Track) => {
      if (!track?.id || seen.has(track.id)) return;
      seen.add(track.id);
      out.push(track);
    };
    const sorted = [...history].sort((a, b) => b.at - a.at);
    for (const entry of sorted) push(fromHistory(entry));
    for (const track of library) push(track);
    return out;
  }, [history, library]);

  const chart = recent.slice(0, 5);

  return (
    <div className="m-scroll">
      <div className="m-head">
        <div className="m-head__brand">
          <span className="m-head__mark" aria-hidden="true">
            ♪
          </span>
          <span>Cursed Player</span>
        </div>
        <div className="m-head__actions">
          <button className="m-icon-btn" aria-label="Поиск" onClick={() => onTab("search")}>
            <Search size={18} />
          </button>
          <button className="m-icon-btn" aria-label="Настройки" onClick={onSettings}>
            <Settings size={18} />
          </button>
        </div>
      </div>

      <button
        className="m-search"
        onClick={() => onTab("search")}
        style={{ width: "100%", textAlign: "left" }}
      >
        <Search size={18} />
        <span style={{ fontSize: 15 }}>Поиск музыки…</span>
      </button>

      <div
        className="m-banner"
        onClick={() => recent.length > 0 && onPlay(recent, 0)}
        role="button"
        tabIndex={0}
      >
        <div className="m-banner__disc" aria-hidden="true" />
        <div>
          <div className="m-banner__title">Твой музыкальный микс</div>
          <div className="m-banner__sub">
            {recent.length > 0
              ? `${recent.length} треков из библиотеки и истории`
              : "Добавь музыку — и микс соберётся"}
          </div>
          <div className="m-banner__play">
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: "#0b0b0c",
                color: "#fff",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Play size={14} fill="currentColor" />
            </span>
            Слушать
          </div>
        </div>
      </div>

      <div className="m-dots" aria-hidden="true">
        <span className="m-dot m-dot--active" />
        <span className="m-dot" />
        <span className="m-dot" />
      </div>

      <section className="m-section">
        <div className="m-section__head">
          <span className="m-section__title">Недавно слушали</span>
          <button className="m-section__more" onClick={() => onTab("library")}>
            Все <ChevronRight size={14} />
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="m-empty">Пока пусто. Добавь файлы или включи трек из поиска.</p>
        ) : (
          <div className="m-row">
            {recent.slice(0, 10).map((track) => (
              <button
                key={track.id}
                className="m-card"
                onClick={() => onPlay(recent, recent.indexOf(track))}
              >
                <div className="m-card__cover">
                  {track.cover ? <img src={track.cover} alt="" draggable={false} /> : "♪"}
                </div>
                <div className="m-card__title">{track.title}</div>
                <div className="m-card__artist">{track.artist ?? "неизвестный"}</div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="m-section">
        <div className="m-section__head">
          <span className="m-section__title">Из библиотеки</span>
          <button className="m-section__more" onClick={() => onTab("favorites")}>
            Избранное <ChevronRight size={14} />
          </button>
        </div>
        {chart.length === 0 ? (
          <p className="m-empty">Библиотека пуста — добавь музыку в приложении на компьютере.</p>
        ) : (
          chart.map((track, position) => (
            <button key={track.id} className="m-track" onClick={() => onPlay(chart, position)}>
              <div className="m-track__cover">
                {track.cover ? <img src={track.cover} alt="" draggable={false} /> : "♪"}
              </div>
              <div className="m-track__meta">
                <div className="m-track__title">{track.title}</div>
                <div className="m-track__artist">{track.artist ?? "неизвестный"}</div>
              </div>
              <span style={{ fontSize: 12, color: "rgb(var(--color-faint))" }}>
                {formatTime(track.durationMs)}
              </span>
            </button>
          ))
        )}
      </section>

      <p style={{ marginTop: 24, fontSize: 11, color: "rgb(var(--color-faint))" }}>
        Лайков: {favorites.length} · в библиотеке: {library.length}
      </p>
    </div>
  );
}
