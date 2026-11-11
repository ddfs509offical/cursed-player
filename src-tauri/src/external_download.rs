//! Запасной путь сохранения трека: внешний сервис soundloadmate.com.
//!
//! Основной способ — нативный (`downloads::save`): он тянет поток SoundCloud
//! напрямую. Этот модуль — честная заплатка на случай, когда нативный путь не
//! справился: ссылка на трек уходит на сторонний сервис, сервис возвращает
//! подписанную ссылку на готовый файл, файл скачивается и только после
//! проверки «это правда аудио» попадает в офлайн-реестр.
//!
//! # Почему модуль изолирован
//!
//! Сервис чужой и работает без гарантий: он может сменить формат, закрыться
//! или отдать вместо музыки страницу. Поэтому вся зависимость от него собрана
//! в этом одном файле, а наружу торчит единственная функция [`save`].
//! Отключить затею целиком = удалить этот файл и три упоминания в `main.rs`
//! (`mod external_download;`, команда `external_save_track` и её строка в
//! `generate_handler!`). Нативное сохранение при этом не затронуто: модуль не
//! трогает ни `index.json`, ни имена файлов, а лишь просит
//! `downloads::adopt_local_file` принять уже проверенный файл.
//!
//! # Как устроен сервис
//!
//! Разведка 2026-10-04 показала обычный HTTP без JS-челленджа и капчи:
//! 1. `GET /ruAB` — форма поиска; имя одноразового поля-токена сервис меняет
//!    каждый раз, поэтому его читаем со страницы, а не запоминаем;
//! 2. `POST /action` (`url` + токен) — JSON с HTML, где на каждый найденный
//!    трек есть форма `submitapurl` и в ней поля `data` (base64 с описанием
//!    трека), `base` и `token`;
//! 3. `POST /action/track` (`data`, `base`, `token`) — JSON с HTML, где лежит
//!    подписанная ссылка `https://rapid.soundloadmate.com/v2?token=…`;
//! 4. `GET` этой ссылки — сам аудиофайл.
//!
//! В ответе всегда две подписанные ссылки: на трек и на обложку. Нужную
//! узнаём по полезной нагрузке JWT: у файла трека есть поле `url`, у обложки
//! — `cover`. Сам `url` внутри токена зашифрован, расшифровывает его только
//! сервис, поэтому идём редиректом, а не пытаемся достать адрес сами.

use crate::downloads;
use crate::silent;
use base64::Engine as _;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicU64, Ordering};

/// Страница сервиса: с неё берём одноразовый токен формы.
const SERVICE_PAGE: &str = "https://soundloadmate.com/ruAB";
/// Начало адресов сервиса: путь эндпоинта приписывается к нему.
const SERVICE_ORIGIN: &str = "https://soundloadmate.com";
/// «Ссылка на трек → список найденного».
const ACTION_PATH: &str = "/action";
/// «Выбранный трек → подписанная ссылка на файл».
const TRACK_ACTION_PATH: &str = "/action/track";
/// Хост подписанных ссылок: отдаёт сам файл.
const RAPID_PREFIX: &str = "https://rapid.soundloadmate.com/";
/// User-Agent: сервис пускает только «браузер».
const CURL_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
/// DNS поверх HTTPS: провайдер не подменит адрес (тот же приём, что в
/// `downloads.rs` и `soundcloud.rs`).
const DOH_URL: &str = "https://1.1.1.1/dns-query";
/// Предел ожидания ответа сервиса, секунд.
const STEP_TIMEOUT: &str = "60";
/// Файл меньше этого — не музыка, а обрезок, заглушка или страница ошибки.
const MIN_AUDIO_BYTES: u64 = 200 * 1024;
/// Сколько байт начала файла нужно, чтобы опознать контейнер.
const SNIFF_BYTES: usize = 16;
/// Счётчик временных файлов: два сохранения не должны столкнуться.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Что сервис вернул в форме трека: по этим полям он и готовит файл.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TrackForm {
    /// base64 с описанием трека (id, название, исполнитель, обложка, ссылка).
    data: String,
    /// Адрес страницы трека в SoundCloud.
    base: String,
    /// Одноразовый токен, выданный сервисом именно этому треку.
    token: String,
}

