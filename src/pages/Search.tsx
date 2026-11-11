import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search as SearchIcon, X, Loader2, AlertTriangle, Plug, Clock, Download, Pin, Check } from "lucide-react";
import ServiceSwitcher from "../components/ServiceSwitcher";
import ServiceMark from "../components/ServiceMark";
import FavoriteButton from "../components/FavoriteButton";
import EmptyState from "../components/EmptyState";
import { DownloadChoiceModal } from "../components/Modal";
import { ArtistLink, PaginationBar } from "../components/ArtistWindow";
import { useServiceStore } from "../store/serviceStore";
import { logError, errorText } from "../store/errorStore";
import { useSettingsStore, choiceWantsLyrics, choiceWantsTrack, type DownloadChoice } from "../store/settingsStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";
import { formatDuration, formatPlaybackCount, searchTracksCached, soundcloudSearchPage, getServiceToken, soundcloudStreamUrl, soundcloudPermalink, type SearchTrack } from "../services/catalog";
import { saveTrackOffline, setOfflineKept, soundcloudDownloadInfo, offlineReason, type SavedFile } from "../services/downloads";
import { externalSaveTrack } from "../services/externalDownload";
import { usePlayerStore } from "../store/playerStore";
import { findOfflineCopy, useOfflineStore } from "../store/offlineStore";
import { saveLyricsForTrack, savedOutcomeTitle, type SaveLyricsStatus } from "../store/lyricsStore";
import { lyricsHasLocal } from "../services/lyrics";
import { offlineFailureMessage, offlineKey } from "../lib/offline";
import { serviceInfo } from "../lib/services";

interface Props {
  initialQuery: string;
  onOpenSettings: () => void;
}

const HISTORY_KEY = "music_hub_recent_searches";
const DEBOUNCE_MS = 400;
/**
 * Сколько результатов показываем на одной странице поиска. Страницы внутри уже
 * загруженного набора переключаются мгновенно; выход за его пределы просит
 * новую порцию у SoundCloud — ровно такого же размера.
 */
const PAGE_SIZE = 20;

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

/**
 * Страница поиска: своё поле ввода, переключатель сервисов и живой поиск
 * через выбранный сервис. Раньше поле поиска жило только в верхней панели
 * и на этой странице его не было вовсе — искать было нечем.
 */
