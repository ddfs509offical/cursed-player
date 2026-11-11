//! Синхронизация через Supabase: транспорт, авторизация, сессия и профили.
//!
//! Адрес проекта и публичный ключ обычно вшиты в сборку (это публичные данные,
//! они всё равно лежат в клиенте): обычный пользователь ничего не вводит.
//! Ручная настройка остаётся только для разработки. Пароль не хранится
//! никогда: после входа остаются только токены.
//!
//! Ключ проекта — публичный ключ новой системы Supabase
//! (`sb_publishable_…`; тот же слот, где раньше был anon-JWT). Он уходит
//! только в заголовке `apikey` и никогда в `Authorization`: в `Authorization`
//! место исключительно пользовательскому `Bearer <access_token>`. Секретные
//! ключи (`sb_secret_…`, старый `service_role`) в клиент не попадают вообще.
//!
//! Сеть — через общий транспорт приложения (`crate::net`): основной путь —
//! постоянный HTTP-клиент с keep-alive, запасной — `curl` с DNS over HTTPS и
//! `ureq`, как в `soundcloud` и `lyrics`. Своего транспорта не заводим.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

// ---------- Транспорт ----------

const DOH_URL: &str = "https://1.1.1.1/dns-query";
const USER_AGENT: &str = "Cursed player/1.0";
/// `--ssl-no-revoke` понимает только Schannel (сборка curl для Windows),
/// поэтому на других платформах флаг не подставляем — как в `lyrics.rs`.
#[cfg(windows)]
const SSL_NO_REVOKE: &str = "--ssl-no-revoke";
#[cfg(not(windows))]
const SSL_NO_REVOKE: &str = "-k";

/// Бюджет времени на один запрос — как у соседних модулей.
const TIME_BUDGET: Duration = Duration::from_secs(20);

/// Обращение к Supabase: адрес, заголовки и необязательное тело JSON.
/// Вынесено отдельной структурой, чтобы аргументы curl можно было проверить
/// тестом без сети.
#[derive(Debug, Clone, PartialEq)]
struct Request {
    method: &'static str,
    url: String,
    headers: Vec<(String, String)>,
    /// Тело POST как JSON (для sync_push — массив строк).
    body: Option<serde_json::Value>,
    /// В теле есть пароль или refresh-токен: такое тело нельзя класть в
    /// командную строку — curl прочитает его со стандартного ввода
    /// (`--data-binary @-`), и в списке процессов его не будет.
    secret: bool,
}

impl Request {
    fn get(url: impl Into<String>) -> Self {
        Self {
            method: "GET",
            url: url.into(),
            headers: Vec::new(),
            body: None,
            secret: false,
        }
    }

    fn post_json(url: impl Into<String>, body: serde_json::Value) -> Self {
        Self {
            method: "POST",
            url: url.into(),
            headers: Vec::new(),
            body: Some(body),
            secret: false,
        }
    }

    /// Вход, регистрация и обновление токена: тело уходит через stdin.
    fn post_secret(url: impl Into<String>, body: serde_json::Value) -> Self {
        Self { secret: true, ..Self::post_json(url, body) }
    }

    fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    fn is_post(&self) -> bool {
        self.body.is_some()
    }

    /// Заголовок типа содержимого уже задан явно? Тогда второй раз не ставим.
    fn has_json_content_type(&self) -> bool {
        self.headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("Content-Type"))
    }

    /// Тело как байты: либо для stdin, либо для аргумента curl.
    fn body_bytes(&self) -> Option<Vec<u8>> {
        self.body.as_ref().map(|body| body.to_string().into_bytes())
    }

    /// То же обращение для постоянного клиента: адрес, заголовки и тело.
    /// Секретное тело остаётся внутри процесса — командной строки оно не
    /// касается вовсе.
    fn as_http(&self) -> crate::net::HttpRequest {
        let mut http = if self.is_post() {
            crate::net::HttpRequest::post(self.url.clone(), self.body_bytes().unwrap_or_default())
        } else {
            crate::net::HttpRequest::get(self.url.clone())
        };
        http = http.user_agent(USER_AGENT);
        for (name, value) in &self.headers {
            http = http.header(name, value);
        }
        if self.secret {
            http = http.secret();
        }
        http
    }
}

/// Проект опознаётся заголовком `apikey` с публичным ключом. Только он и
/// нужен анонимным запросам (`/auth/v1/health`, `/auth/v1/signup`,
/// `/auth/v1/token`): тело там несёт пароль или refresh-токен, а `access_token`
/// ещё не выдан. Публичный ключ в роли `Bearer` сервер отвергнет — поэтому
/// `Authorization` здесь не появляется.
fn with_project_key(request: Request, anon_key: &str) -> Request {
    request.header("apikey", anon_key)
}

/// Запрос к данным (`/rest/v1/*`) от имени вошедшего: нужны ОБА заголовка —
/// `apikey` с публичным ключом проекта (какой это проект) и
/// `Authorization: Bearer <access_token>` (чей это пользователь). Без второго
/// PostgREST увидит анонима и правила RLS не пустят к строкам.
fn with_session(request: Request, anon_key: &str, access_token: &str) -> Request {
    with_project_key(request, anon_key)
        .header("Authorization", &format!("Bearer {access_token}"))
}

fn curl_args(request: &Request, timeout: Duration) -> Vec<String> {
    let seconds = timeout.as_secs().max(1).to_string();
    let mut args: Vec<String> =
        vec!["-sS".into(), "--max-time".into(), seconds, "-X".into(), request.method.into()];

    args.push(SSL_NO_REVOKE.into());
    args.push("--doh-url".into());
    args.push(DOH_URL.into());
    // Прокси выбранного маршрута: при «напрямую» аргументов нет.
    args.extend(crate::net::curl_route_args());
    args.push("-A".into());
    args.push(USER_AGENT.into());

    for (name, value) in &request.headers {
        args.push("-H".into());
        args.push(format!("{name}: {value}"));
    }

    if let Some(body) = &request.body {
        args.push("-H".into());
        args.push("Content-Type: application/json".into());
        args.push("--data-binary".into());
        args.push(if request.secret {
            // Дефис после @ — «читать со стандартного ввода»: ни пароль, ни
            // refresh-токен не попадают в командную строку и список процессов.
            SECRET_BODY.into()
        } else {
            body.to_string()
        });
    }

    // Код состояния нужен отдельно: по нему выбираем текст ошибки.
    args.push("-w".into());
    args.push("\n%{http_code}".into());
    args.push(request.url.clone());
    args
}

/// Значение `--data-binary` для запросов с паролем: тело придёт через stdin.
const SECRET_BODY: &str = "@-";

/// Аргументы запасного пути: их проверяет тест, чтобы флаги не разошлись
/// с основным транспортом.
fn ureq_args(request: &Request, timeout: Duration) -> Vec<String> {
    let mut args: Vec<String> =
        vec!["--max-time".into(), timeout.as_secs().max(1).to_string(), "-A".into(), USER_AGENT.into()];
    for (name, value) in &request.headers {
        args.push("-H".into());
        args.push(format!("{name}: {value}"));
    }
    if request.is_post() {
        args.push("--json".into());
    }
    args
}

/// Запасной транспорт: без DoH, поэтому код состояния и тело достаём из
/// ответа самого ureq, а не из хвоста вывода curl.
fn send_via_ureq(request: &Request, timeout: Duration) -> Result<Response, String> {
    let mut call = if request.method == "GET" {
        ureq::get(&request.url)
    } else {
        ureq::post(&request.url)
    };
    for (name, value) in &request.headers {
        call = call.set(name, value);
    }
    // Секретное тело идёт через stdin, и Content-Type ему curl ставит сам;
    // в запасном пути его выставляем руками — иначе Supabase не разберёт JSON.
    if request.is_post() && !request.has_json_content_type() {
        call = call.set("Content-Type", "application/json");
    }
    call = call.timeout(timeout);

    let outcome = match &request.body {
        Some(body) => call.send_json(body.clone()),
        None => call.call(),
    };

    match outcome {
        Ok(response) => {
            let code = response.status();
            let text = response.into_string().map_err(|e| e.to_string())?;
            Ok(Response { code, text })
        }
        Err(ureq::Error::Status(code, response)) => Ok(Response {
            code,
            text: response.into_string().unwrap_or_default(),
        }),
        Err(error) => Err(error.to_string()),
    }
}

/// Ответ сервера: код состояния и тело как строка.
#[derive(Debug, Clone)]
struct Response {
    code: u16,
    text: String,
}

/// Разбор того, что вернул curl: `-w '\n%{http_code}'` дописал код в конец.
fn split_curl_reply(raw: &str) -> Response {
    let (body, code) = match raw.rsplit_once('\n') {
        Some((body, code)) => (body, code.trim()),
        None => (raw, ""),
    };
    Response {
        code: code.parse::<u16>().unwrap_or(0),
        text: body.trim_end_matches(&['\r', '\n'][..]).to_string(),
    }
}

/// curl с телом на стандартном вводе. Тело пишет отдельный поток: пока curl
/// отвечает, мы уже не обязаны дописывать ему ввод, иначе большой ответ упёрся
/// бы в заполненную трубу и оба процесса замерли бы.
fn run_curl_with_stdin(args: &[String], body: Vec<u8>) -> Option<Response> {
    let mut child = crate::silent::hidden("curl")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&body);
        let _ = stdin.flush();
        // Дескриптор закрывается вместе с потоком: curl увидит конец файла.
    });

    let output = child.wait_with_output().ok()?;
    let _ = writer.join();

    output
        .status
        .success()
        .then(|| split_curl_reply(&String::from_utf8_lossy(&output.stdout)))
}

/// Один запрос: постоянный клиент, затем curl с DoH, затем ureq. Возвращаем
/// код состояния и тело — решение о том, ошибка это или нет, принимает
/// вызывающий код.
fn send(request: &Request) -> Result<Response, String> {
    if !request.url.starts_with("https://") && !request.url.starts_with("http://") {
        return Err("Адрес проекта должен начинаться с https://".into());
    }

    // 1. Основной путь — постоянный HTTP-клиент приложения: соединение и DNS
    // переиспользуются, поэтому вход и синхронизация не платят за новый TLS
    // на каждый запрос. Тело (в том числе пароль) остаётся в процессе.
    if let Ok(response) = crate::net::http(&request.as_http()) {
        return Ok(Response {
            code: response.code,
            text: response.text,
        });
    }

    // 2. Запасной путь: curl с DoH (подмена DNS провайдером) и ureq.
    let args = curl_args(request, TIME_BUDGET);
    // Тело с паролем уходит только через stdin; всё остальное — аргументом,
    // как в соседних модулях.
    let curl_result = if request.secret {
        request
            .body_bytes()
            .and_then(|body| run_curl_with_stdin(&args, body))
    } else {
        crate::silent::hidden("curl")
            .args(&args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| split_curl_reply(&String::from_utf8_lossy(&output.stdout)))
    };

    // Запасной путь: curl нет, stdin не поднялся или DoH не сработал.
    // У ureq тело и так внутри процесса, командной строки оно не касается.
    match curl_result {
        Some(response) => Ok(response),
        None => send_via_ureq(request, TIME_BUDGET).map_err(|_| "Нет сети".to_string()),
    }
}

