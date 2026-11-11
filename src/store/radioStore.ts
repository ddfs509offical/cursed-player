/**
 * «Волна» — радио из похожих треков вокруг текущего.
 *
 * Режим сессии: состояние живёт в памяти и при старте всегда выключено —
 * включать музыку «сама» без просьбы нельзя.
 *
 * Волна идёт НЕПРЕРЫВНЫМ БЛОКОМ сразу после текущего трека, а не в конец
 * очереди: нажал «следующий» — играет похожий трек, а не собственный список,
 * до которого надо домотать. Вставкой занимается
 * `playerStore.insertAfterCurrent`, удалением и пересчётом — чистые функции
 * ниже (см. `waveInsertIndex`, `removeWaveTracks`).
 *
 * Докидывание: когда после текущего остаётся не больше двух волновых треков,
 * просим у SoundCloud порцию и продолжаем блок — сразу после последнего
 * волнового. Порция — пятнадцать треков из трёх источников: похожие треки
 * (~60 %), треки похожих артистов (~25 %, не больше двух на артиста) и треки
 * жанра текущего трека (~15 %). Внутри порции ни один артист не идёт больше
 * двух треков подряд, а сам артист-источник даёт не больше двух треков.
 * Нехватку источников добираем тем, что есть, — пустая волна хуже однообразия.
 * Следующая порция строится от того трека, который играет в этот момент,
 * поэтому ручной переход тоже продолжает волну.
 *
 * Ручной уход на свой трек перестраивает волну: старые волновые удаляются,
 * новые встают после выбранного трека. При выключении волновые треки (кроме
 * играющего) из очереди убираются — очередь возвращается к своему списку.
 *
 * Защита от бесконечных запросов:
 * * порция кешируется на 10 минут по треку-источнику;
 * * после неудачной порции этот же трек больше не спрашиваем, пока не сменится
 *   текущий (или не включат Wave заново);
 * * три неудачные порции подряд выключают режим и показывают тост.
 *
 * Повтор важнее волны: при repeat-one и repeat-all ничего не докидываем,
 * иначе режимы начнут спорить друг с другом. Перемешивание с волной
 * несовместимо (порядок очереди ведёт shuffle), поэтому при включённом shuffle
 * волна не включается и честно предупреждает тостом.
 */

import { create } from "zustand";
import { favoriteKeyFor } from "../lib/favoriteKey";
import { pickBestPerSongKey, songArtist, songKey } from "../lib/songKey";
import { serviceFromTrackId } from "../lib/services";
import {
  getServiceToken,
  soundcloudArtistTop,
  soundcloudGenreTracks,
  soundcloudRelated,
  soundcloudRelatedArtists,
  soundcloudTracks,
  soundcloudUser,
  type SearchTrack,
  type SoundcloudUser,
} from "../services/catalog";
import { usePlayerStore, type Track } from "./playerStore";
import { toast } from "./toastStore";

/** Сколько треков в порции и как их делят источники. */
const PORTION_SIZE = 15;
/** Похожие треки — основа волны, ~60 %. */
const RELATED_LIMIT = 15;
const RELATED_QUOTA = 9;
/** Похожие артисты, ~25 %: по паре треков с артиста. */
const ARTIST_QUOTA = 4;
const ARTIST_TOP_LIMIT = 2;
const RELATED_ARTISTS_LIMIT = 6;
/** Жанр текущего трека — ~15 %. */
const GENRE_QUOTA = PORTION_SIZE - RELATED_QUOTA - ARTIST_QUOTA;
const GENRE_LIMIT = 6;
/** Артист-источник: не больше двух его треков в порции. */
const SEED_ARTIST_LIMIT = 2;
/** После текущего осталось столько волновых — пора докидывать. */
const LOOKAHEAD = 2;
/** Столько неудачных порций подряд — и Wave выключается. */
const MAX_MISSES = 3;
/** Свежесть кеша порций: чаще десяти минут API не дёргаем. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/* ─────────────── Чистая логика волны (без zustand) ─────────────── */

/** Канонический ключ трека — те же правила, что у лайков. */
export function waveKeyOf(track: Track | undefined): string {
  if (!track) return "";
  return favoriteKeyFor(track);
}

