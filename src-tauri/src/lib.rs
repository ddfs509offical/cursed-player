//! Основа приложения Cursed Player.
//!
//! Здесь живы все команды, модули и точка входа `run()`. Бинарник (main.rs)
//! её только вызывает, а Android стартует её через JNI: Tauri на телефоне
//! поднимает приложение из библиотеки, поэтому код обязан быть здесь.
//!
//! Сборка под Android исключает настольные части: трей, оверлей поверх игр,
//! прозрачность окна и автообновление. Всё остальное (плеер, очередь, тексты,
//! синхронизация) общее.
// Атрибут windows_subsystem остаётся в main.rs: он относится к бинарнику.

mod db;
#[cfg(desktop)]
mod discord;
mod downloads;
mod external_download;
mod hwid;
mod lyrics;
mod media;
// Проверка обновлений для телефона: у APK свой порядок установки.
#[cfg(target_os = "android")]
mod mobile_update;
mod net;
#[cfg(desktop)]
mod overlay;
mod player;
mod remux;
mod services;
mod silent;
#[cfg(desktop)]
mod single_instance;
mod soundcloud;
mod spotify;
mod supabase;
mod system;
#[cfg(desktop)]
mod update;
mod yandex;
#[cfg(desktop)]
mod zapret;

/// Единственный экземпляр приложения: его передаёт Tauri при старте.
///
/// Нужен модулям, которые работают вне команд — например, файлу сессии
/// синхронизации, которому требуется папка данных приложения.
static APP: std::sync::OnceLock<tauri::AppHandle<tauri::Wry>> = std::sync::OnceLock::new();

/// Доступ к приложению из любого места. `None` — до старта окна.
pub fn app_handle() -> Option<&'static tauri::AppHandle<tauri::Wry>> {
    APP.get()
}

use db::Profile;
use std::path::PathBuf;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::window::Window;
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri_runtime::ResizeDirection;

/// Путь к базе профилей в папке данных приложения (создаём при необходимости).
fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку данных: {e}"))?;
    Ok(dir.join("profiles.db"))
}

/// Текущее время в Unix-миллисекундах: им размечены сессия синхронизации и
/// момент последней синхронизации.
fn db_now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
fn profiles_list(app: tauri::AppHandle) -> Result<Vec<Profile>, String> {
    let conn = db::open(&db_path(&app)?)?;
    db::list(&conn)
}

#[tauri::command]
fn profile_save(app: tauri::AppHandle, profile: Profile) -> Result<Profile, String> {
    let conn = db::open(&db_path(&app)?)?;
    let mut profile = profile;
    if profile.created_at.is_empty() {
        profile.created_at = db::now_rfc3339();
    }
    db::save(&conn, &profile)?;
    Ok(profile)
}

#[tauri::command]
fn profile_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let conn = db::open(&db_path(&app)?)?;
    db::delete(&conn, &id)?;
    let next = db::list(&conn)?.first().map(|p| p.id.clone());
    if db::active_get(&conn)?.as_deref() == Some(id.as_str()) || next.is_none() {
        db::active_set(&conn, next.as_deref())?;
    }
    Ok(())
}

#[tauri::command]
fn profile_active_get(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let conn = db::open(&db_path(&app)?)?;
    let profiles = db::list(&conn)?;
    let stored = db::active_get(&conn)?;
    // Сохранённый активный профиль мог быть удалён — тогда берём первый.
    // Если же ничего не сохранено, но профили есть, тоже фиксируем первый:
    // иначе после перезагрузки пользователь увидит экран создания аккаунта
    // при живых данных в базе.
    if let Some(id) = stored.as_ref().filter(|id| profiles.iter().any(|p| &p.id == *id)) {
        return Ok(Some(id.clone()));
    }
    let fallback = profiles.first().map(|p| p.id.clone());
    db::active_set(&conn, fallback.as_deref())?;
    Ok(fallback)
}

#[tauri::command]
fn profile_active_set(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let conn = db::open(&db_path(&app)?)?;
    db::active_set(&conn, id.as_deref())
}

/// Перенос профилей из старого localStorage-хранилища (однократный).
#[tauri::command]
fn profiles_import(app: tauri::AppHandle, profiles: Vec<Profile>) -> Result<usize, String> {
    let conn = db::open(&db_path(&app)?)?;
    db::import(&conn, &profiles)
}

#[tauri::command]
fn profiles_count(app: tauri::AppHandle) -> Result<i64, String> {
    let conn = db::open(&db_path(&app)?)?;
    db::count(&conn)
}

/// Системный диалог выбора картинки + подготовка к сохранению.
#[tauri::command]
async fn media_pick_image(kind: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || media::pick(&kind))
        .await
        .map_err(|e| e.to_string())?
}

/// Скачивание картинки по ссылке (в обход CORS WebView).
#[tauri::command]
async fn media_fetch_image(url: String, kind: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || media::fetch(&url, &kind))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn ping() -> String {
    "ok".into()
}

// ---------- Интеграции: Spotify и Discord ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpotifyStatus {
    connected: bool,
    expires_at: i64,
    scope: Option<String>,
    has_refresh: bool,
}

fn spotify_status_of(app: &tauri::AppHandle) -> Result<SpotifyStatus, String> {
    let conn = db::open(&db_path(app)?)?;
    Ok(match db::integration_get(&conn, "spotify")? {
        Some(item) => SpotifyStatus {
            connected: item.refresh_token.is_some() || item.access_token.is_some(),
            expires_at: item.expires_at,
            scope: item.extra,
            has_refresh: item.refresh_token.is_some(),
        },
        None => SpotifyStatus { connected: false, expires_at: 0, scope: None, has_refresh: false },
    })
}