/// Короткое описание неудачи Supabase. Отдельной функцией — её проверяют тесты.
fn apply_error(code: u16, text: &str) -> String {
    let body: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Null);
    // Код ошибки Supabase кладёт то в `error_code`, то в `error` — смотрим оба,
    // а если кода нет, читаем текст сообщения.
    let error_code = body
        .get("error_code")
        .or_else(|| body.get("error"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let message = body
        .get("error_description")
        .or_else(|| body.get("msg"))
        .or_else(|| body.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let lower = message.to_lowercase();

    match code {
        0 => "Нет сети".into(),
        // Регистрация закрыта триггером на `auth.users`: пока проект в бете,
        // GoTrue прячет текст исключения и отдаёт общее «database error saving
        // new user» — узнаём его и переводим на человеческий.
        400 | 422 | 500
            if lower.contains("database error saving new user")
                || lower.contains("registration_closed")
                || lower.contains("registration is closed") =>
        {
            REGISTRATION_CLOSED.into()
        }
        400 | 401 if error_code == "invalid_grant" || error_code == "invalid_credentials" => {
            "Неверный email или пароль".into()
        }
        400 | 422 if error_code == "user_already_exists" || lower.contains("already registered") => {
            "Пользователь уже существует".into()
        }
        400 if error_code == "weak_password" => "Пароль слишком простой".into(),
        // Код не пришёл, но текст ошибки однозначен
        400 | 401 if lower.contains("invalid login credentials") => {
            "Неверный email или пароль".into()
        }
        422 => "Пользователь уже существует".into(),
        401 | 403 => "Ключ или адрес проекта неверны".into(),
        _ => {
            let text = text.trim();
            let head: String = text.chars().take(200).collect();
            if head.is_empty() {
                format!("Supabase ответил {code}")
            } else {
                format!("Supabase ответил {code}: {head}")
            }
        }
    }
}

/// Ответ, который считаем успешным: 2xx и, если тело есть, разобранный JSON.
fn json_of(response: &Response) -> Result<serde_json::Value, String> {
    if !(200..300).contains(&response.code) {
        return Err(apply_error(response.code, &response.text));
    }
    if response.text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&response.text).map_err(|_| "Supabase вернул неожиданный ответ".to_string())
}

// ---------- Сессия ----------

/// Возвращает пустой Option, если строка пуста или это не цифры.
fn option_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Сохранённая сессия: всё, что нужно, чтобы повторить запрос без пароля.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Session {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub anon_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix-миллисекунды, до которых действует access-токен.
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default)]
    pub last_sync_ms: i64,
}

impl Session {
    /// Настроен ли проект: без адреса и ключа ни один запрос не имеет смысла.
    fn configured(&self) -> bool {
        !self.url.trim().is_empty() && !self.anon_key.trim().is_empty()
    }

    fn signed_in(&self) -> bool {
        self.refresh_token
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    }

    /// Битую или частично заполненную запись приводим к осмысленному виду:
    /// отсутствующие поля — пустые, а не ошибка чтения.
    fn repaired(mut self) -> Self {
        self.url = self.url.trim().trim_end_matches('/').to_string();
        self.anon_key = self.anon_key.trim().to_string();
        self.access_token = self.access_token.and_then(|v| option_string(Some(&v)));
        self.refresh_token = self.refresh_token.and_then(|v| option_string(Some(&v)));
        self.email = self.email.and_then(|v| option_string(Some(&v)));
        self.user_id = self.user_id.and_then(|v| option_string(Some(&v)));
        if self.last_sync_ms < 0 {
            self.last_sync_ms = 0;
        }
        self
    }

    /// Прочитать запись из JSON. Битый файл не паникует: считаем, что настроек
    /// нет, — пользователь настроит проект заново.
    fn from_json(text: &str) -> Self {
        let text = text.trim_start_matches('\u{feff}');
        serde_json::from_str::<Session>(text)
            .unwrap_or_default()
            .repaired()
    }

    fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into())
    }
}

/// Папка данных приложения: на каждой платформе своя.
///
/// Раньше путь собирался из %APPDATA%, и на Android это давало ошибку:
/// там такой переменной нет. Теперь папку спрашиваем у Tauri — он знает
/// её на Windows (~/AppData/Roaming/com.example.musichub) и на Android
/// (/data/user/0/com.example.musichub/files).
fn data_dir() -> Result<PathBuf, String> {
    use tauri::Manager;
    let app = crate::app_handle()
        .ok_or_else(|| "Приложение ещё не готово: нет окна для папки данных".to_string())?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Не удалось определить папку данных приложения: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку данных: {e}"))?;
    Ok(dir)
}

/// Файл сессии синхронизации в папке данных приложения.
pub fn session_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("sync.json"))
}

fn read_session_from(path: &Path) -> Session {
    match std::fs::read_to_string(path) {
        Ok(text) => Session::from_json(&text),
        Err(_) => Session::default(),
    }
}

/// Запись настройки: обычный файл рядом с профилями, только токены,
/// никаких паролей. Пустая папка создаётся при необходимости.
fn write_session_to(path: &Path, session: &Session) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать папку данных: {e}"))?;
    }
    std::fs::write(path, session.to_json())
        .map_err(|e| format!("Не удалось сохранить настройки синхронизации: {e}"))
}

fn load() -> Result<Session, String> {
    Ok(read_session_from(&session_path()?))
}

fn store(session: &Session) -> Result<(), String> {
    write_session_to(&session_path()?, session)
}

// ---------- Статус ----------

/// Состояние синхронизации для интерфейса.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl SyncStatus {
    fn of(session: &Session) -> Self {
        Self {
            configured: session.configured(),
            signed_in: session.signed_in(),
            email: session.email.clone(),
            user_id: session.user_id.clone(),
            last_sync_at_ms: (session.last_sync_ms > 0).then_some(session.last_sync_ms),
            last_error: None,
        }
    }

    fn with_error(mut self, error: &str) -> Self {
        self.last_error = Some(error.to_string());
        self
    }
}

// ---------- Обновление токена ----------

/// За сколько до истечения обновляем токен: запрос должен успеть пройти,
/// пока старый ещё действует.
const REFRESH_MARGIN_MS: i64 = 60_000;

/// Момент, с которого токен считается протухшим (expires_at минус запас).
fn refresh_at_ms(expires_at: i64) -> i64 {
    expires_at.saturating_sub(REFRESH_MARGIN_MS)
}

/// Пора ли обновлять токен: пустой или просроченный токен — пора.
fn needs_refresh(expires_at: i64, now_ms: i64) -> bool {
    expires_at <= 0 || now_ms >= refresh_at_ms(expires_at)
}

/// Unix-миллисекунды из времени ответа: `expires_in` в секундах, либо
/// `expires_at` в секундах (его отдаёт refresh_token), либо запасные сутки.
fn expires_at_ms(body: &serde_json::Value, now_ms: i64) -> i64 {
    if let Some(seconds) = body.get("expires_in").and_then(|v| v.as_i64()) {
        return now_ms + seconds.saturating_mul(1000);
    }
    if let Some(seconds) = body.get("expires_at").and_then(|v| v.as_i64()) {
        return seconds.saturating_mul(1000);
    }
    now_ms + 3_600_000
}

/// Что делать после запроса авторизации. Отдельной функцией — её проверяют тесты
/// без сети: и успех, и «нужно подтвердить почту», и отказ.
#[derive(Debug)]
enum AuthOutcome {
    Tokens(Box<Session>),
    /// Пользователь создан, но сессии нет: Supabase ждёт подтверждения почты.
    ConfirmEmail,
}

fn auth_outcome(
    body: &serde_json::Value,
    url: &str,
    anon_key: &str,
    fallback_email: &str,
    now_ms: i64,
) -> Result<AuthOutcome, String> {
    let access_token = body.get("access_token").and_then(|v| v.as_str());
    let refresh_token = body.get("refresh_token").and_then(|v| v.as_str());

    // При регистрации пользователь приходит либо вложенным в `user`, либо
    // прямо в корне ответа (зависит от версии Supabase).
    let user = body.get("user").filter(|value| value.is_object());
    let email = option_string(user.and_then(|u| u.get("email")).and_then(|v| v.as_str()))
        .or_else(|| option_string(body.get("email").and_then(|v| v.as_str())))
        .or_else(|| option_string(Some(fallback_email)));
    let user_id = option_string(user.and_then(|u| u.get("id")).and_then(|v| v.as_str()))
        .or_else(|| option_string(body.get("id").and_then(|v| v.as_str())));

    match access_token {
        Some(access) if !access.trim().is_empty() => Ok(AuthOutcome::Tokens(Box::new(Session {
            url: url.trim_end_matches('/').to_string(),
            anon_key: anon_key.to_string(),
            access_token: Some(access.trim().to_string()),
            refresh_token: refresh_token.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string),
            expires_at: expires_at_ms(body, now_ms),
            email,
            user_id,
            last_sync_ms: 0,
        }))),
        // Токенов нет, но пользователь есть: включено подтверждение почты.
        _ if user.is_some() || user_id.is_some() => Ok(AuthOutcome::ConfirmEmail),
        _ => Err("Supabase не выдал токен доступа".into()),
    }
}

/// Обновление токена по refresh_token. Ошибка означает одно: сессия кончилась,
/// и пользователь должен войти заново — токены убираем, пароль не спрашиваем.
fn refresh(session: &mut Session) -> Result<(), String> {
    let refresh_token = session
        .refresh_token
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Сессия истекла, войди заново".to_string())?;

    let url = format!("{}/auth/v1/token?grant_type=refresh_token", session.url);
    let request = with_project_key(
        Request::post_secret(url, serde_json::json!({ "refresh_token": refresh_token })),
        &session.anon_key,
    );
    let response = send(&request)?;

    let body = match json_of(&response) {
        Ok(body) => body,
        Err(error) => {
            session.access_token = None;
            session.refresh_token = None;
            session.expires_at = 0;
            let _ = store(session);
            return Err(error);
        }
    };

    let now = crate::db_now_ms();
    let emitted = auth_outcome(&body, &session.url, &session.anon_key, "", now)
        .map_err(|error| {
            session.access_token = None;
            session.refresh_token = None;
            session.expires_at = 0;
            let _ = store(session);
            error
        })?;

    match emitted {
        AuthOutcome::Tokens(fresh) => {
            session.access_token = fresh.access_token;
            // Новый refresh-токен заменяет старый; если его не прислали —
            // оставляем прежний, иначе вход потеряется на ровном месте.
            if fresh.refresh_token.is_some() {
                session.refresh_token = fresh.refresh_token;
            }
            session.expires_at = fresh.expires_at;
            if session.email.as_deref().unwrap_or("").is_empty() {
                session.email = fresh.email;
            }
            if session.user_id.as_deref().unwrap_or("").is_empty() {
                session.user_id = fresh.user_id;
            }
            store(session)?;
            Ok(())
        }
        AuthOutcome::ConfirmEmail => Err("Сессия истекла, войди заново".into()),
    }
}

