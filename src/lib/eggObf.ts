/**
 * Кодированные константы «тихого слоя» и их чтение в рантайме.
 *
 * Ничего читаемого здесь нет специально: слова-ключа нет вовсе (только FNV-1a
 * 64 от нормализованной строки), фразы лежат как XOR(UTF-8, поток ключа) в
 * base64, «магический» цвет — упакованным целым под маской, имена слотов
 * хранилища — короткие производные хеши. Исходные тексты есть только в
 * _verify/egg-encode.cjs (генератор) и _verify/egg-obf-test.cjs (тест).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Зерно потока ключа: от него же считаются имена слотов хранилища. */
const KEY_SEED = "mh/ui/v1";

/** FNV-1a 32: короткие производные идентификаторы (слоты хранилища). */
function fnv1a32(input: string): number {
  const bytes = encoder.encode(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** FNV-1a 64 в hex: сравнение набранного слова идёт только по этому хешу. */
export function fnv1a64(input: string): string {
  const bytes = encoder.encode(input);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Единственная нормализация: обрезка пробелов и нижний регистр. */
export function normalizeTrigger(value: string): string {
  return value.trim().toLowerCase();
}

export function triggerDigest(value: string): string {
  return fnv1a64(normalizeTrigger(value));
}

/** FNV-1a 64 от нормализованного слова-ключа. */
export const TRIGGER_HASH = "ea02e4fc16aed7e4";
/** Длина слова-ключа: буфер набранных символов короче не проверяется. */
export const TRIGGER_LEN = 4;

/**
 * Двигает окно набранных символов на один вперёд и говорит, собрался ли ключ.
 * Хвост длиннее ключа отбрасывается, поэтому неверный символ просто сдвигает
 * окно — ровно то же, что раньше делало посимвольное сравнение.
 */
export function pushTriggerChar(buffer: string[], key: string): boolean {
  buffer.push(key.toLowerCase());
  if (buffer.length > TRIGGER_LEN) buffer.splice(0, buffer.length - TRIGGER_LEN);
  if (buffer.length < TRIGGER_LEN) return false;
  return triggerDigest(buffer.join("")) === TRIGGER_HASH;
}

/** Поток ключа для XOR: тот же алгоритм, что в генераторе. */
function keyStream(length: number): Uint8Array {
  const seed = encoder.encode(KEY_SEED);
  const out = new Uint8Array(length);
  let hash = 0x811c9dc5;
  for (let i = 0; i < length; i += 1) {
    hash ^= seed[i % seed.length] ^ (i & 0xff);
    hash = Math.imul(hash, 0x01000193);
    out[i] = ((hash >>> 24) ^ (hash >>> 16) ^ (hash >>> 8) ^ hash) & 0xff;
  }
  return out;
}

function fromBase64(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/*
 * Фразы: 0..4 — обычные, 5 — десятое открытие, 6 — двадцать пятое,
 * 7 — «магический» цвет. Порядок индексов фиксирован и совпадает с
 * генератором; сами тексты появляются только в рантайме после XOR.
 */
const SLOTS: readonly string[] = [
  "YzNVCX10by3tQ08CqWufTtbjOCdIlJjOggEgy7BabmIoYCqj3wyEDxwXHNRB1fuQIqpRLqhl6tIZgx7Mgzo4BGKujLlk4TeH5DIcONGthRpCXKR+hiOC5b0Fde/1uEIdSsPdcFSjyazX1XSprsZVJxw02Z6EHmqzxhoMpA==",
  "YwRVA4wmA3F4syBszAvPEbuEULu4+fKuHAAcyoxbXGMWYRhTvlzWZUG0He5B0vuVIq6tsqlf6+4YvB//gz3JWvFe6TRl0DeHFFBxVrUNhRZDa6VJdkPgge1X7u/xuETj2MLxcFSjy1yLdTA3r/pVJB0KKfTOcArbag==",
  "YzNVCXxNbhntQ04CqGqjTtvjNtvclak+7VJzkC5bU2MTYCtTu13pZHhFRY0dRfuYIqasjahq6+0ZhR7Hggk4BGde6Bpl0zeC5QsdDtCVhCpCUlUjISKy5IL4H7ym1+fi68PCcWii6KzX1XSprsVVIR0LKMnOdgvgaOpkOC8SpCOc06qSB5hRpVEb0pb1cQII36kuLq04",
  "YzxUOH10by7tcXBGPGuTT+njPiu5xfKg7Gdyqd4+PgRzBE873jh0ZHVEenxA4vuQI5Sshahi6sEYuO6t5WGqBU6ujkkAfMfpq1FMVr4NhR9Da6VBdk0Q5IEFdu7MuEXj1DOgHAbGWVyChV1ZzqIwTU+X2Z6kH1qy+hoIWkuzpDBstsvyXcfE",
  "YztUPYwmD3BOQ0QDn5rOKLuHULu5xvOSEvByht41zmMbkE8x3w2EBBwWHNCxtKr1R8bM3szC6+0ZiO6t42CbBGuvuqOUg2rotlByV4INhRFDYKVGhiKx5b4Ffu7NSReIu5ChJgf7qTkZdTA2rsxUHh0FKfLPTfqzwxs2WkCzpDBtiDuTPmg6yD6q0pcFFJcJ6aksLq44",
  "YzJUPX13by4cESFePGueTtvjNyu5xvOVHAAdyo5bVmIrYQ5Tta2FNRwaHehB1QUFIoGts6lS6tcZhR//fpHJWQ786SeUgljotFB8VrL94XIj/qVAdkPgguxoHoBYSResu5ChIAfxqAAVhGOpr/BVKR0KKME+HmizxRslqi4ipDFst8v2XcrKpGrrvPqlFJwJ4KgQ38CWTrMpfQGdiMqoVxfGvxgZAKXrV+w7f3gAE/ma28OSUltT",
  "YwRVA4wmDHBMQmHyzA/PF7qioNvflJbOiQEjyoKlzmMMkE4B3jOEAh0h7b4R8Qv1TcbD3sMyi3AYvx/2cmCZBGSvukg8glfpgVFEV4wNhR5CXaVFd3jgju1W4B6m/heBu4KgFgbHqAcVhV1Zy1JVLx0LKM/OcwvhlUia",
  "YwRVA4wmA3F9QngDjWqlvrq1ULm48fOcEPByod41PzFzDk4D3waEDe1EcIwkRfuXI52tv6la6tAZjR/zgzM4BV6ugkg3g2DphFB1Vr3964yzDtgjJCOO5b71LL7iSReGu4JegeJCWbgCddm7XpAFCO1rRJ6r7grdlHRlCC4tpQ5tgDuSC5lopVEb0pH0RPJoufl+R/KkCi3U3PH9FcqiVxA37XB3a8mC9BxbKBxSdGdqt5H3MxrHQIAreAh1wYOf5c+wePyBCPvWPmgpYYRUSjX0dly3Vx7IQK7W6cReDeUDG2h9iVxaIsc=",
];

/** Индексы особых слотов — по счётчику открытий. */
export const OPEN_MILESTONES = { tenth: 5, twentyFifth: 6 } as const;
export const ACCENT_SLOT = 7;
export const RANDOM_SLOTS = 5;

const cache = new Map<number, string>();

/** Декодирование слота: только в момент показа, результат кешируется. */
export function decodeSlot(index: number): string {
  const known = cache.get(index);
  if (known !== undefined) return known;
  const raw = SLOTS[index];
  if (!raw) return "";
  const bytes = fromBase64(raw);
  const key = keyStream(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= key[i];
  const text = decoder.decode(bytes);
  cache.set(index, text);
  return text;
}

/*
 * «Магический» акцент: упакованный триплет под маской. Ни 41, ни 47, ни 92
 * не встречаются в бандле как отдельные литералы — только это целое.
 */
const ACCENT_PACKED = 0x737506 ^ 0x5a5a5a;

/** Допуск по каждой компоненте: цвет может прийти из обложки с округлением. */
export const ACCENT_TOLERANCE = 6;

export function accentTriplet(): [number, number, number] {
  return [(ACCENT_PACKED >>> 16) & 0xff, (ACCENT_PACKED >>> 8) & 0xff, ACCENT_PACKED & 0xff];
}

/** Подпись под особой фразой: те же числа, собранные в рантайме. */
export function accentSignature(): string {
  return accentTriplet().join(" · ");
}

/**
 * Слоты localStorage: короткие производные хеши. Прежние имена ключей в коде
 * не упоминаются вовсе, поэтому миграции нет — прогресс на уже установленных
 * копиях начинается заново. Это осознанный выбор: любое чтение старого ключа
 * вернуло бы его имя в бандл.
 */
function slotName(round: number): string {
  return "_" + fnv1a32(`${KEY_SEED}/${round}`).toString(36);
}

export const STORAGE_KEYS = {
  seen: slotName(1),
  clicks: slotName(2),
  opens: slotName(3),
} as const;

/** Канал со страницей настроек: нейтральные имена, без намёка на секрет. */
export const LAYER_EVENTS = {
  hide: "ui:layer:hide",
  reset: "ui:layer:reset",
} as const;
