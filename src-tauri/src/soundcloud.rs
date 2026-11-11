//! SoundCloud: поиск, прямая ссылка на поток и автоматический client_id.
//!
//! Официальный API SoundCloud требует client_id приложения. Чтобы не заставлять
//! пользователя регистрировать приложение, мы умеем доставать публичный
//! client_id из веб-клиента SoundCloud (то же делают открытые проекты), а поле
//! для своего id остаётся на случай, если автопоиск перестанет работать.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundCloudTrack {
    pub id: String,
    pub title: String,
    pub artists: String,
    pub duration_ms: i64,
    pub cover: Option<String>,
    pub service: String,
    /// Автор разрешил скачивание файла: в интерфейсе это кнопка «Скачать»,
    /// иначе честно предлагаем временную офлайн-копию («Сохранить в кеш»).
    #[serde(default)]
    pub downloadable: bool,
    // --- Популярность трека: по ней сортируем выдачу и показываем подпись
    // в интерфейсе. Поля необязательные: SoundCloud отдаёт их не во всех
    // ответах (например, у части старых лайков), а None в JSON не уходит
    // вовсе — интерфейс тогда просто ничего не показывает.
    /// Сколько раз трек прослушали.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback_count: Option<i64>,
    /// Лайки трека.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub likes_count: Option<i64>,
    /// Репосты (рекомендации в лентах).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reposts_count: Option<i64>,
    /// Комментарии: живой признак живого трека.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_count: Option<i64>,
    /// Подписчики исполнителя.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub followers_count: Option<i64>,
    /// SoundCloud подтвердил аккаунт исполнителя (галочка).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    /// Жанр трека (поле `genre`, иначе первый тег): по нему «Волна» добирает
    /// жанровую порцию. Поле необязательное — у части треков жанра нет.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    /// Дата публикации в формате RFC3339 — как её отдаёт SoundCloud.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// Запрос текста по адресу.
///
/// Основной путь — постоянный HTTP-клиент (`crate::net`): соединения и DNS
/// переиспользуются, поэтому обложки и порции выдачи не платят за новый TLS.
/// Запасной путь — `curl` с DNS over HTTPS: он нужен там, где системный DNS
/// подменяет адрес и постоянный клиент пасует перед сертификатом. Маршрут
/// (напрямую, локальный прокси или авто-гонка) тоже выбирает `crate::net`.
fn get_text(url: &str) -> Result<String, String> {
    let text = crate::net::get_text(url)?;
    if text.trim().is_empty() {
        return Err("пустой ответ от SoundCloud".into());
    }
    Ok(text)
}

fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let text = get_text(url)?;
    serde_json::from_str(&text).map_err(|_| "SoundCloud вернул неожиданный ответ".to_string())
}

/// Достаёт client_id из строки скрипта (32 hex-символа рядом с client_id).
pub fn extract_client_id(script: &str) -> Option<String> {
    for marker in ["client_id:\"", "client_id=\"", "client_id:\"", "\"clientId\":\""] {
        if let Some(position) = script.find(marker) {
            let rest = &script[position + marker.len()..];
            let candidate: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if candidate.len() >= 32 {
                return Some(candidate);
            }
        }
    }
    None
}

/// Публичный client_id веб-клиента SoundCloud: пробуем найти в скриптах страницы.
pub fn discover_client_id() -> Result<String, String> {
    let html = get_text("https://soundcloud.com/")?;

    let mut scripts: Vec<String> = Vec::new();
    for part in html.split("src=\"").skip(1) {
        let url = part.split('"').next().unwrap_or("");
        if url.starts_with("https://a-v2.sndcdn.com/") && url.ends_with(".js") {
            scripts.push(url.to_string());
        }
    }

    for script_url in scripts.iter().take(12) {
        if let Ok(code) = get_text(script_url) {
            if let Some(id) = extract_client_id(&code) {
                return Ok(id);
            }
        }
    }
    Err("Не удалось найти публичный client_id SoundCloud — вставь свой в настройках".into())
}

fn artwork(value: Option<&str>) -> Option<String> {
    value.map(|url| url.replace("-large", "-t500x500"))
}

/// Превращает объект трека из ответа SoundCloud в наш формат.
fn map_track(item: &serde_json::Value) -> SoundCloudTrack {
    SoundCloudTrack {
        id: item.get("id").map(|v| v.to_string()).unwrap_or_default(),
        title: item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Без названия")
            .to_string(),
        artists: item
            .pointer("/user/username")
            .and_then(|v| v.as_str())
            .unwrap_or("SoundCloud")
            .to_string(),
        duration_ms: item.get("duration").and_then(|v| v.as_i64()).unwrap_or(0),
        cover: artwork(item.get("artwork_url").and_then(|value| value.as_str())).or_else(|| {
            // У части треков своей обложки нет — берём аватар автора,
            // чтобы в плеере не было пустой заглушки
            artwork(item.pointer("/user/avatar_url").and_then(|value| value.as_str()))
        }),
        service: "soundcloud".into(),
        downloadable: item
            .get("downloadable")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        // Популярность: чего в ответе нет — то None, и решаем по остальному
        playback_count: number(item.get("playback_count")),
        likes_count: number(item.get("likes_count")),
        reposts_count: number(item.get("reposts_count")),
        comment_count: number(item.get("comment_count")),
        followers_count: number(item.pointer("/user/followers_count")),
        verified: item.pointer("/user/verified").and_then(|value| value.as_bool()),
        genre: text(item.get("genre")).or_else(|| first_tag(item)),
        created_at: item
            .get("created_at")
            .and_then(|value| value.as_str())
            .map(str::to_string),
    }
}

/// Число из ответа SoundCloud: отсутствие поля — это None, а не ноль,
/// чтобы «нет данных» и «честный ноль» не путались.
fn number(value: Option<&serde_json::Value>) -> Option<i64> {
    value.and_then(|value| value.as_i64())
}

/// Первый тег из `tag_list` («"dark phonk" "phonk"»): SoundCloud перечисляет
/// их через пробел, а внутри тега пробел допустим, поэтому в кавычках берём
/// всё до закрывающей кавычки. Нужен, когда поле `genre` пустое.
fn first_tag(item: &serde_json::Value) -> Option<String> {
    let tags = item.get("tag_list").and_then(|value| value.as_str())?.trim();
    if tags.is_empty() {
        return None;
    }
    let tag = match tags.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(""),
        None => tags.split_whitespace().next().unwrap_or(""),
    };
    let tag = tag.trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

// ---------- Чистые функции отбора: мусор, популярность, релевантность ----------

/// Треки короче 20 секунд — это обрывки, отрывки и «сниппеты», а не музыка;
/// длиннее 30 минут в поиске по названию — почти всегда подкаст, микс или
/// чужая вещь с похожим именем.
const MIN_TRACK_MS: i64 = 20_000;
const MAX_TRACK_MS: i64 = 30 * 60 * 1000;

/// Маркер мусорной версии трека.
struct JunkMarker {
    /// Варианты написания, которые ищем в названии и у исполнителя
    /// (уже нормализованные: нижний регистр, слова через пробел).
    phrases: &'static [&'static str],
    /// Слова запроса, при которых маркер считается «запрошенным»:
    /// ищешь «slowed» — значит slowed-версии нужны, и фильтр их не трогает.
    triggers: &'static [&'static str],
}

/// Мусорные версии: «speed up», «slowed», ремиксы, караоке и прочее, что
/// лезет в выдачу вместо самого трека. Жанры (phonk, house, techno и т. п.)
/// здесь намеренно отсутствуют — это музыка, а не мусор.
const JUNK_MARKERS: &[JunkMarker] = &[
    // Ускоренные и замедленные версии
    JunkMarker {
        phrases: &["speed up", "sped up", "spedup", "speedup", "speed up version"],
        triggers: &["speed up", "sped up", "spedup", "speedup"],
    },
    JunkMarker {
        phrases: &["slowed", "super slowed", "slowed down", "slowed reverb", "slowedreverb"],
        triggers: &["slowed", "slowed down", "slowed reverb"],
    },
    // Обработка звука: реверб, 8D, «басы», глухо, «уши режет»
    JunkMarker {
        phrases: &["reverb"],
        triggers: &["reverb"],
    },
    JunkMarker {
        phrases: &["8d", "8d audio"],
        triggers: &["8d", "8d audio"],
    },
    JunkMarker {
        phrases: &["bass boosted", "bassboosted", "bass boost"],
        triggers: &["bass boosted", "bassboosted", "bass boost"],
    },
    JunkMarker {
        phrases: &["muffled"],
        triggers: &["muffled"],
    },
    JunkMarker {
        phrases: &["earrape"],
        triggers: &["earrape"],
    },
    // Приметы «версии для соцсетей»
    JunkMarker {
        phrases: &["nightcore"],
        triggers: &["nightcore"],
    },
    JunkMarker {
        phrases: &["tiktok", "tiktok version", "tiktokversion"],
        triggers: &["tiktok", "tiktok version"],
    },
    // Чужие исполнения и подделки под трек
    JunkMarker {
        phrases: &["karaoke"],
        triggers: &["karaoke"],
    },
    JunkMarker {
        phrases: &["instrumental"],
        triggers: &["instrumental"],
    },
    JunkMarker {
        phrases: &["cover by", "cover version", "coverby"],
        triggers: &["cover", "cover by", "cover version"],
    },
    JunkMarker {
        phrases: &["tribute"],
        triggers: &["tribute"],
    },
    JunkMarker {
        phrases: &["type beat", "typebeat"],
        triggers: &["type beat", "typebeat"],
    },
    JunkMarker {
        phrases: &["remake"],
        triggers: &["remake"],
    },
    JunkMarker {
        phrases: &["flip"],
        triggers: &["flip"],
    },
    JunkMarker {
        phrases: &["mashup", "mash up"],
        triggers: &["mashup", "mash up"],
    },
    JunkMarker {
        phrases: &["edit"],
        triggers: &["edit"],
    },
    // Ремиксы: пользователь обычно ищет сам трек, а не чужую обработку.
    // Если «remix» есть в запросе — фильтр отключается (см. triggers).
    JunkMarker {
        phrases: &["remix"],
        triggers: &["remix"],
    },
    // Явная ошибка вместо трека: SoundCloud так тоже отвечает
    JunkMarker {
        phrases: &["error", "ошибка"],
        triggers: &["error", "ошибка"],
    },
];