/**
 * Куда ставить следующую порцию: сразу после последнего волнового трека,
 * который стоит после текущего (волна — непрерывный блок). Волновых после
 * текущего нет — сразу после текущего. Текущего нет — в конец очереди.
 */
export function waveInsertIndex(
  queue: Track[],
  index: number,
  waveIds: ReadonlySet<string>
): number {
  if (index < 0 || index >= queue.length) return queue.length;
  let at = index + 1;
  for (let i = index + 1; i < queue.length; i += 1) {
    if (waveIds.has(waveKeyOf(queue[i]))) at = i + 1;
  }
  return Math.min(at, queue.length);
}

/** Сколько волновых треков стоит после текущего (по волновым, не по всей очереди). */
export function waveRemainingAfter(
  queue: Track[],
  index: number,
  waveIds: ReadonlySet<string>
): number {
  let count = 0;
  for (let i = Math.max(0, index + 1); i < queue.length; i += 1) {
    if (waveIds.has(waveKeyOf(queue[i]))) count += 1;
  }
  return count;
}

/**
 * Отбрасывает из порции то, что уже стоит в очереди, уже вставлено волной
 * (в том числе осталось от прошлого сеанса) и сам трек-источник. Дубли внутри
 * порции тоже схлопываются: в очередь не должен попасть один трек дважды —
 * ни по каноническому id, ни по сути трека (`songKey` ловит перезаливы).
 */
export function pickWaveCandidates(
  items: Track[],
  queue: Track[],
  waveIds: ReadonlySet<string>,
  seedKey = "",
  seedSongKey = ""
): Track[] {
  const known = new Set(queue.map((track) => waveKeyOf(track)));
  const knownSongs = new Set(
    queue.map((track) => songKey(track)).filter((key) => !!key)
  );
  const fresh: Track[] = [];
  for (const item of items) {
    const key = waveKeyOf(item);
    if (!key || key === seedKey || known.has(key) || waveIds.has(key)) continue;
    const song = songKey(item);
    if (song && (song === seedSongKey || knownSongs.has(song))) continue;
    known.add(key);
    if (song) knownSongs.add(song);
    fresh.push(item);
  }
  return fresh;
}

/**
 * Порция из трёх источников в заданной пропорции. Дубли между источниками
 * схлопываются по сути трека и по id; недобор одного источника добирается
 * остатками других — лучше чуть больше похожих, чем пустая волна.
 */
export function composeWavePortion(
  related: SearchTrack[],
  artists: SearchTrack[],
  genre: SearchTrack[]
): SearchTrack[] {
  const used = new Set<string>();
  const chosen: SearchTrack[] = [];

  const take = (pool: SearchTrack[], quota: number): void => {
    let taken = 0;
    for (const item of pool) {
      if (taken >= quota) break;
      const song = songKey(item);
      const id = String(item.id ?? "").trim();
      if ((song && used.has(`s:${song}`)) || (id && used.has(`i:${id}`))) continue;
      if (song) used.add(`s:${song}`);
      if (id) used.add(`i:${id}`);
      chosen.push(item);
      taken += 1;
    }
  };

  take(related, RELATED_QUOTA);
  take(artists, ARTIST_QUOTA);
  take(genre, GENRE_QUOTA);
  if (chosen.length < PORTION_SIZE) {
    // Источники недодали — добираем тем, что есть
    take([...related, ...artists, ...genre], PORTION_SIZE - chosen.length);
  }
  return chosen;
}

/**
 * Перемешивает порцию так, чтобы один артист не шёл больше двух треков подряд,
 * и не даёт артисту-источнику занять всю порцию (максимум два его трека).
 * Когда выбора нет (всё одного артиста) — оставляем как есть, но не падаем.
 */
