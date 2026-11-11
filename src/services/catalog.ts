/**
 * Каталог: поиск и плейлисты подключённых сервисов.
 * Токены берутся из localStorage, для Spotify дополнительно работает вход
 * по PKCE — тогда access-токен продлевается автоматически.
 */

import { invoke } from "@tauri-apps/api/core";
import { getToken } from "../lib/tokens";
import { pickBestPerSongKey } from "../lib/songKey";
import { serviceFromTrackId, serviceInfo, type ServiceId } from "../lib/services";
import type { Track } from "../store/playerStore";
import { isTauri } from "./profiles";
import { spotifyAccessToken, spotifyStatus } from "./integrations";
import { yandexAccessToken, yandexStatus } from "./yandex";
import { useSettingsStore } from "../store/settingsStore";

export interface SearchTrack {
  id: string;
  title: string;
  artists: string;
  album: string | null;
  durationMs: number;
  cover: string | null;
  service: string;
  /**
   * Автор разрешил скачивание файла (SoundCloud). Такие треки можно честно
   * «Скачать»; остальные сохраняются офлайн только как временная копия в кеш.
   * У старых записей кеша поле отсутствует — тогда решает ответ download_info.
   */
  downloadable?: boolean;
  /**
   * Популярность трека (SoundCloud): по ней Rust сортирует выдачу, а страница
   * поиска показывает компактную подпись. Полей может не быть вовсе — тогда
   * просто ничего не показываем.
   */
  playbackCount?: number;
  likesCount?: number;
  followersCount?: number;
  /** Аккаунт исполнителя подтверждён сервисом. */
  verified?: boolean;
  /**
   * Жанр трека (SoundCloud: поле genre, иначе первый тег). По нему «Волна»
   * добирает жанровую порцию, поэтому поле необязательное.
   */
  genre?: string | null;
}

export interface ServicePlaylist {
  id: string;
  title: string;
  trackCount: number;
  cover: string | null;
  service: string;
}

/** Токен сервиса: вход по OAuth важнее вставленного вручную токена. */
export async function getServiceToken(id: ServiceId): Promise<string | null> {
  const settings = useSettingsStore.getState();

  // У входа по OAuth есть refresh-токен и точно тот аккаунт, который выбрал
  // пользователь, поэтому он приоритетнее старого «вставленного» токена.
  if (id === "spotify" && settings.spotifyClientId) {
    try {
      return await spotifyAccessToken(settings.spotifyClientId);
    } catch {
      // упадём на вставленный токен ниже
    }
  }
  if (id === "yandex" && settings.yandexClientId && settings.yandexClientSecret) {
    try {
      return await yandexAccessToken(settings.yandexClientId, settings.yandexClientSecret);
    } catch {
      // упадём на вставленный токен ниже
    }
  }
  // У SoundCloud вместо токена используется client_id
  if (id === "soundcloud") {
    return settings.soundcloudClientId || null;
  }

  return getToken(serviceInfo(id).tokenKey);
}

export async function detectAvailability(): Promise<Record<ServiceId, boolean>> {
  const yandexLegacy = !!getToken(serviceInfo("yandex").tokenKey);
  const vk = !!getToken(serviceInfo("vk").tokenKey);
  let spotify = !!getToken(serviceInfo("spotify").tokenKey);
  let yandex = yandexLegacy;

  if (!spotify) {
    try {
      spotify = (await spotifyStatus()).connected;
    } catch {
      spotify = false;
    }
  }
  if (!yandex) {
    try {
      yandex = (await yandexStatus()).connected;
    } catch {
      yandex = false;
    }
  }
  return { yandex, spotify, vk, soundcloud: !!useSettingsStore.getState().soundcloudClientId };
}

/**
 * Запрос к SoundCloud через WebView.
 *
 * У Rust-клиента свой TLS-стек, и он отказывается работать, если в hosts
 * прописан IP с просроченным сертификатом. WebView ходит так же, как браузер,
 * поэтому сначала пробуем именно этот путь.
 */
