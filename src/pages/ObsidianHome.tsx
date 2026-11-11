/**
 * Главная «Обсидиан»: вверху обложка того, что слушаешь, под ней — ленты.
 *
 * Прежняя главная была дашбордом: четыре равные плитки со сводкой, ещё три
 * счётчика и список «с чего начать». Всё это рассказывало о приложении, а не
 * о музыке. Здесь наоборот: первое, что видно, — то, что сейчас играет или
 * что слушал последним, во всю ширину; дальше идут ленты — недавнее, тренды,
 * волна, — которые можно листать вбок и включать в один щелчок.
 *
 * Числа никуда не делись, но ушли в конец, одной тихой строкой: слушателю
 * они нужны раз в месяц, а не каждый запуск.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Play, SkipForward, Plus } from "lucide-react";
import Cover from "../components/Cover";
import ObsidianCharts from "../components/ObsidianCharts";
import { useHistoryStore, type HistoryEntry } from "../store/historyStore";
import { usePlayerStore } from "../store/playerStore";
import { useFavoritesStore } from "../store/favoritesStore";
import { useLibraryStore } from "../store/libraryStore";
import { findOfflineCopy } from "../store/offlineStore";
import { offlineFailureMessage } from "../lib/offline";
import { formatDuration, refreshServiceStream } from "../services/catalog";
import { serviceFromTrackId } from "../lib/services";
import { toast } from "../store/toastStore";
import { errorText, logError } from "../store/errorStore";
import { sounds } from "../lib/sounds";
import type { Profile } from "../services/profiles";
import type { Track } from "../store/playerStore";

interface Props {
  profile: Profile;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  onOpenPlaylists: () => void;
  onAddMusic: () => void;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

/** Запись истории в вид трека плеера. */
function trackFromHistory(entry: HistoryEntry): Track {
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

/** Сколько треков: «1 трек», «3 трека», «11 треков». */
function tracksWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} трек`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} трека`;
  return `${count} треков`;
}

export default function ObsidianHome({
  profile,
  onOpenSettings,
  onOpenLibrary,
  onOpenPlaylists,
  onAddMusic,
}: Props) {
  const history = useHistoryStore((s) => s.entries);
  const library = useLibraryStore((s) => s.tracks);
  const favoritesCount = useFavoritesStore((s) => s.ids.length);

  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const position = usePlayerStore((s) => s.position);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);

  const current = index >= 0 ? queue[index] : undefined;

  /** Что показываем в большой карточке: играющий трек или последний из истории. */
  const hero = useMemo(() => {
    if (current) return current;
    const last = [...history].sort((a, b) => b.at - a.at)[0];
    return last ? trackFromHistory(last) : null;
  }, [current, history]);

  /** Недавнее: история без повтора героя. */
  const recent = useMemo(() => {
    const seen = new Set<string>(hero ? [hero.id] : []);
    const out: Track[] = [];
    for (const entry of [...history].sort((a, b) => b.at - a.at)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(trackFromHistory(entry));
      if (out.length >= 14) break;
    }
    return out;
  }, [history, hero]);

  /** «Волна из библиотеки»: локальные треки, если они есть. */
  const fromLibrary = useMemo(() => library.slice(0, 14), [library]);

  const stats = profile.stats;

  // Индекс героя в history для воспроизведения всей ленты недавнего.
  const recentQueue = useMemo(() => recent, [recent]);

  /**
   * Включение из лент: сервисный трек требует свежей ссылки на поток,
   * локальный играет с диска. Офлайн-копия сильнее обоих вариантов.
   */
  async function playTrack(track: Track, list: Track[] = [track]) {
    try {
      const copy = await findOfflineCopy(track.id);
      const ready = copy ?? (track.source === "service" ? await refreshServiceStream(track) : track);
      const startAt = list.findIndex((item) => item.id === track.id);
      if (list.length > 1 && startAt >= 0) {
        usePlayerStore.getState().playLocal(
          list.map((item) => (item.id === track.id ? ready : item)),
          startAt
        );
      } else {
        usePlayerStore.getState().playNow(ready);
      }
      sounds.save();
    } catch (e) {
      const message = offlineFailureMessage(e, false);
      sounds.error();
      logError("Не удалось включить трек", `${track.title}: ${message}`, "главная", errorText(e));
      toast({ title: "Не удалось включить трек", description: message, tone: "danger" });
    }
  }

  /** Главная кнопка: включить/поставить на паузу, либо начать с героя. */
  function heroAction() {
    if (current) {
      togglePlay();
      return;
    }
    if (hero) void playTrack(hero, [hero, ...recentQueue]);
  }

  return (
    <div className="obs-home">
      {/* ── Верх: обложка и подпись ─────────────────────────────────── */}
      <section className="obs-hero">
        <div className="obs-hero__plate obs-plate obs-plate--hero">
          <Cover
            src={hero?.cover ?? null}
            size={344}
            rounded="rounded-none"
            service={hero ? serviceFromTrackId(hero.id) : null}
            className="w-full h-full"
          />
        </div>

        <div className="obs-hero__body">
          <p className="obs-hero__greet">
            {greeting()}, {profile.displayName}
          </p>
          <h1 className="obs-hero__title">{hero ? hero.title : "Тишина"}</h1>
          <p className="obs-hero__sub">
            {hero ? (hero.artist ?? "Неизвестный исполнитель") : "Включи что-нибудь — и здесь появится обложка"}
          </p>

          <div className="obs-hero__actions">
            <button className="obs-btn-primary" onClick={heroAction}>
              <Play size={15} fill="currentColor" />
              {current ? (isPlaying ? "Пауза" : "Продолжить") : "Слушать"}
            </button>
            <button className="obs-btn" onClick={onAddMusic}>
              <Plus size={15} /> Добавить музыку
            </button>
          </div>

          {hero && (
            <p className="obs-hero__meta obs-num">
              {hero.album ? `${hero.album} · ` : ""}
              {hero.durationMs > 0 ? formatDuration(hero.durationMs) : "—"}
              {current && position > 0 ? ` · остановились на ${formatDuration(position * 1000)}` : ""}
            </p>
          )}
        </div>

        {/* Кнопка «дальше» справа: листает героя по истории без перехода. */}
        {history.length > 1 && (
          <button
            className="obs-hero__next"
            title="Следующий из истории"
            aria-label="Следующий из истории"
            onClick={() => {
              const list = recent;
              if (list[0]) void playTrack(list[0], list);
            }}
          >
            <SkipForward size={17} fill="currentColor" />
          </button>
        )}
      </section>

      {/* ── Ленты ───────────────────────────────────────────────────── */}
      <ObsidianRow
        title="Недавно слушали"
        subtitle={recent.length > 0 ? tracksWord(recent.length) : undefined}
        empty={
          recent.length === 0
            ? "Пока пусто. Включи трек из поиска — он появится здесь."
            : undefined
        }
      >
        {recent.map((track) => (
          <ObsidianCard
            key={track.id}
            title={track.title}
            subtitle={track.artist ?? "Неизвестный исполнитель"}
            cover={track.cover}
            service={serviceFromTrackId(track.id)}
            onPlay={() => void playTrack(track, recent)}
            wide
          />
        ))}
      </ObsidianRow>

      {/* Тренды включают трек сами: у них своя ссылка на поток. */}
      <ObsidianCharts onPlay={() => undefined} />

      {fromLibrary.length > 0 && (
        <ObsidianRow title="Из библиотеки" subtitle={tracksWord(fromLibrary.length)}>
          {fromLibrary.map((track) => (
            <ObsidianCard
              key={track.id}
              title={track.title}
              subtitle={track.artist ?? "Неизвестный исполнитель"}
              cover={track.cover}
              service={serviceFromTrackId(track.id)}
              onPlay={() => void playTrack(track, fromLibrary)}
            />
          ))}
        </ObsidianRow>
      )}

      {/* ── Тихая подпись и сводка ──────────────────────────────────── */}
      <footer className="obs-home__foot">
        <p className="obs-num">
          {stats.hours.toFixed(1)} ч музыки · {stats.tracks} прослушано · {favoritesCount} в избранном
          {stats.topArtist ? ` · чаще всех — ${stats.topArtist}` : ""}
        </p>
        <div className="obs-home__links">
          <button onClick={onOpenLibrary}>Моя музыка</button>
          <button onClick={onOpenPlaylists}>Плейлисты</button>
          <button onClick={onOpenSettings}>Настройки</button>
        </div>
      </footer>
    </div>
  );
}

