#![cfg(desktop)]
// Островок поверх игр — настольная функция: на Android его роль играет
// системное уведомление и плавающее окно, это отдельная работа.
//! Островок поверх игры: маленькое окно с текущим треком, как на iPhone.
//!
//! Почему отдельное окно, а не часть приложения: игра занимает весь экран, и
//! всё, что нарисовано внутри окна плеера, под ней не видно. Здесь создаётся
//! второе окно — верхний слой, без рамки и фона, с прозрачностью.
//!
//! Что важно и что честно ограничено:
//!   * В процесс игры мы не лезем: ни инъекций, ни чтения памяти. Только своё
//!     окно Windows поверх остальных — так же работают Discord и Overwolf.
//!   * Видно его только в режиме «окно без рамки» (Borderless window). В
//!     настоящем полноэкранном режиме Windows не показывает чужие окна поверх.
//!   * Окно не забирает фокус и пропускает клики мимо себя, поэтому игра
//!     продолжает получать мышь.
//!   * Наличие игры проверяем штатным `tasklist`: это чтение списка процессов,
//!     на игру не влияет.

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Что показывать в островке. Пишет главное окно, читает окно островка:
/// события между окнами в WebView2 доставляются не всегда, а команда — всегда.
///
/// Поля в camelCase: интерфейс присылает `durationMs`, и без этого правила
/// serde ждал `duration_ms`, разбор падал, и островок оставался пустым.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandTrack {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    /// Обложка: уже готовый для отрисовки адрес (asset:// или http).
    pub cover: String,
    /// Длительность трека в миллисекундах, 0 — неизвестна.
    pub duration_ms: u64,
}

impl Default for IslandTrack {
    fn default() -> Self {
        Self {
            title: String::new(),
            artist: String::new(),
            playing: false,
            cover: String::new(),
            duration_ms: 0,
        }
    }
}

/// Настройки островка: включён ли, показывать всегда или только в игре,
/// держать ли поверх всех окон. Пишет интерфейс из настроек.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandConfig {
    /// Включён ли островок вообще.
    pub enabled: bool,
    /// Показывать всегда, а не только когда запущена Dota.
    pub always: bool,
    /// Держать поверх всех окон.
    pub always_on_top: bool,
}

impl Default for IslandConfig {
    fn default() -> Self {
        Self { enabled: true, always: false, always_on_top: true }
    }
}

static CONFIG: Mutex<Option<IslandConfig>> = Mutex::new(None);

/// Интерфейс присылает настройки — наблюдатель сразу их применяет.
#[tauri::command]
pub fn island_config(app: AppHandle, config: IslandConfig) {
    let enabled = config.enabled;
    let always = config.always;
    let on_top = config.always_on_top;
    if let Ok(mut guard) = CONFIG.lock() {
        *guard = Some(config);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_always_on_top(on_top);
    }
    // Выключили — прячем сразу, не дожидаясь следующего опроса.
    if !enabled {
        set_visible(&app, false);
    } else if always {
        set_visible(&app, true);
    }
}

fn current_config() -> IslandConfig {
    CONFIG.lock().ok().and_then(|guard| guard.clone()).unwrap_or_default()
}
/// Последнее, что играет. Одно поле на приложение — этого достаточно.
static TRACK: Mutex<Option<IslandTrack>> = Mutex::new(None);

/// Главное окно сообщает текущий трек.
#[tauri::command]
pub fn island_update(track: IslandTrack) {
    if let Ok(mut guard) = TRACK.lock() {
        *guard = Some(track);
    }
}

/// Островок спрашивает, что показать. Возвращает пустой трек, пока ничего нет.
#[tauri::command]
pub fn island_state() -> IslandTrack {
    TRACK
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

/// Очередь действий из островка: next / prev / toggle.
static ACTION: Mutex<Option<String>> = Mutex::new(None);

/// Островок просит переключить трек или поставить паузу.
#[tauri::command]
pub fn island_action(action: String) {
    if let Ok(mut guard) = ACTION.lock() {
        *guard = Some(action);
    }
}

/// Главное окно забирает действие (и очищает ячейку).
#[tauri::command]
pub fn island_take_action() -> Option<String> {
    ACTION.lock().ok().and_then(|mut guard| guard.take())
}

/// Имя окна: по нему находим островок из потока наблюдения.
pub const LABEL: &str = "island";

/// Сколько ждать между проверками: игра запускается не мгновенно, но и чаще
/// раза в пару секунд опрашивать список процессов незачем.
const POLL: Duration = Duration::from_secs(4);

/// Ширина и высота островка. Высота с запасом: тень и скругления не должны
/// обрезаться краем окна.
const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 64.0;
/// Отступ сверху: островок висит под кромкой экрана, не мешая прицелу.
const TOP_MARGIN: f64 = 18.0;

/// Запущена ли Dota 2. Список процессов читаем через tasklist — без
/// дополнительных крейтов и без обращения к самой игре.
fn dota_running() -> bool {
    let Ok(output) = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq dota2.exe", "/NH"])
        // Без этого Windows на секунду показывает консольное окно поверх игры.
        .creation_flags(0x0800_0000)
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    text.contains("dota2.exe")
}

/// Создаёт окно островка: без рамки, прозрачное, поверх всех, без фокуса.
fn build(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Cursed player · островок")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        // Фон прозрачный: видна только сама плашка, остальное — игра.
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Фокус не забираем: иначе игра свернулась бы в момент показа.
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("Не удалось создать островок: {e}"))?;

    // Клики проходят сквозь окно в игру.
    let _ = window.set_ignore_cursor_events(true);

    // Верх по центру главного монитора.
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let screen = monitor.size();
        let scale = monitor.scale_factor();
        let x = (screen.width as i32 - (WIDTH * scale) as i32) / 2;
        let y = (TOP_MARGIN * scale) as i32;
        let _ = window.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)));
    }

    Ok(())
}

/// Показывает или прячет островок. Показ не активирует окно, поэтому игра
/// не теряет фокус.
fn set_visible(app: &AppHandle, visible: bool) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    if visible {
        let _ = window.show();
        let _ = window.set_always_on_top(true);
    } else {
        let _ = window.hide();
    }
}

/// Готовит островок: окно создаём сразу при старте (скрытым), а показываем и
/// прячем по появлению игры. Создавать WebView из команды нельзя: окно
/// открывалось пустым, а вызов команды не возвращался.
pub fn watch(app: AppHandle) {
    thread::spawn(move || {
        let mut shown = false;
        loop {
            let config = current_config();
            // Включён и (всегда или запущена игра) — показываем.
            let running = config.enabled && (config.always || dota_running());
            if running != shown {
                shown = running;
                set_visible(&app, running);
            }
            if config.always_on_top {
                if let Some(window) = app.get_webview_window(LABEL) {
                    let _ = window.set_always_on_top(true);
                }
            }
            thread::sleep(POLL);
        }
    });
}

/// Создаёт окно островка (скрытым) и запускает наблюдение за игрой.
pub fn init(app: &AppHandle) {
    if let Err(error) = build(app) {
        eprintln!("островок: {error}");
        return;
    }
    watch(app.clone());
}

/// Ручное включение островка: нужно, чтобы проверить его без запущенной игры.
#[tauri::command]
pub fn island_test(app: AppHandle, visible: bool) -> Result<(), String> {
    set_visible(&app, visible);
    Ok(())
}
