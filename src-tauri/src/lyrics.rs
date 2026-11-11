//! Текст песни: цепочка открытых источников без ключей и регистрации.
//! Теги приходят грязными: «forgotten dreams (feat. shiawase)», «- Remastered»,
//! «(Official Video)». Поэтому сначала чистим название и исполнителя, а потом
//! перебираем варианты запроса — от самого точного к самому широкому — и
//! останавливаемся на первом синхронном тексте. На всю операцию отведён общий
//! бюджет времени, чтобы интерфейс не ждал вечно.
//!
//! Сеть устроена так же, как в `soundcloud.rs`: сначала curl с DNS over HTTPS
//! (провайдер подменяет DNS, и обычный путь может не отвечать), затем обычный
//! запрос как запасной путь. Транспорт, который уже сработал, следующий запрос
//! делает первым — иначе каждый адрес стоил бы двух попыток. У всех вызовов
//! curl отключена проверка отзыва сертификата (`--ssl-no-revoke`): без неё
//! Windows-сборка curl падает с CRYPT_E_REVOCATION_OFFLINE, хотя сертификат
//! источника настоящий.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Идентификация приложения: LRCLIB просит указывать, кто именно спрашивает.
const USER_AGENT: &str = "Cursed player/1.0 (https://github.com/cursed-player)";
/// Браузерный агент для Netease: «неизвестным» клиентам он отвечает охотнее,
/// когда запрос выглядит как из веб-клиента.
const NETEASE_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
/// Без Referer на свой домен Netease отвечает отказом.
const NETEASE_REFERER: &str = "https://music.163.com/";
/// Резолвер DNS over HTTPS: провайдер подменяет обычный DNS.
const DOH_URL: &str = "https://1.1.1.1/dns-query";
/// Отключение проверки отзыва сертификата. curl на Windows работает через
/// Schannel и лезет за CRL/OCSP: если они недоступны (провайдер, офлайн-сеть),
/// запрос падает с CRYPT_E_REVOCATION_OFFLINE, хотя сертификат настоящий.
/// Флаг понимает только Schannel, поэтому передаём его лишь на Windows.
const SSL_NO_REVOKE: &str = "--ssl-no-revoke";
/// Таймаут одного запроса: текст песни — не то, чего стоит ждать минуту.
const REQUEST_TIMEOUT_SECS: u64 = 5;
/// Общий бюджет на все источники: они опрашиваются параллельно, поэтому
/// бюджет — это ровно то время, которое панель может «думать».
const TOTAL_BUDGET_SECS: u64 = 8;
/// Разница длительности, при которой версию ещё считаем «той же песней».
const DURATION_TOLERANCE_SEC: i64 = 5;
/// Когда исполнителя в базе нет вовсе, совпадение держится только на названии —
/// поэтому длительность обязана сойтись куда точнее. Иначе легко получить текст
/// чужой песни: именно так и случилось с «Prettiest Dolphin» из Netease.
const TITLE_ONLY_DURATION_TOLERANCE_SEC: i64 = 3;
/// Насколько выигрывает запись, у которой подтвердился исполнитель. Меньше
/// разрыва между синхронным и обычным текстом (30 против 5), поэтому
/// «синхронный важнее обычного» остаётся в силе.
const ARTIST_BONUS: i32 = 20;

/// Служебные хвосты, на которых название песни заканчивается. Совпадение —
/// по целому слову, поэтому «prod» не поймает «producer» и «ft» — «Soft».
const STRONG_TAILS: [&str; 10] = [
    "feat",
    "feats",
    "ft",
    "featuring",
    "featured",
    "prod",
    "produced",
    "remaster",
    "remastered",
    "official",
];
/// Слова-хвосты, которые режем только после разделителя («- Lyrics», «| Audio»):
/// иначе «Radio Video» превратилось бы в «Radio».
const SOFT_TAILS: [&str; 12] = [
    "lyrics",
    "lyric",
    "audio",
    "video",
    "visualizer",
    "hd",
    "hq",
    "mv",
    "explicit",
    "deluxe",
    "bonus",
    "4k",
];
/// Разделители, которые остаются на краях после вырезанных хвостов.
const EDGE_CHARS: [char; 12] = [
    ' ', '\t', '-', '–', '—', '|', ',', ';', ':', '.', '·', '•',
];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// Текст найден (хотя бы обычный).
    pub found: bool,
    /// Синхронный текст в формате LRC — по нему работает подсветка строк.
    pub synced: Option<String>,
    /// Обычный текст без времени: показываем как есть, без подсветки.
    pub plain: Option<String>,
    /// Откуда текст, например "lrclib".
    pub source: Option<String>,
    /// Название и исполнитель так, как их знает источник.
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Название найденной записи, по которому прошла строгая проверка
    /// соответствия. Видно в журнале: если что-то подобралось не то, здесь
    /// окажется именно чужая песня, а не запрос плеера.
    pub matched_title: Option<String>,
    /// Исполнитель найденной записи — та же проверка, то же назначение.
    pub matched_artist: Option<String>,
    /// Текст взят у оригинала (или у одной из частей коллажа), а не у той самой
    /// версии, что играет: её в базе могло не быть вовсе. В интерфейсе это
    /// честная подпись «Текст от оригинала», а не молчаливая подмена.
    #[serde(default)]
    pub from_original: bool,
    /// Время строк расставлено нами по длине текста, а не взято у источника.
    /// Подсветка работает, но тайминг примерный — интерфейс обязан это сказать.
    #[serde(default)]
    pub estimated: bool,
    /// Что пробовали, когда текста не нашлось: попадает в журнал ошибок,
    /// чтобы промах можно было разобрать без отладчика.
    #[serde(default)]
    pub attempts: Vec<String>,
}


/// Один из найденных вариантов текста: интерфейс даёт переключиться, если
/// выбранный оказался не тем (например, кавер, перевод или другая версия).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsVariant {
    pub source: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub estimated: bool,
    pub from_original: bool,
    pub matched_title: Option<String>,
    pub matched_artist: Option<String>,
}

/// Ответ приложения: сам текст (`flatten` — поля как раньше) и остальные
/// найденные варианты. Пустой список не сериализуется: у старых сборок
/// ничего не меняется.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsAnswer {
    #[serde(flatten)]
    pub lyrics: Lyrics,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<LyricsVariant>,
}

impl Lyrics {
    fn as_variant(&self) -> LyricsVariant {
        LyricsVariant {
            source: self.source.clone().unwrap_or_default(),
            title: self.title.clone(),
            artist: self.artist.clone(),
            synced: self.synced.clone(),
            plain: self.plain.clone(),
            estimated: self.estimated,
            from_original: self.from_original,
            matched_title: self.matched_title.clone(),
            matched_artist: self.matched_artist.clone(),
        }
    }

    /// Собрать ответ: победитель первым, за ним остальные варианты по убыванию
    /// ранга. Одинаковые тексты (тот же источник и то же содержимое) не дублируем.
    fn answer_with(mut self, mut others: Vec<Candidate>, attempts: Vec<String>) -> LyricsAnswer {
        self.attempts = attempts;
        others.sort_by(|left, right| right.rank.cmp(&left.rank));

        let chosen = self.as_variant();
        let mut variants = vec![chosen.clone()];
        for candidate in others {
            let variant = candidate.lyrics.as_variant();
            if variant.synced.is_none() && variant.plain.is_none() {
                continue;
            }
            if variants.iter().any(|known| {
                known.source == variant.source
                    && known.synced == variant.synced
                    && known.plain == variant.plain
            }) {
                continue;
            }
            variants.push(variant);
        }

        LyricsAnswer { lyrics: self, variants }
    }
}

impl Lyrics {
    /// Чего-то не нашли — честный пустой ответ, а не ошибка.
    fn missing() -> Self {
        Self::default()
    }

    /// Ничего не нашли, но знаем, что именно пробовали.
    fn not_found(attempts: Vec<String>) -> Self {
        Self {
            attempts,
            ..Self::missing()
        }
    }

    /// Приписать ответу список попыток — он нужен журналу и отладке.
    fn with_attempts(mut self, attempts: Vec<String>) -> Self {
        self.attempts = attempts;
        self
    }
}

// ---------- Чистка тегов ----------

/// Слово без обрамляющей пунктуации и в нижнем регистре — для сравнений.
fn bare_word(word: &str) -> String {
    word.trim_matches(|ch: char| !ch.is_alphanumeric())
        .to_lowercase()
}

fn is_strong_tail(word: &str) -> bool {
    STRONG_TAILS.contains(&word)
}

fn is_soft_tail(word: &str) -> bool {
    SOFT_TAILS.contains(&word)
}

/// Слово состоит только из разделителей: «-», «|», «·».
fn is_separator_word(word: &str) -> bool {
    !word.is_empty() && word.chars().all(|ch| EDGE_CHARS.contains(&ch))
}

/// Скобочная вставка не про песню: «(feat. …)», «(Official Video)»,
/// «(2011 Remaster)», «(Lyrics)». Пустые скобки тоже убираем.
fn is_noise_text(inner: &str) -> bool {
    let words: Vec<String> = inner
        .split_whitespace()
        .map(bare_word)
        .filter(|word| !word.is_empty())
        .collect();

    match words.first() {
        // «()» и «( )» — просто мусор
        None => true,
        Some(first) => {
            // Хвост может стоять и последним словом: «(2011 Remaster)»
            let strong_last = words.last().map(|last| is_strong_tail(last)).unwrap_or(false);
            is_strong_tail(first) || is_soft_tail(first) || strong_last
        }
    }
}

/// Убрать скобочные вставки, которые не относятся к названию.
fn strip_noise_brackets(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;

    while index < chars.len() {
        let open = chars[index];
        let close = match open {
            '(' => Some(')'),
            '[' => Some(']'),
            '{' => Some('}'),
            _ => None,
        };

        if let Some(close) = close {
            if let Some(offset) = chars[index + 1..].iter().position(|ch| *ch == close) {
                let inner: String = chars[index + 1..index + 1 + offset].iter().collect();
                if is_noise_text(&inner) {
                    index += offset + 2;
                    continue;
                }
            }
        }

        out.push(chars[index]);
        index += 1;
    }

    out
}

/// Убрать хвосты без скобок: «feat. X», «prod. by X», «- Remastered 2011».
fn strip_noise_tails(value: &str) -> String {
    let words: Vec<&str> = value.split_whitespace().collect();
    let mut kept: Vec<&str> = Vec::new();

    for (index, word) in words.iter().copied().enumerate() {
        let key = bare_word(word);

        // Первое слово — часть названия, даже если совпало со служебным
        if index > 0 && !key.is_empty() {
            let weak_after_separator = is_soft_tail(&key)
                && kept
                    .last()
                    .map(|last| is_separator_word(last))
                    .unwrap_or(false);

            if is_strong_tail(&key) || weak_after_separator {
                if weak_after_separator {
                    // Разделитель перед хвостом тоже лишний
                    kept.pop();
                }
                break;
            }
        }

        kept.push(word);
    }

    kept.join(" ")
}

/// Края: пробелы и висящие разделители/запятые после вырезанных хвостов.
fn trim_edges(value: &str) -> String {
    value
        .trim()
        .trim_matches(&EDGE_CHARS[..])
        .trim()
        .to_string()
}

/// Название без служебных хвостов: «(feat. …)», «[prod. …]», «- remastered»,
/// «(official video)», «(lyrics)» и лишних пробелов. Регистр сохраняем:
/// так запрос к источнику выглядит естественнее.
pub fn normalize_title(value: &str) -> String {
    let without_brackets = strip_noise_brackets(value);
    let without_tails = strip_noise_tails(&without_brackets);
    trim_edges(&without_tails)
}

/// Ключ для сравнения: регистр, лишние пробелы и служебные хвосты не важны.
pub fn comparison_key(value: &str) -> String {
    normalize_title(value).to_lowercase()
}

/// Ключ строгого сравнения: служебные хвосты срезаны, регистр приведён к
/// нижнему, а от пунктуации и пробелов не остаётся ничего — только буквы и
/// цифры. Так «Prettiest Dolphin» и «prettiest-dolphin!» — одно и то же, а
/// «Numb» и «Numb (Live)» — уже нет: хвост «(Live)» значимый.
pub fn match_key(value: &str) -> String {
    comparison_key(value)
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

// ---------- Производные версии и коллажи ----------

/// Маркеры производных версий, которые вырезаем в любом месте названия:
/// ускорение, замедление, реверб, nightcore, «8D», нарезка для TikTok.
/// «speed» и «sped» сами по себе маркерами не считаются — только в паре с
/// «up»: иначе «Speed of Sound» превратилось бы в «of Sound».
const VERSION_WORDS: [&str; 10] = [
    "speedup",
    "spedup",
    "reverb",
    "slowed",
    "nightcore",
    "8d",
    "muffled",
    "bassboosted",
    "tiktokversion",
    "tiktok",
];
/// Маркеры из нескольких слов: «speed up», «sped up», «bass boosted»,
/// «8d audio», «tiktok version». Из фраз в одной позиции выигрывает длинная.
const VERSION_PHRASES: [&[&str]; 5] = [
    &["tiktok", "version"],
    &["bass", "boosted"],
    &["speed", "up"],
    &["sped", "up"],
    &["8d", "audio"],
];
/// Маркеры, которые вырезаем ТОЛЬКО в скобках: «(remix)», «(cover)», «(edit)».
/// Без скобок это часть настоящего названия («Cover Me», «Edit the Sad Parts»),
/// и трогать её нельзя.
const BRACKET_VERSION_WORDS: [&str; 3] = ["remix", "cover", "edit"];

/// Сколько кандидатов ослабленного прохода пробуем. Каждый кандидат — это ещё
/// запросы, а бюджет времени общий, поэтому список короткий.
const MAX_ORIGINAL_CANDIDATES: usize = 4;
/// Сколько секунд общего бюджета придерживаем для прохода «по оригиналу»,
/// когда название производное или коллажное. Без запаса обычный перебор
/// вариантов занял бы все 8 секунд, и до оригинала дело бы не дошло.
const ORIGINAL_RESERVE_SECS: u64 = 3;
/// Разделители коллажных названий: несколько песен в одной строке.
const COLLAGE_CHARS: [char; 6] = ['×', '&', '+', '/', '|', ','];

/// Слово названия вместе с его границами: по ним и вырезаем маркеры.
#[derive(Debug, Clone)]
struct TitleWord {
    /// Слово в нижнем регистре — по нему идёт сравнение с маркерами.
    key: String,
    /// Индекс первого символа в названии.
    start: usize,
    /// Индекс сразу за последним символом.
    end: usize,
    /// Слово стоит внутри скобок: «(remix)» — да, «Remix» в начале — нет.
    bracketed: bool,
}

/// Разбить название на слова. Точка и запятая между цифрами остаются внутри
/// слова, поэтому «1.25x» — одно слово, а не «1» и «25x».
fn title_words(value: &str) -> Vec<TitleWord> {
    let chars: Vec<char> = value.chars().collect();
    let mut words: Vec<TitleWord> = Vec::new();
    let mut index = 0;
    let mut depth: i32 = 0;

    while index < chars.len() {
        let ch = chars[index];
        if !ch.is_alphanumeric() {
            match ch {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => depth = (depth - 1).max(0),
                _ => {}
            }
            index += 1;
            continue;
        }

        let bracketed = depth > 0;
        let start = index;
        let mut key = String::new();

        while index < chars.len() {
            let current = chars[index];
            if current.is_alphanumeric() {
                key.extend(current.to_lowercase());
                index += 1;
                continue;
            }

            // «1.25x», «8,5x»: разделитель внутри числа — часть слова
            let inside_number = (current == '.' || current == ',')
                && chars[index - 1].is_ascii_digit()
                && chars
                    .get(index + 1)
                    .map(|next| next.is_ascii_digit())
                    .unwrap_or(false);
            if inside_number {
                key.push(current);
                index += 1;
                continue;
            }
            break;
        }

        words.push(TitleWord {
            key,
            start,
            end: index,
            bracketed,
        });
    }

    words
}

/// Число: хотя бы одна цифра, а всё остальное — цифры, точка или запятая.
/// «8d» и «25x» числами не считаются.
fn is_number(value: &str) -> bool {
    !value.is_empty()
        && value.chars().any(|ch| ch.is_ascii_digit())
        && value
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '.' || ch == ',')
}

/// Множитель темпа: «1.25x», «2x», «x0.8», «1,25 x». Возвращает число слов,
/// которые надо вырезать: обычно одно, для «x 1.25» — два.
fn tempo_multiplier_words(words: &[TitleWord], index: usize) -> Option<usize> {
    let key = words[index].key.as_str();

    // «1.25x» и «0.8x»
    if let Some(number) = key.strip_suffix('x') {
        if is_number(number) {
            return Some(1);
        }
    }
    // «x1.25» — буква и число в одном слове, пробела между ними нет
    if let Some(number) = key.strip_prefix('x') {
        if is_number(number) {
            return Some(1);
        }
    }

    let next = words.get(index + 1).map(|word| word.key.as_str());
    if key == "x" && next.map(is_number).unwrap_or(false) {
        return Some(2);
    }
    if is_number(key) && next == Some("x") {
        return Some(2);
    }

    None
}

/// Сколько слов занимает маркер версии в позиции `index`: слово из списка или
/// фраза. `None` — здесь маркера нет.
fn version_marker_words(words: &[TitleWord], index: usize) -> Option<usize> {
    let mut best: Option<usize> = None;

    for phrase in VERSION_PHRASES {
        if index + phrase.len() > words.len() {
            continue;
        }
        let matched = phrase
            .iter()
            .zip(&words[index..])
            .all(|(word, token)| token.key == *word);
        if matched && best.map(|len| phrase.len() > len).unwrap_or(true) {
            best = Some(phrase.len());
        }
    }

    if best.is_none() {
        let token = &words[index];
        if VERSION_WORDS.contains(&token.key.as_str())
            || (token.bracketed && BRACKET_VERSION_WORDS.contains(&token.key.as_str()))
        {
            best = Some(1);
        }
    }

    best
}

/// Убрать скобочные пары, внутри которых не осталось ни букв, ни цифр: после
/// вырезания маркеров от «(speed up)» остаётся пустое «()», и его надо снять.
fn drop_empty_groups(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;

    while index < chars.len() {
        let close = match chars[index] {
            '(' => Some(')'),
            '[' => Some(']'),
            '{' => Some('}'),
            _ => None,
        };
        if let Some(close) = close {
            if let Some(offset) = chars[index + 1..].iter().position(|ch| *ch == close) {
                let inner: String = chars[index + 1..index + 1 + offset].iter().collect();
                if !inner.chars().any(|ch| ch.is_alphanumeric()) {
                    index += offset + 2;
                    continue;
                }
            }
        }
        out.push(chars[index]);
        index += 1;
    }

    out
}

/// Срезать с краёв «склейку» маркеров: обычные разделители снимает `trim_edges`,
/// а «+» и «/» он не знает. Без этого «Song speed up+reverb» без скобок оставило
/// бы висящий «+» в названии.
fn trim_version_edges(value: &str) -> String {
    const GLUE: [char; 6] = ['+', '/', '&', '=', '_', '×'];
    let trimmed = value.trim_matches(|ch: char| GLUE.contains(&ch) || ch.is_whitespace());
    trim_edges(trimmed)
}

/// Привести название к виду после вырезания маркеров: пустые скобки убрать,
/// пробелы сжать, висящие разделители по краям срезать.
fn cleanup_version_text(value: &str) -> String {
    let mut text = value.to_string();
    loop {
        let next = drop_empty_groups(&text);
        if next == text {
            break;
        }
        text = next;
    }

    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    trim_version_edges(&collapsed)
}

/// Вырезать из названия маркеры производной версии: «speed up», «sped up»,
/// «speedup», «reverb», «slowed + reverb», «nightcore», «8d audio»,
/// «bass boosted», «muffled», «tiktok version», скобочные «(remix)», «(cover)»,
/// «(edit)» и множители темпа («1.25x», «x0.8»).
///
/// Возвращает очищенное название и признак производной версии. Признак
/// ставится, только если маркер нашёлся И после вырезания осталось осмысленное
/// название: «Reverb» — это песня с таким названием, а не производная версия.
pub fn strip_version_markers(title: &str) -> (String, bool) {
    let words = title_words(title);
    let mut removed = vec![false; words.len()];
    let mut found = false;
    let mut index = 0;

    while index < words.len() {
        let count = tempo_multiplier_words(&words, index)
            .or_else(|| version_marker_words(&words, index));

        match count {
            Some(count) => {
                for slot in removed.iter_mut().skip(index).take(count) {
                    *slot = true;
                }
                found = true;
                index += count;
            }
            None => index += 1,
        }
    }

    if !found {
        return (title.trim().to_string(), false);
    }

    // Вырезаем по символам: слово может занимать несколько символов, а
    // разделители между вырезанными словами срежет чистка краёв.
    let mut drop_char = vec![false; title.chars().count()];
    for (position, word) in words.iter().enumerate() {
        if removed[position] {
            for slot in drop_char.iter_mut().take(word.end).skip(word.start) {
                *slot = true;
            }
        }
    }
    let kept: String = title
        .chars()
        .enumerate()
        .filter(|(position, _)| !drop_char[*position])
        .map(|(_, ch)| ch)
        .collect();

    let cleaned = cleanup_version_text(&kept);
    let meaningful = cleaned.chars().any(|ch| ch.is_alphanumeric());
    (cleaned, meaningful)
}

