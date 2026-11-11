//! Общий сетевой транспорт приложения: постоянный HTTP-клиент, маршруты
//! (напрямую / локальный прокси / авто-гонка), кэш DNS на процесс и запасной
//! путь через `curl` с DNS over HTTPS.
//!
//! Почему так, а не «каждый запрос — новый `curl`»: у отдельного процесса
//! каждый раз свой DNS, свой TCP и свой TLS, а на медленном канале это и есть
//! та самая «долгая загрузка». Поэтому основной путь — один живой `ureq`-агент
//! на маршрут: соединения переиспользуются (keep-alive), а таймауты одинаковы
//! для всех запросов.
//!
//! `curl` остаётся запасным путём: он умеет DNS over HTTPS (когда системный DNS
//! врёт) и SOCKS-прокси, которых нет в `ureq` без дополнительной зависимости.
//! Секретные тела (пароль, refresh-токен) и там, и там не попадают в аргументы
//! командной строки: `ureq` держит тело в процессе, `curl` читает его со stdin.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Общий бюджет одного запроса — как у соседних модулей.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Сколько ждём установления соединения (DNS + TCP + TLS).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// Сколько живёт запись кэша DNS: десять минут.
pub const DNS_TTL: Duration = Duration::from_secs(600);
/// Больше адресов в кэше не держим: хостов у приложения немного.
const DNS_CAPACITY: usize = 64;
/// Таймаут TCP-проверки локального прокси: короткий, чтобы поиск был быстрым.
const PROBE_TIMEOUT: Duration = Duration::from_millis(350);
/// Куда смотрим локальный прокси: типичные порты Clash, v2ray, SOCKS и Tor.
const PROXY_PORTS: [u16; 7] = [7890, 7891, 1080, 10808, 2080, 9150, 10801];
/// Сколько помним результат поиска локального прокси.
const LOCAL_PROXY_TTL: Duration = Duration::from_secs(300);

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
pub const DOH_URL: &str = "https://1.1.1.1/dns-query";
/// `--ssl-no-revoke` понимает только Schannel (сборка curl для Windows).
#[cfg(windows)]
const SSL_NO_REVOKE: &str = "--ssl-no-revoke";
#[cfg(not(windows))]
const SSL_NO_REVOKE: &str = "-k";

/// Тело секретного POST: curl прочитает его со стандартного ввода, поэтому в
/// аргументах и списке процессов тела не будет.
const SECRET_BODY: &str = "@-";

// ---------- Маршруты и прокси ----------

/// Как ходить в сеть. `Auto` — гонка прямого пути и прокси.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Direct,
    Proxy,
    Auto,
}

impl Route {
    /// Разбор значения из настроек: неизвестное считаем «авто».
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "direct" => Route::Direct,
            "proxy" => Route::Proxy,
            _ => Route::Auto,
        }
    }

    /// Подпись маршрута для сообщений об ошибках и журнала.
    pub fn as_str(self) -> &'static str {
        match self {
            Route::Direct => "direct",
            Route::Proxy => "proxy",
            Route::Auto => "auto",
        }
    }
}

/// Схема прокси. `socks5h` — единственная, где имя хоста резолвит прокси,
/// поэтому она и стоит первой в автопоиске.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyScheme {
    Socks5h,
    Socks5,
    Http,
    Https,
}

impl ProxyScheme {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "socks5h" => Some(ProxyScheme::Socks5h),
            "socks5" => Some(ProxyScheme::Socks5),
            "http" => Some(ProxyScheme::Http),
            "https" => Some(ProxyScheme::Https),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ProxyScheme::Socks5h => "socks5h",
            ProxyScheme::Socks5 => "socks5",
            ProxyScheme::Http => "http",
            ProxyScheme::Https => "https",
        }
    }
}

/// Разобранный адрес локального (или своего) прокси.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxySpec {
    pub scheme: ProxyScheme,
    pub host: String,
    pub port: u16,
}

impl ProxySpec {
    /// Адрес в том виде, в каком его понимает curl (`--proxy`).
    pub fn url(&self) -> String {
        format!("{}://{}:{}", self.scheme.as_str(), self.host, self.port)
    }

    /// Прокси для постоянного агента. `ureq` без фичи `socks-proxy` умеет
    /// только HTTP-прокси, поэтому для SOCKS и HTTPS вызывающий уходит на curl.
    pub fn for_ureq(&self) -> Result<ureq::Proxy, String> {
        match self.scheme {
            ProxyScheme::Http => ureq::Proxy::new(self.url())
                .map_err(|_| format!("Не удалось разобрать прокси {}", self.url())),
            ProxyScheme::Https => Err("HTTPS-прокси поддерживается только через curl".into()),
            ProxyScheme::Socks5h | ProxyScheme::Socks5 => {
                Err("SOCKS-прокси поддерживается только через curl".into())
            }
        }
    }
}

/// Разбор и проверка адреса прокси из настроек.
///
/// Поддерживаются схемы `socks5h://`, `socks5://`, `http://` и `https://`;
/// порт обязателен. Публичные списки прокси не поддерживаются и не вшиваются —
/// берём только то, что ввёл пользователь (или что нашлось локально).
pub fn parse_proxy(value: &str) -> Result<ProxySpec, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Адрес прокси пуст".into());
    }
    let (scheme_text, rest) = value.split_once("://").ok_or_else(|| {
        "Прокси должен начинаться со схемы: socks5h://, socks5://, http:// или https://".to_string()
    })?;
    let scheme = ProxyScheme::parse(scheme_text).ok_or_else(|| {
        format!("Неизвестная схема прокси «{scheme_text}»: подходят socks5h, socks5, http и https")
    })?;

    if rest.contains('/') || rest.contains('?') || rest.contains('#') {
        return Err("В адресе прокси не должно быть пути: нужен только host:port".into());
    }
    if rest.contains('@') {
        return Err("Прокси с логином и паролем не поддерживается".into());
    }
    if rest.chars().any(char::is_whitespace) {
        return Err("В адресе прокси не должно быть пробелов".into());
    }

    let (host, port) = rest
        .rsplit_once(':')
        .ok_or_else(|| "В адресе прокси нужен порт, например 127.0.0.1:7890".to_string())?;
    let host = host.trim();
    if host.is_empty() {
        return Err("В адресе прокси не хватает хоста".into());
    }
    let port: u16 = port
        .trim()
        .parse()
        .map_err(|_| format!("Порт прокси «{port}» — не число"))?;
    if port == 0 {
        return Err("Порт прокси не может быть нулевым".into());
    }

    Ok(ProxySpec {
        scheme,
        host: host.to_string(),
        port,
    })
}