export function diversifyPortion(items: SearchTrack[], seedArtist = ""): SearchTrack[] {
  const seed = seedArtist.trim() ? songArtist({ artist: seedArtist }) : "";
  const pool: SearchTrack[] = [];
  let seedTracks = 0;
  for (const item of items) {
    if (seed && songArtist(item) === seed) {
      if (seedTracks >= SEED_ARTIST_LIMIT) continue;
      seedTracks += 1;
    }
    pool.push(item);
  }

  const ordered: SearchTrack[] = [];
  while (pool.length) {
    let pick = 0;
    for (let i = 0; i < pool.length; i += 1) {
      const artist = songArtist(pool[i]);
      const last = ordered.length >= 1 ? songArtist(ordered[ordered.length - 1]) : "";
      const before = ordered.length >= 2 ? songArtist(ordered[ordered.length - 2]) : "";
      if (!(artist === last && artist === before)) {
        pick = i;
        break;
      }
    }
    ordered.push(pool.splice(pick, 1)[0]);
  }
  return ordered;
}

export interface WaveRemovalResult {
  /** Очередь без волновых треков (кроме играющего). */
  queue: Track[];
  /** Индекс того же играющего трека после удаления. */
  index: number;
  /** Обновлённые волновые ключи: играющий волновой из них уже убран. */
  waveIds: Set<string>;
  /** Сколько треков удалено. */
  removed: number;
}

/**
 * Убирает из очереди все волновые треки, кроме текущего играющего. Индекс
 * пересчитывается на тот же трек, поэтому воспроизведение не сбивается:
 * текущий трек продолжает играть, а следующий — уже из своего списка.
 * Если играет волновой трек, он остаётся в очереди, но перестаёт считаться
 * волновым — при следующем выключении его уже не удалят.
 */
export function removeWaveTracks(
  queue: Track[],
  index: number,
  waveIds: ReadonlySet<string>
): WaveRemovalResult {
  const current = index >= 0 && index < queue.length ? queue[index] : undefined;
  const currentKey = waveKeyOf(current);

  const kept: Track[] = [];
  let removed = 0;
  let removedBefore = 0;
  queue.forEach((track, i) => {
    const isWave = waveIds.has(waveKeyOf(track));
    // Играющий трек не трогаем никогда: он звучит прямо сейчас
    if (isWave && i !== index) {
      removed += 1;
      if (i < index) removedBefore += 1;
      return;
    }
    kept.push(track);
  });

  // В waveIds остаются только волновые треки, которые правда ещё в очереди;
  // ключ играющего волнового убираем, чтобы его больше не считали волной.
  const nextIds = new Set<string>();
  for (const track of kept) {
    const key = waveKeyOf(track);
    if (key !== currentKey && waveIds.has(key)) nextIds.add(key);
  }

  // Текущий трек остался в очереди, поэтому его новый индекс — старый минус
  // удалённые перед ним. Очередь могла опустеть, если играющего не было вовсе.
  const nextIndex =
    index < 0 || !kept.length
      ? -1
      : Math.max(0, Math.min(kept.length - 1, index - removedBefore));

  return { queue: kept, index: nextIndex, waveIds: nextIds, removed };
}

/* ─────────────── Сеть и состояние ─────────────── */

interface CachedPortion {
  at: number;
  items: SearchTrack[];
}

/** Порции по треку-источнику. Только память: между запусками это не нужно. */
const cache = new Map<string, CachedPortion>();
/** Трек, для которого порция уже не дала ничего: второй раз не спрашиваем. */
let blockedSeed: string | null = null;
/** Один запрос за раз: быстрые переключения не плодят порции. */
let pending: Promise<void> | null = null;
/**
 * Сеанс, которому принадлежит `pending`. Запрос прошлого сеанса (волну
 * выключили и включили заново) может зависнуть навсегда — ждать его значит не
 * вставить ни одного трека, поэтому чужой запрос волну больше не задерживает.
 */
let pendingSession = -1;
/** Номер последнего запущенного запроса: снимать `pending` может только он. */
let pendingRun = 0;
/** Внутренняя правка очереди: подписка не должна реагировать сама на себя. */
let adjusting = false;

interface RadioState {
  enabled: boolean;
  /** Идёт запрос порции — кнопка показывает это точкой/спиннером. */
  loading: boolean;
  /** Неудачные порции подряд. */
  misses: number;
  /** Канонические ключи треков, которые вставила волна. */
  waveIds: Set<string>;
  /** Номер сеанса волны: ответы, приехавшие после перестройки/выключения, отбрасываются. */
  waveSession: number;
  /** Включить/выключить волну. Выключение убирает волновые треки из очереди. */
  toggle: () => void;
  /** Докиднуть порцию, если пора. `force` — по включению, без оглядки на хвост. */
  fill: (force?: boolean) => Promise<void>;
}