/// Нормализует строку для сравнения: нижний регистр, буквы и цифры остаются,
/// любой другой символ — разделитель. «De Jure (Slowed + Reverb)» превращается
/// в «de jure slowed reverb», поэтому «+», скобки и дефисы нам не мешают.
fn normalize(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut separator = false;
    for symbol in text.to_lowercase().chars() {
        if symbol.is_alphanumeric() {
            if separator && !result.is_empty() {
                result.push(' ');
            }
            separator = false;
            result.push(symbol);
        } else {
            separator = true;
        }
    }
    result
}

/// Слова нормализованной строки: сравнение идёт по словам, а не по подстрокам,
/// иначе «slowed» ловило бы «unslowed», а «edit» — «edition».
fn words(text: &str) -> Vec<String> {
    normalize(text).split_whitespace().map(str::to_string).collect()
}

/// Идёт ли фраза в списке слов подряд (с учётом границ слов).
fn contains_phrase(haystack: &[String], phrase: &[String]) -> bool {
    if phrase.is_empty() || phrase.len() > haystack.len() {
        return false;
    }
    haystack.windows(phrase.len()).any(|window| window == phrase)
}

/// Пользователь сам попросил эту версию? Тогда фильтр по этому маркеру
/// отключается: ищешь «remix» — ремиксы нужны.
fn asked_by_query(query: &[String], trigger: &str) -> bool {
    let trigger = words(trigger);
    if trigger.is_empty() || query.is_empty() {
        return false;
    }
    contains_phrase(query, &trigger) || contains_phrase(&trigger, query)
}

/// Мусорная версия трека: «speed up», «slowed + reverb», караоке, ремикс и
/// прочее. Маркер ищем и в названии, и у исполнителя — «Slowed Vibes» это
/// ровно то, что не нужно. Маркеры, которые есть в самом запросе, не считаются
/// мусором: ищешь slowed — получишь slowed.
pub fn is_junk_title(title: &str, artist: &str, query: &str) -> bool {
    let title = words(title);
    let artist = words(artist);
    let query = words(query);

    for marker in JUNK_MARKERS {
        if marker
            .triggers
            .iter()
            .any(|trigger| asked_by_query(&query, trigger))
        {
            continue;
        }
        let junk = marker.phrases.iter().any(|phrase| {
            let phrase = words(phrase);
            contains_phrase(&title, &phrase) || contains_phrase(&artist, &phrase)
        });
        if junk {
            return true;
        }
    }
    false
}

/// Насколько трек популярен: логарифмы, чтобы один трек-миллионник не
/// заслонял всё остальное, но всё же был выше. Прослушивания весят 2,
/// лайки 3, подписчики исполнителя 2, репост 1, галочка — 1.5.
pub fn popularity_score(track: &SoundCloudTrack) -> f64 {
    let count = |value: Option<i64>| value.unwrap_or(0).max(0) as f64;
    (count(track.playback_count) + 1.0).log10() * 2.0
        + (count(track.likes_count) + 1.0).log10() * 3.0
        + (count(track.followers_count) + 1.0).log10() * 2.0
        + if track.verified.unwrap_or(false) { 1.5 } else { 0.0 }
        + (count(track.reposts_count) + 1.0).log10()
}

/// Похоже ли название на то, что искали. Полное совпадение названия — самый
/// высокий балл, вхождение запроса целиком — средний, совпадение по отдельным
/// словам — меньший, совпадение исполнителя — плюс. Лишние слова в названии
/// дают крошечный минус, чтобы «De Jure» стоял выше «De Jure (Live)».
pub fn relevance(track: &SoundCloudTrack, query: &str) -> f64 {
    let query_words = words(query);
    if query_words.is_empty() {
        return 0.0;
    }
    let title_words = words(&track.title);
    let artist_words = words(&track.artists);

    let mut score = 0.0;
    if title_words == query_words {
        score += 6.0;
    } else if contains_phrase(&title_words, &query_words) {
        score += 4.0;
    }

    // Слова запроса, найденные в названии: доля от всех слов запроса
    let hits = query_words
        .iter()
        .filter(|word| title_words.contains(word))
        .count();
    score += 2.0 * (hits as f64) / (query_words.len() as f64);

    if artist_words == query_words {
        score += 3.0;
    } else if contains_phrase(&artist_words, &query_words) {
        score += 2.0;
    } else if query_words.iter().any(|word| artist_words.contains(word)) {
        score += 0.5;
    }

    let extra = title_words.len().saturating_sub(query_words.len()).min(20);
    score - 0.05 * extra as f64
}

/// Длительность правдоподобна? Ноль означает «SoundCloud не сказал» —
/// такие треки не наказываем, иначе легко потерять всю выдачу.
fn duration_is_reasonable(duration_ms: i64) -> bool {
    duration_ms <= 0 || (MIN_TRACK_MS..=MAX_TRACK_MS).contains(&duration_ms)
}

/// Сравнение для выдачи: сначала релевантность, затем популярность.
/// Совпадение по релевантности разрешает популярность, а id делает порядок
/// устойчивым (одинаковые запросы дают одинаковый список).
fn compare_tracks(left: &SoundCloudTrack, right: &SoundCloudTrack, query: &str) -> Ordering {
    relevance(right, query)
        .total_cmp(&relevance(left, query))
        .then_with(|| popularity_score(right).total_cmp(&popularity_score(left)))
        .then_with(|| left.id.cmp(&right.id))
}

/// Отбор и сортировка выдачи: сначала выбрасываем мусорные версии и
/// неправдоподобные по длительности треки, затем ставим наверх релевантные
/// и популярные. Мусор, который пользователь сам попросил (например «remix»),
/// остаётся.
pub fn rank_results(items: Vec<SoundCloudTrack>, query: &str) -> Vec<SoundCloudTrack> {
    let mut ranked: Vec<SoundCloudTrack> = items
        .into_iter()
        .filter(|track| !is_junk_title(&track.title, &track.artists, query))
        .filter(|track| duration_is_reasonable(track.duration_ms))
        .collect();
    ranked.sort_by(|left, right| compare_tracks(left, right, query));
    ranked
}

/// Крайний случай: фильтр выбросил всё. Тогда отдаём что есть, но по
/// популярности — пустой экран хуже, чем неточная выдача.
fn popular_first(items: Vec<SoundCloudTrack>) -> Vec<SoundCloudTrack> {
    let mut list = items;
    list.sort_by(|left, right| {
        popularity_score(right)
            .total_cmp(&popularity_score(left))
            .then_with(|| left.id.cmp(&right.id))
    });
    list
}

// ---------- Сеть ----------

/// Сколько треков просим за раз; если после фильтрации почти ничего не
/// осталось — переспрашиваем шире.
const SEARCH_LIMIT: usize = 20;
const WIDE_SEARCH_LIMIT: usize = 50;
/// Меньше этого числа осмысленных результатов — повод сходить за более
/// широкой выдачей.
const MIN_USEFUL_RESULTS: usize = 5;

fn search_url(client_id: &str, query: &str, limit: usize) -> String {
    format!(
        "https://api-v2.soundcloud.com/search/tracks?q={}&client_id={}&limit={}&app_locale=en",
        urlencode(query),
        urlencode(client_id),
        limit
    )
}

/// Разбор ответа поиска в список треков — без отбора и сортировки.
fn fetch_search(client_id: &str, query: &str, limit: usize) -> Result<Vec<SoundCloudTrack>, String> {
    let body = get_json(&search_url(client_id, query, limit))?;
    let items = body
        .get("collection")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(items.iter().map(map_track).collect())
}

/// Поиск треков: отбираем мусорные версии, сортируем по релевантности и
/// популярности. Если после отбора почти ничего не осталось, просим у
/// SoundCloud 50 результатов и фильтруем ещё раз — так список не оказывается
/// пустым из-за одного строгого правила.
pub fn search(client_id: &str, query: &str) -> Result<Vec<SoundCloudTrack>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }

    let raw = fetch_search(client_id, query, SEARCH_LIMIT)?;
    let ranked = rank_results(raw.clone(), query);
    if ranked.len() >= MIN_USEFUL_RESULTS {
        return Ok(ranked);
    }

    // Отобрали почти всё: спрашиваем шире и пробуем снова
    match fetch_search(client_id, query, WIDE_SEARCH_LIMIT) {
        Ok(wide) => {
            let ranked_wide = rank_results(wide.clone(), query);
            let best = if ranked_wide.len() >= ranked.len() {
                ranked_wide
            } else {
                ranked
            };
            if !best.is_empty() {
                return Ok(best);
            }
            if !wide.is_empty() {
                return Ok(popular_first(wide));
            }
        }
        Err(_) if !ranked.is_empty() => return Ok(ranked),
        Err(_) => {}
    }

    // Совсем ничего осмысленного: честно отдаём исходную выдачу по популярности
    if !raw.is_empty() {
        return Ok(popular_first(raw));
    }
    Ok(Vec::new())
}

/// Ссылка на страницу поиска: `limit` и `offset`, а `linked_partitioning`
/// заставляет SoundCloud вернуть ещё и `next_href` — по нему удобнее идти
/// вглубь выдачи, чем считать смещение самим.
fn search_page_url(client_id: &str, query: &str, limit: usize, offset: usize) -> String {
    format!(
        "https://api-v2.soundcloud.com/search/tracks?q={}&client_id={}&limit={}&offset={}&linked_partitioning=1&app_locale=en",
        urlencode(query),
        urlencode(client_id),
        limit.max(1),
        offset
    )
}

/// Ответ SoundCloud в виде страницы: элементы и курсор следующей страницы.
/// С `linked_partitioning` приходит объект с `collection`/`next_href`, без него —
/// просто массив, поэтому понимаем обе формы.
fn page_of(body: &serde_json::Value) -> (Vec<serde_json::Value>, Option<String>) {
    let items = body
        .get("collection")
        .and_then(|value| value.as_array())
        .cloned()
        .or_else(|| body.as_array().cloned())
        .unwrap_or_default();
    (items, text(body.get("next_href")))
}

/// Абсолютная ссылка из курсора SoundCloud. В `next_href` client_id обычно уже
/// есть, но если его нет — добавляем свой: без него SoundCloud отвечает отказом.
pub fn next_page_url(next_href: &str, client_id: &str) -> String {
    let href = next_href.trim();
    if href.is_empty() || client_id.trim().is_empty() || href.contains("client_id=") {
        return href.to_string();
    }
    let separator = if href.contains('?') { '&' } else { '?' };
    format!("{href}{separator}client_id={}", urlencode(client_id))
}