export default function Search({ initialQuery, onOpenSettings }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchTrack[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Результаты из кеша: сеть не ответила, показываем сохранённое без ошибки. */
  const [stale, setStale] = useState(false);
  const [history, setHistory] = useState<string[]>(() => readHistory());
  /** id трека, который сейчас сохраняется офлайн: блокирует повторный клик. */
  const [savingId, setSavingId] = useState<string | null>(null);
  /**
   * Постраничная выдача: текущая страница, курсор следующей порции и признак
   * «за загруженным набором есть ещё». Загруженное держим целиком, поэтому
   * возврат на предыдущую страницу не ходит в сеть.
   */
  const [page, setPage] = useState(1);
  const [nextHref, setNextHref] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  /** Идёт догрузка порции: показываем плейсхолдеры строк, окно не блокируем. */
  const [loadingMore, setLoadingMore] = useState(false);

  const available = useServiceStore((s) => s.available);
  const activeService = useSettingsStore((s) => s.activeService);
  /** Запасной путь включён: предлагаем его только тогда и только вручную. */
  const externalEnabled = useSettingsStore((s) => s.externalDownloaderEnabled);
  /** Что сохранять: выбор, запомненный в окне «Что сохранить?». */
  const downloadChoice = useSettingsStore((s) => s.downloadChoice);
  const choiceRemembered = useSettingsStore((s) => s.downloadChoiceRemembered);
  const setDownloadChoice = useSettingsStore((s) => s.setDownloadChoice);
  const playNow = usePlayerStore((s) => s.playNow);
  /** Сохранённые офлайн-записи: по ним видно, что трек уже лежит на диске. */
  const offlineRecords = useOfflineStore((s) => s.records);
  /** id треков, текст которых уже сохранён файлом: для состояния «сохранено». */
  const [lyricsSavedIds, setLyricsSavedIds] = useState<Record<string, boolean>>({});
  /** Открытое окно выбора: для какого трека и что уже сделано. */
  const [choiceFor, setChoiceFor] = useState<{
    track: SearchTrack;
    trackSaved: boolean;
    lyricsSaved: boolean;
  } | null>(null);
  const info = serviceInfo(activeService);
  const connected = available[activeService];
  const request = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function remember(value: string) {
    const next = [value, ...history.filter((item) => item !== value)].slice(0, 8);
    setHistory(next);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  }

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setError(null);
      setStale(false);
      setBusy(false);
      setPage(1);
      setNextHref(null);
      setHasMore(false);
      return;
    }
    if (!connected) {
      setResults([]);
      setBusy(false);
      setError(null);
      setStale(false);
      setPage(1);
      setNextHref(null);
      setHasMore(false);
      return;
    }

    const id = ++request.current;
    // Новый запрос — новый набор: страницы и курсор начинаются заново
    setPage(1);
    setNextHref(null);
    setHasMore(false);
    const timer = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      setStale(false);
      try {
        const cached = await searchTracksCached(activeService, query);
        if (request.current !== id) return;
        setResults(cached.tracks);
        setStale(cached.stale);
        /**
         * Про «есть ещё» честно неизвестно: первую порцию SoundCloud отдаёт
         * вместе с отбором мусора, поэтому ориентируемся на её полноту.
         * Отсутствие остатка выяснится при первой же попытке догрузки.
         */
        setHasMore(activeService === "soundcloud" && cached.tracks.length >= PAGE_SIZE);
        if (cached.tracks.length) remember(query.trim());
      } catch (e) {
        if (request.current !== id) return;
        sounds.error();
        logError(
          `Поиск не сработал: ${info.name}`,
          e instanceof Error ? e.message : String(e),
          "поиск",
          errorText(e)
        );
        setError(e instanceof Error ? e.message : String(e));
        setStale(false);
        setResults([]);
        setHasMore(false);
      } finally {
        if (request.current === id) setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query, activeService, connected]);

  /**
   * Текст на диске проверяем только у треков, которые уже лежат офлайн: именно
   * у них кнопка скачивания может показать «сохранено». Зависимость — строка
   * id, а не массив: результаты поиска пересобираются на каждый рендер.
   */
  const savedCandidates = results
    .map((track) => `${track.service}:${track.id}`)
    .filter((id) => offlineRecords[offlineKey(id)])
    .join("|");

  useEffect(() => {
    let alive = true;
    const ids = savedCandidates ? savedCandidates.split("|") : [];
    if (!ids.length) {
      setLyricsSavedIds({});
      return () => {
        alive = false;
      };
    }
    void Promise.all(ids.map(async (id) => [id, await lyricsHasLocal(id)] as const)).then((pairs) => {
      if (alive) setLyricsSavedIds(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [savedCandidates]);

  /** Загруженные страницы и точное число страниц, когда список закончился. */
  const loadedPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const totalPages = hasMore ? null : loadedPages;
  const pageTracks = results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  /**
   * Переход по страницам. Внутри уже загруженного набора — мгновенно, без
   * запроса. Шаг за его пределы просит следующую порцию у SoundCloud: сначала
   * по курсору `next_href`, а если курсора нет — по смещению (сколько уже
   * загружено). Уже загруженное при этом не теряется.
   */
  async function goToPage(target: number) {
    if (target < 1 || busy || loadingMore) return;
    if (target <= loadedPages) {
      setPage(target);
      return;
    }
    // Дальше одной порции за клик не прыгаем: сначала её надо получить
    if (!hasMore || target > loadedPages + 1) return;

    const clientId = await getServiceToken("soundcloud");
    if (!clientId) {
      toast({
        title: "SoundCloud: нужен client_id",
        description: "Вставь свой client_id в настройках — без него страницы не догружаются",
        tone: "danger",
      });
      return;
    }

    setLoadingMore(true);
    /**
     * Запрос мог устареть: пока порция ехала, пользователь дописал запрос, и
     * тогда её место — не в новом списке. Номер запроса это ловит.
     */
    const token = request.current;
    const asked = query.trim();
    try {
      const batch = await soundcloudSearchPage(clientId, asked, PAGE_SIZE, results.length, nextHref);
      if (request.current !== token) return;
      setNextHref(batch.nextHref);

      // Дубли отсекаем по ключу трека: порции SoundCloud могут пересекаться
      const seen = new Set(results.map((track) => `${track.service}:${track.id}`));
      const added = batch.tracks.filter((track) => !seen.has(`${track.service}:${track.id}`));
      const merged = added.length ? [...results, ...added] : results;
      if (added.length) setResults(merged);
      /**
       * Порция без новинок означает, что дальше двигаться некуда (например,
       * сервис проигнорировал смещение): «Вперёд» больше ничего не обещает.
       */
      setHasMore(batch.hasMore && added.length > 0);
      if (!added.length) {
        toast({
          title: "Это все результаты",
          description: `По запросу «${asked}» в ${info.name} больше ничего нет`,
        });
      }

      // Порция могла оказаться короче страницы: встаём на последнюю реальную
      const pagesAfter = Math.max(1, Math.ceil(merged.length / PAGE_SIZE));
      setPage(Math.min(target, pagesAfter));
    } catch (e) {
      if (request.current !== token) return;
      sounds.error();
      logError(
        "Не удалось догрузить результаты поиска",
        `${asked} — ${info.name}`,
        "поиск",
        errorText(e)
      );
      toast({
        title: "Дальше загрузить не удалось",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
      // Порций больше не обещаем: подпись «Страница N из M» станет точной
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }

  function selectTrack(track: SearchTrack) {
    if (activeService === "soundcloud") {
      void playSoundCloud(track);
      return;
    }
    if (activeService === "spotify") {
      sounds.error();
      toast({
        title: "Spotify: пока только каталог",
        description: "Для воспроизведения нужен Premium и Web Playback SDK — это следующий этап",
        tone: "danger",
      });
      return;
    }
    sounds.error();
    toast({ title: "Этот сервис не поддерживается", description: info.note, tone: "danger" });
  }

  /** SoundCloud: берём прямую ссылку на поток трека и включаем его. */
  async function playSoundCloud(track: SearchTrack) {
    const id = `${track.service}:${track.id}`;
    /**
     * Сохранённая копия важнее сети: результаты поиска лежат в кеше и видны
     * даже без интернета, поэтому клик по такому треку обязан играть с диска,
     * а не падать на попытке получить ссылку.
     */
    const copy = await findOfflineCopy(id);
    if (copy) {
      playNow(copy);
      sounds.save();
      toast({ title: `Играю: ${copy.title}`, description: "Офлайн-копия с диска" });
      return;
    }
    try {
      const clientId = await getServiceToken("soundcloud");
      if (!clientId) throw new Error("SoundCloud: нужен client_id — вставь в настройках");
      const url = await soundcloudStreamUrl(clientId, track.id);
      playNow({
        id,
        path: url,
        title: track.title,
        artist: track.artists || null,
        album: track.album,
        durationMs: track.durationMs,
        source: "service",
        cover: track.cover,
      });
      sounds.save();
      toast({ title: `Играю: ${track.title}`, description: `${track.artists} · SoundCloud` });
    } catch (e) {
      sounds.error();
      // Копии нет и сеть не ответила — объясняем это, а не отказ сервиса
      const message = offlineFailureMessage(e, false);
      logError(
        "Не удалось включить трек",
        `${track.title} — ${track.artists}: ${message}`,
        "воспроизведение",
        errorText(e)
      );
      toast({
        title: "Не удалось включить трек",
        description: message,
        tone: "danger",
      });
    }
  }

  /**
   * Кнопка скачивания. Что именно сохранять, решает окно «Что сохранить?»:
   * пока выбор не запомнен, оно спрашивается всегда, а у трека, уже лежащего
   * на диске без текста, — независимо от запомненного выбора: «только трек» в
   * нём неактивно, зато докачивается текст. Полностью сохранённое окно не
   * открывает вовсе — там уже нечего предлагать.
   */
  async function startDownload(track: SearchTrack) {
    if (savingId) return;
    const id = `${track.service}:${track.id}`;
    const trackSaved = Boolean(offlineRecords[offlineKey(id)]);
    const lyricsSaved = await lyricsHasLocal(id);

    if (trackSaved && lyricsSaved) {
      toast({
        title: "Уже сохранено полностью",
        description: `${track.title} — и трек, и текст лежат на диске`,
      });
      return;
    }

    /**
     * Трек уже на диске, а текста нет: окно выбора показываем всегда, даже если
     * выбор запомнен — «только трек» в нём неактивно, зато докачивается текст.
     */
    if (trackSaved) {
      setChoiceFor({ track, trackSaved, lyricsSaved });
      return;
    }

    if (choiceRemembered) {
      await saveOffline(track, downloadChoice);
      return;
    }
    setChoiceFor({ track, trackSaved, lyricsSaved });
  }

  /**
   * Офлайн-трек. Сначала спрашиваем SoundCloud, разрешил ли автор скачивание:
   * разрешил — сохраняем сам файл («Скачать»); не разрешил — тянем ссылку на
   * поток и кладём офлайн-копию в кеш, о чём честно пишем в тосте.
   *
   * Текст сохраняется отдельно от аудио: если файл не взялся, текст всё равно
   * попробуем — это независимые вещи, и панель текста работает сама по себе.
   *
   * Идентификатор трека — тот же, что в очереди и в избранном
   * («soundcloud:123»): именно по нему плеер потом найдёт копию офлайн.
   */
  async function saveOffline(track: SearchTrack, choice: DownloadChoice) {
    if (savingId) return;
    setSavingId(track.id);
    const id = `${track.service}:${track.id}`;
    try {
      const alreadySaved = Boolean(useOfflineStore.getState().records[offlineKey(id)]);
      const wantTrack = choiceWantsTrack(choice) && !alreadySaved;
      const wantLyrics = choiceWantsLyrics(choice);
      let trackSaved = alreadySaved;
      // Способ уже сохранённой копии: по нему честно подписываем тост
      let method: string | null =
        useOfflineStore.getState().records[offlineKey(id)]?.method ?? null;
      let trackError: unknown = null;

      if (wantTrack) {
        try {
          const clientId = await getServiceToken("soundcloud");
          if (!clientId) throw new Error("SoundCloud: нужен client_id — вставь в настройках");

          const meta = { title: track.title, artist: track.artists || null, cover: track.cover };
          const info = await soundcloudDownloadInfo(clientId, track.id);

          if (info.downloadable && info.url) {
            const file = await saveTrackOffline(info.url, id, "download", meta);
            useOfflineStore.getState().upsert(file);
            method = file.method;
          } else {
            const stream = await soundcloudStreamUrl(clientId, track.id);
            const file = await saveTrackOffline(stream, id, "cache", meta);
            useOfflineStore.getState().upsert(file);
            method = file.method;
          }
          trackSaved = true;
        } catch (e) {
          trackError = e;
        }
      }

      let lyricsStatus: SaveLyricsStatus | null = null;
      if (wantLyrics) {
        lyricsStatus = (
          await saveLyricsForTrack({
            id,
            path: "",
            title: track.title,
            artist: track.artists || null,
            album: track.album ?? null,
            durationMs: track.durationMs,
            source: "service",
            cover: track.cover,
          })
        ).status;
      }

      if (trackError) {
        sounds.error();
        logError(
          "Не удалось сохранить трек для офлайна",
          `${track.title} — ${track.artists}`,
          "офлайн",
          errorText(trackError)
        );
        toast({
          title: "Не удалось сохранить трек",
          // Короткая причина в тосте: «тишина» в кнопке — то, на что жаловались
          description: externalEnabled
            ? `${offlineReason(trackError)}. Можно попробовать запасной путь — сторонний сервис`
            : offlineReason(trackError),
          tone: "danger",
          // Запасной путь предлагаем, но не запускаем сами: на чужой сервис
          // приложение ходит только по явному нажатию пользователя.
          action: externalEnabled
            ? { label: "Попробовать через внешний сервис", run: () => void saveExternally(track) }
            : { label: "Повторить", run: () => void saveOffline(track, choice) },
        });
        return;
      }

      sounds.save();
      void refreshLyricsSaved(id, lyricsStatus === "saved");
      toast({
        title: savedOutcomeTitle(trackSaved, lyricsStatus),
        description: trackSaved
          ? method === "download"
            ? `${track.title} — файл лежит в «Моей музыке» на вкладке «Скачанные»`
            : `${track.title} — офлайн-копия: автор не разрешил скачивание, файл лежит во временном хранилище приложения`
          : lyricsStatus === "saved"
            ? `${track.title} — текст сохранён файлом рядом с треком`
            : `${track.title} — текст не нашёлся ни в одном источнике`,
      });
    } finally {
      setSavingId(null);
    }
  }

  /** Обновить отметку «текст сохранён» для строки сразу после скачивания. */
  function refreshLyricsSaved(id: string, saved: boolean) {
    if (!saved) return;
    setLyricsSavedIds((current) => ({ ...current, [id]: true }));
  }

  /**
   * Запасной путь сохранения: трек уходит на внешний сервис soundloadmate.
   * Вызывается только из тоста об ошибке — то есть когда нативный способ уже
   * не справился и пользователь сам попросил попробовать иначе.
   *
   * Сервису нужен адрес страницы трека, а не числовой id: голые цифры он
   * понимает как поисковую строку и вернул бы чужие треки. Адрес спрашиваем у
   * SoundCloud, потому что нигде в приложении он не хранится.
   */
  async function saveExternally(track: SearchTrack) {
    if (savingId) return;
    setSavingId(track.id);
    try {
      const clientId = await getServiceToken("soundcloud");
      if (!clientId) throw new Error("SoundCloud: нужен client_id — вставь в настройках");

      const page = await soundcloudPermalink(clientId, track.id);
      const id = `${track.service}:${track.id}`;
      const file = await externalSaveTrack(page, id, {
        title: track.title,
        artist: track.artists || null,
        cover: track.cover,
      });
      useOfflineStore.getState().upsert(file);
      sounds.save();
      toast({
        title: `Сохранено через внешний сервис: ${track.title}`,
        description:
          "Офлайн-копия лежит в «Моей музыке» на вкладке «Скачанные». Сервис сторонний: работал без гарантий",
      });
    } catch (e) {
      sounds.error();
      logError(
        "Не удалось сохранить трек через внешний сервис",
        `${track.title} — ${track.artists}`,
        "офлайн",
        errorText(e)
      );
      toast({
        title: "Внешний сервис не справился",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    } finally {
      setSavingId(null);
    }
  }

  /**
   * «Держать офлайн»: файл остаётся на месте, меняется только пометка в
   * реестре — уборка кеша такую копию не удаляет.
   */
  async function toggleKeep(record: SavedFile) {
    const kept = !record.kept;
    try {
      await setOfflineKept(record.trackId, kept);
      useOfflineStore.getState().upsert({
        ...record,
        kept,
        kind: kept ? "keep" : record.baseKind,
      });
      sounds.save();
      toast({
        title: kept ? "Держу офлайн" : "Пометка снята",
        description: kept
          ? `${record.title} не удалится при очистке кеша`
          : `${record.title} снова может уйти при очистке кеша`,
      });
    } catch (e) {
      sounds.error();
      logError("Не удалось изменить пометку офлайн", record.title, "офлайн", errorText(e));
      toast({
        title: "Не удалось изменить пометку",
        description: offlineReason(e),
        tone: "danger",
      });
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Поиск</h1>
        </div>
        <ServiceSwitcher size="md" />
      </div>

      {/* Своё поле поиска: работает даже когда верхняя панель скрыта */}
      <div className="flex items-center gap-2 h-11 px-3.5 rounded-xl bg-inset border border-line/[0.07] mb-5 focus-within:border-accentText/50 transition-colors">
        <SearchIcon size={16} className="text-faint shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Треки, исполнители, альбомы — поиск в ${info.name}`}
          className="bg-transparent flex-1 min-w-0 outline-none text-[14px] placeholder:text-faint"
        />
        {busy && <Loader2 size={15} className="text-accentText animate-spin shrink-0" />}
        {query && !busy && (
          <button
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Очистить"
            className="shrink-0 p-1 rounded-md text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Сеть не ответила, но результаты нашлись в кеше — ошибку не показываем */}
      {connected && stale && (
        <p className="text-[12px] text-faint -mt-3 mb-4">Сеть не ответила — показаны сохранённые результаты</p>
      )}

      {history.length > 0 && !query && (
        <div className="mb-6">
          <p className="text-[12px] text-muted mb-2 flex items-center gap-1.5">
            <Clock size={12} /> Недавние запросы
          </p>
          <div className="flex flex-wrap gap-2">
            {history.map((item) => (
              <button
                key={item}
                onClick={() => setQuery(item)}
                className="h-7 px-3 rounded-lg bg-ink/[0.05] border border-line/[0.07] text-[12px] hover:text-ink hover:border-line/20 transition-colors"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Сервис не подключён */}
      {!connected && (
        <EmptyState
          Icon={Plug}
          title={`${info.name} не подключена`}
          description={
            info.searchable
              ? "Вставь токен сервиса в настройках — и поиск пойдёт через него. До этого момента иконка сервиса серая."
              : (info.note ?? "Сервис не умеет искать по API")
          }
          action={
            <button
              onClick={onOpenSettings}
              className="h-9 px-4 rounded-lg bg-accent text-onAccent text-[13px] font-medium hover:bg-accentHover transition-colors"
            >
              Открыть настройки
            </button>
          }
        />
      )}

      {connected && error && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-red-500/25 bg-red-500/[0.06]">
          <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium">Поиск не сработал</p>
            <p className="text-[12px] text-muted mt-1 break-words">{error}</p>
          </div>
        </div>
      )}

      {connected && !error && busy && results.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="flex items-center gap-3 px-2 py-2">
              <div className="w-10 h-10 rounded-md bg-ink/[0.05] animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-40 rounded bg-ink/[0.06] animate-pulse" />
                <div className="h-2.5 w-24 rounded bg-ink/[0.05] animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      )}

      {connected && !error && !stale && !busy && query.trim() && results.length === 0 && (
        <EmptyState
          Icon={SearchIcon}
          title={`Ничего не найдено по «${query.trim()}»`}
          description={`Попробуй другой запрос или переключись на другой сервис — сейчас ищем в ${info.name}.`}
        />
      )}

      {connected && !error && !query.trim() && (
        <EmptyState
          Icon={SearchIcon}
          title="Начни вводить запрос"
          description={`Поиск идёт по каталогу сервиса ${info.name}. Результаты появляются по мере ввода.`}
        />
      )}

      {connected && !error && results.length > 0 && (
        <div>
          <p className="text-[12px] text-muted mb-2">
            Найдено {results.length} · {info.name}
          </p>
          <div className="space-y-1">
            <AnimatePresence initial={false}>
              {pageTracks.map((track, index) => {
                const rowId = `${track.service}:${track.id}`;
                const trackSaved = Boolean(offlineRecords[offlineKey(rowId)]);
                const fullySaved = trackSaved && Boolean(lyricsSavedIds[rowId]);
                return (
                <motion.button
                  key={`${track.service}-${track.id}`}
                  initial={{ y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index, 8) * 0.02 }}
                  onClick={() => selectTrack(track)}
                  className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-ink/[0.05] transition-colors text-left group"
                >
                  {track.cover ? (
                    <img
                      src={track.cover}
                      alt=""
                      className="w-10 h-10 rounded-md object-cover shrink-0 bg-inset"
                      onError={(event) => {
                        (event.currentTarget as HTMLImageElement).style.visibility = "hidden";
                      }}
                    />
                  ) : (
                    <span className="w-10 h-10 rounded-md shrink-0 bg-ink/[0.06] flex items-center justify-center text-faint">
                      <ServiceMark service={activeService} size={16} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium truncate">{track.title}</span>
                    <span className="block text-[12px] text-muted truncate">
                      {/* Имя исполнителя — отдельный клик: открывает окно
                          артиста и не включает трек */}
                      {activeService === "soundcloud" ? <ArtistLink name={track.artists} /> : track.artists}
                      {track.album ? ` · ${track.album}` : ""}
                    </span>
                  </span>
                  {/* Популярность: компактно, рядом с длительностью. Данных
                      нет — подписи нет, место не занимаем */}
                  {(() => {
                    const plays = formatPlaybackCount(track.playbackCount);
                    if (!plays) return null;
                    const exact = (track.playbackCount ?? 0).toLocaleString("ru-RU");
                    return (
                      <span
                        className="text-[11px] text-faint shrink-0 tnum hidden sm:inline"
                        title={`${exact} прослушиваний`}
                      >
                        {plays}
                      </span>
                    );
                  })()}
                  <span className="text-[12px] text-muted shrink-0 tnum">{formatDuration(track.durationMs)}</span>
                  {/* Офлайн: честное имя кнопки зависит от разрешения автора.
                      Сохранённое и то и другое больше не предлагаем */}
                  {track.service === "soundcloud" &&
                    (savingId === track.id ? (
                      <span className="flex items-center gap-1.5 text-[12px] text-accentText shrink-0 px-1.5">
                        <Loader2 size={13} className="animate-spin" /> Сохраняю…
                      </span>
                    ) : fullySaved ? (
                      <span
                        aria-label="Уже сохранено: трек и текст"
                        title="Уже сохранено: и трек, и текст лежат на диске"
                        className="flex items-center gap-1 text-[12px] text-accentText shrink-0 px-1.5"
                      >
                        <Check size={13} strokeWidth={2.2} /> Сохранено
                      </span>
                    ) : (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void startDownload(track);
                        }}
                        aria-label={track.downloadable ? "Скачать" : "Сохранить в кеш"}
                        title={
                          track.downloadable
                            ? "Скачать: автор разрешил скачивание файла"
                            : "Сохранить в кеш: автор не разрешил скачивание — это офлайн-копия"
                        }
                        className="p-1.5 rounded-lg text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                      >
                        <Download size={14} strokeWidth={1.9} />
                      </button>
                    ))}
                  {/* Трек уже сохранён: можно попросить держать копию офлайн */}
                  {(() => {
                    const record = offlineRecords[offlineKey(`${track.service}:${track.id}`)];
                    if (!record) return null;
                    return (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleKeep(record);
                        }}
                        aria-label={record.kept ? "Снять «держать офлайн»" : "Держать офлайн"}
                        title={
                          record.kept
                            ? "Держу офлайн: уборка кеша эту копию не удалит"
                            : "Держать офлайн: не удалять копию при очистке кеша"
                        }
                        className={`p-1.5 rounded-lg transition-colors shrink-0 ${
                          record.kept
                            ? "text-accentText"
                            : "text-faint hover:text-ink hover:bg-ink/[0.06] opacity-0 group-hover:opacity-100 focus:opacity-100"
                        }`}
                      >
                        <Pin size={14} strokeWidth={1.9} className={record.kept ? "fill-current" : ""} />
                      </button>
                    );
                  })()}
                  <FavoriteButton
                    track={{
                      // Ссылку на поток подставит плеер: сохранённая успевает истечь
                      id: `${activeService}:${track.id}`,
                      title: track.title,
                      artist: track.artists || null,
                      cover: track.cover,
                      source: "service",
                      path: "",
                    }}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                  />
                </motion.button>
                );
              })}
            </AnimatePresence>
          </div>

          {/* Догрузка страницы: плейсхолдеры строк вместо блокировки окна */}
          {loadingMore && (
            <div className="space-y-2 pt-1 opacity-70">
              {[0, 1, 2].map((index) => (
                <div key={index} className="flex items-center gap-3 px-2 py-2">
                  <div className="w-10 h-10 rounded-md bg-ink/[0.05] animate-pulse" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-40 rounded bg-ink/[0.06] animate-pulse" />
                    <div className="h-2.5 w-24 rounded bg-ink/[0.05] animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Страницы: внутри загруженного — мгновенно, дальше — догрузка */}
          <PaginationBar
            page={page}
            total={totalPages}
            hasMore={hasMore}
            busy={busy || loadingMore}
            onGo={(target) => void goToPage(target)}
          />
        </div>
      )}

      {/* Окно выбора: спрашивается, только пока выбор не запомнен */}
      <DownloadChoiceModal
        open={choiceFor !== null}
        trackTitle={choiceFor?.track.title}
        trackSaved={choiceFor?.trackSaved ?? false}
        lyricsSaved={choiceFor?.lyricsSaved ?? false}
        defaultChoice={downloadChoice}
        remembered={choiceRemembered}
        onClose={() => setChoiceFor(null)}
        onConfirm={(choice, remember) => {
          const target = choiceFor?.track;
          setChoiceFor(null);
          if (remember) setDownloadChoice(choice, true);
          if (target) void saveOffline(target, choice);
        }}
      />

    </div>
  );
}