/// Сохраняет трек через внешний сервис и, если всё сошлось, кладёт файл в
/// офлайн-реестр. Единственная публичная функция модуля.
///
/// Режим всегда `cache`: сервис не сообщает, разрешил ли автор скачивание,
/// поэтому называть файл «скачанным» (`download`) было бы обманом. Дальше
/// пользователь может включить «держу офлайн» — это уже штатный механизм.
/// Способ — `external`: в «Скачанных» он показан отдельно от режима, чтобы
/// было видно, что файл добыт сторонним сервисом.
pub fn save(
    track_url: &str,
    id: &str,
    title: &str,
    artist: Option<&str>,
    cover: Option<&str>,
) -> Result<downloads::SavedFile, String> {
    let link = track_url.trim();
    if !link.starts_with("https://") && !link.starts_with("http://") {
        return Err("Ссылка на трек должна начинаться с http:// или https://".into());
    }

    let dir = downloads::cache_dir()?;
    let jar = cookie_jar();
    let result = fetch_and_adopt(&dir, &jar, link, id, title, artist, cover);
    // Cookie-файл — мусор в TEMP: он не нужен ни при успехе, ни при ошибке.
    let _ = std::fs::remove_file(&jar);
    result
}

/// Весь путь до готового файла: страница → токен → список → форма → ссылка.
fn fetch_and_adopt(
    dir: &Path,
    jar: &Path,
    link: &str,
    id: &str,
    title: &str,
    artist: Option<&str>,
    cover: Option<&str>,
) -> Result<downloads::SavedFile, String> {
    let page = service_page(jar)?;
    let (name, token) = form_token(&page).ok_or_else(|| {
        "Внешний сервис не отдал токен формы — похоже, он включил защиту от автоматизации"
            .to_string()
    })?;

    let found = service_post(
        ACTION_PATH,
        &[("url", link), (name.as_str(), token.as_str())],
        jar,
    )?;
    let list = take_field(&found, "html")?;
    let form = track_form(&list)
        .ok_or_else(|| "Внешний сервис не нашёл трек по этой ссылке".to_string())?;

    let prepared = service_post(
        TRACK_ACTION_PATH,
        &[
            ("data", form.data.as_str()),
            ("base", form.base.as_str()),
            ("token", form.token.as_str()),
        ],
        jar,
    )?;
    let html = take_field(&prepared, "data")?;
    let file_link = rapid_link(&html).ok_or_else(|| {
        "Внешний сервис не отдал ссылку на файл — похоже, он сменил формат ответа".to_string()
    })?;

    download_and_adopt(dir, &file_link, id, title, artist, cover)
}