/// Токен для запросов к данным: обновляем заранее, а не после отказа.
fn access_token(session: &mut Session) -> Result<String, String> {
    if !session.signed_in() {
        return Err("Сессия истекла, войди заново".into());
    }
    if needs_refresh(session.expires_at, crate::db_now_ms()) {
        refresh(session)?;
    }
    session
        .access_token
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Сессия истекла, войди заново".to_string())
}

// ---------- Время и адрес ----------

/// Момент `since_ms` в виде ISO-8601 (UTC) — в таком виде Supabase сравнивает
/// `updated_at`. Отдельная функция: её проверяет тест без сети.
fn iso_from_ms(ms: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Utc.timestamp_millis_opt(0).single().unwrap_or_else(Utc::now))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Адрес проекта приводим к виду без хвостового слэша — иначе получаются
/// адреса вида `https://x.supabase.co//auth/v1/token`.
fn base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Запасная проверка доступности проекта, когда `/auth/v1/health` не ответил.
///
/// Корень `/rest/v1/` для этого не годится: он отдаёт схему и с новыми ключами
/// требует **секретный** ключ — публичный publishable получает
/// `401 Secret API key required`, то есть ответ, который ничего не говорит о
/// том, верен ли ключ. Спрашиваем обычную таблицу: с валидным публичным ключом
/// она отдаёт `200` (RLS покажет только разрешённые строки), с неверным — 401.
fn rest_probe_url(base: &str) -> String {
    format!("{}/rest/v1/user_data?select=*&limit=1", base_url(base))
}

// ---------- Ответы команд ----------

/// Настроить проект: запомнить адрес и anon-ключ и проверить доступность.
/// Токены входа при смене проекта не переносим.
pub fn configure(url: &str, anon_key: &str) -> Result<SyncStatus, String> {
    let url = base_url(url);
    let anon_key = anon_key.trim().to_string();
    if url.is_empty() || anon_key.is_empty() {
        return Err("Заполни адрес проекта и anon-ключ".into());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Адрес проекта должен начинаться с https://".into());
    }

    // Проверка доступности и ключа: этот запрос отвечает без входа и без
    // Authorization — только `apikey` с публичным ключом.
    let request = with_project_key(Request::get(format!("{url}/auth/v1/health")), &anon_key);
    let response = send(&request)?;
    if let Err(error) = json_of(&response) {
        if error == "Ключ или адрес проекта неверны" {
            return Err(error);
        }
        // Некоторые версии проекта не отдают /health, но ключ принимают:
        // тогда проверяем REST-адрес и решаем по коду ответа. Запрос
        // анонимный (сессии ещё нет) — значит снова только `apikey`.
        // HTML здесь — признак того, что по адресу вообще не Supabase.
        let probe = with_project_key(Request::get(rest_probe_url(&url)), &anon_key);
        let probe_response = send(&probe)?;
        let looks_like_html = probe_response.text.trim_start().starts_with('<');
        // Код 401/403 здесь ещё не приговор: RLS могла не пустить анонима к
        // таблице. Настоящая ошибка ключа видна на /health выше, а этот запрос
        // лишь проверяет, что по адресу отвечает Supabase, а не чужой сервер.
        if !(200..500).contains(&probe_response.code) || looks_like_html {
            return Err(if looks_like_html {
                "Ключ или адрес проекта неверны".to_string()
            } else {
                apply_error(probe_response.code, &probe_response.text)
            });
        }
    }

    let mut session = load()?;
    let changed = session.url != url || session.anon_key != anon_key;
    if changed {
        session = Session { url, anon_key, ..Session::default() };
    } else {
        session.url = url;
        session.anon_key = anon_key;
    }
    store(&session)?;
    Ok(SyncStatus::of(&session))
}

/// Вход. Ошибку превращаем в понятную фразу, токены сохраняем.
pub fn sign_in(email: &str, password: &str) -> Result<SyncStatus, String> {
    let session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let email = email.trim();
    if email.is_empty() {
        return Err("Укажи email".into());
    }

    let url = format!("{}/auth/v1/token?grant_type=password", session.url);
    let request = with_project_key(
        Request::post_secret(url, serde_json::json!({ "email": email, "password": password })),
        &session.anon_key,
    );
    let response = send(&request)?;
    let body = json_of(&response)?;

    let outcome = auth_outcome(&body, &session.url, &session.anon_key, email, crate::db_now_ms())?;
    let mut fresh = match outcome {
        AuthOutcome::Tokens(fresh) => *fresh,
        AuthOutcome::ConfirmEmail => {
            return Err("Почта не подтверждена — проверь письмо от Supabase".into())
        }
    };
    fresh.last_sync_ms = session.last_sync_ms;
    store(&fresh)?;
    Ok(SyncStatus::of(&fresh))
}

/// Регистрация. Если в проекте включено подтверждение почты, токенов не будет —
/// об этом честно и говорим, а не делаем вид, что вход состоялся.
pub fn sign_up(
    email: &str,
    password: &str,
    invite_code: Option<&str>,
) -> Result<SyncStatus, String> {
    let session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let email = email.trim();
    if email.is_empty() {
        return Err("Укажи email".into());
    }

    // Код приглашения едет в метаданных регистрации: его проверяет триггер
    // на `auth.users`. Владельцу и при открытой регистрации код не нужен.
    let mut body = serde_json::json!({ "email": email, "password": password });
    let code = invite_code.unwrap_or("").trim();
    if !code.is_empty() {
        body["data"] = serde_json::json!({ "invite_code": code.to_uppercase() });
    }

    let url = format!("{}/auth/v1/signup", session.url);
    let request = with_project_key(Request::post_secret(url, body), &session.anon_key);
    let response = send(&request)?;
    let body = json_of(&response)?;

    match auth_outcome(&body, &session.url, &session.anon_key, email, crate::db_now_ms())? {
        AuthOutcome::Tokens(fresh) => {
            let mut fresh = *fresh;
            fresh.last_sync_ms = session.last_sync_ms;
            store(&fresh)?;
            Ok(SyncStatus::of(&fresh))
        }
        // Токенов нет: вход не состоялся, но и адрес почты показать полезно
        AuthOutcome::ConfirmEmail => {
            let mut pending = SyncStatus::of(&session);
            pending.email = Some(email.to_string());
            pending.last_error =
                Some("Пользователь создан — подтверди почту по письму от Supabase".into());
            Ok(pending)
        }
    }
}

/// Выход: забываем токены, локальные данные не трогаем.
pub fn sign_out() -> Result<(), String> {
    let mut session = load()?;
    session.access_token = None;
    session.refresh_token = None;
    session.expires_at = 0;
    session.email = None;
    session.user_id = None;
    store(&session)
}

/// Состояние без сети: берётся прямо из файла.
pub fn status() -> Result<SyncStatus, String> {
    Ok(SyncStatus::of(&load()?))
}

/// Отправка строк в `user_data`. Слишком большие порции режем на пачки: REST
/// Supabase принимает запрос целиком, но длинный массив упирается в лимит.
pub fn push(rows: &[serde_json::Value]) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let token = access_token(&mut session)?;

    /// Столько строк отправляем за один запрос.
    const BATCH: usize = 200;
    for chunk in rows.chunks(BATCH) {
        let request = with_session(
            Request::post_json(
                format!("{}/rest/v1/user_data", session.url),
                serde_json::Value::Array(chunk.to_vec()),
            ),
            &session.anon_key,
            &token,
        )
        .header("Prefer", "resolution=merge-duplicates");

        let response = send(&request)?;
        if !(200..300).contains(&response.code) {
            return Err(apply_error(response.code, &response.text));
        }
    }

    let mut session = load()?;
    session.last_sync_ms = crate::db_now_ms();
    store(&session)?;
    Ok(())
}

/// Выгрузка строк, изменённых позже `since_ms`. Пустое значение означает
/// «всё подряд»: без условия времени Supabase отдаёт всю таблицу пользователя
/// (доступ ограничен политикой RLS).
pub fn pull(since_ms: i64) -> Result<Vec<serde_json::Value>, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let token = access_token(&mut session)?;

    let url = if since_ms > 0 {
        format!(
            "{}/rest/v1/user_data?select=*&updated_at=gt.{}",
            session.url,
            iso_from_ms(since_ms)
        )
    } else {
        format!("{}/rest/v1/user_data?select=*", session.url)
    };

    let request = with_session(Request::get(url), &session.anon_key, &token);
    let response = send(&request)?;
    let body = json_of(&response)?;

    let rows = body.as_array().cloned().unwrap_or_default();
    if since_ms <= 0 {
        let mut session = load()?;
        session.last_sync_ms = crate::db_now_ms();
        let _ = store(&session);
    }
    Ok(rows)
}

// ---------- Профили (публичная таблица `profiles`) ----------
//
// Юзернейм, аватар, баннер и описание живут отдельно от личных данных: их
// читают все вошедшие — по ним работает поиск людей. Свою строку каждый
// пишет только себе (RLS `id = auth.uid()`), поэтому идентификатор берём из
// сессии и никогда из аргументов команды: подменить его нельзя.

/// Колонки, которые нужны интерфейсу: `select=*` тянул бы лишнее.
const PROFILE_COLUMNS: &str = "id,username,display_name,avatar,banner,bio,privacy,updated_at";

/// Сколько людей отдаёт поиск за один раз.
const SEARCH_LIMIT: usize = 20;

/// Что отвечаем на попытку зарегистрироваться, пока проект в бете.
const REGISTRATION_CLOSED: &str =
    "Регистрация временно закрыта: проект в бете, доступ открыт только владельцу";

/// Аватар и баннер уезжают в облако целиком (data-URL после сжатия), поэтому
/// слишком большую картинку не отправляем: обрезать data-URL нельзя, вышла бы
/// битая картинка — честнее попросить уменьшить.
const MAX_IMAGE_CHARS: usize = 900_000;

/// Свой профиль в облаке. Поля базы (`snake_case`) раскладываются вручную,
/// наружу — в интерфейс — они уходят в camelCase, как в соседних структурах.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    pub privacy: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            id: String::new(),
            username: String::new(),
            display_name: None,
            avatar: None,
            banner: None,
            bio: None,
            privacy: serde_json::json!({}),
            updated_at: None,
        }
    }
}