/// Аргументы прокси для внешних curl-вызовов: при прямом маршруте их нет.
pub fn curl_route_args_for(route: Route, proxy: Option<&ProxySpec>) -> Vec<String> {
    match (route, proxy) {
        (Route::Direct, _) | (_, None) => Vec::new(),
        (_, Some(spec)) => vec!["--proxy".to_string(), spec.url()],
    }
}

/// Аргументы прокси по текущим настройкам.
pub fn curl_route_args() -> Vec<String> {
    let config = configured();
    curl_route_args_for(config.route, config.proxy.as_ref())
}

// ---------- Кэш DNS ----------

/// Кэш «хост → адрес» на процесс: обложки и сегменты не должны резолвить один
/// и тот же хост каждый раз заново.
#[derive(Debug, Default)]
pub struct DnsCache {
    entries: Mutex<HashMap<String, (String, Instant)>>,
}

impl DnsCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Адрес из кэша, если он ещё не протух.
    pub fn get(&self, host: &str, now: Instant) -> Option<String> {
        let entries = self.entries.lock().ok()?;
        let (ip, expires_at) = entries.get(host)?;
        if now >= *expires_at {
            return None;
        }
        Some(ip.clone())
    }

    /// Запомнить адрес на `ttl` от момента `now`.
    pub fn put(&self, host: &str, ip: &str, now: Instant, ttl: Duration) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if entries.len() >= DNS_CAPACITY {
            entries.retain(|_, (_, expires_at)| now < *expires_at);
            if entries.len() >= DNS_CAPACITY {
                entries.clear();
            }
        }
        entries.insert(host.to_string(), (ip.to_string(), now + ttl));
    }

    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }

    /// Сколько записей сейчас в кэше (нужно тестам и проверке сброса).
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.entries.lock().map(|entries| entries.len()).unwrap_or(0)
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn dns() -> &'static DnsCache {
    static CACHE: OnceLock<DnsCache> = OnceLock::new();
    CACHE.get_or_init(DnsCache::new)
}

/// Адрес хоста из кэша (или `None`, если его там нет).
pub fn cached_ip(host: &str) -> Option<String> {
    dns().get(host, Instant::now())
}

/// Запомнить адрес хоста на стандартный TTL.
pub fn remember_ip(host: &str, ip: &str) {
    dns().put(host, ip, Instant::now(), DNS_TTL);
}

/// Ручной сброс кэша DNS: после смены маршрута или обхода блокировок.
pub fn clear_dns_cache() {
    dns().clear();
}

/// Хост из абсолютного адреса. Порт, путь и логин отбрасываются.
pub fn host_of(url: &str) -> Option<&str> {
    let rest = url.split_once("://").map(|(_, rest)| rest)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let authority = authority.rsplit_once('@').map(|(_, host)| host).unwrap_or(authority);
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    };
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

// ---------- Локальный прокси: поиск ----------

/// Найденные локальные прокси: адрес в том виде, в каком его можно сохранить.
fn local_proxy_candidates(open_ports: &[u16]) -> Vec<String> {
    let mut found = Vec::new();
    for port in PROXY_PORTS {
        if !open_ports.contains(&port) {
            continue;
        }
        // SOCKS5H первым: с ним имя хоста резолвит прокси, а не провайдер.
        found.push(format!("socks5h://127.0.0.1:{port}"));
        found.push(format!("http://127.0.0.1:{port}"));
    }
    found
}

fn state_local() -> &'static Mutex<Option<(Vec<String>, Instant)>> {
    static LOCAL: OnceLock<Mutex<Option<(Vec<String>, Instant)>>> = OnceLock::new();
    LOCAL.get_or_init(|| Mutex::new(None))
}

/// Поиск без сети наружу: только TCP-подключение к своему же 127.0.0.1.
fn detect_with<F>(probe: F) -> Vec<String>
where
    F: Fn(&str, u16) -> bool + Sync,
{
    let mut open = Vec::new();
    std::thread::scope(|scope| {
        let handles: Vec<_> = PROXY_PORTS
            .iter()
            .map(|&port| {
                let probe = &probe;
                scope.spawn(move || (port, probe("127.0.0.1", port)))
            })
            .collect();
        for handle in handles {
            if let Ok((port, true)) = handle.join() {
                open.push(port);
            }
        }
    });
    local_proxy_candidates(&open)
}

fn tcp_probe(host: &str, port: u16) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs.into_iter().any(|addr| {
        TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
    })
}

/// Найти локальный прокси и запомнить результат на пять минут.
pub fn detect_local_proxy() -> Vec<String> {
    let found = detect_with(tcp_probe);
    if let Ok(mut slot) = state_local().lock() {
        *slot = Some((found.clone(), Instant::now()));
    }
    found
}

/// Уже найденные локальные прокси (без новых TCP-попыток).
pub fn cached_local_proxies() -> Vec<String> {
    let Ok(slot) = state_local().lock() else {
        return Vec::new();
    };
    match slot.as_ref() {
        Some((found, at)) if at.elapsed() < LOCAL_PROXY_TTL => found.clone(),
        _ => Vec::new(),
    }
}

/// Первый найденный локальный прокси — для режима «авто».
fn cached_local_proxy() -> Option<ProxySpec> {
    cached_local_proxies()
        .into_iter()
        .find_map(|value| parse_proxy(&value).ok())
}

/// Прогреть поиск в фоне: интерфейс не должен ждать TCP-попыток.
pub fn refresh_local_proxies() {
    std::thread::spawn(detect_local_proxy);
}

// ---------- Настройки маршрута ----------

#[derive(Debug, Clone)]
struct Config {
    route: Route,
    proxy: Option<ProxySpec>,
}

fn state_config() -> &'static Mutex<Config> {
    static CONFIG: OnceLock<Mutex<Config>> = OnceLock::new();
    CONFIG.get_or_init(|| {
        Mutex::new(Config {
            route: Route::Auto,
            proxy: None,
        })
    })
}