/// Страница поиска: порция выдачи, отобранная от мусора и отсортированная так
/// же, как первый список. Курсор SoundCloud важнее смещения: если он есть,
/// следующую порцию берём по нему, иначе — по `offset`.
pub fn search_page(
    client_id: &str,
    query: &str,
    limit: usize,
    offset: usize,
    next: Option<&str>,
) -> Result<SoundCloudPage, String> {
    let query = query.trim();
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    if query.is_empty() {
        return Ok(SoundCloudPage {
            tracks: Vec::new(),
            next_href: None,
            has_more: false,
        });
    }

    let url = match next.map(str::trim).filter(|href| !href.is_empty()) {
        Some(href) => next_page_url(href, client_id),
        None => search_page_url(client_id, query, limit, offset),
    };
    let body = get_json(&url)?;
    let (items, next_href) = page_of(&body);

    let mut ranked = rank_results(items.iter().map(map_track).collect(), query);
    if ranked.is_empty() {
        // Фильтр отсеял всю порцию: пустой экран хуже неточной выдачи
        ranked = popular_first(items.iter().map(map_track).collect());
    }

    let has_more = next_href.is_some() || items.len() >= limit.max(1);
    Ok(SoundCloudPage {
        tracks: ranked,
        next_href,
        has_more,
    })
}

/// URL трендов: регион («RU») добавляем только тогда, когда он задан.
fn charts_url(client_id: &str, genre: &str, region: &str) -> String {
    let mut url = format!(
        "https://api-v2.soundcloud.com/charts?kind=trending&genre={}&client_id={}&limit=20",
        urlencode(genre),
        urlencode(client_id)
    );
    if !region.trim().is_empty() {
        url.push_str(&format!("&region={}", urlencode(region)));
    }
    url
}

/// Разбирает ответ трендов: каждый элемент — обёртка с полем track.
fn fetch_charts(url: &str) -> Result<Vec<SoundCloudTrack>, String> {
    let body = get_json(url)?;
    let items = body
        .get("collection")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .filter_map(|item| item.get("track"))
        .map(map_track)
        .collect())
}

/// Тренды SoundCloud: то, что сервис сам продвигает сейчас.
/// Жанр по умолчанию — вся музыка; остальные: electronic, hiphoprap, rock.
/// Регион («RU») включает местные тренды. Если по региону не пришло ничего
/// или запрос с ним не прошёл, отдаём общий список по тому же жанру, чтобы
/// раздел не оставался пустым.
pub fn charts(client_id: &str, genre: &str, region: &str) -> Result<Vec<SoundCloudTrack>, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }

    let genre = if genre.trim().is_empty() {
        "soundcloud:genres:all-music"
    } else {
        genre
    };
    let region = region.trim().to_uppercase();

    if region.is_empty() {
        return fetch_charts(&charts_url(client_id, genre, ""));
    }

    match fetch_charts(&charts_url(client_id, genre, &region)) {
        Ok(tracks) if tracks.is_empty() => fetch_charts(&charts_url(client_id, genre, "")),
        // Регион не поддержан: пробуем без него, но исходную ошибку не теряем
        Err(region_error) => {
            fetch_charts(&charts_url(client_id, genre, "")).map_err(|_| region_error)
        }
        Ok(tracks) => Ok(tracks),
    }
}

/// Режет список id на пачки длиной не больше size: эндпоинт `tracks?ids=`
/// принимает примерно до 50 идентификаторов за раз. Нулевой размер
/// приравниваем к единице, чтобы не зациклиться на пустых пачках.
fn chunk_ids(ids: &[String], size: usize) -> Vec<Vec<String>> {
    ids.chunks(size.max(1)).map(|chunk| chunk.to_vec()).collect()
}

/// Треки по списку идентификаторов: SoundCloud отдаёт их одним запросом
/// `tracks?ids=<id1,id2,...>`, а мы, если id больше 50, ходим пачками и
/// склеиваем ответы. Нужно, чтобы догрузить названия, исполнителей и
/// обложки старых лайков, у которых сохранён только идентификатор.
pub fn tracks_by_ids(client_id: &str, ids: &[String]) -> Result<Vec<SoundCloudTrack>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }

    const BATCH: usize = 50;
    let mut tracks = Vec::new();
    for chunk in chunk_ids(ids, BATCH) {
        let url = format!(
            "https://api-v2.soundcloud.com/tracks?ids={}&client_id={}",
            chunk.join(","),
            urlencode(client_id)
        );
        let body = get_json(&url)?;
        // Ответ — массив треков; удалённые приходят как null, их пропускаем
        let items = body.as_array().cloned().unwrap_or_default();
        tracks.extend(items.iter().filter(|item| item.is_object()).map(map_track));
    }
    Ok(tracks)
}

// ---------- Артист: профиль и его треки ----------

/// Профиль артиста SoundCloud — то, что показывает окно артиста.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundCloudUser {
    pub id: String,
    /// Ник артиста.
    pub username: String,
    pub full_name: Option<String>,
    pub avatar_url: Option<String>,
    pub banner_url: Option<String>,
    /// Био: в интерфейсе сворачивается, если длинное.
    pub description: Option<String>,
    /// Постоянная ссылка (последняя часть адреса страницы).
    pub permalink: Option<String>,
    pub permalink_url: Option<String>,
    pub followers_count: Option<i64>,
    pub followings_count: Option<i64>,
    pub track_count: Option<i64>,
    pub playlist_count: Option<i64>,
    pub likes_count: Option<i64>,
    pub city: Option<String>,
    pub country_code: Option<String>,
    pub verified: Option<bool>,
}

/// Страница списка от SoundCloud: треки, курсор следующей страницы и признак
/// «дальше ещё есть». Одна форма и для поиска, и для треков артиста.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundCloudPage {
    pub tracks: Vec<SoundCloudTrack>,
    /// Курсор следующей страницы (`next_href`), если SoundCloud его отдал.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_href: Option<String>,
    /// Сервис отдал полную порцию — значит, дальше почти наверняка есть ещё.
    pub has_more: bool,
}

/// Непустая строка из ответа SoundCloud: пробелы и пустое значение — это None.
fn text(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Аватар в крупном размере: SoundCloud отдаёт уменьшенные копии
/// (`…-large.jpg`, `…-crop.jpg`), а в шапке окна артиста нужен размер побольше.
fn avatar(value: Option<&str>) -> Option<String> {
    const SIZES: [&str; 6] = ["-large", "-t50x50", "-crop", "-mini", "-small", "-tiny"];
    value.map(|url| {
        for size in SIZES {
            if url.contains(size) {
                return url.replace(size, "-t500x500");
            }
        }
        url.to_string()
    })
}

/// Баннер профиля: SoundCloud кладёт его либо в `banner_url`, либо в `visuals`.
fn banner_of(value: &serde_json::Value) -> Option<String> {
    text(value.get("banner_url")).or_else(|| text(value.pointer("/visuals/visuals/0/visual_url")))
}

/// Разбор профиля артиста. Отдельная функция — её проверяют офлайн-тесты.
pub fn parse_user(value: &serde_json::Value) -> SoundCloudUser {
    SoundCloudUser {
        id: value.get("id").map(|value| value.to_string()).unwrap_or_default(),
        username: text(value.get("username")).unwrap_or_else(|| "SoundCloud".into()),
        full_name: text(value.get("full_name")),
        avatar_url: avatar(value.get("avatar_url").and_then(|value| value.as_str())),
        banner_url: banner_of(value),
        description: text(value.get("description")),
        permalink: text(value.get("permalink")),
        permalink_url: text(value.get("permalink_url")),
        followers_count: number(value.get("followers_count")),
        followings_count: number(value.get("followings_count")),
        track_count: number(value.get("track_count")),
        playlist_count: number(value.get("playlist_count")),
        likes_count: number(value.get("likes_count")),
        city: text(value.get("city")),
        // Поле страны SoundCloud называет по-разному в разных ответах
        country_code: text(value.get("country_code")).or_else(|| text(value.get("country"))),
        verified: value.get("verified").and_then(|value| value.as_bool()),
    }
}

/// Идентификатор пользователя — число: по нему ходим в API напрямую.
fn is_user_id(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|symbol| symbol.is_ascii_digit())
}

/// Похоже на адрес страницы SoundCloud, а не на ник.
fn looks_like_url(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.contains("soundcloud.com")
}

/// Ссылка на профиль: числовой id — прямо в API, ник или адрес — через resolve.
pub fn user_url(client_id: &str, user_id_or_permalink: &str) -> String {
    let target = user_id_or_permalink.trim();
    if is_user_id(target) {
        return format!(
            "https://api-v2.soundcloud.com/users/{}?client_id={}",
            urlencode(target),
            urlencode(client_id)
        );
    }
    let page = if looks_like_url(target) {
        target.to_string()
    } else {
        format!("https://soundcloud.com/{}", urlencode(target))
    };
    format!(
        "https://api-v2.soundcloud.com/resolve?url={}&client_id={}",
        urlencode(&page),
        urlencode(client_id)
    )
}

/// Поиск людей: нужен, когда артист пришёл ником, а не постоянной ссылкой.
pub fn users_search_url(client_id: &str, query: &str, limit: u32) -> String {
    format!(
        "https://api-v2.soundcloud.com/search/users?q={}&client_id={}&limit={}",
        urlencode(query),
        urlencode(client_id),
        limit.max(1)
    )
}

/// Первый подходящий человек из ответа поиска: сначала точное совпадение по
/// нику или постоянной ссылке, иначе — первый в выдаче (SoundCloud уже
/// отсортировал её по популярности).
fn best_user(body: &serde_json::Value, wanted: &str) -> Option<serde_json::Value> {
    let items = body.get("collection").and_then(|value| value.as_array())?;
    let wanted = wanted.trim().to_lowercase();
    let same = |value: &serde_json::Value, field: &str| {
        text(value.get(field)).map_or(false, |text| text.to_lowercase() == wanted)
    };
    items
        .iter()
        .find(|item| same(item, "permalink") || same(item, "username"))
        .or_else(|| items.first())
        .cloned()
}

/// Профиль артиста: числовой id, постоянная ссылка или ник.
pub fn user(client_id: &str, user_id_or_permalink: &str) -> Result<serde_json::Value, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    let target = user_id_or_permalink.trim();
    if target.is_empty() {
        return Err("Не указан артист SoundCloud".into());
    }

    // Точный адрес: id или ссылка — resolve тут не нужен
    if is_user_id(target) || looks_like_url(target) {
        return get_json(&user_url(client_id, target));
    }

    // Ник: сначала постоянная ссылка (если ник совпал с permalink), затем поиск
    if let Ok(value) = get_json(&user_url(client_id, target)) {
        return Ok(value);
    }
    let found = get_json(&users_search_url(client_id, target, 10))?;
    best_user(&found, target).ok_or_else(|| format!("Артист «{target}» не найден в SoundCloud"))
}

