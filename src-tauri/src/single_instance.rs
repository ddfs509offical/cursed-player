#![cfg(desktop)]
//! Один экземпляр приложения.
//!
//! Второй запуск плеера не должен открывать второе окно и второй процесс: при
//! старте мы занимаем файл-замок в папке данных приложения
//! (`%APPDATA%\com.example.musichub\instance.lock`) эксклюзивно созданием файла
//! (`create_new`). Кто первый создал — тот и работает; остальные читают из замка
//! PID владельца и спрашивают у Windows, жив ли ещё такой процесс. Процесс жив —
//! второй экземпляр тихо выходит и просит первый показать окно (см.
//! `watch_show_requests`). Процесса нет — замок устаревший (плеер упал или его
//! сняли через диспетчер задач), и мы перезаписываем его своим PID.
//!
//! Почему не именованный мьютекс (`CreateMutexW`), хотя он выглядит проще: для
//! него нужны объявления `extern "system"` и `unsafe` вокруг сырых хендлов, а
//! сверх «занято/свободно» он ничего не даёт — устаревший замок он не
//! распознаёт, и по нему не видно, какой именно процесс держит приложение.
//! Файл-замок решает ту же задачу средствами std, не тянет новых зависимостей и
//! целиком проверяется офлайн-тестами.
//!
//! Проверку делаем в `main` ДО сборки Tauri (см. `main.rs`): окна из
//! `tauri.conf.json` создаются внутри `Builder::run` раньше пользовательского
//! setup-хука, поэтому проверка в setup успела бы показать второе окно.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Папка данных приложения — тот же `identifier`, что в `tauri.conf.json`.
const APP_DIR: &str = "com.example.musichub";
/// Файл-замок одиночного запуска: внутри PID владельца.
const LOCK_FILE: &str = "instance.lock";
/// Файл-запрос «покажи окно»: его создаёт второй запуск для первого.
const SHOW_FILE: &str = "instance.show";
/// Журнал одиночного запуска: строки о том, что решила проверка.
const LOG_FILE: &str = "instance.log";
/// Как часто первый экземпляр проверяет запрос «покажи окно».
const SHOW_POLL_MS: u64 = 700;

/// Путь к служебному файлу в папке данных приложения.
pub fn data_file_in(appdata: &Path, name: &str) -> PathBuf {
    appdata.join(APP_DIR).join(name)
}

/// Корень данных приложения. `APPDATA` — основной путь, запасные нужны только
/// там, где переменной нет; на самый крайний случай остаётся временная папка —
/// замок важнее того, где именно он лежит.
pub fn data_root() -> PathBuf {
    for name in ["APPDATA", "LOCALAPPDATA", "USERPROFILE"] {
        if let Some(value) = std::env::var_os(name) {
            if !value.is_empty() {
                return PathBuf::from(value);
            }
        }
    }
    std::env::temp_dir()
}

/// Путь файла-замка одиночного запуска.
pub fn lock_path() -> PathBuf {
    data_file_in(&data_root(), LOCK_FILE)
}

/// Путь запроса «покажи окно».
pub fn show_path() -> PathBuf {
    data_file_in(&data_root(), SHOW_FILE)
}

/// Путь журнала одиночного запуска.
pub fn log_path() -> PathBuf {
    data_file_in(&data_root(), LOG_FILE)
}

/// Создать папку для файла, если её ещё нет.
fn ensure_parent(path: &Path) -> Result<(), String> {
    match path.parent() {
        Some(dir) => fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать папку данных: {e}")),
        None => Ok(()),
    }
}

/// Занять замок: создать файл эксклюзивно и записать в него свой PID.
/// `Ok(false)` — файл уже есть (замок чужой либо устаревший).
pub fn create_lock(path: &Path, pid: u32) -> Result<bool, String> {
    ensure_parent(path)?;
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            writeln!(file, "{pid}").map_err(|e| format!("Не удалось записать PID в замок: {e}"))?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!("Не удалось создать замок: {error}")),
    }
}

/// Перезаписать замок своим PID: так забирают устаревший замок умершего процесса.
pub fn write_pid(path: &Path, pid: u32) -> Result<(), String> {
    ensure_parent(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("Не удалось открыть замок: {e}"))?;
    writeln!(file, "{pid}").map_err(|e| format!("Не удалось записать PID в замок: {e}"))?;
    file.flush().map_err(|e| format!("Не удалось записать PID в замок: {e}"))
}