/// Применить настройки сети из интерфейса. Мусорный адрес прокси — понятная
/// ошибка, прежние настройки при этом не меняются.
pub fn configure(route: Route, proxy_url: Option<&str>) -> Result<(), String> {
    let proxy = match proxy_url.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Some(parse_proxy(value)?),
        None => None,
    };
    let mut config = state_config()
        .lock()
        .map_err(|_| "Настройки сети недоступны".to_string())?;
    config.route = route;
    config.proxy = proxy;
    Ok(())
}

/// Текущие настройки. В режиме «авто» без своего прокси берём найденный
/// локальный — если он уже был найден (поиск не блокирует запрос).
fn configured() -> Config {
    let config = state_config()
        .lock()
        .map(|config| config.clone())
        .unwrap_or(Config {
            route: Route::Auto,
            proxy: None,
        });
    if config.route == Route::Auto && config.proxy.is_none() {
        return Config {
            route: config.route,
            proxy: cached_local_proxy(),
        };
    }
    config
}

// ---------- Отмена ----------

/// Общая отмена для гонки: проигравший поток видит флаг и не продолжает.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

// ---------- Запрос и ответ ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

/// Одно HTTP-обращение: адрес, метод, заголовки и необязательное тело.
#[derive(Debug, Clone, PartialEq)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Тело секретное: в командную строку curl оно не попадает никогда.
    pub secret: bool,
    pub user_agent: Option<String>,
    /// Свой таймаут вместо общего (например, у поиска текста бюджет меньше).
    pub timeout: Option<Duration>,
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: Method::Get,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            secret: false,
            user_agent: None,
            timeout: None,
        }
    }

    pub fn post(url: impl Into<String>, body: Vec<u8>) -> Self {
        Self {
            method: Method::Post,
            body: Some(body),
            ..Self::get(url)
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    /// Пометить тело секретным: curl получит его через stdin.
    pub fn secret(mut self) -> Self {
        self.secret = true;
        self
    }

    pub fn user_agent(mut self, value: &str) -> Self {
        self.user_agent = Some(value.to_string());
        self
    }

    pub fn timeout(mut self, value: Duration) -> Self {
        self.timeout = Some(value);
        self
    }

    fn agent_name(&self) -> &str {
        self.user_agent.as_deref().unwrap_or(USER_AGENT)
    }

    fn has_header(&self, name: &str) -> bool {
        self.headers
            .iter()
            .any(|(header, _)| header.eq_ignore_ascii_case(name))
    }

    fn timeout_or_default(&self) -> Duration {
        self.timeout.unwrap_or(REQUEST_TIMEOUT)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub code: u16,
    pub text: String,
}

// ---------- Постоянный клиент ----------

// ---------- Свой DNS: обход подмены адреса ----------

/// Домены, к которым ходим через свой DNS.
///
/// Только SoundCloud: остальные сервисы работают, и их трогать не нужно.
const DOH_HOSTS: [&str; 3] = ["api-v2.soundcloud.com", "api.soundcloud.com", "api-widget.soundcloud.com"];

/// DNS-over-HTTPS решатели: если один заслонён, пробуем второй.
const DOH_ENDPOINTS: [&str; 2] = [
    "https://cloudflare-dns.com/dns-query?name={host}&type=A",
    "https://dns.google/resolve?name={host}&type=A",
];

/// Кэш адресов: (хост, адрес, когда получен).
fn doh_cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Разбирает ответ DoH и достаёт адрес A-записи.
fn doh_pick_address(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    // Cloudflare отдаёт JSON с перечислением, Google — свой список Answer.
    if let Some(list) = value.get("Answer").and_then(|v| v.as_array()) {
        for item in list {
            if item.get("type").and_then(|t| t.as_u64()) == Some(1) {
                if let Some(data) = item.get("data").and_then(|d| d.as_str()) {
                    return Some(data.to_string());
                }
            }
        }
    }
    if let Some(list) = value.get("Answer").and_then(|v| v.as_array()) {
        for item in list {
            if let Some(data) = item.get("data").and_then(|d| d.as_str()) {
                return Some(data.to_string());
            }
        }
    }
    None
}

/// Спрашивает адрес у DoH. Возвращает первый ответивший.
fn doh_resolve(host: &str) -> Option<String> {
    // Соединение с самим DoH идёт обычным путём: он не подменён.
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(4))
        .timeout(Duration::from_secs(6))
        .build();
    for template in DOH_ENDPOINTS {
        let url = template.replace("{host}", host);
        let response = agent
            .get(&url)
            .set("Accept", "application/dns-json")
            .set("User-Agent", "cursed-player")
            .call();
        if let Ok(response) = response {
            if let Ok(body) = response.into_string() {
                if let Some(address) = doh_pick_address(&body) {
                    return Some(address);
                }
            }
        }
    }
    None
}

/// Адрес для домена: из кэша, через DoH или обычным DNS, если DoH не ответил.
fn resolve_host(host: &str) -> Option<String> {
    let ttl = Duration::from_secs(600);
    if let Ok(cache) = doh_cache().lock() {
        if let Some((address, at)) = cache.get(host) {
            if at.elapsed() < ttl {
                return Some(address.clone());
            }
        }
    }
    let address = doh_resolve(host)?;
    if let Ok(mut cache) = doh_cache().lock() {
        cache.insert(host.to_string(), (address.clone(), Instant::now()));
    }
    Some(address)
}

/// Резолвер для ureq: SoundCloud идёт через наш DNS, остальное — системный.
///
/// Если DoH не ответил, отдаём обычный адрес: лучше попробовать, чем упасть.
///
/// ureq ждёт список адресов: отдаём один — первый рабочий по нашему DNS,
/// иначе все системные (обычный случай).
fn resilient_resolver(
    host: &str,
) -> std::io::Result<Vec<std::net::SocketAddr>> {
    let needs_own_dns = DOH_HOSTS
        .iter()
        .any(|known| host == *known || host.ends_with(&format!(".{known}")));
    if needs_own_dns {
        if let Some(address) = resolve_host(host) {
            if let Ok(socket) = format!("{address}:443").parse() {
                return Ok(vec![socket]);
            }
        }
    }
    // Обычный путь: всё, что вернул системный резолвер.
    use std::net::ToSocketAddrs;
    let list: Vec<std::net::SocketAddr> = (host, 443)
        .to_socket_addrs()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
        .collect();
    if list.is_empty() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "адрес не найден"));
    }
    Ok(list)
}
fn agents() -> &'static Mutex<HashMap<String, ureq::Agent>> {
    static AGENTS: OnceLock<Mutex<HashMap<String, ureq::Agent>>> = OnceLock::new();
    AGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Агент на маршрут: соединения переиспользуются, таймауты одинаковы. Ключ
