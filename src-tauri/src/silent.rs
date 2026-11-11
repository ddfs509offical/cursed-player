//! Запуск консольных программ без мигающих чёрных окон.
//!
//! Приложение графическое: когда оно запускает `curl`, `reg`, `tasklist`, `sc`
//! или `schtasks`, Windows по умолчанию открывает для них консольное окно.
//! Пользователь видит, как при поиске трека мигает окно, а при выборе трека —
//! сразу два. Флаг CREATE_NO_WINDOW это убирает.

use std::process::Command;

/// Скрытый запуск: процесс работает, но окна у него нет.
pub fn hidden(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// CREATE_NO_WINDOW — не создавать консольное окно.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}