/// Скачивает файл по подписанной ссылке, проверяет, что это правда аудио, и
/// только потом отдаёт его реестру. При любой неудаче временный файл
/// удаляется: мусор в папке кеша оставлять нельзя.
fn download_and_adopt(
    dir: &Path,
    file_link: &str,
    id: &str,
    title: &str,
    artist: Option<&str>,
    cover: Option<&str>,
) -> Result<downloads::SavedFile, String> {
    let temp = dir.join(format!(
        "external_{}.{}.part",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| {
        // Тот же curl с DoH и запасным обычным путём, что у нативного
        // сохранения: файл пишется сразу на диск.
        if let Err(doh_error) = downloads::download_with_curl(file_link, &temp, true) {
            downloads::download_with_curl(file_link, &temp, false).map_err(|error| {
                format!(
                    "Не удалось скачать файл с внешнего сервиса. Через DoH: {doh_error}. Обычным способом: {error}"
                )
            })?;
        }

        let extension = verify_audio(&temp)
            .map_err(|why| format!("Сервис отдал не аудиофайл: {why}"))?;

        downloads::adopt_local_file(
            temp.clone(),
            &extension,
            id,
            // Режим всегда «cache»: сервис не подтверждает разрешение автора.
            // Способ — «external»: файл добыт сторонним сервисом, и в
            // «Скачанных» это видно отдельно от режима.
            "cache",
            "external",
            title,
            artist,
            cover,
        )
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/* ─────────────── Проверка файла ─────────────── */

/// Опознаёт контейнер по первым байтам и возвращает честное расширение.
/// Проверка нужна как защита от подмены: сервис — чужая сторона, и вместо
/// музыки он может отдать страницу, JSON с ошибкой или рекламную заглушку.
fn sniff_audio(head: &[u8]) -> Option<&'static str> {
    // MP3 с тегом ID3v2 — так отдаёт файлы сам soundloadmate.
    if head.starts_with(b"ID3") {
        return Some("mp3");
    }
    // ADTS AAC: синхрослово 0xFFF (12 бит) и поле «слой» из двух нулей.
    // Проверяем раньше MP3: у MP3 синхрослово короче (0xFFE), и без проверки
    // слоя обычный MP3 (0xFB) сошёл бы за AAC.
    if head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xF6) == 0xF0 {
        return Some("aac");
    }
    // MP3 без тега: синхрослово 0xFFE.
    if head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0 {
        return Some("mp3");
    }
    // MP4/M4A: бокс `ftyp` всегда идёт четвёртым по счёту.
    if head.len() >= 8 && &head[4..8] == b"ftyp" {
        return Some("m4a");
    }
    if head.starts_with(b"OggS") {
        return Some("ogg");
    }
    if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WAVE" {
        return Some("wav");
    }
    None
}

/// Человеческое объяснение, почему файл не признан аудио: пользователю важно
/// понять, что случилось, а не увидеть «ошибка».
fn describe_not_audio(head: &[u8]) -> String {
    let text = String::from_utf8_lossy(head)
        .trim_start()
        .to_ascii_lowercase();
    if text.starts_with("<!doctype") || text.starts_with("<html") || text.starts_with("<?xml") {
        return "вместо файла пришла HTML-страница".into();
    }
    if text.starts_with('{') || text.starts_with('[') {
        return "вместо файла пришёл JSON с ошибкой".into();
    }

    let signature = head
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("неизвестная сигнатура ({signature})")
}

/// Полная проверка скачанного файла: размер и сигнатура. Возвращает
/// расширение для имени файла или понятную причину отказа.
fn verify_audio(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("файл не скачался: {e}"))?;
    if meta.len() < MIN_AUDIO_BYTES {
        return Err(format!(
            "файл слишком мал для музыки ({} КБ)",
            meta.len() / 1024
        ));
    }

    let mut head = [0u8; SNIFF_BYTES];
    let mut file = std::fs::File::open(path).map_err(|e| format!("файл не открылся: {e}"))?;
    let read = file
        .read(&mut head)
        .map_err(|e| format!("файл не прочитался: {e}"))?;
    let head = &head[..read];

    sniff_audio(head)
        .map(str::to_string)
        .ok_or_else(|| describe_not_audio(head))
}

/* ─────────────── Разбор ответов сервиса ─────────────── */

/// Разбирает ответ сервиса и достаёт из него поле с HTML. Отказ сервиса
/// показываем его же словами: они осмысленны («неверная ссылка», «токен
/// устарел»), а придумывать своё поверх чужого сообщения незачем.
fn take_field(text: &str, field: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(text.trim()).map_err(|_| {
        "Внешний сервис ответил не JSON — похоже, он сменил формат ответа".to_string()
    })?;

    if value.get("error").and_then(Value::as_bool) == Some(true) {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("сервис отказал без пояснения");
        return Err(format!("Внешний сервис отказал: {message}"));
    }

    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("В ответе внешнего сервиса нет поля «{field}»"))
}

