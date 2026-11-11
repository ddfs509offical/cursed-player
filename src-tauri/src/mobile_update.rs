//! Проверка обновлений для Android.
//!
//! На Windows обновление ставит установщик: приложение скачивает `.exe` и
//! запускает его. На телефоне так нельзя — установка APK поверх работающей
//! программы требует подтверждения системы. Поэтому здесь другой порядок:
//!
//!   1. Читаем `latest.json` из того же бакета, что и настольная версия;
//!   2. Сравниваем номер сборки с текущим;
//!   3. Если есть новее — отдаём адрес APK и отпечаток, а установку запускает
//!      системный загрузчик (`Intent`), который и спросит разрешение.
//!
//! Отдельный файл, а не расширение настольного: у него нет ни установщика,
//! ни запуска процесса — общий код здесь только чтение JSON.

#![cfg(target_os = "android")]

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Ожидание ответа сервера: проверка не должна подвешивать экран.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Номер сборки приложения. Растёт при каждом выпуске; на настольной
/// версии его поднимает `npm run release`, здесь — тот же номер.
const CURRENT_BUILD: u64 = 51;

/// Что известно о новой версии.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileUpdate {
    /// Номер новой сборки.
    pub build: u64,
    /// Текущая сборка — чтобы интерфейс показал «было → стало».
    pub current_build: u64,
    /// Заметки к выпуску, если есть.
    pub notes: Option<String>,
    /// Прямая ссылка на APK.
    pub url: String,
    /// Размер файла в байтах, если сервер его сообщил.
    pub size: Option<u64>,
}

fn project() -> Result<(String, String), String> {
    crate::supabase::project_config()
}

/// Достаёт сборку из `version`: «52», «52-beta», 52 — всё сводится к числу.
fn build_from(value: &serde_json::Value) -> Option<u64> {
    let text = match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Number(number) => number.to_string(),
        _ => return None,
    };
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Проверяет, есть ли новая сборка. `None` — обновлений нет.
pub fn check() -> Result<Option<MobileUpdate>, String> {
    let (base, key) = project()?;
    let url = format!("{base}/storage/v1/object/public/updates/android.json");
    let response = match ureq::get(&url)
        .set("apikey", &key)
        .timeout(CHECK_TIMEOUT)
        .call()
    {
        Ok(response) => response,
        // Файла ещё нет — обычное состояние: мобильные обновления не публиковали.
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            let short: String = body.trim().chars().take(160).collect();
            return Err(format!("Сервер обновлений ответил {code}: {short}"));
        }
        Err(error) => return Err(format!("Сервер обновлений недоступен: {error}")),
    };

    let text = response
        .into_string()
        .map_err(|error| format!("Не удалось прочитать ответ: {error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "Сервер обновлений вернул не JSON".to_string())?;

    let build = value.get("version").and_then(build_from).unwrap_or(0);
    if build == 0 || build <= CURRENT_BUILD {
        return Ok(None);
    }

    // Ссылка: явная в файле или по имени APK в том же бакете.
    let file = value
        .get("file")
        .and_then(|v| v.as_str())
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.trim().replace(' ', "%20"))
        .unwrap_or_else(|| "Cursed%20Player.apk".to_string());
    let download = value
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{base}/storage/v1/object/public/updates/{file}"));

    Ok(Some(MobileUpdate {
        build,
        current_build: CURRENT_BUILD,
        notes: value
            .get("notes")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        url: download,
        size: value.get("size").and_then(|v| v.as_u64()),
    }))
}

/// Текущая сборка для интерфейса.
pub fn current_build() -> u64 {
    CURRENT_BUILD
}