/// Разделить название на части по «x», «×», «&», «+», «/», «|» и «,».
/// Однобуквенный «x» разделяет только как отдельное слово: иначе «Xylophone»
/// распалось бы на куски.
fn collage_parts(title: &str) -> Vec<String> {
    let chars: Vec<char> = title.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        let left_ok = index == 0 || !chars[index - 1].is_alphanumeric();
        let right_ok = chars
            .get(index + 1)
            .map(|next| !next.is_alphanumeric())
            .unwrap_or(true);
        let word_x = (ch == 'x' || ch == 'X') && left_ok && right_ok;

        if COLLAGE_CHARS.contains(&ch) || word_x {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
        index += 1;
    }
    parts.push(current);

    parts
        .into_iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

/// Есть ли в строке скобочная вставка: по ней видно уточнение («(ayrro)» —
/// кто именно исполняет часть), а не часть названия.
fn has_bracket_groups(value: &str) -> bool {
    value.chars().any(|ch| matches!(ch, '(' | '[' | '{'))
}

/// Убрать ЛЮБЫЕ скобочные вставки: «Miss (ayrro)» → «Miss». Внутри частей
/// коллажа скобки почти всегда про исполнителя, и поиск по ним бесполезен.
fn drop_bracket_groups(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;

    while index < chars.len() {
        let close = match chars[index] {
            '(' => Some(')'),
            '[' => Some(']'),
            '{' => Some('}'),
            _ => None,
        };
        if let Some(close) = close {
            if let Some(offset) = chars[index + 1..].iter().position(|ch| *ch == close) {
                index += offset + 2;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }

    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Отрезать хвост после последнего тире: «insomniac - tuboroshi» → «insomniac».
/// `None` — тире нет или слева от него ничего не осталось.
fn split_dash_tail(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut cut: Option<usize> = None;

    for (index, ch) in chars.iter().enumerate() {
        if *ch != '-' && *ch != '–' && *ch != '—' {
            continue;
        }
        let left_ok = index > 0 && chars[index - 1].is_whitespace();
        let right_ok = chars
            .get(index + 1)
            .map(|next| next.is_whitespace())
            .unwrap_or(false);
        if left_ok && right_ok {
            cut = Some(index);
        }
    }

    let head: String = chars[..cut?].iter().collect();
    let head = head.trim().to_string();
    if head.is_empty() {
        None
    } else {
        Some(head)
    }
}

/// Кандидат осмысленный: после чистки в нём есть буквы и хотя бы два знака.
/// «x», «1» и «—» кандидатами не считаются.
fn meaningful_candidate(value: &str) -> bool {
    let key = match_key(value);
    key.chars().count() >= 2 && key.chars().any(|ch| ch.is_alphabetic())
}

/// Кандидаты одной части коллажа: сама часть без скобочных уточнений, затем она
/// же, укороченная по последнему тире. «insomniac - tuboroshi» даёт сначала
/// целую часть, потом «insomniac».
fn part_candidates(part: &str) -> Vec<String> {
    let without_brackets = drop_bracket_groups(part);
    let base = if without_brackets.trim().is_empty() {
        part.trim().to_string()
    } else {
        without_brackets
    };

    let mut values: Vec<String> = Vec::new();
    let mut current = base;
    loop {
        values.push(current.trim().to_string());
        match split_dash_tail(&current) {
            Some(head) => current = head,
            None => break,
        }
    }

    values
        .into_iter()
        .filter(|value| meaningful_candidate(value))
        .collect()
}

/// Части коллажного названия. Пусто — название обычное: послабления не будет.
/// Коллажем считаем и несколько частей через разделители, и одиночную часть
/// со скобочным уточнением («Miss (ayrro)»).
fn collage_candidates(title: &str) -> Vec<String> {
    let parts = collage_parts(title);
    let multiple = parts.len() >= 2;
    let clarified = parts.iter().any(|part| has_bracket_groups(part));
    if !multiple && !clarified {
        return Vec::new();
    }

    let mut values: Vec<String> = Vec::new();
    for part in &parts {
        values.extend(part_candidates(part));
    }
    values
}

/// Убрать повторы кандидатов, сохранив порядок: сравниваем по тому же ключу,
/// по которому идёт сверка названий.
fn dedupe_candidates(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let key = match_key(&value);
        if key.is_empty() || out.iter().any(|seen| match_key(seen) == key) {
            continue;
        }
        out.push(value);
    }
    out
}

/// Кандидаты ослабленного прохода: очищенное название производной версии и
/// части коллажа. Пусто — трек обычный, и строгость остаётся прежней.
///
/// Порядок — от длинного кандидата к короткому: чем полнее название, тем
/// меньше шансов, что источник найдёт одноимённую чужую песню. Список
/// ограничен `MAX_ORIGINAL_CANDIDATES`: каждый кандидат — это ещё запросы.
fn original_candidates(title: &str) -> Vec<String> {
    let (clean, derivative) = strip_version_markers(title);
    let mut values: Vec<String> = Vec::new();

    if derivative {
        let normalized = normalize_title(&clean);
        if meaningful_candidate(&normalized) {
            values.push(normalized);
        }
    }

    values.extend(collage_candidates(&clean));

    let mut values = dedupe_candidates(values);
    values.sort_by(|left, right| right.chars().count().cmp(&left.chars().count()));
    values.truncate(MAX_ORIGINAL_CANDIDATES);
    values
}

/// Ослабленный проход идёт только после полного провала обычного: строгое
/// совпадение всегда лучше «похожего на оригинал».
fn should_try_original(strict_found: bool, candidates: &[String]) -> bool {
    !strict_found && !candidates.is_empty()
}

/// Дедлайн обычного прохода. Когда трек производный или коллажный, часть
/// общего бюджета придерживается для ослабленного прохода: иначе перебор
/// обычных вариантов занял бы все 8 секунд и до оригинала дело бы не дошло.
fn reserved_deadline(deadline: Instant, reserve: bool) -> Instant {
    if !reserve {
        return deadline;
    }
    deadline
        .checked_sub(Duration::from_secs(ORIGINAL_RESERVE_SECS))
        .unwrap_or(deadline)
}

/// Слова для сравнения исполнителей: без пунктуации и служебных хвостов.
/// Совпадения хотя бы по одному слову достаточно: в базах имя часто записано
/// полнее («Anonymous Ember feat. X») или короче («Anonymous Ember»).
fn match_words(value: &str) -> Vec<String> {
    comparison_key(value)
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Исполнители, перечисленные через «,», «;», «&» или «feat.».
fn split_artists(value: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current: Vec<String> = Vec::new();

    /// Закончить текущее имя и, если оно непустое, положить его в список.
    fn flush(current: &mut Vec<String>, parts: &mut Vec<String>) {
        let name = current.join(" ").trim().to_string();
        current.clear();
        if !name.is_empty() {
            parts.push(name);
        }
    }

    for word in value.split_whitespace() {
        // Запятая, точка с запятой и амперсанд разделяют и без пробелов: «A,B»
        let mut piece = String::new();
        for ch in word.chars() {
            if ch == ',' || ch == ';' || ch == '&' {
                if !piece.is_empty() {
                    current.push(std::mem::take(&mut piece));
                }
                flush(&mut current, &mut parts);
            } else {
                piece.push(ch);
            }
        }

        if piece.is_empty() {
            continue;
        }

        // «feat.», «ft.», «featuring» — это тоже разделитель исполнителей
        if is_feature_marker(&bare_word(&piece)) {
            flush(&mut current, &mut parts);
        } else {
            current.push(piece);
        }
    }

    flush(&mut current, &mut parts);
    parts
}

/// Исполнители из хвоста «(feat. X)» в названии: «shiawase» и подобные.
fn featured_artists(title: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut collecting = false;
    let mut current = String::new();

    for word in title.split_whitespace() {
        if !collecting {
            if is_feature_marker(&bare_word(word)) {
                collecting = true;
            }
            continue;
        }

        // Список гостей заканчивается закрывающей скобкой
        let stop = word.contains(')') || word.contains(']');
        let piece: String = word.chars().take_while(|ch| *ch != ')' && *ch != ']').collect();

        if !piece.is_empty() {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(&piece);
        }

        if stop || is_separator_word(word) {
            if !current.is_empty() {
                names.extend(split_artists(&current));
                current.clear();
            }
            collecting = false;
        }
    }

    if !current.is_empty() {
        names.extend(split_artists(&current));
    }

    names
}

/// «feat.», «ft.», «featuring» — по этим словам начинается список гостей.
fn is_feature_marker(key: &str) -> bool {
    matches!(key, "feat" | "feats" | "ft" | "featuring" | "featured")
}

/// Основной исполнитель: без служебных хвостов и без соавторов.
pub fn normalize_artist(value: &str) -> String {
    let without_brackets = strip_noise_brackets(value);
    let without_tails = strip_noise_tails(&without_brackets);
    let cleaned = trim_edges(&without_tails);

    match split_artists(&cleaned).into_iter().next() {
        Some(first) => first,
        None => cleaned,
    }
}

/// Исполнители, которых стоит попробовать по отдельности: перечисленные в теге
/// («A, B», «A & B») и упомянутые в названии как feat. Повторы в другом
/// регистре — тот же человек.
fn artist_candidates(artist: &str, title: &str) -> Vec<String> {
    let mut names = split_artists(artist);
    names.extend(featured_artists(title));

    let mut out: Vec<String> = Vec::new();
    for name in names {
        let value = name.trim().to_string();
        if value.is_empty() {
            continue;
        }
        if out.iter().any(|seen| comparison_key(seen) == comparison_key(&value)) {
            continue;
        }
        out.push(value);
    }

    out
}

// ---------- Строгая проверка соответствия ----------

/// Найденная источником запись: название, исполнители и длительность.
/// Только эти поля и участвуют в проверке — позиция записи в списке поиска
/// ничего не доказывает, поэтому раньше и приезжал текст чужой песни.
#[derive(Debug, Clone, Default)]
struct FoundRecord {
    title: String,
    /// Все исполнители записи: у Netease это `ar[].name`, у LRCLIB — одна
    /// строка `artistName` (иногда со списком через запятую).
    artists: Vec<String>,
    /// Длительность в секундах; 0 — источник её не сообщил.
    duration_sec: i64,
}

/// Все непустые исполнители записи в виде строк.
fn record_artists(record: &FoundRecord) -> Vec<&str> {
    record
        .artists
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .collect()
}

/// Расхождение длительностей: `None` — сравнивать не с чем.
fn duration_delta(found_sec: i64, wanted_sec: u32) -> Option<i64> {
    if found_sec <= 0 || wanted_sec == 0 {
        return None;
    }
    Some((found_sec - wanted_sec as i64).abs())
}

/// Исполнитель записи подтверждает запрос: хотя бы одно общее слово. Пустой
/// запрос и запись без исполнителя подтверждением не считаются.
fn artist_matches(record: &FoundRecord, artist: &str) -> bool {
    let wanted_words = match_words(artist);
    if wanted_words.is_empty() {
        return false;
    }
    record_artists(record).iter().any(|name| {
        match_words(name)
            .iter()
            .any(|word| wanted_words.contains(word))
    })
}

/// Результат держится только на названии: оно совпало ТОЧНО, а исполнитель не
/// подтвердился — в базе он другой или его там нет вовсе. Такой текст честно
/// помечается «от оригинала», чтобы пользователь видел, чей он.
///
/// Только для точного названия: при частичном совпадении запись обязана
/// подтвердиться ещё и исполнителем либо длительностью.
fn title_only_match(record: &FoundRecord, title: &str, artist: &str) -> bool {
    let wanted = match_key(title);
    !wanted.is_empty() && match_key(&record.title) == wanted && !artist_matches(record, artist)
}

/// Строгая проверка: подходит ли найденная запись запросу. `None` — подходит,
/// `Some(причина)` — нет, и причина уходит в журнал попыток.
///
/// Правила:
/// 1. Название после нормализации (нижний регистр, только буквы и цифры,
///    служебные хвосты срезаны) равно запросу или содержит его — в любую
///    сторону. Иначе это другая песня.
/// 2. Если название совпало ТОЧНО — этого достаточно: короткие и числовые
///    названия («44») лежат в базах под чужим именем исполнителя и с другой
///    длительностью, и требовать больше нечего. Такой ответ помечается
///    `from_original`, если исполнитель не подтвердился.
/// 3. Название совпало только частично: исполнитель должен подтвердить запись
///    (хотя бы одно общее слово). Если исполнителя в базе нет вовсе, вместо
///    него подтверждает длительность, и допуск там узкий — ±3 с.
/// 4. Если длительность трека известна и расходится больше чем на 5 с — это
///    несовпадение, кроме случая, когда точно совпали и название, и исполнитель.
fn mismatch_reason(
    record: &FoundRecord,
    title: &str,
    artist: &str,
    duration_sec: u32,
) -> Option<String> {
    let wanted_title = match_key(title);
    let found_title = match_key(&record.title);

    let title_equal = !wanted_title.is_empty() && found_title == wanted_title;
    let title_close = title_equal
        || (!wanted_title.is_empty()
            && !found_title.is_empty()
            && (found_title.contains(&wanted_title) || wanted_title.contains(&found_title)));

    if !wanted_title.is_empty() && !title_close {
        return Some(format!(
            "название «{}» не совпадает с «{}»",
            record.title, title
        ));
    }

    // Точное название — самодостаточное доказательство: раньше такие треки
    // находились, а строгая сверка начала их отбрасывать.
    if title_equal {
        return None;
    }

    let wanted_words = match_words(artist);
    let artists = record_artists(record);
    let artist_matched = artist_matches(record, artist);

    // Исполнитель в базе есть, но это другой человек — текст точно чужой
    if !wanted_words.is_empty() && !artists.is_empty() && !artist_matched {
        return Some(format!(
            "исполнитель «{}» не совпадает с «{}»",
            artists.join(", "),
            artist
        ));
    }

    let delta = duration_delta(record.duration_sec, duration_sec);

    // Исполнителя в базе нет вовсе: название подтверждаем длительностью
    if !wanted_words.is_empty() && artists.is_empty() {
        // Длительность трека неизвестна — требовать нечего, доверяем названию
        if duration_sec == 0 {
            return None;
        }
        return match delta {
            Some(value) if value <= TITLE_ONLY_DURATION_TOLERANCE_SEC => None,
            Some(value) => Some(format!(
                "исполнитель в базе не указан, а длительность разошлась на {value} с"
            )),
            None => Some(
                "исполнитель в базе не указан, а длительность записи неизвестна — \
                 подтвердить совпадение нечем"
                    .to_string(),
            ),
        };
    }

    let artist_ok = !wanted_words.is_empty() && artist_matched;
    if let Some(value) = delta {
        if value > DURATION_TOLERANCE_SEC && !(title_equal && artist_ok) {
            return Some(format!(
                "длительность разошлась на {value} с: {} с против {} с",
                record.duration_sec, duration_sec
            ));
        }
    }

    None
}

/// Смягчённая сверка ослабленного прохода: название записи должно совпасть с
/// чистым названием — равным или содержащим его в любую сторону после
/// нормализации. Исполнитель и длительность не проверяются вовсе: у ускоренной
/// версии длительность короче, а в теге исполнителя стоит загрузивший, а не
/// автор. Название при этом сверяется так же строго, как и раньше.
fn original_mismatch_reason(record: &FoundRecord, clean_title: &str) -> Option<String> {
    let wanted = match_key(clean_title);
    if wanted.is_empty() {
        return Some("искать нечего: название пустое".to_string());
    }

    let found = match_key(&record.title);
    if found.is_empty() {
        return Some("у записи нет названия для сверки".to_string());
    }

    if found == wanted || found.contains(&wanted) || wanted.contains(&found) {
        return None;
    }

    Some(format!(
        "название «{}» не совпадает с «{}»",
        record.title, clean_title
    ))
}

/// Запись LRCLIB: `trackName`, `artistName`, `duration` (в секундах).
fn lrclib_record(body: &serde_json::Value) -> FoundRecord {
    FoundRecord {
        title: text_field(body, "trackName").unwrap_or_default(),
        artists: text_field(body, "artistName").into_iter().collect(),
        duration_sec: duration_of(body),
    }
}

/// Название и исполнитель найденной записи — то, что видно в журнале.
fn matched_labels(record: &FoundRecord) -> (Option<String>, Option<String>) {
    let title = if record.title.trim().is_empty() {
        None
    } else {
        Some(record.title.clone())
    };
    let artists = record_artists(record);
    let artist = if artists.is_empty() {
        None
    } else {
        Some(artists.join(", "))
    };
    (title, artist)
}

/// Один вариант запроса: либо точный адрес, либо свободный поиск.
#[derive(Debug, Clone, PartialEq)]
enum Lookup {
    Exact { artist: String, title: String },
    /// Точный запрос без длительности: /api/get отвечает 404, если
    /// длительность в тегах трека не совпала, а имя при этом верное.
    ExactName { artist: String, title: String },
    Search { query: String },
}

impl Lookup {
    /// Как вариант называется в журнале попыток.
    fn label(&self) -> String {
        match self {
            Lookup::Exact { artist, title } => format!("точный запрос «{artist} — {title}»"),
            Lookup::ExactName { artist, title } => {
                format!("точный запрос без длительности «{artist} — {title}»")
            }
            Lookup::Search { query } => format!("поиск «{query}»"),
        }
    }

    fn url(&self, duration_sec: u32) -> String {
        match self {
            Lookup::Exact { artist, title } => exact_url(artist, title, None, duration_sec),
            Lookup::ExactName { artist, title } => exact_url(artist, title, None, 0),
            Lookup::Search { query } => search_url(query),
        }
    }
}

/// Убрать повторы, сохранив порядок: один и тот же адрес дважды не спрашиваем.
fn unique(plan: Vec<Lookup>) -> Vec<Lookup> {
    let mut out: Vec<Lookup> = Vec::new();
    for item in plan {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// Порядок попыток: от самого точного совпадения к самому широкому.
fn variants(artist: &str, title: &str) -> Vec<Lookup> {
    let artist = artist.trim();
    let title = title.trim();
    let clean_artist = normalize_artist(artist);
    let clean_title = normalize_title(title);
    let mut plan: Vec<Lookup> = Vec::new();

    // 1. Как есть: исполнитель и полное название — самое надёжное, когда
    //    теги заполнены аккуратно.
    if !artist.is_empty() && !title.is_empty() {
        plan.push(Lookup::Exact {
            artist: artist.to_string(),
            title: title.to_string(),
        });
    }

    // 2. То же, но без «(feat. …)», «- remastered» и прочих хвостов: именно
    //    из-за них трек «forgotten dreams (feat. shiawase)» и не находился.
    if !clean_artist.is_empty() && !clean_title.is_empty() {
        plan.push(Lookup::Exact {
            artist: clean_artist.clone(),
            title: clean_title.clone(),
        });
    }

    // 3. Точный запрос без длительности: длительность в тегах бывает
    //    неточной, а /api/get из-за неё отвечает 404 — хотя имя верное.
    if !clean_artist.is_empty() && !clean_title.is_empty() {
        plan.push(Lookup::ExactName {
            artist: clean_artist.clone(),
            title: clean_title.clone(),
        });
    }

    // 4. Только очищенное название: исполнитель в тегах бывает чужим.
    if !clean_title.is_empty() {
        plan.push(Lookup::Search {
            query: clean_title.clone(),
        });
    }

    // 5. Свободный поиск «исполнитель название» — как было раньше.
    let free = match (artist.is_empty(), title.is_empty()) {
        (true, _) => title.to_string(),
        (_, true) => artist.to_string(),
        _ => format!("{artist} {title}"),
    };
    if !free.is_empty() {
        plan.push(Lookup::Search { query: free });
    }

    // 6. Тот же свободный поиск, но с очищенными тегами.
    if !clean_artist.is_empty() && !clean_title.is_empty() {
        plan.push(Lookup::Search {
            query: format!("{clean_artist} {clean_title}"),
        });
    }

    // 7. Каждый исполнитель по отдельности: «shadowraze», «shiawase».
    if !clean_title.is_empty() {
        for name in artist_candidates(artist, title) {
            plan.push(Lookup::Search {
                query: format!("{name} {clean_title}"),
            });
        }
    }

    unique(plan)
}

// ---------- Сеть ----------

/// Транспорт запроса: curl с DNS over HTTPS или обычный HTTP.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Transport {
    Doh,
    Plain,
}

impl Transport {
    fn label(self) -> &'static str {
        match self {
            Transport::Doh => "DoH",
            Transport::Plain => "обычный",
        }
    }
}

/// Итог одного адреса: записи нет вовсе или транспорт не ответил.
#[derive(Debug)]
enum LookupError {
    /// Источник честно ответил 404 — это не сетевая ошибка.
    Missing,
    /// Транспорт не смог получить ответ.
    Failed(String),
}

/// Тело ответа и код состояния, который curl дописал через `-w`. `origin` —
/// имя источника: по нему понятно, кто именно ответил отказом.
fn reply_of(raw: &str, origin: &str, label: &str) -> Result<String, LookupError> {
    let (body, code) = match raw.rsplit_once('\n') {
        Some((body, code)) => (body, code.trim()),
        None => (raw, ""),
    };

    let body = body.trim_end_matches(&['\r', '\n'][..]);

    match code {
        "404" => Err(LookupError::Missing),
        "200" | "" => {
            if body.trim().is_empty() {
                Err(LookupError::Failed(format!(
                    "пустой ответ от {origin} ({label})"
                )))
            } else {
                Ok(body.to_string())
            }
        }
        other => Err(LookupError::Failed(format!(
            "{origin} ответил {other} ({label})"
        ))),
    }
}

/// Описание сетевого обращения: адрес, метод и заголовки. Непустой список
/// полей формы означает POST; значения хранятся как есть — кодируют их curl
/// и ureq, иначе кириллица закодировалась бы дважды.
#[derive(Debug, Clone, PartialEq)]
struct Request {
    url: String,
    form: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    /// Имя источника для сообщений об ошибках: «Netease ответил 403».
    origin: &'static str,
}

impl Request {
    /// Обычный GET.
    fn get(origin: &'static str, url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            form: Vec::new(),
            headers: Vec::new(),
            origin,
        }
    }

    /// POST с полями формы.
    fn post(origin: &'static str, url: impl Into<String>, form: Vec<(&str, &str)>) -> Self {
        Self {
            url: url.into(),
            form: form
                .into_iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            headers: Vec::new(),
            origin,
        }
    }

    fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    fn is_post(&self) -> bool {
        !self.form.is_empty()
    }
}

/// Аргументы curl для одного обращения. Вынесены отдельной функцией, чтобы
/// флаги транспорта (в том числе `--ssl-no-revoke`) можно было проверить тестом.
fn curl_args(request: &Request, transport: Transport, timeout: Duration) -> Vec<String> {
    let seconds = timeout.as_secs().max(1).to_string();
    let mut args: Vec<String> = vec!["-sS".into(), "--max-time".into(), seconds];

    // На Windows curl собран с Schannel и по умолчанию проверяет отзыв
    // сертификата. Когда CRL/OCSP недоступны, запрос падает с
    // CRYPT_E_REVOCATION_OFFLINE — именно на этом вис api.lyrics.ovh.
    // Флаг понимает только Schannel, поэтому на других платформах его нет.
    if cfg!(windows) {
        args.push(SSL_NO_REVOKE.into());
    }

    if transport == Transport::Doh {
        args.push("--doh-url".into());
        args.push(DOH_URL.into());
    }

    // Прокси выбранного маршрута: при «напрямую» аргументов нет.
    args.extend(crate::net::curl_route_args());

    // Если у запроса свой User-Agent (так просит Netease), общий не
    // подставляем: иначе curl отправит два заголовка User-Agent.
    let own_agent = request
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("User-Agent"));
    if !own_agent {
        args.push("-A".into());
        args.push(USER_AGENT.into());
    }

    for (name, value) in &request.headers {
        args.push("-H".into());
        args.push(format!("{name}: {value}"));
    }

    if request.is_post() {
        args.push("-X".into());
        args.push("POST".into());
        for (name, value) in &request.form {
            args.push("--data-urlencode".into());
            args.push(format!("{name}={value}"));
        }
    }

    args.push("-w".into());
    args.push("\n%{http_code}".into());
    args.push(request.url.clone());
    args
}

/// Один запрос выбранным транспортом.
fn get_text(
    request: &Request,
    transport: Transport,
    timeout: Duration,
) -> Result<String, LookupError> {
    if transport == Transport::Doh {
        let args = curl_args(request, transport, timeout);
        let output = crate::silent::hidden("curl")
            .args(&args)
            .output()
            .map_err(|e| LookupError::Failed(format!("curl недоступен: {e}")))?;

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(LookupError::Failed(if error.is_empty() {
                "curl не получил ответ".into()
            } else {
                error
            }));
        }

        let raw = String::from_utf8_lossy(&output.stdout).to_string();
        return reply_of(&raw, request.origin, "DoH");
    }

    // Запасной путь: постоянный клиент приложения. Соединения и DNS
    // переиспользуются, а маршрут и прокси берутся из общих настроек. Отзыв
    // сертификата он не проверяет вовсе, но и DNS over HTTPS не умеет.
    let mut http = if request.is_post() {
        let body = request
            .form
            .iter()
            .map(|(name, value)| format!("{}={}", urlencode(name), urlencode(value)))
            .collect::<Vec<_>>()
            .join("&");
        crate::net::HttpRequest::post(request.url.clone(), body.into_bytes())
            .header("Content-Type", "application/x-www-form-urlencoded")
    } else {
        crate::net::HttpRequest::get(request.url.clone())
    };
    http = http
        .user_agent(USER_AGENT)
        .timeout(timeout.clamp(Duration::from_millis(500), Duration::from_secs(REQUEST_TIMEOUT_SECS)));
    for (name, value) in &request.headers {
        http = http.header(name, value);
    }

    let response = crate::net::http(&http)
        .map_err(|error| LookupError::Failed(format!("{error} (обычный)")))?;

    match response.code {
        404 => Err(LookupError::Missing),
        200..=299 => {
            if response.text.trim().is_empty() {
                Err(LookupError::Failed(format!(
                    "пустой ответ от {} (обычный)",
                    request.origin
                )))
            } else {
                Ok(response.text)
            }
        }
        other => Err(LookupError::Failed(format!(
            "{} ответил {other} (обычный)",
            request.origin
        ))),
    }
}

/// Достаёт JSON по адресу, помня, какой транспорт уже сработал, и следя за
/// общим бюджетом времени на всю операцию поиска.
struct Fetcher {
    preferred: Option<Transport>,
    /// Абсолютный момент, после которого запросы не начинаются. Дедлайн общий
    /// для всех потоков: источники опрашиваются параллельно и вместе
    /// укладываются в один бюджет.
    deadline: Instant,
}

/// Общая отмена для параллельных потоков: как только лучший ответ найден,
/// остальные источники прекращают перебирать варианты на ближайшей проверке.
/// Без неё ранний выход не имел бы смысла — потоки продолжали бы работать.
#[derive(Clone, Default)]
struct Cancel(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Cancel {
    fn new() -> Self {
        Self::default()
    }

    fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Fetcher {
    /// Момент окончания бюджета: считается один раз на всю операцию поиска.
    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(TOTAL_BUDGET_SECS)
    }

    fn new(deadline: Instant) -> Self {
        Self {
            preferred: None,
            deadline,
        }
    }

    /// Сколько времени осталось на всю операцию: None — бюджет исчерпан.
    fn remaining(&self) -> Option<Duration> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            None
        } else {
            Some(left)
        }
    }

    /// Тело ответа как есть, без разбора JSON: так забирается HTML-страница
    /// песни Genius. Вместе с телом возвращается ярлык транспорта, который
    /// ответил, — для сообщений об ошибках разбора в `json`.
    fn raw(&mut self, request: &Request) -> Result<(String, &'static str), LookupError> {
        // Тот транспорт, что уже отвечал, идёт первым: иначе каждый адрес
        // стоил бы двух попыток и бюджет кончался бы на втором варианте.
        let order = match self.preferred {
            Some(Transport::Plain) => [Transport::Plain, Transport::Doh],
            _ => [Transport::Doh, Transport::Plain],
        };

        let mut errors: Vec<String> = Vec::new();
        for transport in order {
            let left = match self.remaining() {
                Some(left) => left,
                None => break,
            };

            let timeout = left.min(Duration::from_secs(REQUEST_TIMEOUT_SECS));
            match get_text(request, transport, timeout) {
                Ok(text) => {
                    self.preferred = Some(transport);
                    return Ok((text, transport.label()));
                }
                // 404 — это ответ: второй транспорт ничего не изменит
                Err(LookupError::Missing) => return Err(LookupError::Missing),
                Err(LookupError::Failed(error)) => {
                    errors.push(format!("{}: {error}", transport.label()))
                }
            }
        }

        if errors.is_empty() {
            return Err(LookupError::Failed("время на поиск текста вышло".into()));
        }
        Err(LookupError::Failed(errors.join("; ")))
    }

    fn json(&mut self, request: &Request) -> Result<serde_json::Value, LookupError> {
        let (text, label) = self.raw(request)?;
        serde_json::from_str::<serde_json::Value>(&text).map_err(|_| {
            LookupError::Failed(format!("{label}: {} вернул неожиданный ответ", request.origin))
        })
    }
}

