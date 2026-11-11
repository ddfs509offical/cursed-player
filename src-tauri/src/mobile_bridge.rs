//! Android-мост: файлы с телефона и выбор музыки системным диалогом.
//!
//! На Android Rust не может открыть системный диалог сам — это делает
//! Kotlin-плагин `MobileBridgePlugin`. Здесь только команды, которые зовёт
//! интерфейс: они проксируют вызов в плагин и возвращают результат.
//!
//! На настольных системах модуль не компилируется: там та же работа идёт
//! через `player::pick_files` и `rfd`.

#![cfg(target_os = "android")]

use serde::{Deserialize, Serialize};
use tauri::plugin::PluginHandle;
use tauri::{AppHandle, Manager, Runtime};

/// Идентификатор плагина: совпадает с именем в Kotlin-объявлении.
const PLUGIN_IDENTIFIER: &str = "mobile-bridge";

/// Ответ плагина на чтение файла.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// Запрос к плагину: адрес `content://` выбранного файла.
#[derive(Debug, Clone, Serialize)]
struct ReadFileRequest {
    uri: String,
}

/// Состояние с ручкой плагина: её выдаёт Tauri при регистрации.
pub struct BridgeState<R: Runtime> {
    pub handle: PluginHandle<R>,
}

/// Копирует выбранный файл в кэш приложения и отдаёт обычный путь.
#[tauri::command]
pub fn mobile_read_file<R: Runtime>(app: AppHandle<R>, uri: String) -> Result<MobileFile, String> {
    let state = app.state::<BridgeState<R>>();
    state
        .handle
        .run_mobile_plugin::<MobileFile>("readFile", ReadFileRequest { uri })
        .map_err(|e| e.to_string())
}

/// Открывает системный выбор музыки. Результат интерфейс получает событием.
#[tauri::command]
pub fn mobile_pick_audio<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<BridgeState<R>>();
    state
        .handle
        .run_mobile_plugin::<()>("pickAudio", ())
        .map_err(|e| e.to_string())
}

/// Сколько файлов уже лежит в кэше — признак, что мост действительно работает.
#[tauri::command]
pub fn mobile_cache_count<R: Runtime>(app: AppHandle<R>) -> Result<u32, String> {
    #[derive(Debug, Deserialize)]
    struct Count {
        count: u32,
    }
    let state = app.state::<BridgeState<R>>();
    let result = state
        .handle
        .run_mobile_plugin::<Count>("cacheCount", ())
        .map_err(|e| e.to_string())?;
    Ok(result.count)
}

/// Плагин Tauri: регистрирует Kotlin-часть и команды для интерфейса.
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new(PLUGIN_IDENTIFIER)
        .invoke_handler(tauri::generate_handler![
            mobile_read_file,
            mobile_pick_audio,
            mobile_cache_count
        ])
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MobileBridgePlugin")?;
            app.manage(BridgeState { handle });
            Ok(())
        })
        .build()
}