/// пула — адрес прокси, поэтому прямой путь и прокси не делят соединения.
fn agent_for(proxy: Option<&ProxySpec>) -> Result<ureq::Agent, String> {
    let key = proxy.map(ProxySpec::url).unwrap_or_else(|| "direct".to_string());
    if let Ok(map) = agents().lock() {
        if let Some(agent) = map.get(&key) {
            return Ok(agent.clone());
        }
    }

    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        // Свой DNS: провайдер подменяет адрес SoundCloud, и поиск падает.
        .resolver(resilient_resolver);
    if let Some(spec) = proxy {
        builder = builder.proxy(spec.for_ureq()?);
    }
    let agent = builder.build();
    if let Ok(mut map) = agents().lock() {
        map.insert(key, agent.clone());
    }
    Ok(agent)
}

fn ureq_call(request: &HttpRequest, proxy: Option<&ProxySpec>) -> Result<HttpResponse, String> {
    let agent = agent_for(proxy)?;
    let mut call = match request.method {
        Method::Get => agent.get(&request.url),
        Method::Post => agent.post(&request.url),
    };
    call = call
        .timeout(request.timeout_or_default())
        .set("User-Agent", request.agent_name());
    for (name, value) in &request.headers {
        call = call.set(name, value);
    }
    // Секретное тело у curl получает Content-Type сам; здесь ставим руками.
    if request.body.is_some() && !request.has_header("Content-Type") {
        call = call.set("Content-Type", "application/json");
    }

    let outcome = match &request.body {
        Some(body) => call.send_bytes(body),
        None => call.call(),
    };

    match outcome {
        Ok(response) => {
            let code = response.status();
            let text = response.into_string().unwrap_or_default();
            Ok(HttpResponse { code, text })
        }
        // 4xx/5xx — это ответ сервера, решение принимает вызывающий код
        Err(ureq::Error::Status(code, response)) => Ok(HttpResponse {
            code,
            text: response.into_string().unwrap_or_default(),
        }),
        Err(error) => Err(match proxy {
            Some(spec) => format!("прокси {}: {error}", spec.url()),
            None => error.to_string(),
        }),
    }
}

// ---------- Запасной путь: curl + DoH ----------

/// Порт для `--resolve`: 443 у https, 80 у http.
fn resolve_port(url: &str) -> u16 {
    if url.starts_with("https://") {
        443
    } else {
        80
    }
}

/// Аргументы curl для запроса. Вынесены отдельной функцией: её проверяют
/// тесты, поэтому флаги DoH, прокси и stdin не разъедутся с кодом.
pub fn curl_args(
    request: &HttpRequest,
    proxy: Option<&ProxySpec>,
    resolve: Option<(&str, &str)>,
) -> Vec<String> {
    let timeout = request.timeout_or_default().as_secs().max(1).to_string();
    let mut args: Vec<String> = vec![
        "-sS".into(),
        "--max-time".into(),
        timeout,
        "--connect-timeout".into(),
        CONNECT_TIMEOUT.as_secs().max(1).to_string(),
        "-X".into(),
        request.method.as_str().into(),
        SSL_NO_REVOKE.into(),
    ];

    // DoH остаётся на месте: именно он обходит подмену DNS провайдером.
    args.push("--doh-url".into());
    args.push(DOH_URL.into());

    // Адрес из кэша: curl не тратит время на DNS, но DoH-флаг не мешает.
    if let Some((host, ip)) = resolve {
        args.push("--resolve".into());
        args.push(format!("{host}:{}:{ip}", resolve_port(&request.url)));
    }

    if let Some(spec) = proxy {
        args.push("--proxy".into());
        args.push(spec.url());
    }

    if !request.has_header("User-Agent") {
        args.push("-A".into());
        args.push(request.agent_name().into());
    }
    for (name, value) in &request.headers {
        args.push("-H".into());
        args.push(format!("{name}: {value}"));
    }

    if let Some(body) = &request.body {
        if !request.has_header("Content-Type") {
            args.push("-H".into());
            args.push("Content-Type: application/json".into());
        }
        args.push("--data-binary".into());
        args.push(if request.secret {
            SECRET_BODY.into()
        } else {
            String::from_utf8_lossy(body).into_owned()
        });
    }

    // Код состояния и адрес сервера нужны отдельно: по адресу заполняем кэш DNS.
    args.push("-w".into());
    args.push("\n%{http_code}\n%{remote_ip}".into());
    args.push(request.url.clone());
    args
}

/// Разбор ответа curl: тело, код состояния и адрес сервера.
fn split_curl_reply(raw: &str) -> (HttpResponse, Option<String>) {
    let mut tail = raw.rsplitn(3, '\n');
    let ip = tail.next().unwrap_or("").trim().to_string();
    let code = tail.next().unwrap_or("").trim().to_string();
    let body = tail.next().unwrap_or("");

    match code.parse::<u16>() {
        Ok(code) => (
            HttpResponse {
                code,
                text: body.trim_end_matches(&['\r', '\n'][..]).to_string(),
            },
            Some(ip).filter(|value| !value.is_empty()),
        ),
        Err(_) => (
            HttpResponse {
                code: 0,
                text: raw.trim_end_matches(&['\r', '\n'][..]).to_string(),
            },
            None,
        ),
    }
}