// ---------- Источники ----------

/// Насколько ответ ценен: синхронный текст всегда важнее обычного, а при
/// одинаковой синхронности LRCLIB важнее Netease. Чем больше, тем лучше.
fn rank_of(source: &str, synced: bool) -> i32 {
    match (source, synced) {
        ("lrclib", true) => 40,
        ("netease", true) => 30,
        // Синхронность, посчитанная по длине строк (см. `estimate_lrc`):
        // лучше обычного текста, но хуже любого настоящего LRC.
        ("genius", true) => 15,
        ("lyrics.ovh", true) => 12,
        ("lrclib", false) => 20,
        ("netease", false) => 10,
        // Genius и lyrics.ovh — только обычный текст. Genius выше: у него
        // больше покрытие, а запись подтверждается метаданными поиска.
        ("genius", false) => 7,
        ("lyrics.ovh", false) => 5,
        _ => 0,
    }
}

/// Лучший из возможных ответов: как только он найден, остальные источники не
/// нужны. Это синхронный текст LRCLIB.
const BEST_RANK: i32 = 40;

/// Найденный ответ вместе с его оценкой.
#[derive(Debug, Clone)]
struct Candidate {
    rank: i32,
    lyrics: Lyrics,
}

/// Итог работы одного источника: его лучший ответ, журнал попыток и признак
/// того, ответил ли он вообще. Собирается в потоке источника и уходит в общий
/// канал — общее состояние между потоками не разделяется.
#[derive(Debug, Default, Clone)]
struct SourceOutcome {
    best: Option<Candidate>,
    attempts: Vec<String>,
    answered: bool,
    network_error: Option<String>,
}

/// Состояние поиска по одному источнику: транспорт, журнал попыток и лучший
/// найденный ответ. У каждого потока свой экземпляр.
struct Search {
    fetcher: Fetcher,
    /// Общая отмена: приходит извне, когда лучший ответ уже найден.
    cancel: Cancel,
    /// Что пробовали — попадает в журнал ошибок и в сам ответ.
    attempts: Vec<String>,
    /// Хотя бы один источник ответил (неважно, нашёл он текст или нет).
    answered: bool,
    /// Последняя сетевая ошибка: если не ответил никто, она уходит наверх.
    network_error: Option<String>,
    best: Option<Candidate>,
}

impl Search {
    /// Поиск по одному источнику в своём потоке: общая отмена и общий дедлайн.
    fn with_cancel(cancel: Cancel, deadline: Instant) -> Self {
        Self {
            fetcher: Fetcher::new(deadline),
            cancel,
            attempts: Vec::new(),
            answered: false,
            network_error: None,
            best: None,
        }
    }

    /// Бюджет времени на всю операцию уже вышел.
    fn out_of_time(&self) -> bool {
        self.fetcher.remaining().is_none()
    }

    /// Пора прекращать перебор вариантов: либо время вышло, либо лучший ответ
    /// уже найден другим источником. Запрос в полёте не прерывается — он
    /// всё равно ограничен `REQUEST_TIMEOUT_SECS`.
    fn should_stop(&self) -> bool {
        self.cancel.is_cancelled() || self.out_of_time()
    }

    /// Почему перебор прекращён — это же уходит в журнал попыток.
    fn stop_reason(&self) -> String {
        if self.cancel.is_cancelled() {
            "поиск прекращён: лучший ответ уже найден другим источником".into()
        } else {
            "время на поиск текста вышло".into()
        }
    }

    /// Отдать накопленное наружу, когда поток заканчивает работу.
    fn into_outcome(self) -> SourceOutcome {
        SourceOutcome {
            best: self.best,
            attempts: self.attempts,
            answered: self.answered,
            network_error: self.network_error,
        }
    }

    /// Запрос к источнику: сетевую ошибку запоминаем, но поиск не прекращаем —
    /// следующий источник ещё может ответить.
    fn json(&mut self, request: &Request) -> Result<serde_json::Value, LookupError> {
        match self.fetcher.json(request) {
            Ok(body) => {
                self.answered = true;
                Ok(body)
            }
            // 404 — это тоже ответ источника, а не сетевая ошибка
            Err(LookupError::Missing) => {
                self.answered = true;
                Err(LookupError::Missing)
            }
            Err(LookupError::Failed(error)) => {
                self.network_error = Some(error.clone());
                Err(LookupError::Failed(error))
            }
        }
    }

    /// Запрос, ответ которого — не JSON (HTML-страница Genius): сетевые правила
    /// те же, что у `json`.
    fn text(&mut self, request: &Request) -> Result<String, LookupError> {
        match self.fetcher.raw(request) {
            Ok((body, _)) => {
                self.answered = true;
                Ok(body)
            }
            // 404 — это тоже ответ источника, а не сетевая ошибка
            Err(LookupError::Missing) => {
                self.answered = true;
                Err(LookupError::Missing)
            }
            Err(LookupError::Failed(error)) => {
                self.network_error = Some(error.clone());
                Err(LookupError::Failed(error))
            }
        }
    }

    /// Запомнить ответ, если он лучше уже найденного. При равной оценке
    /// остаётся тот, что нашёлся раньше.
    fn consider(&mut self, lyrics: Lyrics) {
        if !lyrics.found {
            return;
        }
        let source = lyrics.source.clone().unwrap_or_default();
        let rank = rank_of(&source, lyrics.synced.is_some());
        let better = self
            .best
            .as_ref()
            .map(|best| rank > best.rank)
            .unwrap_or(true);

        if better {
            self.best = Some(Candidate { rank, lyrics });
        }
    }

}

/// Ранг лучшего ответа источника; `-1` — ответа нет.
fn best_rank_of(outcome: &SourceOutcome) -> i32 {
    outcome.best.as_ref().map(|item| item.rank).unwrap_or(-1)
}

/// LRCLIB: источник синхронных текстов с наивысшим приоритетом. Перебираем
/// варианты запроса от точного к широкому и останавливаемся на синхронном.
fn search_lrclib(search: &mut Search, artist: &str, title: &str, duration_sec: u32) {
    for lookup in variants(artist, title) {
        if search.should_stop() {
            search.attempts.push(search.stop_reason());
            break;
        }

        match search.json(&Request::get("LRCLIB", lookup.url(duration_sec))) {
            Ok(body) => match &lookup {
                Lookup::Exact { .. } | Lookup::ExactName { .. } => {
                    // Точный адрес — ещё не гарантия: LRCLIB умеет ответить
                    // похожей записью. Сверяем название, исполнителя и время.
                    if let Some(reason) = mismatch_reason(
                        &lrclib_record(&body),
                        title,
                        artist,
                        duration_sec,
                    ) {
                        search
                            .attempts
                            .push(format!("{} — не совпало: {reason}", lookup.label()));
                        continue;
                    }
                    let mut found = lyrics_from(&body);
                    // Название совпало точно, а исполнитель — нет: текст чужой
                    // версии, и об этом надо сказать пользователю.
                    found.from_original = title_only_match(&lrclib_record(&body), title, artist);
                    if found.synced.is_some() {
                        search
                            .attempts
                            .push(format!("{} — синхронный текст", lookup.label()));
                        search.consider(found);
                        return;
                    }
                    if found.found {
                        search
                            .attempts
                            .push(format!("{} — только обычный текст", lookup.label()));
                        search.consider(found);
                    } else {
                        search
                            .attempts
                            .push(format!("{} — текста нет", lookup.label()));
                    }
                }
                Lookup::Search { .. } => {
                    match pick_from_search(&body, title, artist, duration_sec) {
                        (Some(item), _) => {
                            let mut found = lyrics_from(item);
                            found.from_original =
                                title_only_match(&lrclib_record(item), title, artist);
                            if found.synced.is_some() {
                                search
                                    .attempts
                                    .push(format!("{} — синхронный текст", lookup.label()));
                                search.consider(found);
                                return;
                            }
                            search
                                .attempts
                                .push(format!("{} — только обычный текст", lookup.label()));
                            search.consider(found);
                        }
                        (None, Some(reason)) => search.attempts.push(format!(
                            "{} — ничего не совпало: {reason}",
                            lookup.label()
                        )),
                        (None, None) => search
                            .attempts
                            .push(format!("{} — ничего не нашлось", lookup.label())),
                    }
                }
            },
            // Записи по этому адресу нет — переходим к следующему варианту
            Err(LookupError::Missing) => {
                search
                    .attempts
                    .push(format!("{} — записи нет", lookup.label()));
            }
            Err(LookupError::Failed(error)) => {
                search
                    .attempts
                    .push(format!("{} — сеть: {error}", lookup.label()));
            }
        }
    }
}

/// Ослабленный проход LRCLIB: ищем по одному названию — сначала вместе с
/// исполнителем (источнику это помогает ранжировать записи), затем без него.
/// Сверка идёт только по названию: у производной версии длительность другая, а
/// исполнитель в теге — загрузивший. Останавливаемся на первом синхронном
/// тексте; если синхронного нет, остаётся первый найденный обычный.
fn search_lrclib_original(search: &mut Search, artist: &str, candidates: &[String]) {
    let artist = normalize_artist(artist);

    for candidate in candidates {
        let mut queries: Vec<String> = Vec::new();
        if !artist.is_empty() {
            queries.push(format!("{artist} {candidate}"));
        }
        queries.push(candidate.clone());

        for query in queries {
            if search.should_stop() {
                search.attempts.push(search.stop_reason());
                return;
            }

            let label = format!("по оригиналу: поиск «{query}»");
            match search.json(&Request::get("LRCLIB", search_url(&query))) {
                Ok(body) => match pick_from_search_original(&body, candidate) {
                    (Some(item), _) => {
                        let found = original_lyrics_from(item);
                        let synced = found.synced.is_some();
                        search.attempts.push(format!(
                            "{label} — {}",
                            if synced {
                                "синхронный текст"
                            } else {
                                "только обычный текст"
                            }
                        ));
                        search.consider(found);
                        if synced {
                            return;
                        }
                    }
                    (None, Some(reason)) => search
                        .attempts
                        .push(format!("{label} — ничего не совпало: {reason}")),
                    (None, None) => search
                        .attempts
                        .push(format!("{label} — ничего не нашлось")),
                },
                Err(LookupError::Missing) => search
                    .attempts
                    .push(format!("{label} — записи нет")),
                Err(LookupError::Failed(error)) => search
                    .attempts
                    .push(format!("{label} — сеть: {error}")),
            }
        }
    }
}

/// Netease Cloud Music: неофициальные, но открытые эндпоинты без ключей и
/// регистрации — каталог большой, у многих песен есть синхронный LRC.
/// Официальной поддержки нет: эндпоинт может ответить отказом или потребовать
/// cookie — тогда честно идём к следующему источнику.
const NETEASE_SEARCH_URL: &str = "https://music.163.com/api/search/get";
const NETEASE_LYRIC_URL: &str = "https://music.163.com/api/song/lyric";

/// Заглушки, которыми Netease помечает треки без текста: это не текст песни,
/// а строка-заплатка, и показывать её нельзя.
const NETEASE_STUBS: [&str; 3] = [
    "此歌曲为没有填词的纯音乐",
    "纯音乐，请欣赏",
    "该歌曲还没有歌词",
];

/// Варианты поиска Netease: сначала «исполнитель название», затем «только
/// название» — исполнитель в тегах бывает записан иначе, чем в каталоге.
fn netease_queries(artist: &str, title: &str) -> Vec<String> {
    let artist = normalize_artist(artist);
    let title = normalize_title(title);
    let mut queries: Vec<String> = Vec::new();

    if !artist.is_empty() && !title.is_empty() {
        queries.push(format!("{artist} {title}"));
    }
    if !title.is_empty() && !queries.iter().any(|query| query == &title) {
        queries.push(title.clone());
    }

    queries
}

/// Запрос поиска: POST с полями формы — так его вызывает и веб-клиент Netease.
fn netease_search_request(query: &str) -> Request {
    Request::post(
        "Netease",
        NETEASE_SEARCH_URL,
        vec![
            ("s", query),
            ("type", "1"),
            ("limit", "10"),
            ("offset", "0"),
        ],
    )
    .header("Referer", NETEASE_REFERER)
    .header("User-Agent", NETEASE_AGENT)
}

/// Запрос текста по id трека: поле `lrc.lyric` содержит LRC.
fn netease_lyric_request(id: i64) -> Request {
    let id = id.to_string();
    Request::post(
        "Netease",
        NETEASE_LYRIC_URL,
        vec![
            ("id", id.as_str()),
            ("lv", "1"),
            ("kv", "1"),
            ("tv", "-1"),
        ],
    )
    .header("Referer", NETEASE_REFERER)
    .header("User-Agent", NETEASE_AGENT)
}

/// Оценка трека из поиска Netease: длительность приходит в миллисекундах,
/// поэтому сравниваем её с тегами, где она в секундах.
fn netease_song_score(song: &serde_json::Value, duration_sec: u32) -> i32 {
    let mut total = 0;

    if duration_sec > 0 {
        if let Some(ms) = song.get("duration").and_then(|value| value.as_i64()) {
            if ms > 0 {
                let delta = (ms / 1000 - duration_sec as i64).abs();
                if delta <= DURATION_TOLERANCE_SEC {
                    // Чем ближе длительность, тем лучше — как и в `score`
                    total += 100 + (DURATION_TOLERANCE_SEC - delta) as i32;
                } else if delta <= 10 {
                    total += 20;
                } else {
                    total -= 10;
                }
            }
        }
    }
    if song.get("name").and_then(|value| value.as_str()).is_some() {
        total += 1;
    }
    total
}

/// Трек с наиболее подходящей длительностью из тех, что прошли строгую
/// проверку соответствия. Записи без id пропускаем: по ним нельзя запросить
/// текст. Второе значение — причина отказа первого кандидата для журнала.
fn pick_netease_song<'a>(
    body: &'a serde_json::Value,
    title: &str,
    artist: &str,
    duration_sec: u32,
) -> (Option<&'a serde_json::Value>, Option<String>) {
    let songs = match body
        .get("result")
        .and_then(|value| value.get("songs"))
        .and_then(|value| value.as_array())
    {
        Some(songs) => songs,
        None => return (None, None),
    };

    let mut best: Option<(&serde_json::Value, i32)> = None;
    let mut rejected: Option<String> = None;

    for song in songs {
        if song.get("id").and_then(|value| value.as_i64()).is_none() {
            continue;
        }

        if let Some(reason) = mismatch_reason(&netease_record(song), title, artist, duration_sec) {
            if rejected.is_none() {
                rejected = Some(reason);
            }
            continue;
        }

        let value = netease_song_score(song, duration_sec)
            + if artist_matches(&netease_record(song), artist) {
                ARTIST_BONUS
            } else {
                0
            };
        match best {
            Some((_, current)) if current >= value => {}
            _ => best = Some((song, value)),
        }
    }

    (best.map(|(song, _)| song), rejected)
}

/// То же, что `pick_netease_song`, но для ослабленного прохода: запись обязана
/// совпасть только по названию, исполнитель и длительность не участвуют.
fn pick_netease_song_original<'a>(
    body: &'a serde_json::Value,
    clean_title: &str,
) -> (Option<&'a serde_json::Value>, Option<String>) {
    let songs = match body
        .get("result")
        .and_then(|value| value.get("songs"))
        .and_then(|value| value.as_array())
    {
        Some(songs) => songs,
        None => return (None, None),
    };

    let mut best: Option<&serde_json::Value> = None;
    let mut rejected: Option<String> = None;

    for song in songs {
        if song.get("id").and_then(|value| value.as_i64()).is_none() {
            continue;
        }

        if let Some(reason) = original_mismatch_reason(&netease_record(song), clean_title) {
            if rejected.is_none() {
                rejected = Some(reason);
            }
            continue;
        }

        if best.is_none() {
            best = Some(song);
        }
    }

    (best, rejected)
}

/// Все исполнители трека Netease: `ar[].name` в новом ответе поиска и
/// `artists[].name` в старом. Проверяем именно эти поля — позиция трека в
/// списке поиска ничего не доказывает.
fn netease_song_artists(song: &serde_json::Value) -> Vec<String> {
    song.get("ar")
        .or_else(|| song.get("artists"))
        .and_then(|value| value.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| text_field(item, "name"))
                .collect()
        })
        .unwrap_or_default()
}

/// Исполнитель трека в ответе Netease: первый из `ar[].name`.
fn netease_song_artist(song: &serde_json::Value) -> Option<String> {
    netease_song_artists(song).into_iter().next()
}

/// Запись Netease: `name`, `ar[].name` и `duration` в миллисекундах.
fn netease_record(song: &serde_json::Value) -> FoundRecord {
    let duration_sec = song
        .get("duration")
        .and_then(|value| value.as_i64())
        .map(|ms| ms / 1000)
        .filter(|sec| *sec > 0)
        .unwrap_or(0);

    FoundRecord {
        title: text_field(song, "name").unwrap_or_default(),
        artists: netease_song_artists(song),
        duration_sec,
    }
}

/// Есть ли в тексте LRC-метка времени вида `[mm:ss` или `[hh:mm:ss`.
fn has_lrc_timestamps(text: &str) -> bool {
    text.match_indices('[')
        .any(|(index, _)| is_lrc_stamp(&text[index + 1..]))
}

/// Начало метки: минуты (1–3 цифры), двоеточие и хотя бы одна цифра секунд.
/// Служебные теги вида `[ar:Кино]` метками не считаются.
fn is_lrc_stamp(value: &str) -> bool {
    let (minutes, rest) = match value.split_once(':') {
        Some(pair) => pair,
        None => return false,
    };
    if minutes.is_empty() || minutes.len() > 3 || !minutes.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    rest.chars()
        .next()
        .map(|ch| ch.is_ascii_digit())
        .unwrap_or(false)
}

/// Ответ `/api/song/lyric`: текст лежит в `lrc.lyric`. Пустой ответ, флаги
/// `nolyric`/`uncollected` и строки-заглушки означают «текста нет».
fn netease_lyrics(body: &serde_json::Value) -> Option<Lyrics> {
    if body.get("nolyric").and_then(|value| value.as_bool()) == Some(true) {
        return None;
    }
    if body.get("uncollected").and_then(|value| value.as_bool()) == Some(true) {
        return None;
    }

    let raw = body
        .get("lrc")
        .and_then(|value| value.get("lyric"))
        .and_then(|value| value.as_str())?
        .trim();

    if raw.is_empty() || NETEASE_STUBS.iter().any(|stub| raw.contains(stub)) {
        return None;
    }

    // Текст с метками времени — синхронный; без них — обычный.
    let (synced, plain) = if has_lrc_timestamps(raw) {
        (Some(raw.to_string()), None)
    } else {
        (None, Some(raw.to_string()))
    };

    Some(Lyrics {
        found: true,
        synced,
        plain,
        source: Some("netease".into()),
        title: None,
        artist: None,
        // Заполняются вызывающим: там известно, какую именно запись поиска
        // мы проверяли и у какой из них взяли текст.
        matched_title: None,
        matched_artist: None,
        // Ставится вызывающим: ослабленный проход помечает текст «от оригинала».
        from_original: false,
        // У Netease тайминг либо настоящий, либо его нет: оценки не подставляем.
        estimated: false,
        attempts: Vec::new(),
    })
}

/// Netease: ищем до первого синхронного текста — он лучше любого обычного.
fn search_netease(search: &mut Search, artist: &str, title: &str, duration_sec: u32) {
    for query in netease_queries(artist, title) {
        if search.should_stop() {
            search.attempts.push(search.stop_reason());
            break;
        }

        let body = match search.json(&netease_search_request(&query)) {
            Ok(body) => body,
            Err(LookupError::Missing) => {
                search
                    .attempts
                    .push(format!("Netease: поиск «{query}» — записи нет"));
                continue;
            }
            Err(LookupError::Failed(error)) => {
                search
                    .attempts
                    .push(format!("Netease: поиск «{query}» — сеть: {error}"));
                continue;
            }
        };

        let (picked, rejected) = pick_netease_song(&body, title, artist, duration_sec);
        let song = match picked {
            Some(song) => song,
            None => {
                search.attempts.push(match rejected {
                    // Причина важна: именно так видно, что запись нашлась, но
                    // оказалась чужой песней — и текст её показывать нельзя.
                    Some(reason) => format!(
                        "Netease: поиск «{query}» — ничего не совпало: {reason}"
                    ),
                    None => format!("Netease: поиск «{query}» — ничего не нашлось"),
                });
                continue;
            }
        };

        // id нужен для запроса текста, остальное — только для подписи ответа
        let id = match song.get("id").and_then(|value| value.as_i64()) {
            Some(id) => id,
            None => continue,
        };
        let record = netease_record(song);
        let song_title = text_field(song, "name");
        let song_artist = netease_song_artist(song);

        if search.should_stop() {
            search.attempts.push(search.stop_reason());
            break;
        }

        match search.json(&netease_lyric_request(id)) {
            Ok(body) => match netease_lyrics(&body) {
                Some(mut lyrics) => {
                    lyrics.title = song_title;
                    lyrics.artist = song_artist;
                    let (matched_title, matched_artist) = matched_labels(&record);
                    lyrics.matched_title = matched_title;
                    lyrics.matched_artist = matched_artist;
                    // Название совпало точно, а исполнитель — нет: текст чужой
                    // версии, об этом честно скажет подпись в панели.
                    lyrics.from_original = title_only_match(&record, title, artist);
                    let synced = lyrics.synced.is_some();
                    search.attempts.push(format!(
                        "Netease: «{query}» — {}",
                        if synced {
                            "синхронный текст"
                        } else {
                            "только обычный текст"
                        }
                    ));
                    search.consider(lyrics);
                    // Синхронный текст Netease лучше любого обычного — искать
                    // дальше по этому источнику незачем.
                    if synced {
                        return;
                    }
                }
                None => search
                    .attempts
                    .push(format!("Netease: «{query}» — текста нет")),
            },
            Err(LookupError::Missing) => {
                search
                    .attempts
                    .push(format!("Netease: текст для «{query}» — записи нет"));
            }
            Err(LookupError::Failed(error)) => {
                search
                    .attempts
                    .push(format!("Netease: текст для «{query}» — сеть: {error}"));
            }
        }
    }
}

