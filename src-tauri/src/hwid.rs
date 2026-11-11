//! Отпечаток компьютера (HWID) для привязки аккаунта к устройству.
//!
//! Зачем: человек может забыть и пароль, и ник. Тогда приложение спрашивает у
//! сервера, к какому аккаунту привязан этот компьютер, и подсказывает почту —
//! а дальше обычный сброс пароля письмом.
//!
//! Что берём: `MachineGuid` из реестра Windows (он уникален для установки и не
//! меняется при переименовании машины), имя компьютера и соль приложения.
//! Наружу уходит только SHA-256 от этой строки — сам GUID в базу не попадает.

use sha2::{Digest, Sha256};

/// Соль: без неё одинаковый HWID у разных приложений, а с ней — только у нас.
const SALT: &str = "cursed-player-hwid-v1";

/// `MachineGuid` из реестра. Читаем через `reg query`: это одна команда без
/// зависимостей и без прав администратора (ветка доступна на чтение всем).
fn machine_guid() -> Option<String> {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // Строка выглядит так: "    MachineGuid    REG_SZ    1f2e3d4c-...-..."
    for line in text.lines() {
        if let Some(index) = line.find("REG_SZ") {
            let value = line[index + "REG_SZ".len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Имя компьютера — добавляем к отпечатку: GUID переживает переустановку
/// Windows, а имя помогает различить две машины с одинаковым образом системы.
fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
}

/// HWID: 64 символа hex (SHA-256). Стабилен между запусками одного устройства.
pub fn fingerprint() -> Result<String, String> {
    let guid = machine_guid().ok_or_else(|| "Не удалось прочитать идентификатор устройства".to_string())?;
    let raw = format!("{SALT}|{guid}|{}", computer_name());
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_hex() {
        // Реестр может быть недоступен (не Windows, урезанный образ) — тогда
        // проверять нечего: функция честно вернула ошибку.
        let Ok(first) = fingerprint() else {
            return;
        };
        let second = fingerprint().expect("hwid");
        assert_eq!(first, second, "отпечаток должен быть одинаковым между вызовами");
        assert_eq!(first.len(), 64, "SHA-256 в hex — 64 символа");
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn salt_changes_the_digest() {
        let mut plain = Sha256::new();
        plain.update(b"same");
        let mut salted = Sha256::new();
        salted.update(format!("{SALT}|same").as_bytes());
        assert_ne!(format!("{:x}", plain.finalize()), format!("{:x}", salted.finalize()));
    }
}
