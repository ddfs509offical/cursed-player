//! Системные функции Windows: автозапуск и глобальные горячие клавиши.
//!
//! Автозапуск пишем прямо в реестр (HKCU\...\Run) — это ровно то, что делает
//! одноимённый плагин, но без лишней зависимости. Горячие клавиши регистрирует
//! `global-hotkey`, события уходят в интерфейс.

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Cursed player";

/// Путь к текущему exe: его и прописываем в автозапуск.
fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("Не удалось определить путь к приложению: {e}"))
}

pub fn set_autostart(enabled: bool) -> Result<(), String> {
    if enabled {
        let path = exe_path()?;
        let status = crate::silent::hidden("reg")
            .args([
                "add",
                RUN_KEY,
                "/v",
                RUN_VALUE,
                "/t",
                "REG_SZ",
                "/d",
                &format!("\"{path}\""),
                "/f",
            ])
            .status()
            .map_err(|e| format!("Не удалось вызвать reg: {e}"))?;
        if !status.success() {
            return Err("Windows не дал прописать автозапуск".into());
        }
        Ok(())
    } else {
        let status = crate::silent::hidden("reg")
            .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
            .status()
            .map_err(|e| format!("Не удалось вызвать reg: {e}"))?;
        // Отсутствие записи — не ошибка: значит автозапуск и так выключен
        let _ = status;
        Ok(())
    }
}

pub fn autostart_enabled() -> bool {
    match crate::silent::hidden("reg").args(["query", RUN_KEY, "/v", RUN_VALUE]).output() {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_can_be_toggled() {
        // Проверяем реальный цикл включения и выключения записи в реестре
        let before = autostart_enabled();
        set_autostart(true).expect("включение автозапуска");
        assert!(autostart_enabled(), "запись автозапуска должна появиться");
        set_autostart(false).expect("выключение автозапуска");
        assert!(!autostart_enabled(), "запись автозапуска должна исчезнуть");
        if before {
            let _ = set_autostart(true);
        }
    }
}
