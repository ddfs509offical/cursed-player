import { create } from "zustand";
import { playerAudio, clearSource, loadSource, setRepeatMode, toPlayableUrl } from "../player/audio";
import { pickAudioFiles, type LocalTrack } from "../services/player";
import { getServiceToken, prefetchSoundcloudStream, refreshServiceStream } from "../services/catalog";
import { serviceFromTrackId } from "../lib/services";
import { decideServicePlayback, hasNetwork, offlineFailureMessage } from "../lib/offline";
import { errorText, logError } from "./errorStore";
import { useOfflineStore, ensureOfflineLoaded } from "./offlineStore";

export interface Track {
  /** Для локальных файлов это путь, для сервисных — «сервис:id». */
  id: string;
  /** Локальный путь или ссылка на поток. */
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number;
  source: "local" | "service";
  /** Обложка: ссылка или путь, полученный из тегов файла. */
  cover?: string | null;
}

export function trackFromLocal(track: LocalTrack): Track {
  return {
    id: track.path,
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
    source: "local",
    cover: track.cover ?? null,
  };
}

/** Догруженные метаданные для уже стоящего в очереди трека. */
export interface TrackPatch {
  id: string;
  title?: string | null;
  artist?: string | null;
  cover?: string | null;
}

/**
 * Название выглядит как идентификатор: у старых лайков SoundCloud в очередь
 * попало «soundcloud:2398675908», и его нужно заменить настоящим именем.
 */
function titleLooksLikeId(track: Track): boolean {
  return !track.title.trim() || track.title === track.id;
}

/** Пустое поле: null, пустая строка или строка из пробелов. */
function isEmpty(value: string | null | undefined): boolean {
  return !value || !value.trim();
}

type RepeatMode = "off" | "all" | "one";

/**
 * Позиция ползунка (0..1) превращается в реальную громкость аудио.
 * Кривая восприятия: без неё уже в начале шкалы звук почти максимальный
 * и «тихо» всё равно звучит громко.
 */
export function sliderToVolume(position: number): number {
  const value = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0;
  return Math.min(1, Math.max(0, Math.pow(value, 2.5)));
}

/** Ставит на аудиоэлемент громкость, соответствующую позиции ползунка. */
export function applyVolume(position: number): void {
  if (playerAudio) playerAudio.volume = sliderToVolume(position);
}

const PERSIST_KEY = "music_hub_player_state_v1";
/** Позиции треков: чтобы после закрытия приложения продолжать с того же места. */
let positions: Record<string, number> = {};
let lastPersist = 0;

interface Persisted {
  queue: Track[];
  index: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Скорость воспроизведения: 1 — обычная. */
  speed: number;
  positions: Record<string, number>;
}

function persistNow(force = false) {
  const now = Date.now();
  if (!force && now - lastPersist < 5000) return;
  lastPersist = now;
  const { queue, index, volume, shuffle, repeat, speed } = usePlayerStore.getState();
  const payload: Persisted = { queue, index, volume, shuffle, repeat, speed, positions };
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(payload));
  } catch {
    // Переполнение хранилища не должно ломать плеер
  }
}

interface PlayerState {
  isPlaying: boolean;
  hasStarted: boolean;
  progress: number;
  /** Позиция ползунка громкости 0..1 — на аудио уходит её кривая (см. sliderToVolume). */
  volume: number;
  trackTitle: string;
  trackArtist: string;

  queue: Track[];
  index: number;
  position: number;
  durationMs: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Скорость воспроизведения: 1 — обычная. */
  speed: number;
  error: string | null;
  /** Идёт получение свежей ссылки на поток (сервисный трек). */
  isLoading: boolean;