/// Строка из базы → профиль. Незнакомые и битые поля не роняют разбор:
/// чего нет, того и нет, а `privacy` по умолчанию пустой объект — «всё видно»
/// (эту же договорённость держит интерфейс).
fn profile_from_row(row: &serde_json::Value) -> Profile {
    let text = |key: &str| {
        row.get(key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Profile {
        id: text("id").unwrap_or_default(),
        username: text("username").unwrap_or_default(),
        display_name: text("display_name"),
        avatar: text("avatar"),
        banner: text("banner"),
        bio: text("bio"),
        privacy: row
            .get("privacy")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        updated_at: text("updated_at"),
    }
}

/// Пробелы по краям убираем, пустое превращаем в NULL: в базе пустая строка
/// и отсутствие значения должны выглядеть одинаково.
fn trimmed(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Правила @username ровно те же, что в интерфейсе (`validateUsername`):
/// латиница, цифры, «_» и «.», от 3 до 20 символов, без ведущего «@».
fn check_username(raw: &str) -> Result<String, String> {
    let name = raw.trim().trim_start_matches('@').to_ascii_lowercase();
    let length = name.chars().count();
    if length < 3 {
        return Err("Юзернейм: минимум 3 символа".into());
    }
    if length > 20 {
        return Err("Юзернейм: максимум 20 символов".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
    {
        return Err("Юзернейм: только латиница, цифры, «_» и «.»".into());
    }
    Ok(name)
}

/// Картинка для облака: пустая ссылка — это «нет картинки», а слишком
/// большая — понятная ошибка вместо битой записи.
fn image_or_none(value: Option<&str>, what: &str) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > MAX_IMAGE_CHARS {
        return Err(format!("{what} слишком большой для облака — уменьши картинку"));
    }
    Ok(Some(value.to_string()))
}

/// Поисковый запрос для PostgREST: `or=(...)` разбирается по запятым, скобкам
/// и звёздочкам, поэтому из ввода оставляем только буквы, цифры и «_ . -».
/// Пустой результат означает «искать нечего».
fn sanitize_query(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '.' || *c == '-' || *c == ' ')
        .take(40)
        .collect();
    // Пробелы подряд сжимаем: шаблон `*a  b*` искал бы буквально два пробела
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Процентное кодирование значения в адресе: в пути допустимы только
/// ASCII-символы, а поиск бывает и русским.
fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Адрес одного профиля по идентификатору пользователя.
fn profile_get_url(base: &str, user_id: &str) -> String {
    format!(
        "{base}/rest/v1/profiles?select={PROFILE_COLUMNS}&id=eq.{}&limit=1",
        encode_query(user_id.trim())
    )
}

/// Адрес поиска: совпадение по юзернейму или отображаемому имени, лимит 20.
fn profile_search_url(base: &str, query: &str) -> String {
    let pattern = encode_query(query);
    format!(
        "{base}/rest/v1/profiles?select={PROFILE_COLUMNS}&or=(username.ilike.*{pattern}*,display_name.ilike.*{pattern}*)&limit={SEARCH_LIMIT}&order=username.asc"
    )
}

/// Расшифровка отказа записи профиля: занятый юзернейм Supabase отдаёт как 409
/// с текстом про duplicate key — это не «неверный ключ проекта».
fn profile_write_error(code: u16, text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if code == 409 || lower.contains("duplicate key") || lower.contains("profiles_username") {
        return Some("Этот юзернейм уже занят — выбери другой".into());
    }
    None
}

/// Разрешил ли человек находить себя по юзернейму. Поля может не быть вовсе —
/// тогда считаем «да»: скрывать людей без их просьбы мы не имеем права.
fn profile_is_discoverable(row: &serde_json::Value) -> bool {
    match row.get("privacy").and_then(|value| value.get("discoverable")) {
        Some(serde_json::Value::Bool(visible)) => *visible,
        _ => true,
    }
}

/// Записать свой профиль в облако: одна строка, ключ — идентификатор сессии.
/// `Prefer: resolution=merge-duplicates` превращает вставку в обновление.
pub fn profile_upsert(
    username: &str,
    display_name: &str,
    avatar: Option<&str>,
    banner: Option<&str>,
    bio: &str,
    privacy: Option<&serde_json::Value>,
) -> Result<Profile, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let user_id = session
        .user_id
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Сначала войди в аккаунт".to_string())?;

    let username = check_username(username)?;
    let privacy = privacy
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    let row = serde_json::json!({
        "id": user_id,
        "username": username,
        "display_name": trimmed(display_name),
        "avatar": image_or_none(avatar, "Аватар")?,
        "banner": image_or_none(banner, "Баннер")?,
        "bio": trimmed(bio),
        "privacy": privacy,
        "updated_at": iso_from_ms(crate::db_now_ms()),
    });

    let token = access_token(&mut session)?;
    let request = with_session(
        Request::post_json(
            format!("{}/rest/v1/profiles", session.url),
            serde_json::Value::Array(vec![row.clone()]),
        ),
        &session.anon_key,
        &token,
    )
    .header("Prefer", "resolution=merge-duplicates,return=representation");

    let response = send(&request)?;
    if let Some(error) = profile_write_error(response.code, &response.text) {
        return Err(error);
    }
    let body = json_of(&response)?;

    // `return=representation` отдаёт записанную строку обратно; если тело пустое,
    // показываем то, что отправили — интерфейсу этого достаточно.
    Ok(body
        .as_array()
        .and_then(|rows| rows.first())
        .map(profile_from_row)
        .unwrap_or_else(|| profile_from_row(&row)))
}

/// Профиль по идентификатору. Пустой ответ — это «профиля ещё нет», а не
/// ошибка: у только что зарегистрированного пользователя строки может не быть.
pub fn profile_get(user_id: &str) -> Result<Option<Profile>, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Err("Не указан пользователь".into());
    }

    let token = access_token(&mut session)?;
    let request = with_session(
        Request::get(profile_get_url(&session.url, user_id)),
        &session.anon_key,
        &token,
    );
    let body = json_of(&send(&request)?)?;

    Ok(body
        .as_array()
        .and_then(|rows| rows.first())
        .map(profile_from_row))
}

/// Поиск людей по юзернейму и отображаемому имени. Регистр не важен: `ilike`.
/// Читать может любой вошедший — политика RLS на `profiles` именно такая.
pub fn profile_search(query: &str) -> Result<Vec<Profile>, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let query = sanitize_query(query);
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let token = access_token(&mut session)?;
    let request = with_session(
        Request::get(profile_search_url(&session.url, &query)),
        &session.anon_key,
        &token,
    );
    let body = json_of(&send(&request)?)?;

    Ok(body
        .as_array()
        .map(|rows| {
            rows.iter()
                // «Не находить меня по юзернейму» уважаем и здесь
                .filter(|row| profile_is_discoverable(row))
                .map(profile_from_row)
                .collect()
        })
        .unwrap_or_default())
}

/* ------------------------------------------------------------------ */
/* Приглашения                                                         */
/* ------------------------------------------------------------------ */

/// Приглашение, как его отдаёт RPC `invite_list`: статус считает сервер.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub code: String,
    pub note: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    pub max_uses: i64,
    pub used_count: i64,
    pub revoked_at: Option<String>,
    /// `active` / `used` / `expired` / `revoked`.
    pub status: String,
}

fn invite_from_row(row: &serde_json::Value) -> Invite {
    let text = |name: &str| {
        row.get(name).and_then(|value| value.as_str()).map(|value| value.to_string())
    };
    Invite {
        code: text("code").unwrap_or_default(),
        note: text("note").filter(|value| !value.is_empty()),
        created_at: text("created_at").unwrap_or_default(),
        expires_at: text("expires_at").unwrap_or_default(),
        max_uses: row.get("max_uses").and_then(|v| v.as_i64()).unwrap_or(1),
        used_count: row.get("used_count").and_then(|v| v.as_i64()).unwrap_or(0),
        revoked_at: text("revoked_at"),
        status: text("status").unwrap_or_else(|| "active".into()),
    }
}

/// Адрес RPC PostgREST: тело — именованные аргументы функции.
fn rpc_url(base: &str, name: &str) -> String {
    format!("{base}/rest/v1/rpc/{name}")
}

/// Проверить код до отправки формы: код не расходуется. Доступна анонимно —
/// коды высокоэнтропийные, перебор нереален (см. миграцию 20261023_invites).
pub fn invite_check(code: &str) -> Result<bool, String> {
    let session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let code = code.trim();
    if code.is_empty() {
        return Ok(false);
    }
    let request = with_project_key(
        Request::post_json(rpc_url(&session.url, "invite_check"), serde_json::json!({ "p_code": code.to_uppercase() })),
        &session.anon_key,
    );
    let body = json_of(&send(&request)?)?;
    Ok(body.as_bool().unwrap_or(false))
}

/// Создать приглашение. Права проверяет сервер (`is_app_owner`).
pub fn invite_create(note: Option<&str>, days: i64, max_uses: i64) -> Result<Invite, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let token = access_token(&mut session)?;
    let request = with_session(
        Request::post_json(
            rpc_url(&session.url, "invite_create"),
            serde_json::json!({
                "p_note": note.map(str::trim).filter(|value| !value.is_empty()),
                "p_days": days,
                "p_max_uses": max_uses,
            }),
        ),
        &session.anon_key,
        &token,
    );
    let body = json_of(&send(&request)?)?;
    Ok(invite_from_row(&body))
}

/// Список приглашений. Чужому пользователю сервер откажет — интерфейс по этой
/// ошибке прячет раздел настроек целиком.
pub fn invite_list() -> Result<Vec<Invite>, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let token = access_token(&mut session)?;
    let request = with_session(
        Request::post_json(rpc_url(&session.url, "invite_list"), serde_json::json!({})),
        &session.anon_key,
        &token,
    );
    let body = json_of(&send(&request)?)?;
    Ok(body
        .as_array()
        .map(|rows| rows.iter().map(invite_from_row).collect())
        .unwrap_or_default())
}

/// Отозвать код. Уже зарегистрированных это не удаляет.
pub fn invite_revoke(code: &str) -> Result<bool, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let code = code.trim();
    if code.is_empty() {
        return Err("Не указан код приглашения".into());
    }
    let token = access_token(&mut session)?;
    let request = with_session(
        Request::post_json(
            rpc_url(&session.url, "invite_revoke"),
            serde_json::json!({ "p_code": code.to_uppercase() }),
        ),
        &session.anon_key,
        &token,
    );
    let body = json_of(&send(&request)?)?;
    Ok(body.as_bool().unwrap_or(false))
}

// ---------- Устройства (HWID) и админ-панель ----------

/// К какому аккаунту привязан компьютер. Доступно до входа — иначе человек,
/// забывший и пароль, и ник, не смог бы вспомнить, куда входил.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAccount {
    pub username: String,
    pub display_name: String,
    pub email: String,
}

fn text_field(row: &serde_json::Value, name: &str) -> String {
    row.get(name).and_then(|value| value.as_str()).unwrap_or("").to_string()
}

