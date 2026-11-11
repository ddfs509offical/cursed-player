/**
 * Ключ СУТИ трека, а не загрузки.
 *
 * У SoundCloud один и тот же трек лежит в нескольких аккаунтах-перезаливах:
 * id у них разные, поэтому дедуп по id не срабатывает. Здесь мы собираем ключ
 * из того, что описывает саму песню: очищенное название, исполнитель и
 * длительность, округлённая до двух секунд.
 *
 * Название чистим от мусора загрузчика («prod. by …», «official audio»,
 * «free download», «out now» и т. п.), но маркеры версии — remix, sped up,
 * slowed, live, cover, instrumental и остальные из `VERSION_MARKERS` —
 * намеренно оставляем: оригинал и его версия не должны схлопнуться в один
 * трек.
 */

/** Что нужно знать о треке, чтобы построить ключ. */
export interface SongKeyTrack {
  id?: string | number;
  title?: string | null;
  /** Исполнители: массив или одна строка (у SoundCloud здесь ник загрузчика). */
  artists?: string | string[] | null;
  /** Отдельное поле исполнителя, если оно есть у трека. */
  artist?: string | null;
  /** Загрузчик отдельным полем/объектом, если он известен. */
  uploader?: string | null;
  user?: { username?: string | null } | null;
  durationMs?: number | null;
  duration_ms?: number | null;
  playbackCount?: number | null;
  playback_count?: number | null;
  verified?: boolean | null;
}

/**
 * Маркеры версии. Их нельзя вырезать из названия: remix, sped up, slowed,
 * reverb, nightcore, live, cover, instrumental, acapella, extended, edit, vip,
 * bootleg — это другая запись, а не тот же трек.
 */
export const VERSION_MARKERS = [
  "remix",
  "sped up",
  "spedup",
  "speed up",
  "slowed",
  "reverb",
  "nightcore",
  "live",
  "cover",
  "instrumental",
  "acapella",
  "extended",
  "edit",
  "vip",
  "bootleg",
] as const;

/** Маркеры мусора загрузчика: их из названия выбрасываем. */
const JUNK_PATTERNS: readonly RegExp[] = [
  // «(prod. by Someone)», «[prod. by …]»
  /[([][^)\]]*\bprod\.?\s*by\b[^)\]]*[)\]]/gi,
  // «prod. by Someone» без скобок — обычно хвост названия
  /\bprod\.?\s*by\b[^,;()[\]\n]*/gi,
  // «[free download]», «free download»
  /\bfree\s*download\b/gi,
  /[([]\s*(?:free\s*)?download\s*[)\]]/gi,
  // «official audio», «official video», «official music video»
  /\bofficial\s+(?:audio|video|music\s+video|lyric\s+video|visuali[sz]er)\b/gi,
  /\bout\s+now\b/gi,
  /\bpremiere\b/gi,
  /\bexclusive\b/gi,
  /\bhq\b/gi,
];

/** «feat. X», «ft. X», «featuring X» — для исполнителя это не имя. */
const FEATURING = /\b(?:feat|ft|featuring)\.?\s+[^,;()[\]\n]*/gi;

/** Разделитель «Артист — Название»: дефис, тире, длинное тире. */
const TITLE_DASH = /\s+[-–—]\s+/;

/**
 * Нормализация строки: нижний регистр, ё→е, без мусора загрузчика, без
 * пунктуации и лишних пробелов. Буквы (включая кириллицу) и цифры остаются.
 */