/// Адрес возврата, который нужно один раз добавить в кабинете Spotify.
#[tauri::command]
fn spotify_redirect_uri() -> String {
    spotify::redirect_uri()
}

#[tauri::command]
fn spotify_status(app: tauri::AppHandle) -> Result<SpotifyStatus, String> {
    spotify_status_of(&app)
}

/// Полный вход: браузер → локальный порт → обмен кода на токены.
#[tauri::command]
async fn spotify_connect(app: tauri::AppHandle, client_id: String) -> Result<SpotifyStatus, String> {
    let client = client_id.trim().to_string();
    let tokens = tauri::async_runtime::spawn_blocking(move || spotify::authorize(&client))
        .await
        .map_err(|e| e.to_string())??;

    let conn = db::open(&db_path(&app)?)?;
    db::integration_save(
        &conn,
        &db::Integration {
            service: "spotify".into(),
            refresh_token: tokens.refresh_token.clone(),
            access_token: Some(tokens.access_token),
            expires_at: tokens.expires_at,
            extra: tokens.scope,
            updated_at: db::now_rfc3339(),
        },
    )?;
    spotify_status_of(&app)
}

/// Действующий access-токен: если срок вышел — молча продлеваем по refresh-токену.
#[tauri::command]
async fn spotify_access_token(app: tauri::AppHandle, client_id: String) -> Result<String, String> {
    let client = client_id.trim().to_string();
    let conn = db::open(&db_path(&app)?)?;
    let stored = db::integration_get(&conn, "spotify")?
        .ok_or_else(|| "Spotify не подключён".to_string())?;

    if !stored.access_token.as_deref().unwrap_or("").is_empty() && stored.expires_at > db::now_unix() {
        return Ok(stored.access_token.unwrap_or_default());
    }

    let refresh_token = stored
        .refresh_token
        .clone()
        .ok_or_else(|| "Нет refresh-токена — подключи Spotify заново".to_string())?;
    let refreshed = tauri::async_runtime::spawn_blocking(move || spotify::refresh(&client, &refresh_token))
        .await
        .map_err(|e| e.to_string())??;

    db::integration_save(
        &conn,
        &db::Integration {
            service: "spotify".into(),
            refresh_token: refreshed.refresh_token.or(stored.refresh_token),
            access_token: Some(refreshed.access_token.clone()),
            expires_at: refreshed.expires_at,
            extra: refreshed.scope.or(stored.extra),
            updated_at: db::now_rfc3339(),
        },
    )?;
    Ok(refreshed.access_token)
}

#[tauri::command]
fn spotify_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let conn = db::open(&db_path(&app)?)?;
    db::integration_delete(&conn, "spotify")
}