/// Привязать этот компьютер к текущему аккаунту (после входа).
pub fn device_bind(hwid: &str) -> Result<(), String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let hwid = hwid.trim().to_string();
    if hwid.len() < 32 {
        return Err("Не удалось определить устройство".into());
    }
    let token = access_token(&mut session)?;
    let request = with_session(
        Request::post_json(rpc_url(&session.url, "device_bind"), serde_json::json!({ "p_hwid": hwid })),
        &session.anon_key,
        &token,
    );
    json_of(&send(&request)?)?;
    Ok(())
}

/// Вспомнить аккаунт по компьютеру: пустой ответ — устройство ни к чему не
/// привязано.
pub fn device_lookup(hwid: &str) -> Result<Option<DeviceAccount>, String> {
    let session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let hwid = hwid.trim().to_string();
    if hwid.len() < 32 {
        return Ok(None);
    }
    let request = with_project_key(
        Request::post_json(rpc_url(&session.url, "device_lookup"), serde_json::json!({ "p_hwid": hwid })),
        &session.anon_key,
    );
    let body = json_of(&send(&request)?)?;
    let row = body.as_array().and_then(|rows| rows.first()).cloned();
    Ok(row.map(|row| DeviceAccount {
        username: text_field(&row, "username"),
        display_name: text_field(&row, "display_name"),
        email: text_field(&row, "email"),
    }))
}

/// Владелец ли текущий аккаунт: по этому ответу клиент прячет разделы
/// разработчика и показывает админ-панель.
pub fn is_owner() -> Result<bool, String> {
    let mut session = load()?;
    if !session.configured() {
        return Ok(false);
    }
    let token = access_token(&mut session)?;
    let request = with_session(
        Request::post_json(rpc_url(&session.url, "is_owner"), serde_json::json!({})),
        &session.anon_key,
        &token,
    );
    let body = json_of(&send(&request)?)?;
    Ok(body.as_bool().unwrap_or(false))
}

/// Письмо для сброса пароля: Supabase присылает ссылку на почту аккаунта.
pub fn recover_password(email: &str) -> Result<(), String> {
    let session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let email = email.trim();
    if email.is_empty() {
        return Err("Укажи почту аккаунта".into());
    }
    let request = with_project_key(
        Request::post_json(
            format!("{}/auth/v1/recover", session.url),
            serde_json::json!({ "email": email }),
        ),
        &session.anon_key,
    );
    json_of(&send(&request)?)?;
    Ok(())
}

/// Адрес проекта и публичный ключ — для модуля обновлений (Storage).
pub fn project_config() -> Result<(String, String), String> {
    let session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    Ok((session.url, session.anon_key))
}

/// Открыта ли регистрация для всех: ответ RPC `app_registration_state`.
/// Если владелец открыл её в админ-панели, экран входа не должен требовать код.
pub fn registration_is_open() -> Result<bool, String> {
    let session = load()?;
    if !session.configured() {
        return Ok(false);
    }
    let request = with_project_key(
        Request::post_json(rpc_url(&session.url, "app_registration_state"), serde_json::json!({})),
        &session.anon_key,
    );
    let body = json_of(&send(&request)?)?;
    Ok(body
        .get("open")
        .and_then(|value| value.as_bool())
        .unwrap_or(false))
}

/// Строка списка людей в админ-панели.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUser {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub created_at: String,
    pub last_sign_in_at: Option<String>,
    pub devices: i64,
}

/// Строка списка устройств в админ-панели.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminDevice {
    pub username: String,
    pub email: String,
    pub hwid: String,
    pub created_at: String,
    pub last_seen_at: String,
}

/// Строка журнала использованных кодов.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteUse {
    pub code: String,
    pub email: String,
    pub used_at: String,
}

/// Сводка для админ-панели.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminStats {
    pub users: i64,
    pub invites_active: i64,
    pub invites_used: i64,
    pub devices: i64,
    pub registration_open: bool,
}

fn admin_call(name: &str) -> Result<serde_json::Value, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let token = access_token(&mut session)?;
    let request = with_session(
        Request::post_json(rpc_url(&session.url, name), serde_json::json!({})),
        &session.anon_key,
        &token,
    );
    json_of(&send(&request)?)
}

fn rows(body: &serde_json::Value) -> Vec<serde_json::Value> {
    body.as_array().cloned().unwrap_or_default()
}

pub fn admin_users() -> Result<Vec<AdminUser>, String> {
    let body = admin_call("admin_users")?;
    Ok(rows(&body)
        .iter()
        .map(|row| AdminUser {
            user_id: text_field(row, "user_id"),
            username: text_field(row, "username"),
            display_name: text_field(row, "display_name"),
            email: text_field(row, "email"),
            created_at: text_field(row, "created_at"),
            last_sign_in_at: row
                .get("last_sign_in_at")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            devices: row.get("devices").and_then(|value| value.as_i64()).unwrap_or(0),
        })
        .collect())
}

pub fn admin_devices() -> Result<Vec<AdminDevice>, String> {
    let body = admin_call("admin_devices")?;
    Ok(rows(&body)
        .iter()
        .map(|row| AdminDevice {
            username: text_field(row, "username"),
            email: text_field(row, "email"),
            hwid: text_field(row, "hwid"),
            created_at: text_field(row, "created_at"),
            last_seen_at: text_field(row, "last_seen_at"),
        })
        .collect())
}

pub fn admin_invite_uses() -> Result<Vec<InviteUse>, String> {
    let body = admin_call("admin_invite_uses")?;
    Ok(rows(&body)
        .iter()
        .map(|row| InviteUse {
            code: text_field(row, "code"),
            email: text_field(row, "email"),
            used_at: text_field(row, "used_at"),
        })
        .collect())
}

pub fn admin_stats() -> Result<AdminStats, String> {
    let body = admin_call("admin_stats")?;
    let row = rows(&body).into_iter().next().unwrap_or(serde_json::Value::Null);
    Ok(AdminStats {
        users: row.get("users").and_then(|value| value.as_i64()).unwrap_or(0),
        invites_active: row.get("invites_active").and_then(|value| value.as_i64()).unwrap_or(0),
        invites_used: row.get("invites_used").and_then(|value| value.as_i64()).unwrap_or(0),
        devices: row.get("devices").and_then(|value| value.as_i64()).unwrap_or(0),
        registration_open: row
            .get("registration_open")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    })
}