/// Ослабленный проход Netease: поиск только по названию (либо «исполнитель
/// название») и сверка только по названию. Синхронный текст важнее обычного,
/// поэтому обход кандидатов продолжается, пока синхронного нет.
fn search_netease_original(search: &mut Search, artist: &str, candidates: &[String]) {
    let artist = normalize_artist(artist);

    for candidate in candidates {
        let mut queries: Vec<String> = Vec::new();
        if !artist.is_empty() {
            queries.push(format!("{artist} {candidate}"));
        }
        queries.push(candidate.clone());

        for query in queries {
            if search.should_stop() {
                search.attempts.push(search.stop_reason());
                return;
            }

            let body = match search.json(&netease_search_request(&query)) {
                Ok(body) => body,
                Err(LookupError::Missing) => {
                    search
                        .attempts
                        .push(format!("Netease по оригиналу: поиск «{query}» — записи нет"));
                    continue;
                }
                Err(LookupError::Failed(error)) => {
                    search
                        .attempts
                        .push(format!("Netease по оригиналу: поиск «{query}» — сеть: {error}"));
                    continue;
                }
            };

            let (picked, rejected) = pick_netease_song_original(&body, candidate);
            let song = match picked {
                Some(song) => song,
                None => {
                    search.attempts.push(match rejected {
                        Some(reason) => format!(
                            "Netease по оригиналу: поиск «{query}» — ничего не совпало: {reason}"
                        ),
                        None => format!(
                            "Netease по оригиналу: поиск «{query}» — ничего не нашлось"
                        ),
                    });
                    continue;
                }
            };

            let id = match song.get("id").and_then(|value| value.as_i64()) {
                Some(id) => id,
                None => continue,
            };
            let record = netease_record(song);
            let song_title = text_field(song, "name");
            let song_artist = netease_song_artist(song);

            if search.should_stop() {
                search.attempts.push(search.stop_reason());
                return;
            }

            match search.json(&netease_lyric_request(id)) {
                Ok(body) => match netease_lyrics(&body) {
                    Some(mut lyrics) => {
                        lyrics.title = song_title;
                        lyrics.artist = song_artist;
                        let (matched_title, matched_artist) = matched_labels(&record);
                        lyrics.matched_title = matched_title;
                        lyrics.matched_artist = matched_artist;
                        lyrics.from_original = true;
                        let synced = lyrics.synced.is_some();
                        search.attempts.push(format!(
                            "Netease по оригиналу: «{query}» — {}",
                            if synced {
                                "синхронный текст"
                            } else {
                                "только обычный текст"
                            }
                        ));
                        search.consider(lyrics);
                        if synced {
                            return;
                        }
                    }
                    None => search
                        .attempts
                        .push(format!("Netease по оригиналу: «{query}» — текста нет")),
                },
                Err(LookupError::Missing) => search
                    .attempts
                    .push(format!("Netease по оригиналу: текст для «{query}» — записи нет")),
                Err(LookupError::Failed(error)) => search
                    .attempts
                    .push(format!("Netease по оригиналу: текст для «{query}» — сеть: {error}")),
            }
        }
    }
}

/// api.lyrics.ovh: бесплатный источник обычного текста без синхронизации.
/// Идёт последним: синхронный текст и LRCLIB, и Netease важнее.
const LYRICS_OVH_BASE: &str = "https://api.lyrics.ovh/v1";

/// Адрес: исполнитель и название — сегменты пути, поэтому пробел кодируется
/// как `%20`, а не как `+`.
fn lyrics_ovh_url(artist: &str, title: &str) -> String {
    format!(
        "{LYRICS_OVH_BASE}/{}/{}",
        urlencode_path(artist),
        urlencode_path(title)
    )
}

/// Ответ lyrics.ovh: `{"lyrics": "…"}` или `{"error": "No lyrics found"}`.
fn lyrics_ovh_lyrics(body: &serde_json::Value) -> Option<Lyrics> {
    if body.get("error").is_some() {
        return None;
    }

    let plain = clean_ovh_lyrics(body.get("lyrics")?.as_str()?);
    if plain.is_empty() {
        return None;
    }

    Some(Lyrics {
        found: true,
        synced: None,
        plain: Some(plain),
        source: Some("lyrics.ovh".into()),
        title: None,
        artist: None,
        // У lyrics.ovh в ответе нет ни названия, ни исполнителя: сверить
        // нечего, поэтому запись считается совпавшей по самому запросу.
        matched_title: None,
        matched_artist: None,
        from_original: false,
        estimated: false,
        attempts: Vec::new(),
    })
}

/// lyrics.ovh добавляет к тексту служебные строки («Paroles de la chanson …
/// par …», «Letra de la canción …») и линейки звёздочек — их убираем.
fn clean_ovh_lyrics(raw: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();

    for line in raw.split('\n') {
        let value = line.trim();
        if value.is_empty() {
            continue;
        }

        let lower = value.to_lowercase();
        let service = lower.starts_with("paroles de la chanson")
            || lower.starts_with("letra de la canción")
            || lower.starts_with("letra de la cancion")
            || lower.starts_with("lyrics of the song")
            || value.starts_with("***");
        if service {
            continue;
        }

        kept.push(value);
    }

    kept.join("\n")
}

/// lyrics.ovh: последний шанс — обычный текст без синхронизации.
fn search_lyrics_ovh(search: &mut Search, artist: &str, title: &str) {
    let artist = normalize_artist(artist);
    let title = normalize_title(title);
    if artist.is_empty() || title.is_empty() {
        search
            .attempts
            .push("lyrics.ovh: нет исполнителя или названия".into());
        return;
    }
    if search.should_stop() {
        search.attempts.push("время на поиск текста вышло".into());
        return;
    }

    match search.json(&Request::get(
        "lyrics.ovh",
        lyrics_ovh_url(&artist, &title),
    )) {
        Ok(body) => match lyrics_ovh_lyrics(&body) {
            Some(mut lyrics) => {
                // Источник отвечает по паре «исполнитель/название» из адреса и
                // никаких метаданных не возвращает: подтвердить совпадение
                // нечем, поэтому в matched* попадает сам запрос.
                lyrics.matched_title = Some(title.clone());
                lyrics.matched_artist = Some(artist.clone());
                search.attempts.push(format!(
                    "lyrics.ovh: «{artist} — {title}» — обычный текст \
                     (метаданных нет, совпадение по запросу)"
                ));
                search.consider(lyrics);
            }
            None => search
                .attempts
                .push(format!("lyrics.ovh: «{artist} — {title}» — текста нет")),
        },
        Err(LookupError::Missing) => search
            .attempts
            .push(format!("lyrics.ovh: «{artist} — {title}» — записи нет")),
        Err(LookupError::Failed(error)) => search
            .attempts
            .push(format!("lyrics.ovh: «{artist} — {title}» — сеть: {error}")),
    }
}

// ---------- Genius ----------

/// Поиск сайта Genius: эндпоинт его же веб-клиента, ключей не требует.
const GENIUS_SEARCH_URL: &str = "https://genius.com/api/search/multi";
/// Официальный API Genius тексты не отдаёт (только метаданные), поэтому текст
/// берётся со страницы песни. Браузерный агент: серверному клиенту страница
/// может не достаться.
const GENIUS_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/// Сколько песен из поиска проверяем: подходящая почти всегда в начале.
const GENIUS_MAX_CANDIDATES: usize = 5;
/// Короче такого текста в контейнере быть не должно — это шапка или мусор.
const GENIUS_MIN_TEXT_CHARS: usize = 40;

/// Запрос поиска Genius.
fn genius_search_request(query: &str) -> Request {
    Request::get(
        "Genius",
        format!("{GENIUS_SEARCH_URL}?q={}", urlencode(query)),
    )
    .header("User-Agent", GENIUS_AGENT)
}

/// Запрос страницы песни: путь приходит из ответа поиска и начинается с «/».
fn genius_page_request(path: &str) -> Request {
    Request::get("Genius", format!("https://genius.com{path}")).header("User-Agent", GENIUS_AGENT)
}

/// Песни из ответа поиска: `response.sections[].hits[]` с `type == "song"`.
/// Длительности в ответе нет — сверка идёт по названию и исполнителю.
fn genius_records(body: &serde_json::Value) -> Vec<(FoundRecord, String)> {
    let mut records = Vec::new();
    let sections = match body.pointer("/response/sections").and_then(|value| value.as_array()) {
        Some(sections) => sections,
        None => return records,
    };

    for section in sections {
        let hits = match section.get("hits").and_then(|value| value.as_array()) {
            Some(hits) => hits,
            None => continue,
        };
        for hit in hits {
            if hit.get("type").and_then(|value| value.as_str()) != Some("song") {
                continue;
            }
            let result = match hit.get("result") {
                Some(result) => result,
                None => continue,
            };
            let title = result.get("title").and_then(|value| value.as_str()).unwrap_or("");
            let path = result.get("path").and_then(|value| value.as_str()).unwrap_or("");
            let artists = result
                .get("artist_names")
                .and_then(|value| value.as_str())
                .map(split_artists)
                .unwrap_or_default();
            if title.is_empty() || path.is_empty() {
                continue;
            }
            records.push((
                FoundRecord {
                    title: title.to_string(),
                    artists,
                    duration_sec: 0,
                },
                path.to_string(),
            ));
        }
    }

    records
}

/// Содержимое блоков `data-lyrics-container="true"`: внутри одного блока могут
/// быть вложенные `<div>` (шапка с участниками), поэтому конец ищется учётом
/// глубины, а не первым попавшимся `</div>`.
fn genius_containers(html: &str) -> Vec<String> {
    const NEEDLE: &str = "data-lyrics-container=\"true\"";

    let mut blocks = Vec::new();
    let mut from = 0;
    while let Some(at) = html[from..].find(NEEDLE) {
        let found = from + at;
        from = found + NEEDLE.len();

        // Игла — внутри открывающего тега: содержимое начинается после его «>»
        let start = match html[from..].find('>') {
            Some(end) => from + end + 1,
            None => continue,
        };

        let mut depth: i32 = 1;
        let mut pos = start;
        let mut end = None;
        loop {
            let open = html[pos..].find("<div").map(|at| pos + at);
            let close = html[pos..].find("</div>").map(|at| pos + at);
            match (open, close) {
                (Some(o), Some(c)) if o < c => {
                    depth += 1;
                    pos = o + 4;
                }
                (_, Some(c)) => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(c);
                        break;
                    }
                    pos = c + 6;
                }
                // Закрывающего тега дальше нет — блок битый, пропускаем
                (_, None) => break,
            }
        }

        if let Some(end) = end {
            if end > start {
                blocks.push(html[start..end].to_string());
            }
        }
    }

    blocks
}

/// Именованные и числововые HTML-сущности, которые встречаются в текстах.
fn genius_entity(value: &str) -> String {
    match value {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" | "rsquo" | "lsquo" => "'".into(),
        "rdquo" | "ldquo" => "\"".into(),
        "nbsp" => "\u{a0}".into(),
        "hellip" => "…".into(),
        "mdash" => "—".into(),
        "ndash" => "–".into(),
        other => {
            let code = other
                .strip_prefix("#x")
                .map(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| other.strip_prefix('#').map(|dec| dec.parse::<u32>().ok()))
                .flatten();
            match code.and_then(char::from_u32) {
                Some(ch) => ch.to_string(),
                // Незнакомая сущность — оставляем как есть, лучше странная
                // запись, чем пропавший из текста знак
                None => format!("&{value};"),
            }
        }
    }
}

fn genius_decode_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }

    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        // Сущность короткая и заканчивается «;»: `&#x27;`, `&amp;`. Всё
        // длиннее десяти символов — просто текст с амперсандом.
        match rest[at..].find(';') {
            Some(end) if end <= 10 => {
                out.push_str(&genius_entity(&rest[at + 1..at + end]));
                rest = &rest[at + end + 1..];
            }
            _ => {
                out.push('&');
                rest = &rest[at + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// HTML-блок текста песни → строки: `<br>` (и закрывающие блочные теги) дают
/// перенос строки, остальная разметка убирается, сущности раскрываются.
fn genius_html_to_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find('<') {
        text.push_str(&genius_decode_entities(&rest[..at]));
        let tag_end = match rest[at..].find('>') {
            Some(end) => at + end,
            None => break,
        };
        let name: String = rest[at + 1..tag_end]
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if name == "br" || name == "div" || name == "p" {
            text.push('\n');
        }
        rest = &rest[tag_end + 1..];
    }
    text.push_str(&genius_decode_entities(rest));
    text
}

/// Текст из страницы: берём самый длинный блок-контейнер — шапка с участниками
/// и пустые блоки короче, а перевод почти всегда короче оригинала.
fn genius_plain_of(html: &str) -> String {
    let mut best = String::new();
    for block in genius_containers(html) {
        // В блоке текста Genius держит служебные вставки: шапку «167 Contributors»,
        // переводы, рекламу. Они помечены `data-exclude-from-selection` — без
        // этой чистки они попадали в текст первыми строками.
        let cleaned = genius_strip_service_blocks(&block);
        let text = genius_html_to_text(&cleaned);
        let lines: Vec<&str> = text.split('\n').map(str::trim).filter(|line| !line.is_empty()).collect();
        let joined = lines.join("\n");
        if joined.chars().count() > best.chars().count() {
            best = joined;
        }
    }

    if best.chars().count() < GENIUS_MIN_TEXT_CHARS {
        return String::new();
    }
    best
}

/// Убрать из блока контейнера всё, что помечено как «не текст песни».
///
/// Genius отмечает шапку и переводы атрибутом `data-exclude-from-selection`,
/// а кнопки и иконки — обычной разметкой. Удаляем элемент целиком, с учётом
/// вложенности: у шапки внутри свои `<div>`, и первый `</div>` — не её конец.
fn genius_strip_service_blocks(block: &str) -> String {
    let mut value = block.to_string();

    while let Some(at) = value.find("data-exclude-from-selection=\"true\"") {
        let tag_start = match value[..at].rfind('<') {
            Some(start) => start,
            None => break,
        };
        let tag = value[tag_start + 1..]
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if tag.is_empty() {
            break;
        }
        let end = genius_element_end(&value, tag_start, &tag).unwrap_or(value.len());
        value.replace_range(tag_start..end, "");
    }

    // Кнопки и иконки внутри текста не несут текста песни.
    for tag in ["button", "svg", "script", "style"] {
        loop {
            let Some(open) = value.find(&format!("<{tag}")) else {
                break;
            };
            let Some(end) = genius_element_end(&value, open, tag) else {
                break;
            };
            value.replace_range(open..end, "");
        }
    }

    value
}

/// Конец элемента `tag`, открытого в позиции `start` (включая закрывающий тег).
fn genius_element_end(html: &str, start: usize, tag: &str) -> Option<usize> {
    let open_needle = format!("<{tag}");
    let close_needle = format!("</{tag}>");
    let mut depth: i32 = 1;
    let mut pos = start + open_needle.len();

    loop {
        let open = html[pos..].find(&open_needle).map(|at| pos + at);
        let close = html[pos..].find(&close_needle).map(|at| pos + at);
        match (open, close) {
            (Some(o), Some(c)) if o < c => {
                depth += 1;
                pos = o + open_needle.len();
            }
            (_, Some(c)) => {
                depth -= 1;
                if depth == 0 {
                    return Some(c + close_needle.len());
                }
                pos = c + close_needle.len();
            }
            (_, None) => return None,
        }
    }
}

/// Страница песни Genius → обычный текст без синхронизации.
fn genius_page_lyrics(search: &mut Search, path: &str) -> Option<Lyrics> {
    // Путь приходит из ответа поиска, но проверяем его форму: в запрос он
    // попадает как есть.
    if !path.starts_with('/') || path.contains("..") || path.contains(' ') {
        return None;
    }
    if search.should_stop() {
        search.attempts.push(search.stop_reason());
        return None;
    }

    let html = match search.text(&genius_page_request(path)) {
        Ok(html) => html,
        Err(LookupError::Missing) => {
            search.attempts.push(format!("Genius: {path} — страницы нет"));
            return None;
        }
        Err(LookupError::Failed(error)) => {
            search
                .attempts
                .push(format!("Genius: {path} — сеть: {error}"));
            return None;
        }
    };

    let plain = genius_plain_of(&html);
    if plain.is_empty() {
        search
            .attempts
            .push(format!("Genius: {path} — текст в разметке не найден"));
        return None;
    }

    Some(Lyrics {
        found: true,
        synced: None,
        plain: Some(plain),
        source: Some("genius".into()),
        title: None,
        artist: None,
        matched_title: None,
        matched_artist: None,
        from_original: false,
        estimated: false,
        attempts: Vec::new(),
    })
}

/// Примерный тайминг по обычному тексту: Genius отдаёт строки без времени, и
/// раньше подсветка в плеере для них не работала вовсе.
///
/// Раскладываем строки по длительности трека пропорционально их длине: вступление
/// и концовка получают свои проценты, каждая строка — вес по числу символов плюс
/// пауза «на вдох». Точность здесь не нужна — это ориентир, и интерфейс честно
/// подписывает такой текст «тайминг примерный». Кнопки ± в панели текста
/// сдвигают сетку, если трек начинается не с первого такта.
fn estimate_lrc(plain: &str, duration_sec: u32) -> Option<String> {
    // Короткие треки и обрывки текста не стоит растягивать: ошибка будет видна.
    if duration_sec < 30 {
        return None;
    }
    let lines: Vec<&str> = plain
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() < 4 {
        return None;
    }

    let weight_of = |line: &str| -> f64 {
        // «[Припев]» почти не поют — вес минимальный.
        if line.starts_with('[') && line.ends_with(']') {
            return 2.0;
        }
        let chars = line.chars().count() as f64;
        chars.clamp(6.0, 90.0) + 8.0
    };

    let total: f64 = lines.iter().map(|line| weight_of(line)).sum();
    if total <= 0.0 {
        return None;
    }

    // 6% на вступление, 8% на концовку — там обычно интро и затухание.
    let start = duration_sec as f64 * 0.06;
    let span = duration_sec as f64 * 0.86;

    let mut out = String::with_capacity(plain.len() + lines.len() * 12);
    let mut elapsed = 0.0f64;
    let mut previous = -1.0f64;
    for line in &lines {
        let mut at = start + span * (elapsed / total);
        if at <= previous {
            at = previous + 0.8;
        }
        previous = at;
        let minutes = (at / 60.0).floor() as u32;
        let seconds = at - minutes as f64 * 60.0;
        out.push_str(&format!("[{minutes:02}:{seconds:05.2}]\n"));
        out.push_str(line);
        out.push('\n');
        elapsed += weight_of(line);
    }
    Some(out)
}

/// Добавить примерный тайминг к тексту, у которого времени нет.
fn with_estimated_timing(mut lyrics: Lyrics, duration_sec: u32) -> Lyrics {
    if lyrics.synced.is_some() {
        return lyrics;
    }
    let Some(plain) = lyrics.plain.clone() else {
        return lyrics;
    };
    if let Some(lrc) = estimate_lrc(&plain, duration_sec) {
        lyrics.synced = Some(lrc);
        lyrics.estimated = true;
    }
    lyrics
    }
/// Схлопнуть повторы символов: «ррррррасссттаа» и «Ррррррассстаа» — одно
/// название, а поиск Genius на таких стилизациях легко промахивается.
fn collapse_runs(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last: Option<char> = None;
    for ch in value.chars() {
        if Some(ch) == last {
            continue;
        }
        out.push(ch);
        last = Some(ch);
    }
    out
}

/// Принять найденную запись: страница → текст → примерный тайминг.
/// `relaxed` — совпало только название, исполнитель в теге другой; в панели
/// это станет подписью «Текст от оригинала: <кто> — <название>».
fn genius_accept(
    search: &mut Search,
    record: &FoundRecord,
    path: &str,
    query: &str,
    duration_sec: u32,
    relaxed: bool,
) -> bool {
    let Some(mut lyrics) = genius_page_lyrics(search, path) else {
        return false;
    };
    lyrics.title = Some(record.title.clone());
    lyrics.artist = Some(record_artists(record).join(", "));
    let (matched_title, matched_artist) = matched_labels(record);
    lyrics.matched_title = matched_title;
    lyrics.matched_artist = matched_artist;
    if relaxed {
        lyrics.from_original = true;
    }
    // Genius времени не отдаёт: раскладываем строки сами, чтобы подсветка и
    // автоскролл работали и текст не лежал «мёртвым».
    lyrics = with_estimated_timing(lyrics, duration_sec);

    let note = if lyrics.estimated {
        "обычный текст, тайминг примерный"
    } else {
        "обычный текст"
    };
    search
        .attempts
        .push(format!("Genius: «{query}» — «{}»: {note}", record.title));
    search.consider(lyrics);
    true
}

/// Один запрос к Genius: строгая сверка, затем (если `relaxed`) совпадение по
/// названию без учёта исполнителя.
fn genius_try(
    search: &mut Search,
    query: &str,
    title: &str,
    artist: &str,
    duration_sec: u32,
    relaxed: bool,
) -> bool {
    let body = match search.json(&genius_search_request(query)) {
        Ok(body) => body,
        Err(LookupError::Missing) => {
            search
                .attempts
                .push(format!("Genius: поиск «{query}» — записи нет"));
            return false;
        }
        Err(LookupError::Failed(error)) => {
            search
                .attempts
                .push(format!("Genius: поиск «{query}» — сеть: {error}"));
            return false;
        }
    };

    let records = genius_records(&body);
    if records.is_empty() {
        search
            .attempts
            .push(format!("Genius: поиск «{query}» — ничего не нашлось"));
        return false;
    }

    let mut rejected: Option<String> = None;
    for (record, path) in records.iter().take(GENIUS_MAX_CANDIDATES) {
        if search.should_stop() {
            search.attempts.push(search.stop_reason());
            return false;
        }
        if let Some(reason) = mismatch_reason(record, title, artist, duration_sec) {
            rejected = Some(reason);
            continue;
        }
        if genius_accept(search, record, path, query, duration_sec, false) {
            return true;
        }
    }

    if relaxed {
        // Название совпало, а исполнитель в теге другой: у стилизаций,
        // «speed up»-каналов и треков вроде «автостопом 3» это обычная история.
        // Скобки в названии почти всегда про исполнителя или перевод:
        // «Ррррррассстаа (Rrrrrrastaman)» и «ррррррасссттаа» — одна песня.
        let title_key = |value: &str| collapse_runs(&match_key(&drop_bracket_groups(value)));
        let wanted = title_key(title);
        if wanted.chars().count() >= 4 {
            for (record, path) in records.iter().take(GENIUS_MAX_CANDIDATES) {
                if search.should_stop() {
                    search.attempts.push(search.stop_reason());
                    return false;
                }
                if title_key(&record.title) != wanted {
                    continue;
                }
                if genius_accept(search, record, path, query, duration_sec, true) {
                    return true;
                }
            }
        }
    }

    search.attempts.push(match rejected {
        Some(reason) => format!("Genius: поиск «{query}» — ничего не совпало: {reason}"),
        None => format!("Genius: поиск «{query}» — текст взять не удалось"),
    });
    false
}

/// Genius: последний рубеж для обычного текста — после LRCLIB, Netease и
/// lyrics.ovh.
///
/// Запросов несколько: сначала с исполнителем, потом только название, потом
/// название со схлопнутыми повторами букв. Genius плохо переносит лишнее слово
/// в запросе — «автостопом 3 ррррррасссттаа» не находит ничего, а
/// «ррррррасссттаа» находит нужную страницу.
fn search_genius(search: &mut Search, artist: &str, title: &str, duration_sec: u32) {
    let artist = normalize_artist(artist);
    let title = normalize_title(title);
    if title.is_empty() {
        search.attempts.push("Genius: нет названия".into());
        return;
    }

    let mut queries: Vec<String> = Vec::new();
    if !artist.is_empty() {
        queries.push(format!("{artist} {title}"));
    }
    queries.push(title.clone());
    let collapsed = collapse_runs(&match_key(&drop_bracket_groups(&title)));
    if collapsed.chars().count() >= 3 && collapsed != match_key(&title) {
        queries.push(collapsed);
    }

    for query in queries {
        if search.should_stop() {
            search.attempts.push(search.stop_reason());
            return;
        }
        if genius_try(search, &query, &title, &artist, duration_sec, true) {
            return;
        }
    }
}
/// Проход по оригиналу: та же схема, но сверка только по названию —
/// длительность производной версии не оригинальная, а исполнитель в теге
/// часто посторонний.
fn search_genius_original(search: &mut Search, artist: &str, candidates: &[String]) {
    let artist = normalize_artist(artist);

    for candidate in candidates {
        if search.should_stop() {
            search.attempts.push(search.stop_reason());
            return;
        }

        let query = if artist.is_empty() {
            candidate.clone()
        } else {
            format!("{artist} {candidate}")
        };

        let body = match search.json(&genius_search_request(&query)) {
            Ok(body) => body,
            Err(_) => {
                // Сеть уже описана обычным проходом; здесь достаточно краткой
                // строки, чтобы журнал не разбухал
                search
                    .attempts
                    .push(format!("Genius по оригиналу: поиск «{query}» — не ответил"));
                continue;
            }
        };

        let records = genius_records(&body);
        let mut rejected: Option<String> = None;
        for (record, path) in records.iter().take(GENIUS_MAX_CANDIDATES) {
            if search.should_stop() {
                search.attempts.push(search.stop_reason());
                return;
            }
            if let Some(reason) = original_mismatch_reason(record, candidate) {
                rejected = Some(reason);
                continue;
            }

            if let Some(mut lyrics) = genius_page_lyrics(search, path) {
                lyrics.title = Some(record.title.clone());
                lyrics.artist = Some(record_artists(record).join(", "));
                let (matched_title, matched_artist) = matched_labels(record);
                lyrics.matched_title = matched_title;
                lyrics.matched_artist = matched_artist;
                lyrics.from_original = true;
                search.attempts.push(format!(
                    "Genius по оригиналу: «{query}» — «{}»: обычный текст",
                    record.title
                ));
                search.consider(lyrics);
                return;
            }
        }

        if records.is_empty() {
            search
                .attempts
                .push(format!("Genius по оригиналу: поиск «{query}» — ничего не нашлось"));
        } else {
            search.attempts.push(match rejected {
                Some(reason) => {
                    format!("Genius по оригиналу: поиск «{query}» — ничего не совпало: {reason}")
                }
                None => format!("Genius по оригиналу: поиск «{query}» — текст взять не удалось"),
            });
        }
    }
}

// ---------- Адреса и разбор ответа ----------

/// Адрес точного запроса: исполнитель, название и длительность. Длительность
/// не даёт спутать студийную версию с ремиксом или концертной записью.
fn exact_url(artist: &str, title: &str, album: Option<&str>, duration_sec: u32) -> String {
    let mut url = format!(
        "https://lrclib.net/api/get?artist_name={}&track_name={}",
        urlencode(artist),
        urlencode(title)
    );
    if let Some(album) = album.map(str::trim).filter(|value| !value.is_empty()) {
        url.push_str(&format!("&album_name={}", urlencode(album)));
    }
    if duration_sec > 0 {
        url.push_str(&format!("&duration={duration_sec}"));
    }
    url
}

/// Адрес поиска: свободная строка «исполнитель название».
fn search_url(query: &str) -> String {
    format!("https://lrclib.net/api/search?q={}", urlencode(query))
}

/// Строковое поле ответа: пустое значение и null одинаково означают «нет».
fn text_field(body: &serde_json::Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Длительность записи в секундах. LRCLIB отдаёт целое, но на всякий случай
/// принимаем и дробное: иначе длительность молча стала бы нулевой и проверка
/// соответствия осталась бы без своего главного аргумента.
fn duration_of(body: &serde_json::Value) -> i64 {
    let raw = match body.get("duration") {
        Some(value) => value,
        None => return 0,
    };
    if let Some(value) = raw.as_i64() {
        return value;
    }
    if let Some(value) = raw.as_f64() {
        return value.round() as i64;
    }
    0
}

/// Разбирает один объект LRCLIB в наш ответ. Синхронный текст важнее обычного:
/// по нему работает подсветка строк. `matchedTitle`/`matchedArtist` — то, что
/// реально вернул источник: по ним видно, совпало ли найденное с запросом.
fn lyrics_from(body: &serde_json::Value) -> Lyrics {
    let synced = text_field(body, "syncedLyrics");
    let plain = text_field(body, "plainLyrics");
    let (matched_title, matched_artist) = matched_labels(&lrclib_record(body));
    Lyrics {
        found: synced.is_some() || plain.is_some(),
        synced,
        plain,
        source: Some("lrclib".into()),
        title: text_field(body, "trackName"),
        artist: text_field(body, "artistName"),
        matched_title,
        matched_artist,
        from_original: false,
        estimated: false,
        attempts: Vec::new(),
    }
}

/// Тот же разбор ответа, но с честной пометкой «текст от оригинала»: запись
/// нашлась в ослабленном проходе, значит играет не она, а её производная версия.
fn original_lyrics_from(body: &serde_json::Value) -> Lyrics {
    let mut lyrics = lyrics_from(body);
    lyrics.from_original = true;
    lyrics
}

/// Оценка кандидата из поиска: чем больше, тем лучше подходит.
/// Сначала совпадение по длительности (±5 секунд), затем синхронный текст.
fn score(body: &serde_json::Value, duration_sec: u32) -> i32 {
    let mut total = 0;
    if duration_sec > 0 && duration_of(body) > 0 {
        let delta = (duration_of(body) - duration_sec as i64).abs();
        if delta <= DURATION_TOLERANCE_SEC {
            // Чем ближе длительность, тем лучше: при точном названии записей
            // может быть несколько, и выбирать надо самую близкую версию
            total += 100 + (DURATION_TOLERANCE_SEC - delta) as i32;
        } else if delta <= 10 {
            total += 20;
        } else {
            total -= 10;
        }
    }
    if text_field(body, "syncedLyrics").is_some() {
        total += 30;
    }
    if text_field(body, "plainLyrics").is_some() {
        total += 5;
    }
    total
}

/// Из ответа поиска берём запись с текстом, которая прошла строгую проверку
/// соответствия, и с самой подходящей длительностью. Совсем без текста кандидат
/// не нужен: пустой результат честнее пустых строк. При равном счёте выигрывает
/// та запись, что встретилась раньше. Второе значение — причина, по которой
/// первый кандидат не подошёл: она объясняет промах в журнале.
fn pick_from_search<'a>(
    body: &'a serde_json::Value,
    title: &str,
    artist: &str,
    duration_sec: u32,
) -> (Option<&'a serde_json::Value>, Option<String>) {
    let items = match body.as_array() {
        Some(items) => items,
        None => return (None, None),
    };
    let mut best: Option<(&serde_json::Value, i32)> = None;
    let mut rejected: Option<String> = None;

    for item in items {
        if text_field(item, "syncedLyrics").is_none() && text_field(item, "plainLyrics").is_none() {
            continue;
        }

        if let Some(reason) = mismatch_reason(&lrclib_record(item), title, artist, duration_sec) {
            if rejected.is_none() {
                rejected = Some(reason);
            }
            continue;
        }

        let value = score(item, duration_sec)
            + if artist_matches(&lrclib_record(item), artist) {
                ARTIST_BONUS
            } else {
                0
            };
        match best {
            Some((_, current)) if current >= value => {}
            _ => best = Some((item, value)),
        }
    }

    (best.map(|(item, _)| item), rejected)
}

/// То же, что `pick_from_search`, но для ослабленного прохода: запись обязана
/// совпасть только по названию, исполнитель и длительность не участвуют.
/// Счёт по длительности не считаем — она у производной версии заведомо другая,
/// а синхронный текст остаётся важнее обычного.
fn pick_from_search_original<'a>(
    body: &'a serde_json::Value,
    clean_title: &str,
) -> (Option<&'a serde_json::Value>, Option<String>) {
    let items = match body.as_array() {
        Some(items) => items,
        None => return (None, None),
    };
    let mut best: Option<(&serde_json::Value, i32)> = None;
    let mut rejected: Option<String> = None;

    for item in items {
        if text_field(item, "syncedLyrics").is_none() && text_field(item, "plainLyrics").is_none() {
            continue;
        }

        if let Some(reason) = original_mismatch_reason(&lrclib_record(item), clean_title) {
            if rejected.is_none() {
                rejected = Some(reason);
            }
            continue;
        }

        let value = score(item, 0);
        match best {
            Some((_, current)) if current >= value => {}
            _ => best = Some((item, value)),
        }
    }

    (best.map(|(item, _)| item), rejected)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Lrclib,
    Netease,
    LyricsOvh,
    Genius,
}

/// Как источник ищет текст. Обычный проход строгий; ослабленный идёт только
/// после его полного провала и только для производных версий и коллажей.
#[derive(Debug, Clone, PartialEq)]
enum Pass {
    /// Теги как есть: название, исполнитель и длительность сверяются строго.
    Strict,
    /// Поиск «по оригиналу»: очищенное название производной версии или части
    /// коллажа. Исполнитель в запросе помогает источнику ранжировать записи, но
    /// сверка идёт только по названию — длительность и исполнитель не годятся.
    Original(Vec<String>),
}

/// Итог одного прохода: лучший ответ, ответил ли кто-нибудь вообще, последняя
/// сетевая ошибка и журнал попыток.
#[derive(Debug, Default)]
struct PassOutcome {
    best: Option<Candidate>,
    /// Лучший ответ каждого источника: из них собираются варианты текста.
    variants: Vec<Candidate>,
    answered: bool,
    network_error: Option<String>,
    attempts: Vec<String>,
}

/// Тело потока одного источника: свой `Search`, своя отмена, общий дедлайн.
fn run_source(
    source: Source,
    pass: &Pass,
    artist: String,
    title: String,
    duration_sec: u32,
    cancel: Cancel,
    deadline: Instant,
) -> SourceOutcome {
    let mut search = Search::with_cancel(cancel, deadline);
    match pass {
        Pass::Strict => match source {
            Source::Lrclib => search_lrclib(&mut search, &artist, &title, duration_sec),
            Source::Netease => search_netease(&mut search, &artist, &title, duration_sec),
            Source::LyricsOvh => search_lyrics_ovh(&mut search, &artist, &title),
            Source::Genius => search_genius(&mut search, &artist, &title, duration_sec),
        },
        Pass::Original(candidates) => match source {
            Source::Lrclib => search_lrclib_original(&mut search, &artist, candidates),
            Source::Netease => search_netease_original(&mut search, &artist, candidates),
            // lyrics.ovh отвечает по паре «исполнитель/название» из адреса, а
            // исполнитель в теге производной версии — загрузивший: искать там
            // нечего, и лишний запрос только съел бы бюджет.
            Source::LyricsOvh => search.attempts.push(
                "lyrics.ovh: проход по оригиналу не используется (нет исполнителя-автора)"
                    .to_string(),
            ),
            Source::Genius => search_genius_original(&mut search, &artist, candidates),
        },
    }
    search.into_outcome()
}

/// Один проход по всем источникам: четыре потока, общая отмена и общий дедлайн.
/// Возвращает лучший ответ, сведения о сети и полный журнал попыток.
fn run_pass(
    pass: Pass,
    artist: &str,
    title: &str,
    duration_sec: u32,
    deadline: Instant,
) -> PassOutcome {
    let cancel = Cancel::new();
    let (sender, receiver) = std::sync::mpsc::channel::<(Source, SourceOutcome)>();

    let mut handles = Vec::with_capacity(4);
    for source in [Source::Lrclib, Source::Netease, Source::LyricsOvh, Source::Genius] {
        let sender = sender.clone();
        let cancel = cancel.clone();
        let pass = pass.clone();
        let artist = artist.to_string();
        let title = title.to_string();
        handles.push(std::thread::spawn(move || {
            let outcome = run_source(source, &pass, artist, title, duration_sec, cancel, deadline);
            // Приёмник может быть уже закрыт: это нормальный ранний выход
            let _ = sender.send((source, outcome));
        }));
    }
    // Свой клон отправителя не нужен: иначе канал никогда не закроется
    drop(sender);

    let mut lrclib: Option<SourceOutcome> = None;
    let mut netease: Option<SourceOutcome> = None;
    let mut ovh: Option<SourceOutcome> = None;
    let mut genius: Option<SourceOutcome> = None;
    let mut received = 0;

    while received < 4 {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }

        match receiver.recv_timeout(left) {
            Ok((source, outcome)) => {
                received += 1;
                let rank = best_rank_of(&outcome);
                match source {
                    Source::Lrclib => lrclib = Some(outcome),
                    Source::Netease => netease = Some(outcome),
                    Source::LyricsOvh => ovh = Some(outcome),
                    Source::Genius => genius = Some(outcome),
                }

                // Лучший возможный ответ уже есть — остальных не ждём
                if rank >= BEST_RANK {
                    break;
                }

                if pass == Pass::Strict {
                    // Оба главных источника ответили, и хотя бы один нашёл текст:
                    // результат lyrics.ovh всё равно хуже, ждать его незачем
                    if lrclib.is_some()
                        && netease.is_some()
                        && (has_result(lrclib.as_ref()) || has_result(netease.as_ref()))
                    {
                        break;
                    }
                } else if lrclib.is_some()
                    && netease.is_some()
                    && (synced_result(lrclib.as_ref()) || synced_result(netease.as_ref()))
                {
                    // Ослабленный проход: обычный текст — ещё не повод бросать
                    // поиск, синхронный важнее. Ждём, пока оба главных
                    // источника ответят или выйдет время.
                    break;
                }
            }
            Err(_) => break,
        }
    }

    // Всё, что уже найдено, дальше не нужно — потоки остановятся сами
    cancel.cancel();

    let attempts = collect_attempts(&[&lrclib, &netease, &ovh, &genius]);
    // Все ответы источников сохраняем: интерфейс даст переключиться на другой
    // вариант, если выбранный текст не тот.
    let variants: Vec<Candidate> = [lrclib.as_ref(), netease.as_ref(), ovh.as_ref(), genius.as_ref()]
        .into_iter()
        .filter_map(|outcome| outcome.and_then(|item| item.best.clone()))
        .collect();
    let (best, answered, network_error) = merge_sources(lrclib, netease, ovh, genius);
    finish_threads(handles);

    PassOutcome {
        variants,
        best,
        answered,
        network_error,
        attempts,
    }
}