  play: (title: string, artist: string) => void;
  setTrack: (title: string, artist: string) => void;
  togglePlay: () => void;
  setVolume: (value: number) => void;
  setProgress: (value: number) => void;
  previous: () => void;
  next: () => void;
  seekFraction: (fraction: number) => void;
  /**
   * Перемотка на абсолютное время в секундах (клик по строке текста).
   * Тот же путь, что у `seekFraction` — позиция аудио, `position`/`progress` и
   * сохранённая позиция трека, — но работает и когда длительность ещё
   * неизвестна: тогда это единственный доступный способ перемотки.
   */
  seekTo: (seconds: number) => void;
  /** Забыть сохранённую позицию (трек дослушан). */
  forgetPosition: () => void;
  setPosition: (seconds: number) => void;
  setDuration: (ms: number) => void;
  onTrackEnded: () => void;

  openFiles: () => Promise<number>;
  playLocal: (tracks: Track[], startIndex?: number) => void;
  playNow: (track: Track) => void;
  addToQueue: (tracks: Track[]) => void;
  /**
   * Вставляет треки сразу после текущего, не меняя текущий индекс, позицию и
   * воспроизведение. Так «Волна» ставит похожие треки вперёд собственного
   * списка: нажал «следующий» — играет волна, а не конец очереди.
   */
  insertAfterCurrent: (tracks: Track[]) => void;
  /**
   * Догружает названия/исполнителя/обложку в уже стоящие в очереди треки.
   * Нужно для старых лайков SoundCloud: в очереди у них лежит идентификатор
   * («soundcloud:2398675908») вместо названия — очередь хранится в localStorage
   * и сама по себе не обновляется.
   */
  patchTracks: (items: TrackPatch[]) => void;
  jumpTo: (index: number) => void;
  removeAt: (index: number) => void;
  clearQueue: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setSpeed: (value: number) => void;
}

/* ─────────────── Загрузка трека в плеер ─────────────── */

/**
 * Ссылка на поток сервиса (SoundCloud) живёт недолго, а в очереди у сервисных
 * треков path может быть пустым: у лайков из «Избранного» хранится только id,
 * ссылку выдаёт сервис перед стартом. Поэтому сервисный трек грузим через
 * refreshServiceStream, а уже полученную ссылку держим в памяти — тогда
 * перелистывание туда-обратно не дёргает сеть.
 */
const SERVICE_URL_TTL_MS = 10 * 60 * 1000;
/** id трека → { ссылка, когда получена }. Живёт только в текущем сеансе. */
const serviceUrls = new Map<string, { url: string; at: number }>();

/**
 * Уже выполняющиеся запросы ссылок: id → промис со ссылкой. Если пользователь
 * быстро пролистал трек туда-обратно, второй запрос к сервису не нужен —
 * оба включения ждут один и тот же ответ.
 */
const pendingStreams = new Map<string, Promise<string>>();

/** Свежая (полученная меньше 10 минут назад) ссылка из памяти. */
function cachedServiceUrl(id: string): string | null {
  const entry = serviceUrls.get(id);
  if (!entry) return null;
  if (Date.now() - entry.at >= SERVICE_URL_TTL_MS) {
    serviceUrls.delete(id);
    return null;
  }
  return entry.url;
}

function rememberServiceUrl(id: string, url: string): void {
  if (!id || !url) return;
  const now = Date.now();
  serviceUrls.set(id, { url, at: now });
  // Заодно выбрасываем просроченное, чтобы карта не росла бесконечно
  for (const [key, entry] of serviceUrls) {
    if (now - entry.at >= SERVICE_URL_TTL_MS) serviceUrls.delete(key);
  }
}

/**
 * Помечает только что добытую ссылку свежей. Страница уже сходила за ней через
 * `refreshServiceStream` и сейчас поставит трек в очередь: без этой пометки
 * плеер пошёл бы за той же ссылкой второй раз, задерживая первый звук. Здесь
 * помечается ровно та ссылка, которую вызывающий код только что получил, —
 * устаревшие пути из очереди по-прежнему не считаются свежими.
 */
export function markFreshStream(track: Track): void {
  if (track.source === "service" && /^https?:\/\//i.test(track.path)) {
    rememberServiceUrl(track.id, track.path);
  }
}