/// Ссылка на треки артиста: порциями по `limit` с пропуском `offset`.
fn user_tracks_url(client_id: &str, user_id: &str, limit: u32, offset: u32) -> String {
    format!(
        "https://api-v2.soundcloud.com/users/{}/tracks?client_id={}&limit={}&offset={}&linked_partitioning=1",
        urlencode(user_id.trim()),
        urlencode(client_id),
        limit.max(1),
        offset
    )
}

/// Треки артиста как их отдаёт SoundCloud: порция по `limit` с пропуском
/// `offset`. Отбора и сортировки тут нет — в списке артиста всё его.
pub fn user_tracks(
    client_id: &str,
    user_id: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<serde_json::Value>, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    if user_id.trim().is_empty() {
        return Err("Не указан артист SoundCloud".into());
    }
    let body = get_json(&user_tracks_url(client_id, user_id, limit, offset))?;
    Ok(page_of(&body).0)
}

/// Разобранные треки артиста для интерфейса: одна порция по `limit`/`offset`.
/// Интерфейс ходит за следующими порциями сам, наращивая `offset`: список
/// загруженного не теряется при переключении страниц.
pub fn user_tracks_page(
    client_id: &str,
    user_id: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<SoundCloudTrack>, String> {
    let items = user_tracks(client_id, user_id, limit, offset)?;
    Ok(items
        .iter()
        .filter(|item| item.is_object())
        .map(map_track)
        .collect())
}

// ---------- Wave: похожие треки ----------

/// Ссылка на «похожие» треки: до `limit` штук за один запрос.
fn related_url(client_id: &str, track_id: &str, limit: u32) -> String {
    format!(
        "https://api-v2.soundcloud.com/tracks/{}/related?client_id={}&limit={}",
        urlencode(track_id.trim()),
        urlencode(client_id),
        limit.max(1)
    )
}

/// Ссылка на треки артиста — запасной путь Wave, когда «похожих» нет.
fn artist_top_url(client_id: &str, user_id: &str, limit: u32) -> String {
    format!(
        "https://api-v2.soundcloud.com/users/{}/tracks?client_id={}&limit={}",
        urlencode(user_id.trim()),
        urlencode(client_id),
        limit.max(1)
    )
}

/// Элементы ответа: массив или объект с `collection` (так отвечают related и
/// треки артиста). Всё остальное — неожиданный ответ, а не «пусто».
fn track_items(body: &serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    if let Some(items) = body.as_array() {
        return Ok(items.clone());
    }
    if let Some(items) = body.get("collection").and_then(|value| value.as_array()) {
        return Ok(items.clone());
    }
    Err("SoundCloud вернул неожиданный ответ".into())
}

/// Разбор порции Wave: только стримабельные, без мусорных версий и дублей,
/// популярные выше. Чистая функция — проверяется тестами без сети.
fn parse_wave_tracks(body: &serde_json::Value) -> Result<Vec<SoundCloudTrack>, String> {
    let items = track_items(body)?;
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();
    for item in items.iter() {
        if !item.is_object() {
            continue;
        }
        let track = map_track(item);
        if track.id.trim().is_empty() || !seen.insert(track.id.clone()) {
            continue;
        }
        // SoundCloud отдал streamable:false — трек не играет, в радио не берём
        if item.get("streamable").and_then(|value| value.as_bool()) == Some(false) {
            continue;
        }
        if !duration_is_reasonable(track.duration_ms) {
            continue;
        }
        if is_junk_title(&track.title, &track.artists, "") {
            continue;
        }
        tracks.push(track);
    }
    Ok(popular_first(tracks))
}

/// Пора идти за треками артиста: только когда related не дал ничего.
pub fn needs_artist_fallback(related: &[SoundCloudTrack]) -> bool {
    related.is_empty()
}

/// Похожие треки: `GET /tracks/<id>/related`. Сам трек из порции убираем —
/// в очереди он уже играет.
pub fn related(client_id: &str, track_id: &str, limit: u32) -> Result<Vec<SoundCloudTrack>, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    if track_id.trim().is_empty() {
        return Err("Не указан трек SoundCloud".into());
    }
    let body = get_json(&related_url(client_id, track_id, limit))?;
    let mut tracks = parse_wave_tracks(&body)?;
    tracks.retain(|track| track.id != track_id.trim());
    tracks.truncate(limit.max(1) as usize);
    Ok(tracks)
}

/// Запасной путь Wave: верхние треки артиста, только стримабельные.
/// `user_id` — числовой id, ник или адрес страницы: ник и адрес разрешаем
/// тем же поиском, что и окно артиста.
pub fn artist_top(
    client_id: &str,
    user_id: &str,
    limit: u32,
) -> Result<Vec<SoundCloudTrack>, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    let target = user_id.trim();
    if target.is_empty() {
        return Err("Не указан артист SoundCloud".into());
    }
    let id = if target.chars().all(|c| c.is_ascii_digit()) {
        target.to_string()
    } else {
        let value = user(client_id, target)?;
        value
            .get("id")
            .map(|id| id.to_string())
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| format!("Артист «{target}» не найден в SoundCloud"))?
    };
    let body = get_json(&artist_top_url(client_id, &id, limit))?;
    let mut tracks = parse_wave_tracks(&body)?;
    tracks.truncate(limit.max(1) as usize);
    Ok(tracks)
}

// ---------- Разнообразие волны: жанр и похожие артисты ----------

/// Жанр из id вида `soundcloud:genres:phonk`: API ждёт само название,
/// а идентификатор из чартов ему не подходит.
fn genre_slug(genre: &str) -> String {
    let trimmed = genre.trim();
    trimmed
        .strip_prefix("soundcloud:genres:")
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

/// Ссылка на треки жанра: `tracks?genres=…&limit=…&linked_partitioning=1`.
fn genre_tracks_url(client_id: &str, genre: &str, limit: u32) -> String {
    format!(
        "https://api-v2.soundcloud.com/tracks?genres={}&client_id={}&limit={}&linked_partitioning=1",
        urlencode(&genre_slug(genre)),
        urlencode(client_id),
        limit.max(1)
    )
}

/// Треки жанра — третий источник порции «Волны». Разбор и фильтры те же, что
/// у похожих треков: только стримабельное, без мусорных версий и дублей.
pub fn genre_tracks(
    client_id: &str,
    genre: &str,
    limit: u32,
) -> Result<Vec<SoundCloudTrack>, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    if genre_slug(genre).is_empty() {
        // Жанр неизвестен — не идём в сеть за «всё подряд»
        return Ok(Vec::new());
    }
    let body = get_json(&genre_tracks_url(client_id, genre, limit))?;
    let mut tracks = parse_wave_tracks(&body)?;
    tracks.truncate(limit.max(1) as usize);
    Ok(tracks)
}

/// Похожие артисты: `/users/<id>/related`.
fn related_artists_url(client_id: &str, user_id: &str, limit: u32) -> String {
    format!(
        "https://api-v2.soundcloud.com/users/{}/related?client_id={}&limit={}&linked_partitioning=1",
        urlencode(user_id.trim()),
        urlencode(client_id),
        limit.max(1)
    )
}

/// Запасной путь: на кого подписан артист. Оттуда берём лишь пару треков,
/// поэтому и лимит небольшой.
fn following_artists_url(client_id: &str, user_id: &str, limit: u32) -> String {
    format!(
        "https://api-v2.soundcloud.com/users/{}/followings?client_id={}&limit={}&linked_partitioning=1",
        urlencode(user_id.trim()),
        urlencode(client_id),
        limit.max(1)
    )
}

/// Разбор списка артистов: массив пользователей, объект с `collection` или
/// элементы-обёртки с полем `user`. Всё остальное (404, пустой ответ, мусор) —
/// честная пустота, а не ошибка: без похожих артистов волна просто доберёт
/// треки из других источников.
fn parse_related_users(body: &serde_json::Value) -> Vec<SoundCloudUser> {
    let items = match body.as_array() {
        Some(items) => items.clone(),
        None => body
            .get("collection")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default(),
    };
    let mut seen = HashSet::new();
    let mut users = Vec::new();
    for item in items.iter() {
        let user = item.get("user").filter(|value| value.is_object()).unwrap_or(item);
        if !user.is_object() {
            continue;
        }
        let parsed = parse_user(user);
        let has_id = parsed.id != "null"
            && parsed.id != "0"
            && !parsed.id.trim().is_empty();
        if !has_id || !seen.insert(parsed.id.clone()) {
            continue;
        }
        users.push(parsed);
    }
    users
}

/// Похожие артисты вокруг трека. `related` может ответить 404 — это не сбой,
/// а повод взять артистов из `followings`. Если не ответил никто, возвращаем
/// пустой список: волна доберёт треки из других источников.
pub fn related_artists(
    client_id: &str,
    user_id: &str,
    limit: u32,
) -> Result<Vec<SoundCloudUser>, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    if user_id.trim().is_empty() {
        return Err("Не указан артист SoundCloud".into());
    }
    let limit = limit.max(1) as usize;

    let mut users = match get_json(&related_artists_url(client_id, user_id, limit as u32)) {
        Ok(body) => parse_related_users(&body),
        // 404 и прочие отказы endpoint'а — не ошибка волны
        Err(_) => Vec::new(),
    };
    if users.is_empty() {
        if let Ok(body) = get_json(&following_artists_url(client_id, user_id, limit as u32)) {
            users = parse_related_users(&body);
        }
    }
    users.truncate(limit);
    Ok(users)
}

/// Постоянный адрес страницы трека: `https://soundcloud.com/автор/трек`.
/// Нужен запасному пути сохранения (`external_download`): внешний сервис
/// принимает именно адрес трека, а голый числовой идентификатор понимает как
/// поисковую строку и возвращает чужие треки (проверено: «293» дал 50
/// посторонних записей со словом 293 в названии).
pub fn permalink(client_id: &str, track_id: &str) -> Result<String, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    let url = format!(
        "https://api-v2.soundcloud.com/tracks/{}?client_id={}",
        urlencode(track_id),
        urlencode(client_id)
    );
    let body = get_json(&url)?;
    permalink_of(&body).ok_or_else(|| "SoundCloud не отдал адрес страницы трека".to_string())
}