/// PID владельца из замка. Пустой файл, мусор или ноль — `None`: такой замок
/// считаем устаревшим, а не «живым».
pub fn read_pid(path: &Path) -> Option<u32> {
    let text = fs::read_to_string(path).ok()?;
    let pid: u32 = text.trim().parse().ok()?;
    (pid != 0).then_some(pid)
}

/// Есть ли в выводе `tasklist /FO CSV` строка с таким PID **и** именем образа.
///
/// Строка выглядит так: `"chrome.exe","1234","Console","1","10 000 К"` — имя и
/// PID это первые два поля в кавычках. Сообщение «нет задач» строк с задачей не
/// содержит, а совпадение с числом из другого столбца невозможно: в объёме
/// памяти всегда есть « К» и разделитель разрядов.
///
/// Имя образа проверять обязательно: Windows переиспользует номера процессов,
/// и после перезагрузки чужой процесс (например, `dllhost.exe`) может носить
/// номер, записанный в замке, — тогда плеер навсегда решал бы «уже работаю» и
/// не запускался вовсе.
pub fn csv_has_named_pid(text: &str, pid: u32, image: &str) -> bool {
    let expected = pid.to_string();
    text.lines().any(|line| {
        let mut fields = line.split("\",\"");
        let Some(name) = fields.next() else { return false };
        let Some(field) = fields.next() else { return false };
        name.trim_matches('"').eq_ignore_ascii_case(image) && field.trim_matches('"').trim() == expected
    })
}

/// Имя нашего исполняемого файла: владелец замка должен быть этим же
/// приложением, а не любым процессом, которому достался номер.
fn our_image_name() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_string()))
}

/// Жив ли процесс с таким PID — и это именно наше приложение.
///
/// Спрашиваем у Windows список процессов (`tasklist`) — это не требует ни новых
/// зависимостей, ни `unsafe` с сырыми хендлами. Ошибку запуска считаем ответом
/// «не жив»: устаревший замок лучше, чем живое второе окно.
pub fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let Some(image) = our_image_name() else {
        return false;
    };
    let filter = format!("PID eq {pid}");
    match crate::silent::hidden("tasklist")
        .args(["/FI", &filter, "/NH", "/FO", "CSV"])
        .output()
    {
        Ok(output) => csv_has_named_pid(&String::from_utf8_lossy(&output.stdout), pid, &image),
        Err(_) => false,
    }
}

/// Строка в журнал одиночного запуска.
///
/// Обычный `eprintln!` здесь не годится: в release у приложения нет консоли
/// (`windows_subsystem = "windows"`), а запись в несуществующий stderr — паника.
/// Поэтому пишем файлом рядом с замком и ошибки записи игнорируем.
pub fn log_line(path: &Path, message: &str) {
    if ensure_parent(path).is_err() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {message}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    }
}

/// Записать строку в журнал одиночного запуска.
pub fn log(message: &str) {
    log_line(&log_path(), message);
}

/// Попросить уже запущенный экземпляр показать окно: выкладываем файл-запрос,
/// который первый экземпляр замечает сторожем (см. `watch_show_requests`).
///
/// Окно чужого процесса из отдельного процесса без плагина `single-instance` не
/// поднять, поэтому связь идёт через файл в общей папке данных.
pub fn request_show() {
    let path = show_path();
    if ensure_parent(&path).is_err() {
        return;
    }
    let _ = fs::write(&path, b"show");
}

/// Забрать запрос «покажи окно», если он есть: файл удаляется, чтобы одно
/// нажатие поднимало окно ровно один раз.
pub fn take_show_request(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let _ = fs::remove_file(path);
    true
}

/// Убрать запрос «покажи окно», оставшийся от прошлого раза: устаревший запрос
/// не должен поднимать окно сам по себе.
pub fn clear_show_request() {
    let _ = fs::remove_file(show_path());
}

/// Сторож запроса «покажи окно»: раз в `SHOW_POLL_MS` проверяет файл-запрос и
/// поднимает окно. Стоимость — один `stat` в секунду; зато повторный запуск из
/// ярлыка возвращает к уже открытому плееру, а не в пустоту.
pub fn watch_show_requests(app: tauri::AppHandle) {
    use tauri::Manager as _;

    let path = show_path();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(SHOW_POLL_MS));
        if !take_show_request(&path) {
            continue;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            #[cfg(desktop)]
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    });
}