/// Одноразовый токен формы. Сервис каждый раз называет поле по-новому,
/// поэтому ищем не по имени, а по признаку: скрытый input со значением из
/// 32 шестнадцатеричных знаков. Такое имя сервис меняет, значение — тоже.
fn form_token(page: &str) -> Option<(String, String)> {
    for tag in tags(page, "<input") {
        let Some(value) = attr(tag, "value") else {
            continue;
        };
        if !is_hex32(&value) {
            continue;
        }
        let name = attr(tag, "name")?;
        if !name.is_empty() {
            return Some((name, value));
        }
    }
    None
}

/// Ровно 32 шестнадцатеричных знака — формат антибот-значения сервиса.
fn is_hex32(value: &str) -> bool {
    value.len() == 32 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// Форма трека из ответа сервиса. На странице-списке таких форм столько же,
/// сколько найденных треков; нам нужна первая — сервис кладёт её по ссылке,
/// которую дал пользователь.
fn track_form(html: &str) -> Option<TrackForm> {
    let lower = html.to_ascii_lowercase();
    let start = lower
        .find("name=\"submitapurl\"")
        .or_else(|| lower.find("name='submitapurl'"))?;
    let end = lower[start..]
        .find("</form>")
        .map(|offset| start + offset)
        .unwrap_or(html.len());

    let mut form = TrackForm::default();
    for tag in tags(&html[start..end], "<input") {
        let (Some(name), Some(value)) = (attr(tag, "name"), attr(tag, "value")) else {
            continue;
        };
        match name.as_str() {
            "data" => form.data = value,
            "base" => form.base = value,
            "token" => form.token = value,
            _ => {}
        }
    }

    if form.data.is_empty() || form.base.is_empty() || form.token.is_empty() {
        None
    } else {
        Some(form)
    }
}

/// Подписанная ссылка на сам файл. Сервис всегда даёт две ссылки — на трек и
/// на обложку, и внешне они неразличимы. Нужную узнаём по полезной нагрузке
/// JWT: у файла трека есть поле `url`, у обложки — `cover`. Если разобрать
/// токены не удалось, берём первую ссылку: сервис ставит трек первым.
fn rapid_link(html: &str) -> Option<String> {
    let mut first: Option<String> = None;
    let mut from = 0;

    while let Some(offset) = html[from..].find(RAPID_PREFIX) {
        let start = from + offset;
        let end = html[start..]
            .find(|c: char| c == '"' || c == '\'' || c == '<' || c == ' ' || c == '\\')
            .map(|offset| start + offset)
            .unwrap_or(html.len());
        let link = &html[start..end];
        from = end.max(start + 1);

        if first.is_none() {
            first = Some(link.to_string());
        }
        if jwt_payload(link).is_some_and(|payload| payload.contains("\"url\"")) {
            return Some(link.to_string());
        }
    }

    first
}

/// Полезная нагрузка JWT из подписанной ссылки: по ней видно, файл это или
/// обложка. Токен лежит в параметре `token` и раскодирован из base64url.
fn jwt_payload(link: &str) -> Option<String> {
    let token = link.split("token=").nth(1)?.split('&').next()?;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    String::from_utf8(bytes).ok()
}

/// Значение атрибута в теге: `name="значение"`, `name='значение'` или
/// `name=значение`. Перед именем обязан стоять разделитель, иначе `data-id`
/// сошёл бы за `id`. Своего HTML-парсера в зависимостях нет, а для двух
/// десятков атрибутов он и не нужен.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{}=", name.to_ascii_lowercase());
    let mut from = 0;

    while let Some(offset) = lower[from..].find(&needle) {
        let at = from + offset;
        if matches!(lower[..at].chars().last(), Some(c) if c.is_whitespace() || c == '<') {
            let rest = &tag[at + needle.len()..];
            let value = match rest.chars().next() {
                Some('"') => rest[1..].split('"').next().unwrap_or(""),
                Some('\'') => rest[1..].split('\'').next().unwrap_or(""),
                _ => rest
                    .split(|c: char| c.is_whitespace() || c == '>')
                    .next()
                    .unwrap_or(""),
            };
            return Some(value.to_string());
        }
        from = at + needle.len();
    }

    None
}