/** Трек SoundCloud, для которого волна имеет смысл. */
function isWaveTrack(track: Track | undefined): track is Track {
  return !!track && track.source === "service" && serviceFromTrackId(track.id) === "soundcloud";
}

/** Числовой id из «soundcloud:123». */
function rawTrackId(track: Track): string {
  const [, id] = track.id.split(":");
  return (id ?? "").trim();
}

/** Трек сервиса в форме, которую понимает плеер. */
function toTrack(item: SearchTrack): Track {
  const raw = String(item.id ?? "");
  return {
    id: raw.includes(":") ? raw : `soundcloud:${raw}`,
    // Ссылку на поток плеер спросит сам: сохранённая быстро истекает
    path: "",
    title: item.title || "Без названия",
    artist: item.artists || null,
    album: item.album ?? null,
    durationMs: item.durationMs ?? 0,
    source: "service",
    cover: item.cover ?? null,
  };
}

/** Свежая порция из кеша или из сети. */
async function candidates(track: Track, force: boolean): Promise<SearchTrack[]> {
  const seed = track.id;
  if (!force) {
    const cached = cache.get(seed);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;
  }

  const clientId = await getServiceToken("soundcloud");
  if (!clientId) throw new Error("SoundCloud: нужен client_id");
  const trackId = rawTrackId(track);
  if (!trackId) return [];

  // related — основной путь; ошибка или пустота ведут к трекам артиста
  let related: SearchTrack[] = [];
  /** Основной путь не ответил: пустота здесь — не «похожих нет». */
  let failed = false;
  try {
    related = await soundcloudRelated(clientId, trackId, RELATED_LIMIT);
  } catch {
    related = [];
    failed = true;
  }
  if (!related.length && track.artist?.trim()) {
    try {
      related = await soundcloudArtistTop(clientId, track.artist.trim(), RELATED_LIMIT);
      failed = false;
    } catch {
      related = [];
      failed = true;
    }
  }

  /*
   * Два дополнительных источника разнообразия: похожие артисты и жанр.
   * Их отказ — не сбой порции: волну доберут похожие треки, а не пустой экран.
   */
  const [artistTracks, genreItems] = await Promise.all([
    similarArtistTracks(clientId, track.artist ?? ""),
    genreTracks(clientId, trackId),
  ]);

  // Жанры выученных треков пригодятся следующей порции — без лишнего запроса
  for (const item of [...related, ...artistTracks, ...genreItems]) {
    const id = String(item.id ?? "").trim();
    const genre = (item.genre ?? "").trim();
    if (id && genre) rememberGenre(id, genre);
  }

  const items = diversifyPortion(
    composeWavePortion(
      pickBestPerSongKey(related),
      pickBestPerSongKey(artistTracks),
      pickBestPerSongKey(genreItems)
    ),
    track.artist ?? ""
  );

  /*
   * Ни один путь не ответил — это сбой связи, а не «похожих не нашлось».
   * Наружу отдаём ошибку, а пустую порцию в кеш не кладём: иначе первый же
   * сбой запомнился бы на десять минут, и волна молчала бы до перезапуска.
   */
  if (!items.length && failed) throw new Error("SoundCloud: похожие не ответили");

  cache.set(seed, { at: Date.now(), items });
  // Просроченные порции не держим: карта не должна расти бесконечно
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  return items;
}

/* ─────────────── Дополнительные источники волны ─────────────── */

/** Жанр трека, выученный из ответов SoundCloud: запрос за ним нужен один раз. */
const knownGenres = new Map<string, string>();

/** Запоминаем жанр трека; карта сеанса не должна расти бесконечно. */
function rememberGenre(id: string, genre: string): void {
  if (!id || !genre) return;
  knownGenres.set(id, genre);
  if (knownGenres.size <= 200) return;
  let extra = knownGenres.size - 200;
  for (const key of knownGenres.keys()) {
    if (extra <= 0) break;
    knownGenres.delete(key);
    extra -= 1;
  }
}

/**
 * Жанр текущего трека: из уже выученного или из его карточки. Пустая строка —
 * жанр неизвестен, и жанровый источник просто не участвует в порции.
 */