/// Итог проверки при старте.
pub enum Instance {
    /// Мы первые: замок наш, при выходе файл снимается (см. `Lock`).
    Primary(Lock),
    /// Плеер уже запущен этим процессом: второй экземпляр не открываем.
    AlreadyRunning(u32),
    /// Замок не удалось ни взять, ни проверить (нет папки, нет прав): пускаем
    /// приложение — «не запускается вовсе» хуже, чем редкое второе окно.
    Unavailable(String),
}

/// Замок одиночного запуска: файл с нашим PID. Пока структура жива, замок наш;
/// на выходе (в том числе при `Drop` во время возврата из `main`) файл снимается,
/// поэтому устаревших замков после штатного выхода не остаётся.
pub struct Lock {
    path: PathBuf,
    pid: u32,
}

impl Drop for Lock {
    fn drop(&mut self) {
        // Снимаем только свой замок: если его успел перезаписать другой запуск
        // (наш процесс посчитали умершим), чужой PID трогать нельзя.
        if read_pid(&self.path) == Some(self.pid) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Взять замок одиночного запуска по штатному пути.
pub fn acquire() -> Instance {
    acquire_at(&lock_path())
}

/// То же по явному пути: так проверяется тестами, без реального `%APPDATA%`.
pub fn acquire_at(path: &Path) -> Instance {
    acquire_with(path, process_is_alive)
}

/// Проверка запуска с подставляемой проверкой «процесс жив»: тесты подают сюда
/// свою функцию и не зависят от чужих процессов в системе.
fn acquire_with(path: &Path, alive: impl Fn(u32) -> bool) -> Instance {
    let pid = std::process::id();

    // Первая попытка: создать замок эксклюзивно. Одержали — мы первые.
    match create_lock(path, pid) {
        Ok(true) => return Instance::Primary(Lock { path: path.to_path_buf(), pid }),
        Ok(false) => {}
        Err(reason) => return Instance::Unavailable(reason),
    }

    // Замок уже есть. Свой же PID в нём (номер достался нам после чужого
    // процесса) владельцем не считаем: это устаревший замок.
    let owner = read_pid(path).filter(|owner| *owner != pid && alive(*owner));
    if let Some(owner) = owner {
        return Instance::AlreadyRunning(owner);
    }

    // Замок устаревший: процесс владельца умер, файл пуст или битый.
    // Между чтением и перезаписью мог выиграть другой запуск — тогда `create_new`
    // не сработает, и мы снова увидим живой PID.
    let _ = fs::remove_file(path);
    match create_lock(path, pid) {
        Ok(true) => Instance::Primary(Lock { path: path.to_path_buf(), pid }),
        Ok(false) => match read_pid(path).filter(|other| *other != pid && alive(*other)) {
            Some(other) => Instance::AlreadyRunning(other),
            None => Instance::Unavailable("замок одиночного запуска не занялся".into()),
        },
        Err(reason) => Instance::Unavailable(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Отдельная папка на каждый тест: тесты идут параллельно и не мешают друг другу.
    fn case_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("music_hub_single_instance_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("папка теста создаётся");
        dir
    }

    /// Путь замка собирается из корня данных приложения и не трогает реальные файлы.
    #[test]
    fn lock_path_lives_in_the_app_data_dir() {
        let root = Path::new(r"C:\Users\user\AppData\Roaming");
        let lock = data_file_in(root, LOCK_FILE);
        assert_eq!(lock, root.join("com.example.musichub").join("instance.lock"));
        assert_eq!(data_file_in(root, SHOW_FILE).file_name().unwrap(), "instance.show");
        assert_eq!(data_file_in(root, LOG_FILE).file_name().unwrap(), "instance.log");

        // И штатный путь: корень берётся из окружения, а хвост всегда один и тот
        // же — папка приложения и имя файла замка.
        let real = lock_path();
        assert!(real.ends_with(Path::new(APP_DIR).join(LOCK_FILE)));
        assert!(real.is_absolute(), "замок лежит по абсолютному пути");
    }

    /// PID записывается в замок и читается обратно.
    #[test]
    fn pid_is_written_and_read_back() {
        let path = case_dir("pid_round_trip").join(LOCK_FILE);
        write_pid(&path, 41234).expect("PID пишется");
        assert_eq!(read_pid(&path), Some(41234));
    }

    /// Мусор и пустой файл — не владелец: такой замок считается устаревшим.
    #[test]
    fn broken_lock_has_no_pid() {
        let dir = case_dir("broken_lock");
        let path = dir.join(LOCK_FILE);
        assert_eq!(read_pid(&path), None, "файла ещё нет");
        fs::write(&path, "").unwrap();
        assert_eq!(read_pid(&path), None, "пустой файл");
        fs::write(&path, "не число").unwrap();
        assert_eq!(read_pid(&path), None, "мусор");
        fs::write(&path, "0\n").unwrap();
        assert_eq!(read_pid(&path), None, "нулевой PID");
    }

    /// PID берётся именно из второго столбца, имя — из первого.
    #[test]
    fn csv_finds_the_pid_column() {
        let line = "\"chrome.exe\",\"1234\",\"Console\",\"1\",\"10 000 К\"";
        assert!(csv_has_named_pid(line, 1234, "chrome.exe"));
        assert!(!csv_has_named_pid(line, 1235, "chrome.exe"));
        assert!(!csv_has_named_pid(line, 10, "chrome.exe"), "число из памяти — не PID");
        // Чужое имя образа при том же PID владельцем не считается — так и
        // ловится переиспользованный после перезагрузки номер процесса
        assert!(
            !csv_has_named_pid(line, 1234, "music_hub.exe"),
            "PID занят чужим процессом"
        );
        // Регистр имени не важен
        assert!(csv_has_named_pid(line, 1234, "Chrome.EXE"));
        let two = format!("{line}\n\"music_hub.exe\",\"4321\",\"Console\",\"1\",\"120 000 К\"");
        assert!(csv_has_named_pid(&two, 4321, "music_hub.exe"));
    }

    /// Сообщение «задач нет» (в том числе локализованное) владельца не выдаёт.
    #[test]
    fn csv_ignores_the_no_tasks_message() {
        assert!(!csv_has_named_pid(
            "ИНФОРМАЦИЯ: отсутствуют задачи, отвечающие указанным критериям.",
            1234,
            "music_hub.exe"
        ));
        assert!(!csv_has_named_pid(
            "INFO: No tasks are running which match the specified criteria.",
            4,
            "music_hub.exe"
        ));
        assert!(!csv_has_named_pid("", 4, "music_hub.exe"));
    }

    /// Свой процесс заведомо жив: проверка спрашивает систему, а не догадывается.
    #[cfg(windows)]
    #[test]
    fn own_pid_is_alive() {
        assert!(process_is_alive(std::process::id()));
    }

    /// Заведомо несуществующий PID живым не считается.
    #[cfg(windows)]
    #[test]
    fn unknown_pid_is_not_alive() {
        assert!(!process_is_alive(u32::MAX));
        assert!(!process_is_alive(0));
    }

    /// Первый запуск занимает замок, а на выходе снимает его — устаревших файлов
    /// после штатного выхода не остаётся.
    #[test]
    fn first_run_takes_the_lock_and_removes_it_on_exit() {
        let path = case_dir("first_run").join(LOCK_FILE);
        let lock = match acquire_with(&path, |_| false) {
            Instance::Primary(lock) => lock,
            _ => panic!("первый запуск должен занять замок"),
        };
        assert_eq!(read_pid(&path), Some(std::process::id()));
        drop(lock);
        assert!(!path.exists(), "замок снимается на выходе");
    }

    /// Второй запуск при живом владельце не открывается.
    #[test]
    fn second_run_stops_while_the_owner_is_alive() {
        let path = case_dir("second_run").join(LOCK_FILE);
        write_pid(&path, 12345).unwrap();
        match acquire_with(&path, |_| true) {
            Instance::AlreadyRunning(owner) => assert_eq!(owner, 12345),
            _ => panic!("при живом владельце второй запуск должен отказаться"),
        }
        assert_eq!(read_pid(&path), Some(12345), "чужой замок не перезаписан");
    }

    /// Устаревший замок умершего процесса забирается себе: плеер запускается.
    #[test]
    fn stale_lock_is_replaced_with_our_pid() {
        let path = case_dir("stale_lock").join(LOCK_FILE);
        write_pid(&path, 12345).unwrap();
        let lock = match acquire_with(&path, |_| false) {
            Instance::Primary(lock) => lock,
            _ => panic!("устаревший замок должен достаться нам"),
        };
        assert_eq!(read_pid(&path), Some(std::process::id()));
        drop(lock);
    }

    /// Запрос «покажи окно» забирается один раз: файл удаляется.
    #[test]
    fn show_request_is_taken_once() {
        let path = case_dir("show_request").join(SHOW_FILE);
        assert!(!take_show_request(&path), "запроса ещё нет");
        fs::write(&path, b"show").unwrap();
        assert!(take_show_request(&path));
        assert!(!take_show_request(&path), "повторно окно не поднимается");
    }
}