/* ── Лента ─────────────────────────────────────────────────────────── */

/**
 * Горизонтальная лента с прокруткой кнопками. Колесо мыши работает как
 * обычно; кнопки нужны для мыши без горизонтального колеса.
 */
function ObsidianRow({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  empty?: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  function update() {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [children]);

  function scrollBy(direction: number) {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.8), behavior: "smooth" });
  }

  return (
    <section className="obs-section-block">
      <header className="obs-section-head">
        <h2 className="obs-title">{title}</h2>
        {subtitle && <span className="obs-label">{subtitle}</span>}
        <span className="obs-section-head__spacer" />
        {canLeft && (
          <button className="obs-icon" onClick={() => scrollBy(-1)} aria-label="Назад">
            <ChevronLeft size={16} />
          </button>
        )}
        {(canRight || canLeft) && (
          <button className="obs-icon" onClick={() => scrollBy(1)} aria-label="Вперёд">
            <ChevronRight size={16} />
          </button>
        )}
      </header>

      {empty ? (
        <p className="obs-prose">{empty}</p>
      ) : (
        <div className="obs-row-scroll" ref={ref}>
          {children}
        </div>
      )}
    </section>
  );
}

/* ── Карточка ──────────────────────────────────────────────────────── */

/**
 * Карточка ленты: обложка предметом, название, исполнитель. Широкая —
 * для недавнего, обычная — для длинных лент. Воспроизведение по щелчку.
 */
function ObsidianCard({
  title,
  subtitle,
  cover,
  service,
  onPlay,
  wide,
}: {
  title: string;
  subtitle: string;
  cover?: string | null;
  service?: ReturnType<typeof serviceFromTrackId>;
  onPlay: () => void;
  wide?: boolean;
}) {
  return (
    <button
      className="obs-card"
      data-wide={wide ? "true" : undefined}
      onClick={onPlay}
      title={`Включить: ${title}`}
    >
      <span className="obs-card__plate obs-plate">
        <span className="obs-card__cover">
          <Cover src={cover ?? null} size={wide ? 168 : 132} rounded="rounded-none" service={service} />
        </span>
        <span className="obs-card__play" aria-hidden="true">
          <Play size={15} fill="currentColor" />
        </span>
      </span>
      <span className="obs-card__title">{title}</span>
      <span className="obs-card__sub">{subtitle}</span>
    </button>
  );
}
