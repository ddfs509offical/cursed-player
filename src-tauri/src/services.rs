//! Поиск и плейлисты через подключённые сервисы.
//!
//! Токен приходит из интерфейса (он хранится у пользователя), поэтому здесь
//! нет ни своей базы токенов, ни OAuth: команда просто ходит в API сервиса.
//!
//! Spotify — официальный Web API. Яндекс.Музыка — публичный API клиента
//! (тот же, которым пользуется официальное приложение). VK с 2021 не отдаёт
//! музыку через API, поэтому честно сообщаем об этом.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTrack {
    pub id: String,
    pub title: String,
    pub artists: String,
    pub album: Option<String>,
    pub duration_ms: i64,
    pub cover: Option<String>,
    pub service: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePlaylist {
    pub id: String,
    pub title: String,
    pub track_count: i64,
    pub cover: Option<String>,
    pub service: String,
}

/// Токен может прийти с префиксом («OAuth », «Bearer »), в кавычках или
/// с переносами строк — сервис на такое отвечает 401.
fn normalize_token(raw: &str) -> String {
    let mut value = raw.trim().trim_matches(['"', '\'', '`']).trim().to_string();
    // Иногда копируют целиком строку заголовка
    for label in ["Authorization:", "authorization:"] {
        if let Some(rest) = value.strip_prefix(label) {
            value = rest.trim().to_string();
            break;
        }
    }
    for prefix in ["OAuth ", "oauth ", "Bearer ", "bearer "] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.trim().to_string();
            break;
        }
    }
    value.chars().filter(|c| !c.is_whitespace()).collect()
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

pub fn get_json(url: &str, auth: Option<(&str, &str)>) -> Result<serde_json::Value, String> {
    let mut request = ureq::get(url)
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(20));
    if let Some((header, value)) = auth {
        request = request.set(header, value);
    }
    let response = request.call().map_err(|e| match e {
        ureq::Error::Status(401, _) => "Токен не подошёл или истёк — подключи сервис заново".to_string(),
        ureq::Error::Status(403, _) => "Сервис отказал: проверь права токена".to_string(),
        ureq::Error::Status(code, _) => format!("Сервис ответил ошибкой {code}"),
        other => format!("Нет связи с сервисом: {other}"),
    })?;
    let text = response.into_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|_| "Сервис вернул неожиданный ответ".to_string())
}

/// Яндекс отдаёт обложки шаблоном со `%%` — подставляем размер.
fn yandex_cover(uri: &str) -> Option<String> {
    if uri.is_empty() {
        return None;
    }
    Some(format!("https://{}", uri.replace("%%", "400x400")))
}

fn yandex_search(token: &str, query: &str) -> Result<Vec<SearchTrack>, String> {
    let url = format!(
        "https://api.music.yandex.net/search?text={}&type=track&page=0&nocorrect=false",
        urlencode(query)
    );
    let body = get_json(&url, Some(("Authorization", &format!("OAuth {token}"))))?;

    let items = body
        .pointer("/result/tracks/results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .map(|item| {
            let artists = item
                .get("artists")
                .and_then(|v| v.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            SearchTrack {
                id: item.get("id").map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default(),
                title: item.get("title").and_then(|v| v.as_str()).unwrap_or("Без названия").to_string(),
                artists,
                album: item
                    .pointer("/albums/0/title")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                duration_ms: item.get("durationMs").and_then(|v| v.as_i64()).unwrap_or(0),
                cover: item
                    .get("coverUri")
                    .and_then(|v| v.as_str())
                    .and_then(yandex_cover),
                service: "yandex".into(),
            }
        })
        .filter(|track| !track.title.is_empty())
        .collect())
}

fn yandex_uid(token: &str) -> Result<String, String> {
    let body = get_json(
        "https://api.music.yandex.net/account/status",
        Some(("Authorization", &format!("OAuth {token}"))),
    )?;
    body.pointer("/result/account/uid")
        .map(|v| v.to_string().trim_matches('"').to_string())
        .filter(|uid| !uid.is_empty())
        .ok_or_else(|| {
            "у токена нет доступа к данным аккаунта (в ответе нет uid) — для плейлистов нужен токен \
             с правами на аккаунт, поиск при этом работает"
                .to_string()
        })
}