/// curl с телом на стандартном вводе: тело пишет отдельный поток, иначе
/// большой ответ упёрся бы в заполненную трубу и оба процесса замерли бы.
fn run_curl_with_stdin(args: &[String], body: &[u8]) -> Result<Output, String> {
    use std::io::Write;

    let mut child = crate::silent::hidden("curl")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl недоступен: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "curl не принял stdin".to_string())?;
    let body = body.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&body);
        let _ = stdin.flush();
    });

    let output = child
        .wait_with_output()
        .map_err(|error| format!("curl не ответил: {error}"))?;
    let _ = writer.join();
    Ok(output)
}

fn curl_error(output: &Output) -> String {
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if error.is_empty() {
        "curl не получил ответ".into()
    } else {
        error
    }
}

fn curl_call(
    request: &HttpRequest,
    proxy: Option<&ProxySpec>,
    cancel: &Cancel,
) -> Result<HttpResponse, String> {
    if cancel.is_cancelled() {
        return Err("запрос отменён".into());
    }

    let host = host_of(&request.url).map(str::to_string);
    let cached = host.as_deref().and_then(cached_ip);
    let args = curl_args(
        request,
        proxy,
        host.as_deref().zip(cached.as_deref()),
    );

    let output = match (&request.body, request.secret) {
        (Some(body), true) => run_curl_with_stdin(&args, body)?,
        _ => crate::silent::hidden("curl")
            .args(&args)
            .output()
            .map_err(|error| format!("curl недоступен: {error}"))?,
    };

    if !output.status.success() {
        return Err(curl_error(&output));
    }

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let (response, remote_ip) = split_curl_reply(&raw);

    // Кэш заполняем только для прямого пути: через прокси remote_ip — это
    // адрес прокси, а не сайта.
    if proxy.is_none() {
        if let (Some(host), Some(ip)) = (host.as_deref(), remote_ip.as_deref()) {
            if !ip.is_empty() {
                remember_ip(host, ip);
            }
        }
    }

    Ok(response)
}

// ---------- Две попытки: прямой путь и прокси ----------

fn attempt_direct(request: &HttpRequest, cancel: &Cancel) -> Result<HttpResponse, String> {
    match ureq_call(request, None) {
        Ok(response) => Ok(response),
        Err(agent_error) => {
            if cancel.is_cancelled() {
                return Err("запрос отменён".into());
            }
            // Постоянный клиент пасует перед сертификатом или DNS — пробуем
            // curl с DoH: он ходит как браузер.
            curl_call(request, None, cancel)
                .map_err(|curl_error| format!("{agent_error}; {curl_error}"))
        }
    }
}

fn attempt_proxy(
    request: &HttpRequest,
    proxy: &ProxySpec,
    cancel: &Cancel,
) -> Result<HttpResponse, String> {
    // SOCKS и HTTPS-прокси постоянный клиент не умеет — сразу curl с --proxy.
    if proxy.for_ureq().is_ok() {
        match ureq_call(request, Some(proxy)) {
            Ok(response) => return Ok(response),
            Err(agent_error) => {
                if cancel.is_cancelled() {
                    return Err("запрос отменён".into());
                }
                return curl_call(request, Some(proxy), cancel)
                    .map_err(|curl_error| format!("{agent_error}; {curl_error}"));
            }
        }
    }
    curl_call(request, Some(proxy), cancel)
}

/// Маршрут, который ничего не ответил: одна честная ошибка вместо цикла попыток.
fn no_network(first: &str, second: &str) -> String {
    let shorten = |value: &str| value.chars().take(160).collect::<String>();
    if second.is_empty() {
        format!("Нет сети: {}", shorten(first))
    } else {
        format!(
            "Нет сети (прямой: {}; прокси: {})",
            shorten(first),
            shorten(second)
        )
    }
}

