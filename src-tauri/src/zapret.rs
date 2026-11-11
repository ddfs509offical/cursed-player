#![cfg(desktop)]
//! Взаимодействие с zapret (обход блокировок) — без вмешательства в работу
//! пользователя: показываем состояние, разбираем их же отчёты тестов и
//! проверяем соединение с целями.
//!
//! Служба zapret может быть уже запущена — тогда мы ничего не трогаем,
//! чтобы не конфликтовать с работающим обходом.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Итог по одному пресету из отчёта тестов zapret.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetScore {
    pub preset: String,
    pub ok: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZapretStatus {
    pub folder: String,
    pub found: bool,
    pub binary_found: bool,
    pub presets: Vec<String>,
    pub service_state: String,
    pub winws_running: bool,
    pub report_path: Option<String>,
    pub report_best: Option<PresetScore>,
    pub report_scores: Vec<PresetScore>,
    /// Пресет, с которым установлена служба (из реестра).
    pub current_preset: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub host: String,
    pub ok: bool,
    pub detail: String,
}

fn folder() -> PathBuf {
    // Путь по умолчанию: Desktop\1 (как у пользователя), плюс запасные варианты
    let candidates = [
        std::env::var("USERPROFILE").map(|home| format!("{home}\\Desktop\\1")),
        std::env::var("USERPROFILE").map(|home| format!("{home}\\Desktop\\zapret")),
    ];
    for candidate in candidates.into_iter().flatten() {
        let path = PathBuf::from(candidate);
        if path.is_dir() {
            return path;
        }
    }
    PathBuf::from(
        std::env::var("USERPROFILE")
            .map(|home| format!("{home}\\Desktop\\1"))
            .unwrap_or_else(|_| "C:\\zapret".into()),
    )
}

fn presets(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension().and_then(|ext| ext.to_str()) == Some("bat")
                        && path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(|name| name.to_lowercase().contains("general"))
                            .unwrap_or(false)
                })
                .filter_map(|path| path.file_name().map(|name| name.to_string_lossy().to_string()))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Разбирает отчёт тестера zapret: сколько целей отвечает у каждого пресета.
fn parse_report(text: &str) -> Vec<PresetScore> {
    let mut scores: Vec<PresetScore> = Vec::new();
    let mut current: Option<PresetScore> = None;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Config:") {
            if let Some(score) = current.take() {
                scores.push(score);
            }
            let preset = rest
                .split("(Type")
                .next()
                .unwrap_or(rest)
                .trim()
                .to_string();
            current = Some(PresetScore { preset, ok: 0, total: 0 });
            continue;
        }
        if let Some(score) = current.as_mut() {
            if line.contains(" : ") {
                score.total += 1;
                // Успехом считаем любой ответ по HTTP или TLS
                let ok = line.contains("HTTP:OK") || line.contains("TLS1.3:OK") || line.contains("TLS1.2:OK");
                if ok {
                    score.ok += 1;
                }
            }
        }
    }
    if let Some(score) = current.take() {
        scores.push(score);
    }

    scores.sort_by(|a, b| b.ok.cmp(&a.ok).then(a.total.cmp(&b.total)));
    scores
}

fn latest_report(dir: &Path) -> Option<PathBuf> {
    let reports = dir.join("utils").join("test results");
    let mut files: Vec<PathBuf> = std::fs::read_dir(reports)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("txt"))
        .collect();
    files.sort_by_key(|path| {
        std::fs::metadata(path).and_then(|meta| meta.modified()).ok()
    });
    files.pop()
}