async function soundcloudJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`SoundCloud ответил ${response.status}`);
  }
  return (await response.json()) as T;
}

interface SoundcloudApiTrack {
  id: number | string;
  title?: string;
  duration?: number;
  artwork_url?: string | null;
  user?: { username?: string; followers_count?: number; verified?: boolean };
  /** Автор разрешил скачивание — кнопка «Скачать» вместо «Сохранить в кеш». */
  downloadable?: boolean;
  /** Популярность: приходит в том же ответе, что и сам трек. */
  playback_count?: number;
  likes_count?: number;
  /** Жанр: по нему «Волна» добирает жанровую порцию. */
  genre?: string | null;
}

function mapSoundcloudTrack(item: SoundcloudApiTrack): SearchTrack {
  return {
    id: String(item.id),
    title: item.title ?? "Без названия",
    artists: item.user?.username ?? "SoundCloud",
    album: null,
    durationMs: item.duration ?? 0,
    cover: item.artwork_url ? item.artwork_url.replace("-large", "-t500x500") : null,
    service: "soundcloud",
    downloadable: item.downloadable === true,
    playbackCount: item.playback_count,
    likesCount: item.likes_count,
    followersCount: item.user?.followers_count,
    verified: item.user?.verified,
    genre: item.genre ?? null,
  };
}

/**
 * Кеш каталога в localStorage.
 *
 * Сеть до SoundCloud нестабильна (провайдер подменяет DNS, спасает только DoH),
 * поэтому каждый поиск и каждая загрузка трендов ходят в сеть заново и часто
 * падают. Свежий ответ отдаём из кеша и в сеть не идём вовсе, а если сеть
 * всё-таки отвалилась — показываем сохранённый результат с пометкой «устарел».
 *
 * Версия кеша поиска: в первой версии в кеш попадали любые ответы SoundCloud —
 * вместе с мусорными версиями («speed up», «slowed» и прочим). Отбор и
 * сортировку теперь делает Rust, поэтому старые записи поиска показывать
 * нельзя: поднимаем версию, и кеш поиска начинается заново. В третьей версии
 * выдача ещё и схлопывается по сути трека (`songKey`), поэтому записи второй
 * версии с перезаливами тоже не показываем. Кеш трендов, избранного и
 * офлайн-копий при этом не тронут.
 */
const SEARCH_VERSION = 3;
const SEARCH_CACHE_KEY = `music_hub_search_cache_v${SEARCH_VERSION}`;
/** Ключ прошлой версии: подчищаем, чтобы мусор не оставался в хранилище. */
const LEGACY_SEARCH_CACHE_KEY = "music_hub_search_cache";
const CHARTS_CACHE_KEY = "music_hub_charts_cache";
/** Свежесть поиска и трендов. */
const SEARCH_TTL_MS = 15 * 60 * 1000;
const CHARTS_TTL_MS = 30 * 60 * 1000;
/** Сколько последних поисковых запросов храним. */
const SEARCH_CACHE_LIMIT = 40;

interface CacheEntry<T> {
  at: number;
  items: T[];
}

type CacheMap<T> = Record<string, CacheEntry<T>>;

/** Результат с информацией о происхождении: кеш или сеть. */
export interface CachedTracks {
  tracks: SearchTrack[];
  fromCache: boolean;
  /** Данные из кеша, потому что сеть не ответила. */
  stale: boolean;
}

function readCache<T>(key: string): CacheMap<T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: CacheMap<T> = {};
    for (const [entryKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { at?: unknown; items?: unknown };
      if (typeof entry.at !== "number" || !Array.isArray(entry.items)) continue;
      result[entryKey] = { at: entry.at, items: entry.items as T[] };
    }
    return result;
  } catch {
    // Битый кеш не должен ломать поиск
    return {};
  }
}

/** Запись кеша; при лимите выбрасываем самые старые записи. */
function writeCache<T>(key: string, cache: CacheMap<T>, limit?: number): void {
  try {
    let entries = Object.entries(cache);
    if (limit && entries.length > limit) {
      entries = entries.sort((a, b) => b[1].at - a[1].at).slice(0, limit);
    }
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Переполнение хранилища не должно ломать каталог
  }
}