/// Все теги, начинающиеся с `prefix` (например, `<input`). `>` внутри
/// значения атрибута сервис не использует, поэтому простого поиска хватает.
fn tags<'a>(html: &'a str, prefix: &str) -> Vec<&'a str> {
    let lower = html.to_ascii_lowercase();
    let mut found = Vec::new();
    let mut from = 0;

    while let Some(offset) = lower[from..].find(prefix) {
        let start = from + offset;
        let end = html[start..]
            .find('>')
            .map(|offset| start + offset)
            .unwrap_or(html.len());
        found.push(&html[start..end]);
        from = end + 1;
    }

    found
}

/* ─────────────── Запросы к сервису ─────────────── */

/// Одноразовый файл cookie: сервис привязывает форму и токен к сессии,
/// поэтому все шаги должны идти с одним и тем же набором cookie.
fn cookie_jar() -> PathBuf {
    std::env::temp_dir().join(format!(
        "music_hub_external_{}_{}.cookies",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Открывает страницу сервиса и заодно заводит сессию в cookie-файле.
fn service_page(jar: &Path) -> Result<String, String> {
    with_doh(|doh| {
        let mut command = silent::hidden("curl");
        command.args(["-sS", "--fail", "-L", "--max-time", STEP_TIMEOUT]);
        // На Windows curl (Schannel) проверяет отзыв сертификата; когда
        // CRL/OCSP недоступны, запрос падает — флаг снимает эту проверку.
        if cfg!(windows) {
            command.arg("--ssl-no-revoke");
        }
        if doh {
            command.args(["--doh-url", DOH_URL]);
        }
        let output = command
            .args(["-A", CURL_AGENT])
            .arg("-b")
            .arg(jar)
            .arg("-c")
            .arg(jar)
            .arg(SERVICE_PAGE)
            .output()
            .map_err(|e| format!("curl недоступен: {e}"))?;
        curl_text(output)
    })
}

/// Отправляет форму на эндпоинт сервиса: так уходят и ссылка на трек, и
/// выбранная форма. Ответ приходит JSON-ом.
fn service_post(path: &str, fields: &[(&str, &str)], jar: &Path) -> Result<String, String> {
    let url = format!("{SERVICE_ORIGIN}{path}");
    let referer = format!("Referer: {SERVICE_PAGE}");

    with_doh(|doh| {
        let mut command = silent::hidden("curl");
        command.args(["-sS", "--fail", "-L", "--max-time", STEP_TIMEOUT]);
        // Тот же флаг, что и при открытии страницы сервиса.
        if cfg!(windows) {
            command.arg("--ssl-no-revoke");
        }
        if doh {
            command.args(["--doh-url", DOH_URL]);
        }
        command
            .args(["-A", CURL_AGENT])
            .args(["-H", "X-Requested-With: XMLHttpRequest"])
            .args(["-H", referer.as_str()])
            .arg("-b")
            .arg(jar)
            .arg("-c")
            .arg(jar);
        for (name, value) in fields {
            command.arg("--data-urlencode").arg(format!("{name}={value}"));
        }
        let output = command
            .arg(&url)
            .output()
            .map_err(|e| format!("curl недоступен: {e}"))?;
        curl_text(output)
    })
}

/// DoH отдаёт настоящий адрес, когда провайдер подменяет DNS (тот же приём,
/// что в `downloads.rs`). Если через DoH не вышло — пробуем обычным способом,
/// иначе один недоступный резолвер ломал бы всю затею.
fn with_doh<T>(mut attempt: impl FnMut(bool) -> Result<T, String>) -> Result<T, String> {
    match attempt(true) {
        Ok(value) => Ok(value),
        Err(doh_error) => attempt(false)
            .map_err(|error| format!("Через DoH: {doh_error}. Обычным способом: {error}")),
    }
}

/// Тело успешного ответа curl; иначе — текст ошибки от curl.
fn curl_text(output: Output) -> Result<String, String> {
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() {
            "curl не получил ответ".into()
        } else {
            error
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Собирает подписанную ссылку с заданной полезной нагрузкой JWT.
    fn signed_link(payload: &str) -> String {
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.as_bytes());
        format!("{RAPID_PREFIX}v2?token=header.{body}.signature")
    }

    #[test]
    fn form_token_is_read_from_a_hidden_input() {
        // Имя поля сервис меняет каждый раз — ищем по формату значения.
        let page = r#"<form action method="post"><input name="url" type="text" value="">
            <input name="jMcXp" type="hidden" value="8a3dc9f10c0f95138d2236afbeb7d46f"/></form>"#;
        let (name, value) = form_token(page).expect("токен должен найтись");
        assert_eq!(name, "jMcXp");
        assert_eq!(value, "8a3dc9f10c0f95138d2236afbeb7d46f");
    }

    #[test]
    fn form_token_ignores_values_of_the_wrong_shape() {
        // Короткое значение токеном не считается: у сервиса их ровно 32 знака.
        let page = r#"<input name="short" type="hidden" value="8a3dc9f1">
            <input name="other" type="hidden" value="не шестнадцатеричное значение!">"#;
        assert!(form_token(page).is_none());
    }

    #[test]
    fn track_form_fields_are_read_from_the_list() {
        let html = r#"<div><form name="submitapurl" method="post">
            <input type="hidden" name="data" value='eyJpZCI6MjkzfQ=='>
            <input type="hidden" name="base" value="https://soundcloud.com/forss/flickermood">
            <input type="hidden" name="token" value="wjjZS://SMrpGyfMrG.yMh">
            <button type="submit">Download</button></form></div>"#;
        let form = track_form(html).expect("форма должна разобраться");
        assert_eq!(form.data, "eyJpZCI6MjkzfQ==");
        assert_eq!(form.base, "https://soundcloud.com/forss/flickermood");
        assert_eq!(form.token, "wjjZS://SMrpGyfMrG.yMh");
    }

    #[test]
    fn track_form_without_token_is_rejected() {
        let html = r#"<form name="submitapurl"><input name="data" value="a">
            <input name="base" value="b"></form>"#;
        assert!(track_form(html).is_none());
    }

    #[test]
    fn rapid_link_prefers_the_track_over_the_cover() {
        // Порядок ссылок в ответе менять нельзя: нужную узнаём по JWT.
        let cover = signed_link(r#"{"filename":"Трек","cover":"что-то"}"#);
        let track = signed_link(r#"{"filename":"Трек","url":"что-то"}"#);
        let html = format!(r#"<a href="{cover}">обложка</a><a href="{track}">трек</a>"#);
        assert_eq!(rapid_link(&html).as_deref(), Some(track.as_str()));
    }

    #[test]
    fn rapid_link_falls_back_to_the_first_link() {
        // Если токены не разобрались, сервис всё равно ставит трек первым.
        let html = format!(r#"<a href="{RAPID_PREFIX}v2?token=мусор">1</a>"#);
        let expected = format!("{RAPID_PREFIX}v2?token=мусор");
        assert_eq!(rapid_link(&html).as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn audio_signatures_are_recognized() {
        let mp3 = [0x49, 0x44, 0x33, 0x03, 0, 0, 0, 2, 0x27, 0x76];
        assert_eq!(sniff_audio(&mp3), Some("mp3"));

        // MP3 без тега: синхрослово 0xFFE.
        let bare_mp3 = [0xFF, 0xFB, 0x90, 0x00];
        assert_eq!(sniff_audio(&bare_mp3), Some("mp3"));

        // ADTS AAC: синхрослово 0xFFF, его нельзя спутать с MP3.
        let aac = [0xFF, 0xF1, 0x50, 0x80];
        assert_eq!(sniff_audio(&aac), Some("aac"));

        // MPEG-2 AAC отличается только одним битом версии.
        let aac2 = [0xFF, 0xF9, 0x50, 0x80];
        assert_eq!(sniff_audio(&aac2), Some("aac"));

        let mut m4a = vec![0, 0, 0, 0x20];
        m4a.extend_from_slice(b"ftypM4A ");
        assert_eq!(sniff_audio(&m4a), Some("m4a"));

        assert_eq!(sniff_audio(b"OggS\x00\x02\x00\x00\x00\x00\x00\x00"), Some("ogg"));

        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&[0, 0, 0, 0]);
        wav.extend_from_slice(b"WAVEfmt ");
        assert_eq!(sniff_audio(&wav), Some("wav"));
    }

    #[test]
    fn pages_and_json_are_not_audio() {
        assert!(sniff_audio(b"<!DOCTYPE html>").is_none());
        assert!(sniff_audio(b"{\"error\":true}").is_none());

        assert_eq!(
            describe_not_audio(b"<!DOCTYPE html><html>"),
            "вместо файла пришла HTML-страница"
        );
        assert_eq!(
            describe_not_audio(br#"{"error":"nope"}"#),
            "вместо файла пришёл JSON с ошибкой"
        );
        assert!(describe_not_audio(&[0x00, 0x01, 0x02]).starts_with("неизвестная сигнатура"));
    }

    #[test]
    fn service_error_is_reported_with_its_own_words() {
        let answer = r#"{"error":true,"message":"Invalid URL"}"#;
        let error = take_field(answer, "html").expect_err("отказ должен быть ошибкой");
        assert!(error.contains("Invalid URL"), "получилось: {error}");
    }

    #[test]
    fn missing_field_is_reported() {
        let answer = r#"{"success":true}"#;
        let error = take_field(answer, "html").expect_err("пустой ответ не годится");
        assert!(error.contains("html"), "получилось: {error}");

        let not_json = "<html>заглушка</html>";
        assert!(take_field(not_json, "html").is_err());
    }

    #[test]
    fn attribute_values_survive_both_quote_styles() {
        let tag = r#"<input name="data" value='eyJpZCI6MjkzfQ==' type="hidden">"#;
        assert_eq!(attr(tag, "value").as_deref(), Some("eyJpZCI6MjkzfQ=="));
        // `data-id` не должен выдаваться за `id`.
        assert!(attr(r#"<input data-id="7" name="x">"#, "id").is_none());
    }

    /// Полный проход по-настоящему: сеть, чужой сервис и запись в офлайн-реестр.
    /// В обычном прогоне не запускается — он ходит в интернет и трогает
    /// настоящую папку кеша. Для ручной проверки:
    /// `cargo test flow_works_against_the_real_service -- --ignored --nocapture`
    #[test]
    #[ignore = "нужен интернет и настоящая папка кеша"]
    fn flow_works_against_the_real_service() {
        let id = "soundcloud:293";
        let saved = save(
            "https://soundcloud.com/forss/flickermood",
            id,
            "Flickermood",
            Some("Forss"),
            None,
        )
        .expect("сервис должен отдать файл");

        assert_eq!(saved.track_id, id);
        // Через внешний сервис файл всегда офлайн-копия: авторских прав он не
        // подтверждает, и называть его «скачанным» было бы обманом.
        assert_eq!(saved.kind, "cache");
        // А способ отдельно называет, откуда файл взялся
        assert_eq!(saved.method, "external");
        assert!(
            saved.size > MIN_AUDIO_BYTES,
            "файл подозрительно мал: {} байт",
            saved.size
        );
        assert!(saved.path.ends_with(".mp3"), "путь: {}", saved.path);

        // Уборка за собой: ни файла, ни записи в реестре остаться не должно.
        downloads::remove(&saved.path).expect("временный файл должен удалиться");
    }
}