/// Адрес страницы из ответа SoundCloud. Отдельной функцией — чтобы проверять
/// разбор без сети.
fn permalink_of(body: &serde_json::Value) -> Option<String> {
    body.get("permalink_url")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Выбирает прогрессивную дорожку из списка транскодингов.
pub fn pick_progressive(transcodings: &[serde_json::Value]) -> Option<String> {
    let progressive = transcodings.iter().find(|item| {
        item.get("protocol").and_then(|v| v.as_str()) == Some("progressive")
    });
    progressive
        .or_else(|| transcodings.first())
        .and_then(|item| item.get("url"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Прямая ссылка на mp3-поток трека.
pub fn stream_url(client_id: &str, track_id: &str) -> Result<String, String> {
    let info_url = format!(
        "https://api-v2.soundcloud.com/tracks/{}?client_id={}",
        urlencode(track_id),
        urlencode(client_id)
    );
    let body = get_json(&info_url)?;
    let transcodings = body
        .pointer("/media/transcodings")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| "SoundCloud не отдал дорожки для этого трека".to_string())?;

    // Прогрессивную дорожку предпочитаем, но если её нет — отдаём HLS-ссылку
    // (её играет hls.js в интерфейсе), а не отказываем пользователю.
    let transcoding = pick_progressive(&transcodings)
        .ok_or_else(|| "Нет подходящей дорожки".to_string())?;

    let separator = if transcoding.contains('?') { '&' } else { '?' };
    let stream = get_json(&format!("{transcoding}{separator}client_id={}", urlencode(client_id)))?;
    stream
        .get("url")
        .and_then(|v| v.as_str())
        .map(|url| url.to_string())
        .ok_or_else(|| "SoundCloud не вернул ссылку на поток".to_string())
}

/// Предзагрузка следующего трека очереди: ссылка на поток добывается заранее,
/// а соединение с сервером потока прогревается (DNS, TCP, TLS), чтобы первый
/// звук не ждал рукопожатия. Ошибка предзагрузки ничего не ломает: когда трек
/// действительно попросят играть, плеер спросит ссылку сам.
pub fn prefetch(client_id: &str, track_id: &str) -> Result<String, String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }
    if track_id.trim().is_empty() {
        return Err("Не указан трек SoundCloud".into());
    }
    let url = stream_url(client_id, track_id)?;
    crate::net::warm(&url);
    Ok(url)
}

/// Разбор ответа SoundCloud о треке: (разрешено ли скачивание, download_url).
/// Отдельная функция — её проверяет тест, сети для этого не нужно.
/// Ссылки нет — считаем, что скачать нечего: обещать скачивание нельзя.
pub fn describe_download(track: &serde_json::Value) -> (bool, Option<String>) {
    let downloadable = track
        .get("downloadable")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !downloadable {
        return (false, None);
    }

    match track
        .get("download_url")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        Some(url) => (true, Some(url.to_string())),
        None => (false, None),
    }
}

/// Ответ на запрос download_url — объект с прямой ссылкой на файл,
/// ровно как у stream_url: ссылку отдаёт отдельное поле `url`.
fn parse_file_url(body: &serde_json::Value) -> Option<String> {
    body.get("url")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
}