/** Свежая запись кеша или undefined. */
function freshEntry<T>(cache: CacheMap<T>, key: string, ttl: number): CacheEntry<T> | undefined {
  const entry = cache[key];
  if (!entry) return undefined;
  return Date.now() - entry.at < ttl ? entry : undefined;
}

async function searchTracksRemote(id: ServiceId, query: string): Promise<SearchTrack[]> {
  const info = serviceInfo(id);
  if (!info.supported) throw new Error(info.note ?? "Сервис не поддерживается");
  const token = await getServiceToken(id);
  if (!token) throw new Error(await notConnectedMessage(id));
  if (!isTauri()) return [];

  if (id === "soundcloud") {
    try {
      const tracks = await invoke<SearchTrack[]>("soundcloud_search", { clientId: token, query });
      // Один трек от разных аккаунтов-перезаливов — один результат
      return pickBestPerSongKey(tracks);
    } catch (e) {
      // Ключ веб-клиента SoundCloud устаревает: сервер отвечает 401.
      // Берём свежий и повторяем — иначе поиск «умирал» навсегда.
      //
      // Важно: новый ключ сначала пробуем сами. Если он тоже не годится,
      // старый в настройках не трогаем — вдруг проблема временная.
      if (/\b401\b/.test(String(e))) {
        try {
          const fresh = await discoverSoundcloudClientId();
          if (fresh && fresh !== token) {
            const tracks = await invoke<SearchTrack[]>("soundcloud_search", { clientId: fresh, query });
            await rememberSoundcloudClientId(fresh);
            return pickBestPerSongKey(tracks);
          }
        } catch {
          // Свежий ключ не помог — падаем в обычную обработку ошибки.
        }
      }
      throw new Error(explainSoundcloudError(e));
    }
  }

  return invoke<SearchTrack[]>("service_search", { service: id, token, query });
}

/**
 * Поиск с кешем: свежая запись (моложе 15 минут) отдаётся сразу и в сеть не
 * ходит; при сбое сети возвращается старая запись с признаком stale.
 */
export async function searchTracksCached(id: ServiceId, query: string): Promise<CachedTracks> {
  const trimmed = query.trim();
  if (!trimmed) return { tracks: [], fromCache: false, stale: false };

  const key = `v${SEARCH_VERSION}:${id}:${trimmed.toLowerCase()}`;
  const cache = readCache<SearchTrack>(SEARCH_CACHE_KEY);
  const cached = cache[key];

  const fresh = freshEntry(cache, key, SEARCH_TTL_MS);
  if (fresh) return { tracks: fresh.items, fromCache: true, stale: false };

  try {
    const tracks = await searchTracksRemote(id, trimmed);
    cache[key] = { at: Date.now(), items: tracks };
    writeCache(SEARCH_CACHE_KEY, cache, SEARCH_CACHE_LIMIT);
    // Записи прошлой версии кеша уже не нужны: в них лежала выдача с мусором
    try {
      localStorage.removeItem(LEGACY_SEARCH_CACHE_KEY);
    } catch {
      // Хранилище может быть недоступно — на поиск это не влияет
    }
    return { tracks, fromCache: false, stale: false };
  } catch (e) {
    if (cached) return { tracks: cached.items, fromCache: true, stale: true };
    throw e;
  }
}

/** Поиск без информации о кеше — для мест, которым нужен только список. */
export async function searchTracks(id: ServiceId, query: string): Promise<SearchTrack[]> {
  const { tracks } = await searchTracksCached(id, query);
  return tracks;
}

/**
 * Объясняет типичные сетевые ошибки SoundCloud человеческим языком:
 * чаще всего виноват мёртвый IP, прописанный в hosts.
 */
/**
 * Объясняет сетевые ошибки SoundCloud человеческим языком.
 * Про hosts говорим только тогда, когда дело действительно в сертификате.
 */
