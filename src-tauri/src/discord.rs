#![cfg(not(target_os = "android"))]
// Discord IPC есть только в настольных системах: на Android этот файл
// не компилируется, а вызовы в main.rs защищены отдельно.
//! Discord Rich Presence: показываем в Discord, что сейчас играет.
//!
//! Важное ограничение самой платформы: Discord требует Application ID —
//! без него активность отобразить нельзя. Поэтому ID хранится в настройках:
//! приложение подставляет его автоматически при каждом изменении трека
//! (повторно ничего вводить не нужно) и переподключается, если Discord
//! был перезапущен.

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub struct DiscordState {
    client: Mutex<Option<DiscordIpcClient>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Ставит активность. Если соединения нет — подключается.
/// `large_image` — либо ключ ассета, загруженного в приложении Discord
/// (например «logo»), либо ссылка на картинку.
pub fn set_activity(
    state: &DiscordState,
    client_id: &str,
    details: &str,
    state_line: &str,
    started_at_ms: Option<i64>,
    large_image: Option<&str>,
    large_text: Option<&str>,
) -> Result<(), String> {
    if client_id.trim().is_empty() {
        return Err("Не указан Discord Application ID".into());
    }

    let mut guard = state.client.lock().map_err(|_| "Состояние Discord занято".to_string())?;

    if guard.is_none() {
        let mut client =
            DiscordIpcClient::new(client_id).map_err(|e| format!("Неверный Application ID: {e}"))?;
        client
            .connect()
            .map_err(|e| format!("Discord не запущен или не принимает подключение: {e}"))?;
        *guard = Some(client);
    }

    let mut assets = Assets::new();
    if let Some(image) = large_image {
        assets = assets.large_image(image);
    }
    if let Some(text) = large_text {
        assets = assets.large_text(text);
    }

    // Именно «слушает музыку», а не «играет»: так и должно выглядеть у плеера
    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .details(details)
        .state(state_line)
        .assets(assets);
    if let Some(start) = started_at_ms {
        activity = activity.timestamps(Timestamps::new().start(start / 1000));
    }

    let client = guard.as_mut().expect("клиент только что установлен");
    match client.set_activity(activity) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Соединение могло отвалиться (Discord закрыли) — сбрасываем,
            // следующий вызов подключится заново.
            *guard = None;
            Err(format!("Не удалось обновить активность: {error}"))
        }
    }
}

pub fn clear(state: &DiscordState) -> Result<(), String> {
    let mut guard = state.client.lock().map_err(|_| "Состояние Discord занято".to_string())?;
    if let Some(client) = guard.as_mut() {
        let _ = client.clear_activity();
    }
    *guard = None;
    Ok(())
}

/// Активность, когда ничего не играет: показываем иконку приложения.
pub fn set_idle_activity(
    state: &DiscordState,
    client_id: &str,
    large_image: Option<&str>,
) -> Result<(), String> {
    set_activity(
        state,
        client_id,
        "Cursed player",
        "Ничего не играет",
        None,
        large_image,
        Some("beta test v1"),
    )
}

/// Активность для проверки в настройках.
pub fn set_test_activity(state: &DiscordState, client_id: &str, large_image: Option<&str>) -> Result<(), String> {
    set_activity(
        state,
        client_id,
        "Cursed player",
        "Проверка подключения",
        Some(now_ms()),
        large_image,
        Some("beta test v1"),
    )
}