/// Гонка двух путей: первый успешный ответ выигрывает, проигравший отменяется.
/// Больше двух путей не запускается, общий срок — `deadline`.
pub fn race<T, A, B>(deadline: Duration, first: A, second: B) -> Result<T, String>
where
    T: Send + 'static,
    A: FnOnce(Cancel) -> Result<T, String> + Send + 'static,
    B: FnOnce(Cancel) -> Result<T, String> + Send + 'static,
{
    type Attempt<T> = Box<dyn FnOnce(Cancel) -> Result<T, String> + Send>;

    let (sender, receiver) = std::sync::mpsc::channel::<(usize, Result<T, String>)>();
    let cancelled = Cancel::new();

    let attempts: [Attempt<T>; 2] = [Box::new(first), Box::new(second)];
    for (index, attempt) in attempts.into_iter().enumerate() {
        let sender = sender.clone();
        let cancel = cancelled.clone();
        // Потоки не дожидаемся: проигравший не должен задерживать ответ.
        std::thread::spawn(move || {
            // Отменённый путь не начинаем вовсе — иначе он зря занимал бы канал
            if cancel.is_cancelled() {
                let _ = sender.send((index, Err("отменено".into())));
                return;
            }
            let wake = cancel.clone();
            let outcome = attempt(cancel);
            // Первый успех сам гасит второй путь, не дожидаясь главного потока:
            // иначе проигравший мог бы успеть начать лишнюю попытку.
            if outcome.is_ok() {
                wake.cancel();
            }
            let _ = sender.send((index, outcome));
        });
    }
    drop(sender);

    let started = Instant::now();
    let mut errors: Vec<(usize, String)> = Vec::new();

    loop {
        let left = deadline.saturating_sub(started.elapsed());
        if left.is_zero() {
            break;
        }
        match receiver.recv_timeout(left) {
            Ok((_, Ok(value))) => {
                // Проигравший больше не нужен: будим его флагом отмены
                cancelled.cancel();
                return Ok(value);
            }
            Ok((index, Err(error))) => {
                errors.push((index, error));
                // Оба пути уже отказали — ждать больше нечего
                if errors.len() >= 2 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    // Никто не выиграл: собираем понятную причину по обоим путям
    errors.sort_by_key(|(index, _)| *index);
    let first = errors.first().map(|(_, error)| error.clone()).unwrap_or_default();
    let second = errors.get(1).map(|(_, error)| error.clone()).unwrap_or_default();
    Err(no_network(&first, &second))
}

fn dispatch(
    request: &HttpRequest,
    route: Route,
    proxy: Option<&ProxySpec>,
) -> Result<HttpResponse, String> {
    match route {
        Route::Direct => attempt_direct(request, &Cancel::new()),
        Route::Proxy => match proxy {
            Some(spec) => attempt_proxy(request, spec, &Cancel::new()),
            None => Err("Прокси не задан: укажи адрес в настройках".into()),
        },
        Route::Auto => match proxy {
            Some(spec) => {
                let direct_request = Arc::new(request.clone());
                let proxy_request = Arc::new(request.clone());
                let spec = spec.clone();
                race(
                    REQUEST_TIMEOUT,
                    move |cancel| attempt_direct(direct_request.as_ref(), &cancel),
                    move |cancel| attempt_proxy(proxy_request.as_ref(), &spec, &cancel),
                )
            }
            // Прокси нет — гоним один прямой путь: второй такой же не нужен.
            None => attempt_direct(request, &Cancel::new()),
        },
    }
}

// ---------- Публичный интерфейс ----------

/// Выполнить запрос по текущим настройкам маршрута.
pub fn http(request: &HttpRequest) -> Result<HttpResponse, String> {
    let config = configured();
    let response = dispatch(request, config.route, config.proxy.as_ref())?;
    // 407 — прокси требует пароль: это не «нет сети», а понятная причина.
    if response.code == 407 {
        return Err("Прокси требует авторизацию — укажи адрес без логина и пароля".into());
    }
    Ok(response)
}

/// GET и текст ответа: годятся только 2xx, остальное — ошибка.
pub fn get_text(url: &str) -> Result<String, String> {
    let response = http(&HttpRequest::get(url))?;
    if !(200..300).contains(&response.code) {
        return Err(format!("Сервер ответил {}", response.code));
    }
    Ok(response.text)
}

/// Результат проверки маршрута для кнопки «Проверить».
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteCheck {
    pub ok: bool,
    pub ms: u64,
}

/// Адрес проверки: публичный API SoundCloud без секретов.
pub const ROUTE_CHECK_URL: &str = "https://api-v2.soundcloud.com/search/tracks?q=test&limit=1";

/// Проверить маршрут: измерить, за сколько он отвечает.
pub fn test_route(route: Route, proxy_url: Option<&str>) -> Result<RouteCheck, String> {
    let proxy = match proxy_url.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Some(parse_proxy(value)?),
        None => None,
    };
    if route == Route::Proxy && proxy.is_none() {
        return Err("Прокси не задан: укажи адрес в настройках".into());
    }

    let started = Instant::now();
    let response = dispatch(&HttpRequest::get(ROUTE_CHECK_URL), route, proxy.as_ref())
        .map_err(|error| format!("{}: {error}", route.as_str()))?;
    let ms = started.elapsed().as_millis() as u64;

    // Любой ответ сервера (даже 401) значит, что маршрут работает.
    if response.code >= 500 {
        return Err(format!("SoundCloud ответил {}", response.code));
    }
    Ok(RouteCheck { ok: true, ms })
}

/// Прогреть соединение с сервером потока: DNS, TCP и TLS будут готовы, когда
/// следующий трек действительно попросят играть.
pub fn warm(url: &str) {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return;
    }
    let config = configured();
    let Ok(agent) = agent_for(config.proxy.as_ref()) else {
        return;
    };
    let request = HttpRequest::get(url).header("Range", "bytes=0-1");
    if let Ok(response) = agent
        .get(&request.url)
        .set("User-Agent", request.agent_name())
        .set("Range", "bytes=0-1")
        .timeout(CONNECT_TIMEOUT)
        .call()
    {
        // Читаем чуть-чуть и бросаем: цель — не файл, а готовое соединение.
        let mut sink = Vec::new();
        let _ = response.into_reader().take(2048).read_to_end(&mut sink);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(value: &str) -> ProxySpec {
        parse_proxy(value).unwrap()
    }

    // ---------- Адрес прокси ----------

    #[test]
    fn supported_schemes_are_parsed() {
        for (value, scheme) in [
            ("socks5h://127.0.0.1:7890", ProxyScheme::Socks5h),
            ("socks5://127.0.0.1:1080", ProxyScheme::Socks5),
            ("http://127.0.0.1:2080", ProxyScheme::Http),
            ("https://127.0.0.1:8443", ProxyScheme::Https),
            ("  SOCKS5H://127.0.0.1:7890  ", ProxyScheme::Socks5h),
        ] {
            let parsed = spec(value);
            assert_eq!(parsed.scheme, scheme, "схема {value}");
            assert_eq!(parsed.host, "127.0.0.1");
            assert!(parsed.port > 0);
            // Адрес для curl собирается обратно без потерь
            assert!(parsed.url().contains("://127.0.0.1:"));
        }
        assert_eq!(spec("socks5h://proxy.local:1080").host, "proxy.local");
    }

    #[test]
    fn garbage_proxy_urls_are_rejected() {
        let bad = [
            "",
            "   ",
            "127.0.0.1:7890",
            "socks4://127.0.0.1:1080",
            "ftp://127.0.0.1:21",
            "socks5h://127.0.0.1",
            "socks5h://127.0.0.1:0",
            "socks5h://127.0.0.1:99999",
            "socks5h://127.0.0.1:abc",
            "socks5h://:7890",
            "http://user:pass@127.0.0.1:7890",
            "http://127.0.0.1:7890/path",
            "http://127.0.0.1:7890?x=1",
            "http://127.0.0.1:7890 # comment",
        ];
        for value in bad {
            assert!(parse_proxy(value).is_err(), "приняли мусор: {value:?}");
        }
        // Ошибка объясняет, что именно не так
        assert!(parse_proxy("ftp://x:1").unwrap_err().contains("схема"));
        assert!(parse_proxy("socks5h://127.0.0.1").unwrap_err().contains("порт"));
    }

    #[test]
    fn ureq_supports_only_http_proxies() {
        // SOCKS и HTTPS постоянный клиент не умеет — там работает curl.
        assert!(spec("http://127.0.0.1:2080").for_ureq().is_ok());
        assert!(spec("socks5h://127.0.0.1:7890").for_ureq().is_err());
        assert!(spec("socks5://127.0.0.1:1080").for_ureq().is_err());
        assert!(spec("https://127.0.0.1:8443").for_ureq().is_err());
    }

    // ---------- Аргументы curl ----------

    fn request() -> HttpRequest {
        HttpRequest::get("https://api-v2.soundcloud.com/search/tracks?q=test")
    }

    #[test]
    fn direct_route_adds_no_proxy_arguments() {
        assert!(curl_route_args_for(Route::Direct, Some(&spec("http://127.0.0.1:2080"))).is_empty());
        let args = curl_args(&request(), None, None);
        assert!(!args.iter().any(|arg| arg == "--proxy"), "{args:?}");
        assert!(!args.iter().any(|arg| arg.contains("127.0.0.1:2080")), "{args:?}");
    }

    #[test]
    fn proxy_route_passes_the_address_to_curl() {
        let proxy = spec("socks5h://127.0.0.1:7890");
        let args = curl_route_args_for(Route::Proxy, Some(&proxy));
        assert_eq!(args, vec!["--proxy".to_string(), "socks5h://127.0.0.1:7890".to_string()]);

        let full = curl_args(&request(), Some(&proxy), None);
        let position = full.iter().position(|arg| arg == "--proxy").expect("--proxy");
        assert_eq!(full[position + 1], "socks5h://127.0.0.1:7890");
        // DoH остаётся: именно он обходит подмену DNS
        assert!(full.iter().any(|arg| arg == "--doh-url"));
        assert!(full.iter().any(|arg| arg == DOH_URL));
        assert!(full.iter().any(|arg| arg == "--connect-timeout"));
        assert_eq!(full.last().unwrap(), &request().url);
    }

    #[test]
    fn cached_address_goes_to_resolve() {
        let args = curl_args(&request(), None, Some(("api-v2.soundcloud.com", "203.0.113.7")));
        let position = args.iter().position(|arg| arg == "--resolve").expect("--resolve");
        assert_eq!(args[position + 1], "api-v2.soundcloud.com:443:203.0.113.7");
        // Без кэша никакого --resolve нет
        assert!(!curl_args(&request(), None, None).iter().any(|arg| arg == "--resolve"));
    }

    #[test]
    fn secret_bodies_never_reach_the_command_line() {
        let body = br#"{"email":"u@example.com","password":"SuperSecret!123"}"#.to_vec();
        let secret = HttpRequest::post("https://x.supabase.co/auth/v1/token", body.clone()).secret();
        let args = curl_args(&secret, None, None);
        let position = args
            .iter()
            .position(|arg| arg == "--data-binary")
            .expect("тело");
        assert_eq!(args[position + 1], SECRET_BODY);
        assert!(!args.iter().any(|arg| arg.contains("SuperSecret!123")), "{args:?}");
        assert!(!args.iter().any(|arg| arg.contains("@example.com")), "{args:?}");

        // Обычное тело по-прежнему уходит аргументом
        let plain = HttpRequest::post("https://x.supabase.co/rest/v1/user_data", body);
        let args = curl_args(&plain, None, None);
        let position = args
            .iter()
            .position(|arg| arg == "--data-binary")
            .expect("тело");
        assert_eq!(args[position + 1], r#"{"email":"u@example.com","password":"SuperSecret!123"}"#);
    }

    #[test]
    fn curl_reply_is_split_into_body_code_and_address() {
        let (response, ip) = split_curl_reply("{\"ok\":true}\n200\n203.0.113.7");
        assert_eq!(response.code, 200);
        assert_eq!(response.text, "{\"ok\":true}");
        assert_eq!(ip.as_deref(), Some("203.0.113.7"));

        // Без адреса (например, запрос через прокси) — не паникуем
        let (response, ip) = split_curl_reply("тело\n404\n");
        assert_eq!(response.code, 404);
        assert_eq!(response.text, "тело");
        assert_eq!(ip, None);

        // Совсем без хвоста: код неизвестен, тело не потеряно
        let (response, ip) = split_curl_reply("тело без кода");
        assert_eq!(response.code, 0);
        assert_eq!(ip, None);
    }

    // ---------- Кэш DNS ----------

    #[test]
    fn dns_cache_returns_the_same_address_until_it_expires() {
        let cache = DnsCache::new();
        let now = Instant::now();
        cache.put("i1.sndcdn.com", "203.0.113.7", now, DNS_TTL);

        // До истечения TTL — тот же адрес, что и в начале
        assert_eq!(cache.get("i1.sndcdn.com", now + Duration::from_secs(1)).as_deref(), Some("203.0.113.7"));
        assert_eq!(
            cache.get("i1.sndcdn.com", now + DNS_TTL - Duration::from_secs(1)).as_deref(),
            Some("203.0.113.7")
        );
        // Ровно по TTL запись протухает
        assert_eq!(cache.get("i1.sndcdn.com", now + DNS_TTL), None);
        // Другой хост в кэш не попал
        assert_eq!(cache.get("api-v2.soundcloud.com", now), None);
    }

    #[test]
    fn dns_cache_is_cleared_manually_and_does_not_grow_forever() {
        let cache = DnsCache::new();
        let now = Instant::now();
        cache.put("a", "1.1.1.1", now, DNS_TTL);
        assert_eq!(cache.len(), 1);
        cache.clear();
        assert!(cache.is_empty());
        assert_eq!(cache.get("a", now), None);

        // Переполнение не копит бесконечную карту
        for index in 0..(DNS_CAPACITY + 10) {
            cache.put(&format!("host{index}"), "1.1.1.1", now, DNS_TTL);
        }
        assert!(cache.len() <= DNS_CAPACITY);
    }

    #[test]
    fn host_is_extracted_from_urls() {
        assert_eq!(host_of("https://api-v2.soundcloud.com/search?q=a"), Some("api-v2.soundcloud.com"));
        assert_eq!(host_of("https://i1.sndcdn.com/artworks/a.jpg"), Some("i1.sndcdn.com"));
        assert_eq!(host_of("http://127.0.0.1:1420/x"), Some("127.0.0.1"));
        assert_eq!(host_of("https://x.supabase.co"), Some("x.supabase.co"));
        assert_eq!(host_of("не url"), None);
        assert_eq!(host_of("https:///nohost"), None);
    }

    // ---------- Поиск локального прокси ----------

    #[test]
    fn found_proxies_are_reported_in_a_stable_order() {
        let found = local_proxy_candidates(&[2080, 7890]);
        assert_eq!(
            found,
            vec![
                "socks5h://127.0.0.1:7890".to_string(),
                "http://127.0.0.1:7890".to_string(),
                "socks5h://127.0.0.1:2080".to_string(),
                "http://127.0.0.1:2080".to_string(),
            ]
        );
        assert!(local_proxy_candidates(&[]).is_empty());
        // Каждый вариант — валидный адрес прокси
        for value in found {
            assert!(parse_proxy(&value).is_ok(), "плохой адрес: {value}");
        }
    }

    #[test]
    fn detection_uses_the_probe_and_never_goes_outside() {
        // Пробу «подключаем» только на 1080: наружу при этом никто не ходит.
        let found = detect_with(|host, port| host == "127.0.0.1" && port == 1080);
        assert_eq!(
            found,
            vec![
                "socks5h://127.0.0.1:1080".to_string(),
                "http://127.0.0.1:1080".to_string(),
            ]
        );
        assert!(detect_with(|_, _| false).is_empty());
    }

    // ---------- Гонка ----------

    #[test]
    fn race_returns_the_first_successful_path() {
        let winner = race(
            Duration::from_secs(5),
            |_| -> Result<String, String> {
                std::thread::sleep(Duration::from_millis(20));
                Ok("прямой".into())
            },
            |_| -> Result<String, String> {
                std::thread::sleep(Duration::from_secs(3));
                Ok("прокси".into())
            },
        )
        .unwrap();
        assert_eq!(winner, "прямой");
    }

    #[test]
    fn race_survives_both_paths_failing() {
        let error = race(
            Duration::from_secs(5),
            |_| -> Result<String, String> { Err("прямой не ответил".into()) },
            |_| -> Result<String, String> { Err("прокси не ответил".into()) },
        )
        .unwrap_err();
        assert!(error.contains("Нет сети"), "получили: {error}");
        // Одна ошибка, а не цикл: причина обоих путей внутри
        assert!(error.contains("прямой"), "{error}");
        assert!(error.contains("прокси"), "{error}");
    }

    #[test]
    fn race_gives_up_on_the_deadline() {
        let started = Instant::now();
        let result = race(
            Duration::from_millis(120),
            |_| -> Result<String, String> {
                std::thread::sleep(Duration::from_millis(600));
                Ok("прямой".into())
            },
            |_| -> Result<String, String> {
                std::thread::sleep(Duration::from_millis(600));
                Ok("прокси".into())
            },
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn race_skips_the_loser_after_the_first_success() {
        // Проигравший не должен задерживать ответ: гонка возвращается сразу,
        // как только один путь ответил, — медленный второй не ждём.
        let started = Instant::now();
        let winner = race(
            Duration::from_secs(5),
            |_| -> Result<String, String> { Ok("прямой".into()) },
            |_| -> Result<String, String> {
                std::thread::sleep(Duration::from_secs(3));
                Ok("прокси".into())
            },
        )
        .unwrap();
        assert_eq!(winner, "прямой");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "ждали проигравшего: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn cancel_flag_is_shared_between_threads() {
        let cancel = Cancel::new();
        let clone = cancel.clone();
        assert!(!clone.is_cancelled());
        cancel.cancel();
        // Флаг общий: отмена видна во всех клонах
        assert!(clone.is_cancelled());
        assert!(cancel.is_cancelled());
    }

    #[test]
    fn post_request_keeps_its_method() {
        let request = HttpRequest::post("https://x.supabase.co/rest/v1/user_data", b"[]".to_vec());
        assert_eq!(request.method, Method::Post);
        assert_eq!(curl_args(&request, None, None).iter().filter(|arg| *arg == "POST").count(), 1);
        // GET-запрос остаётся GET: тело у него появляется только у POST
        assert_eq!(HttpRequest::get("https://x/").method, Method::Get);
    }

    // ---------- Настройки маршрута ----------

    /// Настройки сети — общее состояние процесса, поэтому тесты, которые их
    /// меняют, идут по очереди: иначе один тест видел бы настройки другого.
    fn settings_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn route_is_parsed_from_settings() {
        assert_eq!(Route::parse("direct"), Route::Direct);
        assert_eq!(Route::parse("PROXY"), Route::Proxy);
        assert_eq!(Route::parse("auto"), Route::Auto);
        // Мусор — «авто»: так безопаснее, чем гадать
        assert_eq!(Route::parse(""), Route::Auto);
        assert_eq!(Route::parse("через-соседа"), Route::Auto);
        assert_eq!(Route::Direct.as_str(), "direct");
        assert_eq!(Route::Proxy.as_str(), "proxy");
        assert_eq!(Route::Auto.as_str(), "auto");
    }

    #[test]
    fn bad_proxy_url_is_reported_without_touching_the_settings() {
        let _guard = settings_lock().lock().unwrap();
        let before = configured();
        let error = configure(Route::Proxy, Some("socks4://127.0.0.1:1080")).unwrap_err();
        assert!(error.contains("схема"), "получили: {error}");
        // Прежние настройки не изменились
        let after = configured();
        assert_eq!(before.route, after.route);
        assert_eq!(before.proxy, after.proxy);
    }

    #[test]
    fn empty_proxy_url_means_no_proxy() {
        let _guard = settings_lock().lock().unwrap();
        assert!(configure(Route::Direct, Some("   ")).is_ok());
        let config = configured();
        assert_eq!(config.route, Route::Direct);
        assert!(config.proxy.is_none());
        assert!(curl_route_args().is_empty());
        // Вернём «авто» по умолчанию, чтобы не влиять на соседние тесты
        assert!(configure(Route::Auto, None).is_ok());
    }

    #[test]
    fn test_route_explains_a_missing_proxy() {
        let error = test_route(Route::Proxy, None).unwrap_err();
        assert!(error.contains("Прокси не задан"), "получили: {error}");
        // Мусорный адрес тоже отсекается до сети
        assert!(test_route(Route::Auto, Some("socks4://x:1")).is_err());
    }

    #[test]
    fn route_check_is_serialized_in_camel_case() {
        let text = serde_json::to_string(&RouteCheck { ok: true, ms: 240 }).unwrap();
        assert!(text.contains("\"ok\":true"), "{text}");
        assert!(text.contains("\"ms\":240"), "{text}");
    }
}



