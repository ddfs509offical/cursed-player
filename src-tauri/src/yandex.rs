//! Вход в Яндекс по OAuth (Authorization Code) и проверка аккаунта.
//!
//! Зачем свой вход: токен, полученный из ссылки, часто принадлежит другому
//! аккаунту и не даёт ни Плюса, ни данных аккаунта. Через OAuth приложение
//! получает refresh-токен (продлевается само) и работает с тем аккаунтом,
//! в котором пользователь вошёл в браузере.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REDIRECT_PORT: u16 = 8898;
const WAIT_FOR_LOGIN: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YandexTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

/// Что видно про аккаунт по токену: есть ли Плюс и данные пользователя.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YandexAccount {
    pub has_plus: bool,
    pub has_music_subscription: bool,
    pub uid: Option<String>,
    pub display_name: Option<String>,
    /// Функциональная проверка: отдаёт ли Яндекс полный трек или фрагмент.
    pub stream_full: Option<bool>,
    pub note: String,
}

pub fn redirect_uri(host: &str) -> String {
    // Яндекс строго сверяет адрес возврата с зарегистрированным, поэтому
    // поддерживаем оба варианта: 127.0.0.1 и localhost.
    let host = if host.trim().eq_ignore_ascii_case("localhost") {
        "localhost"
    } else {
        "127.0.0.1"
    };
    format!("http://{host}:{REDIRECT_PORT}/callback")
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn token_request(form: &[(&str, &str)]) -> Result<YandexTokens, String> {
    let response = ureq::post("https://oauth.yandex.ru/token")
        .set("Content-Type", "application/x-www-form-urlencoded")
        .timeout(Duration::from_secs(30))
        .send_form(form)
        .map_err(|e| format!("Яндекс отклонил запрос токена: {e}"))?;
    let text = response.into_string().map_err(|e| e.to_string())?;
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "Непонятный ответ Яндекс OAuth".to_string())?;

    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Яндекс не вернул токен. Ответ: {}", text.chars().take(160).collect::<String>()))?
        .to_string();
    let expires_in = body.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(31_536_000);

    Ok(YandexTokens {
        access_token,
        refresh_token: body.get("refresh_token").and_then(|v| v.as_str()).map(str::to_string),
        expires_at: now_unix() + expires_in - 60,
    })
}

pub fn refresh(client_id: &str, client_secret: &str, refresh_token: &str) -> Result<YandexTokens, String> {
    token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ])
}

/// Открывает браузер, ловит код на локальном порту и меняет его на токены.
pub fn authorize(client_id: &str, client_secret: &str, host: &str) -> Result<YandexTokens, String> {
    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Err("Нужны Client ID и Client secret приложения Яндекса".into());
    }

    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .map_err(|e| format!("Порт {REDIRECT_PORT} занят: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let redirect = redirect_uri(host);
    let url = format!(
        "https://oauth.yandex.ru/authorize?response_type=code&client_id={}&redirect_uri={}",
        urlencode(client_id),
        urlencode(&redirect)
    );
    open::that(&url).map_err(|e| format!("Не удалось открыть браузер: {e}"))?;

    let deadline = Instant::now() + WAIT_FOR_LOGIN;
    let code = loop {
        if Instant::now() > deadline {
            return Err("Время ожидания входа истекло — попробуй ещё раз".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();

                let page = "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\">\
<title>Cursed player</title></head><body style=\"font-family:Segoe UI,sans-serif;background:#0b0b0e;\
color:#f2f2f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h2>Вход выполнен</h2><p style=\"color:#9a9aa5\">\
Можно закрыть эту вкладку и вернуться в Cursed player.</p></div></body></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    page.as_bytes().len(),
                    page
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();

                if let Some(error) = query_param(&path, "error") {
                    return Err(format!("Яндекс вернул ошибку: {error}"));
                }
                match query_param(&path, "code") {
                    Some(code) => break code,
                    None => continue,
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("Ошибка локального сервера входа: {e}")),
        }
    };

    token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ])
}

/// Что известно про аккаунт: Плюс, подписка и uid (если токен это отдаёт).
pub fn account_info(token: &str) -> Result<YandexAccount, String> {
    let auth = format!("OAuth {}", token.trim());

    let about = crate::services::get_json(
        "https://api.music.yandex.net/account/about",
        Some(("Authorization", &auth)),
    );
    let status = crate::services::get_json(
        "https://api.music.yandex.net/account/status",
        Some(("Authorization", &auth)),
    );

    if about.is_err() && status.is_err() {
        return Err(about.err().unwrap_or_else(|| "Нет ответа от Яндекса".into()));
    }

    let has_plus = about
        .as_ref()
        .ok()
        .and_then(|body| body.get("result")?.get("hasPlus")?.as_bool())
        .unwrap_or(false);
    let has_music_subscription = about
        .as_ref()
        .ok()
        .and_then(|body| body.get("result")?.get("hasMusicSubscription")?.as_bool())
        .unwrap_or(false);
    let uid = status
        .as_ref()
        .ok()
        .and_then(|body| body.pointer("/result/account/uid"))
        .map(|v| v.to_string().trim_matches('"').to_string());
    let display_name = status
        .as_ref()
        .ok()
        .and_then(|body| body.pointer("/result/account/displayName"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    // Проверяем не только флаги аккаунта, но и то, что реально отдаёт поток:
    // именно это определяет, будут ли треки целиком или по 30 секунд.
    let stream_full = crate::services::search("yandex", token, "кино")
        .ok()
        .and_then(|tracks| tracks.into_iter().next())
        .and_then(|track| crate::services::yandex_track_url(token, &track.id).ok())
        .map(|info| !info.preview);

    let note = match stream_full {
        Some(true) => "Яндекс отдаёт полные треки — воспроизведение работает целиком".to_string(),
        Some(false) => {
            if has_plus || has_music_subscription {
                "Плюс есть, но поток приходит 30-секундным: Яндекс отдаёт полное аудио только своим клиентам"
                    .to_string()
            } else {
                "Поток 30-секундный: на аккаунте нет активного Плюса".to_string()
            }
        }
        None => {
            if uid.is_none() {
                "Не удалось проверить поток, и токен не даёт данных аккаунта — войди через Client ID".to_string()
            } else {
                "Не удалось проверить поток — попробуй ещё раз".to_string()
            }
        }
    };

    Ok(YandexAccount {
        has_plus,
        has_music_subscription,
        uid,
        display_name,
        stream_full,
        note,
    })
}

fn query_param(path: &str, name: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        if key == name {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_points_to_local_port() {
        assert_eq!(redirect_uri("127.0.0.1"), "http://127.0.0.1:8898/callback");
        assert_eq!(redirect_uri("localhost"), "http://localhost:8898/callback");
        // Незнакомое значение не должно ломать адрес
        assert_eq!(redirect_uri("что-то ещё"), "http://127.0.0.1:8898/callback");
    }

    #[test]
    fn query_params_are_parsed() {
        assert_eq!(query_param("/callback?code=abc&state=x", "code").as_deref(), Some("abc"));
        assert_eq!(query_param("/callback?error=access_denied", "error").as_deref(), Some("access_denied"));
        assert_eq!(query_param("/callback", "code"), None);
    }

    #[test]
    fn empty_credentials_are_rejected() {
        let error = authorize("", "", "127.0.0.1").unwrap_err();
        assert!(error.contains("Client ID"), "получили: {error}");
    }

    #[test]
    fn authorize_url_is_encoded() {
        assert_eq!(urlencode("http://127.0.0.1:8898/callback"), "http%3A%2F%2F127.0.0.1%3A8898%2Fcallback");
    }
}