/// С каким пресетом установлена служба: это записано в реестре их же service.bat.
fn current_preset() -> Option<String> {
    let output = crate::silent::hidden("reg")
        .args([
            "query",
            r"HKLM\System\CurrentControlSet\Services\zapret",
            "/v",
            "zapret-discord-youtube",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    text.lines()
        .find(|line| line.contains("REG_SZ"))
        .and_then(|line| line.split("REG_SZ").nth(1))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

// ---------- Запуск без окон: задача планировщика ----------

/// Имя задачи, через которую приложение запускает обход скрытно.
const TASK_NAME: &str = "CursedPlayerZapret";

fn task_exists() -> bool {
    crate::silent::hidden("schtasks")
        .args(["/query", "/tn", TASK_NAME])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Создаёт задачу с правами администратора. Windows один раз покажет запрос —
/// зато дальше запуск идёт скрыто и без единого окна.
fn create_task(script: &Path) -> Result<(), String> {
    let command = format!(
        "Start-Process -FilePath 'schtasks' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList \
         '/create','/tn','{name}','/tr','powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{script}\"',\
         '/sc','once','/st','00:00','/rl','highest','/f'",
        name = TASK_NAME,
        script = script.display()
    );

    let status = crate::silent::hidden("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &command])
        .status()
        .map_err(|e| format!("Не удалось создать задачу: {e}"))?;

    if !status.success() || !task_exists() {
        return Err("Не удалось создать задачу: подтверди запрос администратора Windows".into());
    }
    Ok(())
}

/// Выполняет скрипт с правами администратора: без окон и без новых запросов.
pub fn run_elevated(body: &str) -> Result<(), String> {
    let dir = own_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join("task.ps1");
    std::fs::write(&script, body).map_err(|e| format!("Не записался скрипт: {e}"))?;

    if !task_exists() {
        create_task(&script)?;
    }

    let output = crate::silent::hidden("schtasks")
        .args(["/run", "/tn", TASK_NAME])
        .output()
        .map_err(|e| format!("Не удалось запустить задачу: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("Задача не запустилась: {text}"))
    }
}

/// Применяет пресет: запускает их же .bat скрыто (будет UAC только в первый раз).
pub fn apply_preset(preset: &str) -> Result<(), String> {
    let dir = folder();
    if !dir.is_dir() {
        return Err("Папка zapret не найдена".into());
    }
    let path = dir.join(preset);
    if !path.is_file() {
        return Err(format!("Пресет не найден: {}", path.display()));
    }

    run_elevated(&format!(
        "Start-Process -FilePath '{}' -WorkingDirectory '{}' -WindowStyle Hidden",
        path.display(),
        dir.display()
    ))
}

/// Запущен ли чужой обход: с ним мы не конфликтуем, а просто сообщаем.
fn winws_running() -> bool {
    let output = crate::silent::hidden("tasklist")
        .args(["/FI", "IMAGENAME eq winws.exe", "/NH"])
        .output();
    match output {
        Ok(result) => String::from_utf8_lossy(&result.stdout).to_lowercase().contains("winws.exe"),
        Err(_) => false,
    }
}

fn service_state() -> String {
    let output = crate::silent::hidden("sc").args(["query", "zapret"]).output();
    match output {
        Ok(result) => {
            let text = String::from_utf8_lossy(&result.stdout).to_uppercase();
            if text.contains("RUNNING") {
                "запущена".into()
            } else if text.contains("STOPPED") {
                "остановлена".into()
            } else {
                "не найдена".into()
            }
        }
        Err(_) => "неизвестно".into(),
    }
}

pub fn status() -> ZapretStatus {
    let dir = folder();
    let found = dir.is_dir();
    let binary_found = dir.join("bin").join("winws.exe").exists();
    let presets = if found { presets(&dir) } else { Vec::new() };
    let report = if found { latest_report(&dir) } else { None };

    let (report_scores, report_best) = match report.as_ref().and_then(|path| std::fs::read_to_string(path).ok()) {
        Some(text) => {
            let scores = parse_report(&text);
            let best = scores.first().cloned();
            (scores, best)
        }
        None => (Vec::new(), None),
    };

    let winws = winws_running();
    let service = service_state();
    let preset = current_preset();

    let note = if !found {
        "Папка zapret не найдена — укажи её в настройках, если она в другом месте".to_string()
    } else if winws || service == "запущена" {
        "Обход уже работает (твоя служба zapret) — приложение его не трогает, чтобы не мешать".to_string()
    } else {
        "Обход не запущен: можно применить подобранную стратегию из приложения".to_string()
    };

    ZapretStatus {
        folder: dir.to_string_lossy().to_string(),
        found,
        binary_found,
        presets,
        service_state: service,
        winws_running: winws,
        report_path: report.map(|path| path.to_string_lossy().to_string()),
        report_best,
        report_scores,
        current_preset: preset,
        note,
    }
}

/// Живая проверка: отвечают ли цели прямо сейчас (и что именно ломается).
pub fn probe(hosts: Vec<String>) -> Vec<ProbeResult> {
    let targets = if hosts.is_empty() {
        vec![
            "https://api-v2.soundcloud.com".to_string(),
            "https://soundcloud.com".to_string(),
            "https://discord.com".to_string(),
            "https://www.youtube.com".to_string(),
        ]
    } else {
        hosts
    };

    targets
        .into_iter()
        .map(|host| {
            let result = ureq::get(&host)
                .timeout(Duration::from_secs(12))
                .call();
            match result {
                Ok(response) => ProbeResult {
                    host: host.clone(),
                    ok: true,
                    detail: format!("HTTP {}", response.status()),
                },
                Err(error) => ProbeResult {
                    host: host.clone(),
                    ok: false,
                    detail: format!("{error}"),
                },
            }
        })
        .collect()
}

// ---------- Встроенный запуск: своя копия zapret и перебор стратегий ----------

/// Разбирает .bat пресета и достаёт аргументы для winws.exe.
/// Понимает переменные %BIN% и %LISTS%, переносы строк через ^ и кавычки.
pub fn parse_preset(text: &str, dir: &Path) -> Option<String> {
    let bin = format!("{}\\bin\\", dir.display());
    let lists = format!("{}\\lists\\", dir.display());

    // Склеиваем переносы строк (в .bat это символ ^ в конце строки)
    let joined = text.replace("^\r\n", " ").replace("^\n", " ").replace("\\\r\n", " ");

    let line = joined
        .lines()
        .find(|line| line.contains("winws.exe"))?;

    let after = line.split("winws.exe").nth(1)?.to_string();

    let mut args = after
        .replace("%BIN%", &bin)
        .replace("%LISTS%", &lists)
        .replace("%~dp0", &format!("{}\\", dir.display()));

    // Переменные игры (%GameFilterTCP% и прочие) просто убираем
    while let Some(start) = args.find('%') {
        match args[start + 1..].find('%') {
            Some(end) => args.replace_range(start..start + end + 2, ""),
            None => break,
        }
    }

    let cleaned = args.split_whitespace().collect::<Vec<_>>().join(" ");
    // После winws.exe в .bat остаётся кавычка — убираем вместе с пробелами
    let cleaned = cleaned.trim_start_matches(['"', ' ']).trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Папка, куда приложение копирует zapret, чтобы не зависеть от Desktop.
pub fn own_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("com.example.musichub").join("zapret")
}

/// Копирует bin и lists из папки пользователя в свою папку (один раз).
pub fn ensure_own_copy() -> Result<PathBuf, String> {
    let source = folder();
    if !source.join("bin").join("winws.exe").exists() {
        return Err("Не нашёл bin\\winws.exe в папке zapret".into());
    }
    let target = own_dir();
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    for sub in ["bin", "lists"] {
        let from = source.join(sub);
        let to = target.join(sub);
        std::fs::create_dir_all(&to).map_err(|e| format!("Не создаётся папка {}: {e}", to.display()))?;
        if let Ok(entries) = std::fs::read_dir(&from) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.file_name() {
                        // Ошибку копирования не глотаем: иначе папка окажется пустой
                        // и пользователь увидит непонятный отказ
                        std::fs::copy(&path, to.join(name)).map_err(|e| {
                            format!("Не скопировался {}: {e}", path.display())
                        })?;
                    }
                }
            }
        }
    }

    if !target.join("bin").join("winws.exe").exists() {
        return Err("Не удалось скопировать winws.exe".into());
    }
    Ok(target)
}

/// Список кандидатов: лучшие по отчёту тестов, чтобы перебор был быстрым.
pub fn candidates(limit: usize) -> Vec<String> {
    let status = status();
    let mut list: Vec<String> = Vec::new();

    // Сначала лучший пресет из их отчёта, он чаще всего и подходит
    if let Some(best) = status.report_best.as_ref() {
        list.push(best.preset.clone());
    }
    for score in status.report_scores.iter().take(limit) {
        if !list.contains(&score.preset) {
            list.push(score.preset.clone());
        }
    }
    list.truncate(limit.max(1));
    list
}

/// Готовит файлы для автоподбора и запускает скрипт с правами администратора.
/// Один запрос UAC — дальше всё делает скрипт и пишет результаты в файл.
pub fn start_autotest(limit: usize) -> Result<usize, String> {
    let own = ensure_own_copy()?;
    let source = folder();
    let list = candidates(limit);
    if list.is_empty() {
        return Err("Не нашёл пресеты для перебора".into());
    }

    // Таблица стратегий: имя<TAB>аргументы
    let mut table = String::new();
    for name in &list {
        let path = source.join(name);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        if let Some(args) = parse_preset(&text, &own) {
            table.push_str(&format!("{name}\t{args}\n"));
        }
    }
    if table.is_empty() {
        return Err("Не удалось разобрать аргументы пресетов".into());
    }

    let table_path = own.join("strategies.tsv");
    let results_path = own.join("autotest-results.tsv");
    let script_path = own.join("autotest.ps1");
    std::fs::write(&table_path, table).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&results_path);

    let script = format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$exe = '{exe}'
$table = '{table}'
$results = '{results}'
$target = 'https://api-v2.soundcloud.com'

# Останавливаем службу пользователя: два winws одновременно мешали бы друг другу
sc.exe stop zapret | Out-Null
Start-Sleep -Seconds 2
Remove-Item $results -ErrorAction SilentlyContinue

$lines = Get-Content $table | Where-Object {{ $_ -match "`t" }}
foreach ($line in $lines) {{
  $name, $args = $line.Split("`t", 2)
  $process = Start-Process -FilePath $exe -ArgumentList $args -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $ok = 'FAIL'
  $detail = ''
  try {{
    $response = Invoke-WebRequest -Uri $target -TimeoutSec 8 -UseBasicParsing
    $ok = 'OK'
    $detail = "HTTP $($response.StatusCode)"
  }} catch {{
    $detail = $_.Exception.Message
  }}
  "$name`t$ok`t$detail" | Add-Content -Path $results -Encoding UTF8
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
}}

# Оставляем включённой первую рабочую стратегию
$winner = Get-Content $results | Where-Object {{ $_ -match "`tOK`t" }} | Select-Object -First 1
if ($winner) {{
  $name = $winner.Split("`t")[0]
  $args = ($lines | Where-Object {{ $_ -like "$name`t*" }} | Select-Object -First 1).Split("`t", 2)[1]
  Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden
  "STARTED`t$name" | Add-Content -Path $results -Encoding UTF8
}} else {{
  sc.exe start zapret | Out-Null
  "NOBEST" | Add-Content -Path $results -Encoding UTF8
}}
"#,
        exe = own.join("bin").join("winws.exe").display(),
        table = table_path.display(),
        results = results_path.display()
    );

    std::fs::write(&script_path, &script).map_err(|e| e.to_string())?;

    // Один раз подтверждаем администратора (если задачи ещё нет), дальше — скрыто
    run_elevated(&script)?;
    Ok(list.len())
}

/// Читает результаты автоподбора: по строке на стратегию.
pub fn autotest_results() -> Vec<(String, bool, String)> {
    let path = own_dir().join("autotest-results.tsv");
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };

    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let name = parts.next()?.to_string();
            let state = parts.next().unwrap_or("");
            let detail = parts.next().unwrap_or("").to_string();
            match state {
                "OK" => Some((name, true, detail)),
                "FAIL" => Some((name, false, detail)),
                _ => None,
            }
        })
        .collect()
}