/**
 * Свежая ссылка на поток сервисного трека. Один запрос на трек: повторные
 * обращения, пока ответ не пришёл, ждут тот же промис. Ошибка не кешируется —
 * следующий заход попробует получить ссылку снова.
 */
function requestServiceUrl(track: Track): Promise<string> {
  const pending = pendingStreams.get(track.id);
  if (pending) return pending;

  const request = refreshServiceStream(track)
    .then((fresh) => {
      if (!fresh.path) {
        throw new Error("Сервис не отдал ссылку на поток — проверь подключение сервиса в настройках");
      }
      return fresh.path;
    })
    .finally(() => {
      pendingStreams.delete(track.id);
    });

  pendingStreams.set(track.id, request);
  return request;
}

/**
 * Предзагрузка СЛЕДУЮЩЕГО трека очереди, пока играет текущий: ссылка на поток
 * добывается заранее, соединение с сервером прогревается. Это и есть то самое
 * «долго начинается воспроизведение»: следующий трек стартует уже с готовой
 * ссылкой. Трек без id (или не из сервиса) просто пропускаем — очередь от
 * этого не ломается.
 */
function prefetchNextTrack(): void {
  const { queue, index } = usePlayerStore.getState();
  const next = queue[index + 1];
  if (!next || next.source !== "service" || !next.id) return;
  if (cachedServiceUrl(next.id) || pendingStreams.has(next.id)) return;
  // Предзагрузка умеет только SoundCloud: у остальных сервисов ссылку не
  // достать без их собственного входа.
  if (serviceFromTrackId(next.id) !== "soundcloud") return;

  const trackId = next.id.split(":")[1] ?? "";
  if (!trackId) return;

  const request = getServiceToken("soundcloud")
    .then((clientId) => {
      if (!clientId) throw new Error("SoundCloud не подключён");
      return prefetchSoundcloudStream(clientId, trackId);
    })
    .then((url) => {
      if (!url) throw new Error("Сервис не отдал ссылку на поток");
      rememberServiceUrl(next.id, url);
      return url;
    })
    .catch(() => "");

  pendingStreams.set(next.id, request);
  void request.finally(() => {
    pendingStreams.delete(next.id);
  });
}

/**
 * Номер текущей загрузки. Пока ссылка едет по сети, пользователь может
 * перелистнуть трек — результат устаревшей загрузки применять нельзя.
 */
let loadSeq = 0;
/** Отменяет незавершённую загрузку (очередь очистили или сменили целиком). */
function cancelPendingLoad(): void {
  loadSeq += 1;
}

/**
 * Растёт, когда пользователь нажал паузу. Нужен, чтобы отложенный запуск
 * сервисного трека не включил музыку после паузы: ссылка едет по сети, и
 * пауза может случиться уже после того, как трек попросили включить.
 */
let pauseEpoch = 0;

/** Пишет свежую ссылку в очередь, чтобы трек можно было переиграть без сети. */
function applyServiceUrl(id: string, url: string): void {
  rememberServiceUrl(id, url);
  usePlayerStore.setState((state) => {
    let changed = false;
    const queue = state.queue.map((item) => {
      if (item.id !== id || item.path === url) return item;
      changed = true;
      return { ...item, path: url };
    });
    return changed ? { queue } : {};
  });
  persistNow(true);
}

/** Ставит источник в плеер и при необходимости запускает воспроизведение. */
function startTrack(path: string, autoplay: boolean): void {
  loadSource(toPlayableUrl(path));
  if (playerAudio) playerAudio.playbackRate = usePlayerStore.getState().speed;
  if (autoplay && playerAudio) void playerAudio.play().catch(() => {});
}

/**
 * Понятный отказ вместо ожидания сети: копии нет, играть нечем. Такое
 * сообщение важнее технической ошибки сервиса — оно объясняет, что трек
 * просто не сохранён офлайн, и человек знает, что делать дальше.
 */
