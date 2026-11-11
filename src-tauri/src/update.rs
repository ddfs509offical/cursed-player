#![cfg(desktop)]
//! Автообновление: проверка `latest.json` в бакете `updates` и запуск
//! установщика.
//!
//! Как это работает:
//!  1. `npm run release` поднимает `APP_BUILD`, собирает установщик и кладёт
//!     рядом `latest.json` (номер сборки, размер, заметки).
//!  2. Владелец загружает оба файла в Storage → бакет `updates` (публичный на
//!     чтение).
//!  3. Приложение при старте читает `latest.json`; если номер больше своего —
//!     предлагает обновление, скачивает установщик в temp и запускает его.
//!
//! Чего здесь нет намеренно: тихой подмены файлов без спроса. Установщик
//! показывает своё окно, и человек видит, что происходит.

use serde::Serialize;
use std::time::Duration;

/// Сколько ждать сервер обновлений: это не критичный к задержке запрос.
const CHECK_TIMEOUT: Duration = Duration::from_secs(8);
/// Скачивание установщика (≈9 МБ) — с запасом.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Номер сборки строкой: в JSON он лежит как "version": "12".
    pub version: String,
    pub notes: Option<String>,
    pub url: String,
    pub size: Option<u64>,
}

fn project() -> Result<(String, String), String> {
    crate::supabase::project_config()
}

/// Есть ли обновление. `None` — сервер не знает про обновления (нет файла).
pub fn check() -> Result<Option<UpdateInfo>, String> {
    let (base, key) = project()?;
    let url = format!("{base}/storage/v1/object/public/updates/latest.json");
    let response = match ureq::get(&url)
        .set("apikey", &key)
        .timeout(CHECK_TIMEOUT)
        .call()
    {
        Ok(response) => response,
        // Файла ещё нет — это нормальное состояние нового проекта.
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        // Бакет есть, но закрыт или назван иначе: молчать нельзя, иначе в
        // настройках будет «обновлений нет», хотя сервер просто не пускает.
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            let short: String = body.trim().chars().take(160).collect();
            let lower = short.to_lowercase();
            let hint = if lower.contains("bucket not found") || lower.contains("nosuchbucket") {
                " — создай бакет «updates» и включи Public bucket"
            } else if code == 400 || code == 401 || code == 403 {
                " — проверь, что бакет «updates» публичный"
            } else {
                ""
            };
            return Err(format!("Сервер обновлений ответил {code}: {short}{hint}"));
        }
        Err(error) => return Err(format!("Сервер обновлений недоступен: {error}")),
    };

    let text = response
        .into_string()
        .map_err(|error| format!("Не удалось прочитать ответ: {error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "Сервер обновлений вернул не JSON".to_string())?;

    let version = value
        .get("version")
        .map(|v| match v {
            serde_json::Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    if version.trim().is_empty() {
        return Ok(None);
    }

    // Ссылка: если в latest.json есть `url` — берём его, иначе собираем из имени
    // файла (`file`) или из имени установщика по умолчанию.
    let file = value
        .get("file")
        .and_then(|v| v.as_str())
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.trim().replace(' ', "%20"))
        .unwrap_or_else(|| "Cursed%20player%20setup.exe".to_string());
    let default_url = format!("{base}/storage/v1/object/public/updates/{file}");

    Ok(Some(UpdateInfo {
        version: version.trim().to_string(),
        notes: value
            .get("notes")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        url: value
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or(default_url),
        size: value.get("size").and_then(|v| v.as_u64()),
    }))
}

/// Скачать установщик во временную папку и вернуть путь к нему.
pub fn download(url: &str) -> Result<String, String> {
    let (_, key) = project()?;
    let path = std::env::temp_dir().join("cursed-player-update-setup.exe");

    let response = ureq::get(url)
        .set("apikey", &key)
        .timeout(DOWNLOAD_TIMEOUT)
        .call()
        .map_err(|error| format!("Не удалось скачать обновление: {error}"))?;

    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(&path)
        .map_err(|error| format!("Не удалось создать файл обновления: {error}"))?;
    std::io::copy(&mut reader, &mut file)
        .map_err(|error| format!("Не удалось записать обновление: {error}"))?;

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size < 1_000_000 {
        // Установщик меньше мегабайта — почти наверняка это HTML-страница ошибки.
        let _ = std::fs::remove_file(&path);
        return Err("Сервер отдал не установщик, а что-то другое".into());
    }

    Ok(path.to_string_lossy().to_string())
}

/// Открыть скачанный установщик. Дальше всё делает NSIS: он закроет
/// приложение, заменит файлы и (в обычном режиме) запустит новую версию.
pub fn launch(path: &str) -> Result<(), String> {
    open::that(path).map_err(|error| format!("Не удалось запустить установщик: {error}"))
}