/// Запускает конкретный пресет из своей копии — скрытно, через задачу.
pub fn start_own(preset: &str) -> Result<(), String> {
    let own = ensure_own_copy()?;
    let text = std::fs::read_to_string(folder().join(preset))
        .map_err(|e| format!("Не читается пресет: {e}"))?;
    let args = parse_preset(&text, &own).ok_or_else(|| "Не разобрал аргументы пресета".to_string())?;

    run_elevated(&format!(
        "sc.exe stop zapret | Out-Null\nStart-Sleep -Seconds 2\nStart-Process -FilePath '{}' -ArgumentList '{}' -WindowStyle Hidden",        own.join("bin").join("winws.exe").display(),
        args.replace('\'', "''")
    ))
}

/// Останавливает winws приложения и возвращает службу пользователя.
pub fn stop_own() -> Result<(), String> {
    // Всё скрыто и без новых запросов администратора: задача уже создана
    run_elevated(
        "Stop-Process -Name winws -Force -ErrorAction SilentlyContinue\n\
         Start-Sleep -Seconds 1\n\
         sc.exe start zapret | Out-Null",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn preset_arguments_are_parsed() {
        let bat = r#"@echo off
set "BIN=%~dp0bin\"
set "LISTS=%~dp0lists\"
start "zapret" /min "%BIN%winws.exe" --wf-tcp=80,443,%GameFilterTCP% --wf-udp=443 ^
--filter-tcp=443 --hostlist="%LISTS%list-general.txt" --dpi-desync=fake --new ^
--filter-udp=443 --dpi-desync=fake
"#;
        let dir = PathBuf::from(r"C:\zapret");
        let args = parse_preset(bat, &dir).expect("аргументы должны разобраться");
        assert!(args.starts_with("--wf-tcp=80,443, --wf-udp=443"), "получили: {args}");
        assert!(args.contains(r#"--hostlist="C:\zapret\lists\list-general.txt""#));
        assert!(args.contains("--new"));
        assert!(!args.contains('%'), "переменные должны быть убраны: {args}");
    }

    #[test]
    fn preset_without_winws_is_rejected() {
        let dir = PathBuf::from(r"C:\zapret");
        assert!(parse_preset("@echo off\nrem nothing", &dir).is_none());
    }

    #[test]
    fn report_is_parsed_and_sorted() {
        let text = "\
Config: general (ALT).bat (Type: standard)
  DiscordMain : HTTP:ERROR TLS1.2:ERROR TLS1.3:OK    | Ping: 41 ms
  YouTubeWeb : HTTP:ERROR TLS1.2:ERROR TLS1.3:ERROR | Ping: 18 ms
Config: general (FAKE TLS AUTO).bat (Type: standard)
  DiscordMain : HTTP:OK    TLS1.2:OK    TLS1.3:OK | Ping: 41 ms
  YouTubeWeb : HTTP:OK    TLS1.2:ERROR TLS1.3:OK | Ping: 18 ms
";
        let scores = parse_report(text);
        assert_eq!(scores.len(), 2);
        assert_eq!(scores[0].preset, "general (FAKE TLS AUTO).bat");
        assert_eq!(scores[0].ok, 2);
        assert_eq!(scores[0].total, 2);
        assert_eq!(scores[1].ok, 1);
        assert_eq!(scores[1].total, 2);
    }

    #[test]
    fn empty_report_is_safe() {
        assert!(parse_report("").is_empty());
    }
}