export function explainSoundcloudError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  if (/certificate|сертификат/i.test(text) && /expired|просроч|not valid/i.test(text)) {
    return (
      "Сертификат SoundCloud не совпал: соединение подменяет посредник (хост в hosts, VPN или антивирус). " +
      "Проверь hosts и настройки обхода — приложение уже пробовало несколько раз."
    );
  }
  if (/Connection Failed|tls|connect|timed out|timeout|не ответил/i.test(text)) {
    return (
      "Соединение с SoundCloud оборвалось — при обходе блокировок так бывает через раз. " +
      "Приложение уже сделало 3 попытки: нажми поиск ещё раз, обычно проходит. " +
      "Технические детали — в журнале ошибок."
    );
  }
  return text;
}

/** Понятное объяснение, почему сервис не подключён. */
export async function notConnectedMessage(id: ServiceId): Promise<string> {
  if (id === "soundcloud") {
    return "SoundCloud: нужен client_id — вставь свой в настройках или нажми «Найти автоматически»";
  }
  return `${serviceInfo(id).name} не подключена — добавь токен в настройках`;
}

/** Прямая ссылка на поток SoundCloud. */
export async function soundcloudStreamUrl(clientId: string, trackId: string): Promise<string> {
  try {
    return await invoke<string>("soundcloud_stream", { clientId, trackId });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * Предзагрузка трека: Rust добывает ссылку на поток заранее и прогревает
 * соединение с сервером (DNS, TCP, TLS). Возвращает ту же ссылку, чтобы плеер
 * запомнил её и включил следующий трек без ожидания сети.
 */
export async function prefetchSoundcloudStream(
  clientId: string,
  trackId: string
): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("soundcloud_prefetch", { clientId, trackId });
}

/**
 * Адрес страницы трека в SoundCloud (`https://soundcloud.com/автор/трек`).
 *
 * Нужен запасному пути сохранения: внешний сервис принимает именно адрес
 * страницы, а голый числовой id понимает как поисковую строку и вернул бы
 * чужие треки. В приложении адрес нигде не хранится, поэтому спрашиваем его
 * у SoundCloud тем же client_id, что и поток.
 */
export async function soundcloudPermalink(clientId: string, trackId: string): Promise<string> {
  try {
    return await invoke<string>("soundcloud_permalink", { clientId, trackId });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * Свежая ссылка на поток для трека из сервиса: сохранённые ссылки истекают,
 * поэтому перед воспроизведением берём новую (из-за этого избранное из поиска
 * раньше не играло).
 */
export async function refreshServiceStream(track: Track): Promise<Track> {
  if (track.source !== "service") return track;
  const service = serviceFromTrackId(track.id);
  if (service !== "soundcloud") return track;
  const clientId = await getServiceToken("soundcloud");
  if (!clientId) return track;
  const trackId = track.id.split(":")[1] ?? "";
  if (!trackId) return track;
  const url = await soundcloudStreamUrl(clientId, trackId);
  return { ...track, path: url };
}

/** Жанры для трендов SoundCloud. */
export const SOUNDCLOUD_GENRES = [
  { id: "soundcloud:genres:all-music", label: "Всё" },
  { id: "soundcloud:genres:electronic", label: "Электроника" },
  { id: "soundcloud:genres:hiphoprap", label: "Хип-хоп" },
  { id: "soundcloud:genres:rock", label: "Рок" },
];

/**
 * Тренды SoundCloud — рекомендации для главной.
 * Регион («RU») включает местные тренды; пустая строка — общемировые.
 */
async function soundcloudChartsRemote(genre: string, region: string): Promise<SearchTrack[]> {
  const clientId = await getServiceToken("soundcloud");
  if (!clientId) throw new Error("SoundCloud: нужен client_id — добавь в настройках");
  if (!isTauri()) return [];
  try {
    return await invoke<SearchTrack[]>("soundcloud_charts", { clientId, genre, region });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * Тренды с кешем: свежие (моложе 30 минут) — без сети, старые — при сбое сети.
 * `force` нужен кнопке «Обновить тренды»: она обязана сходить в сеть.
 */
export async function soundcloudChartsCached(genre: string, region = "", force = false): Promise<CachedTracks> {
  const key = `${genre}:${region}`;
  const cache = readCache<SearchTrack>(CHARTS_CACHE_KEY);
  const cached = cache[key];

  const fresh = force ? undefined : freshEntry(cache, key, CHARTS_TTL_MS);
  if (fresh) return { tracks: fresh.items, fromCache: true, stale: false };

  try {
    const tracks = await soundcloudChartsRemote(genre, region);
    cache[key] = { at: Date.now(), items: tracks };
    writeCache(CHARTS_CACHE_KEY, cache);
    return { tracks, fromCache: false, stale: false };
  } catch (e) {
    if (cached) return { tracks: cached.items, fromCache: true, stale: true };
    throw e;
  }
}

/** Тренды без информации о кеше — для мест, которым нужен только список. */
export async function soundcloudCharts(genre: string, region = ""): Promise<SearchTrack[]> {
  const { tracks } = await soundcloudChartsCached(genre, region);
  return tracks;
}

/**
 * Треки SoundCloud по идентификаторам — одним запросом (Rust сам делит
 * список на пачки по 50). Нужно, чтобы догрузить названия, исполнителей и
 * обложки старых лайков, у которых сохранён только id.
 */
export async function soundcloudTracks(ids: string[]): Promise<SearchTrack[]> {
  if (!ids.length) return [];
  const clientId = await getServiceToken("soundcloud");
  if (!clientId) throw new Error("SoundCloud: нужен client_id — добавь в настройках");
  if (!isTauri()) return [];
  try {
    return await invoke<SearchTrack[]>("soundcloud_tracks", { clientId, ids });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * Кладёт новый client_id в настройки: следующий поиск сразу пойдёт с ним,
 * без повторного обнаружения.
 */
async function rememberSoundcloudClientId(clientId: string): Promise<void> {
  const { useSettingsStore } = await import("../store/settingsStore");
  useSettingsStore.getState().setSoundcloudClientId(clientId);
}
/** Публичный client_id SoundCloud, если пользователь не ввёл свой. */
export async function discoverSoundcloudClientId(): Promise<string> {
  if (!isTauri()) throw new Error("Доступно только в приложении");
  return invoke<string>("soundcloud_discover_client_id");
}

/**
 * «Волна»: похожие на трек SoundCloud. Rust уже отбирает стримабельные треки
 * без мусорных версий и дублей, поэтому здесь только транспорт.
 */
export async function soundcloudRelated(
  clientId: string,
  trackId: string,
  limit = 15
): Promise<SearchTrack[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<SearchTrack[]>("soundcloud_related", { clientId, trackId, limit });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * «Волна», запасной путь: верхние треки артиста. Артиста можно назвать
 * числовым id, ником или адресом страницы — Rust сам его разрешит.
 */
export async function soundcloudArtistTop(
  clientId: string,
  userId: string,
  limit = 15
): Promise<SearchTrack[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<SearchTrack[]>("soundcloud_artist_top", { clientId, userId, limit });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * «Волна»: треки жанра — третий источник порции. Жанр берём из поля genre
 * текущего трека (если пусто — из первого тега), поэтому пустая строка
 * означает «жанр неизвестен» и запрос не нужен.
 */
export async function soundcloudGenreTracks(
  clientId: string,
  genre: string,
  limit = 6
): Promise<SearchTrack[]> {
  if (!isTauri() || !genre.trim()) return [];
  try {
    return await invoke<SearchTrack[]>("soundcloud_genre_tracks", { clientId, genre, limit });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * «Волна»: похожие артисты (related, запасной путь — followings). По каждому
 * из них радио берёт не больше пары треков, чтобы порция не стала «ещё одним
 * артистом целиком».
 */
export async function soundcloudRelatedArtists(
  clientId: string,
  userId: string,
  limit = 6
): Promise<SoundcloudUser[]> {
  if (!isTauri() || !userId.trim()) return [];
  try {
    return await invoke<SoundcloudUser[]>("soundcloud_related_artists", {
      clientId,
      userId,
      limit,
    });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * Профиль артиста SoundCloud для окна артиста.
 *
 * Поля необязательные: SoundCloud отдаёт не всё про всех, а выдумывать нули
 * нельзя — «нет данных» и «честный ноль» в интерфейсе выглядят по-разному.
 */
export interface SoundcloudUser {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  description: string | null;
  permalink: string | null;
  permalinkUrl: string | null;
  followersCount: number | null;
  followingsCount: number | null;
  trackCount: number | null;
  playlistCount: number | null;
  likesCount: number | null;
  city: string | null;
  countryCode: string | null;
  verified: boolean | null;
}

/** Порция списка от SoundCloud: треки, курсор следующей и признак «есть ещё». */
export interface SoundcloudPage {
  tracks: SearchTrack[];
  /** `next_href` от SoundCloud: по нему берём следующую порцию. */
  nextHref: string | null;
  hasMore: boolean;
}

/**
 * Профиль артиста SoundCloud. Артиста можно назвать числовым id, ником или
 * адресом страницы: Rust сам решает, идти в `/users/<id>` или в `resolve`.
 */
export async function soundcloudUser(clientId: string, user: string): Promise<SoundcloudUser> {
  try {
    return await invoke<SoundcloudUser>("soundcloud_user", { clientId, user });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * Треки артиста порциями: `limit` — размер порции (в окне артиста 25),
 * `offset` — сколько уже загружено. Загруженное держит интерфейс, поэтому
 * переключение страниц внутри него не ходит в сеть.
 */
export async function soundcloudUserTracks(
  clientId: string,
  user: string,
  limit: number,
  offset: number
): Promise<SearchTrack[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<SearchTrack[]>("soundcloud_user_tracks", { clientId, user, limit, offset });
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

/**
 * Следующая порция поиска — для страниц за пределами уже загруженного.
 * Курсор SoundCloud (`next`) важнее смещения: если он есть, Rust идёт по нему.
 */
export async function soundcloudSearchPage(
  clientId: string,
  query: string,
  limit: number,
  offset: number,
  next: string | null
): Promise<SoundcloudPage> {
  if (!isTauri()) return { tracks: [], nextHref: null, hasMore: false };
  try {
    const page = await invoke<SoundcloudPage>("soundcloud_search_page", {
      clientId,
      query,
      limit,
      offset,
      // Пустой курсор отправляем как null: так аргумент точно есть в вызове
      next: next ?? null,
    });
    // Поля могут не прийти вовсе (курсор Rust не сериализует, когда его нет) —
    // приводим ответ к одной форме, чтобы интерфейсу не приходилось гадать
    return {
      tracks: page.tracks ?? [],
      nextHref: page.nextHref ?? null,
      hasMore: page.hasMore === true,
    };
  } catch (e) {
    throw new Error(explainSoundcloudError(e));
  }
}

export async function loadPlaylists(id: ServiceId): Promise<ServicePlaylist[]> {
  const info = serviceInfo(id);
  const token = await getServiceToken(id);
  if (!token) throw new Error(`${info.name} не подключена — добавь токен в настройках`);
  if (!isTauri()) return [];
  return invoke<ServicePlaylist[]>("service_playlists", { service: id, token });
}

/** Миллисекунды в «3:45». */
export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Компактная подпись популярности для списка результатов:
 * «850 прослушиваний», «12,4 тыс. прослушиваний», «1,2 млн прослушиваний».
 *
 * Данных нет (сервис их не отдал) — подписи нет: пустое место честнее нуля.
 */
export function formatPlaybackCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1000) return `${value} прослушиваний`;

  const short = (scaled: number): string => {
    if (scaled >= 100) return String(Math.round(scaled));
    const text = scaled.toFixed(1).replace(/\.0$/, "");
    return text.replace(".", ",");
  };

  const label = value < 1_000_000 ? `${short(value / 1000)} тыс.` : `${short(value / 1_000_000)} млн`;
  return `${label} прослушиваний`;
}
