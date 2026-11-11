// Не показывать консольное окно на Windows в release-сборке
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Вся логика живёт в библиотеке: так же приложение собирается под Android,
// где Tauri стартует его из библиотеки, а не из бинарника.
fn main() {
    music_hub_lib::run();
}
