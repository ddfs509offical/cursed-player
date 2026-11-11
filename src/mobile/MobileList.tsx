/**
 * Простые мобильные списки: библиотека, избранное, плейлисты, поиск.
 *
 * Один компонент на четыре раздела: различается только источник данных и
 * текст заголовка. Так проще держать единый вид строки трека.
 */
import { useMemo, useState } from "react";
import { ChevronRight, Heart, ListMusic, Play, Search } from "lucide-react";
import { usePlayerStore, type Track } from "../store/playerStore";
import { useLibraryStore } from "../store/libraryStore";
import { useFavoritesStore } from "../store/favoritesStore";
import { usePlaylistsStore } from "../store/playlistsStore";
import { formatTime } from "./shared";

interface Props {
  kind: "library" | "favorites" | "playlists" | "search";
  onPlay: (tracks: Track[], index: number) => void;
}

function TrackRow({ track, onPlay }: { track: Track; onPlay: () => void }) {
  return (
    <button className="m-track" onClick={onPlay}>
      <div className="m-track__cover">
        {track.cover ? <img src={track.cover} alt="" draggable={false} /> : "♪"}
      </div>
      <div className="m-track__meta">
        <div className="m-track__title">{track.title}</div>
        <div className="m-track__artist">{track.artist ?? "неизвестный"}</div>
      </div>
      <span style={{ fontSize: 12, color: "rgb(var(--color-faint))" }}>{formatTime(track.durationMs)}</span>
    </button>
  );
}

export default function MobileList({ kind, onPlay }: Props) {
  const library = useLibraryStore((s) => s.tracks);
  const favorites = useFavoritesStore((s) => s.items);
  const playlists = usePlaylistsStore((s) => s.items);
  const queue = usePlayerStore((s) => s.queue);
  const [query, setQuery] = useState("");

  const liked: Track[] = useMemo(
    () =>
      favorites.map((item) => ({
        id: item.id,
        path: item.path,
        title: item.title,
        artist: item.artist,
        album: null,
        durationMs: 0,
        source: item.source,
        cover: item.cover,
      })),
    [favorites]
  );

  const source: Track[] = kind === "library" ? library : kind === "favorites" ? liked : queue;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return source;
    return source.filter(
      (track) =>
        track.title.toLowerCase().includes(needle) || (track.artist ?? "").toLowerCase().includes(needle)
    );
  }, [source, query]);

  const title =
    kind === "library"
      ? "Библиотека"
      : kind === "favorites"
        ? "Избранное"
        : kind === "playlists"
          ? "Плейлисты"
          : "Поиск";

  return (
    <div className="m-scroll">
      <div className="m-head">
        <div className="m-head__brand">
          <span>{title}</span>
        </div>
      </div>

      {kind === "search" && (
        <div className="m-search">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Название или исполнитель"
          />
        </div>
      )}

      {kind === "playlists" ? (
        <div>
          {playlists.length === 0 && <p className="m-empty">Плейлистов пока нет.</p>}
          {playlists.map((playlist) => {
            const tracks = playlist.trackIds
              .map((id) => queue.find((track) => track.id === id) ?? library.find((track) => track.id === id))
              .filter((track): track is Track => Boolean(track));
            return (
              <button
                key={playlist.id}
                className="m-track"
                onClick={() => tracks.length > 0 && onPlay(tracks, 0)}
              >
                <div className="m-track__cover">
                  <ListMusic size={18} />
                </div>
                <div className="m-track__meta">
                  <div className="m-track__title">{playlist.name}</div>
                  <div className="m-track__artist">{playlist.trackIds.length} треков</div>
                </div>
                <ChevronRight size={16} style={{ color: "rgb(var(--color-faint))" }} />
              </button>
            );
          })}
        </div>
      ) : (
        <div>
          {kind === "favorites" && (
            <p style={{ marginBottom: 12, fontSize: 12, color: "rgb(var(--color-faint))" }}>
              {filtered.length} в избранном · <Heart size={11} style={{ display: "inline" }} />
            </p>
          )}
          {kind === "search" && filtered.length === 0 && (
            <p className="m-empty">
              Поиск по названию и исполнителю среди того, что уже в приложении. Онлайн-поиск по сервисам —
              в настольной версии.
            </p>
          )}
          {filtered.map((track, position) => (
            <TrackRow key={track.id} track={track} onPlay={() => onPlay(filtered, position)} />
          ))}
          {kind !== "search" && filtered.length === 0 && (
            <p className="m-empty">
              Пока пусто. Включи трек — он появится здесь.{" "}
              <Play size={11} style={{ display: "inline" }} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}