export function normalizeSongText(
  value: string | null | undefined,
  options: { stripFeat?: boolean } = {}
): string {
  let text = (value ?? "").toLowerCase().replace(/ё/g, "е");
  if (options.stripFeat) text = text.replace(FEATURING, " ");
  for (const pattern of JUNK_PATTERNS) text = text.replace(pattern, " ");
  return text
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Первый исполнитель из `artists` (массив или строка). */
function firstListedArtist(track: SongKeyTrack): string {
  const listed = track.artists;
  if (Array.isArray(listed)) {
    const first = listed.find((name) => typeof name === "string" && name.trim());
    return first ?? "";
  }
  if (typeof listed === "string") {
    // «A, B» / «A & B» — нам нужен первый, а не вся строка
    return listed.split(/\s*(?:,|;|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i)[0] ?? "";
  }
  return "";
}

/** Загрузчик: отдельное поле, объект пользователя или ник из `artists`. */
function uploaderOf(track: SongKeyTrack): string {
  return (
    track.uploader ??
    track.user?.username ??
    firstListedArtist(track) ??
    ""
  );
}

/** Артист из названия «Артист — Трек», если он там есть. */
function titleArtistPrefix(title: string | null | undefined): string {
  const text = (title ?? "").trim();
  const match = TITLE_DASH.exec(text);
  if (!match || match.index < 2) return "";
  const prefix = text.slice(0, match.index).trim();
  if (prefix.length > 40 || !/[\p{L}\p{N}]/u.test(prefix)) return "";
  return prefix;
}

/** Название без префикса «Артист — », если префикс совпал с артистом. */
function titleWithoutArtist(title: string | null | undefined, artist: string): string {
  const text = (title ?? "").trim();
  const match = TITLE_DASH.exec(text);
  if (!match) return text;
  const prefix = normalizeSongText(text.slice(0, match.index), { stripFeat: true });
  if (!prefix || prefix !== artist) return text;
  const rest = text.slice(match.index + match[0].length).trim();
  return rest || text;
}

/**
 * Исполнитель песни в нормализованном виде.
 *
 * Порядок: явное поле `artist`, затем артист из названия «Артист — Трек»,
 * затем первый из `artists`. Название важнее ника загрузчика: у перезалива
 * в нике стоит имя канала, а настоящий исполнитель — в названии.
 */
export function songArtist(track: SongKeyTrack): string {
  const explicit = normalizeSongText(track.artist, { stripFeat: true });
  if (explicit) return explicit;
  const prefix = normalizeSongText(titleArtistPrefix(track.title), { stripFeat: true });
  if (prefix) return prefix;
  const listed = normalizeSongText(firstListedArtist(track), { stripFeat: true });
  if (listed) return listed;
  return normalizeSongText(uploaderOf(track), { stripFeat: true });
}

/**
 * Длительность в двухсекундных окнах: «2:14» и «2:15» попадают в одно окно,
 * «2:14» и «2:40» — в разные. Окно считаем вниз (floor): 135 секунд — это
 * 67,5, и round отправил бы их в соседнее окно 68, разведя почти одинаковые
 * загрузки.
 */
function durationBucket(track: SongKeyTrack): string {
  const raw = track.durationMs ?? track.duration_ms;
  const ms = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  if (ms <= 0) return "0";
  return String(Math.floor(ms / 2000));
}

/** Ключ сути трека: `название|исполнитель|окно_длительности`. */
export function songKey(track: SongKeyTrack): string {
  const artist = songArtist(track);
  const title = normalizeSongText(titleWithoutArtist(track.title, artist));
  if (!title && !artist) return "";
  return `${title}|${artist}|${durationBucket(track)}`;
}

function playbackOf(track: SongKeyTrack): number {
  const raw = track.playbackCount ?? track.playback_count;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/**
 * Загружено самим артистом? Это единственный признак «оригинала», который
 * можно проверить без сети: ник загрузчика совпал либо с явным полем
 * исполнителя, либо с артистом из названия «Артист — Трек».
 */
function isOriginalUploader(track: SongKeyTrack): boolean {
  const uploader = normalizeSongText(uploaderOf(track), { stripFeat: true });
  if (!uploader) return false;
  const explicit = normalizeSongText(track.artist, { stripFeat: true });
  const prefix = normalizeSongText(titleArtistPrefix(track.title), { stripFeat: true });
  return (!!explicit && explicit === uploader) || (!!prefix && prefix === uploader);
}

/** Лучше ли кандидат текущего победителя группы. */
function preferred(candidate: SongKeyTrack, current: SongKeyTrack): boolean {
  const original = isOriginalUploader(candidate);
  if (original !== isOriginalUploader(current)) return original;
  const playback = playbackOf(candidate);
  const currentPlayback = playbackOf(current);
  if (playback !== currentPlayback) return playback > currentPlayback;
  return candidate.verified === true && current.verified !== true;
}

/**
 * Из группы треков с одинаковым ключом оставляет один: сначала оригинального
 * загрузчика, затем более популярный, затем подтверждённый аккаунт, иначе —
 * первый по порядку (порядок выдачи стабилен).
 */
export function pickBestPerSongKey<T extends SongKeyTrack>(tracks: readonly T[]): T[] {
  const result: T[] = [];
  const positions = new Map<string, number>();
  const orphanIds = new Set<string>();

  for (const track of tracks) {
    const key = songKey(track);
    if (!key) {
      // Без названия/исполнителя судить не о чем: оставляем трек как есть
      const id = String(track.id ?? "");
      if (id && orphanIds.has(id)) continue;
      if (id) orphanIds.add(id);
      result.push(track);
      continue;
    }
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, result.length);
      result.push(track);
    } else if (preferred(track, result[position])) {
      result[position] = track;
    }
  }
  return result;
}