async function seedGenre(clientId: string, trackId: string): Promise<string> {
  if (!trackId) return "";
  const cached = knownGenres.get(trackId);
  if (cached !== undefined) return cached;
  let genre = "";
  try {
    const [info] = await soundcloudTracks([trackId]);
    genre = (info?.genre ?? "").trim();
  } catch {
    genre = "";
  }
  rememberGenre(trackId, genre);
  return genre;
}

/** Числовой id артиста по нику: related/followings ходят по id, а не по нику. */
const artistUserIds = new Map<string, string>();

/** id артиста: один раз разрешаем ник, дальше берём из кеша сеанса. */
async function artistUserId(clientId: string, artistName: string): Promise<string> {
  const name = artistName.trim();
  if (!name) return "";
  const cached = artistUserIds.get(name);
  if (cached !== undefined) return cached;
  let id = "";
  try {
    const profile = await soundcloudUser(clientId, name);
    id = String(profile.id ?? "").trim();
  } catch {
    id = "";
  }
  artistUserIds.set(name, id);
  if (artistUserIds.size > 200) {
    const [oldest] = artistUserIds.keys();
    if (oldest !== undefined) artistUserIds.delete(oldest);
  }
  return id;
}

/**
 * Треки похожих артистов: у каждого берём не больше двух. Артистов спрашиваем
 * с запасом, но останавливаемся, как только набрали четверть порции.
 */
async function similarArtistTracks(
  clientId: string,
  artistName: string
): Promise<SearchTrack[]> {
  const userId = await artistUserId(clientId, artistName);
  if (!userId) return [];

  let artists: SoundcloudUser[] = [];
  try {
    artists = await soundcloudRelatedArtists(clientId, userId, RELATED_ARTISTS_LIMIT);
  } catch {
    return [];
  }

  const tracks: SearchTrack[] = [];
  for (const artist of artists) {
    if (tracks.length >= ARTIST_QUOTA) break;
    const id = String(artist.id ?? "").trim();
    if (!id) continue;
    try {
      const top = await soundcloudArtistTop(clientId, id, ARTIST_TOP_LIMIT);
      tracks.push(...top.slice(0, ARTIST_TOP_LIMIT));
    } catch {
      // Артист не ответил — пробуем следующего, порция не должна падать
    }
  }
  return tracks;
}

/** Треки жанра текущего трека — третья часть порции. */
async function genreTracks(clientId: string, trackId: string): Promise<SearchTrack[]> {
  const genre = await seedGenre(clientId, trackId);
  if (!genre) return [];
  try {
    return await soundcloudGenreTracks(clientId, genre, GENRE_LIMIT);
  } catch {
    return [];
  }
}

/** Подменяет очередь, не трогая воспроизведение: индекс указывает на тот же трек. */
function applyQueue(queue: Track[], index: number): void {
  adjusting = true;
  try {
    usePlayerStore.setState({ queue, index });
  } finally {
    adjusting = false;
  }
}

/** Убирает волновые треки (кроме играющего), не останавливая музыку. */
function dropWaveTracks(): WaveRemovalResult {
  const player = usePlayerStore.getState();
  const result = removeWaveTracks(player.queue, player.index, useRadioStore.getState().waveIds);
  if (result.removed > 0) applyQueue(result.queue, result.index);
  return result;
}

/** Волна выключается сама: чистим очередь, ключи и сеанс. */
function turnOff(): void {
  if (!useRadioStore.getState().enabled) return;
  dropWaveTracks();
  useRadioStore.setState((state) => ({
    enabled: false,
    loading: false,
    misses: 0,
    waveIds: new Set<string>(),
    waveSession: state.waveSession + 1,
  }));
}

/** Отметить неудачную порцию и, если хватит, выключить волну. */
function registerMiss(seed: string, misses: number): void {
  // Волну уже выключили — неудача устаревшего запроса никого не касается
  if (!useRadioStore.getState().enabled) return;
  blockedSeed = seed;
  const next = misses + 1;
  if (next >= MAX_MISSES) {
    turnOff();
    toast({ title: "Wave: похожее не нашлось" });
    return;
  }
  useRadioStore.setState({ misses: next, loading: false });
}