/// Найти текст песни. Возвращает сам текст и остальные варианты (если
/// источники предложили разные версии) — интерфейс даёт переключиться.
pub fn fetch(artist: &str, title: &str, duration_sec: u32) -> Result<LyricsAnswer, String> {
    let artist = artist.trim();
    let title = title.trim();
    if title.is_empty() && artist.is_empty() {
        return Err("Не указаны исполнитель и название — искать нечего".into());
    }

    let deadline = Fetcher::deadline();
    let candidates = original_candidates(title);
    // Производному треку часть бюджета придерживаем: обычный перебор вариантов
    // иначе занял бы все 8 секунд, и до оригинала дело бы не дошло.
    let strict_deadline = reserved_deadline(deadline, !candidates.is_empty());

    let strict = run_pass(Pass::Strict, artist, title, duration_sec, strict_deadline);
    let mut attempts = strict.attempts;
    let mut answered = strict.answered;
    let mut network_error = strict.network_error;
    let mut variants = strict.variants;

    if let Some(candidate) = strict.best {
        return Ok(candidate.lyrics.answer_with(variants, attempts));
    }

    // Строгий проход ничего не дал. Если трек производный или коллажный,
    // пробуем найти текст оригинала — и только тогда.
    if should_try_original(false, &candidates) {
        if Instant::now() >= deadline {
            attempts.push("по оригиналу: время на поиск текста вышло".into());
        } else {
            let original = run_pass(
                Pass::Original(candidates),
                artist,
                title,
                duration_sec,
                deadline,
            );
            attempts.extend(original.attempts);
            answered |= original.answered;
            if network_error.is_none() {
                network_error = original.network_error;
            }
            variants.extend(original.variants);
            if let Some(candidate) = original.best {
                return Ok(candidate.lyrics.answer_with(variants, attempts));
            }
        }
    }

    if !answered {
        return Err(network_error.unwrap_or_else(|| "ни один источник текста не ответил".into()));
    }
    Ok(Lyrics::not_found(Vec::new()).answer_with(Vec::new(), attempts))
}

/// Источник что-то нашёл (неважно, синхронный текст или обычный).
fn has_result(outcome: Option<&SourceOutcome>) -> bool {
    outcome.map(|item| item.best.is_some()).unwrap_or(false)
}

/// Источник нашёл именно синхронный текст — он лучше любого обычного.
fn synced_result(outcome: Option<&SourceOutcome>) -> bool {
    outcome
        .and_then(|item| item.best.as_ref())
        .map(|candidate| candidate.lyrics.synced.is_some())
        .unwrap_or(false)
}

/// Журнал попыток в порядке источников: LRCLIB, Netease, lyrics.ovh.
fn collect_attempts(sources: &[&Option<SourceOutcome>]) -> Vec<String> {
    let mut attempts = Vec::new();
    for outcome in sources.iter().filter_map(|item| item.as_ref()) {
        attempts.extend(outcome.attempts.iter().cloned());
    }
    attempts
}

/// Лучший ответ из уже пришедших. Genius и `lyrics.ovh` участвуют только тогда,
/// когда LRCLIB и Netease не нашли ничего: у них нет синхронизации.
fn merge_sources(
    lrclib: Option<SourceOutcome>,
    netease: Option<SourceOutcome>,
    ovh: Option<SourceOutcome>,
    genius: Option<SourceOutcome>,
) -> (Option<Candidate>, bool, Option<String>) {
    let main = lrclib.as_ref().and_then(|item| item.best.clone());
    let other = netease.as_ref().and_then(|item| item.best.clone());
    let best = match (main, other) {
        (Some(left), Some(right)) => Some(if right.rank > left.rank { right } else { left }),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    };

    // Последний рубеж — обычный текст: Genius ценнее lyrics.ovh (ранг выше),
    // но между собой они решаются общим ранжированием.
    let best = match best {
        Some(candidate) => Some(candidate),
        None => [ovh.as_ref(), genius.as_ref()]
            .into_iter()
            .filter_map(|outcome| outcome.and_then(|item| item.best.as_ref()))
            .max_by_key(|candidate| candidate.rank)
            .cloned(),
    };

    let mut answered = false;
    let mut network_error: Option<String> = None;
    for outcome in [lrclib.as_ref(), netease.as_ref(), ovh.as_ref(), genius.as_ref()] {
        if let Some(outcome) = outcome {
            answered |= outcome.answered;
            if network_error.is_none() {
                network_error = outcome.network_error.clone();
            }
        }
    }

    (best, answered, network_error)
}

/// Дождаться потоков, которые уже закончили, а остальные — передать
/// «сборщику»: он их дождётся в фоне. Так ответ не ждёт источник, чей запрос
/// ещё в полёте, и при этом не остаётся ни одного брошенного потока.
fn finish_threads(handles: Vec<std::thread::JoinHandle<()>>) {
    let mut running = Vec::new();
    for handle in handles {
        if handle.is_finished() {
            let _ = handle.join();
        } else {
            running.push(handle);
        }
    }

    if running.is_empty() {
        return;
    }

    std::thread::spawn(move || {
        for handle in running {
            let _ = handle.join();
        }
    });
}

/// Кодирование для строки запроса: пробел записывается как `+`, как принято
/// в query-параметрах. Кириллица и прочие не-ASCII уходят процентами.
fn urlencode(value: &str) -> String {
    encode(value, "+")
}

/// Кодирование для сегмента пути: пробел обязан быть `%20`, иначе сервер
/// прочитает его как знак «плюс» и название не совпадёт.
fn urlencode_path(value: &str) -> String {
    encode(value, "%20")
}

/// Процентное кодирование: неразрешёнными оставляем только символы RFC 3986.
fn encode(value: &str, space: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str(space),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// ---------- Текст на диске ----------
//
// Найденный текст живёт не только в localStorage браузера: копия кладётся
// файлом рядом с офлайн-версией трека — `%APPDATA%\com.example.musichub\lyrics`.
// Так подсветка строк работает и без сети, и после перезапуска: файл переживает
// чистку кеша браузера. Имя файла — `<безопасный id>.lrc`, поэтому id трека
// никогда не выходит за пределы папки.
//
// Первой строкой идёт служебный комментарий `# source: <источник>`: LRC
// допускает строки, начинающиеся с `#`, поэтому такой файл не ломает ни наши,
// ни сторонние парсеры. При чтении служебные строки отбрасываются — наружу
// отдаётся ровно тот текст, который был записан.

/// Папка текстов рядом с офлайн-копиями треков. Создаём только при записи:
/// чтение не должно заводить пустую папку.
pub fn lyrics_dir() -> Result<PathBuf, String> {
    let base = data_root()?;
    Ok(base.join("lyrics"))
}

/// Корень данных приложения. `APPDATA` — основной путь, запасные нужны только
/// там, где переменной нет; паники при этом не будет ни в одном случае.
fn data_root() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("LOCALAPPDATA").ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|v| !v.trim().is_empty()))
        .ok_or_else(|| "Не нашёл папку данных пользователя (APPDATA)".to_string())?;
    Ok(PathBuf::from(appdata).join("com.example.musichub"))
}

/// Сколько символов исходного id оставляем в «читаемой» части имени файла:
/// длинные пути обрезаются, различия между ними несёт хеш.
const MAX_ID_CHARS: usize = 60;
/// Сколько hex-символов хеша идёт в имя файла. Коллизия на 32 битах для
/// нескольких сотен текстов практически невозможна, а имена остаются короткими.
const HASH_CHARS: usize = 8;
/// Разделитель между читаемой частью имени и хешем.
const ID_SEPARATOR: &str = "__";

/// FNV-1a 64-бит: детерминированный хеш от БАЙТОВ исходного id. Своя функция,
/// а не крейт: нужна стабильность между запусками, а не криптостойкость —
/// хеш здесь только разводит разные id по разным файлам. `std::hash` для этого
/// не годится: у него нет гарантий стабильности между версиями и сборками.
fn stable_hash(value: &str) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET_BASIS;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Читаемая часть имени файла: только латиница, цифры, «-» и «_»; всё прочее
/// становится «-», серии дефисов схлопываются, края срезаются. Пусто — у id
/// не осталось ничего читаемого (кириллица, путь с разделителями).
fn readable_id(track_id: &str) -> String {
    let mapped: String = track_id
        .trim()
        .chars()
        .take(MAX_ID_CHARS)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();

    // «track-Кино-42» должно стать «track-42», а не «track--42»
    let mut collapsed = String::with_capacity(mapped.len());
    for ch in mapped.chars() {
        if ch == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(ch);
    }

    collapsed
        .trim_matches('-')
        .chars()
        .take(MAX_ID_CHARS)
        .collect()
}

/// Безопасная основа имени файла: `<читаемая часть>__<хеш>`.
///
/// Хеш обязателен и берётся от ИСХОДНОГО id. Без него все кириллические пути
/// («C:\Music\Кино - Звезда.mp3» и «C:\Music\Кино - Луна.mp3») дали бы одно и то
/// же имя, и разные треки делили бы один файл текста — то есть показывали бы
/// текст чужой песни. Один и тот же id всегда даёт одно и то же имя, поэтому
/// запись, чтение и удаление находят один и тот же файл.
fn safe_id(track_id: &str) -> String {
    // Ровно `HASH_CHARS` hex-символов: нули дополняют значение слева
    let hash = format!("{:016x}", stable_hash(track_id));
    let short = hash.get(..HASH_CHARS).unwrap_or(hash.as_str());
    let readable = readable_id(track_id);
    if readable.is_empty() {
        short.to_string()
    } else {
        format!("{readable}{ID_SEPARATOR}{short}")
    }
}

/// Путь к файлу текста трека: `<папка текстов>\<безопасный id>.lrc`.
fn local_path(track_id: &str) -> Result<PathBuf, String> {
    Ok(lyrics_dir()?.join(format!("{}.lrc", safe_id(track_id))))
}