/// Открыть или закрыть регистрацию для всех. Возвращает новое состояние.
pub fn admin_set_open(open: bool) -> Result<bool, String> {
    let mut session = load()?;
    if !session.configured() {
        return Err("Supabase не настроен: укажи адрес проекта и anon-ключ".into());
    }
    let token = access_token(&mut session)?;
    let request = with_session(
        Request::post_json(
            rpc_url(&session.url, "admin_set_open"),
            serde_json::json!({ "p_open": open }),
        ),
        &session.anon_key,
        &token,
    );
    let body = json_of(&send(&request)?)?;
    Ok(body.as_bool().unwrap_or(open))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Session {
        Session {
            url: "https://abcdefgh.supabase.co".into(),
            anon_key: "anon-key-123".into(),
            access_token: Some("access-1".into()),
            refresh_token: Some("refresh-1".into()),
            expires_at: 1_700_000_000_000,
            email: Some("user@example.com".into()),
            user_id: Some("11111111-2222-3333-4444-555555555555".into()),
            last_sync_ms: 1_699_999_000_000,
        }
    }

    // ---------- Файл сессии ----------

    #[test]
    fn session_json_round_trip() {
        let original = sample();
        let restored = Session::from_json(&original.to_json());
        assert_eq!(restored, original);
        assert!(restored.configured());
        assert!(restored.signed_in());
    }

    #[test]
    fn broken_session_file_is_treated_as_empty() {
        for broken in ["", "   ", "{", "не json", "[]", "null", "123"] {
            let session = Session::from_json(broken);
            assert!(!session.configured(), "файл: {broken:?}");
            assert!(!session.signed_in(), "файл: {broken:?}");
            assert_eq!(session.last_sync_ms, 0);
        }
    }

    #[test]
    fn missing_session_fields_do_not_break_reading() {
        // Файл со старым набором полей: остальное берётся по умолчанию
        let session = Session::from_json(r#"{ "url": "https://x.supabase.co/", "anon_key": "k" }"#);
        assert_eq!(session.url, "https://x.supabase.co");
        assert_eq!(session.anon_key, "k");
        assert!(!session.signed_in());
        assert_eq!(session.access_token, None);
        assert_eq!(session.email, None);
        assert_eq!(session.user_id, None);
        assert_eq!(session.last_sync_ms, 0);

        // Пустые строки и мусорные значения тоже не считаем данными
        let messy = Session::from_json(
            r#"{ "url": " https://y.supabase.co ", "anon_key": " ", "email": "  ",
                 "user_id": "", "access_token": " ", "last_sync_ms": -5 }"#,
        );
        assert_eq!(messy.url, "https://y.supabase.co");
        assert!(!messy.configured(), "пустой ключ — проект не настроен");
        assert_eq!(messy.email, None);
        assert_eq!(messy.user_id, None);
        assert_eq!(messy.access_token, None);
        assert_eq!(messy.last_sync_ms, 0);
    }

    #[test]
    fn password_never_reaches_the_session_file() {
        // Ни пароль, ни его следы не должны попадать в запись на диск:
        // структура сессии вообще не имеет такого поля.
        let password = "SuperSecret!123";
        let body = serde_json::json!({
            "access_token": "a", "refresh_token": "r", "expires_in": 3600,
            "user": { "id": "u-1", "email": "user@example.com" }
        });
        let AuthOutcome::Tokens(session) =
            auth_outcome(&body, "https://x.supabase.co", "anon", "user@example.com", 1_000).unwrap()
        else {
            panic!("ждали токены");
        };
        let text = session.to_json();
        assert!(!text.contains(password), "пароль утёк в файл: {text}");
        assert!(!text.to_lowercase().contains("password"), "поле пароля в файле: {text}");
        assert!(text.contains("a") && text.contains("r"));
        assert_eq!(session.email.as_deref(), Some("user@example.com"));
    }

    #[test]
    fn session_file_lives_in_the_app_data_folder() {
        let path = session_path().expect("путь к файлу сессии");
        assert!(path.ends_with("com.example.musichub\\sync.json") || path.ends_with("com.example.musichub/sync.json"));
    }

    #[test]
    fn session_is_written_and_read_back() {
        let dir = std::env::temp_dir().join(format!("musichub-sync-{}", std::process::id()));
        let path: PathBuf = dir.join("sync.json");
        let session = sample();
        write_session_to(&path, &session).expect("запись");
        assert_eq!(read_session_from(&path), session);
        // Битый файл на диске — тоже не паника
        std::fs::write(&path, "{ oops").expect("запись");
        assert_eq!(read_session_from(&path), Session::default());
        // Отсутствующего файла достаточно, чтобы получить пустую сессию
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_session_from(&path), Session::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- Ответы Supabase ----------

    #[test]
    fn token_response_is_parsed_into_a_session() {
        let body = serde_json::json!({
            "access_token": "access-token",
            "token_type": "bearer",
            "expires_in": 3600,
            "refresh_token": "refresh-token",
            "user": { "id": "user-1", "email": "user@example.com" }
        });
        let now = 1_700_000_000_000;
        let AuthOutcome::Tokens(session) =
            auth_outcome(&body, "https://x.supabase.co/", "anon", "", now).unwrap()
        else {
            panic!("ждали токены");
        };
        assert_eq!(session.url, "https://x.supabase.co");
        assert_eq!(session.access_token.as_deref(), Some("access-token"));
        assert_eq!(session.refresh_token.as_deref(), Some("refresh-token"));
        assert_eq!(session.expires_at, now + 3_600_000);
        assert_eq!(session.user_id.as_deref(), Some("user-1"));
        assert_eq!(session.email.as_deref(), Some("user@example.com"));
        assert!(session.signed_in());
    }

    #[test]
    fn signup_without_tokens_asks_for_email_confirmation() {
        let body = serde_json::json!({
            "id": "user-1",
            "email": "user@example.com",
            "confirmation_sent_at": "2024-01-01T00:00:00Z"
        });
        assert!(matches!(
            auth_outcome(&body, "https://x.supabase.co", "anon", "user@example.com", 0).unwrap(),
            AuthOutcome::ConfirmEmail
        ));
        // Совсем пустой ответ — не успех и не подтверждение почты
        let error = auth_outcome(&serde_json::json!({}), "https://x.supabase.co", "anon", "", 0)
            .unwrap_err();
        assert!(error.contains("токен"), "получили: {error}");
    }

    #[test]
    fn invite_row_is_parsed_with_defaults() {
        let row = serde_json::json!({
            "code": "ABCD-EFGH-JKLM",
            "created_at": "2026-10-23T00:00:00Z",
            "expires_at": "2026-11-06T00:00:00Z",
            "used_count": 2
        });
        let invite = invite_from_row(&row);
        assert_eq!(invite.code, "ABCD-EFGH-JKLM");
        assert_eq!(invite.max_uses, 1);
        assert_eq!(invite.used_count, 2);
        assert_eq!(invite.status, "active");
        assert!(invite.note.is_none() && invite.revoked_at.is_none());
    }

    #[test]
    fn invalid_grant_is_translated_into_a_human_message() {
        let text = r#"{"error":"invalid_grant","error_description":"Invalid login credentials"}"#;
        assert_eq!(apply_error(400, text), "Неверный email или пароль");
        let text = r#"{"error_code":"invalid_credentials","msg":"Invalid login credentials"}"#;
        assert_eq!(apply_error(401, text), "Неверный email или пароль");
    }

    #[test]
    fn already_registered_user_is_reported_clearly() {
        let text = r#"{"code":422,"error_code":"user_already_exists","msg":"User already registered"}"#;
        assert_eq!(apply_error(422, text), "Пользователь уже существует");
        let text = r#"{"error_code":"user_already_exists","message":"User already registered"}"#;
        assert_eq!(apply_error(400, text), "Пользователь уже существует");
    }

    #[test]
    fn forbidden_and_unauthorized_mean_bad_project_key() {
        assert_eq!(apply_error(401, "{}"), "Ключ или адрес проекта неверны");
        assert_eq!(apply_error(403, ""), "Ключ или адрес проекта неверны");
    }

    #[test]
    fn other_errors_keep_the_code_and_the_head_of_the_body() {
        let text = "x".repeat(500);
        let message = apply_error(500, &text);
        assert!(message.starts_with("Supabase ответил 500: "), "получили: {message}");
        // Тело в сообщении обрезано: интерфейсу не нужны простыни
        assert_eq!(message.chars().count(), "Supabase ответил 500: ".chars().count() + 200);

        // Тело без JSON тоже понятно
        assert_eq!(apply_error(502, ""), "Supabase ответил 502");
        assert_eq!(apply_error(0, ""), "Нет сети");
    }

    // ---------- Обновление токена ----------

    #[test]
    fn token_is_refreshed_a_minute_before_expiry() {
        let expires_at = 1_700_000_000_000;
        assert_eq!(refresh_at_ms(expires_at), expires_at - 60_000);
        assert!(!needs_refresh(expires_at, expires_at - 61_000));
        assert!(needs_refresh(expires_at, expires_at - 60_000));
        assert!(needs_refresh(expires_at, expires_at - 1));
        assert!(needs_refresh(expires_at, expires_at + 1_000));
        // Токена нет вовсе — обновлять обязательно
        assert!(needs_refresh(0, 0));
    }

    #[test]
    fn refresh_token_response_replaces_expiry() {
        let body = serde_json::json!({
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 3600
        });
        let now = 1_700_000_000_000;
        let AuthOutcome::Tokens(fresh) =
            auth_outcome(&body, "https://x.supabase.co", "anon", "", now).unwrap()
        else {
            panic!("ждали токены");
        };
        assert_eq!(fresh.expires_at, now + 3_600_000);
        // Абсолютное expires_at (в секундах) тоже понимаем
        let absolute = serde_json::json!({
            "access_token": "a", "refresh_token": "r", "expires_at": 1_800_000_000
        });
        let AuthOutcome::Tokens(fresh) =
            auth_outcome(&absolute, "https://x.supabase.co", "anon", "", now).unwrap()
        else {
            panic!("ждали токены");
        };
        assert_eq!(fresh.expires_at, 1_800_000_000_000);
    }

    #[test]
    fn expired_session_without_refresh_token_is_reported() {
        let mut session = sample();
        session.refresh_token = None;
        let error = access_token(&mut session).unwrap_err();
        assert_eq!(error, "Сессия истекла, войди заново");
    }

    #[test]
    fn status_reports_configuration_without_network() {
        let empty = SyncStatus::of(&Session::default());
        assert!(!empty.configured);
        assert!(!empty.signed_in);
        assert_eq!(empty.email, None);
        assert_eq!(empty.user_id, None);
        assert_eq!(empty.last_sync_at_ms, None);
        assert_eq!(empty.last_error, None);

        let ready = SyncStatus::of(&sample());
        assert!(ready.configured);
        assert!(ready.signed_in);
        assert_eq!(ready.email.as_deref(), Some("user@example.com"));
        assert_eq!(ready.user_id.as_deref(), Some("11111111-2222-3333-4444-555555555555"));
        assert_eq!(ready.last_sync_at_ms, Some(1_699_999_000_000));

        // Ошибку показываем рядом со статусом, ничего не затирая
        let failed = ready.clone().with_error("Нет сети");
        assert_eq!(failed.last_error.as_deref(), Some("Нет сети"));
        assert!(failed.configured);
    }

    #[test]
    fn status_is_serialized_in_camel_case() {
        let text = serde_json::to_string(&SyncStatus::of(&sample())).unwrap();
        for key in ["configured", "signedIn", "email", "userId", "lastSyncAtMs"] {
            assert!(text.contains(key), "нет поля {key}: {text}");
        }
        assert!(!text.contains("signed_in"));

        let empty = serde_json::to_string(&SyncStatus::of(&Session::default())).unwrap();
        assert!(!empty.contains("lastError"), "пустые поля не уходят: {empty}");
        assert!(!empty.contains("lastSyncAtMs"));
    }

    // ---------- Время, адрес и аргументы curl ----------

    #[test]
    fn since_ms_becomes_an_iso_time() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_500), "2023-11-14T22:13:20.500Z");
        // Некорректное значение не паникует
        assert!(iso_from_ms(i64::MIN).starts_with("1970-01-01"));
    }

    #[test]
    fn project_url_loses_its_trailing_slash() {
        assert_eq!(base_url("https://x.supabase.co/"), "https://x.supabase.co");
        assert_eq!(base_url("  https://x.supabase.co///  "), "https://x.supabase.co");
        assert_eq!(base_url(""), "");
    }

    #[test]
    fn health_probe_avoids_the_secret_only_rest_root() {
        // Корень `/rest/v1/` с публичным ключом отвечает 401
        // «Secret API key required»: как проверка доступности он бесполезен.
        // Спрашиваем обычную таблицу и только с `apikey`.
        let url = rest_probe_url("https://x.supabase.co/");
        assert!(url.starts_with("https://x.supabase.co/rest/v1/user_data?"), "{url}");
        assert!(url.contains("select=*"), "{url}");
        assert!(url.contains("limit=1"), "{url}");
        assert!(!url.ends_with("/rest/v1/"), "это корень схемы, он требует секретный ключ: {url}");

        // Хвостовой слэш не превращается в двойной
        let trimmed = rest_probe_url("https://x.supabase.co");
        assert!(!trimmed.contains("co//"), "{trimmed}");
        assert_eq!(trimmed, url);

        // Заголовок — только apikey: сессии на этом шаге ещё нет
        let request = with_project_key(Request::get(rest_probe_url("https://x.supabase.co")), "k");
        let args = curl_args(&request, TIME_BUDGET);
        assert!(
            authorization_header(&args).is_none(),
            "проверка доступности не должна слать Authorization: {args:?}"
        );
        assert!(apikey_headers(&args) == vec!["apikey: k".to_string()], "{args:?}");
    }

    #[test]
    fn curl_carries_the_required_flags() {
        let request = with_session(
            Request::get("https://x.supabase.co/rest/v1/user_data?select=*"),
            "anon",
            "token",
        );
        let args = curl_args(&request, TIME_BUDGET);
        assert!(args.iter().any(|arg| arg == "--doh-url"), "нет DoH: {args:?}");
        assert!(args.iter().any(|arg| arg == DOH_URL));
        assert!(args.iter().any(|arg| arg == "--max-time"), "нет ограничения времени: {args:?}");
        assert!(args.iter().any(|arg| arg == "20"));
        // Флаг имеет смысл только для Schannel: на других платформах его нет
        if cfg!(windows) {
            assert!(args.iter().any(|arg| arg == SSL_NO_REVOKE), "нет --ssl-no-revoke: {args:?}");
            assert!(args.iter().any(|arg| arg == "--ssl-no-revoke"));
        }
        assert!(args.iter().any(|arg| arg == USER_AGENT));
        assert!(args.contains(&"-H".to_string()));
        assert!(args.iter().any(|arg| arg == "apikey: anon"));
        assert!(args.iter().any(|arg| arg == "Authorization: Bearer token"));
        assert_eq!(args.last().unwrap(), &request.url);
    }

    // ---------- Ключ проекта и заголовки ----------
    //
    // Публичный ключ новой системы (`sb_publishable_…`) опознаёт проект и только
    // проект: он уходит в `apikey`. Пользователя опознаёт `Authorization`
    // с `access_token`. Перепутать их нельзя — Supabase ответит 401.

    /// Публичный ключ новой системы — в том же виде, что вшит в сборку.
    const PUBLISHABLE_KEY: &str = "sb_publishable_-IsnSlcDWrkHpF74qxyxXw_HAHdkXy_";

    /// Значение заголовка `Authorization`, если он вообще есть.
    fn authorization_header(args: &[String]) -> Option<String> {
        args.iter().find(|arg| arg.to_lowercase().starts_with("authorization:")).cloned()
    }

    /// Все заголовки `apikey` из аргументов curl.
    fn apikey_headers(args: &[String]) -> Vec<String> {
        args.iter().filter(|arg| arg.to_lowercase().starts_with("apikey:")).cloned().collect()
    }

    #[test]
    fn publishable_key_is_a_valid_public_key_shape() {
        // Проверка по формату, а не по конкретному проекту: подходит и
        // publishable-ключ новой системы, и прежний anon-JWT. Секретных ключей
        // (`sb_secret_…`, `service_role`) в этой роли быть не должно.
        assert!(
            PUBLISHABLE_KEY.starts_with("sb_publishable_") || PUBLISHABLE_KEY.starts_with("eyJ"),
            "неизвестный формат публичного ключа: {PUBLISHABLE_KEY}"
        );
        assert!(!PUBLISHABLE_KEY.starts_with("sb_secret_"), "секретный ключ в клиенте");
        assert!(!PUBLISHABLE_KEY.contains("service_role"), "ключ service_role в клиенте");
    }

    #[test]
    fn rest_requests_carry_both_the_project_key_and_the_user_token() {
        // /rest/v1/* от имени вошедшего: нужны ОБА заголовка. Без apikey
        // PostgREST не поймёт, какой это проект, без Bearer — чей пользователь.
        let session = sample();
        let token = "user-access-token";
        let request = with_session(
            Request::get(format!("{}/rest/v1/user_data?select=*", session.url)),
            &session.anon_key,
            token,
        );
        let args = curl_args(&request, TIME_BUDGET);

        assert_eq!(apikey_headers(&args), vec![format!("apikey: {}", session.anon_key)], "{args:?}");
        assert_eq!(
            authorization_header(&args).as_deref(),
            Some("Authorization: Bearer user-access-token"),
            "{args:?}"
        );
        // Ключ проекта не должен уехать в Authorization: иначе 401
        assert!(
            !args.iter().any(|arg| arg.contains(&format!("Bearer {}", session.anon_key))),
            "ключ проекта в Authorization: {args:?}"
        );
        assert!(!args.iter().any(|arg| arg == "Authorization: Bearer anon-key-123"), "{args:?}");

        // То же для профилей: и на запись, и на чтение
        let write = with_session(
            Request::post_json(
                format!("{}/rest/v1/profiles", session.url),
                serde_json::json!([{ "id": "u-1" }]),
            ),
            PUBLISHABLE_KEY,
            token,
        );
        let args = curl_args(&write, TIME_BUDGET);
        assert_eq!(apikey_headers(&args), vec![format!("apikey: {PUBLISHABLE_KEY}")], "{args:?}");
        assert_eq!(
            authorization_header(&args).as_deref(),
            Some("Authorization: Bearer user-access-token"),
            "{args:?}"
        );
    }

    #[test]
    fn anonymous_auth_requests_never_send_authorization() {
        // Анонимные запросы авторизации: проект опознаёт `apikey`, а сессии ещё
        // нет. Публичный ключ в роли Bearer сервер отвергнет — Authorization
        // здесь появляться не должен ни в каком виде.
        let cases = [
            with_project_key(
                Request::post_secret(
                    "https://x.supabase.co/auth/v1/token?grant_type=password",
                    serde_json::json!({ "email": "user@example.com", "password": "secret" }),
                ),
                PUBLISHABLE_KEY,
            ),
            with_project_key(
                Request::post_secret(
                    "https://x.supabase.co/auth/v1/signup",
                    serde_json::json!({ "email": "user@example.com", "password": "secret" }),
                ),
                PUBLISHABLE_KEY,
            ),
            // Проверка доступности проекта: только apikey
            with_project_key(
                Request::get("https://x.supabase.co/auth/v1/health"),
                PUBLISHABLE_KEY,
            ),
        ];

        for request in &cases {
            let args = curl_args(request, TIME_BUDGET);
            assert!(
                apikey_headers(&args) == vec![format!("apikey: {PUBLISHABLE_KEY}")],
                "apikey не тот: {args:?}"
            );
            assert!(
                authorization_header(&args).is_none(),
                "Authorization у анонимного запроса — будет 401: {args:?}"
            );
        }
    }

    #[test]
    fn refresh_sends_the_user_refresh_token_not_the_project_key() {
        // Обновление сессии: в теле — refresh_token пользователя, в заголовке —
        // публичный ключ. Ни то, ни другое не должно подменять друг друга.
        let user_refresh_token = "user-refresh-token-42";
        let body = serde_json::json!({ "refresh_token": user_refresh_token });
        let request = with_project_key(
            Request::post_secret("https://x.supabase.co/auth/v1/token?grant_type=refresh_token", body.clone()),
            PUBLISHABLE_KEY,
        );
        let args = curl_args(&request, TIME_BUDGET);

        assert!(request.secret, "refresh-токен должен уходить через stdin");
        assert!(apikey_headers(&args) == vec![format!("apikey: {PUBLISHABLE_KEY}")], "{args:?}");
        assert!(authorization_header(&args).is_none(), "Authorization не нужен: {args:?}");
        // Ни ключ проекта, ни refresh-токен в командной строке не мелькают
        assert!(!args.iter().any(|arg| arg.contains(user_refresh_token)), "{args:?}");
        assert!(
            !args.iter().any(|arg| arg.contains(PUBLISHABLE_KEY) && arg.contains("Bearer")),
            "ключ проекта в Authorization: {args:?}"
        );
        // А в теле — именно refresh_token пользователя
        assert_eq!(request.body.as_ref(), Some(&body));
        assert_eq!(
            request.body.as_ref().and_then(|v| v.get("refresh_token")).and_then(|v| v.as_str()),
            Some(user_refresh_token)
        );
    }

    #[test]
    fn post_arguments_carry_the_json_body() {
        let request = Request::post_json(
            "https://x.supabase.co/rest/v1/user_data",
            serde_json::json!([{ "id": 1 }]),
        )
        .header("Prefer", "resolution=merge-duplicates");
        let args = curl_args(&request, TIME_BUDGET);
        assert!(args.contains(&"POST".to_string()));
        assert!(args.iter().any(|arg| arg == "Content-Type: application/json"));
        assert!(args.iter().any(|arg| arg == "Prefer: resolution=merge-duplicates"));
        let body = args
            .iter()
            .position(|arg| arg == "--data-binary")
            .map(|index| args[index + 1].clone())
            .expect("тело запроса");
        assert_eq!(body, r#"[{"id":1}]"#);

        // Запасной путь тоже несёт свои аргументы
        let ureq = ureq_args(&request, TIME_BUDGET);
        assert!(ureq.iter().any(|arg| arg == "--max-time"));
        assert!(ureq.contains(&"Prefer: resolution=merge-duplicates".to_string()));
    }

    #[test]
    fn secret_bodies_never_reach_the_command_line() {
        // Пароли и refresh-токены не должны попадать ни в командную строку,
        // ни в список процессов: тело уходит через stdin (`--data-binary @-`).
        let password = "SuperSecret!123";
        let cases = [
            with_project_key(
                Request::post_secret(
                    "https://x.supabase.co/auth/v1/token?grant_type=password",
                    serde_json::json!({ "email": "user@example.com", "password": password }),
                ),
                PUBLISHABLE_KEY,
            ),
            with_project_key(
                Request::post_secret(
                    "https://x.supabase.co/auth/v1/signup",
                    serde_json::json!({ "email": "user@example.com", "password": password }),
                ),
                PUBLISHABLE_KEY,
            ),
            with_project_key(
                Request::post_secret(
                    "https://x.supabase.co/auth/v1/token?grant_type=refresh_token",
                    serde_json::json!({ "refresh_token": "refresh-secret" }),
                ),
                PUBLISHABLE_KEY,
            ),
        ];

        for request in &cases {
            assert!(request.secret, "запрос с паролем помечен как секретный");
            let args = curl_args(request, TIME_BUDGET);

            // Тело — из stdin, а не текстом в командной строке
            let body_arg = args
                .iter()
                .position(|arg| arg == "--data-binary")
                .map(|index| args[index + 1].clone())
                .expect("тело запроса");
            assert_eq!(body_arg, "@-", "тело не ушло в stdin: {args:?}");

            // Ни пароля, ни самого слова «password» в аргументах нет
            assert!(!args.iter().any(|arg| arg.contains(password)), "пароль в аргументах: {args:?}");
            assert!(
                !args.iter().any(|arg| arg.contains("refresh-secret")),
                "refresh-токен в аргументах: {args:?}"
            );
            // Аргумент `@-` о теле и не говорит, а JSON-тела в аргументах нет
            assert!(
                !args.iter().any(|arg| arg.starts_with("{\"")),
                "тело JSON в аргументах: {args:?}"
            );
            // Значение из тела (в том числе email) в аргументах не мелькает
            assert!(!args.iter().any(|arg| arg.contains("@example.com")));

            // …и при этом тело действительно готово к отправке на stdin
            let body = String::from_utf8(request.body_bytes().expect("тело")).expect("utf-8");
            assert!(body.contains(password) || body.contains("refresh-secret"));
            assert!(body.contains("password") || body.contains("refresh_token"));
        }

        // Обычная отправка данных по-прежнему идёт аргументом, а не через stdin
        let plain = Request::post_json(
            "https://x.supabase.co/rest/v1/user_data",
            serde_json::json!([{ "item_id": "1" }]),
        );
        assert!(!plain.secret);
        let args = curl_args(&plain, TIME_BUDGET);
        let body_arg = args
            .iter()
            .position(|arg| arg == "--data-binary")
            .map(|index| args[index + 1].clone())
            .expect("тело запроса");
        assert_eq!(body_arg, r#"[{"item_id":"1"}]"#);
    }

    #[test]
    fn curl_reads_stdin_and_reports_a_failed_request() {
        // Живой curl без сети: он обязан прочитать тело со stdin (`@-`) и лишь
        // потом попытаться соединиться. Адрес заведомо мёртвый, поэтому важны
        // две вещи: помощник не зависает на записи в stdin и честно отдаёт
        // «не получилось» — вызывающий код тогда уходит на запасной путь ureq.
        if std::process::Command::new("curl")
            .arg("--version")
            .output()
            .is_err()
        {
            return; // curl нет: запасной путь ureq держит тело внутри процесса
        }

        let args: Vec<String> = vec![
            "-sS".into(),
            "--max-time".into(),
            "20".into(),
            "-X".into(),
            "POST".into(),
            "-H".into(),
            "Content-Type: application/json".into(),
            "--data-binary".into(),
            SECRET_BODY.into(),
            "-w".into(),
            "\n%{http_code}".into(),
            "http://127.0.0.1:1/supabase-not-reachable".into(),
        ];
        let body = br#"{"email":"u@example.com","password":"SuperSecret!123"}"#.to_vec();

        // Соединения нет — результат None, и никакого зависания
        assert!(run_curl_with_stdin(&args, body).is_none());

        // В аргументах командной строки тела и пароля нет ни на байт
        assert!(!args.iter().any(|arg| arg.contains("SuperSecret!123")));
        assert!(!args.iter().any(|arg| arg.contains("@example.com")));
        assert_eq!(
            args.iter()
                .position(|arg| arg == "--data-binary")
                .map(|index| args[index + 1].as_str()),
            Some(SECRET_BODY)
        );
    }

    #[test]
    fn curl_reply_splits_the_status_code() {
        let reply = split_curl_reply("{\"ok\":true}\n200");
        assert_eq!(reply.code, 200);
        assert_eq!(reply.text, "{\"ok\":true}");

        let reply = split_curl_reply("");
        assert_eq!(reply.code, 0);
        assert_eq!(reply.text, "");

        // Код пропал — не паникуем, а считаем, что сети не было
        let reply = split_curl_reply("тело без кода");
        assert_eq!(reply.code, 0);
        assert_eq!(reply.text, "тело без кода");
    }

    #[test]
    fn requests_without_a_project_url_are_refused_before_network() {
        let request = Request::get("x.supabase.co/rest/v1/user_data");
        assert_eq!(
            send(&request).unwrap_err(),
            "Адрес проекта должен начинаться с https://"
        );
    }

    #[test]
    fn json_is_parsed_only_for_successful_responses() {
        let ok = Response { code: 200, text: r#"[{"id":1}]"#.into() };
        assert!(json_of(&ok).unwrap().is_array());

        // Пустой ответ 204 — не ошибка
        let empty = Response { code: 204, text: String::new() };
        assert!(json_of(&empty).unwrap().is_null());

        let failed = Response { code: 422, text: r#"{"error_code":"user_already_exists"}"#.into() };
        assert_eq!(json_of(&failed).unwrap_err(), "Пользователь уже существует");
    }

    #[test]
    fn local_commands_do_not_touch_the_network_without_configuration() {
        // Проверка без сети: пустая конфигурация (в тестовом окружении файла
        // настроек нет) — команды отвечают понятной ошибкой.
        if load().map(|session| session.configured()).unwrap_or(false) {
            return; // на машине разработчика уже настроен проект: не мешаем
        }
        assert!(sign_in("a@b.c", "secret").unwrap_err().contains("не настроен"));
        assert!(sign_up("a@b.c", "secret", None).unwrap_err().contains("не настроен"));
        assert!(sign_up("a@b.c", "secret", Some("abcd-efgh-jklm"))
            .unwrap_err()
            .contains("не настроен"));
        assert!(push(&[serde_json::json!({ "id": 1 })]).unwrap_err().contains("не настроен"));
        assert!(pull(0).unwrap_err().contains("не настроен"));
        assert!(profile_get("u-1").unwrap_err().contains("не настроен"));
        assert!(profile_search("cursed").unwrap_err().contains("не настроен"));
        assert!(profile_upsert("cursed", "Cursed", None, None, "", None)
            .unwrap_err()
            .contains("не настроен"));
        // Выход без настройки — молчаливая операция над пустым файлом
        let session = Session::default();
        assert!(!session.configured());
    }

    // ---------- Профили ----------

    #[test]
    fn profile_row_is_read_into_camel_case_fields() {
        let row = serde_json::json!({
            "id": "u-1",
            "username": "cursed",
            "display_name": "  Cursed  ",
            "avatar": "data:image/png;base64,AAA",
            "banner": null,
            "bio": " слушаю ночью ",
            "privacy": { "stats": false },
            "updated_at": "2024-05-01T10:00:00.000Z"
        });
        let profile = profile_from_row(&row);
        assert_eq!(profile.id, "u-1");
        assert_eq!(profile.username, "cursed");
        assert_eq!(profile.display_name.as_deref(), Some("Cursed"));
        assert_eq!(profile.bio.as_deref(), Some("слушаю ночью"));
        assert_eq!(profile.banner, None);
        assert_eq!(profile.privacy["stats"], serde_json::json!(false));

        // Интерфейс ждёт camelCase: как у SyncStatus
        let text = serde_json::to_string(&profile).unwrap();
        for key in ["\"displayName\"", "\"updatedAt\"", "\"privacy\""] {
            assert!(text.contains(key), "нет поля {key}: {text}");
        }
        assert!(!text.contains("display_name"), "snake_case наружу: {text}");
        assert!(!text.contains("banner"), "пустое поле не уходит: {text}");
    }

    #[test]
    fn broken_profile_row_does_not_panic() {
        let profile = profile_from_row(&serde_json::json!({}));
        assert_eq!(profile, Profile::default());
        assert_eq!(profile.privacy, serde_json::json!({}));
        assert_eq!(profile.id, "");
        // `privacy` не объект — считаем, что приватность не настроена
        let profile = profile_from_row(&serde_json::json!({ "privacy": "нет", "id": 7 }));
        assert_eq!(profile.privacy, serde_json::json!({}));
        assert_eq!(profile.id, "");
    }

    #[test]
    fn username_is_normalized_like_in_the_interface() {
        assert_eq!(check_username("  @Cursed ").unwrap(), "cursed");
        assert_eq!(check_username("dj.night_42").unwrap(), "dj.night_42");
        assert_eq!(check_username("abc").unwrap(), "abc");
        assert_eq!(check_username("a".repeat(20).as_str()).unwrap().len(), 20);

        let mut bad = vec![
            "".to_string(),
            "ab".to_string(),
            "@".to_string(),
            "user name".to_string(),
            "юзер".to_string(),
            "имя!".to_string(),
            "-lead".to_string(),
        ];
        bad.push("a".repeat(21));
        for value in bad {
            assert!(check_username(&value).is_err(), "приняли: {value:?}");
        }
    }

    #[test]
    fn empty_profile_fields_become_null() {
        assert_eq!(trimmed("   "), None);
        assert_eq!(trimmed("  Cursed  ").as_deref(), Some("Cursed"));
        assert_eq!(trimmed(""), None);
    }

    #[test]
    fn oversized_pictures_are_refused_before_upload() {
        assert_eq!(image_or_none(None, "Аватар").unwrap(), None);
        assert_eq!(image_or_none(Some("   "), "Аватар").unwrap(), None);
        assert_eq!(
            image_or_none(Some("https://x/y.png"), "Аватар").unwrap().as_deref(),
            Some("https://x/y.png")
        );
        let small = format!("data:image/png;base64,{}", "a".repeat(100));
        assert!(image_or_none(Some(&small), "Аватар").unwrap().is_some());
        let big = "a".repeat(MAX_IMAGE_CHARS + 1);
        let error = image_or_none(Some(&big), "Аватар").unwrap_err();
        assert!(error.contains("слишком большой"), "получили: {error}");
        assert!(error.contains("Аватар"), "получили: {error}");
    }

    #[test]
    fn search_query_is_sanitized_for_postgrest() {
        assert_eq!(sanitize_query("  Cursed  "), "cursed");
        assert_eq!(sanitize_query("dj.night_42"), "dj.night_42");
        // Запятые, скобки и звёздочки ломают `or=(...)` — их выбрасываем
        assert_eq!(sanitize_query("a,b(c)*d"), "abcd");
        assert_eq!(sanitize_query("ночь  волна"), "ночь волна");
        assert_eq!(sanitize_query("   "), "");
        assert_eq!(sanitize_query("###"), "");
        assert_eq!(sanitize_query(&"x".repeat(100)).chars().count(), 40);
    }

    #[test]
    fn search_url_carries_ilike_and_the_limit() {
        let url = profile_search_url("https://x.supabase.co", "cursed");
        assert!(url.starts_with("https://x.supabase.co/rest/v1/profiles?"), "{url}");
        assert!(
            url.contains("or=(username.ilike.*cursed*,display_name.ilike.*cursed*)"),
            "{url}"
        );
        assert!(url.contains("limit=20"), "{url}");
        assert!(url.contains("select=id,username"), "{url}");

        // Пробел и кириллица уезжают процентным кодированием
        let url = profile_search_url("https://x.supabase.co", sanitize_query("ночь волна").as_str());
        assert!(!url.contains(' '), "пробел в адресе: {url}");
        assert!(url.contains("%D0%BD"), "кириллица не закодирована: {url}");
        assert!(url.contains("%20"), "пробел не закодирован: {url}");
    }

    #[test]
    fn profile_get_url_asks_for_exactly_one_user() {
        let url = profile_get_url("https://x.supabase.co", " u-1 ");
        assert_eq!(
            url,
            format!("https://x.supabase.co/rest/v1/profiles?select={PROFILE_COLUMNS}&id=eq.u-1&limit=1")
        );
    }

    #[test]
    fn occupied_username_is_reported_clearly() {
        let text = r#"{"code":"23505","message":"duplicate key value violates unique constraint"}"#;
        assert_eq!(
            profile_write_error(409, text).as_deref(),
            Some("Этот юзернейм уже занят — выбери другой")
        );
        assert_eq!(
            profile_write_error(400, text).as_deref(),
            Some("Этот юзернейм уже занят — выбери другой")
        );
        assert_eq!(profile_write_error(201, r#"[{"id":"u-1"}]"#), None);
        assert_eq!(profile_write_error(200, ""), None);
    }

    #[test]
    fn hidden_profiles_are_not_shown_in_search() {
        // Явное «не находить меня» уважаем, отсутствие поля — «находить можно»
        assert!(profile_is_discoverable(&serde_json::json!({})));
        assert!(profile_is_discoverable(&serde_json::json!({ "privacy": {} })));
        assert!(profile_is_discoverable(&serde_json::json!({ "privacy": { "discoverable": true } })));
        assert!(!profile_is_discoverable(&serde_json::json!({ "privacy": { "discoverable": false } })));
        // Непонятное значение не прячет человека
        assert!(profile_is_discoverable(&serde_json::json!({ "privacy": { "discoverable": "нет" } })));
    }

    #[test]
    fn closed_registration_is_explained_to_the_user() {
        // GoTrue прячет текст исключения триггера за общим сообщением
        let text =
            r#"{"code":500,"error_code":"unexpected_failure","msg":"Database error saving new user"}"#;
        let message = apply_error(500, text);
        assert!(message.contains("Регистрация временно закрыта"), "получили: {message}");
        assert!(message.contains("бете"), "получили: {message}");

        // Если Supabase всё же отдаст текст триггера — тоже узнаём
        assert!(apply_error(500, r#"{"msg":"registration_closed"}"#).contains("временно закрыта"));
        assert!(apply_error(400, r#"{"message":"Registration is closed"}"#)
            .contains("временно закрыта"));

        // Прочие пятисотые остаются как были
        assert!(apply_error(500, "boom").starts_with("Supabase ответил 500"));
    }
}