export const useRadioStore = create<RadioState>((set, get) => ({
  enabled: false,
  loading: false,
  misses: 0,
  waveIds: new Set<string>(),
  waveSession: 0,

  toggle: () => {
    if (get().enabled) {
      // Выключили: волновые убираем, играющий остаётся и звучит дальше
      set({ enabled: false, loading: false, misses: 0 });
      dropWaveTracks();
      set((state) => ({ waveIds: new Set<string>(), waveSession: state.waveSession + 1 }));
      return;
    }
    const { queue, index, repeat, shuffle } = usePlayerStore.getState();
    const track = queue[index];
    if (!isWaveTrack(track)) {
      toast({ title: "Wave: включи трек SoundCloud" });
      return;
    }
    if (shuffle) {
      // Порядок очереди ведёт shuffle — волна вставилась бы в случайные места
      toast({ title: "Wave не работает при перемешивании" });
      return;
    }
    if (repeat !== "off") {
      // Волна и повтор спорят за очередь: сначала выключи повтор
      toast({ title: "Wave: сначала выключи повтор" });
      return;
    }
    blockedSeed = null;
    set((state) => ({
      enabled: true,
      loading: false,
      misses: 0,
      waveIds: new Set<string>(),
      waveSession: state.waveSession + 1,
    }));
    void get().fill(true);
  },

  fill: async (force = false) => {
    if (!get().enabled) return;
    const player = usePlayerStore.getState();
    const track = player.queue[player.index];
    if (!isWaveTrack(track)) return;
    // repeat-one/all — очередь ведёт повтор, волна не вмешивается
    if (player.repeat !== "off") return;
    // При перемешивании не вставляем: предупредили ещё в toggle
    if (player.shuffle) return;

    const waveIds = get().waveIds;
    const remaining = waveRemainingAfter(player.queue, player.index, waveIds);
    if (!force && remaining > LOOKAHEAD) return;
    if (!force && blockedSeed === track.id) return;

    const seed = track.id;
    const session = get().waveSession;
    /*
     * Чужой запрос (от прошлого сеанса) не ждём: он относится к другой очереди,
     * его ответ всё равно отбросит проверка сеанса, а зависнуть он может
     * навсегда. Именно из-за этого «включил волну» иногда не вставляло ничего,
     * пока волну не выключишь и не включишь заново.
     */
    if (pending && pendingSession === session) {
      // Один запрос за раз. Перестройке (force) мало дождаться чужого ответа:
      // он относится к старой очереди, поэтому после ожидания просим заново.
      if (!force) return pending;
      await pending;
      if (!get().enabled) return;
      return get().fill(force);
    }

    const run = ++pendingRun;
    const body = (async () => {
      set({ loading: true });
      let items: SearchTrack[];
      try {
        items = await candidates(track, force);
      } catch {
        /*
         * Первая порция могла не дойти из-за холодного старта: сеть, прокси и
         * client_id готовы не мгновенно. Без повтора первое включение молча
         * оставалось без треков (кнопка горит, очередь пустая), а «лечилось»
         * это выключением и повторным включением. Повторяем один раз.
         */
        try {
          items = await candidates(track, true);
        } catch {
          registerMiss(seed, get().misses);
          return;
        }
        if (!useRadioStore.getState().enabled) return;
        if (useRadioStore.getState().waveSession !== session) return;
      }

      // Пока порция ехала, волну могли выключить или перестроить
      if (!useRadioStore.getState().enabled) return;
      if (useRadioStore.getState().waveSession !== session) return;

      const snapshot = usePlayerStore.getState();
      const seedTrack = snapshot.queue[snapshot.index];
      let fresh = pickWaveCandidates(
        items.map(toTrack),
        snapshot.queue,
        useRadioStore.getState().waveIds,
        waveKeyOf(seedTrack),
        songKey(seedTrack)
      );
      /*
       * Пустая порция — ещё не приговор: в кеше могла лежать уже вставленная
       * порция, а у первого включения порция могла не дойти целиком. Один раз
       * идём в сеть заново: иначе первое включение молча оставалось без
       * треков, а «лечилось» выключением и повторным включением.
       */
      if (!fresh.length) {
        try {
          items = await candidates(track, true);
        } catch {
          registerMiss(seed, get().misses);
          return;
        }
        if (!useRadioStore.getState().enabled) return;
        if (useRadioStore.getState().waveSession !== session) return;
        const again = usePlayerStore.getState();
        const againSeed = again.queue[again.index];
        fresh = pickWaveCandidates(
          items.map(toTrack),
          again.queue,
          useRadioStore.getState().waveIds,
          waveKeyOf(againSeed),
          songKey(againSeed)
        );
      }

      if (!fresh.length) {
        registerMiss(seed, get().misses);
        return;
      }
      if (!useRadioStore.getState().enabled) return;
      if (useRadioStore.getState().waveSession !== session) return;

      // Порция могла устареть, пока ехала: вставляем от текущего состояния
      // очереди и ещё раз отбрасываем то, что уже успело встать
      const now = usePlayerStore.getState();
      const ids = useRadioStore.getState().waveIds;
      const inserts = pickWaveCandidates(fresh, now.queue, ids);
      if (!inserts.length) {
        registerMiss(seed, get().misses);
        return;
      }

      const at = waveInsertIndex(now.queue, now.index, ids);
      if (at === now.index + 1) {
        // Волновых после текущего ещё нет — обычная вставка после текущего
        usePlayerStore.getState().insertAfterCurrent(inserts);
      } else {
        // Блок уже есть: продолжаем его после последнего волнового трека
        const queue = [...now.queue.slice(0, at), ...inserts, ...now.queue.slice(at)];
        usePlayerStore.setState({ queue });
      }
      useRadioStore.setState((state) => ({
        waveIds: new Set([...state.waveIds, ...inserts.map(waveKeyOf)]),
        misses: 0,
        loading: false,
      }));
      blockedSeed = null;
    })();

    /*
     * Снимаем «занято» только со своего запроса: пока он ехал, волну могли
     * выключить и включить снова, и новый сеанс уже поставил свой `pending`.
     * Затерев его, мы оставили бы новый запрос без учёта.
     */
    const owned = body.finally(() => {
      if (pendingRun !== run) return;
      pending = null;
      pendingSession = -1;
      if (useRadioStore.getState().loading) useRadioStore.setState({ loading: false });
    });

    pending = owned;
    pendingSession = session;
    return owned;
  },
}));