/// Отбросить служебные строки формата `# source: …`: наружу отдаём только текст.
fn strip_service_lines(value: &str) -> String {
    value
        .lines()
        .filter(|line| !line.trim_start().starts_with("# source:"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Служебная строка файла: `# source: lrclib`. Источника нет — строки нет.
fn service_line(source: Option<&str>) -> Option<String> {
    let value = source.map(str::trim).filter(|value| !value.is_empty())?;
    // Перенос строки в источнике сломал бы формат файла
    let safe: String = value.chars().filter(|ch| *ch != '\n' && *ch != '\r').collect();
    Some(format!("# source: {safe}"))
}

/// Сохранить текст трека файлом: `<безопасный id>.lrc` в папке текстов.
///
/// Текст пишется КАК ЕСТЬ: синхронный остаётся синхронным, обычный — обычным,
/// тайминги не выдумываются. Пустой текст сохранять нечего — это ошибка.
pub fn save_local(track_id: &str, text: &str, source: Option<&str>) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Пустой текст песни сохранять нечего".to_string());
    }

    let dir = lyrics_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не создаётся папка текстов: {e}"))?;

    let mut body = String::new();
    if let Some(line) = service_line(source) {
        body.push_str(&line);
        body.push('\n');
    }
    body.push_str(text);

    let path = local_path(track_id)?;
    std::fs::write(&path, body).map_err(|e| format!("Не удалось сохранить текст: {e}"))
}

/// Прочитать сохранённый текст трека. `None` — файла нет, он пуст или повреждён;
/// ошибка чтения наружу не выходит, панель просто пойдёт искать текст дальше.
pub fn load_local(track_id: &str) -> Option<String> {
    let path = local_path(track_id).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let text = strip_service_lines(&raw);
    if text.trim().is_empty() {
        return None;
    }
    Some(text)
}

/// Есть ли на диске сохранённый текст трека.
pub fn has_local(track_id: &str) -> bool {
    match local_path(track_id) {
        Ok(path) => path.is_file(),
        Err(_) => false,
    }
}

/// Удалить сохранённый текст трека. Отсутствие файла ошибкой не считается:
/// результат тот же — файла нет.
pub fn remove_local(track_id: &str) -> Result<(), String> {
    let path = local_path(track_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Не удалось удалить текст: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_url_has_artist_track_and_duration() {
        let url = exact_url("Linkin Park", "Numb", None, 185);
        assert!(url.starts_with("https://lrclib.net/api/get?"), "получили: {url}");
        assert!(url.contains("artist_name=Linkin+Park"), "получили: {url}");
        assert!(url.contains("track_name=Numb"), "получили: {url}");
        assert!(url.contains("&duration=185"), "получили: {url}");
        // Альбом добавляем только когда он есть
        assert!(!url.contains("album_name"), "получили: {url}");
    }

    #[test]
    fn exact_url_encodes_cyrillic_and_omits_empty_duration() {
        let url = exact_url("Кино", "Группа крови", Some("Группа крови"), 0);
        assert!(url.contains("artist_name=%D0%9A%D0%B8%D0%BD%D0%BE"), "получили: {url}");
        assert!(url.contains("track_name=%D0%93%D1%80%D1%83%D0%BF%D0%BF%D0%B0+%D0%BA%D1%80%D0%BE%D0%B2%D0%B8"));
        assert!(url.contains("album_name=%D0%93%D1%80%D1%83%D0%BF%D0%BF%D0%B0+%D0%BA%D1%80%D0%BE%D0%B2%D0%B8"));
        // Нулевая длительность означает «неизвестна» — параметр не пишем
        assert!(!url.contains("duration="), "получили: {url}");
    }

    #[test]
    fn search_url_encodes_query() {
        let url = search_url("Numb Linkin Park");
        assert_eq!(url, "https://lrclib.net/api/search?q=Numb+Linkin+Park");
    }

    #[test]
    fn empty_request_is_reported_as_error() {
        let error = fetch("", "   ", 10).unwrap_err();
        assert!(error.contains("название"), "получили: {error}");
    }

    // ---------- Чистка тегов ----------

    #[test]
    fn normalize_drops_featured_tail() {
        assert_eq!(
            normalize_title("forgotten dreams (feat. shiawase)"),
            "forgotten dreams"
        );
        assert_eq!(normalize_title("Song [feat. Someone]"), "Song");
        assert_eq!(normalize_title("Song feat. Someone"), "Song");
        assert_eq!(normalize_title("Song ft. Someone"), "Song");
        assert_eq!(normalize_title("Song featuring Someone"), "Song");
        // Регистр не важен: «FEAT.» — тот же хвост
        assert_eq!(normalize_title("Song (FEAT. SOMEONE)"), "Song");
    }

    #[test]
    fn normalize_drops_production_and_remaster_tails() {
        assert_eq!(normalize_title("Song (prod. by Someone)"), "Song");
        assert_eq!(normalize_title("Song [prod. Someone]"), "Song");
        assert_eq!(normalize_title("Song - Remastered"), "Song");
        assert_eq!(normalize_title("Song - remaster"), "Song");
        assert_eq!(normalize_title("Song - Remastered 2011"), "Song");
        assert_eq!(normalize_title("Song (Remastered 2011)"), "Song");
        // Хвост «Remaster» может стоять и после года
        assert_eq!(normalize_title("Song (2011 Remaster)"), "Song");
    }

    #[test]
    fn normalize_drops_official_lyrics_audio_and_extra_spaces() {
        assert_eq!(
            normalize_title("  Song   Name  (Official Video) "),
            "Song Name"
        );
        assert_eq!(normalize_title("Song (Lyrics)"), "Song");
        assert_eq!(normalize_title("Song [Lyrics]"), "Song");
        assert_eq!(normalize_title("Song [Official Audio]"), "Song");
        assert_eq!(normalize_title("Song - Audio"), "Song");
        assert_eq!(normalize_title("Song - Official Music Video"), "Song");
    }

    #[test]
    fn normalize_keeps_meaningful_brackets_and_words() {
        assert_eq!(normalize_title("Numb"), "Numb");
        assert_eq!(
            normalize_title("Song (Live at Wembley)"),
            "Song (Live at Wembley)"
        );
        // «Video» в середине названия — часть названия, а не хвост
        assert_eq!(normalize_title("Radio Video"), "Radio Video");
        assert_eq!(
            normalize_title("Video Killed the Radio Star"),
            "Video Killed the Radio Star"
        );
        // Пустое название не должно превращаться в мусор из разделителей
        assert_eq!(normalize_title("   "), "");
    }

    #[test]
    fn normalize_artist_keeps_main_name_and_drops_tails() {
        assert_eq!(normalize_artist("shadowraze"), "shadowraze");
        assert_eq!(normalize_artist("Shadowraze (prod. Someone)"), "Shadowraze");
        assert_eq!(normalize_artist("Shadowraze & Shiawase"), "Shadowraze");
        assert_eq!(normalize_artist("  Shadowraze  "), "Shadowraze");
        assert_eq!(normalize_artist(""), "");
    }

    #[test]
    fn comparison_ignores_case_spaces_and_tails() {
        assert_eq!(
            comparison_key("Song (Feat. Someone)"),
            comparison_key("song")
        );
        assert_eq!(comparison_key("  SONG  "), comparison_key("song"));
        assert_ne!(comparison_key("Song"), comparison_key("Song Two"));
    }

    #[test]
    fn match_key_keeps_only_letters_and_digits() {
        assert_eq!(match_key("Prettiest Dolphin"), "prettiestdolphin");
        assert_eq!(match_key("prettiest-dolphin!"), "prettiestdolphin");
        assert_eq!(match_key("Группа крови"), "группакрови");
        // Служебные хвосты срезаются и здесь
        assert_eq!(match_key("Song (feat. Someone)"), "song");
    }

    // ---------- Строгая проверка соответствия ----------

    /// Запись источника: пустой исполнитель означает «в базе его нет».
    fn found(title: &str, artist: &str, duration: i64) -> FoundRecord {
        FoundRecord {
            title: title.to_string(),
            artists: if artist.is_empty() {
                Vec::new()
            } else {
                vec![artist.to_string()]
            },
            duration_sec: duration,
        }
    }

    #[test]
    fn match_accepts_exact_title_and_artist() {
        assert!(mismatch_reason(
            &found("Numb", "Linkin Park", 185),
            "Numb",
            "Linkin Park",
            185
        )
        .is_none());
        // Регистр и служебные хвосты не важны
        assert!(mismatch_reason(&found("NUMB", "Linkin Park", 185), "Numb", "Linkin Park", 185)
            .is_none());
        assert!(mismatch_reason(
            &found("Numb (Remastered 2011)", "Linkin Park", 185),
            "Numb",
            "Linkin Park",
            185
        )
        .is_none());
    }

    #[test]
    fn match_accepts_containment_in_both_directions() {
        // Название в базе полнее запроса
        assert!(mismatch_reason(
            &found("Numb (Live at Wembley)", "Linkin Park", 186),
            "Numb",
            "Linkin Park",
            185
        )
        .is_none());
        // Запрос полнее названия в базе
        assert!(mismatch_reason(
            &found("Numb", "Linkin Park", 185),
            "Numb (Live at Wembley)",
            "Linkin Park",
            185
        )
        .is_none());
    }

    #[test]
    fn match_rejects_another_title() {
        let reason = mismatch_reason(
            &found("Prettiest Dolphin", "Anonymous Ember", 200),
            "Toy",
            "Anonymous Ember",
            200,
        );
        assert!(reason.is_some(), "чужое название должно отсекаться");
        assert!(reason.unwrap().contains("название"));
    }

    #[test]
    fn exact_title_is_enough_even_with_foreign_artist_and_duration() {
        // «44» лежит в базе под другим именем исполнителя и с другой
        // длительностью: точного названия достаточно, иначе трек не находится
        let record = found("44", "Someone Else", 200);
        assert!(mismatch_reason(&record, "44", "shadowraze", 138).is_none());
        // Такой текст честно помечается «от оригинала»: исполнитель не подтвердился
        assert!(title_only_match(&record, "44", "shadowraze"));
        // Исполнитель совпал — подпись не нужна
        assert!(!title_only_match(
            &found("44", "shadowraze", 200),
            "44",
            "shadowraze"
        ));
        // Частичное совпадение так не проходит: там нужен исполнитель
        assert!(!title_only_match(
            &found("44 (Live)", "Someone Else", 200),
            "44",
            "shadowraze"
        ));
    }

    #[test]
    fn different_titles_are_rejected_even_without_the_artist() {
        // Именно эта защита не даёт приехать чужому тексту: у «Prettiest
        // Dolphin» источник отдавал запись «LILBOB #3STYLE» — названия разные
        let record = found("LILBOB #3STYLE", "LILBOB", 150);
        let reason = mismatch_reason(&record, "Prettiest Dolphin", "Anonymous Ember", 260);
        assert!(reason.is_some(), "чужое название должно отсекаться");
        assert!(reason.unwrap().contains("название"));
        assert!(!title_only_match(&record, "Prettiest Dolphin", "Anonymous Ember"));
    }

    #[test]
    fn partial_title_with_foreign_artist_is_rejected() {
        // Название совпало только частично, а исполнитель чужой: доверять
        // нельзя, даже если длительность сошлась
        let reason = mismatch_reason(
            &found("Toy (Live)", "Armand Bultheel", 200),
            "Toy",
            "Anonymous Ember",
            200,
        );
        assert!(reason.is_some(), "чужой исполнитель должен отсекаться");
        assert!(reason.unwrap().contains("исполнитель"));
    }

    #[test]
    fn match_accepts_one_matching_artist_word() {
        // Имя в базе записано полнее — достаточно одного общего слова
        assert!(mismatch_reason(
            &found("Toy", "Anonymous Ember feat. Someone", 200),
            "Toy",
            "Anonymous Ember",
            200
        )
        .is_none());
    }

    #[test]
    fn partial_title_without_artist_needs_close_duration() {
        // Точное название принимается и без исполнителя — это новое правило
        assert!(mismatch_reason(&found("Toy", "", 260), "Toy", "Anonymous Ember", 200).is_none());
        // А частичное совпадение без исполнителя подтверждает длительность ±3 с
        assert!(
            mismatch_reason(&found("Toy (Live)", "", 203), "Toy", "Anonymous Ember", 200).is_none()
        );
        let reason = mismatch_reason(&found("Toy (Live)", "", 204), "Toy", "Anonymous Ember", 200);
        assert!(reason.is_some(), "расхождение 4 с при неизвестном исполнителе");
        assert!(reason.unwrap().contains("длительность"));
        // Длительность записи неизвестна — подтвердить совпадение нечем
        assert!(mismatch_reason(&found("Toy (Live)", "", 0), "Toy", "Anonymous Ember", 200).is_some());
        // Длительность трека неизвестна — тогда проверять нечего, пропускаем
        assert!(mismatch_reason(&found("Toy (Live)", "", 0), "Toy", "Anonymous Ember", 0).is_none());
    }

    #[test]
    fn duration_deviation_needs_exact_title_and_artist() {
        // Название только «содержит» запрос — расхождение больше 5 с это промах
        let reason = mismatch_reason(
            &found("Toy (Live)", "Anonymous Ember", 300),
            "Toy",
            "Anonymous Ember",
            200,
        );
        assert!(reason.is_some(), "версия разошлась по времени");
        assert!(reason.unwrap().contains("длительность"));

        // Точное название и точный исполнитель — та же песня другой версии
        assert!(mismatch_reason(
            &found("Toy", "Anonymous Ember", 300),
            "Toy",
            "Anonymous Ember",
            200
        )
        .is_none());
    }

    #[test]
    fn match_handles_cyrillic() {
        assert!(mismatch_reason(
            &found("Группа крови", "Кино", 260),
            "Группа крови",
            "Кино",
            260
        )
        .is_none());
        // Регистр и лишняя пунктуация не мешают
        assert!(mismatch_reason(
            &found("группа крови!", "КИНО", 260),
            "Группа крови",
            "кино",
            260
        )
        .is_none());
        // Чужой исполнитель при ТОЧНОМ названии теперь принимается: такие
        // треки в базах лежат под именем загрузившего, и раньше они находились
        assert!(mismatch_reason(
            &found("Группа крови", "Аквариум", 260),
            "Группа крови",
            "Кино",
            260
        )
        .is_none());
        // А частичное совпадение названия с чужим исполнителем — по-прежнему мимо
        assert!(mismatch_reason(
            &found("Группа крови (Live)", "Аквариум", 260),
            "Группа крови",
            "Кино",
            260
        )
        .is_some());
        // Чужое название на кириллице
        assert!(mismatch_reason(
            &found("Хочу перемен", "Кино", 260),
            "Группа крови",
            "Кино",
            260
        )
        .is_some());
    }

    // ---------- Производные версии ----------

    #[test]
    fn version_markers_are_stripped_and_flagged() {
        for title in [
            "Я не буду спать (speed up+reverb)",
            "Я не буду спать speed up+reverb",
            "Я не буду спать (Speed Up + Reverb)",
            "Я не буду спать speed up reverb",
            "Я не буду спать speedup",
            "Я не буду спать spedup",
            "Я не буду спать (sped up)",
            "Я не буду спать (slowed)",
            "Я не буду спать (slowed + reverb)",
            "Я не буду спать (nightcore)",
            "Я не буду спать (8D audio)",
            "Я не буду спать (bass boosted)",
            "Я не буду спать (muffled)",
            "Я не буду спать tiktok version",
            "Я не буду спать (remix)",
            "Я не буду спать (cover)",
            "Я не буду спать (edit)",
            "Я не буду спать 1.25x",
            "Я не буду спать x1.25",
            "Я не буду спать 0.8x",
        ] {
            let (clean, derivative) = strip_version_markers(title);
            assert_eq!(clean, "Я не буду спать", "получили: {title}");
            assert!(derivative, "маркер не распознан: {title}");
        }
    }

    #[test]
    fn version_markers_keep_the_rest_of_the_title_meaningful() {
        // После вырезания пусто — это не производная версия, а песня с таким
        // названием: послабление для неё не включаем
        assert_eq!(strip_version_markers("Reverb"), (String::new(), false));
        assert_eq!(strip_version_markers("(sped up)"), (String::new(), false));
        // Без скобок «cover» и «edit» — часть настоящего названия
        assert_eq!(
            strip_version_markers("Cover Me"),
            ("Cover Me".to_string(), false)
        );
        assert_eq!(
            strip_version_markers("Edit the Sad Parts"),
            ("Edit the Sad Parts".to_string(), false)
        );
        // Обычное название маркеров не содержит
        assert_eq!(strip_version_markers("Numb"), ("Numb".to_string(), false));
        assert_eq!(
            strip_version_markers("  Radio   Video  "),
            ("Radio   Video".to_string(), false)
        );
    }

    #[test]
    fn original_candidates_use_the_cleaned_title() {
        assert_eq!(
            original_candidates("я не буду спать (speed up+reverb)"),
            vec!["я не буду спать".to_string()]
        );
        // Обычный трек — кандидатов нет, значит и послабления не будет
        assert!(original_candidates("Numb").is_empty());
        assert!(original_candidates("44").is_empty());
        assert!(original_candidates("Группа крови").is_empty());
        assert!(original_candidates("Radio Video").is_empty());
    }

    #[test]
    fn original_mode_ignores_artist_and_duration() {
        // У производной версии и исполнитель, и длительность заведомо другие
        let record = found("Я не буду спать", "Автоспорт", 150);
        assert!(original_mismatch_reason(&record, "я не буду спать").is_none());
        // Содержание в любую сторону — тоже совпадение
        assert!(original_mismatch_reason(
            &found("Я не буду спать (speed up)", "lazzzwq", 100),
            "я не буду спать"
        )
        .is_none());
        // А чужое название по-прежнему отсекается
        let reason = original_mismatch_reason(&found("Другая песня", "Кто-то", 150), "я не буду спать");
        assert!(reason.is_some(), "чужое название должно отсекаться");
        assert!(reason.unwrap().contains("название"));
    }

    #[test]
    fn original_pass_marks_lyrics_as_from_the_original() {
        let body = serde_json::json!({
            "trackName": "Я не буду спать",
            "artistName": "Автоспорт",
            "duration": 150,
            "syncedLyrics": "[00:01.00] текст"
        });
        let lyrics = original_lyrics_from(&body);
        assert!(lyrics.found);
        assert!(lyrics.from_original, "флаг «от оригинала» обязателен");
        assert_eq!(lyrics.matched_title.as_deref(), Some("Я не буду спать"));
        assert_eq!(lyrics.matched_artist.as_deref(), Some("Автоспорт"));
        // Обычный разбор того же ответа флаг не ставит
        assert!(!lyrics_from(&body).from_original);
    }

    #[test]
    fn original_search_accepts_a_foreign_record_with_the_same_title() {
        let body = serde_json::json!([
            { "trackName": "Другое", "artistName": "Кто-то", "duration": 90,
              "plainLyrics": "чужие строки", "syncedLyrics": null },
            { "trackName": "Я не буду спать", "artistName": "Автоспорт", "duration": 150,
              "plainLyrics": null, "syncedLyrics": "[00:01.00] текст" }
        ]);
        let (picked, _) = pick_from_search_original(&body, "я не буду спать");
        let picked = picked.expect("оригинал должен был найтись");
        assert_eq!(
            text_field(picked, "syncedLyrics").as_deref(),
            Some("[00:01.00] текст")
        );

        let (picked, reason) = pick_from_search_original(&body, "Совсем другая песня");
        assert!(picked.is_none(), "чужое название не должно подойти");
        assert!(reason.is_some(), "причина отказа попадает в журнал");
    }

    #[test]
    fn original_pass_runs_only_after_the_strict_one_failed() {
        let candidates = original_candidates("Song (speed up)");
        assert!(!candidates.is_empty());
        // Строгий проход нашёл текст — послабление не нужно
        assert!(!should_try_original(true, &candidates));
        // Строгий проход пуст — пробуем оригинал
        assert!(should_try_original(false, &candidates));
        // Обычный трек: кандидатов нет, послабления не будет
        assert!(!should_try_original(false, &original_candidates("Numb")));
    }

    #[test]
    fn derivative_track_gets_a_reserved_slice_of_the_budget() {
        let deadline = Fetcher::deadline();
        // Обычный трек: бюджет не трогаем
        assert_eq!(reserved_deadline(deadline, false), deadline);
        // Производный: часть бюджета придерживается для прохода по оригиналу
        let reserved = reserved_deadline(deadline, true);
        assert!(reserved < deadline, "запас не выделен");
        assert!(reserved.saturating_duration_since(Instant::now())
            < Duration::from_secs(TOTAL_BUDGET_SECS));
        assert!(ORIGINAL_RESERVE_SECS < TOTAL_BUDGET_SECS);
    }

    // ---------- Коллажи ----------

    #[test]
    fn collage_parts_split_on_separators() {
        for title in [
            "Miss (ayrro) x insomniac - tuboroshi x memo b",
            "Miss (ayrro) × insomniac - tuboroshi × memo b",
            "Miss (ayrro) X insomniac - tuboroshi X memo b",
            "Miss (ayrro) & insomniac - tuboroshi & memo b",
        ] {
            let candidates = original_candidates(title);
            assert!(
                candidates.contains(&"Miss".to_string()),
                "скобочное уточнение не снято: {candidates:?}"
            );
            assert!(
                candidates.contains(&"insomniac".to_string()),
                "хвост после тире не срезан: {candidates:?}"
            );
            assert!(
                candidates.contains(&"memo b".to_string()),
                "третья часть потерялась: {candidates:?}"
            );
        }
    }

    #[test]
    fn collage_candidates_go_from_long_to_short() {
        let candidates = original_candidates("Miss (ayrro) x insomniac - tuboroshi x memo b");
        assert_eq!(
            candidates,
            vec![
                "insomniac - tuboroshi".to_string(),
                "insomniac".to_string(),
                "memo b".to_string(),
                "Miss".to_string(),
            ]
        );
    }

    #[test]
    fn collage_candidates_are_limited() {
        let candidates = original_candidates("Aaa x Bbbb x Cccc x Dddd x Eeee");
        assert_eq!(
            candidates.len(),
            MAX_ORIGINAL_CANDIDATES,
            "получили: {candidates:?}"
        );
        assert!(candidates.len() <= 4, "получили: {candidates:?}");
    }

    #[test]
    fn collage_titles_get_the_loosened_pass() {
        let candidates = original_candidates("Miss (ayrro) x insomniac - tuboroshi x memo b");
        assert!(!candidates.is_empty());
        // Послабление включается только после провала строгого прохода
        assert!(should_try_original(false, &candidates));
        // Текст одной из частей коллажа принимается без исполнителя и длительности
        assert!(original_mismatch_reason(&found("Miss", "ayrro", 120), "Miss").is_none());
        assert!(original_mismatch_reason(&found("insomniac", "Кто-то другой", 300), "insomniac")
            .is_none());
        assert!(original_mismatch_reason(&found("Инопланетянин", "Кто-то", 120), "insomniac")
            .is_some());
    }

    #[test]
    fn more_than_one_separator_counts_as_a_collage() {
        // «+», «/», «|» и «,» тоже разделяют коллаж
        for (title, expected) in [
            ("Song One + Song Two", vec!["Song One", "Song Two"]),
            ("Song One / Song Two", vec!["Song One", "Song Two"]),
            ("Song One | Song Two", vec!["Song One", "Song Two"]),
            ("Song One, Song Two", vec!["Song One", "Song Two"]),
        ] {
            assert_eq!(
                original_candidates(title),
                expected
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<String>>(),
                "получили: {title}"
            );
        }
        // Одиночный «x» внутри слова не разделяет: «Xylophone» — одно название
        assert!(collage_parts("Xylophone").len() == 1);
    }

    #[test]
    fn ordinary_titles_keep_the_strict_behaviour() {
        // Название без разделителей, маркеров и скобок — кандидатов нет
        assert!(original_candidates("Numb").is_empty());
        assert!(original_candidates("Prettiest Dolphin").is_empty());
        // Строгая сверка для них прежняя: при частичном названии чужой
        // исполнитель по-прежнему отбрасывается
        let reason = mismatch_reason(
            &found("Radio Video (Live)", "Кто-то", 200),
            "Radio Video",
            "Кино",
            210,
        );
        assert!(reason.is_some(), "чужой исполнитель должен отсекаться");
        assert!(reason.unwrap().contains("исполнитель"));
    }

    #[test]
    fn artists_are_split_by_separators() {
        assert_eq!(
            split_artists("Shadowraze, Shiawase"),
            vec!["Shadowraze".to_string(), "Shiawase".to_string()]
        );
        assert_eq!(
            split_artists("Shadowraze & Shiawase"),
            vec!["Shadowraze".to_string(), "Shiawase".to_string()]
        );
        assert_eq!(
            split_artists("Shadowraze feat. Shiawase"),
            vec!["Shadowraze".to_string(), "Shiawase".to_string()]
        );
        assert_eq!(split_artists("Shadowraze"), vec!["Shadowraze".to_string()]);
        assert!(split_artists("").is_empty());
        assert!(split_artists("   ").is_empty());
    }

    #[test]
    fn candidates_include_featured_artist_from_title() {
        let names = artist_candidates("shadowraze", "forgotten dreams (feat. shiawase)");
        assert_eq!(
            names,
            vec!["shadowraze".to_string(), "shiawase".to_string()]
        );
        // Повторы в другом регистре — тот же исполнитель
        let repeated = artist_candidates("Shadowraze, shadowraze", "Song");
        assert_eq!(repeated, vec!["Shadowraze".to_string()]);
    }

    // ---------- Порядок вариантов ----------

    #[test]
    fn variants_go_from_precise_to_broad() {
        let plan = variants("shadowraze", "forgotten dreams (feat. shiawase)");
        let labels: Vec<String> = plan.iter().map(Lookup::label).collect();

        assert_eq!(
            labels[0],
            "точный запрос «shadowraze — forgotten dreams (feat. shiawase)»",
            "получили: {labels:?}"
        );
        assert_eq!(
            labels[1],
            "точный запрос «shadowraze — forgotten dreams»",
            "получили: {labels:?}"
        );
        // Длительность в тегах бывает неточной — пробуем имя без неё
        assert_eq!(
            labels[2],
            "точный запрос без длительности «shadowraze — forgotten dreams»",
            "получили: {labels:?}"
        );
        assert_eq!(labels[3], "поиск «forgotten dreams»", "получили: {labels:?}");
        assert_eq!(
            labels[4],
            "поиск «shadowraze forgotten dreams (feat. shiawase)»",
            "получили: {labels:?}"
        );
        assert_eq!(
            labels[5],
            "поиск «shadowraze forgotten dreams»",
            "получили: {labels:?}"
        );
        // Последними пробуем исполнителей по отдельности: «shadowraze» уже был,
        // значит остаётся гость из feat.
        assert_eq!(
            labels[6],
            "поиск «shiawase forgotten dreams»",
            "получили: {labels:?}"
        );
        assert_eq!(labels.len(), 7, "получили: {labels:?}");
    }

    #[test]
    fn variants_skip_empty_and_dont_repeat() {
        let plan = variants("", "Numb");
        assert_eq!(plan, vec![Lookup::Search { query: "Numb".into() }]);

        let plan = variants("Linkin Park", "Numb");
        let mut seen: Vec<Lookup> = Vec::new();
        for item in &plan {
            assert!(!seen.contains(item), "повтор варианта: {item:?}");
            seen.push(item.clone());
            match item {
                Lookup::Exact { artist, title } | Lookup::ExactName { artist, title } => {
                    assert!(!artist.trim().is_empty() && !title.trim().is_empty());
                }
                Lookup::Search { query } => assert!(!query.trim().is_empty()),
            }
        }
        // Первым всегда идёт точный запрос с теми же тегами, что и в плеере
        assert_eq!(
            plan[0],
            Lookup::Exact {
                artist: "Linkin Park".into(),
                title: "Numb".into()
            }
        );
    }

    #[test]
    fn variants_use_duration_only_for_exact_requests() {
        let plan = variants("shadowraze", "forgotten dreams (feat. shiawase)");
        assert!(plan[0].url(185).contains("&duration=185"));
        assert!(plan[1].url(185).contains("&duration=185"));
        // Вариант без длительности её не подставляет
        assert!(!plan[2].url(185).contains("duration="));

        for item in plan.iter() {
            match item {
                Lookup::Exact { .. } => assert!(
                    item.url(185).contains("&duration=185"),
                    "точный запрос без длительности: {item:?}"
                ),
                Lookup::ExactName { .. } => assert!(
                    !item.url(185).contains("duration="),
                    "длительность попала в запрос по имени: {item:?}"
                ),
                Lookup::Search { query } => assert_eq!(item.url(185), search_url(query)),
            }
        }

        // Когда чистые теги совпадают с исходными, вариант не повторяется:
        // остаётся один точный запрос, второй — уже без длительности
        let plain = variants("Linkin Park", "Numb");
        let exact = plain
            .iter()
            .filter(|item| matches!(item, Lookup::Exact { .. }))
            .count();
        assert_eq!(exact, 1, "получили: {plain:?}");
    }

    // ---------- Разбор ответа ----------

    #[test]
    fn synced_lyrics_are_preferred_over_plain() {
        let body = serde_json::json!({
            "trackName": "Numb",
            "artistName": "Linkin Park",
            "duration": 185,
            "plainLyrics": "I'm tired of being what you want me to be",
            "syncedLyrics": "[00:22.00] I'm tired of being what you want me to be"
        });
        let lyrics = lyrics_from(&body);
        assert!(lyrics.found);
        assert_eq!(lyrics.source.as_deref(), Some("lrclib"));
        assert_eq!(lyrics.title.as_deref(), Some("Numb"));
        assert_eq!(lyrics.artist.as_deref(), Some("Linkin Park"));
        assert!(lyrics.synced.as_deref().unwrap_or("").contains("[00:22.00]"));
        assert!(lyrics.plain.is_some());
        assert!(lyrics.attempts.is_empty());
    }

    #[test]
    fn plain_only_answer_is_still_found() {
        let body = serde_json::json!({ "plainLyrics": "строка текста", "syncedLyrics": null });
        let lyrics = lyrics_from(&body);
        assert!(lyrics.found);
        assert_eq!(lyrics.synced, None);
        assert_eq!(lyrics.plain.as_deref(), Some("строка текста"));
        // Пустые строки и пробелы считаем отсутствием текста
        let blank = lyrics_from(&serde_json::json!({ "plainLyrics": "   ", "syncedLyrics": "" }));
        assert!(!blank.found);
        assert_eq!(blank.plain, None);
        assert_eq!(blank.synced, None);
    }

    #[test]
    fn instrumental_answer_has_no_lyrics() {
        let body = serde_json::json!({
            "instrumental": true,
            "plainLyrics": null,
            "syncedLyrics": null
        });
        assert!(!lyrics_from(&body).found);
    }

    /// Разбор ответа поиска LRCLIB для запроса «Numb — Linkin Park».
    fn pick_numb(body: &serde_json::Value, duration: u32) -> Option<&serde_json::Value> {
        pick_from_search(body, "Numb", "Linkin Park", duration).0
    }

    #[test]
    fn search_prefers_matching_duration() {
        let body = serde_json::json!([
            { "trackName": "Numb", "artistName": "Linkin Park", "duration": 400,
              "plainLyrics": "концертная версия", "syncedLyrics": null },
            { "trackName": "Numb", "artistName": "Linkin Park", "duration": 186,
              "plainLyrics": "студийная версия", "syncedLyrics": "[00:01.00] hey" }
        ]);
        let picked = pick_numb(&body, 185).expect("должны были выбрать запись");
        assert_eq!(text_field(picked, "plainLyrics").as_deref(), Some("студийная версия"));
    }

    #[test]
    fn search_accepts_a_version_within_tolerance() {
        // Исполнителя в записи нет вовсе: совпадение держится на длительности,
        // и допуск там узкий (±3 с), а не общий ±5
        let body = serde_json::json!([
            { "trackName": "Numb", "duration": 190,
              "plainLyrics": null, "syncedLyrics": "[00:01.00] другая версия" },
            { "trackName": "Numb", "duration": 188,
              "plainLyrics": null, "syncedLyrics": "[00:01.00] студийная" }
        ]);
        let picked = pick_numb(&body, 185).expect("должны были выбрать запись");
        assert_eq!(text_field(picked, "syncedLyrics").as_deref(), Some("[00:01.00] студийная"));
    }

    #[test]
    fn search_prefers_synced_when_duration_is_unknown() {
        let body = serde_json::json!([
            { "trackName": "Numb", "artistName": "Linkin Park", "duration": 0,
              "plainLyrics": "только текст", "syncedLyrics": null },
            { "trackName": "Numb", "artistName": "Linkin Park", "duration": 0,
              "plainLyrics": null, "syncedLyrics": "[00:01.00] синхрон" }
        ]);
        let picked = pick_numb(&body, 0).expect("должны были выбрать запись");
        assert_eq!(text_field(picked, "syncedLyrics").as_deref(), Some("[00:01.00] синхрон"));
    }

    #[test]
    fn search_keeps_the_first_of_equal_candidates() {
        let body = serde_json::json!([
            { "trackName": "Numb", "artistName": "Linkin Park", "duration": 185,
              "plainLyrics": null, "syncedLyrics": "[00:01.00] первый" },
            { "trackName": "Numb", "artistName": "Linkin Park", "duration": 185,
              "plainLyrics": null, "syncedLyrics": "[00:01.00] второй" }
        ]);
        let picked = pick_numb(&body, 185).expect("должны были выбрать запись");
        assert_eq!(text_field(picked, "syncedLyrics").as_deref(), Some("[00:01.00] первый"));
    }

    #[test]
    fn search_skips_items_without_any_text() {
        let body = serde_json::json!([
            { "trackName": "Numb", "artistName": "Linkin Park", "duration": 185,
              "plainLyrics": null, "syncedLyrics": null },
            { "trackName": "Numb", "artistName": "Linkin Park", "duration": 185, "instrumental": true }
        ]);
        assert!(pick_numb(&body, 185).is_none());
    }

    #[test]
    fn search_rejects_records_that_failed_the_match() {
        // Ровно тот случай, из-за которого приезжал чужой текст: запись с
        // текстом нашлась, но это другая песня другого исполнителя
        let body = serde_json::json!([
            { "trackName": "Prettiest Dolphin (Armand Bultheel Remix)",
              "artistName": "Armand Bultheel", "duration": 200,
              "plainLyrics": null,
              "syncedLyrics": "[00:00.00] 作曲 : Armand Bultheel/Clara Cappagli" }
        ]);
        let (picked, reason) = pick_from_search(&body, "Prettiest Dolphin", "Anonymous Ember", 260);
        assert!(picked.is_none(), "чужая запись не должна подойти");
        assert!(reason.is_some(), "причина отказа должна попадать в журнал");
    }

    #[test]
    fn search_rejects_plain_text_from_a_foreign_record() {
        // Обычный текст тоже проверяется: если запись не прошла сверку,
        // found остаётся false — «чужой обычный текст» не показываем
        let body = serde_json::json!([
            { "trackName": "Другая песня", "artistName": "Кино",
              "duration": 260, "plainLyrics": "чужие строки", "syncedLyrics": null }
        ]);
        let (picked, reason) = pick_from_search(&body, "Группа крови", "Кино", 260);
        assert!(picked.is_none(), "название не совпало — записи нет");
        assert!(reason.is_some());
    }

    #[test]
    fn unexpected_search_answer_does_not_panic() {
        let wrong = serde_json::json!({ "message": "not found" });
        assert!(pick_from_search(&wrong, "Numb", "Linkin Park", 10).0.is_none());
        assert!(pick_from_search(&serde_json::json!([]), "Numb", "Linkin Park", 10)
            .0
            .is_none());
        assert!(pick_from_search(&serde_json::json!(null), "Numb", "Linkin Park", 10)
            .0
            .is_none());
    }

    #[test]
    fn not_found_answer_maps_to_empty_result() {
        let lyrics = Lyrics::missing();
        assert!(!lyrics.found);
        assert_eq!(lyrics.synced, None);
        assert_eq!(lyrics.plain, None);
        assert_eq!(lyrics.source, None);
        assert!(lyrics.attempts.is_empty());
    }

    #[test]
    fn failure_keeps_the_list_of_attempts() {
        let lyrics = Lyrics::not_found(vec![
            "точный запрос «shadowraze — forgotten dreams (feat. shiawase)» — записи нет".into(),
            "поиск «forgotten dreams» — ничего не нашлось".into(),
        ]);
        assert!(!lyrics.found);
        assert_eq!(lyrics.attempts.len(), 2);
        assert!(lyrics.attempts[0].contains("записи нет"));
    }

    #[test]
    fn answer_is_serialized_in_camel_case() {
        let lyrics = lyrics_from(&serde_json::json!({
            "trackName": "Numb",
            "artistName": "Linkin Park",
            "syncedLyrics": "[00:01.00] hey"
        }))
        .with_attempts(vec!["поиск «Numb» — синхронный текст".into()]);
        let json = serde_json::to_string(&lyrics).expect("сериализация не должна падать");
        assert!(json.contains("\"found\":true"), "получили: {json}");
        assert!(json.contains("\"synced\":"), "получили: {json}");
        assert!(json.contains("\"plain\":"), "получили: {json}");
        assert!(json.contains("\"source\":\"lrclib\""), "получили: {json}");
        assert!(json.contains("\"title\":\"Numb\""), "получили: {json}");
        // Флаг «текст от оригинала» уходит в интерфейс в camelCase
        assert!(json.contains("\"fromOriginal\":false"), "получили: {json}");
        assert!(json.contains("\"attempts\":["), "получили: {json}");
    }

    #[test]
    fn lrclib_not_found_body_is_not_a_network_error() {
        // 404 curl отдаёт с кодом состояния в последней строке
        assert!(matches!(
            reply_of("{\"message\":\"not found\"}\n404", "lrclib.net", "DoH"),
            Err(LookupError::Missing)
        ));
        assert!(matches!(
            reply_of("[{\"trackName\":\"Numb\"}]\n200", "lrclib.net", "DoH"),
            Ok(_)
        ));
        assert!(matches!(
            reply_of("\n500", "lrclib.net", "DoH"),
            Err(LookupError::Failed(_))
        ));
        assert!(matches!(
            reply_of("\n200", "lrclib.net", "DoH"),
            Err(LookupError::Failed(_))
        ));
        // Имя источника попадает в текст ошибки: по нему видно, кто отказал
        let error = reply_of("\n503", "Netease", "DoH").unwrap_err();
        assert!(
            format!("{error:?}").contains("Netease"),
            "получили: {error:?}"
        );
    }

    #[test]
    fn fetcher_stops_when_time_is_over() {
        let mut fetcher = Fetcher::new(Fetcher::deadline());
        // Бюджет уже истрачен — новых запросов не будет
        fetcher.deadline = Instant::now() - Duration::from_secs(1);
        assert!(fetcher.remaining().is_none());
        assert!(matches!(
            fetcher.json(&Request::get(
                "lrclib.net",
                "https://lrclib.net/api/get?artist_name=A&track_name=B"
            )),
            Err(LookupError::Failed(_))
        ));
    }

    // ---------- Источник Netease ----------

    #[test]
    fn netease_lyric_gives_synced_text() {
        let body = serde_json::json!({
            "lrc": { "version": 1, "lyric": "[00:01.00] строка\n[00:05.00] вторая" },
            "tlyric": { "lyric": "[00:01.00] перевод" }
        });
        let lyrics = netease_lyrics(&body).expect("текст должен был найтись");
        assert!(lyrics.found);
        assert_eq!(lyrics.source.as_deref(), Some("netease"));
        assert!(lyrics
            .synced
            .as_deref()
            .unwrap_or("")
            .contains("[00:05.00]"));
        assert_eq!(lyrics.plain, None);
    }

    #[test]
    fn netease_lyric_without_timestamps_is_plain() {
        let body = serde_json::json!({ "lrc": { "lyric": "первая строка\nвторая строка" } });
        let lyrics = netease_lyrics(&body).expect("текст должен был найтись");
        assert_eq!(lyrics.synced, None);
        assert_eq!(
            lyrics.plain.as_deref(),
            Some("первая строка\nвторая строка")
        );
    }

    #[test]
    fn netease_empty_and_stub_lyrics_are_not_found() {
        // Пустой ответ и отсутствие поля
        assert!(netease_lyrics(&serde_json::json!({ "lrc": { "lyric": "   " } })).is_none());
        assert!(netease_lyrics(&serde_json::json!({ "lrc": {} })).is_none());
        assert!(netease_lyrics(&serde_json::json!({})).is_none());
        assert!(netease_lyrics(&serde_json::json!(null)).is_none());

        // Инструментальная заглушка — это не текст песни
        assert!(netease_lyrics(&serde_json::json!({
            "lrc": { "lyric": "[00:00.00]此歌曲为没有填词的纯音乐，请欣赏" }
        }))
        .is_none());
        assert!(netease_lyrics(&serde_json::json!({
            "lrc": { "lyric": "纯音乐，请欣赏" }
        }))
        .is_none());

        // Явные флаги «текста нет»
        assert!(netease_lyrics(&serde_json::json!({ "nolyric": true })).is_none());
        assert!(netease_lyrics(&serde_json::json!({ "uncollected": true })).is_none());
    }

    #[test]
    fn netease_search_prefers_matching_duration() {
        let body = serde_json::json!({
            "result": { "songs": [
                { "id": 1, "name": "Numb", "duration": 400_000,
                  "artists": [{ "name": "Linkin Park" }] },
                { "id": 2, "name": "Numb", "duration": 186_000,
                  "artists": [{ "name": "Linkin Park" }] }
            ] }
        });
        let (song, _) = pick_netease_song(&body, "Numb", "Linkin Park", 185);
        let song = song.expect("трек должен был найтись");
        assert_eq!(song.get("id").and_then(|value| value.as_i64()), Some(2));
        assert_eq!(netease_song_artist(song).as_deref(), Some("Linkin Park"));
        assert_eq!(text_field(song, "name").as_deref(), Some("Numb"));
    }

    #[test]
    fn netease_record_reads_name_and_ar_names() {
        // Новый ответ поиска перечисляет исполнителей в `ar`, а не `artists`
        let song = serde_json::json!({
            "id": 7, "name": "Prettiest Dolphin", "duration": 200_500,
            "ar": [{ "name": "Anonymous Ember" }, { "name": "Someone Else" }]
        });
        let record = netease_record(&song);
        assert_eq!(record.title, "Prettiest Dolphin");
        assert_eq!(
            record.artists,
            vec!["Anonymous Ember".to_string(), "Someone Else".to_string()]
        );
        assert_eq!(record.duration_sec, 200);
    }

    #[test]
    fn netease_search_rejects_a_foreign_song() {
        // Поиск вернул запись, но это другая песня другого исполнителя:
        // раньше она уходила в интерфейс как «найденный текст»
        let body = serde_json::json!({
            "result": { "songs": [
                { "id": 1, "name": "Another Song", "duration": 200_000,
                  "ar": [{ "name": "Armand Bultheel" }] }
            ] }
        });
        let (song, reason) = pick_netease_song(&body, "Prettiest Dolphin", "Anonymous Ember", 200);
        assert!(song.is_none(), "чужая запись не должна подойти");
        assert!(reason.is_some(), "причина отказа должна попадать в журнал");
    }

    #[test]
    fn netease_search_handles_empty_and_broken_answers() {
        let empty = serde_json::json!({ "result": { "songs": [] } });
        assert!(pick_netease_song(&empty, "Numb", "Linkin Park", 10).0.is_none());
        assert!(pick_netease_song(&serde_json::json!({ "code": 400 }), "Numb", "Linkin Park", 10)
            .0
            .is_none());
        assert!(pick_netease_song(&serde_json::json!(null), "Numb", "Linkin Park", 10)
            .0
            .is_none());
        // Трек без id запросить нельзя
        let no_id = serde_json::json!({ "result": { "songs": [{ "name": "Numb" }] } });
        assert!(pick_netease_song(&no_id, "Numb", "Linkin Park", 10).0.is_none());
    }

    #[test]
    fn netease_queries_fall_back_to_title_only() {
        assert_eq!(
            netease_queries("shadowraze", "forgotten dreams (feat. shiawase)"),
            vec![
                "shadowraze forgotten dreams".to_string(),
                "forgotten dreams".to_string()
            ]
        );
        // Пустой исполнитель — только название, без дублей
        assert_eq!(netease_queries("", "Numb"), vec!["Numb".to_string()]);
        assert!(netease_queries("", "   ").is_empty());
    }

    #[test]
    fn netease_requests_are_posts_with_referer() {
        let request = netease_search_request("Numb Linkin Park");
        assert!(request.is_post(), "поиск Netease — POST с полями формы");
        assert!(request.url.starts_with("https://music.163.com/api/search/get"));
        assert!(request
            .form
            .iter()
            .any(|(name, value)| name == "s" && value == "Numb Linkin Park"));
        assert!(request.form.iter().any(|(name, value)| name == "type" && value == "1"));
        assert!(request
            .headers
            .iter()
            .any(|(name, value)| name == "Referer" && value == "https://music.163.com/"));

        let lyric = netease_lyric_request(12345);
        assert!(lyric.url.starts_with("https://music.163.com/api/song/lyric"));
        assert!(lyric
            .form
            .iter()
            .any(|(name, value)| name == "id" && value == "12345"));
        assert!(lyric.form.iter().any(|(name, value)| name == "lv" && value == "1"));
    }

    // ---------- Источник lyrics.ovh ----------

    #[test]
    fn lyrics_ovh_answer_is_plain_text() {
        let body = serde_json::json!({ "lyrics": "первая строка\r\nвторая строка\r\n" });
        let lyrics = lyrics_ovh_lyrics(&body).expect("текст должен был найтись");
        assert_eq!(lyrics.source.as_deref(), Some("lyrics.ovh"));
        assert_eq!(lyrics.synced, None);
        assert_eq!(lyrics.plain.as_deref(), Some("первая строка\nвторая строка"));
    }

    #[test]
    fn lyrics_ovh_error_means_not_found() {
        assert!(lyrics_ovh_lyrics(&serde_json::json!({ "error": "No lyrics found" })).is_none());
        assert!(lyrics_ovh_lyrics(&serde_json::json!({ "lyrics": "   " })).is_none());
        assert!(lyrics_ovh_lyrics(&serde_json::json!({})).is_none());
        assert!(lyrics_ovh_lyrics(&serde_json::json!(null)).is_none());
    }

    #[test]
    fn lyrics_ovh_service_lines_are_removed() {
        let body = serde_json::json!({
            "lyrics": "Paroles de la chanson Numb par Linkin Park\r\n\r\n******* Letra de la canción Numb par Linkin Park\r\nнастоящая строка"
        });
        let lyrics = lyrics_ovh_lyrics(&body).expect("текст должен был найтись");
        assert_eq!(lyrics.plain.as_deref(), Some("настоящая строка"));
    }

    #[test]
    fn lyrics_ovh_url_encodes_path_segments() {
        let url = lyrics_ovh_url("Кино", "Группа крови");
        assert_eq!(
            url,
            "https://api.lyrics.ovh/v1/%D0%9A%D0%B8%D0%BD%D0%BE/%D0%93%D1%80%D1%83%D0%BF%D0%BF%D0%B0%20%D0%BA%D1%80%D0%BE%D0%B2%D0%B8"
        );
        // Пробел в пути — это %20, а не «+»
        assert!(!url.contains('+'), "получили: {url}");
    }

    // ---------- Порядок источников ----------

    #[test]
    fn synced_lyrics_outrank_plain_ones() {
        assert!(rank_of("lrclib", true) > rank_of("netease", true));
        assert!(rank_of("netease", true) > rank_of("lrclib", false));
        assert!(rank_of("lrclib", false) > rank_of("netease", false));
        assert!(rank_of("netease", false) > rank_of("lyrics.ovh", false));
        assert_eq!(rank_of("неизвестный", true), 0);
    }

    /// Ответ одного источника для проверки слияния результатов.
    fn outcome(lyrics: Lyrics) -> SourceOutcome {
        let source = lyrics.source.clone().unwrap_or_default();
        let rank = rank_of(&source, lyrics.synced.is_some());
        SourceOutcome {
            best: Some(Candidate { rank, lyrics }),
            attempts: Vec::new(),
            answered: true,
            network_error: None,
        }
    }

    #[test]
    fn search_keeps_the_best_candidate() {
        let plain = |source: &str| Lyrics {
            found: true,
            synced: None,
            plain: Some("текст".into()),
            source: Some(source.into()),
            title: None,
            artist: None,
            matched_title: None,
            matched_artist: None,
            from_original: false,
            estimated: false,
            attempts: Vec::new(),
        };
        let synced = |source: &str| Lyrics {
            synced: Some("[00:01.00] текст".into()),
            ..plain(source)
        };

        // Обычный текст LRCLIB не должен затирать синхронный из Netease
        let (best, answered, _) = merge_sources(
            Some(outcome(plain("lrclib"))),
            Some(outcome(synced("netease"))),
            None,
            None,
        );
        assert!(answered);
        let best = best.expect("должен был найтись ответ");
        assert_eq!(best.lyrics.source.as_deref(), Some("netease"));
        assert!(best.lyrics.synced.is_some());

        // А синхронный LRCLIB, наоборот, важнее синхронного Netease
        let (best, _, _) = merge_sources(
            Some(outcome(synced("lrclib"))),
            Some(outcome(synced("netease"))),
            None,
            None,
        );
        let best = best.expect("должен был найтись ответ");
        assert_eq!(best.lyrics.source.as_deref(), Some("lrclib"));
        // Лучший возможный ответ — дальше искать нечего
        assert!(best.rank >= BEST_RANK);
    }

    #[test]
    fn plain_text_is_used_when_nothing_is_synced() {
        // Обычный текст LRCLIB остаётся ответом, если синхронизации нет нигде:
        // «если нету синхры — просто текст оставь и все»
        let plain = Lyrics {
            found: true,
            synced: None,
            plain: Some("строка текста".into()),
            source: Some("lrclib".into()),
            title: None,
            artist: None,
            matched_title: None,
            matched_artist: None,
            from_original: false,
            estimated: false,
            attempts: Vec::new(),
        };
        let (best, _, _) = merge_sources(Some(outcome(plain)), None, None, None);
        let best = best.expect("обычный текст тоже ответ");
        assert!(best.lyrics.found);
        assert!(best.lyrics.synced.is_none(), "синхронизации нет");
        assert_eq!(best.lyrics.plain.as_deref(), Some("строка текста"));
        assert!(best.rank < BEST_RANK);
    }

    #[test]
    fn ovh_is_used_only_when_main_sources_are_empty() {
        let plain = |source: &str| Lyrics {
            found: true,
            synced: None,
            plain: Some("текст".into()),
            source: Some(source.into()),
            title: None,
            artist: None,
            matched_title: None,
            matched_artist: None,
            from_original: false,
            estimated: false,
            attempts: Vec::new(),
        };

        // lyrics.ovh не перебивает уже найденное Netease — и Genius тоже
        let (best, _, _) = merge_sources(
            Some(outcome(plain("netease"))),
            None,
            Some(outcome(plain("lyrics.ovh"))),
            Some(outcome(plain("genius"))),
        );
        assert_eq!(
            best.expect("ответ есть").lyrics.source.as_deref(),
            Some("netease")
        );

        // И участвует, только когда главные источники ничего не нашли
        let (best, _, _) = merge_sources(
            None,
            None,
            Some(outcome(plain("lyrics.ovh"))),
            Some(outcome(plain("genius"))),
        );
        // Genius ценнее lyrics.ovh: покрытие больше, а запись подтверждена
        // метаданными поиска — при пустых главных источниках берётся он
        assert_eq!(
            best.expect("ответ есть").lyrics.source.as_deref(),
            Some("genius")
        );

        // Один Genius — тоже ответ
        let (best, _, _) = merge_sources(None, None, None, Some(outcome(plain("genius"))));
        assert_eq!(
            best.expect("ответ есть").lyrics.source.as_deref(),
            Some("genius")
        );
    }

    #[test]
    fn cancel_stops_the_other_sources_at_once() {
        // Логика раннего выхода проверяется без сети: отменённый поиск сразу
        // перестаёт перебирать варианты и честно пишет об этом в журнал
        let cancel = Cancel::new();
        let search = Search::with_cancel(cancel.clone(), Fetcher::deadline());
        assert!(!search.should_stop());
        cancel.cancel();
        assert!(search.should_stop());
        assert!(
            search.stop_reason().contains("прекращён"),
            "получили: {}",
            search.stop_reason()
        );
    }

    #[test]
    fn sources_are_queried_in_parallel_with_a_shared_deadline() {
        // Все источники получают один и тот же абсолютный дедлайн: бюджет
        // считается на операцию, а не на каждый источник отдельно
        let deadline = Fetcher::deadline();
        let first = Search::with_cancel(Cancel::new(), deadline).fetcher.deadline;
        let second = Search::with_cancel(Cancel::new(), deadline).fetcher.deadline;
        assert_eq!(first, second);
        assert!(deadline.saturating_duration_since(Instant::now())
            <= Duration::from_secs(TOTAL_BUDGET_SECS));
    }

    #[test]
    fn search_reports_not_found_with_attempts() {
        let (best, answered, error) = merge_sources(None, None, None, None);
        assert!(best.is_none());
        assert!(!answered, "никто не ответил — это уже сетевая ошибка");
        assert!(error.is_none());

        // Источник ответил, но текста нет: честное «не найдено» без ошибки
        let empty = SourceOutcome {
            answered: true,
            attempts: vec!["LRCLIB — записи нет".into()],
            ..SourceOutcome::default()
        };
        let attempts = collect_attempts(&[&Some(empty.clone()), &None, &None, &None]);
        let (best, answered, _) = merge_sources(Some(empty), None, None, None);
        assert!(best.is_none());
        assert!(answered, "источник ответил отказом, а не промолчал");
        let lyrics = Lyrics::not_found(attempts);
        assert!(!lyrics.found);
        assert_eq!(lyrics.attempts.len(), 1);
    }

    // ---------- Genius ----------

    #[test]
    fn genius_search_response_is_parsed_into_records() {
        let body = serde_json::json!({
            "response": {
                "sections": [
                    {
                        "type": "top_hit",
                        "hits": [
                            {
                                "type": "song",
                                "result": {
                                    "title": "ocean eyes",
                                    "artist_names": "Billie Eilish",
                                    "path": "/Billie-eilish-ocean-eyes-lyrics"
                                }
                            }
                        ]
                    },
                    {
                        "type": "song",
                        "hits": [
                            {
                                "type": "song",
                                "result": {
                                    "title": "Ocean Eyes",
                                    "artist_names": "Billie Eilish & Finneas",
                                    "path": "/Billie-eilish-ocean-eyes-lyrics-2"
                                }
                            },
                            { "type": "artist", "result": { "name": "Billie Eilish" } }
                        ]
                    }
                ]
            }
        });

        let records = genius_records(&body);
        assert_eq!(records.len(), 2, "хиты-не-песни не считаются");
        assert_eq!(records[0].0.title, "ocean eyes");
        assert_eq!(records[0].1, "/Billie-eilish-ocean-eyes-lyrics");
        assert_eq!(records[1].0.artists, vec!["Billie Eilish", "Finneas"]);
        assert_eq!(records[0].0.duration_sec, 0, "длительности в ответе нет");
    }

    #[test]
    fn genius_lyrics_container_is_extracted_from_page_html() {
        // Структура реальной страницы: шапка с участниками (вложенный div),
        // пустой контейнер и сам текст
        let html = concat!(
            "<body>",
            "<div data-lyrics-container=\"true\" class=\"Lyrics\"><div class=\"Header\">",
            "<span>Lyrics by A</span></div></div>",
            "<div data-lyrics-container=\"true\"></div>",
            "<div data-lyrics-container=\"true\">[Chorus]<br/>",
            "<a href=\"/x\">No fair</a>, you really know<br/><br/>",
            "how to make me &#x27;cry&#x27;<br/>when you give me those &quot;ocean eyes&quot;</div>",
            "</body>"
        );

        let plain = genius_plain_of(html);
        let lines: Vec<&str> = plain.split('\n').collect();
        assert_eq!(
            lines,
            vec![
                "[Chorus]",
                "No fair, you really know",
                "how to make me 'cry'",
                "when you give me those \"ocean eyes\"",
            ],
            "получили: {plain}"
        );
    }

    #[test]
    fn genius_short_text_is_not_lyrics() {
        // Только шапка и мусор: текстом это не считаем
        let html = "<div data-lyrics-container=\"true\">Lyrics by Someone</div>";
        assert!(genius_plain_of(html).is_empty());
        assert!(genius_plain_of("<html></html>").is_empty(), "контейнеров нет");
    }

    #[test]
    fn genius_entities_are_decoded() {
        assert_eq!(genius_decode_entities("&amp;&lt;&#x27;&#39;&nbsp;"), "&<''\u{a0}");
        assert_eq!(genius_decode_entities("fish &amp; chips"), "fish & chips");
        // Амперсанд без сущности остаётся как есть
        assert_eq!(genius_decode_entities("AT&T and M&Ms"), "AT&T and M&Ms");
    }

    #[test]
    fn genius_rank_is_above_lyrics_ovh() {
        assert!(rank_of("genius", false) > rank_of("lyrics.ovh", false));
        // Свой тайминг (estimate_lrc) у Genius теперь есть, но он ниже любого
        // настоящего LRC: 15 против 40 у LRCLIB и 30 у Netease.
        assert_eq!(rank_of("genius", true), 15, "примерный тайминг — не LRC");
        assert!(rank_of("lrclib", true) > rank_of("genius", true));
        assert!(rank_of("netease", true) > rank_of("genius", true));
        assert!(rank_of("netease", false) > rank_of("genius", false));
    }

    #[test]
    fn estimated_timing_covers_every_line_inside_the_track() {
        let plain = "[Куплет 1]\nПервая строка текста\nВторая строка подлиннее\n\nПрипев поёт\nЕщё одна строка";
        let lrc = estimate_lrc(plain, 200).expect("тайминг должен получиться");

        let timed: Vec<&str> = lrc.lines().filter(|line| parse_estimate_seconds(line).is_some()).collect();
        let texts: Vec<&str> = lrc.lines().filter(|line| parse_estimate_seconds(line).is_none()).collect();
        assert_eq!(timed.len(), 5, "каждая строка получает время");
        assert_eq!(texts.len(), 5, "текст строк не потерян");
        assert!(texts.contains(&"[Куплет 1]"), "заголовок остаётся строкой текста");

        // Времена растут и укладываются в трек (старт после 6% вступления).
        let mut previous = -1.0f64;
        for line in &timed {
            let seconds = parse_estimate_seconds(line).expect("метка разбирается");
            assert!(seconds > previous, "метки по возрастанию: {line}");
            assert!(seconds < 200.0, "метка внутри трека: {line}");
            previous = seconds;
        }
        assert!(previous > 120.0, "последняя строка заметно позже первой");
    }

    #[test]
    fn no_estimated_timing_for_tiny_or_short_inputs() {
        assert!(estimate_lrc("одна строка", 200).is_none(), "мало строк");
        assert!(
            estimate_lrc("[a]\n[b]\n[c]\n[d]", 10).is_none(),
            "трек короче 30 секунд"
        );
        let mut lyrics = Lyrics { found: true, plain: Some("[a]\n[b]\n[c]".into()), ..Default::default() };
        let same = with_estimated_timing(lyrics.clone(), 200);
        assert!(!same.estimated, "три строки — мало для тайминга");
        assert!(same.synced.is_none());

        // Настоящий LRC не трогаем.
        lyrics.synced = Some("[00:01.00]настоящий".into());
        lyrics.plain = Some("что-то".into());
        let kept = with_estimated_timing(lyrics, 200);
        assert!(!kept.estimated, "настоящий тайминг остаётся настоящим");
    }

    /// Время из метки `[mm:ss.xx]` обратно в секунды — для теста выше.
    fn parse_estimate_seconds(line: &str) -> Option<f64> {
        let inner = line.strip_prefix('[')?.split(']').next()?;
        let (minutes, rest) = inner.split_once(':')?;
        Some(minutes.parse::<f64>().ok()? * 60.0 + rest.parse::<f64>().ok()?)
    }

    /// Живая сеть: обычные прогоны тестов идут без неё, этот — по запросу
    /// (`cargo test genius_live -- --ignored --nocapture`).
    #[test]
    #[ignore = "живая сеть: запускать вручную"]
    fn genius_live_search_and_page() {
        let mut search = Search::with_cancel(Cancel::new(), Fetcher::deadline());
        let body = search
            .json(&genius_search_request("Billie Eilish ocean eyes"))
            .expect("поиск Genius ответил");
        let records = genius_records(&body);
        assert!(!records.is_empty(), "в поиске есть песни");

        let (record, path) = &records[0];
        assert!(path.starts_with('/'), "путь страницы корректен: {path}");

        let lyrics = genius_page_lyrics(&mut search, path).expect("страница отдала текст");
        let plain = lyrics.plain.expect("текст извлечён");
        assert!(plain.chars().count() > 100, "текст не обрывок: {plain}");
        assert!(
            plain.to_lowercase().contains("ocean eyes"),
            "в тексте есть строчка песни"
        );
        assert_eq!(record.title.to_lowercase(), "ocean eyes");
    }

    /// Живая проверка «Genius + наш тайминг»: текст находим, метки времени
    /// расставлены нами, и признак `estimated` выставлен.
    /// (`cargo test genius_live_estimated -- --ignored --nocapture`)
    #[test]
    #[ignore = "живая сеть: запускать вручную"]
    fn genius_live_estimated_timing() {
        let mut search = Search::with_cancel(Cancel::new(), Fetcher::deadline());
        search_genius(&mut search, "Billie Eilish", "ocean eyes", 199);

        let lyrics = search
            .best
            .clone()
            .map(|candidate| candidate.lyrics)
            .expect("Genius отдал текст");
        assert!(lyrics.estimated, "тайминг помечен как примерный");
        let lrc = lyrics.synced.expect("LRC собран");
        let marks = lrc.lines().filter(|line| line.starts_with('[')).count();
        assert!(marks > 10, "меток много: {marks}");
        assert!(lrc.contains("[00:"), "формат LRC: {}", &lrc[..lrc.len().min(40)]);
        println!("{}", &lrc[..lrc.len().min(200)]);
    }

    // ---------- Бюджет времени и транспорт ----------

    #[test]
    fn time_budget_is_shared_between_sources() {
        assert!(
            REQUEST_TIMEOUT_SECS <= TOTAL_BUDGET_SECS,
            "один запрос не может быть дольше всего бюджета"
        );
        let left = Fetcher::new(Fetcher::deadline())
            .remaining()
            .expect("бюджет только что начался");
        assert!(left <= Duration::from_secs(TOTAL_BUDGET_SECS));
        assert!(left > Duration::from_secs(TOTAL_BUDGET_SECS - 1));
    }

    #[test]
    fn curl_arguments_disable_certificate_revocation_check() {
        let request = Request::get("lrclib.net", "https://lrclib.net/api/search?q=Numb");
        let args = curl_args(
            &request,
            Transport::Doh,
            Duration::from_secs(REQUEST_TIMEOUT_SECS),
        );

        // Флаг понимает только Schannel-сборка curl (Windows)
        assert_eq!(
            args.contains(&SSL_NO_REVOKE.to_string()),
            cfg!(windows),
            "получили: {args:?}"
        );
        assert!(args.contains(&"--doh-url".to_string()), "получили: {args:?}");
        assert!(
            args.contains(&REQUEST_TIMEOUT_SECS.to_string()),
            "таймаут запроса должен быть не больше {} с: {args:?}",
            REQUEST_TIMEOUT_SECS
        );
        // Своего агента у запроса нет — подставляем общий
        assert!(
            args.windows(2).any(|pair| pair[0] == "-A"),
            "получили: {args:?}"
        );
        assert_eq!(
            args.last().map(String::as_str),
            Some("https://lrclib.net/api/search?q=Numb")
        );
    }

    #[test]
    fn curl_arguments_build_a_post_with_form_fields() {
        let request = netease_search_request("Numb");
        let args = curl_args(&request, Transport::Plain, Duration::from_secs(8));
        let pairs: Vec<(&str, &str)> = args
            .windows(2)
            .map(|pair| (pair[0].as_str(), pair[1].as_str()))
            .collect();

        assert!(pairs.contains(&("-X", "POST")), "получили: {args:?}");
        assert!(
            pairs.contains(&("--data-urlencode", "s=Numb")),
            "получили: {args:?}"
        );
        assert!(
            pairs.contains(&("-H", "Referer: https://music.163.com/")),
            "получили: {args:?}"
        );
        // Свой User-Agent уже есть — общий (-A) не подставляем
        assert!(!args.contains(&"-A".to_string()), "получили: {args:?}");
        assert!(
            pairs.contains(&("-w", "\n%{http_code}")),
            "получили: {args:?}"
        );
    }

    #[test]
    fn urlencode_encodes_cyrillic_for_query_and_path() {
        assert_eq!(urlencode("Кино"), "%D0%9A%D0%B8%D0%BD%D0%BE");
        assert_eq!(urlencode("Numb Linkin Park"), "Numb+Linkin+Park");
        assert_eq!(
            urlencode_path("Группа крови"),
            "%D0%93%D1%80%D1%83%D0%BF%D0%BF%D0%B0%20%D0%BA%D1%80%D0%BE%D0%B2%D0%B8"
        );
    }

    #[test]
    fn lrc_timestamp_detection() {
        assert!(has_lrc_timestamps("[00:01.00] текст"));
        assert!(has_lrc_timestamps("строка\n[1:02] вторая"));
        assert!(has_lrc_timestamps("[00:12.5]строка без пробела"));
        // Служебные теги и обычный текст метками не считаются
        assert!(!has_lrc_timestamps("просто текст [не метка]"));
        assert!(!has_lrc_timestamps("[ar:Кино]\n[ti:Песня]"));
    }

    // ---------- Текст на диске ----------

    /// Уникальный след теста: параллельные тесты не должны мешать друг другу.
    fn test_id(name: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        format!("test-{name}-{nanos}")
    }

    /// Убрать за собой файл и, если получится, пустую папку текстов.
    fn cleanup(id: &str) {
        let _ = remove_local(id);
    }

    #[test]
    fn safe_id_keeps_only_letters_digits_dash_and_underscore() {
        // Читаемая часть сохраняется как есть, следом идёт хеш
        assert!(
            safe_id("Numb_Linkin-Park").starts_with(&format!("Numb_Linkin-Park{ID_SEPARATOR}")),
            "получили: {}",
            safe_id("Numb_Linkin-Park")
        );
        assert_eq!(readable_id("local:track/42"), "local-track-42");
        // Точки-точки и разделители путей: имя наружу выйти не может
        assert_eq!(readable_id("../../etc/passwd"), "etc-passwd");
        assert_eq!(readable_id(".."), "");
        assert_eq!(readable_id("   "), "");
        // Кириллица в имени файла недопустима: от неё остаются только дефисы,
        // а уникальность несёт хеш (см. тесты ниже)
        assert_eq!(readable_id("Кино"), "");
        assert_eq!(readable_id("track-Кино-42"), "track-42");
        // Пробелы по краям не влияют
        assert_eq!(readable_id("  abc  "), "abc");
    }

    #[test]
    fn safe_id_is_stable_and_ends_with_the_hash() {
        let id = "local:track/42";
        // Один и тот же id — всегда одно и то же имя: по нему файл и находят
        assert_eq!(safe_id(id), safe_id(id));
        // Читаемая часть, разделитель и хеш фиксированной длины
        let name = safe_id(id);
        assert!(name.starts_with("local-track-42"), "получили: {name}");
        assert!(name.contains(ID_SEPARATOR), "получили: {name}");
        let suffix = name.rsplit(ID_SEPARATOR).next().unwrap();
        assert_eq!(suffix.chars().count(), HASH_CHARS, "получили: {name}");
        assert!(suffix.chars().all(|ch| ch.is_ascii_hexdigit()), "получили: {name}");
        // Хеш считается от ИСХОДНОГО id, а не от читаемой части: иначе «/» и
        // «:» дали бы одно имя и разные треки делили бы один файл
        assert_ne!(safe_id("a/b"), safe_id("a:b"));
    }

    #[test]
    fn cyrillic_ids_get_different_files() {
        let star = "C:\\Music\\Кино - Звезда.mp3";
        let moon = "C:\\Music\\Кино - Луна.mp3";

        // От кириллицы читаемой части не остаётся: имя держится на хеше.
        // Разные пути при этом обязаны получить разные имена — иначе треки
        // делили бы один файл и показывался бы текст чужой песни.
        let star_name = safe_id(star);
        let suffix = star_name.rsplit(ID_SEPARATOR).next().unwrap_or(&star_name);
        assert_eq!(
            suffix.chars().count(),
            HASH_CHARS,
            "получили: {star_name}"
        );
        assert_ne!(safe_id(star), safe_id(moon), "разные треки — разные файлы");
        assert_ne!(
            local_path(star).unwrap(),
            local_path(moon).unwrap(),
            "разные треки не должны делить файл текста"
        );
        // Стабильность: то же имя при повторном вычислении
        assert_eq!(safe_id(star), safe_id(star));
    }

    #[test]
    fn cyrillic_paths_round_trip_through_disk() {
        let star = "C:\\Music\\Кино - Звезда.mp3";
        let moon = "C:\\Music\\Кино - Луна.mp3";
        save_local(star, "текст звезды", Some("lrclib")).unwrap();
        save_local(moon, "текст луны", Some("lrclib")).unwrap();

        // Каждый трек читает свой текст, а не соседский
        assert_eq!(load_local(star).as_deref(), Some("текст звезды"));
        assert_eq!(load_local(moon).as_deref(), Some("текст луны"));
        assert_ne!(safe_id(star), safe_id(moon));

        cleanup(star);
        cleanup(moon);
        // Удаление одного не тронуло файл другого
        assert!(!has_local(star));
        assert!(!has_local(moon));
    }

    #[test]
    fn safe_id_is_capped_at_max_length() {
        let long = "a".repeat(400);
        let cleaned = safe_id(&long);
        // Читаемая часть ограничена, но хеш всегда остаётся
        assert_eq!(
            cleaned.chars().count(),
            MAX_ID_CHARS + ID_SEPARATOR.len() + HASH_CHARS,
            "получили {cleaned}"
        );
        let (readable, suffix) = cleaned.rsplit_once(ID_SEPARATOR).unwrap();
        assert!(readable.chars().all(|ch| ch == 'a'), "получили {cleaned}");
        assert_eq!(suffix.chars().count(), HASH_CHARS, "получили {cleaned}");
    }

    #[test]
    fn plain_text_round_trip_and_service_line_is_dropped() {
        let id = test_id("plain");
        let text = "Первая строка\nВторая строка";
        save_local(&id, text, Some("lrclib")).unwrap();

        assert!(has_local(&id));
        let loaded = load_local(&id).expect("текст должен читаться");
        assert_eq!(loaded, text);
        assert!(!loaded.contains("# source:"), "служебная строка осталась");

        // На диске служебная строка есть — LRC её допускает
        let raw = std::fs::read_to_string(local_path(&id).unwrap()).unwrap();
        assert!(raw.starts_with("# source: lrclib\n"), "получили: {raw}");

        cleanup(&id);
        assert!(!has_local(&id));
    }

    #[test]
    fn lrc_text_is_stored_untouched() {
        let id = test_id("lrc");
        let lrc = "[ar:Кино]\n[00:12.50]Первый куплет\n[00:15.00]Второй";
        save_local(&id, lrc, Some("netease")).unwrap();

        let loaded = load_local(&id).expect("LRC должен читаться");
        assert_eq!(loaded, lrc, "тайминги не должны меняться");
        assert!(has_lrc_timestamps(&loaded));

        cleanup(&id);
    }

    #[test]
    fn save_without_source_writes_text_as_first_line() {
        let id = test_id("nosource");
        save_local(&id, "просто текст", None).unwrap();
        let raw = std::fs::read_to_string(local_path(&id).unwrap()).unwrap();
        assert_eq!(raw, "просто текст");
        assert_eq!(load_local(&id).as_deref(), Some("просто текст"));
        cleanup(&id);
    }

    #[test]
    fn empty_text_is_rejected() {
        let id = test_id("empty");
        assert!(save_local(&id, "", Some("lrclib")).is_err());
        assert!(save_local(&id, "   \n\t ", Some("lrclib")).is_err());
        // Отказ не оставляет после себя файл
        assert!(!has_local(&id));
        cleanup(&id);
    }

    #[test]
    fn missing_file_gives_none_and_remove_is_idempotent() {
        let id = test_id("missing");
        assert_eq!(load_local(&id), None);
        assert!(!has_local(&id));
        // Удаления того, чего нет, — не ошибка
        assert!(remove_local(&id).is_ok());
    }

    #[test]
    fn empty_or_broken_file_gives_none() {
        let empty_id = test_id("broken-empty");
        save_local(&empty_id, "текст", Some("lrclib")).unwrap();
        let path = local_path(&empty_id).unwrap();
        std::fs::write(&path, "").unwrap();
        assert_eq!(load_local(&empty_id), None);

        let comment_id = test_id("broken-comment");
        save_local(&comment_id, "текст", Some("lrclib")).unwrap();
        let path = local_path(&comment_id).unwrap();
        // Осталась только служебная строка — текста нет
        std::fs::write(&path, "# source: lrclib\n\n").unwrap();
        assert_eq!(load_local(&comment_id), None);

        cleanup(&empty_id);
        cleanup(&comment_id);
    }

    #[test]
    fn local_path_stays_inside_lyrics_dir() {
        let dir = lyrics_dir().unwrap();
        // Разделители путей исчезают в имени, а хеш не даёт именам совпасть
        for id in ["../../etc/passwd", "..\\..\\Windows\\System32\\config"] {
            let path = local_path(id).unwrap();
            assert!(path.starts_with(&dir), "путь вышел за папку текстов: {path:?}");
            assert_eq!(path.parent().unwrap(), dir, "получили: {path:?}");
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(name.ends_with(".lrc"), "получили: {name}");
            assert!(
                name.chars().all(|ch| ch.is_ascii_alphanumeric()
                    || ch == '-'
                    || ch == '_'
                    || ch == '.'),
                "в имени остались недопустимые символы: {name}"
            );
            assert_ne!(name, "passwd.lrc", "имя без хеша: {name}");
        }

        // Имя состоит из читаемой части, разделителя и хеша
        let name = local_path("../../etc/passwd")
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(
            name.starts_with(&format!("etc-passwd{ID_SEPARATOR}")),
            "получили: {name}"
        );
    }
}