/// Скачивание исходного файла трека: `(разрешено, ссылка на файл)`.
///
/// SoundCloud отдаёт прямую ссылку только тем трекам, где автор разрешил
/// скачивание: сначала читаем объект трека (`downloadable`, `download_url`),
/// затем отдельным запросом (как со stream_url) получаем саму ссылку.
/// Если автор запретил — честно возвращаем `(false, None)`, и интерфейс
/// предложит временную офлайн-копию в кеш.
pub fn download_info(client_id: &str, track_id: &str) -> Result<(bool, Option<String>), String> {
    if client_id.trim().is_empty() {
        return Err("SoundCloud не подключён: нужен client_id".into());
    }

    let info_url = format!(
        "https://api-v2.soundcloud.com/tracks/{}?client_id={}",
        urlencode(track_id),
        urlencode(client_id)
    );
    let body = get_json(&info_url)?;
    let (allowed, download_url) = describe_download(&body);
    let Some(download_url) = download_url.filter(|_| allowed) else {
        return Ok((false, None));
    };

    let separator = if download_url.contains('?') { '&' } else { '?' };
    let resolved = get_json(&format!(
        "{download_url}{separator}client_id={}",
        urlencode(client_id)
    ))?;
    let url = parse_file_url(&resolved);

    // Ссылки не оказалось — скачивание фактически недоступно
    Ok((url.is_some(), url))
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_id_is_extracted_from_script() {
        let script = r#"var x={client_id:"a1b2c3d4e5f60718293a4b5c6d7e8f90",y:1};"#;
        assert_eq!(
            extract_client_id(script).as_deref(),
            Some("a1b2c3d4e5f60718293a4b5c6d7e8f90")
        );
        assert_eq!(extract_client_id("нет тут ничего"), None);
        // Слишком короткое значение не принимаем
        assert_eq!(extract_client_id(r#"client_id:"short""#), None);
    }

    #[test]
    fn progressive_transcoding_is_preferred() {
        let transcodings = serde_json::json!([
            { "protocol": "hls", "url": "https://example.com/hls" },
            { "protocol": "progressive", "url": "https://example.com/mp3" }
        ]);
        let list = transcodings.as_array().unwrap().clone();
        assert_eq!(pick_progressive(&list).as_deref(), Some("https://example.com/mp3"));
    }

    #[test]
    fn empty_query_returns_nothing() {
        assert!(search("client", "  ").unwrap().is_empty());
    }

    #[test]
    fn missing_client_id_is_reported() {
        let error = search("", "track").unwrap_err();
        assert!(error.contains("client_id"), "получили: {error}");
    }

    #[test]
    fn charts_reports_missing_client_id() {
        let error = charts("", "", "").unwrap_err();
        assert!(error.contains("client_id"), "получили: {error}");
    }

    #[test]
    fn charts_url_adds_region_only_when_asked() {
        let world = charts_url("cid", "soundcloud:genres:all-music", "");
        assert!(world.contains("kind=trending"));
        assert!(world.contains("limit=20"));
        assert!(!world.contains("region="), "получили: {world}");

        let russian = charts_url("cid", "soundcloud:genres:rock", "RU");
        assert!(russian.contains("&region=RU"), "получили: {russian}");
    }

    #[test]
    fn ids_are_split_into_batches() {
        let ids: Vec<String> = (1..=120).map(|n| n.to_string()).collect();
        let batches = chunk_ids(&ids, 50);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].len(), 50);
        assert_eq!(batches[1].len(), 50);
        assert_eq!(batches[2].len(), 20);
        // Порядок не теряется
        assert_eq!(batches[0][0], "1");
        assert_eq!(batches[1][0], "51");
        assert_eq!(batches[2][19], "120");
        // Ровно одна пачка — один запрос, пустой список — ни одной
        assert_eq!(chunk_ids(&["7".to_string()], 50).len(), 1);
        assert!(chunk_ids(&[], 50).is_empty());
        // Нулевой размер не должен приводить к бесконечному циклу
        assert_eq!(chunk_ids(&["1".to_string(), "2".to_string()], 0).len(), 2);
    }

    #[test]
    fn tracks_by_ids_skips_network_without_ids() {
        assert!(tracks_by_ids("client", &[]).unwrap().is_empty());
    }

    #[test]
    fn tracks_by_ids_reports_missing_client_id() {
        let error = tracks_by_ids("", &["1".to_string()]).unwrap_err();
        assert!(error.contains("client_id"), "получили: {error}");
    }

    #[test]
    fn artwork_gets_bigger_size() {
        assert_eq!(
            artwork(Some("https://i1.sndcdn.com/artworks-abc-large.jpg")).as_deref(),
            Some("https://i1.sndcdn.com/artworks-abc-t500x500.jpg")
        );
        assert_eq!(artwork(None), None);
    }

    #[test]
    fn download_is_allowed_only_with_flag_and_link() {
        let allowed = serde_json::json!({
            "downloadable": true,
            "download_url": "https://api-v2.soundcloud.com/tracks/1/download"
        });
        assert_eq!(
            describe_download(&allowed),
            (true, Some("https://api-v2.soundcloud.com/tracks/1/download".to_string()))
        );

        // Автор запретил скачивание — пары с ссылкой быть не должно
        let denied = serde_json::json!({
            "downloadable": false,
            "download_url": "https://api-v2.soundcloud.com/tracks/1/download"
        });
        assert_eq!(describe_download(&denied), (false, None));

        // Флага нет вовсе (например, часть ответов чартов) — тоже нельзя
        assert_eq!(describe_download(&serde_json::json!({ "id": 1 })), (false, None));
        // Флаг стоит, а ссылки нет: скачивать нечего, обещать не будем
        assert_eq!(
            describe_download(&serde_json::json!({ "downloadable": true })),
            (false, None)
        );
        assert_eq!(
            describe_download(&serde_json::json!({ "downloadable": true, "download_url": "   " })),
            (false, None)
        );
    }

    #[test]
    fn track_page_address_comes_from_permalink_url() {
        let answer = serde_json::json!({ "permalink_url": "https://soundcloud.com/forss/flickermood" });
        assert_eq!(
            permalink_of(&answer).as_deref(),
            Some("https://soundcloud.com/forss/flickermood")
        );
        // Пустой адрес или его отсутствие — не битая ссылка, а честный отказ
        assert_eq!(permalink_of(&serde_json::json!({ "permalink_url": "   " })), None);
        assert_eq!(permalink_of(&serde_json::json!({ "id": 293 })), None);
    }

    #[test]
    fn direct_file_link_comes_from_url_field() {
        let answer = serde_json::json!({ "url": "https://cf-media.sndcdn.com/track.mp3?x=1" });
        assert_eq!(
            parse_file_url(&answer).as_deref(),
            Some("https://cf-media.sndcdn.com/track.mp3?x=1")
        );
        // Пустой или неподходящий ответ не превращается в битую ссылку
        assert_eq!(parse_file_url(&serde_json::json!({ "url": "" })), None);
        assert_eq!(parse_file_url(&serde_json::json!({ "error": "not found" })), None);
    }

    #[test]
    fn prefetch_refuses_bad_input_before_network() {
        // Следующий трек без id — не ошибка плеера: просто нечего предзагружать
        assert!(prefetch("", "1").unwrap_err().contains("client_id"));
        assert!(prefetch("cid", "   ").unwrap_err().contains("трек"));
    }

    #[test]
    fn empty_client_id_breaks_download_info() {
        let error = download_info("", "1").unwrap_err();
        assert!(error.contains("client_id"), "получили: {error}");
    }

    #[test]
    fn track_flag_is_mapped_for_the_interface() {
        let item = serde_json::json!({
            "id": 7,
            "title": "Трек",
            "downloadable": true,
            "duration": 1000
        });
        assert!(map_track(&item).downloadable);
        assert!(!map_track(&serde_json::json!({ "id": 8 })).downloadable);
    }

    // ---------- Отбор мусора, популярность и релевантность ----------

    /// Трек для тестов: длительность нормальная, популярность задаётся числом.
    fn track(title: &str, artist: &str, playback: i64, verified: bool) -> SoundCloudTrack {
        SoundCloudTrack {
            id: title.to_string(),
            title: title.to_string(),
            artists: artist.to_string(),
            duration_ms: 200_000,
            cover: None,
            service: "soundcloud".into(),
            downloadable: false,
            playback_count: Some(playback),
            likes_count: Some(playback / 10),
            reposts_count: Some(playback / 100),
            comment_count: Some(playback / 100),
            followers_count: Some(playback / 5),
            verified: Some(verified),
            genre: None,
            created_at: None,
        }
    }

    #[test]
    fn junk_versions_are_cut_out() {
        let junk = [
            "De Jure (Speed Up)",
            "De Jure (sped up)",
            "De Jure - Slowed + Reverb",
            "De Jure (Super Slowed)",
            "De Jure (Slowed Down)",
            "De Jure (Reverb)",
            "De Jure (Nightcore)",
            "De Jure [8D Audio]",
            "De Jure (Bass Boosted)",
            "De Jure (Muffled)",
            "De Jure (Earrape)",
            "De Jure (TikTok Version)",
            "De Jure (Karaoke)",
            "De Jure (Instrumental)",
            "De Jure Cover by Someone",
            "De Jure (Tribute)",
            "De Jure Type Beat",
            "De Jure (Remake)",
            "De Jure (Flip)",
            "De Jure (Mashup)",
            "De Jure (Edit)",
            "De Jure (Remix)",
            "De Jure (Phonk Remix)",
            "error",
            "Ошибка",
        ];
        for title in junk {
            assert!(
                is_junk_title(title, "Кто-то", "de jure"),
                "не отсекли мусор: {title}"
            );
        }
    }

    #[test]
    fn real_titles_and_genres_survive_the_filter() {
        let fine = [
            "De Jure",
            "De Jure (Live)",
            "De Jure (Original Mix)",
            "De Jure (Phonk)",
            "Phonk",
            "Phonk Beat",
            "Unslowed Memories",
            "Edition",
            "Flipped",
            "Reverberation",
            "Super Bass",
        ];
        for title in fine {
            assert!(
                !is_junk_title(title, "Обычный исполнитель", "de jure"),
                "зря отсекли: {title}"
            );
        }
    }

    #[test]
    fn junk_artist_names_are_cut_too() {
        assert!(is_junk_title("De Jure", "Nightcore Dreams", "de jure"));
        assert!(is_junk_title("De Jure", "Slowed Vibes", "de jure"));
        assert!(!is_junk_title("De Jure", "Обычный исполнитель", "de jure"));
    }

    #[test]
    fn markers_respect_word_boundaries() {
        assert!(!is_junk_title("Unslowed", "X", "de jure"));
        assert!(!is_junk_title("Edition", "X", "de jure"));
        assert!(!is_junk_title("Flipped", "X", "de jure"));
        // Слитные написания версий отсекаем всё равно
        assert!(is_junk_title("De Jure (SlowedReverb)", "X", "de jure"));
        assert!(is_junk_title("De Jure (SpedUp)", "X", "de jure"));
    }

    #[test]
    fn what_the_user_asked_for_is_not_junk() {
        // Ищешь slowed — slowed-версии нужны
        assert!(!is_junk_title("De Jure (Slowed)", "DJ", "slowed de jure"));
        assert!(!is_junk_title("De Jure (Sped Up)", "DJ", "sped up"));
        assert!(!is_junk_title("De Jure (Remix)", "DJ", "de jure remix"));
        assert!(!is_junk_title("De Jure (Instrumental)", "DJ", "instrumental"));
        assert!(!is_junk_title("De Jure (8D Audio)", "DJ", "8d audio"));
        assert!(!is_junk_title("Error", "DJ", "error"));
        // А без такого запроса это мусор
        assert!(is_junk_title("De Jure (Slowed)", "DJ", "de jure"));
        assert!(is_junk_title("De Jure (Remix)", "DJ", "de jure"));
        assert!(is_junk_title("Error", "DJ", "de jure"));
    }

    #[test]
    fn popularity_grows_with_numbers_and_the_verified_badge() {
        let zero = track("Zero", "X", 0, false);
        let small = track("Small", "X", 100, false);
        let big = track("Big", "X", 1_000_000, false);
        let verified = track("Verified", "X", 1_000_000, true);
        assert!(popularity_score(&big) > popularity_score(&small));
        assert!(popularity_score(&small) > popularity_score(&zero));
        assert!(popularity_score(&verified) > popularity_score(&big));

        // Нет данных — считаем как честный ноль, а не хуже него
        let mut missing = track("Missing", "X", 0, false);
        missing.playback_count = None;
        missing.likes_count = None;
        missing.reposts_count = None;
        missing.comment_count = None;
        missing.followers_count = None;
        missing.verified = None;
        assert_eq!(popularity_score(&missing), popularity_score(&zero));
    }

    #[test]
    fn relevance_prefers_exact_titles_and_popular_artists() {
        let exact = track("De Jure", "Люди", 1, false);
        let inside = track("De Jure (Live)", "Люди", 1, false);
        let by_artist = track("Something Else", "De Jure", 1, false);
        let other = track("Совсем другое", "Кто-то", 1, false);

        assert!(relevance(&exact, "de jure") > relevance(&inside, "de jure"));
        assert!(relevance(&inside, "de jure") > relevance(&other, "de jure"));
        assert!(relevance(&by_artist, "de jure") > relevance(&other, "de jure"));
        // Регистр и лишние пробелы не важны
        assert_eq!(relevance(&exact, "  De   Jure "), relevance(&exact, "de jure"));
        // Пустой запрос не паникует и ничего не набирает
        assert_eq!(relevance(&exact, "   "), 0.0);
    }

    #[test]
    fn rank_puts_popular_real_tracks_first() {
        let items = vec![
            track("De Jure (Speed Up)", "Random Guy", 900_000, false),
            track("De Jure", "Известный", 4_500_000, true),
            track("De Jure", "Средний", 250_000, false),
            track("De Jure", "Неизвестный", 120, false),
            track("De Jure (Sped Up)", "Random Guy", 800_000, false),
            track("Другая песня", "Кто-то", 100_000_000, false),
        ];
        let ranked = rank_results(items, "de jure");

        // Мусорных версий в выдаче нет
        assert!(ranked
            .iter()
            .all(|item| !item.title.contains("Speed Up") && !item.title.contains("Sped Up")));
        // Три настоящих «De Jure» разных исполнителей на месте
        let titles = ranked
            .iter()
            .filter(|item| item.title == "De Jure")
            .count();
        assert_eq!(titles, 3);
        // Сверху — самый популярный из точных совпадений
        assert_eq!(ranked[0].artists, "Известный");
        assert_eq!(ranked[1].artists, "Средний");
        assert_eq!(ranked[2].artists, "Неизвестный");
        // Чужая песня с миллионами прослушиваний уходит вниз
        assert_eq!(ranked.last().unwrap().title, "Другая песня");
    }

    #[test]
    fn absurd_durations_are_dropped() {
        let with_duration = |title: &str, duration_ms: i64| {
            let mut item = track(title, "X", 10, false);
            item.duration_ms = duration_ms;
            item
        };
        let ranked = rank_results(
            vec![
                with_duration("Обрывок", 15_000),
                with_duration("Марафон", 31 * 60 * 1000),
                with_duration("Ровно двадцать секунд", 20_000),
                with_duration("Ровно полчаса", 30 * 60 * 1000),
                with_duration("Нормальный", 200_000),
                with_duration("Без длительности", 0),
            ],
            "de jure",
        );

        let titles: Vec<&str> = ranked.iter().map(|item| item.title.as_str()).collect();
        assert!(!titles.contains(&"Обрывок"), "получили: {titles:?}");
        assert!(!titles.contains(&"Марафон"), "получили: {titles:?}");
        assert!(titles.contains(&"Ровно двадцать секунд"), "получили: {titles:?}");
        assert!(titles.contains(&"Ровно полчаса"), "получили: {titles:?}");
        assert!(titles.contains(&"Нормальный"), "получили: {titles:?}");
        // Ноль — это «SoundCloud не сказал», а не обрывок
        assert!(titles.contains(&"Без длительности"), "получили: {titles:?}");
    }

    #[test]
    fn fallback_keeps_the_most_popular_when_everything_was_cut() {
        let items = vec![
            track("De Jure (Speed Up)", "Random", 1_000, false),
            track("De Jure (Slowed)", "Random", 5_000, false),
        ];
        assert!(rank_results(items.clone(), "de jure").is_empty());

        let fallback = popular_first(items);
        assert_eq!(fallback.len(), 2);
        assert_eq!(fallback[0].title, "De Jure (Slowed)");
    }

    #[test]
    fn ranking_an_empty_answer_is_harmless() {
        assert!(rank_results(Vec::new(), "de jure").is_empty());
        assert!(popular_first(Vec::new()).is_empty());
    }

    #[test]
    fn popularity_is_mapped_from_the_answer() {
        let item = serde_json::json!({
            "id": 42,
            "title": "Трек",
            "duration": 210000,
            "playback_count": 12345,
            "likes_count": 678,
            "reposts_count": 90,
            "comment_count": 12,
            "created_at": "2021-05-06T07:08:09Z",
            "user": { "username": "Автор", "followers_count": 5000, "verified": true }
        });
        let mapped = map_track(&item);
        assert_eq!(mapped.playback_count, Some(12345));
        assert_eq!(mapped.likes_count, Some(678));
        assert_eq!(mapped.reposts_count, Some(90));
        assert_eq!(mapped.comment_count, Some(12));
        assert_eq!(mapped.followers_count, Some(5000));
        assert_eq!(mapped.verified, Some(true));
        assert_eq!(mapped.created_at.as_deref(), Some("2021-05-06T07:08:09Z"));

        // Ответ без этих полей не выдумывает нули
        let bare = map_track(&serde_json::json!({ "id": 1 }));
        assert_eq!(bare.playback_count, None);
        assert_eq!(bare.likes_count, None);
        assert_eq!(bare.reposts_count, None);
        assert_eq!(bare.comment_count, None);
        assert_eq!(bare.followers_count, None);
        assert_eq!(bare.verified, None);
        assert_eq!(bare.created_at, None);
    }

    #[test]
    fn popularity_fields_go_to_the_interface_in_camel_case() {
        let mapped = track("De Jure", "Автор", 777, true);
        let json = serde_json::to_value(&mapped).unwrap();
        assert_eq!(json.get("playbackCount").and_then(|v| v.as_i64()), Some(777));
        assert_eq!(json.get("likesCount").and_then(|v| v.as_i64()), Some(77));
        assert_eq!(json.get("repostsCount").and_then(|v| v.as_i64()), Some(7));
        assert_eq!(json.get("followersCount").and_then(|v| v.as_i64()), Some(155));
        assert_eq!(json.get("verified").and_then(|v| v.as_bool()), Some(true));

        // Отсутствующие данные не превращаются в null
        let mut empty = track("De Jure", "Автор", 0, false);
        empty.playback_count = None;
        empty.created_at = None;
        let json = serde_json::to_value(&empty).unwrap();
        assert!(json.get("playbackCount").is_none());
        assert!(json.get("createdAt").is_none());
    }

    #[test]
    fn search_asks_for_the_right_limits() {
        let url = search_url("cid", "de jure", SEARCH_LIMIT);
        assert!(url.contains("limit=20"), "получили: {url}");
        assert!(url.contains("q=de+jure"), "получили: {url}");
        let wide = search_url("cid", "de jure", WIDE_SEARCH_LIMIT);
        assert!(wide.contains("limit=50"), "получили: {wide}");
        assert!(WIDE_SEARCH_LIMIT > SEARCH_LIMIT);
    }

    // ---------- Страницы поиска: offset и курсор ----------

    #[test]
    fn search_page_url_carries_limit_offset_and_partitioning() {
        let url = search_page_url("cid", "de jure", 20, 40);
        assert!(url.contains("q=de+jure"), "получили: {url}");
        assert!(url.contains("limit=20"), "получили: {url}");
        assert!(url.contains("offset=40"), "получили: {url}");
        // linked_partitioning — из-за него ответ приходит с next_href
        assert!(url.contains("linked_partitioning=1"), "получили: {url}");
        // Нулевой лимит не превращается в запрос без порции
        assert!(search_page_url("cid", "q", 0, 0).contains("limit=1"));
    }

    #[test]
    fn next_href_becomes_an_absolute_url() {
        let href = "https://api-v2.soundcloud.com/search/tracks?limit=20&offset=20";
        let url = next_page_url(href, "cid");
        assert!(url.starts_with(href), "получили: {url}");
        assert!(url.contains("client_id=cid"), "получили: {url}");
        // К ссылке без параметров client_id тоже добавляется
        assert_eq!(
            next_page_url("https://api-v2.soundcloud.com/x", "cid"),
            "https://api-v2.soundcloud.com/x?client_id=cid"
        );
        // client_id уже есть в курсоре — второй раз не добавляем
        let with_id = "https://api-v2.soundcloud.com/x?client_id=abc&limit=20";
        assert_eq!(next_page_url(with_id, "cid"), with_id);
        // Пустой курсор — не битая ссылка, а честная пустота
        assert_eq!(next_page_url("   ", "cid"), "");
    }

    #[test]
    fn page_of_reads_collection_and_cursor() {
        let body = serde_json::json!({
            "collection": [ { "id": 1 }, { "id": 2 } ],
            "next_href": "https://api-v2.soundcloud.com/x?offset=2"
        });
        let (items, next) = page_of(&body);
        assert_eq!(items.len(), 2);
        assert_eq!(next.as_deref(), Some("https://api-v2.soundcloud.com/x?offset=2"));

        // Без linked_partitioning ответ приходит просто массивом
        let (items, next) = page_of(&serde_json::json!([{ "id": 3 }]));
        assert_eq!(items.len(), 1);
        assert_eq!(next, None);

        // Пустой или мусорный ответ не паникует
        assert!(page_of(&serde_json::json!({})).0.is_empty());
        assert_eq!(page_of(&serde_json::json!({ "next_href": "   " })).1, None);
    }

    #[test]
    fn search_page_refuses_bad_input_before_network() {
        assert!(search_page("", "de jure", 20, 0, None)
            .unwrap_err()
            .contains("client_id"));
        // Пустой запрос — пустая страница, в сеть не идём
        let empty = search_page("cid", "   ", 20, 0, None).unwrap();
        assert!(empty.tracks.is_empty());
        assert!(!empty.has_more);
        assert_eq!(empty.next_href, None);
    }

    // ---------- Профиль артиста ----------

    #[test]
    fn user_profile_is_parsed_with_a_bigger_avatar() {
        let item = serde_json::json!({
            "id": 12345,
            "username": "De Jure",
            "full_name": "De Jure Music",
            "avatar_url": "https://i1.sndcdn.com/avatars-0001-abc-large.jpg",
            "visuals": { "visuals": [ { "visual_url": "https://i1.sndcdn.com/visuals-0001-banner.jpg" } ] },
            "description": "  Био артиста  ",
            "permalink": "dejure",
            "permalink_url": "https://soundcloud.com/dejure",
            "followers_count": 1200,
            "followings_count": 30,
            "track_count": 42,
            "playlist_count": 3,
            "likes_count": 777,
            "city": "Москва",
            "country_code": "RU",
            "verified": true
        });
        let user = parse_user(&item);
        assert_eq!(user.id, "12345");
        assert_eq!(user.username, "De Jure");
        assert_eq!(user.full_name.as_deref(), Some("De Jure Music"));
        assert_eq!(
            user.avatar_url.as_deref(),
            Some("https://i1.sndcdn.com/avatars-0001-abc-t500x500.jpg")
        );
        assert_eq!(
            user.banner_url.as_deref(),
            Some("https://i1.sndcdn.com/visuals-0001-banner.jpg")
        );
        assert_eq!(user.description.as_deref(), Some("Био артиста"));
        assert_eq!(user.permalink.as_deref(), Some("dejure"));
        assert_eq!(user.permalink_url.as_deref(), Some("https://soundcloud.com/dejure"));
        assert_eq!(user.followers_count, Some(1200));
        assert_eq!(user.followings_count, Some(30));
        assert_eq!(user.track_count, Some(42));
        assert_eq!(user.playlist_count, Some(3));
        assert_eq!(user.likes_count, Some(777));
        assert_eq!(user.city.as_deref(), Some("Москва"));
        assert_eq!(user.country_code.as_deref(), Some("RU"));
        assert_eq!(user.verified, Some(true));
    }

    #[test]
    fn bare_profile_does_not_invent_data() {
        let bare = parse_user(&serde_json::json!({ "id": 7 }));
        assert_eq!(bare.id, "7");
        assert_eq!(bare.username, "SoundCloud");
        assert_eq!(bare.avatar_url, None);
        assert_eq!(bare.banner_url, None);
        assert_eq!(bare.description, None);
        assert_eq!(bare.followers_count, None);
        assert_eq!(bare.track_count, None);
        assert_eq!(bare.city, None);
        assert_eq!(bare.verified, None);
        // Пустые строки — это тоже «нет данных»
        let blank = parse_user(&serde_json::json!({ "username": "   ", "description": "  " }));
        assert_eq!(blank.username, "SoundCloud");
        assert_eq!(blank.description, None);
    }

    #[test]
    fn banner_falls_back_to_banner_url_and_country_to_country_field() {
        let with_banner = parse_user(&serde_json::json!({
            "banner_url": "https://i1.sndcdn.com/banner.jpg",
            "visuals": { "visuals": [ { "visual_url": "https://i1.sndcdn.com/visual.jpg" } ] },
            "country": "DE"
        }));
        assert_eq!(
            with_banner.banner_url.as_deref(),
            Some("https://i1.sndcdn.com/banner.jpg")
        );
        assert_eq!(with_banner.country_code.as_deref(), Some("DE"));
    }

    #[test]
    fn profile_goes_to_the_interface_in_camel_case() {
        let json = serde_json::to_value(parse_user(&serde_json::json!({
            "id": 1,
            "username": "a",
            "track_count": 5,
            "country_code": "RU",
            "full_name": "Имя"
        })))
        .unwrap();
        assert_eq!(json.get("trackCount").and_then(|value| value.as_i64()), Some(5));
        assert_eq!(json.get("countryCode").and_then(|value| value.as_str()), Some("RU"));
        assert_eq!(json.get("fullName").and_then(|value| value.as_str()), Some("Имя"));
        assert_eq!(json.get("followersCount"), Some(&serde_json::Value::Null));
    }

    #[test]
    fn avatars_and_user_links_are_built_offline() {
        // Числовой id идёт прямо в API пользователей
        let by_id = user_url("cid", "12345");
        assert!(by_id.contains("/users/12345?"), "получили: {by_id}");
        assert!(!by_id.contains("resolve"), "получили: {by_id}");
        assert!(by_id.contains("client_id=cid"), "получили: {by_id}");

        // Ник и адрес страницы — через resolve
        let by_nick = user_url("cid", "dejure");
        assert!(by_nick.contains("/resolve?url="), "получили: {by_nick}");
        assert!(by_nick.contains("soundcloud.com%2Fdejure"), "получили: {by_nick}");
        let by_link = user_url("cid", "https://soundcloud.com/dejure/tracks");
        assert!(
            by_link.contains("https%3A%2F%2Fsoundcloud.com%2Fdejure%2Ftracks"),
            "получили: {by_link}"
        );

        // Поиск людей: ник и лимит на месте
        let search = users_search_url("cid", "de jure", 10);
        assert!(search.contains("/search/users?q=de+jure"), "получили: {search}");
        assert!(search.contains("limit=10"), "получили: {search}");
        assert!(users_search_url("cid", "x", 0).contains("limit=1"));
    }

    #[test]
    fn best_user_prefers_the_exact_nick() {
        let body = serde_json::json!({ "collection": [
            { "id": 1, "username": "De Jure Cover Band", "permalink": "dejurecover" },
            { "id": 2, "username": "De Jure", "permalink": "dejure" }
        ]});
        // Совпадение по постоянной ссылке важнее порядка выдачи
        assert_eq!(best_user(&body, "dejure").unwrap()["id"], 2);
        // Регистр не важен
        assert_eq!(best_user(&body, "DE JURE").unwrap()["id"], 2);
        // Ничего не совпало — отдаём первого: SoundCloud уже отсортировал выдачу
        assert_eq!(best_user(&body, "кто-то другой").unwrap()["id"], 1);
        // Пустая выдача и мусорный ответ — честный None
        assert!(best_user(&serde_json::json!({ "collection": [] }), "dejure").is_none());
        assert!(best_user(&serde_json::json!({}), "dejure").is_none());
    }

    #[test]
    fn artist_urls_refuse_empty_input_before_network() {
        assert!(user("cid", "  ").unwrap_err().contains("артист"));
        assert!(user("", "dejure").unwrap_err().contains("client_id"));
        assert!(user_tracks("cid", "", 25, 0).unwrap_err().contains("артист"));
        assert!(user_tracks("", "1", 25, 0).unwrap_err().contains("client_id"));
        assert!(user_tracks_page("", "1", 25, 0).unwrap_err().contains("client_id"));
    }

    #[test]
    fn user_tracks_url_carries_limit_and_offset() {
        let url = user_tracks_url("cid", "12345", 25, 50);
        assert!(url.contains("/users/12345/tracks?"), "получили: {url}");
        assert!(url.contains("limit=25"), "получили: {url}");
        assert!(url.contains("offset=50"), "получили: {url}");
        assert!(url.contains("client_id=cid"), "получили: {url}");
        // Нулевой лимит не превращается в пустую страницу
        assert!(user_tracks_url("cid", "1", 0, 0).contains("limit=1"));
    }

    #[test]
    fn artist_page_keeps_the_shape_the_interface_expects() {
        // Пустая страница не выдумывает курсор и «есть ещё»
        let page = SoundCloudPage {
            tracks: Vec::new(),
            next_href: None,
            has_more: false,
        };
        let json = serde_json::to_value(&page).unwrap();
        assert!(json.get("tracks").and_then(|value| value.as_array()).unwrap().is_empty());
        assert!(!json.get("hasMore").and_then(|value| value.as_bool()).unwrap());
        // Отсутствующий курсор не превращается в null-поле
        assert!(json.get("nextHref").is_none());

        let with_cursor = SoundCloudPage {
            tracks: vec![track("De Jure", "Автор", 10, false)],
            next_href: Some("https://api-v2.soundcloud.com/x?offset=20".into()),
            has_more: true,
        };
        let json = serde_json::to_value(&with_cursor).unwrap();
        assert_eq!(
            json.get("nextHref").and_then(|value| value.as_str()),
            Some("https://api-v2.soundcloud.com/x?offset=20")
        );
        assert!(json.get("hasMore").and_then(|value| value.as_bool()).unwrap());
        assert_eq!(json.get("tracks").and_then(|value| value.as_array()).unwrap().len(), 1);
    }

    #[test]
    fn wave_tracks_are_deduped_and_unplayable_are_cut() {
        let body = serde_json::json!({ "collection": [
            {
                "id": 1,
                "title": "De Jure",
                "duration": 200_000,
                "streamable": true,
                "playback_count": 500,
                "user": { "username": "Автор" }
            },
            // Тот же трек второй раз — в очередь дважды не попадёт
            {
                "id": 1,
                "title": "De Jure (дубль)",
                "duration": 200_000,
                "streamable": true,
                "user": { "username": "Автор" }
            },
            // SoundCloud запретил поток — играть нечего
            {
                "id": 2,
                "title": "Закрытый трек",
                "duration": 200_000,
                "streamable": false,
                "user": { "username": "Автор" }
            },
            // Мусорная версия — отсекается тем же фильтром, что и поиск
            {
                "id": 3,
                "title": "De Jure (Speed Up)",
                "duration": 200_000,
                "streamable": true,
                "user": { "username": "Автор" }
            },
            // Обрывок короче 20 секунд — не музыка
            {
                "id": 4,
                "title": "Сниппет",
                "duration": 5_000,
                "streamable": true,
                "user": { "username": "Автор" }
            }
        ]});

        let tracks = parse_wave_tracks(&body).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].id, "1");
        assert_eq!(tracks[0].title, "De Jure");
    }

    #[test]
    fn empty_related_response_is_empty_not_an_error() {
        // related и треки артиста отвечают и объектом с collection, и массивом
        assert!(parse_wave_tracks(&serde_json::json!({ "collection": [] }))
            .unwrap()
            .is_empty());
        assert!(parse_wave_tracks(&serde_json::json!([])).unwrap().is_empty());
    }

    #[test]
    fn garbage_related_response_is_an_error() {
        assert!(parse_wave_tracks(&serde_json::json!("<html>")).is_err());
        assert!(parse_wave_tracks(&serde_json::json!({ "status": "404" })).is_err());
    }

    #[test]
    fn artist_fallback_is_needed_only_for_empty_related() {
        assert!(needs_artist_fallback(&[]));
        assert!(!needs_artist_fallback(&[track("De Jure", "Автор", 10, false)]));
    }

    #[test]
    fn wave_urls_carry_limit_and_client_id() {
        let related = related_url("cid", "12345", 15);
        assert!(related.contains("/tracks/12345/related?"), "получили: {related}");
        assert!(related.contains("limit=15"), "получили: {related}");
        assert!(related.contains("client_id=cid"), "получили: {related}");
        // Нулевой лимит не превращается в пустой запрос
        assert!(related_url("cid", "1", 0).contains("limit=1"));

        let artist = artist_top_url("cid", "42", 7);
        assert!(artist.contains("/users/42/tracks?"), "получили: {artist}");
        assert!(artist.contains("limit=7"), "получили: {artist}");
        assert!(artist.contains("client_id=cid"), "получили: {artist}");
    }

    #[test]
    fn wave_refuses_empty_input_before_network() {
        assert!(related("", "1", 15).unwrap_err().contains("client_id"));
        assert!(related("cid", "  ", 15).unwrap_err().contains("трек"));
        assert!(artist_top("", "1", 5).unwrap_err().contains("client_id"));
        assert!(artist_top("cid", "  ", 5).unwrap_err().contains("артист"));
    }

    // ---------- Разнообразие волны: жанр и похожие артисты ----------

    #[test]
    fn genre_tracks_url_carries_genre_and_limit() {
        let url = genre_tracks_url("cid", "Phonk", 6);
        assert!(
            url.starts_with("https://api-v2.soundcloud.com/tracks?genres=Phonk"),
            "получили: {url}"
        );
        assert!(url.contains("limit=6"), "получили: {url}");
        assert!(url.contains("linked_partitioning=1"), "получили: {url}");
        assert!(url.contains("client_id=cid"), "получили: {url}");

        // Идентификатор из чартов приводим к самому жанру
        assert!(
            genre_tracks_url("cid", "soundcloud:genres:phonk", 3).contains("genres=phonk"),
            "получили: {url}"
        );
        // Пробелы кодируются, нулевой лимит не превращается в пустой запрос
        assert!(
            genre_tracks_url("cid", "hip hop", 0).contains("genres=hip+hop"),
            "получили: {url}"
        );
        assert!(genre_tracks_url("cid", "x", 0).contains("limit=1"));
    }

    #[test]
    fn genre_tracks_skips_network_without_genre() {
        // Жанр неизвестен — запрос не нужен, и это не ошибка
        assert!(genre_tracks("cid", "  ", 5).unwrap().is_empty());
        assert!(genre_tracks("cid", "", 5).unwrap().is_empty());
        assert!(genre_tracks("", "phonk", 5).unwrap_err().contains("client_id"));
    }

    #[test]
    fn tag_list_gives_the_genre_when_the_field_is_empty() {
        let with_genre = map_track(&serde_json::json!({ "id": 1, "genre": "Phonk" }));
        assert_eq!(with_genre.genre.as_deref(), Some("Phonk"));

        let with_tags = map_track(&serde_json::json!({
            "id": 2,
            "genre": "   ",
            "tag_list": "\"dark phonk\" \"phonk\" \"bass\""
        }));
        assert_eq!(with_tags.genre.as_deref(), Some("dark phonk"));

        let bare = map_track(&serde_json::json!({ "id": 3 }));
        assert_eq!(bare.genre, None);
    }

    #[test]
    fn related_artist_urls_carry_limit_and_client_id() {
        let related = related_artists_url("cid", "42", 6);
        assert!(
            related.contains("/users/42/related?"),
            "получили: {related}"
        );
        assert!(related.contains("limit=6"), "получили: {related}");
        assert!(related.contains("client_id=cid"), "получили: {related}");
        assert!(related_artists_url("cid", "1", 0).contains("limit=1"));

        let followings = following_artists_url("cid", "42", 4);
        assert!(
            followings.contains("/users/42/followings?"),
            "получили: {followings}"
        );
        assert!(followings.contains("limit=4"), "получили: {followings}");
    }

    #[test]
    fn related_users_are_parsed_from_array_collection_and_wrappers() {
        let body = serde_json::json!([
            { "id": 1, "username": "Артист" },
            { "id": 1, "username": "Дубль" },
            { "user": { "id": 2, "username": "Второй" } },
            { "id": 3 }
        ]);
        let users = parse_related_users(&body);
        assert_eq!(users.len(), 3);
        assert_eq!(users[0].id, "1");
        assert_eq!(users[0].username, "Артист");
        assert_eq!(users[1].id, "2");
        assert_eq!(users[1].username, "Второй");

        // linked_partitioning отвечает объектом с collection
        let collection = serde_json::json!({ "collection": [ { "id": 7, "username": "Седьмой" } ] });
        let users = parse_related_users(&collection);
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].username, "Седьмой");
    }

    #[test]
    fn empty_or_404_related_answer_is_empty_not_an_error() {
        // 404, пустая выдача и мусор — честная пустота, волна доберёт другим
        assert!(parse_related_users(&serde_json::json!([])).is_empty());
        assert!(parse_related_users(&serde_json::json!({ "collection": [] })).is_empty());
        assert!(parse_related_users(&serde_json::json!({ "status": "404" })).is_empty());
        assert!(parse_related_users(&serde_json::json!("<html>")).is_empty());
        assert!(parse_related_users(&serde_json::json!([{ "id": null }])).is_empty());
    }

    #[test]
    fn related_artists_refuse_bad_input_before_network() {
        assert!(related_artists("", "1", 5).unwrap_err().contains("client_id"));
        assert!(related_artists("cid", "  ", 5).unwrap_err().contains("артист"));
    }
}