function failLoad(track: Track, message: string, details?: unknown): void {
  logError(
    "Не удалось включить трек",
    `${track.title} — ${track.artist ?? "неизвестный исполнитель"}: ${message}`,
    "плеер",
    details === undefined ? undefined : errorText(details)
  );
  // То же состояние ошибки, что ставит обработчик ошибки аудиоэлемента
  usePlayerStore.setState({ isLoading: false, error: message, isPlaying: false });
}

/**
 * Загружает трек в плеер. Локальные файлы играют со своего пути, сохранённые
 * офлайн — тоже с диска (это приоритетнее сети), а остальным сервисным трекам
 * сначала берём свежую ссылку (у них path может быть пустым или истёкшим).
 */
async function loadInto(track: Track | undefined, autoplay: boolean): Promise<void> {
  if (!playerAudio) return;
  const seq = ++loadSeq;
  const epoch = pauseEpoch;

  if (!track) {
    usePlayerStore.setState({ isLoading: false });
    playerAudio.pause();
    playerAudio.removeAttribute("src");
    return;
  }

  // Локальные файлы не трогаем: у них настоящий путь
  if (track.source !== "service") {
    usePlayerStore.setState({ isLoading: false });
    startTrack(track.path, autoplay);
    return;
  }

  // Пока играет этот трек, готовим следующий: ссылка и соединение заранее.
  // Ошибка предзагрузки ничего не меняет — плеер спросит ссылку сам.
  prefetchNextTrack();

  /**
   * Офлайн-копия важнее и сети, и кеша ссылок: если трек сохранён, он играет
   * с диска, и в интернет мы не ходим вовсе. Но ждать чтения индекса на старте
   * трека нельзя: пока он читается, пользователь уже ждёт звук. Поэтому если
   * список ещё не в памяти — сразу идём в сеть за ссылкой, а индекс читаем
   * фоном: он понадобится следующему треку, текущий ничего не перезапускает.
   *
   * Единственное исключение — связи нет вовсе: там ждать сеть бессмысленно, а
   * без списка мы бы соврали «нет сохранённой копии». Ждём только диск.
   */
  const online = hasNetwork();
  if (!useOfflineStore.getState().loaded) {
    if (online) {
      void ensureOfflineLoaded();
    } else {
      await ensureOfflineLoaded();
      // Трек успели перелистнуть, пока читался список
      if (seq !== loadSeq) return;
    }
  }

  const decision = decideServicePlayback({
    trackId: track.id,
    entries: useOfflineStore.getState().list,
    cachedUrl: cachedServiceUrl(track.id),
    online,
  });

  // Локальная копия: играем файл с диска
  if (decision.action === "local") {
    usePlayerStore.setState({ isLoading: false, error: null });
    // Паузу могли нажать, пока читался список — тогда не включаем сами
    startTrack(decision.path, autoplay && epoch === pauseEpoch);
    return;
  }

  // Свежая ссылка из памяти: сеть не нужна
  if (decision.action === "url") {
    usePlayerStore.setState({ isLoading: false });
    startTrack(decision.path, autoplay);
    return;
  }

  // Копии нет и связи нет: ждать ответ сервиса бессмысленно, говорим прямо
  if (decision.action === "error") {
    failLoad(track, decision.message);
    return;
  }

  usePlayerStore.setState({ isLoading: true, error: null });
  try {
    const url = await requestServiceUrl(track);
    // Трек успели перелистнуть: чужой результат никому не нужен
    if (seq !== loadSeq) return;
    applyServiceUrl(track.id, url);
    usePlayerStore.setState({ isLoading: false });
    // Паузу нажали, пока ссылка ехала по сети — не включаем музыку сами
    startTrack(url, autoplay && epoch === pauseEpoch);
  } catch (e) {
    if (seq !== loadSeq) return;
    // Нет копии и сеть не ответила — объясняем это, а не отказ сервиса
    const message = offlineFailureMessage(e, false);
    logError(
      "Не удалось включить трек",
      `${track.title} — ${track.artist ?? "неизвестный исполнитель"}: ${message}`,
      "плеер",
      errorText(e)
    );
    // То же состояние ошибки, что ставит обработчик ошибки аудиоэлемента
    usePlayerStore.setState({ isLoading: false, error: message, isPlaying: false });
  }
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  isPlaying: false,
  hasStarted: false,
  progress: 0,
  volume: 0.8,
  trackTitle: "",
  trackArtist: "",

  queue: [],
  index: -1,
  position: 0,
  durationMs: 0,
  shuffle: false,
  repeat: "off",
  speed: 1,
  error: null,
  isLoading: false,

  play: (title, artist) =>
    set({ trackTitle: title, trackArtist: artist, isPlaying: true, hasStarted: true }),

  setTrack: (title, artist) => set({ trackTitle: title, trackArtist: artist }),

  togglePlay: () => {
    const { isPlaying, index } = get();
    if (index < 0) {
      void get().openFiles().then((count) => {
        if (count > 0) get().togglePlay();
      });
      return;
    }
    if (isPlaying) {
      // Отменяем отложенный запуск сервисного трека, который ещё грузится
      pauseEpoch += 1;
      playerAudio?.pause();
      set({ isPlaying: false });
      persistNow(true);
    } else {
      const audio = playerAudio;
      if (audio) {
        if (audio.duration && audio.currentTime >= audio.duration - 0.05) audio.currentTime = 0;
        void audio.play().catch((e) => set({ error: String(e), isPlaying: false }));
      }
      set({ isPlaying: true, hasStarted: true });
    }
  },

  setVolume: (value) => {
    // В состоянии и настройках живёт позиция ползунка, на аудио — её кривая
    const volume = Math.min(1, Math.max(0, value));
    applyVolume(volume);
    set({ volume });
    persistNow();
  },

  setProgress: (value) => set({ progress: value }),

  setPosition: (seconds) => {
    const { durationMs, queue, index } = get();
    const track = queue[index];
    // Запоминаем позицию только текущего трека: все остальные при следующем
    // запуске начнутся с начала. Если трек дослушан — позицию забываем.
    if (track) positions = { [track.id]: seconds };
    set({
      position: seconds,
      progress: durationMs > 0 ? Math.min(1, (seconds * 1000) / durationMs) : 0,
    });
    persistNow();
  },

  /** Трек дослушан или начат заново — сохранённая позиция больше не нужна. */
  forgetPosition: () => {
    positions = {};
    persistNow(true);
  },

  setDuration: (ms) => {
    set((s) => ({
      durationMs: ms,
      progress: ms > 0 ? Math.min(1, (s.position * 1000) / ms) : 0,
      queue: s.queue.map((track, i) =>
        i === s.index && track.durationMs === 0 ? { ...track, durationMs: ms } : track
      ),
    }));
  },

  seekFraction: (fraction) => {
    const audio = playerAudio;
    if (!audio) return;
    const { durationMs, queue, index } = get();
    // Длительность в состоянии может быть нулевой (поток ещё не сообщил её),
    // но перемотка в ноль от этого не должна пропадать: у повтора трека
    // другого пути к началу нет.
    const known =
      durationMs > 0
        ? durationMs / 1000
        : Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : null;
    if (known === null) {
      // Совсем ничего не знаем — хотя бы ставим начало и не считаем долю.
      if (fraction <= 0) {
        audio.currentTime = 0;
        set({ position: 0, progress: 0 });
      }
      return;
    }
    const seconds = Math.min(known, Math.max(0, fraction * known));
    audio.currentTime = seconds;
    // Позицию пишем только для текущего трека — чтобы после закрытия
    // приложения можно было продолжить именно его
    const track = queue[index];
    if (track) positions = { [track.id]: seconds };
    set({ position: seconds, progress: seconds / (durationMs / 1000) });
    persistNow(true);
  },

  /**
   * Перемотка на абсолютное время. Состояние воспроизведения не меняется:
   * играет — продолжает играть, на паузе — остаётся на паузе в новом месте.
   * Длительность берём из состояния, а если её там ещё нет — из самого аудио:
   * у только что загруженного трека `durationMs` может быть нулевым.
   */
  seekTo: (seconds) => {
    const audio = playerAudio;
    if (!audio || !Number.isFinite(seconds)) return;
    const { durationMs, queue, index } = get();
    const end =
      durationMs > 0
        ? durationMs / 1000
        : Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : null;
    const target = Math.max(0, end === null ? seconds : Math.min(seconds, end));
    audio.currentTime = target;
    // Позицию пишем только для текущего трека — как и у остальных перемоток
    const track = queue[index];
    if (track) positions = { [track.id]: target };
    set({ position: target, progress: end && end > 0 ? Math.min(1, target / end) : 0 });
    persistNow(true);
  },

  jumpTo: (target) => {
    const { queue } = get();
    if (target < 0 || target >= queue.length) return;
    const track = queue[target];
    const resume = positions[track.id] ?? 0;
    set({
      index: target,
      trackTitle: track.title,
      trackArtist: track.artist ?? "",
      isPlaying: true,
      hasStarted: true,
      position: resume,
      durationMs: track.durationMs,
      progress: track.durationMs > 0 ? Math.min(1, (resume * 1000) / track.durationMs) : 0,
      error: null,
    });
    void loadInto(track, true);
    // Продолжаем трек с сохранённого места (даже после полного закрытия)
    if (playerAudio && resume > 3) {
      const once = () => {
        if (playerAudio) playerAudio.currentTime = resume;
        playerAudio?.removeEventListener("loadedmetadata", once);
      };
      playerAudio.addEventListener("loadedmetadata", once);
    }
    persistNow(true);
  },

  previous: () => {
    const { index, queue, position } = get();
    if (index < 0) return;
    if (position > 3) {
      get().seekFraction(0);
      return;
    }
    get().jumpTo(index > 0 ? index - 1 : queue.length - 1);
  },

  next: () => {
    const { index, queue, shuffle } = get();
    if (index < 0 || !queue.length) return;
    if (shuffle && queue.length > 1) {
      let target = index;
      while (target === index) target = Math.floor(Math.random() * queue.length);
      get().jumpTo(target);
      return;
    }
    get().jumpTo(index + 1 < queue.length ? index + 1 : 0);
  },

  onTrackEnded: () => {
    const { repeat, index, queue } = get();
    if (repeat === "one") {
      get().seekFraction(0);
      void playerAudio?.play().catch(() => {});
      return;
    }
    const isLast = index >= queue.length - 1;
    if (isLast && repeat === "off") {
      playerAudio?.pause();
      set({ isPlaying: false, progress: 0, position: 0 });
      persistNow(true);
      return;
    }
    get().next();
  },

  openFiles: async () => {
    try {
      const files = await pickAudioFiles();
      if (!files.length) return 0;
      const tracks = files.map(trackFromLocal);
      const { queue } = get();
      set({ queue: [...queue, ...tracks], error: null });
      get().jumpTo(queue.length);
      persistNow(true);
      return tracks.length;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return 0;
    }
  },

  playLocal: (tracks, startIndex = 0) => {
    if (!tracks.length) return;
    set({ queue: tracks, error: null });
    get().jumpTo(Math.min(Math.max(0, startIndex), tracks.length - 1));
  },

  /** Ставит трек (в том числе сервисный) в конец очереди и включает его. */
  playNow: (track) => {
    const { queue } = get();
    /**
     * playNow всегда получает трек сразу после refreshServiceStream или
     * soundcloudStreamUrl, то есть ссылка только что добыта. Помечаем её
     * свежей, чтобы плеер не сходил в сеть второй раз перед воспроизведением.
     */
    markFreshStream(track);
    const withoutSame = queue.filter((item) => item.id !== track.id);
    const merged = [...withoutSame, track];
    set({ queue: merged, error: null });
    get().jumpTo(merged.length - 1);
  },

  addToQueue: (tracks) => {
    if (!tracks.length) return;
    const { queue, index } = get();
    const merged = [...queue, ...tracks];
    set({ queue: merged });
    if (index < 0) get().jumpTo(0);
    persistNow(true);
  },

  /**
   * Треки встают сразу после текущего (splice(index + 1, 0, ...tracks)).
   * Текущий индекс не меняется, потому что сдвигается только хвост очереди;
   * позиция, воспроизведение и сохранённая позиция трека не трогаются — звук
   * продолжается без перезагрузки источника. Пустая очередь (или ещё не
   * выбранный трек) ведёт себя как `addToQueue`.
   */
  insertAfterCurrent: (tracks) => {
    if (!tracks.length) return;
    const { queue, index } = get();
    // Текущего трека нет — обычное добавление (и старт, как у addToQueue)
    if (index < 0) {
      set({ queue: [...queue, ...tracks] });
      get().jumpTo(0);
      persistNow(true);
      return;
    }
    const merged = [...queue.slice(0, index + 1), ...tracks, ...queue.slice(index + 1)];
    set({ queue: merged });
    persistNow(true);
  },

  /**
   * Обновляет совпадающие по id треки очереди: название — только если оно
   * пустое или выглядит как идентификатор, исполнитель и обложка — только если
   * пустые. Порядок, текущая позиция и воспроизведение не трогаются.
   */
  patchTracks: (items) => {
    if (!items.length) return;
    const patches = new Map(items.map((item) => [item.id, item]));
    const { queue, index } = get();
    const current = queue[index];
    let changed = false;

    const next = queue.map((track) => {
      const patch = patches.get(track.id);
      if (!patch) return track;
      const title = titleLooksLikeId(track) && !isEmpty(patch.title) ? patch.title!.trim() : track.title;
      const artist = isEmpty(track.artist) && !isEmpty(patch.artist) ? patch.artist! : track.artist;
      const cover = isEmpty(track.cover) && !isEmpty(patch.cover) ? patch.cover! : track.cover ?? null;
      if (title === track.title && artist === track.artist && cover === (track.cover ?? null)) return track;
      changed = true;
      return { ...track, title, artist, cover };
    });

    if (!changed) return;
    // Строка «сейчас играет» живёт отдельно от очереди — синхронизируем её,
    // если патч затронул текущий трек.
    const patchedCurrent = current ? next[index] : undefined;
    set({
      queue: next,
      ...(current && patchedCurrent && patchedCurrent !== current
        ? { trackTitle: patchedCurrent.title, trackArtist: patchedCurrent.artist ?? "" }
        : {}),
    });
    persistNow(true);
  },

  removeAt: (target) => {
    const { queue, index } = get();
    if (target < 0 || target >= queue.length) return;
    const next = queue.filter((_, i) => i !== target);
    set({ queue: next });
    if (!next.length) {
      cancelPendingLoad();
      playerAudio?.pause();
      set({
        index: -1,
        isPlaying: false,
        isLoading: false,
        trackTitle: "",
        trackArtist: "",
        progress: 0,
        position: 0,
        durationMs: 0,
      });
      persistNow(true);
      return;
    }
    if (target < index) set({ index: index - 1 });
    else if (target === index) get().jumpTo(Math.min(index, next.length - 1));
    persistNow(true);
  },

  clearQueue: () => {
    cancelPendingLoad();
    playerAudio?.pause();
    set({
      queue: [],
      index: -1,
      isPlaying: false,
      isLoading: false,
      trackTitle: "",
      trackArtist: "",
      progress: 0,
      position: 0,
      durationMs: 0,
    });
    positions = {};
    persistNow(true);
  },

  toggleShuffle: () => {
    set((s) => ({ shuffle: !s.shuffle }));
    persistNow(true);
  },

  cycleRepeat: () => {
    set((s) => ({ repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off" }));
    // Аудиоэлемент владеет повтором сам: его подписка на `ended` живёт дольше
    // обработчиков компонента и не теряется при перемонтировании.
    setRepeatMode(get().repeat);
    persistNow(true);
  },

  setSpeed: (value) => {
    // Диапазон как у обычных плееров: медленнее и быстрее, но без крайностей,
    // где звук уже превращается в шум. Скорость живёт на аудиоэлементе, поэтому
    // переживает переключение треков: её заново ставит startTrack.
    const speed = Math.min(2, Math.max(0.5, Math.round(value * 100) / 100));
    if (playerAudio) playerAudio.playbackRate = speed;
    set({ speed });
  },
}));

/**
 * Полная остановка плеера: выход из профиля и переключение на другой аккаунт.
 * Музыка и очередь не должны «переезжать» в чужой профиль, поэтому глушим звук,
 * забываем очередь, позиции треков и сохранённое состояние.
 */
export function resetPlayback() {
  cancelPendingLoad();
  playerAudio?.pause();
  clearSource();
  positions = {};
  usePlayerStore.setState({
    queue: [],
    index: -1,
    position: 0,
    durationMs: 0,
    progress: 0,
    isPlaying: false,
    isLoading: false,
    hasStarted: false,
    error: null,
    trackTitle: "",
    trackArtist: "",
  });
  persistNow(true);
}

/**
 * Возвращает очередь, громкость, режимы и позицию трека после перезапуска.
 * Вызывается один раз при старте приложения.
 */
export function restorePlayerState() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Persisted>;
    const queue = Array.isArray(saved.queue) ? saved.queue : [];
    positions = saved.positions && typeof saved.positions === "object" ? saved.positions : {};

    const rawIndex = typeof saved.index === "number" ? saved.index : -1;
    const index = queue.length ? Math.min(Math.max(0, rawIndex), queue.length - 1) : -1;
    const track = index >= 0 ? queue[index] : undefined;
    const resume = track ? positions[track.id] ?? 0 : 0;

    usePlayerStore.setState({
      queue,
      index,
      volume: typeof saved.volume === "number" ? saved.volume : 0.8,
      shuffle: Boolean(saved.shuffle),
      repeat: saved.repeat ?? "off",
      speed:
        typeof saved.speed === "number" && Number.isFinite(saved.speed)
          ? Math.min(2, Math.max(0.5, saved.speed))
          : 1,      trackTitle: track?.title ?? "",
      trackArtist: track?.artist ?? "",
      hasStarted: Boolean(track),
      isPlaying: false,
      position: resume,
      durationMs: track?.durationMs ?? 0,
      progress: track && track.durationMs > 0 ? Math.min(1, (resume * 1000) / track.durationMs) : 0,
    });

    // Сохранённый режим повтора сообщаем аудио: оно само перезапускает трек.
    setRepeatMode(saved.repeat ?? "off");

    if (playerAudio && track) {
      // В сохранённом состоянии лежит позиция ползунка — на аудио ставим кривую
      applyVolume(typeof saved.volume === "number" ? saved.volume : 0.8);
      /**
       * Ссылку берём тем же путём, что и при обычном включении: у сервисного
       * трека в сохранённой очереди path пустой (лайк из «Избранного») или уже
       * истёк — её нужно получить заново. Автовоспроизведения тут нет.
       */
      void loadInto(track, false);
      if (resume > 3) {
        const once = () => {
          if (playerAudio) playerAudio.currentTime = resume;
          playerAudio?.removeEventListener("loadedmetadata", once);
        };
        playerAudio.addEventListener("loadedmetadata", once);
      }
    }
  } catch {
    // Битое состояние не должно мешать запуску
  }
}

// В режиме разработки состояние плеера доступно из консоли и автотестов
if (import.meta.env.DEV) {
  (window as unknown as { __playerStore?: unknown }).__playerStore = usePlayerStore;
}