fn yandex_playlists(token: &str) -> Result<Vec<ServicePlaylist>, String> {
    let uid = yandex_uid(token)?;
    let url = format!("https://api.music.yandex.net/users/{uid}/playlists");
    let body = get_json(&url, Some(("Authorization", &format!("OAuth {token}"))))?;
    let items = body
        .get("result")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .map(|item| ServicePlaylist {
            id: item
                .get("kind")
                .map(|v| v.to_string().trim_matches('"').to_string())
                .unwrap_or_default(),
            title: item.get("title").and_then(|v| v.as_str()).unwrap_or("Плейлист").to_string(),
            track_count: item.get("trackCount").and_then(|v| v.as_i64()).unwrap_or(0),
            cover: item
                .pointer("/cover/uri")
                .and_then(|v| v.as_str())
                .and_then(yandex_cover),
            service: "yandex".into(),
        })
        .collect())
}

fn spotify_search(token: &str, query: &str) -> Result<Vec<SearchTrack>, String> {
    let url = format!(
        "https://api.spotify.com/v1/search?q={}&type=track&limit=20&market=from_token",
        urlencode(query)
    );
    let body = get_json(&url, Some(("Authorization", &format!("Bearer {token}"))))?;
    let items = body
        .pointer("/tracks/items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .map(|item| SearchTrack {
            id: item.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            title: item.get("name").and_then(|v| v.as_str()).unwrap_or("Без названия").to_string(),
            artists: item
                .get("artists")
                .and_then(|v| v.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default(),
            album: item.pointer("/album/name").and_then(|v| v.as_str()).map(str::to_string),
            duration_ms: item.get("duration_ms").and_then(|v| v.as_i64()).unwrap_or(0),
            cover: item
                .pointer("/album/images/0/url")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            service: "spotify".into(),
        })
        .collect())
}

fn spotify_playlists(token: &str) -> Result<Vec<ServicePlaylist>, String> {
    let body = get_json(
        "https://api.spotify.com/v1/me/playlists?limit=50",
        Some(("Authorization", &format!("Bearer {token}"))),
    )?;
    let items = body
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .map(|item| ServicePlaylist {
            id: item.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            title: item.get("name").and_then(|v| v.as_str()).unwrap_or("Плейлист").to_string(),
            track_count: item.pointer("/tracks/total").and_then(|v| v.as_i64()).unwrap_or(0),
            cover: item
                .pointer("/images/0/url")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            service: "spotify".into(),
        })
        .collect())
}

const VK_HINT: &str = "VK с 2021 не отдаёт музыку через API — подключи Яндекс Музыку или Spotify";

fn tag_value(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].to_string())
}

fn md5_hex(value: &str) -> String {
    use md5::{Digest, Md5};
    let digest = Md5::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub url: String,
    /// true — Яндекс отдал только 30-секундный фрагмент (нет активного Плюса)
    pub preview: bool,
}