/**
 * Следим за очередью: волна просыпается, когда после текущего остаётся пара
 * волновых треков, перестраивается при ручном уходе на свой трек и выключается,
 * если включили перемешивание. Подписка живёт всё время работы приложения —
 * стор импортирует мини-плеер.
 */
usePlayerStore.subscribe((state, prev) => {
  // Свои правки очереди (вставка/удаление) не считаем действиями пользователя
  if (adjusting) return;
  const radio = useRadioStore.getState();
  if (!radio.enabled) return;

  if (state.shuffle && !prev.shuffle) {
    // Порядок очереди теперь ведёт shuffle: волна уходит, очередь чистится
    turnOff();
    toast({ title: "Wave не работает при перемешивании" });
    return;
  }

  // Обновления позиции/громкости очередь не меняют — их пропускаем сразу
  if (state.queue === prev.queue && state.index === prev.index) return;

  const current = state.queue[state.index];
  const previous = prev.queue[prev.index];
  if (current?.id === previous?.id) {
    // Очередь поправили (добавили/удалили трек), но играет тот же — добираем хвост
    void radio.fill();
    return;
  }

  // Трек сменился: неудачный источник больше не блокирует
  blockedSeed = null;
  const key = waveKeyOf(current);
  if (current && radio.waveIds.has(key)) {
    // Играет волновой трек — волна просто продолжается от него
    void radio.fill();
    return;
  }
  if (!current) return;

  // Пользователь выбрал свой трек: старые волновые убираем, новые ставим
  // после нового текущего — волна перестраивается от него
  dropWaveTracks();
  useRadioStore.setState((state) => ({
    waveIds: new Set<string>(),
    waveSession: state.waveSession + 1,
  }));
  void useRadioStore.getState().fill(true);
});

// В режиме разработки состояние волны доступно из консоли и автотестов
if (import.meta.env.DEV) {
  (window as unknown as { __radioStore?: unknown }).__radioStore = useRadioStore;
}