/// Кладёт иконку приложения на рабочий стол файлом: её нужно один раз
/// загрузить в Discord (Rich Presence → Art Assets, ключ `logo`), чтобы
/// активность показывалась с аватаркой приложения.
#[tauri::command]
#[cfg(desktop)]
fn export_app_icon(app: tauri::AppHandle) -> Result<String, String> {
    let bytes = include_bytes!("../icons/icon@2x.png");
    let dir = app
        .path()
        .desktop_dir()
        .map_err(|e| format!("Не нашёл рабочий стол: {e}"))?;
    let path = dir.join("cursed-icon.png");
    std::fs::write(&path, bytes).map_err(|e| format!("Не удалось сохранить иконку: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Активность Discord: вызывается при смене трека и повторно «дожимается»,
/// если Discord перезапустили.
#[tauri::command]
#[cfg(desktop)]
fn discord_set_activity(
    state: tauri::State<'_, discord::DiscordState>,
    client_id: String,
    details: String,
    state_line: String,
    started_at_ms: Option<i64>,
    large_image: Option<String>,
    large_text: Option<String>,
) -> Result<(), String> {
    discord::set_activity(
        &state,
        &client_id,
        &details,
        &state_line,
        started_at_ms,
        large_image.as_deref(),
        large_text.as_deref(),
    )
}

/// Активность «ничего не играет» — с иконкой приложения.
#[tauri::command]
#[cfg(desktop)]
fn discord_idle(
    state: tauri::State<'_, discord::DiscordState>,
    client_id: String,
    large_image: Option<String>,
) -> Result<(), String> {
    discord::set_idle_activity(&state, &client_id, large_image.as_deref())
}

#[tauri::command]
#[cfg(desktop)]
fn discord_test(
    state: tauri::State<'_, discord::DiscordState>,
    client_id: String,
    large_image: Option<String>,
) -> Result<(), String> {
    discord::set_test_activity(&state, &client_id, large_image.as_deref())
}

#[cfg(desktop)]
#[tauri::command]
fn discord_clear(state: tauri::State<'_, discord::DiscordState>) -> Result<(), String> {
    discord::clear(&state)
}

// ---------- Поиск и плейлисты подключённых сервисов ----------

#[tauri::command]
async fn service_search(
    service: String,
    token: String,
    query: String,
) -> Result<Vec<services::SearchTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || services::search(&service, &token, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn service_playlists(service: String, token: String) -> Result<Vec<services::ServicePlaylist>, String> {
    tauri::async_runtime::spawn_blocking(move || services::playlists(&service, &token))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn yandex_track_url(token: String, track_id: String) -> Result<services::StreamInfo, String> {
    tauri::async_runtime::spawn_blocking(move || services::yandex_track_url(&token, &track_id))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Вход в Яндекс по OAuth ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct YandexStatus {
    connected: bool,
    expires_at: i64,
    has_refresh: bool,
}

fn yandex_status_of(app: &tauri::AppHandle) -> Result<YandexStatus, String> {
    let conn = db::open(&db_path(app)?)?;
    Ok(match db::integration_get(&conn, "yandex")? {
        Some(item) => YandexStatus {
            connected: item.refresh_token.is_some() || item.access_token.is_some(),
            expires_at: item.expires_at,
            has_refresh: item.refresh_token.is_some(),
        },
        None => YandexStatus { connected: false, expires_at: 0, has_refresh: false },
    })
}

#[tauri::command]
fn yandex_redirect_uri(host: Option<String>) -> String {
    yandex::redirect_uri(host.as_deref().unwrap_or("127.0.0.1"))
}

#[tauri::command]
fn yandex_status(app: tauri::AppHandle) -> Result<YandexStatus, String> {
    yandex_status_of(&app)
}

/// Полный вход: браузер → локальный порт → обмен кода на токены.
#[tauri::command]
async fn yandex_connect(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: String,
    host: Option<String>,
) -> Result<YandexStatus, String> {
    let id = client_id.trim().to_string();
    let secret = client_secret.trim().to_string();
    let host = host.unwrap_or_else(|| "127.0.0.1".into());
    let tokens = tauri::async_runtime::spawn_blocking(move || yandex::authorize(&id, &secret, &host))
        .await
        .map_err(|e| e.to_string())??;

    let conn = db::open(&db_path(&app)?)?;
    db::integration_save(
        &conn,
        &db::Integration {
            service: "yandex".into(),
            refresh_token: tokens.refresh_token.clone(),
            access_token: Some(tokens.access_token),
            expires_at: tokens.expires_at,
            extra: None,
            updated_at: db::now_rfc3339(),
        },
    )?;
    yandex_status_of(&app)
}

/// Действующий токен: при истечении молча продлеваем по refresh-токену.
#[tauri::command]
async fn yandex_access_token(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<String, String> {
    let conn = db::open(&db_path(&app)?)?;
    let stored = db::integration_get(&conn, "yandex")?
        .ok_or_else(|| "Яндекс не подключён".to_string())?;

    if !stored.access_token.as_deref().unwrap_or("").is_empty() && stored.expires_at > db::now_unix() {
        return Ok(stored.access_token.unwrap_or_default());
    }

    let refresh_token = stored
        .refresh_token
        .clone()
        .ok_or_else(|| "Нет refresh-токена — подключи Яндекс заново".to_string())?;
    let id = client_id.trim().to_string();
    let secret = client_secret.trim().to_string();
    let refreshed = tauri::async_runtime::spawn_blocking(move || yandex::refresh(&id, &secret, &refresh_token))
        .await
        .map_err(|e| e.to_string())??;

    db::integration_save(
        &conn,
        &db::Integration {
            service: "yandex".into(),
            refresh_token: refreshed.refresh_token.or(stored.refresh_token),
            access_token: Some(refreshed.access_token.clone()),
            expires_at: refreshed.expires_at,
            extra: None,
            updated_at: db::now_rfc3339(),
        },
    )?;
    Ok(refreshed.access_token)
}

#[tauri::command]
fn yandex_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let conn = db::open(&db_path(&app)?)?;
    db::integration_delete(&conn, "yandex")
}

/// Проверка аккаунта: Плюс, подписка и uid — сразу видно, чей это токен.
#[tauri::command]
async fn yandex_account_info(token: String) -> Result<yandex::YandexAccount, String> {
    tauri::async_runtime::spawn_blocking(move || yandex::account_info(&token))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- SoundCloud ----------

/// Публичный client_id веб-клиента: обычно пользователю ничего вводить не нужно.
#[tauri::command]
async fn soundcloud_discover_client_id() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(soundcloud::discover_client_id)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn soundcloud_search(client_id: String, query: String) -> Result<Vec<soundcloud::SoundCloudTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::search(&client_id, &query))
        .await
        .map_err(|e| e.to_string())?
}

/// «Волна»: похожие на трек — до `limit` штук.
#[tauri::command]
async fn soundcloud_related(
    client_id: String,
    track_id: String,
    limit: u32,
) -> Result<Vec<soundcloud::SoundCloudTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::related(&client_id, &track_id, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// «Волна», запасной путь: верхние треки артиста, когда похожих не нашлось.
#[tauri::command]
async fn soundcloud_artist_top(
    client_id: String,
    user_id: String,
    limit: u32,
) -> Result<Vec<soundcloud::SoundCloudTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::artist_top(&client_id, &user_id, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// «Волна»: треки жанра текущего трека — третий источник порции.
#[tauri::command]
async fn soundcloud_genre_tracks(
    client_id: String,
    genre: String,
    limit: u32,
) -> Result<Vec<soundcloud::SoundCloudTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::genre_tracks(&client_id, &genre, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// «Волна»: похожие артисты (related, запасной путь — followings).
#[tauri::command]
async fn soundcloud_related_artists(
    client_id: String,
    user_id: String,
    limit: u32,
) -> Result<Vec<soundcloud::SoundCloudUser>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        soundcloud::related_artists(&client_id, &user_id, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Обход блокировок (zapret) ----------

#[cfg(desktop)]
/// Состояние zapret: папка, пресеты, служба и разбор их же отчёта тестов.
/// Асинхронно: внутри запускаются reg/tasklist/sc, и нельзя блокировать интерфейс.
#[tauri::command]
async fn zapret_status() -> Result<zapret::ZapretStatus, String> {
    tauri::async_runtime::spawn_blocking(zapret::status)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(desktop)]
/// Живая проверка целей: что отвечает сейчас, а что ломается.
/// Применить выбранный пресет zapret (будет запрос администратора Windows).
#[tauri::command]
async fn zapret_apply(preset: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || zapret::apply_preset(&preset))
        .await
        .map_err(|e| e.to_string())?
}

/// Подбор рабочей стратегии: приложение копирует zapret к себе, перебирает
/// пресеты и оставляет первый, при котором отвечает SoundCloud API.
#[cfg(desktop)]
#[tauri::command]
async fn zapret_autotest(limit: usize) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || zapret::start_autotest(limit))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(desktop)]
/// Результаты подбора: имя пресета, работает ли, подробности.
#[tauri::command]
async fn zapret_autotest_results() -> Result<Vec<(String, bool, String)>, String> {
    tauri::async_runtime::spawn_blocking(zapret::autotest_results)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(desktop)]
/// Запустить конкретный пресет из своей копии (с запросом администратора).
#[tauri::command]
async fn zapret_start_own(preset: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || zapret::start_own(&preset))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(desktop)]
/// Остановить обход, запущенный приложением.
#[tauri::command]
async fn zapret_stop_own() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(zapret::stop_own)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(desktop)]
#[tauri::command]
async fn zapret_probe(hosts: Vec<String>) -> Result<Vec<zapret::ProbeResult>, String> {
    tauri::async_runtime::spawn_blocking(move || zapret::probe(hosts))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn soundcloud_charts(
    client_id: String,
    genre: String,
    region: String,
) -> Result<Vec<soundcloud::SoundCloudTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::charts(&client_id, &genre, &region))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn soundcloud_stream(client_id: String, track_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::stream_url(&client_id, &track_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Предзагрузка следующего трека: ссылка на поток добывается заранее, а
/// соединение с сервером потока прогревается. Ошибки не критичны — плеер
/// всё равно спросит ссылку сам, когда трек начнёт играть.
#[tauri::command]
async fn soundcloud_prefetch(client_id: String, track_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::prefetch(&client_id, &track_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Адрес страницы трека в SoundCloud (`https://soundcloud.com/автор/трек`).
/// Нужен запасному пути сохранения: внешний сервис принимает именно адрес, а
/// голый числовой id он понимает как поисковую строку.
#[tauri::command]
async fn soundcloud_permalink(client_id: String, track_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::permalink(&client_id, &track_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Треки SoundCloud по списку id — для догрузки метаданных старых лайков.
#[tauri::command]
async fn soundcloud_tracks(
    client_id: String,
    ids: Vec<String>,
) -> Result<Vec<soundcloud::SoundCloudTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || soundcloud::tracks_by_ids(&client_id, &ids))
        .await
        .map_err(|e| e.to_string())?
}

/// Профиль артиста SoundCloud: ник, аватар, баннер, био и счётчики.
/// Артиста можно назвать числовым id, ником или адресом страницы.
#[tauri::command]
async fn soundcloud_user(client_id: String, user: String) -> Result<soundcloud::SoundCloudUser, String> {
    let value = tauri::async_runtime::spawn_blocking(move || soundcloud::user(&client_id, &user))
        .await
        .map_err(|e| e.to_string())??;
    Ok(soundcloud::parse_user(&value))
}

/// Треки артиста порциями: `limit` — размер порции, `offset` — сколько уже
/// загружено. Интерфейс наращивает offset и держит загруженное у себя.
#[tauri::command]
async fn soundcloud_user_tracks(
    client_id: String,
    user: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<soundcloud::SoundCloudTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        soundcloud::user_tracks_page(&client_id, &user, limit, offset)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Следующая порция поиска: по курсору `next` (next_href от SoundCloud), а если
/// курсора нет — по смещению `offset`.
#[tauri::command]
async fn soundcloud_search_page(
    client_id: String,
    query: String,
    limit: usize,
    offset: usize,
    next: Option<String>,
) -> Result<soundcloud::SoundCloudPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        soundcloud::search_page(&client_id, &query, limit, offset, next.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Сеть: маршрут, прокси, проверка ----------

/// Запомнить выбранный маршрут: им пользуется весь сетевой слой приложения.
/// Мусорный адрес прокси — понятная ошибка, прежние настройки не меняются.
#[tauri::command]
fn network_configure(route: String, proxy_url: Option<String>) -> Result<(), String> {
    net::configure(net::Route::parse(&route), proxy_url.as_deref())
}

/// Найти локальный прокси: только TCP к 127.0.0.1, наружу — ни одного запроса.
#[tauri::command]
async fn detect_local_proxy() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(net::detect_local_proxy)
        .await
        .map_err(|e| e.to_string())
}

/// Проверить выбранный маршрут живым запросом к SoundCloud и замерить время.
#[tauri::command]
async fn test_route(route: String, proxy_url: Option<String>) -> Result<net::RouteCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        net::test_route(net::Route::parse(&route), proxy_url.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Сбросить кэш DNS: нужен после смены маршрута или настроек обхода.
#[tauri::command]
fn clear_dns_cache() {
    net::clear_dns_cache();
}

// ---------- Офлайн-треки ----------

/// Разрешил ли автор скачивание и есть ли прямая ссылка на файл.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SoundcloudDownloadInfo {
    downloadable: bool,
    /// Прямая ссылка на файл — только когда автор разрешил скачивание.
    url: Option<String>,
}

#[tauri::command]
async fn soundcloud_download_info(
    client_id: String,
    track_id: String,
) -> Result<SoundcloudDownloadInfo, String> {
    let (downloadable, url) =
        tauri::async_runtime::spawn_blocking(move || soundcloud::download_info(&client_id, &track_id))
            .await
            .map_err(|e| e.to_string())??;
    Ok(SoundcloudDownloadInfo { downloadable, url })
}

/// Сохранить трек офлайн: `kind` — «download» (автор разрешил) или «cache».
/// `title`, `artist` и `cover` приходят из сервиса и попадают в реестр
/// офлайн-файлов: у скачанного потока тегов обычно нет.
#[tauri::command]
async fn save_track_offline(
    url: String,
    id: String,
    kind: String,
    title: Option<String>,
    artist: Option<String>,
    cover: Option<String>,
) -> Result<downloads::SavedFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        downloads::save(
            &url,
            &id,
            &kind,
            title.as_deref().unwrap_or(""),
            artist.as_deref(),
            cover.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Сохранить трек офлайн запасным путём — через внешний сервис
/// soundloadmate. Основной способ (`save_track_offline`) надёжнее, поэтому
/// эта команда вызывается только по явному согласию пользователя, когда
/// нативное сохранение не справилось.
///
/// Режим всегда `cache`: сервис не говорит, разрешил ли автор скачивание.
/// Пометка «держу офлайн» потом ставится штатным `offline_set_kept`.
#[tauri::command]
async fn external_save_track(
    track_url: String,
    id: String,
    title: Option<String>,
    artist: Option<String>,
    cover: Option<String>,
) -> Result<downloads::SavedFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        external_download::save(
            &track_url,
            &id,
            title.as_deref().unwrap_or(""),
            artist.as_deref(),
            cover.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Список сохранённых офлайн-треков: только реестр, без чтения тегов файлов
/// (иначе старт приложения читал бы диск по каждому треку).
#[tauri::command]
async fn offline_files() -> Result<Vec<downloads::SavedFile>, String> {
    tauri::async_runtime::spawn_blocking(downloads::list)
        .await
        .map_err(|e| e.to_string())
}

/// Догрузить метаданные одной офлайн-копии: теги файла читаются один раз и
/// запоминаются в реестре. Вызывается лениво, когда списку не хватило данных.
#[tauri::command]
async fn offline_meta(track_id: String) -> Result<downloads::SavedFile, String> {
    tauri::async_runtime::spawn_blocking(move || downloads::meta(&track_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Удалить сохранённый файл (только из папки офлайн-треков).
#[tauri::command]
async fn remove_offline_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || downloads::remove(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Пометить офлайн-копию как «держу офлайн» (или снять пометку).
#[tauri::command]
async fn offline_set_kept(track_id: String, kept: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || downloads::set_kept(&track_id, kept))
        .await
        .map_err(|e| e.to_string())?
}

/// Убрать временные офлайн-копии старше указанного числа дней. Настоящие
/// скачивания и копии, которые просили держать офлайн, не удаляются.
#[tauri::command]
async fn offline_cleanup(max_age_days: u64) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || downloads::cleanup(max_age_days))
        .await
        .map_err(|e| e.to_string())
}

/// Сколько занимают офлайн-файлы и сколько свободно на диске.
#[tauri::command]
async fn offline_stats() -> Result<(u64, u64), String> {
    tauri::async_runtime::spawn_blocking(downloads::stats)
        .await
        .map_err(|e| e.to_string())
}

// ---------- Текст песни ----------

/// Текст песни из открытой базы LRCLIB: обычный и синхронный (LRC).
/// `duration_sec` помогает выбрать правильную версию (студийную, а не ремикс).
/// Не найденный текст — это `found: false`, а не ошибка интерфейса.
#[tauri::command]
async fn lyrics_fetch(
    artist: String,
    title: String,
    duration_sec: u32,
) -> Result<lyrics::LyricsAnswer, String> {
    tauri::async_runtime::spawn_blocking(move || lyrics::fetch(&artist, &title, duration_sec))
        .await
        .map_err(|e| e.to_string())?
}

/// Сохранить найденный текст файлом рядом с офлайн-копией трека:
/// `%APPDATA%\com.example.musichub\lyrics\<безопасный id>.lrc`. Текст пишется
/// как есть — тайминги сохраняются, если они были у источника.
#[tauri::command]
async fn lyrics_save_local(
    track_id: String,
    text: String,
    source: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        lyrics::save_local(&track_id, &text, source.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Прочитать сохранённый текст трека. `None` — файла нет или он пуст.
#[tauri::command]
async fn lyrics_load_local(track_id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || lyrics::load_local(&track_id))
        .await
        .map_err(|e| e.to_string())
}

/// Удалить сохранённый текст трека.
#[tauri::command]
async fn lyrics_remove_local(track_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || lyrics::remove_local(&track_id))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Синхронизация через Supabase ----------
//
// Адрес проекта и anon-ключ пользователь вводит в настройках: в сборке их нет.
// Пароль не сохраняется никогда — только токены в файле сессии рядом с базой
// профилей. Сеть и разбор ответов живут в `supabase.rs`, здесь — только
// команды, каждая в отдельном потоке, как и соседние сетевые вызовы.

#[tauri::command]
async fn sync_configure(url: String, anon_key: String) -> Result<supabase::SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::configure(&url, &anon_key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sync_sign_up(
    email: String,
    password: String,
    invite_code: Option<String>,
) -> Result<supabase::SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        supabase::sign_up(&email, &password, invite_code.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Приглашения (владелец выдаёт коды вместо правки SQL) ----------

#[tauri::command]
async fn invite_check(code: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::invite_check(&code))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn invite_create(
    note: Option<String>,
    days: i64,
    max_uses: i64,
) -> Result<supabase::Invite, String> {
    tauri::async_runtime::spawn_blocking(move || {
        supabase::invite_create(note.as_deref(), days, max_uses)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn invite_list() -> Result<Vec<supabase::Invite>, String> {
    tauri::async_runtime::spawn_blocking(supabase::invite_list)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn invite_revoke(code: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::invite_revoke(&code))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Устройство (HWID) и админ-панель ----------

/// Отпечаток этого компьютера: SHA-256 от MachineGuid + соль приложения.
#[tauri::command]
fn machine_guid() -> Result<String, String> {
    hwid::fingerprint()
}

#[tauri::command]
async fn is_owner() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(supabase::is_owner)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn device_bind(fingerprint: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || supabase::device_bind(&fingerprint))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn device_lookup(fingerprint: String) -> Result<Option<supabase::DeviceAccount>, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::device_lookup(&fingerprint))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn auth_recover(email: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || supabase::recover_password(&email))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn admin_users() -> Result<Vec<supabase::AdminUser>, String> {
    tauri::async_runtime::spawn_blocking(supabase::admin_users)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn admin_devices() -> Result<Vec<supabase::AdminDevice>, String> {
    tauri::async_runtime::spawn_blocking(supabase::admin_devices)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn admin_invite_uses() -> Result<Vec<supabase::InviteUse>, String> {
    tauri::async_runtime::spawn_blocking(supabase::admin_invite_uses)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn admin_stats() -> Result<supabase::AdminStats, String> {
    tauri::async_runtime::spawn_blocking(supabase::admin_stats)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn admin_set_open(open: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::admin_set_open(open))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Регистрация и автообновление ----------

/// Открыта ли регистрация для всех (флаг владельца на сервере).
#[tauri::command]
async fn app_registration_state() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(supabase::registration_is_open)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(desktop)]
/// Есть ли новая сборка: читает `latest.json` из бакета `updates`.
#[tauri::command]
async fn update_check() -> Result<Option<update::UpdateInfo>, String> {
    tauri::async_runtime::spawn_blocking(update::check)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(desktop)]
/// Скачать установщик во временную папку.
#[tauri::command]
async fn update_download(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || update::download(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(desktop)]
/// Запустить скачанный установщик.
#[tauri::command]
async fn update_launch(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update::launch(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sync_sign_in(email: String, password: String) -> Result<supabase::SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::sign_in(&email, &password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sync_sign_out() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(supabase::sign_out)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sync_status() -> Result<supabase::SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(supabase::status)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sync_push(rows: Vec<serde_json::Value>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || supabase::push(&rows))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sync_pull(since_ms: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::pull(since_ms))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Профили людей (публичная таблица `profiles`) ----------
//
// Юзернейм, аватар, баннер и описание: по ним работают поиск людей и открытие
// чужого профиля. Свою строку пишем только себе — идентификатор берётся из
// сессии внутри `supabase.rs`, а не из аргументов команды.

/// Записать свой профиль в облако (создать или обновить).
#[tauri::command]
async fn profile_upsert(
    username: String,
    display_name: String,
    avatar: Option<String>,
    banner: Option<String>,
    bio: String,
    privacy: Option<serde_json::Value>,
) -> Result<supabase::Profile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        supabase::profile_upsert(
            &username,
            &display_name,
            avatar.as_deref(),
            banner.as_deref(),
            &bio,
            privacy.as_ref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Профиль по идентификатору пользователя: `null`, если строки ещё нет.
#[tauri::command]
async fn profile_get(user_id: String) -> Result<Option<supabase::Profile>, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::profile_get(&user_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Поиск людей по юзернейму и отображаемому имени, до 20 человек.
#[tauri::command]
async fn profile_search(query: String) -> Result<Vec<supabase::Profile>, String> {
    tauri::async_runtime::spawn_blocking(move || supabase::profile_search(&query))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Окно, трей ----------

#[cfg(desktop)]
#[tauri::command]
fn window_hide_to_tray(window: Window) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn window_show_from_tray(window: Window) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

// ---------- Системные настройки ----------

#[tauri::command]
fn autostart_set(enabled: bool) -> Result<(), String> {
    system::set_autostart(enabled)
}

#[tauri::command]
async fn autostart_get() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(system::autostart_enabled)
        .await
        .map_err(|e| e.to_string())
}

// ---------- Своя иконка приложения ----------

/// Выбор своей иконки приложения (PNG, JPEG, WebP или анимированный GIF).
#[tauri::command]
async fn app_icon_pick() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| media::pick("app-icon"))
        .await
        .map_err(|e| e.to_string())?
}

/// Сохраняет иконку файлом на рабочий стол: её загружают в Discord как ассет.
#[cfg(desktop)]
#[tauri::command]
fn app_icon_export(app: tauri::AppHandle, data_url: Option<String>) -> Result<String, String> {
    let dir = app
        .path()
        .desktop_dir()
        .map_err(|e| format!("Не нашёл рабочий стол: {e}"))?;

    match data_url.filter(|value| value.contains("base64,")) {
        Some(url) => {
            use base64::Engine as _;
            let payload = url.split_once("base64,").map(|(_, data)| data).unwrap_or("");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(payload.trim())
                .map_err(|e| format!("Не удалось прочитать иконку: {e}"))?;
            let extension = if url.starts_with("data:image/gif") { "gif" } else { "png" };
            let path = dir.join(format!("cursed-icon.{extension}"));
            std::fs::write(&path, bytes).map_err(|e| format!("Не удалось сохранить: {e}"))?;
            Ok(path.to_string_lossy().to_string())
        }
        None => {
            let path = dir.join("cursed-icon.png");
            std::fs::write(&path, include_bytes!("../icons/icon@2x.png"))
                .map_err(|e| format!("Не удалось сохранить: {e}"))?;
            Ok(path.to_string_lossy().to_string())
        }
    }
}

#[cfg(desktop)]
/// Ставит свою иконку в панель задач и в заголовок окна.
#[tauri::command]
fn window_set_icon(window: Window, data_url: Option<String>) -> Result<(), String> {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let Some(url) = data_url.filter(|value| value.contains("base64,")) else {
        return Ok(());
    };
    let payload = url.split_once("base64,").map(|(_, data)| data).unwrap_or("");
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("Не удалось прочитать иконку: {e}"))?;
    let image = image::load_from_memory(&bytes).map_err(|e| format!("Не картинка: {e}"))?;
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let icon = tauri::image::Image::new_owned(rgba.into_raw(), width, height);
    window.set_icon(icon).map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[cfg(desktop)]
/// Иконка в трее: окно можно свернуть и вернуть, музыка продолжает играть.
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Открыть Cursed player", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Играть / пауза", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Следующий трек", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &next, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Cursed player")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "toggle" => {
                let _ = app.emit("tray://toggle", ());
            }
            "next" => {
                let _ = app.emit("tray://next", ());
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Выбор файлов: диалог и чтение тегов.
#[tauri::command]
async fn player_pick_files() -> Result<Vec<player::TrackFile>, String> {
    tauri::async_runtime::spawn_blocking(player::pick_files)
        .await
        .map_err(|e| e.to_string())
}

/// Выбор папки для библиотеки.
#[tauri::command]
async fn player_pick_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(player::pick_folder)
        .await
        .map_err(|e| e.to_string())
}

/// Обход папки: все аудиофайлы с тегами.
#[tauri::command]
async fn player_scan_folder(path: String) -> Result<Vec<player::TrackFile>, String> {
    tauri::async_runtime::spawn_blocking(move || player::scan_folder(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// Метаданные по списку путей — например, для перетащенных файлов.
#[tauri::command]
async fn player_read_files(paths: Vec<String>) -> Result<Vec<player::TrackFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| player::read_track(std::path::Path::new(path)))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

// Управление окном сделано своими командами, а не плагином window: у плагина
// права выдаются через ACL, и в dev-режиме (страница http://localhost:1420)
// вызовы отклоняются — из-за этого кнопки окна и перетаскивание не работали.
// Свои команды не зависят от ACL и ведут себя одинаково в dev и в release.

#[cfg(desktop)]
#[tauri::command]
fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn window_close(window: Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn window_is_maximized(window: Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn window_toggle_maximize(window: Window) -> Result<bool, String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    window.is_maximized().map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn window_start_drag(window: Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn window_start_resize(window: Window, direction: String) -> Result<(), String> {
    let dir = match direction.as_str() {
        "North" => ResizeDirection::North,
        "South" => ResizeDirection::South,
        "East" => ResizeDirection::East,
        "West" => ResizeDirection::West,
        "NorthEast" => ResizeDirection::NorthEast,
        "NorthWest" => ResizeDirection::NorthWest,
        "SouthEast" => ResizeDirection::SouthEast,
        "SouthWest" => ResizeDirection::SouthWest,
        other => return Err(format!("неизвестное направление: {other}")),
    };
    window.start_resize_dragging(dir).map_err(|e| e.to_string())
}

/// Проверка обновлений для телефона: своего сервера у APK нет, читаем тот же
/// `android.json`, что и настольный `latest.json`.
#[cfg(target_os = "android")]
#[tauri::command]
async fn mobile_update_check() -> Result<Option<mobile_update::MobileUpdate>, String> {
    tauri::async_runtime::spawn_blocking(mobile_update::check)
        .await
        .map_err(|e| e.to_string())?
}

/// Номер текущей сборки: интерфейс покажет «у тебя 51, есть 52».
#[cfg(target_os = "android")]
#[tauri::command]
fn mobile_build_number() -> u64 {
    mobile_update::current_build()
}
/// Настольная точка входа: трей, оверлей поверх игр, автообновление.
///
/// Здесь же замок одиночного запуска: на телефоне он не нужен, там
/// приложение всегда одно.
#[cfg(desktop)]
pub fn run() {
    // Замок живёт до конца запуска: на выходе (в том числе через «Выход»
    // в трее) он снимается сам.
    let _instance_lock = match single_instance::acquire() {
        single_instance::Instance::Primary(lock) => {
            // Запрос от прошлого раза не должен поднимать окно сам по себе
            single_instance::clear_show_request();
            Some(lock)
        }
        single_instance::Instance::AlreadyRunning(pid) => {
            single_instance::log(&format!("Второй запуск отклонён: плеер уже работает (PID {pid})"));
            // Первый экземпляр поднимет окно, увидев этот запрос
            single_instance::request_show();
            return;
        }
        single_instance::Instance::Unavailable(reason) => {
            // Замок не сработал: пускаем приложение, но оставляем след
            single_instance::log(&format!("Замок одиночного запуска не сработал: {reason}"));
            None
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(discord::DiscordState::default())
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            setup_tray(app.handle())?;
            // Поиск локального прокси идёт фоном: интерфейс не должен ждать
            // TCP-попыток, а режим «авто» к первому запросу уже будет знать,
            // есть ли рядом локальный прокси.
            net::refresh_local_proxies();
            // Повторный запуск просит показать это окно (см. single_instance)
            single_instance::watch_show_requests(app.handle().clone());
            // Островок поверх игры: своё окно, которое появляется, когда
            // запущена Dota 2, и не забирает у неё фокус.
            overlay::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            profiles_list,
            profile_save,
            profile_delete,
            profile_active_get,
            profile_active_set,
            profiles_import,
            profiles_count,
            media_pick_image,
            media_fetch_image,
            spotify_redirect_uri,
            spotify_status,
            spotify_connect,
            spotify_access_token,
            spotify_disconnect,
            service_search,
            service_playlists,
            yandex_track_url,
            yandex_redirect_uri,
            yandex_status,
            yandex_connect,
            yandex_access_token,
            yandex_disconnect,
            yandex_account_info,
            soundcloud_discover_client_id,
            soundcloud_search,
            soundcloud_related,
            soundcloud_artist_top,
            soundcloud_genre_tracks,
            soundcloud_related_artists,
            soundcloud_charts,
            soundcloud_stream,
            soundcloud_prefetch,
            network_configure,
            detect_local_proxy,
            test_route,
            clear_dns_cache,
            soundcloud_permalink,
            soundcloud_tracks,
            soundcloud_user,
            soundcloud_user_tracks,
            soundcloud_search_page,
            soundcloud_download_info,
            save_track_offline,
            external_save_track,
            offline_files,
            offline_meta,
            remove_offline_file,
            offline_set_kept,
            offline_cleanup,
            offline_stats,
            autostart_set,
            autostart_get,
            app_icon_pick,
            lyrics_fetch,
            lyrics_save_local,
            lyrics_load_local,
            lyrics_remove_local,
            sync_configure,
            sync_sign_up,
            invite_check,
            invite_create,
            invite_list,
            invite_revoke,
            machine_guid,
            is_owner,
            device_bind,
            device_lookup,
            auth_recover,
            admin_users,
            admin_devices,
            admin_invite_uses,
            admin_stats,
            admin_set_open,
            app_registration_state,
            sync_sign_in,
            sync_sign_out,
            sync_status,
            sync_push,
            sync_pull,
            profile_upsert,
            profile_get,
            profile_search,
            player_pick_files,
            player_pick_folder,
            player_scan_folder,
            player_read_files,
            zapret_status,
            zapret_apply,
            zapret_autotest,
            zapret_autotest_results,
            zapret_start_own,
            zapret_stop_own,
            zapret_probe,
            window_hide_to_tray,
            window_show_from_tray,
            window_set_icon,
            update_check,
            update_download,
            update_launch,
            window_minimize,
            window_close,
            window_is_maximized,
            window_toggle_maximize,
            window_start_drag,
            window_start_resize,
            overlay::island_test,
            overlay::island_update,
            overlay::island_state,
            overlay::island_action,
            overlay::island_config,
            overlay::island_take_action,
            discord_set_activity,
            discord_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
/// Мобильная точка входа: только то, что есть на телефоне.
///
/// Трей, оверлей поверх игр, автообновление и запрет остаются настольными:
/// на Android их либо нет, либо они делаются иначе (системное уведомление,
/// VPN-служба). Плеер, очередь, тексты и синхронизация работают как есть.
#[cfg(mobile)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            net::refresh_local_proxies();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_update_check,
            mobile_build_number,
            ping,
            profiles_list,
            profile_save,
            profile_delete,
            profile_active_get,
            profile_active_set,
            profiles_import,
            profiles_count,
            media_pick_image,
            media_fetch_image,
            spotify_redirect_uri,
            spotify_status,
            spotify_connect,
            spotify_access_token,
            spotify_disconnect,
            service_search,
            service_playlists,
            yandex_track_url,
            yandex_redirect_uri,
            yandex_status,
            yandex_connect,
            yandex_access_token,
            yandex_disconnect,
            yandex_account_info,
            soundcloud_discover_client_id,
            soundcloud_search,
            soundcloud_related,
            soundcloud_artist_top,
            soundcloud_genre_tracks,
            soundcloud_related_artists,
            soundcloud_charts,
            soundcloud_stream,
            soundcloud_prefetch,
            network_configure,
            detect_local_proxy,
            test_route,
            clear_dns_cache,
            soundcloud_permalink,
            soundcloud_tracks,
            soundcloud_user,
            soundcloud_user_tracks,
            soundcloud_search_page,
            soundcloud_download_info,
            save_track_offline,
            external_save_track,
            offline_files,
            offline_meta,
            remove_offline_file,
            offline_set_kept,
            offline_cleanup,
            offline_stats,
            autostart_set,
            autostart_get,
            app_icon_pick,
            lyrics_fetch,
            lyrics_save_local,
            lyrics_load_local,
            lyrics_remove_local,
            sync_configure,
            sync_sign_up,
            invite_check,
            invite_create,
            invite_list,
            invite_revoke,
            machine_guid,
            is_owner,
            device_bind,
            device_lookup,
            auth_recover,
            admin_users,
            admin_devices,
            admin_invite_uses,
            admin_stats,
            admin_set_open,
            app_registration_state,
            sync_sign_in,
            sync_sign_out,
            sync_status,
            sync_push,
            sync_pull,
            profile_upsert,
            profile_get,
            profile_search,
            player_pick_files,
            player_pick_folder,
            player_scan_folder,
            player_read_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