/// Прямая ссылка на mp3-поток трека. Без активного Плюса Яндекс отдаёт
/// 30-секундный фрагмент — сообщаем об этом флагом, а не молчим.
pub fn yandex_track_url(token: &str, track_id: &str) -> Result<StreamInfo, String> {
    let token = normalize_token(token);
    if token.is_empty() {
        return Err("Сервис не подключён: вставь токен в настройках".into());
    }

    let url = format!("https://api.music.yandex.net/tracks/{track_id}/download-info");
    let body = get_json(&url, Some(("Authorization", &format!("OAuth {token}"))))?;
    let infos = body
        .get("result")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Яндекс не отдал ссылку на поток".to_string())?;

    let is_mp3 = |item: &&serde_json::Value| item.get("codec").and_then(|v| v.as_str()) == Some("mp3");
    let is_preview = |item: &&serde_json::Value| item.get("preview").and_then(|v| v.as_bool()) == Some(true);
    let bitrate = |item: &&serde_json::Value| item.get("bitrate").and_then(|v| v.as_i64()).unwrap_or(0);

    // Сначала полный трек, потом любой mp3, потом что угодно
    let best = infos
        .iter()
        .filter(is_mp3)
        .filter(|item| !is_preview(item))
        .max_by_key(bitrate)
        .or_else(|| infos.iter().filter(is_mp3).max_by_key(bitrate))
        .or_else(|| infos.iter().max_by_key(bitrate))
        .ok_or_else(|| "Нет доступных вариантов потока".to_string())?;

    let preview = is_preview(&best);
    let info_url = best
        .get("downloadInfoUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Яндекс не вернул downloadInfoUrl".to_string())?;

    let xml = ureq::get(info_url)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| format!("Нет доступа к потоку: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;

    let host = tag_value(&xml, "host").ok_or_else(|| "В ответе нет host".to_string())?;
    let path = tag_value(&xml, "path").ok_or_else(|| "В ответе нет path".to_string())?;
    let ts = tag_value(&xml, "ts").ok_or_else(|| "В ответе нет ts".to_string())?;
    let salt = tag_value(&xml, "s").ok_or_else(|| "В ответе нет s".to_string())?;

    // Классическая подпись клиента Яндекс.Музыки
    let sign = md5_hex(&format!("XGRlBW9FXlekgbPrRHuSiA{}{}", path.trim_start_matches('/'), salt));
    Ok(StreamInfo {
        url: format!("https://{host}/get-mp3/{sign}/{ts}{path}"),
        preview,
    })
}

pub fn search(service: &str, token: &str, query: &str) -> Result<Vec<SearchTrack>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let token = normalize_token(token);
    if token.is_empty() {
        return Err("Сервис не подключён: вставь токен в настройках".into());
    }
    match service {
        "yandex" => yandex_search(&token, query),
        "spotify" => spotify_search(&token, query),
        "vk" => Err(VK_HINT.into()),
        other => Err(format!("Неизвестный сервис: {other}")),
    }
}

pub fn playlists(service: &str, token: &str) -> Result<Vec<ServicePlaylist>, String> {
    let token = normalize_token(token);
    if token.is_empty() {
        return Err("Сервис не подключён: вставь токен в настройках".into());
    }
    match service {
        "yandex" => yandex_playlists(&token),
        "spotify" => spotify_playlists(&token),
        "vk" => Err(VK_HINT.into()),
        other => Err(format!("Неизвестный сервис: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_get_size_substituted() {
        let uri = "avatars.yandex.net/get-music-content/1234/abc/%%";
        assert_eq!(
            yandex_cover(uri).as_deref(),
            Some("https://avatars.yandex.net/get-music-content/1234/abc/400x400")
        );
        assert_eq!(yandex_cover(""), None);
    }

    #[test]
    fn empty_token_is_reported_not_sent() {
        let error = search("yandex", "", "кино").unwrap_err();
        assert!(error.contains("не подключён"), "получили: {error}");
    }

    #[test]
    fn vk_is_honest_about_limits() {
        let error = search("vk", "token", "кино").unwrap_err();
        assert!(error.contains("2021"), "получили: {error}");
    }

    #[test]
    fn empty_query_returns_nothing() {
        assert!(search("yandex", "token", "   ").unwrap().is_empty());
    }

    #[test]
    fn query_is_url_encoded() {
        assert_eq!(urlencode("кино и немцы"), "%D0%BA%D0%B8%D0%BD%D0%BE+%D0%B8+%D0%BD%D0%B5%D0%BC%D1%86%D1%8B");
    }

    #[test]
    fn tokens_are_normalized() {
        assert_eq!(normalize_token("  y0_AgAAAA  "), "y0_AgAAAA");
        assert_eq!(normalize_token("OAuth y0_AgAAAA"), "y0_AgAAAA");
        assert_eq!(normalize_token("Bearer abc.def"), "abc.def");
        assert_eq!(normalize_token("\"y0_AgAAAA\"\n"), "y0_AgAAAA");
        assert_eq!(normalize_token("Authorization: OAuth y0_AgAAAA"), "y0_AgAAAA");
    }
}
