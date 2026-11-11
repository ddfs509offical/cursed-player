//! Офлайн-треки: файлы, сохранённые, чтобы музыка играла без интернета.
//!
//! Есть два честных режима, и пользователь видит, какой именно:
//! * `download` — автор трека разрешил скачивание, это настоящий файл трека;
//! * `cache` — автор не разрешил, поэтому лежит временная офлайн-копия потока.
//!
//! Плюс флаг «держу офлайн» (`kept`): пользователь просит копию не удалять.
//! Такую запись в реестре помечаем режимом `keep`, а исходный режим помним в
//! `baseKind` — снятие флага возвращает запись в него. Сам файл при этом не
//! переименовывается: он уже скачан, а имя лишь описывает, откуда он взялся.
//!
//! Режим и способ (`method`) — разные вещи, и пользователь видит оба. Режим
//! говорит, что это за копия (файл автора или временная офлайн-копия), а
//! способ — откуда файл взялся: `download` (страница автора разрешила
//! скачивание), `stream` (наш поток, в том числе склейка HLS с пересборкой),
//! `external` (сторонний сервис) или `import` (файл принесён вручную).
//! В записях прошлой версии поля не было — там способ выводится из режима:
//! `download` — это скачивание автора, всё остальное — наш поток.
//!
//! Рядом с файлами лежит `index.json`: он хранит исходный идентификатор трека
//! (`soundcloud:123`), поэтому плеер находит офлайн-копию по id из очереди, а
//! не угадывает её по имени файла. Файлы, которых в реестре нет (например,
//! сохранённые прошлой версией приложения), при чтении подхватываются в него
//! сами — иначе после обновления пользователь потерял бы свои загрузки.
//! Метаданные (название, исполнитель, обложка, длительность) для показа
//! по-прежнему читает та же функция `player::read_track`, что и для локальной
//! музыки, но значения из реестра считаются точнее: их дал сам сервис.
//!
//! Часть треков SoundCloud отдаётся только как HLS: ссылка ведёт на `.m3u8`,
//! а музыка лежит в сегментах. Такой поток `save` скачивает целиком и приводит
//! к формату, который играет WebView: fMP4 и MP3 склеиваются как есть, а
//! голый ADTS-AAC и MPEG-TS пересобираются в `.m4a` своим муксером
//! (`crate::remux`) — без ffmpeg и без сторонних программ. ffmpeg остаётся
//! только запасным путём, если он вообще есть в PATH: иначе пользователь
//! получил бы файл, который не проигрывается, а запись в «Скачанных» обязана
//! играть. Формат определяется по первым байтам сегментов: расширение и
//! content-type врут, байты — нет. Разбор плейлистов и пересборка потоков
//! живут рядом и проверяются тестами без сети.

use crate::player;
use crate::remux::{self, StreamFormat};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

/// Единственная точка чтения тегов офлайн-файла. Теги — тяжёлый диск I/O
/// (lofty разбирает файл целиком), поэтому список треков (`list`) их не читает
/// вовсе: метаданные уже лежат в реестре либо догружаются отдельно (`meta`).
fn read_tags(path: &Path) -> player::TrackFile {
    #[cfg(test)]
    TAG_READS.with(|counter| counter.set(counter.get() + 1));
    player::read_track(path)
}

// Счётчик чтений тегов: в тестах доказывает, что список их не делает.
// Счётчик на поток: тесты идут параллельно и не должны мешать друг другу.
#[cfg(test)]
thread_local! {
    static TAG_READS: std::cell::Cell<usize> = std::cell::Cell::new(0);
}

/// Расширения, которые мы умеем определять и играть.
const KNOWN_EXTENSIONS: &[&str] = &["mp3", "m4a", "ogg", "wav"];
/// Если ни ссылка, ни content-type не подсказали формат.
const DEFAULT_EXTENSION: &str = "mp3";
/// Разделитель между идентификатором и режимом в имени файла.
const KIND_SEPARATOR: &str = "__";
/// Режимы, которые можно запросить у `save`.
const KINDS: &[&str] = &["download", "cache"];
/// Все режимы, которые встречаются в реестре: `keep` — запись держат офлайн.
const ALL_KINDS: &[&str] = &["download", "cache", "keep"];
/// Способы, которыми файл мог попасть в офлайн-реестр: `download` — автор
/// разрешил скачивание, `stream` — наш поток (в том числе склейка HLS с
/// пересборкой в `.m4a`), `external` — сторонний сервис, `import` — файл
/// принесён вручную.
const METHODS: &[&str] = &["download", "stream", "external", "import"];
/// Что считаем способом, если разобрать запись не удалось: файл, о котором
/// ничего не известно, честнее назвать нашим потоком, а не файлом автора.
const DEFAULT_METHOD: &str = "stream";
/// Что считаем режимом, если разобрать имя не удалось.
const DEFAULT_KIND: &str = "cache";
/// Ограничение длины имени: длинный идентификатор не должен ломать путь.
const MAX_STEM: usize = 80;
/// Реестр офлайн-файлов внутри папки кеша.
const INDEX_FILE: &str = "index.json";
/// Временный файл реестра: пишем рядом и подменяем, чтобы не оставить обрывок.
const INDEX_TEMP: &str = "index.json.tmp";
/// Счётчик временных файлов: два одновременных сохранения одного трека
/// не должны писать в один и тот же `.part`.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
/// User-Agent: SoundCloud отдаёт потоки только «браузеру».
const CURL_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
/// Предел числа сегментов HLS: длиннее поток займёт диск и время без спроса.
const HLS_MAX_SEGMENTS: usize = 2000;
/// Общий предел на скачивание HLS-потока — десять минут.
const HLS_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
/// Предел размера потока, который пересобирается в памяти: муксеру нужны все
/// кадры сразу, чтобы собрать таблицы. Полуторачасовой поток на 128 кбит/с
/// занимает ~86 МБ, так что запас многократный.
const REMUX_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Режим по умолчанию для serde: без него старый или урезанный `index.json`
/// не прочитается вовсе, а потерять список загрузок хуже, чем угадать режим.
fn default_kind() -> String {
    DEFAULT_KIND.to_string()
}

/// Запись реестра офлайн-файлов: что лежит на диске и что об этом треке знает
/// сервис. Все поля — camelCase: файл читается глазами и фронтендом одинаково.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineRecord {
    /// Исходный идентификатор трека, например `soundcloud:123`.
    pub track_id: String,
    /// Имя файла внутри папки кеша.
    pub file: String,
    /// `download`, `cache` или `keep` (когда запись держат офлайн).
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Исходный режим до пометки «держу офлайн»: `download` или `cache`.
    #[serde(default = "default_kind")]
    pub base_kind: String,
    /// Как файл получен: `download`, `stream`, `external` или `import`.
    /// У записей прошлой версии поля нет — там способ выводится из режима
    /// (см. `normalize_method`), поэтому старый `index.json` читается как есть.
    #[serde(default)]
    pub method: String,
    /// Пользователь просил не удалять эту копию.
    #[serde(default)]
    pub kept: bool,
    /// Дата сохранения в миллисекундах Unix.
    #[serde(default)]
    pub saved_at: u64,
    /// Размер файла в байтах.
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    /// Альбом из тегов файла: список его не читает, значение ленивое.
    #[serde(default)]
    pub album: Option<String>,
    /// Длительность из тегов файла. Ноль — «ещё не читали».
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub cover: Option<String>,
}

/// Сохранённый офлайн-трек для интерфейса: реестр плюс теги самого файла
/// (альбом и длительность в реестре не хранятся — их читаем из файла).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    /// Исходный идентификатор трека — по нему плеер находит копию офлайн.
    pub track_id: String,
    pub path: String,
    pub file_name: String,
    /// `download` — автор разрешил скачивание; `cache` — временная копия;
    /// `keep` — копию просили держать офлайн.
    pub kind: String,
    /// Исходный режим копии (без учёта «держу офлайн»).
    pub base_kind: String,
    /// Как файл получен: `download`, `stream`, `external` или `import`.
    /// Способ и режим — разное: режим говорит, что это за копия, способ —
    /// откуда файл взялся.
    pub method: String,
    pub kept: bool,
    /// Размер файла в байтах.
    pub size: u64,
    /// Дата сохранения: время в миллисекундах Unix и та же дата в RFC3339.
    pub saved_at_ms: u64,
    pub saved_at: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: i64,
    /// Обложка: ссылка сервиса из реестра или путь к картинке из тегов файла.
    pub cover: Option<String>,
}

/// Папка офлайн-треков: `%APPDATA%\com.example.musichub\cache` (создаём по мере
/// надобности). Она же — единственное место, откуда команда удаления имеет
/// право стирать файлы.
pub fn cache_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "Не нашёл папку данных пользователя (APPDATA)".to_string())?;
    let dir = PathBuf::from(appdata)
        .join("com.example.musichub")
        .join("cache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не создаётся папка офлайн-треков: {e}"))?;
    Ok(dir)
}

/* ─────────────── Имена файлов ─────────────── */

/// Безопасное имя из идентификатора: остаются латиница, цифры, «-» и «_».
/// Точки и разделители путей заменяются, поэтому выйти за папку кеша
/// именем файла невозможно.
fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "track".to_string()
    } else {
        trimmed.chars().take(MAX_STEM).collect()
    }
}

/// Имя файла: `<безопасный id>__<режим>.<расширение>`.
fn file_name(id: &str, kind: &str, extension: &str) -> String {
    format!("{}{KIND_SEPARATOR}{kind}.{extension}", sanitize_id(id))
}

/// Имя без расширения.
fn stem_of(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((stem, _)) => stem,
        None => name,
    }
}

/// Режим из имени файла, если он там действительно записан.
/// `None` — имя к нашему формату не относится (например, `index.json`).
fn kind_from_name_opt(name: &str) -> Option<String> {
    match stem_of(name).rsplit_once(KIND_SEPARATOR) {
        Some((_, kind)) if ALL_KINDS.contains(&kind) => Some(kind.to_string()),
        _ => None,
    }
}

/// Режим из имени файла. Всё, что не «download» и не «cache», считаем кешем:
/// показать пользователю неверный режим хуже, чем недооценить его.
fn kind_from_name(name: &str) -> String {
    kind_from_name_opt(name).unwrap_or_else(|| DEFAULT_KIND.to_string())
}

/// Имя без служебного хвоста `__<режим>`: нужно для запасного названия,
/// когда в тегах файла пусто (`read_track` подставляет имя файла).
fn display_stem(name: &str) -> String {
    let stem = stem_of(name);
    match stem.rsplit_once(KIND_SEPARATOR) {
        Some((id, kind)) if ALL_KINDS.contains(&kind) => id.to_string(),
        _ => stem.to_string(),
    }
}

/// Режим из реестра, приведённый к известному: чужая строка не должна
/// превратиться в неизвестное состояние интерфейса.
fn normalize_kind(kind: &str) -> String {
    if ALL_KINDS.contains(&kind) {
        kind.to_string()
    } else {
        DEFAULT_KIND.to_string()
    }
}

/// Способ, выведенный из режима: `download` — это настоящий файл автора, всё
/// остальное — наш поток. Так подписываются записи прошлой версии, в которых
/// поля `method` ещё не было, и подхваченные с диска файлы.
fn method_from_kind(kind: &str, base_kind: &str) -> String {
    if kind == "download" || base_kind == "download" {
        "download".to_string()
    } else {
        DEFAULT_METHOD.to_string()
    }
}

/// Способ, приведённый к известному: чужую строку и пустое поле заменяем
/// выводом из режима — интерфейс не должен показывать невесть что.
fn normalize_method(method: &str, kind: &str, base_kind: &str) -> String {
    if METHODS.contains(&method) {
        method.to_string()
    } else {
        method_from_kind(kind, base_kind)
    }
}

/// Ключ сравнения идентификаторов: только строчные латинские буквы и цифры.
/// `soundcloud:123`, `soundcloud-123` и `soundcloud_123` — один и тот же трек:
/// раньше имя файла собирали заменой знаков в id, поэтому запись могла не
/// совпасть с идентификатором из очереди или избранного.
fn normalize_key(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Один и тот же ли это трек: сначала точное совпадение, затем по ключу.
fn same_track(left: &str, right: &str) -> bool {
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    let key = normalize_key(left);
    !key.is_empty() && key == normalize_key(right)
}

/* ─────────────── Реестр index.json ─────────────── */

/// Путь к реестру внутри папки кеша.
fn index_path(dir: &Path) -> PathBuf {
    dir.join(INDEX_FILE)
}

/// Прочитанные записи, приведённые к согласованному виду: неизвестный режим
/// становится `cache`, `keep` всегда означает `kept`, битые записи отбрасываются.
fn normalize_record(mut record: OfflineRecord) -> Option<OfflineRecord> {
    if record.track_id.trim().is_empty() || record.file.trim().is_empty() {
        return None;
    }
    // Имя файла из реестра не должно уводить за пределы папки кеша
    if record.file.contains("..") || record.file.contains('/') || record.file.contains('\\') {
        return None;
    }
    record.kind = normalize_kind(&record.kind);
    record.base_kind = normalize_kind(&record.base_kind);
    if record.kind == "keep" {
        record.kept = true;
        if record.base_kind == "keep" {
            record.base_kind = DEFAULT_KIND.to_string();
        }
    } else if record.kept {
        // Флаг стоит, а режим не «keep» — приводим запись к одному смыслу
        record.kind = "keep".to_string();
    }
    if record.kind == "keep" && record.base_kind == "keep" {
        record.base_kind = DEFAULT_KIND.to_string();
    }
    // Способ выводим из уже приведённых к известным режимов: у записи прошлой
    // версии поля нет вовсе, а у чужой — там может лежать что угодно
    record.method = normalize_method(&record.method, &record.kind, &record.base_kind);
    Some(record)
}

/// Читает реестр. Отсутствующий или битый файл — это пустой список, а не
/// ошибка: файлы на диске важнее, их подхватит `sync_index`.
fn read_index(dir: &Path) -> Vec<OfflineRecord> {
    let Ok(raw) = std::fs::read_to_string(index_path(dir)) else {
        return Vec::new();
    };
    let parsed: Vec<OfflineRecord> = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    parsed.into_iter().filter_map(normalize_record).collect()
}

/// Записывает реестр: сначала во временный файл рядом, затем подменяет им
/// настоящий — обрывок JSON не должен остаться на месте списка загрузок.
fn write_index(dir: &Path, records: &[OfflineRecord]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(records).map_err(|e| format!("Реестр не собрался: {e}"))?;
    let temp = dir.join(INDEX_TEMP);
    std::fs::write(&temp, text).map_err(|e| format!("Не записался реестр офлайн-треков: {e}"))?;
    let target = index_path(dir);
    if std::fs::rename(&temp, &target).is_ok() {
        return Ok(());
    }
    // Запасной путь: на некоторых файловых системах подмена не проходит
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&temp, &target).map_err(|e| format!("Не записался реестр офлайн-треков: {e}"))
}

/// Время изменения файла в миллисекундах Unix — запасная дата сохранения.
fn file_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or_else(now_ms)
}

/// Текущее время в миллисекундах Unix.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// Миллисекунды Unix в RFC3339 — тот же формат дат, что и раньше.
fn rfc3339(ms: u64) -> String {
    let time = UNIX_EPOCH + std::time::Duration::from_millis(ms);
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()
}

/// Карточка файла для интерфейса: реестр — единственный источник метаданных,
/// теги файла сюда не читаются (это делает `meta` по явному запросу).
fn saved_file(record: &OfflineRecord, dir: &Path, meta: &std::fs::Metadata) -> SavedFile {
    let path = dir.join(&record.file);
    let file_name = record.file.clone();
    // В реестре пусто — показываем имя файла без служебного хвоста `__<режим>`
    let fallback_title = display_stem(&stem_of(&file_name));
    let saved_at_ms = if record.saved_at > 0 {
        record.saved_at
    } else {
        file_ms(meta)
    };

    SavedFile {
        track_id: record.track_id.clone(),
        path: path.to_string_lossy().to_string(),
        file_name,
        kind: record.kind.clone(),
        base_kind: record.base_kind.clone(),
        method: normalize_method(&record.method, &record.kind, &record.base_kind),
        kept: record.kept,
        size: if meta.len() > 0 { meta.len() } else { record.size },
        saved_at_ms,
        saved_at: rfc3339(saved_at_ms),
        title: if record.title.trim().is_empty() {
            fallback_title
        } else {
            record.title.clone()
        },
        artist: record.artist.clone(),
        album: record.album.clone(),
        duration_ms: record.duration_ms,
        cover: record.cover.clone(),
    }
}

/// Собирает карточку файла по записи реестра: проверяем, что файл на месте
/// (`metadata` — без чтения содержимого), но тегов не разбираем.
fn describe_record(record: &OfflineRecord, dir: &Path) -> Option<SavedFile> {
    let path = dir.join(&record.file);
    let meta = std::fs::metadata(&path).ok()?;
    if meta.len() == 0 {
        return None;
    }
    Some(saved_file(record, dir, &meta))
}

/// Реестр, согласованный с диском: записи без файла вычищаются, а файлы, о
/// которых реестр не знает (сохранённые прошлой версией), в него добавляются.
/// Так список загрузок не теряется ни при обновлении приложения, ни при
/// удалении файла мимо интерфейса. Теги здесь не читаются: у подхваченной
/// записи название — имя файла, метаданные догрузит `meta` при необходимости.
fn sync_index(dir: &Path) -> Vec<OfflineRecord> {
    let stored = read_index(dir);
    let mut records: Vec<OfflineRecord> = Vec::with_capacity(stored.len());
    let mut changed = false;

    for mut record in stored {
        match std::fs::metadata(dir.join(&record.file)) {
            Ok(meta) if meta.is_file() && meta.len() > 0 => {
                let size = meta.len();
                if record.size != size {
                    record.size = size;
                    changed = true;
                }
                if record.saved_at == 0 {
                    record.saved_at = file_ms(&meta);
                    changed = true;
                }
                records.push(record);
            }
            // Файла нет или он пустой — записи в списке делать нечего
            _ => changed = true,
        }
    }

    // Подхватываем файлы, которых нет в реестре
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut orphans: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .collect();
        orphans.sort();
        for path in orphans {
            let Some(name) = path.file_name().map(|value| value.to_string_lossy().to_string()) else {
                continue;
            };
            if name == INDEX_FILE || name == INDEX_TEMP || name.ends_with(".part") {
                continue;
            }
            // Имя без «__<режим>» к нашему формату не относится
            let Some(kind) = kind_from_name_opt(&name) else {
                continue;
            };
            let track_id = display_stem(&name);
            if track_id.is_empty() || records.iter().any(|item| item.file == name) {
                continue;
            }
            // Тот же трек уже есть в реестре под другим файлом — не плодим
            if records.iter().any(|item| same_track(&item.track_id, &track_id)) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.len() == 0 {
                continue;
            }
            let stem = stem_of(&name).to_string();
            let base_kind = if kind == "keep" { DEFAULT_KIND.to_string() } else { kind.clone() };
            // Файл из прошлой версии: способ виден только по режиму из имени
            let method = method_from_kind(&kind, &base_kind);
            records.push(OfflineRecord {
                track_id,
                file: name,
                kind,
                base_kind,
                method,
                kept: false,
                saved_at: file_ms(&meta),
                size: meta.len(),
                title: display_stem(&stem),
                artist: None,
                album: None,
                duration_ms: 0,
                cover: None,
            });
            changed = true;
        }
    }

    if changed {
        // Реестр — вспомогательный: его сбой не должен ломать список загрузок
        let _ = write_index(dir, &records);
    }
    records
}

/* ─────────────── Форматы и ссылки ─────────────── */

/// MIME без параметров, в нижнем регистре.
fn mime_of(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Расширение из ссылки: SoundCloud обычно кладёт его в путь к файлу.
fn extension_from_url(url: &str) -> Option<String> {
    let path = url.split(|c| c == '?' || c == '#').next().unwrap_or("");
    let name = path.rsplit('/').next().unwrap_or(path);
    let candidate = name.rsplit_once('.')?.1.to_ascii_lowercase();
    if KNOWN_EXTENSIONS.contains(&candidate.as_str()) {
        Some(candidate)
    } else {
        None
    }
}

/// Расширение по content-type: curl отдаёт его после загрузки (`--write-out`).
fn extension_from_content_type(content_type: &str) -> Option<String> {
    let extension = match mime_of(content_type).as_str() {
        "audio/mpeg" | "audio/mp3" | "audio/mpeg3" | "audio/x-mpeg-3" => "mp3",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" | "audio/aac" => "m4a",
        "audio/ogg" | "application/ogg" | "audio/opus" | "audio/vorbis" => "ogg",
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => "wav",
        _ => return None,
    };
    Some(extension.to_string())
}

/// Итоговое расширение: сначала имя файла из ссылки (оно точнее), затем
/// content-type ответа, затем запасной `.mp3`.
fn pick_extension(url: &str, content_type: &str) -> String {
    extension_from_url(url)
        .or_else(|| extension_from_content_type(content_type))
        .unwrap_or_else(|| DEFAULT_EXTENSION.to_string())
}

/// HLS-плейлист — это список сегментов, а не файл с музыкой: сохранив его
/// как есть, пользователь получил бы неиграющую «пустышку» на пару килобайт.
/// Поэтому по этой проверке `save_in` уходит в `download_hls`: плейлист
/// разбирается, сегменты скачиваются и склеиваются в один играемый файл.
fn is_playlist(url: &str, content_type: &str) -> bool {
    let path = url.split(|c| c == '?' || c == '#').next().unwrap_or("");
    path.to_ascii_lowercase().ends_with(".m3u8") || mime_of(content_type).contains("mpegurl")
}

/// Вместо аудио пришла страница ошибки или JSON: так бывает, когда ссылка
/// уже истекла. Проверка мягкая — неизвестный тип (например,
/// application/octet-stream) принимаем, отбрасываем только явно не аудио.
fn looks_like_error_page(content_type: &str) -> bool {
    let mime = mime_of(content_type);
    mime.starts_with("text/")
        || mime == "application/json"
        || mime.ends_with("+json")
        || mime.ends_with("xml")
}

/* ─────────────── HLS ─────────────── */

/// Вариант master-плейлиста: дорожка со своим битрейтом.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HlsVariant {
    /// BANDWIDTH из `#EXT-X-STREAM-INF`; ноль — «сервис битрейт не назвал».
    bandwidth: u64,
    /// Абсолютная ссылка на media-плейлист варианта.
    url: String,
}

/// Media-плейлист: init-сегмент (fMP4) и сегменты по порядку.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct HlsMedia {
    /// `#EXT-X-MAP:URI` — общий заголовок fMP4, его скачивают первым.
    init: Option<String>,
    segments: Vec<String>,
}

/// Что оказалось в плейлисте: список вариантов или сами сегменты.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ParsedPlaylist {
    /// Master: варианты качества, из которых выбираем лучший по BANDWIDTH.
    Master(Vec<HlsVariant>),
    /// Media: готовый список сегментов.
    Media(HlsMedia),
}

/// Тип сегмента HLS и его формат описывает `crate::remux::StreamFormat`:
/// определение по байтам живёт в одном месте для HLS и для обычных файлов.

/// Остаток строки после тега: `#EXTINF:4.0,` с тегом `#EXTINF` → `4.0,`.
/// `None` — это не тот тег. Сравнение без учёта регистра, но тег обязан
/// закончиться или продолжиться двоеточием: `#EXTINF2` — уже не `#EXTINF`.
fn after_tag<'a>(line: &'a str, tag: &str) -> Option<&'a str> {
    if line.len() < tag.len() || !line.is_char_boundary(tag.len()) {
        return None;
    }
    let (head, tail) = line.split_at(tag.len());
    if !head.eq_ignore_ascii_case(tag) {
        return None;
    }
    match tail.chars().next() {
        None => Some(""),
        Some(':') => Some(&tail[1..]),
        _ => None,
    }
}

/// Атрибуты тега: `BANDWIDTH=128000,CODECS="a,b"` → пары «имя → значение».
/// Кавычки важны: значение может содержать запятую и «=».
fn parse_attributes(text: &str) -> Vec<(String, String)> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;

    for symbol in text.chars() {
        match symbol {
            '"' => {
                quoted = !quoted;
                current.push(symbol);
            }
            ',' if !quoted => parts.push(std::mem::take(&mut current)),
            _ => current.push(symbol),
        }
    }
    parts.push(current);

    parts
        .into_iter()
        .filter_map(|part| {
            let (name, value) = part.split_once('=')?;
            let name = name.trim().to_ascii_uppercase();
            let value = value.trim().trim_matches('"').to_string();
            if name.is_empty() || value.is_empty() {
                None
            } else {
                Some((name, value))
            }
        })
        .collect()
}

/// Значение атрибута по имени (имя — в верхнем регистре).
fn attribute(text: &str, name: &str) -> Option<String> {
    parse_attributes(text)
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

/// Разрешает ссылку из плейлиста относительно адреса самого плейлиста:
/// абсолютные оставляем, «//host/...» достраиваем схемой, «/path» — хостом,
/// остальное — папкой, в которой лежит плейлист.
fn resolve_url(base: &str, reference: &str) -> String {
    let reference = reference.trim();
    if reference.is_empty() {
        return String::new();
    }
    let lower = reference.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return reference.to_string();
    }

    let (scheme, rest) = base.split_once("://").unwrap_or(("https", base));
    if let Some(after) = reference.strip_prefix("//") {
        return format!("{scheme}://{after}");
    }

    let (authority, path) = match rest.find('/') {
        Some(position) => (&rest[..position], &rest[position..]),
        None => (rest, "/"),
    };
    // Параметры и якорь адреса плейлиста к ссылке не относятся
    let path = path.split(['?', '#']).next().unwrap_or(path);

    if let Some(after) = reference.strip_prefix('/') {
        return format!("{scheme}://{authority}/{after}");
    }

    let directory = match path.rfind('/') {
        Some(position) => &path[..=position],
        None => "/",
    };
    format!("{scheme}://{authority}{directory}{reference}")
}

/// Похожа ли строка на ссылку, а не на строку HTML или случайный текст.
/// Пробелы и угловые скобки в ссылке невозможны: так мусор не станет
/// «сегментом», даже если сервис вернул страницу ошибки вместо плейлиста.
fn looks_like_uri(value: &str) -> bool {
    !value.is_empty()
        && !value
            .chars()
            .any(|symbol| symbol.is_whitespace() || matches!(symbol, '<' | '>' | '"' | '{' | '}'))
}

/// Разбирает HLS-плейлист: определяет, master это или media, и разрешает
/// все ссылки относительно адреса плейлиста. Сети здесь нет — только текст,
/// поэтому функцию целиком проверяют тесты.
fn parse_playlist(text: &str, base: &str) -> Result<ParsedPlaylist, String> {
    let mut variants: Vec<HlsVariant> = Vec::new();
    let mut media = HlsMedia::default();
    let mut pending_bandwidth: Option<u64> = None;
    let mut saw_media_tag = false;
    let mut encrypted = false;
    let mut byterange = false;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(value) = after_tag(line, "#EXT-X-KEY") {
            // Зашифрованные сегменты без ключа не заиграют: обещать сохранение
            // нельзя. `METHOD=NONE` — это открытый поток, его принимаем.
            let method = attribute(value, "METHOD").unwrap_or_default();
            if !method.is_empty() && !method.eq_ignore_ascii_case("NONE") {
                encrypted = true;
            }
            continue;
        }
        if let Some(value) = after_tag(line, "#EXT-X-STREAM-INF") {
            let bandwidth = attribute(value, "BANDWIDTH")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            pending_bandwidth = Some(bandwidth);
            continue;
        }
        if let Some(value) = after_tag(line, "#EXT-X-MAP") {
            saw_media_tag = true;
            if attribute(value, "BYTERANGE").is_some() {
                byterange = true;
            }
            if let Some(uri) = attribute(value, "URI") {
                let resolved = resolve_url(base, &uri);
                if !resolved.is_empty() {
                    media.init = Some(resolved);
                }
            }
            continue;
        }
        if after_tag(line, "#EXT-X-BYTERANGE").is_some() {
            // Сегмент — это кусок одного файла, а не отдельный файл: скачав
            // адрес целиком, мы получили бы совсем не то, что просили
            byterange = true;
            continue;
        }
        if after_tag(line, "#EXTINF").is_some() {
            saw_media_tag = true;
            continue;
        }
        // Прочие теги (#EXT-X-VERSION, #EXT-X-ENDLIST, #EXT-X-KEY…) не мешают
        if line.starts_with('#') {
            continue;
        }
        if !looks_like_uri(line) {
            continue;
        }

        // Обычная строка — ссылка: у master она идёт после #EXT-X-STREAM-INF,
        // у media — после #EXTINF (или просто подряд).
        let url = resolve_url(base, line);
        if url.is_empty() {
            continue;
        }
        match pending_bandwidth.take() {
            Some(bandwidth) => variants.push(HlsVariant { bandwidth, url }),
            None => media.segments.push(url),
        }
    }

    if encrypted {
        return Err("поток зашифрован (HLS с ключами) — сохранение не поддержано".into());
    }
    if byterange {
        return Err(
            "поток отдаётся кусками одного файла (#EXT-X-BYTERANGE) — сохранение не поддержано"
                .into(),
        );
    }
    if !variants.is_empty() {
        return Ok(ParsedPlaylist::Master(variants));
    }
    // Сегменты без единого тега media — это не плейлист, а случайный текст
    if saw_media_tag && !media.segments.is_empty() {
        return Ok(ParsedPlaylist::Media(media));
    }
    Err("Это не HLS-плейлист: в нём нет ни вариантов, ни сегментов".into())
}

/// Лучший вариант master-плейлиста: чем выше BANDWIDTH, тем лучше качество.
/// При равенстве (и когда битрейт не указан ни у кого) остаётся первый.
fn best_variant(variants: &[HlsVariant]) -> Option<&HlsVariant> {
    variants
        .iter()
        .reduce(|best, item| if item.bandwidth > best.bandwidth { item } else { best })
}

/// Подсказка о формате по расширению ссылки и content-type ответа. Сама по
/// себе она не решает: нужна лишь тогда, когда первые байты ничего не сказали
/// (например, первый сегмент не скачался). Расширение и тип врут, байты — нет.
fn stream_kind_of(url: &str, content_type: &str) -> StreamFormat {
    let path = url
        .split(|symbol| symbol == '?' || symbol == '#')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = mime_of(content_type);

    if path.ends_with(".ts") || mime.contains("mp2t") {
        return StreamFormat::MpegTs;
    }
    if path.ends_with(".aac") || mime == "audio/aac" {
        return StreamFormat::Adts;
    }
    if path.ends_with(".m4s")
        || path.ends_with(".mp4")
        || path.ends_with(".m4a")
        || path.ends_with(".cmfv")
        || path.ends_with(".cmfa")
        || mime.contains("mp4")
    {
        return StreamFormat::Mp4;
    }
    if path.ends_with(".mp3") || mime == "audio/mpeg" || mime == "audio/mp3" {
        return StreamFormat::Mp3;
    }
    StreamFormat::Unknown
}

/// Формат потока: сначала по самим байтам, и только если они ничего не
/// сказали — по ссылке и content-type. Иначе `.m4a` в имени сегмента заставил
/// бы сохранить голый ADTS, который WebView не проигрывает.
fn stream_format(head: &[u8], url: &str, content_type: &str) -> StreamFormat {
    match remux::detect(head) {
        StreamFormat::Unknown => stream_kind_of(url, content_type),
        known => known,
    }
}

/// Скачивает текстовый ответ (плейлист) — тем же curl с DoH, что и сегменты.
fn fetch_text(url: &str) -> Result<String, String> {
    let mut last_error = String::new();

    for doh in [true, false] {
        let mut command = crate::silent::hidden("curl");
        command.args(["-sS", "--fail", "-L", "--max-time", "60"]);
        // Schannel на Windows проверяет отзыв сертификата: без флага запрос
        // падает с CRYPT_E_REVOCATION_OFFLINE, когда CRL/OCSP недоступны.
        if cfg!(windows) {
            command.arg("--ssl-no-revoke");
        }
        if doh {
            command.args(["--doh-url", "https://1.1.1.1/dns-query"]);
        }
        let output = command
            .args(["-A", CURL_AGENT])
            .arg(url)
            .output()
            .map_err(|e| format!("curl недоступен: {e}"))?;

        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if !text.trim().is_empty() {
                return Ok(text);
            }
            last_error = "пустой ответ".into();
        } else {
            last_error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        }
    }

    Err(if last_error.is_empty() {
        "curl не получил ответ".into()
    } else {
        last_error
    })
}

/// Запасной путь через ffmpeg: он разбирает больше нашего муксера, но
/// обязательным не является. Если ffmpeg в PATH нет, это просто ещё одна
/// причина в тексте ошибки, а не отказ сохранять трек.
fn convert_with_ffmpeg(source: &Path, target: &Path) -> Result<(), String> {
    let output = crate::silent::hidden("ffmpeg")
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(source)
        .args(["-c:a", "copy", "-vn"])
        .arg(target)
        .output()
        .map_err(|_| "ffmpeg не найден в PATH".to_string())?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() {
            "ffmpeg не справился с потоком".into()
        } else {
            error
        });
    }
    if std::fs::metadata(target).map(|meta| meta.len() == 0).unwrap_or(true) {
        return Err("ffmpeg вернул пустой файл".into());
    }
    Ok(())
}

/// Первые байты файла: по ним определяется формат потока.
fn read_head(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Не открылся скачанный файл: {e}"))?;
    let mut head = vec![0u8; limit];
    let mut filled = 0usize;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(e) => return Err(format!("Не прочитался скачанный файл: {e}")),
        }
    }
    head.truncate(filled);
    Ok(head)
}

/// Читает поток целиком: муксеру нужны все кадры сразу, чтобы собрать таблицы.
fn read_stream(path: &Path) -> Result<Vec<u8>, String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("Не прочитался поток: {e}"))?
        .len();
    if size > REMUX_MAX_BYTES {
        return Err(format!(
            "поток слишком большой для пересборки: {size} байт (предел {REMUX_MAX_BYTES})"
        ));
    }
    std::fs::read(path).map_err(|e| format!("Не прочитался поток: {e}"))
}

/// Приводит скачанный поток к файлу, который играет WebView, и возвращает путь
/// к готовому файлу вместе с расширением.
///
/// Основной путь — свой муксер (`crate::remux`): он работает всегда, без
/// внешних программ и без сети. ffmpeg подключается только если свой муксер
/// сдался: он умеет разбирать редкие варианты, но обязательным не является.
fn rebuild_stream(
    raw: &Path,
    target: &Path,
    format: StreamFormat,
) -> Result<(PathBuf, String), String> {
    let native = read_stream(raw).and_then(|bytes| match format {
        StreamFormat::Adts => remux::adts_to_m4a(&bytes),
        StreamFormat::MpegTs => remux::mpeg_ts_to_m4a(&bytes),
        StreamFormat::Unknown => {
            Err("формат потока не опознан: это не MP4, не ADTS-AAC и не MPEG-TS".to_string())
        }
        known => Err(format!("поток в формате {} пересобирать нечем", known.name())),
    });

    match native {
        Ok(bytes) => {
            // Пишем рядом и подменяем: исходный поток может лежать по тому же
            // пути (обычное скачивание), и портить его до успеха нельзя.
            let staged = raw.with_extension("muxed");
            let written = std::fs::write(&staged, &bytes)
                .map_err(|e| format!("Не записался офлайн-файл: {e}"))
                .and_then(|()| {
                    std::fs::rename(&staged, target)
                        .map_err(|e| format!("Не удалось сохранить файл: {e}"))
                });
            if let Err(error) = written {
                let _ = std::fs::remove_file(&staged);
                return Err(error);
            }
            Ok((target.to_path_buf(), format.extension().to_string()))
        }
        Err(native_error) => {
            let converted = raw.with_extension("m4a");
            match convert_with_ffmpeg(raw, &converted) {
                Ok(()) => Ok((converted, "m4a".to_string())),
                Err(ffmpeg_error) => {
                    // Обрывок от ffmpeg в папке кеша не нужен
                    let _ = std::fs::remove_file(&converted);
                    Err(format!(
                        "Не удалось собрать поток в играемый файл: {} — {native_error}; ffmpeg: {ffmpeg_error}",
                        format.name()
                    ))
                }
            }
        }
    }
}

/// Скачивает init-сегмент и сегменты по порядку, складывая их в один файл
/// `raw_temp`, и приводит поток к формату, который играет WebView: fMP4 и MP3
/// склеиваются как есть, а голый ADTS-AAC и MPEG-TS пересобираются в `.m4a`.
/// Возвращает путь к готовому файлу и его расширение: пересобранный поток
/// лежит по тому же пути `target`, а запасной путь через ffmpeg — по другому.
fn collect_hls(
    media: &HlsMedia,
    target: &Path,
    segment_temp: &Path,
    raw_temp: &Path,
) -> Result<(PathBuf, String), String> {
    let deadline = Instant::now() + HLS_TOTAL_TIMEOUT;
    let mut file =
        std::fs::File::create(raw_temp).map_err(|e| format!("Не создался файл офлайн-копии: {e}"))?;

    let mut head: Vec<u8> = Vec::new();
    // Ссылка и тип первого сегмента — только подсказка на случай, когда байты
    // ничего не сказали
    let mut hint_url = String::new();
    let mut hint_type = String::new();
    let mut total: u64 = 0;

    let urls = media.init.iter().cloned().chain(media.segments.iter().cloned());
    for url in urls {
        if Instant::now() > deadline {
            return Err("HLS-поток не скачался за 10 минут".into());
        }

        let content_type = match download_with_curl(&url, segment_temp, true) {
            Ok(value) => value,
            Err(doh_error) => download_with_curl(&url, segment_temp, false).map_err(|error| {
                format!("Не скачался сегмент HLS. Через DoH: {doh_error}. Обычным способом: {error}")
            })?,
        };
        if hint_url.is_empty() {
            hint_url = url.clone();
            hint_type = content_type.clone();
        }

        let bytes =
            std::fs::read(segment_temp).map_err(|e| format!("Не прочитался сегмент HLS: {e}"))?;
        if bytes.is_empty() {
            continue;
        }
        // Первые байты потока — единственный надёжный источник формата
        if head.len() < remux::PROBE_BYTES {
            let room = remux::PROBE_BYTES - head.len();
            head.extend_from_slice(&bytes[..bytes.len().min(room)]);
        }
        file.write_all(&bytes)
            .map_err(|e| format!("Не записался офлайн-файл: {e}"))?;
        total += bytes.len() as u64;
    }
    drop(file);

    if total == 0 {
        return Err("HLS-поток пришёл пустым".into());
    }

    let format = stream_format(&head, &hint_url, &hint_type);
    if format.plays_as_is() {
        // fMP4 и MP3: склеенные байты WebView играет как есть
        std::fs::rename(raw_temp, target).map_err(|e| format!("Не удалось сохранить файл: {e}"))?;
        return Ok((target.to_path_buf(), format.extension().to_string()));
    }

    rebuild_stream(raw_temp, target, format)
}

/// Скачивает HLS-поток в один играемый файл `target`.
///
/// Master-плейлист разворачиваем в лучший по BANDWIDTH вариант, затем качаем
/// init-сегмент (`#EXT-X-MAP`) и все сегменты по порядку. Временные файлы
/// убираются в любом случае, чтобы в папке кеша не оставался мусор.
fn download_hls(
    dir: &Path,
    link: &str,
    playlist: &str,
    target: &Path,
    id: &str,
) -> Result<(PathBuf, String), String> {
    let media = match parse_playlist(playlist, link)? {
        ParsedPlaylist::Media(media) => media,
        ParsedPlaylist::Master(variants) => {
            let best =
                best_variant(&variants).ok_or_else(|| "Пустой master-плейлист".to_string())?;
            let text = fetch_text(&best.url)?;
            match parse_playlist(&text, &best.url)? {
                ParsedPlaylist::Media(media) => media,
                ParsedPlaylist::Master(_) => {
                    return Err("Плейлист лучшего варианта тоже оказался master-плейлистом".into())
                }
            }
        }
    };

    if media.segments.is_empty() {
        return Err("В плейлисте нет сегментов".into());
    }
    if media.segments.len() > HLS_MAX_SEGMENTS {
        return Err(format!(
            "поток слишком длинный: {} сегментов (предел {HLS_MAX_SEGMENTS})",
            media.segments.len()
        ));
    }

    let segment_temp = dir.join(format!(
        "{}.{}.hls.part",
        sanitize_id(id),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    // Сырые склеенные байты: из них берётся формат, и они же идут в муксер
    let raw_temp = dir.join(format!(
        "{}.{}.hls.raw",
        sanitize_id(id),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = collect_hls(&media, target, &segment_temp, &raw_temp);
    let _ = std::fs::remove_file(&segment_temp);
    let _ = std::fs::remove_file(&raw_temp);

    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let _ = std::fs::remove_file(target);
            Err(error)
        }
    }
}

/* ─────────────── Скачивание ─────────────── */

/// Убирает временные копии трека. Нужно при настоящем скачивании: если трек
/// сначала лежал в кеше, а потом автор разрешил скачивание, в списке не должно
/// остаться двух записей об одном треке. В обратную сторону не работает —
/// кеш не должен вытеснять уже сохранённый файл автора.
fn remove_cache_copies(dir: &Path, id: &str) -> Vec<String> {
    let stem = sanitize_id(id);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut removed = Vec::new();
    for path in entries.flatten().map(|entry| entry.path()) {
        let Some(name) = path.file_name().map(|value| value.to_string_lossy().to_string()) else {
            continue;
        };
        let Some((file_stem, _)) = name.rsplit_once('.') else {
            continue;
        };
        if file_stem == format!("{stem}{KIND_SEPARATOR}cache") && std::fs::remove_file(&path).is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// Скачивание через curl: тот же приём, что в soundcloud.rs — DoH отдаёт
/// настоящий адрес, когда провайдер подменяет DNS. Файл пишется сразу на диск
/// (`-o`), а content-type забираем через `--write-out` из stdout.
pub(crate) fn download_with_curl(url: &str, target: &Path, doh: bool) -> Result<String, String> {
    let mut command = crate::silent::hidden("curl");
    command.args(["-sS", "--fail", "-L", "--max-time", "300"]);
    // Тот же флаг, что в остальных вызовах: на Windows Schannel проверяет
    // отзыв сертификата и падает, когда CRL/OCSP недоступны.
    if cfg!(windows) {
        command.arg("--ssl-no-revoke");
    }
    if doh {
        command.args(["--doh-url", "https://1.1.1.1/dns-query"]);
    }

    let output = command
        .args(["-A", CURL_AGENT])
        .arg("-o")
        .arg(target)
        .args(["-w", "%{content_type}"])
        .arg(url)
        .output()
        .map_err(|e| format!("curl недоступен: {e}"))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() {
            "curl не получил ответ".into()
        } else {
            error
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Скачивает трек в папку офлайн-треков.
///
/// `kind`: `download` — автор разрешил скачивание, `cache` — временная
/// офлайн-копия потока. `title`, `artist`, `cover` приходят из сервиса и
/// кладутся в реестр: у скачанного потока тегов обычно нет, а показать
/// пользователю название всё равно нужно. Возвращает карточку файла.
///
/// Способ (`method`) выводится из режима: `download` — файл автора, `cache` —
/// наш поток, в том числе склейка HLS с пересборкой в `.m4a`.
pub fn save(
    url: &str,
    id: &str,
    kind: &str,
    title: &str,
    artist: Option<&str>,
    cover: Option<&str>,
) -> Result<SavedFile, String> {
    let dir = cache_dir()?;
    save_in(&dir, url, id, kind, title, artist, cover)
}

/// Принимает в офлайн-реестр уже скачанный чужой файл: так сохраняется трек,
/// добытый внешним сервисом (`external_download`) или принесённый вручную.
///
/// `source` обязан лежать в папке кеша: файл переименовывается, а не
/// копируется. Режим — тот же, что у `save`: `download` (автор разрешил) или
/// `cache` (офлайн-копия). Содержимое здесь не проверяется: за это отвечает
/// тот, кто скачивал.
///
/// `method` — откуда файл взялся (`external` — сторонний сервис, `import` —
/// принесён вручную). Вывести его из режима нельзя: и сторонний сервис, и
/// ручной импорт кладут файл офлайн-копией, поэтому способ называет вызывающий.
///
/// Шаги приёма намеренно повторяют хвост `save_in`: вынести их в общую
/// функцию нельзя без правки самого `save_in`, а его прямо сейчас трогает
/// параллельная работа по HLS. Разойдясь, эти два места сломали бы реестр,
/// поэтому при изменении формата `index.json` править нужно оба.
pub fn adopt_local_file(
    source: PathBuf,
    extension: &str,
    id: &str,
    kind: &str,
    method: &str,
    title: &str,
    artist: Option<&str>,
    cover: Option<&str>,
) -> Result<SavedFile, String> {
    if !KINDS.contains(&kind) {
        return Err(format!("Неизвестный режим сохранения: {kind}"));
    }
    if !METHODS.contains(&method) {
        return Err(format!("Неизвестный способ сохранения: {method}"));
    }
    let dir = cache_dir()?;

    let new_file = file_name(id, kind, extension);
    let target = dir.join(&new_file);
    if kind == "download" {
        remove_cache_copies(&dir, id);
    }

    // Прежние записи об этом треке: их файлы больше не нужны, а флаг
    // «держу офлайн» переносим на новую копию — пользователь его не снимал.
    let mut kept_before = false;
    let mut records: Vec<OfflineRecord> = Vec::new();
    for record in read_index(&dir) {
        if same_track(&record.track_id, id) {
            kept_before = kept_before || record.kept || record.kind == "keep";
            if record.file != new_file {
                let _ = std::fs::remove_file(dir.join(&record.file));
            }
            continue;
        }
        records.push(record);
    }

    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    std::fs::rename(&source, &target).map_err(|e| {
        let _ = std::fs::remove_file(&source);
        format!("Не удалось сохранить файл: {e}")
    })?;

    let meta = std::fs::metadata(&target).map_err(|e| format!("Файл не сохранился: {e}"))?;
    if meta.len() == 0 {
        let _ = std::fs::remove_file(&target);
        return Err("Файл оказался пустым".into());
    }

    let tags = read_tags(&target);
    let stem = stem_of(&new_file).to_string();
    let tag_title = if tags.title == stem {
        display_stem(&stem)
    } else {
        tags.title.clone()
    };
    let clean_title = title.trim();
    let clean_artist = artist.map(str::trim).filter(|value| !value.is_empty());
    let clean_cover = cover.map(str::trim).filter(|value| !value.is_empty());

    let record = OfflineRecord {
        track_id: id.to_string(),
        file: new_file,
        kind: if kept_before { "keep".to_string() } else { kind.to_string() },
        base_kind: kind.to_string(),
        // Способ назвал тот, кто принёс файл: из режима его не вывести
        method: method.to_string(),
        kept: kept_before,
        saved_at: now_ms(),
        size: meta.len(),
        title: if clean_title.is_empty() {
            tag_title
        } else {
            clean_title.to_string()
        },
        artist: clean_artist
            .map(str::to_string)
            .or_else(|| tags.artist.clone()),
        album: tags.album.clone(),
        duration_ms: tags.duration_ms,
        cover: clean_cover
            .map(str::to_string)
            .or_else(|| tags.cover.clone()),
    };
    records.push(record.clone());
    let _ = write_index(&dir, &records);

    Ok(saved_file(&record, &dir, &meta))
}

/// То же, но в явно заданной папке: так логику можно проверить тестами.
fn save_in(
    dir: &Path,
    url: &str,
    id: &str,
    kind: &str,
    title: &str,
    artist: Option<&str>,
    cover: Option<&str>,
) -> Result<SavedFile, String> {
    let link = url.trim();
    if !link.starts_with("https://") && !link.starts_with("http://") {
        return Err("Ссылка должна начинаться с http:// или https://".into());
    }
    if !KINDS.contains(&kind) {
        return Err(format!("Неизвестный режим сохранения: {kind}"));
    }

    // Расширение станет известно только после ответа (в ссылке его может
    // не быть вовсе), поэтому сначала пишем во временный файл.
    let temp = dir.join(format!(
        "{}.{}.part",
        sanitize_id(id),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let content_type = match download_with_curl(link, &temp, true) {
        Ok(value) => value,
        // Через DoH не вышло (например, он недоступен) — пробуем обычный путь
        Err(doh_error) => download_with_curl(link, &temp, false).map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            format!("Не удалось скачать файл. Через DoH: {doh_error}. Обычным способом: {error}")
        })?,
    };

    // `prepared` — путь к готовому файлу (для HLS и для пересобранных потоков
    // он может быть иным, чем `temp`: муксер и ffmpeg пишут свой файл).
    let (prepared, extension) = if is_playlist(link, &content_type) {
        // HLS: сервис отдал плейлист и пачку сегментов, а не файл трека.
        // Скачиваемое уже лежит в `temp` — читаем его как текст плейлиста.
        let playlist = std::fs::read(&temp).map(|bytes| String::from_utf8_lossy(&bytes).to_string());
        let _ = std::fs::remove_file(&temp);
        let playlist =
            playlist.map_err(|e| format!("Не прочитался плейлист потока: {e}"))?;

        // Ошибку пересборки не оборачиваем: она сама называет формат потока,
        // а лишний префикс только прячет причину от пользователя
        download_hls(dir, link, &playlist, &temp, id)?
    } else {
        if looks_like_error_page(&content_type) {
            let _ = std::fs::remove_file(&temp);
            return Err(
                "SoundCloud отдал не файл, а страницу — офлайн-копию так не сохранить".into(),
            );
        }
        // Расширение берём из ссылки и content-type, но сначала смотрим на
        // сами байты: голый ADTS-AAC и MPEG-TS под именем `.m4a` не заиграют.
        let head = read_head(&temp, remux::PROBE_BYTES).map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            error
        })?;
        let format = stream_format(&head, link, &content_type);
        if matches!(format, StreamFormat::Adts | StreamFormat::MpegTs) {
            let rebuilt = rebuild_stream(&temp, &temp, format).map_err(|error| {
                let _ = std::fs::remove_file(&temp);
                error
            })?;
            // Если сработал запасной путь через ffmpeg, сырой поток не нужен
            if rebuilt.0 != temp {
                let _ = std::fs::remove_file(&temp);
            }
            rebuilt
        } else {
            (temp.clone(), pick_extension(link, &content_type))
        }
    };

    let new_file = file_name(id, kind, &extension);
    let target = dir.join(&new_file);
    // Настоящее скачивание вытесняет прежнюю временную копию того же трека
    if kind == "download" {
        remove_cache_copies(dir, id);
    }

    // Прежние записи об этом треке: их файлы больше не нужны, а флаг
    // «держу офлайн» переносим на новую копию — пользователь его не снимал.
    let mut kept_before = false;
    let mut records: Vec<OfflineRecord> = Vec::new();
    for record in read_index(dir) {
        if same_track(&record.track_id, id) {
            kept_before = kept_before || record.kept || record.kind == "keep";
            if record.file != new_file {
                let _ = std::fs::remove_file(dir.join(&record.file));
            }
            continue;
        }
        records.push(record);
    }

    // Повторное сохранение в том же режиме заменяет прежнюю копию
    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    std::fs::rename(&prepared, &target).map_err(|e| {
        let _ = std::fs::remove_file(&prepared);
        format!("Не удалось сохранить файл: {e}")
    })?;

    let meta = std::fs::metadata(&target).map_err(|e| format!("Файл не сохранился: {e}"))?;
    if meta.len() == 0 {
        let _ = std::fs::remove_file(&target);
        return Err("SoundCloud вернул пустой файл".into());
    }

    // Теги читаем и для карточки (альбом, длительность), и как запасные
    // метаданные: сервис мог не дать название или исполнителя. Это один раз на
    // только что скачанный файл, и результат остаётся в реестре — списку
    // (`list`) читать теги больше не нужно.
    let tags = read_tags(&target);
    let stem = stem_of(&new_file).to_string();
    let tag_title = if tags.title == stem {
        display_stem(&stem)
    } else {
        tags.title.clone()
    };
    let clean_title = title.trim();
    let clean_artist = artist.map(str::trim).filter(|value| !value.is_empty());
    let clean_cover = cover.map(str::trim).filter(|value| !value.is_empty());

    let record = OfflineRecord {
        track_id: id.to_string(),
        file: new_file,
        kind: if kept_before { "keep".to_string() } else { kind.to_string() },
        base_kind: kind.to_string(),
        // Режим известен точно: `download` — файл автора, `cache` — наш поток
        method: method_from_kind(kind, kind),
        kept: kept_before,
        saved_at: now_ms(),
        size: meta.len(),
        title: if clean_title.is_empty() {
            tag_title
        } else {
            clean_title.to_string()
        },
        artist: clean_artist
            .map(str::to_string)
            .or_else(|| tags.artist.clone()),
        album: tags.album.clone(),
        duration_ms: tags.duration_ms,
        cover: clean_cover
            .map(str::to_string)
            .or_else(|| tags.cover.clone()),
    };
    records.push(record.clone());
    // Сбой записи реестра не отменяет загрузку: файл на диске, а реестр
    // соберётся заново при первом чтении списка (см. sync_index).
    let _ = write_index(dir, &records);

    Ok(saved_file(&record, dir, &meta))
}

/// Догружает метаданные одной офлайн-копии: теги файла читаются один раз и
/// запоминаются в реестре. Нужно для записей, у которых метаданных ещё нет
/// (например, подхваченных у прошлой версии приложения), — список `list`
/// остаётся быстрым, а подробности подтягиваются отдельно и лениво.
pub fn meta(track_id: &str) -> Result<SavedFile, String> {
    let dir = cache_dir()?;
    meta_in(&dir, track_id)
}

fn meta_in(dir: &Path, track_id: &str) -> Result<SavedFile, String> {
    let mut records = sync_index(dir);
    let position = records
        .iter()
        .position(|record| same_track(&record.track_id, track_id))
        .ok_or_else(|| "Офлайн-копия этого трека не найдена".to_string())?;

    let file = records[position].file.clone();
    let path = dir.join(&file);
    let meta = std::fs::metadata(&path).map_err(|_| "Файл офлайн-копии уже удалён".to_string())?;
    if meta.len() == 0 {
        return Err("Файл офлайн-копии пуст".to_string());
    }

    let tags = read_tags(&path);
    let stem = stem_of(&file).to_string();
    let record = &mut records[position];

    let changed = merge_tags(record, &tags, &stem);
    let filled = record.clone();
    if changed {
        // Метаданные — вспомогательные: их сбой не должен ломать показ списка
        let _ = write_index(dir, &records);
    }
    Ok(saved_file(&filled, dir, &meta))
}

/// Дополняет запись реестра данными из тегов файла. Заполняется только пустое:
/// название, исполнитель и обложка из сервиса точнее тегов. Возвращает true,
/// если запись изменилась (тогда её нужно сохранить в реестр).
fn merge_tags(record: &mut OfflineRecord, tags: &player::TrackFile, stem: &str) -> bool {
    let mut changed = false;

    if record.title.trim().is_empty() {
        // read_track подставляет имя файла, если тегов нет: в имени есть
        // служебный хвост `__<режим>`, показывать его нельзя
        let title = if !tags.title.trim().is_empty() && tags.title != stem {
            tags.title.clone()
        } else {
            display_stem(stem)
        };
        if !title.is_empty() {
            record.title = title;
            changed = true;
        }
    }
    if record.artist.is_none() && tags.artist.is_some() {
        record.artist = tags.artist.clone();
        changed = true;
    }
    if record.album.is_none() && tags.album.is_some() {
        record.album = tags.album.clone();
        changed = true;
    }
    if record.duration_ms == 0 && tags.duration_ms > 0 {
        record.duration_ms = tags.duration_ms;
        changed = true;
    }
    if record.cover.is_none() && tags.cover.is_some() {
        record.cover = tags.cover.clone();
        changed = true;
    }
    changed
}

/// Список сохранённых файлов — свежие сверху. Читается только из реестра
/// `index.json` плюс дешёвая проверка, что файл на месте: теги файлов не
/// разбираются, иначе старт приложения читал бы диск по каждому треку.
pub fn list() -> Vec<SavedFile> {
    let Ok(dir) = cache_dir() else {
        return Vec::new();
    };
    list_in(&dir)
}

fn list_in(dir: &Path) -> Vec<SavedFile> {
    let mut files: Vec<SavedFile> = sync_index(dir)
        .iter()
        .filter_map(|record| describe_record(record, dir))
        .collect();

    files.sort_by(|a, b| b.saved_at_ms.cmp(&a.saved_at_ms));
    files
}

/// Помечает копию как «держу офлайн» (или снимает пометку). Файл не
/// переименовывается: меняется только запись в реестре, а исходный режим
/// остаётся в `baseKind` — к нему запись и возвращается.
pub fn set_kept(track_id: &str, kept: bool) -> Result<(), String> {
    let dir = cache_dir()?;
    set_kept_in(&dir, track_id, kept)
}

fn set_kept_in(dir: &Path, track_id: &str, kept: bool) -> Result<(), String> {
    let mut records = read_index(dir);
    let position = records
        .iter()
        .position(|record| same_track(&record.track_id, track_id))
        .ok_or_else(|| "Сохранённая копия этого трека не найдена".to_string())?;

    {
        let record = &mut records[position];
        if kept {
            // Исходный режим запоминаем до того, как поставим «keep»
            if record.kind != "keep" && KINDS.contains(&record.kind.as_str()) {
                record.base_kind = record.kind.clone();
            } else if !KINDS.contains(&record.base_kind.as_str()) {
                record.base_kind = DEFAULT_KIND.to_string();
            }
            record.kind = "keep".to_string();
            record.kept = true;
        } else {
            let base = if KINDS.contains(&record.base_kind.as_str()) {
                record.base_kind.clone()
            } else if KINDS.contains(&record.kind.as_str()) {
                record.kind.clone()
            } else {
                DEFAULT_KIND.to_string()
            };
            record.base_kind = base.clone();
            record.kind = base;
            record.kept = false;
        }
    }

    write_index(dir, &records)
}

/// Убирает временные офлайн-копии (`cache`) старше указанного числа дней.
/// Настоящие скачивания (`download`) и копии, которые просили держать
/// (`keep`), не трогает никогда. Возвращает число удалённых файлов.
pub fn cleanup(max_age_days: u64) -> usize {
    let Ok(dir) = cache_dir() else {
        return 0;
    };
    cleanup_in(&dir, max_age_days)
}

fn cleanup_in(dir: &Path, max_age_days: u64) -> usize {
    let max_age_ms = max_age_days.saturating_mul(24 * 60 * 60 * 1000);
    let now = now_ms();
    let mut keep: Vec<OfflineRecord> = Vec::new();
    let mut removed = 0usize;

    for record in sync_index(dir) {
        let age = now.saturating_sub(record.saved_at);
        let is_old_cache = record.kind == "cache" && !record.kept && age >= max_age_ms;
        if is_old_cache {
            let _ = std::fs::remove_file(dir.join(&record.file));
            removed += 1;
            continue;
        }
        keep.push(record);
    }

    if removed > 0 {
        let _ = write_index(dir, &keep);
    }
    removed
}

/// Сколько занимают офлайн-файлы и сколько свободно на диске.
pub fn stats() -> (u64, u64) {
    let Ok(dir) = cache_dir() else {
        return (0, 0);
    };
    (total_bytes(&dir), free_bytes(&dir))
}

/// Суммарный размер офлайн-файлов по реестру.
fn total_bytes(dir: &Path) -> u64 {
    sync_index(dir)
        .iter()
        .filter_map(|record| std::fs::metadata(dir.join(&record.file)).ok())
        .map(|meta| meta.len())
        .sum()
}

/// Буква диска, на котором лежит папка кеша (`C`). Для путей без буквы
/// (например, сетевых) считаем системный диск — свободное место всё равно
/// нужно показать хоть какое-то.
fn volume_root(dir: &Path) -> String {
    let text = dir.to_string_lossy().to_string();
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic() => letter.to_ascii_uppercase().to_string(),
        _ => "C".to_string(),
    }
}

/// Число байт из ответа системы. Форматы разные: PowerShell отдаёт просто
/// число, wmic — «FreeSpace=123», fsutil — «Всего свободных байт : 123 456».
/// Поэтому берём первую строку с цифрами и склеиваем цифры только из неё.
fn parse_free_bytes(text: &str) -> Option<u64> {
    text.lines()
        .map(|line| line.chars().filter(|c| c.is_ascii_digit()).collect::<String>())
        .find(|digits| !digits.is_empty())
        .and_then(|digits| digits.parse::<u64>().ok())
}

/// Свободное место на диске с папкой кеша. Стандартная библиотека этого не
/// умеет, поэтому спрашиваем систему по очереди тремя способами: PowerShell
/// (есть на любой Windows), wmic и fsutil. Ноль — «узнать не удалось»,
/// интерфейс в этом случае просто не показывает цифру.
fn free_bytes(dir: &Path) -> u64 {
    let root = volume_root(dir);
    let attempts: [(&str, [String; 5]); 3] = [
        (
            "powershell",
            [
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                format!("(Get-PSDrive -Name {root}).Free"),
                String::new(),
            ],
        ),
        (
            "wmic",
            [
                "logicaldisk".into(),
                "where".into(),
                format!("DeviceID='{root}:'"),
                "get".into(),
                "FreeSpace".into(),
            ],
        ),
        (
            "fsutil",
            [
                "volume".into(),
                "diskfree".into(),
                format!("{root}:"),
                String::new(),
                String::new(),
            ],
        ),
    ];

    for (program, args) in attempts {
        let mut command = crate::silent::hidden(program);
        for arg in args.iter().filter(|value| !value.is_empty()) {
            command.arg(arg);
        }
        let Ok(output) = command.output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        if let Some(bytes) = parse_free_bytes(&String::from_utf8_lossy(&output.stdout)) {
            return bytes;
        }
    }
    0
}

/// Проверяет, что файл лежит внутри папки кеша, и возвращает канонический путь.
/// Сравниваются именно канонические пути: так не обмануть удаление ни «..»,
/// ни символической ссылкой внутри кеша.
fn checked_path(dir: &Path, path: &str) -> Result<PathBuf, String> {
    const NOT_OURS: &str = "Этот файл не из папки офлайн-треков — удалять его нельзя";

    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Не читается папка офлайн-треков: {e}"))?;
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|_| "Файл уже удалён или недоступен".to_string())?;

    if canonical == canonical_dir || !canonical.starts_with(&canonical_dir) {
        return Err(NOT_OURS.into());
    }
    Ok(canonical)
}

/// Удаляет сохранённый файл с диска. Удалять можно только то, что лежит
/// в папке офлайн-треков: иначе команда стирала бы любой файл в системе.
/// Запись из реестра тоже уходит — иначе список показывал бы призрак.
pub fn remove(path: &str) -> Result<(), String> {
    let dir = cache_dir()?;
    let target = checked_path(&dir, path)?;
    std::fs::remove_file(&target).map_err(|e| format!("Не удалось удалить файл: {e}"))?;

    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let records = read_index(&dir);
    if records.iter().any(|record| record.file == name) {
        let next: Vec<OfflineRecord> = records
            .into_iter()
            .filter(|record| record.file != name)
            .collect();
        let _ = write_index(&dir, &next);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Отдельная временная папка под каждый тест: тесты идут параллельно.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("music_hub_downloads_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("не создалась временная папка");
        dir
    }

    /// Файл-пустышка: содержимое не аудио, но размер не нулевой.
    fn dummy(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"audio-bytes").unwrap();
        path
    }

    fn record(track_id: &str, file: &str, kind: &str, saved_at: u64) -> OfflineRecord {
        let base_kind = if kind == "keep" { "cache" } else { kind }.to_string();
        OfflineRecord {
            track_id: track_id.to_string(),
            file: file.to_string(),
            kind: kind.to_string(),
            base_kind: base_kind.clone(),
            method: method_from_kind(kind, &base_kind),
            kept: kind == "keep",
            saved_at,
            size: 11,
            title: format!("Трек {track_id}"),
            artist: Some("Артист".into()),
            album: Some("Альбом".into()),
            duration_ms: 180_000,
            cover: None,
        }
    }

    /// Сколько раз в этом потоке читались теги файлов.
    fn tag_reads() -> usize {
        TAG_READS.with(|counter| counter.get())
    }

    /// Минимальный поток ADTS-AAC: ровно то, что приходит сегментами HLS.
    /// Годится и для проверки определения формата, и для пересборки в M4A.
    fn adts_bytes(count: usize) -> Vec<u8> {
        let mut stream = Vec::new();
        for index in 0..count {
            let payload = vec![index as u8; 64];
            let frame_len = 7 + payload.len();
            let mut frame = vec![0xFF, 0xF1, (1 << 6) | (4 << 2), 0x00, 0x00, 0x1F, 0xFC];
            frame[3] = (((frame_len >> 11) as u8) & 0x03) | (2 << 6);
            frame[4] = ((frame_len >> 3) & 0xFF) as u8;
            frame[5] = (((frame_len & 0x07) as u8) << 5) | 0x1F;
            frame.extend_from_slice(&payload);
            stream.extend_from_slice(&frame);
        }
        stream
    }

    #[test]
    fn unsafe_ids_become_safe_file_names() {
        assert_eq!(sanitize_id("123456789"), "123456789");
        assert_eq!(sanitize_id("soundcloud-77"), "soundcloud-77");
        // Разделители путей и точки не переживают очистку
        assert_eq!(sanitize_id("../../evil"), "evil");
        assert_eq!(sanitize_id(".."), "track");
        assert_eq!(sanitize_id(""), "track");
        assert_eq!(sanitize_id("C:\\Windows\\system32"), "C__Windows_system32");
        assert!(!sanitize_id("a/../b").contains('/'));
        assert!(!sanitize_id("a/../b").contains(".."));
        // Двоеточие сервисного id не ломает имя файла
        assert_eq!(sanitize_id("soundcloud:123"), "soundcloud_123");
        // Длинный идентификатор обрезается, а не ломает путь
        assert_eq!(sanitize_id(&"a".repeat(500)).len(), MAX_STEM);
    }

    #[test]
    fn kind_is_read_back_from_file_name() {
        let downloaded = file_name("soundcloud-1", "download", "mp3");
        assert_eq!(downloaded, "soundcloud-1__download.mp3");
        assert_eq!(kind_from_name(&downloaded), "download");

        let cached = file_name("77", "cache", "m4a");
        assert_eq!(kind_from_name(&cached), "cache");

        // Незнакомый хвост — считаем временной копией, а не скачиванием
        assert_eq!(kind_from_name("track.mp3"), "cache");
        assert_eq!(kind_from_name("a__weird.mp3"), "cache");
        // Режим берётся из последнего разделителя
        assert_eq!(kind_from_name("a__download__cache.mp3"), "cache");
        // Но «подхватывать» в реестр можно только явные имена
        assert_eq!(kind_from_name_opt("track.mp3"), None);
        assert_eq!(kind_from_name_opt("index.json"), None);
        assert_eq!(kind_from_name_opt("a__weird.mp3"), None);
        assert_eq!(kind_from_name_opt("a__keep.mp3"), Some("keep".to_string()));
    }

    #[test]
    fn service_ids_match_across_separators() {
        // «soundcloud:123» из очереди и «soundcloud-123» из старого имени файла
        assert!(same_track("soundcloud:123", "soundcloud-123"));
        assert!(same_track("soundcloud:123", "soundcloud_123"));
        assert!(same_track("soundcloud:123", "soundcloud:123"));
        assert!(!same_track("soundcloud:123", "soundcloud:124"));
        // Пустые идентификаторы ни с чем не совпадают
        assert!(!same_track("", ""));
        assert!(!same_track("", "soundcloud:123"));
    }

    #[test]
    fn service_tail_is_hidden_in_fallback_title() {
        assert_eq!(display_stem("soundcloud-123__cache"), "soundcloud-123");
        assert_eq!(display_stem("soundcloud-123__download.mp3"), "soundcloud-123");
        assert_eq!(display_stem("обычный трек"), "обычный трек");
    }

    #[test]
    fn extension_comes_from_url_or_content_type() {
        // Ссылка: расширение берём из пути, а не из query
        assert_eq!(pick_extension("https://x/y/file.mp3?client_id=1", ""), "mp3");
        assert_eq!(pick_extension("https://x/y/file.m4a#part", ""), "m4a");
        // В ссылке расширения нет — смотрим content-type
        assert_eq!(pick_extension("https://x/y/stream?x=1", "audio/mp4"), "m4a");
        assert_eq!(pick_extension("https://x/y/stream", "audio/mpeg; charset=utf-8"), "mp3");
        assert_eq!(pick_extension("https://x/y/stream", "audio/ogg"), "ogg");
        assert_eq!(pick_extension("https://x/y/stream", "audio/x-wav"), "wav");
        // Ничего не подсказало формат — запасной mp3
        assert_eq!(pick_extension("https://x/y/stream", "application/octet-stream"), "mp3");
        assert_eq!(pick_extension("https://x/y/file.pdf", "audio/mpeg"), "mp3");
        // Похожее на расширение имя файла не должно обмануть
        assert_eq!(pick_extension("https://x/y/track.mp3.exe", ""), "mp3");
    }

    #[test]
    fn playlists_and_error_pages_are_rejected() {
        // HLS-плейлист: сохранённый как трек, он не заиграет
        assert!(is_playlist("https://cf-hls-media.sndcdn.com/playlist.m3u8?x=1", ""));
        assert!(is_playlist("https://x/y/stream", "application/vnd.apple.mpegurl"));
        assert!(!is_playlist("https://cf-media.sndcdn.com/track.mp3", "audio/mpeg"));

        assert!(looks_like_error_page("text/html; charset=utf-8"));
        assert!(looks_like_error_page("application/json"));
        assert!(looks_like_error_page("application/problem+json"));
        assert!(looks_like_error_page("text/xml"));
        // Аудио и неизвестные типы принимаем: лишний отказ хуже, чем попытка
        assert!(!looks_like_error_page("audio/mpeg"));
        assert!(!looks_like_error_page("application/octet-stream"));
        assert!(!looks_like_error_page(""));
    }

    #[test]
    fn master_playlist_is_recognized_and_best_bandwidth_wins() {
        let text = concat!(
            "#EXTM3U\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS=\"mp4a.40.2\"\n",
            "low/playlist.m3u8\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=256000,RESOLUTION=640x360\n",
            "https://cdn.example.com/high/playlist.m3u8\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=128000\n",
            "mid/playlist.m3u8\n",
        );
        let parsed = parse_playlist(text, "https://cdn.example.com/hls/master.m3u8").unwrap();
        match parsed {
            ParsedPlaylist::Master(variants) => {
                assert_eq!(variants.len(), 3, "вариантов должно быть три: {variants:?}");
                // Запятая внутри CODECS не должна ломать разбор BANDWIDTH
                assert_eq!(variants[0].bandwidth, 64_000);
                assert_eq!(variants[1].bandwidth, 256_000);
                // Относительные ссылки разрешаются от адреса плейлиста
                assert_eq!(variants[0].url, "https://cdn.example.com/hls/low/playlist.m3u8");
                assert_eq!(variants[2].url, "https://cdn.example.com/hls/mid/playlist.m3u8");
                // Абсолютная остаётся как есть
                assert_eq!(variants[1].url, "https://cdn.example.com/high/playlist.m3u8");

                let best = best_variant(&variants).unwrap();
                assert_eq!(best.bandwidth, 256_000, "должен победить лучший битрейт");
                assert_eq!(best.url, "https://cdn.example.com/high/playlist.m3u8");
            }
            other => panic!("ожидали master-плейлист, получили {other:?}"),
        }

        // Единственный вариант без BANDWIDTH тоже принимается
        let single = parse_playlist(
            "#EXTM3U\n#EXT-X-STREAM-INF:NAME=\"a\"\nonly/playlist.m3u8\n",
            "https://cdn.example.com/hls/master.m3u8",
        )
        .unwrap();
        match single {
            ParsedPlaylist::Master(variants) => {
                assert_eq!(variants.len(), 1);
                assert_eq!(variants[0].bandwidth, 0);
            }
            other => panic!("ожидали master-плейлист, получили {other:?}"),
        }
    }

    #[test]
    fn media_playlist_is_recognized_with_init_and_relative_links() {
        let text = concat!(
            "#EXTM3U\n",
            "#EXT-X-VERSION:7\n",
            "#EXT-X-TARGETDURATION:4\n",
            "#EXT-X-MAP:URI=\"init.mp4\"\n",
            "#EXTINF:4.0,\n",
            "seg-1.m4s\n",
            "#EXTINF:4.0,\n",
            "https://other.example.com/abs/seg-2.m4s?token=1\n",
            "#EXT-X-ENDLIST\n",
        );
        let parsed = parse_playlist(
            text,
            "https://cf-hls-media.sndcdn.com/media/12/34/playlist.m3u8?client_id=abc",
        )
        .unwrap();
        match parsed {
            ParsedPlaylist::Media(media) => {
                assert_eq!(
                    media.init.as_deref(),
                    Some("https://cf-hls-media.sndcdn.com/media/12/34/init.mp4"),
                    "init-сегмент из EXT-X-MAP должен быть разрешён от плейлиста"
                );
                assert_eq!(
                    media.segments,
                    vec![
                        "https://cf-hls-media.sndcdn.com/media/12/34/seg-1.m4s".to_string(),
                        "https://other.example.com/abs/seg-2.m4s?token=1".to_string(),
                    ],
                    "сегменты должны идти по порядку и без параметров плейлиста"
                );
            }
            other => panic!("ожидали media-плейлист, получили {other:?}"),
        }

        // Плейлиста без EXT-X-MAP: init-сегмента просто нет
        let without_map = parse_playlist(
            "#EXTM3U\n#EXTINF:10,\nchunk.ts\n#EXT-X-ENDLIST\n",
            "https://cdn.example.com/a/playlist.m3u8",
        )
        .unwrap();
        match without_map {
            ParsedPlaylist::Media(media) => {
                assert_eq!(media.init, None);
                assert_eq!(media.segments, vec!["https://cdn.example.com/a/chunk.ts".to_string()]);
            }
            other => panic!("ожидали media-плейлист, получили {other:?}"),
        }
    }

    #[test]
    fn playlist_links_resolve_against_the_playlist_address() {
        let base = "https://cdn.example.com/media/1/2/playlist.m3u8?x=1";
        // Ссылка рядом с плейлистом
        assert_eq!(
            resolve_url(base, "seg.ts"),
            "https://cdn.example.com/media/1/2/seg.ts"
        );
        // От корня хоста
        assert_eq!(
            resolve_url(base, "/root/seg.ts"),
            "https://cdn.example.com/root/seg.ts"
        );
        // Схема-относительная
        assert_eq!(
            resolve_url(base, "//other.example.com/seg.ts"),
            "https://other.example.com/seg.ts"
        );
        // Абсолютная не трогается
        assert_eq!(
            resolve_url(base, "http://plain.example.com/seg.ts"),
            "http://plain.example.com/seg.ts"
        );
        // Уже папка: «..» не разбираем, но склейка не теряет слэш
        assert_eq!(
            resolve_url("https://cdn.example.com/media/1/", "sub/seg.ts"),
            "https://cdn.example.com/media/1/sub/seg.ts"
        );
        // Хост без пути
        assert_eq!(resolve_url("https://cdn.example.com", "seg.ts"), "https://cdn.example.com/seg.ts");
        // Пустая ссылка не превращается в битый адрес
        assert_eq!(resolve_url(base, "   "), "");
    }

    #[test]
    fn garbage_is_not_a_playlist() {
        let base = "https://cdn.example.com/playlist.m3u8";
        // Пусто и один заголовок без сегментов
        assert!(parse_playlist("", base).is_err());
        assert!(parse_playlist("   \n\n", base).is_err());
        assert!(parse_playlist("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n", base).is_err());
        // Страница ошибки вместо плейлиста
        let html = "<!DOCTYPE html>\n<html><body>Not found</body></html>";
        assert!(parse_playlist(html, base).is_err(), "HTML не должен стать сегментом");
        // Просто текст без тегов HLS
        assert!(parse_playlist("просто текст\nещё одна строка", base).is_err());
        // Ссылка без тега media — тоже не плейлист
        assert!(parse_playlist("seg-1.m4s\nseg-2.m4s", base).is_err());
    }

    #[test]
    fn stream_format_comes_from_bytes_before_the_link() {
        // Подсказка по ссылке и content-type
        assert_eq!(stream_kind_of("https://x/seg.ts", ""), StreamFormat::MpegTs);
        assert_eq!(stream_kind_of("https://x/seg", "video/mp2t"), StreamFormat::MpegTs);
        assert_eq!(stream_kind_of("https://x/seg.m4s", "video/mp4"), StreamFormat::Mp4);
        assert_eq!(stream_kind_of("https://x/seg", "audio/mp4"), StreamFormat::Mp4);
        assert_eq!(stream_kind_of("https://x/init.mp4?x=1", ""), StreamFormat::Mp4);
        assert_eq!(stream_kind_of("https://x/seg.aac", ""), StreamFormat::Adts);
        assert_eq!(stream_kind_of("https://x/seg", "audio/aac"), StreamFormat::Adts);
        assert_eq!(stream_kind_of("https://x/seg.mp3", ""), StreamFormat::Mp3);
        assert_eq!(
            stream_kind_of("https://x/seg", "application/octet-stream"),
            StreamFormat::Unknown
        );

        // fMP4: box «ftyp» с длиной в первых четырёх байтах
        let mut mp4 = vec![0u8, 0, 0, 0x20];
        mp4.extend_from_slice(b"ftypM4A ");
        assert_eq!(stream_format(&mp4, "https://x/seg", ""), StreamFormat::Mp4);
        // Голый ADTS в сегменте с именем `.m4s`: верим байтам, а не имени
        let adts = adts_bytes(3);
        assert_eq!(
            stream_format(&adts, "https://x/seg.m4s", "video/mp4"),
            StreamFormat::Adts
        );
        // MPEG-TS: пакеты по 188 байт, каждый начинается с 0x47
        let mut ts = vec![0u8; 3 * 188];
        ts[0] = 0x47;
        ts[188] = 0x47;
        ts[376] = 0x47;
        assert_eq!(stream_format(&ts, "https://x/seg", ""), StreamFormat::MpegTs);
        // Байты ничего не сказали — берём подсказку из ссылки
        assert_eq!(
            stream_format(b"", "https://x/seg.ts", "video/mp2t"),
            StreamFormat::MpegTs
        );
        assert_eq!(
            stream_format(b"\x00\x00\x00\x00", "https://x/seg", ""),
            StreamFormat::Unknown
        );
    }

    #[test]
    fn rebuild_turns_adts_stream_into_playable_m4a() {
        let dir = temp_dir("rebuild-adts");
        let raw = dir.join("soundcloud_1.7.hls.raw");
        std::fs::write(&raw, adts_bytes(4)).unwrap();
        let target = dir.join("soundcloud_1.7.part");

        let (prepared, extension) = rebuild_stream(&raw, &target, StreamFormat::Adts).unwrap();
        assert_eq!(prepared, target, "готовый файл лежит по пути target");
        assert_eq!(extension, "m4a");

        let bytes = std::fs::read(&target).unwrap();
        assert_eq!(&bytes[4..8], &b"ftyp"[..], "на выходе настоящий MP4");
        assert!(bytes.len() > 4 * 71, "кадры не потерялись: {} байт", bytes.len());
        // Служебной заготовки рядом не остаётся
        assert!(!dir.join("soundcloud_1.7.muxed").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rebuild_names_the_format_when_it_cannot_build() {
        let dir = temp_dir("rebuild-broken");
        let raw = dir.join("broken.3.hls.raw");
        std::fs::write(&raw, "это не поток, а просто текст".as_bytes()).unwrap();
        let target = dir.join("broken.3.part");

        let error = rebuild_stream(&raw, &target, StreamFormat::MpegTs).unwrap_err();
        assert!(
            error.starts_with("Не удалось собрать поток в играемый файл: MPEG-TS"),
            "получили: {error}"
        );
        assert!(!target.exists(), "неудача не должна оставлять готовый файл");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn head_reading_stops_at_the_limit_and_at_the_end() {
        let dir = temp_dir("read-head");
        let path = dir.join("stream.bin");
        std::fs::write(&path, [7u8; 300]).unwrap();

        let head = read_head(&path, remux::PROBE_BYTES).unwrap();
        assert_eq!(head.len(), 300, "короткий файл читается целиком");
        let head = read_head(&path, 16).unwrap();
        assert_eq!(head.len(), 16, "длинный файл читается только до лимита");
        assert!(head.iter().all(|byte| *byte == 7));
        // Отсутствующий файл — понятная ошибка, а не паника
        assert!(read_head(&dir.join("нет.bin"), 8).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn encrypted_playlists_are_rejected() {
        // Зашифрованные сегменты без ключа склеятся в мусор: честнее отказать
        let encrypted = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://x/key\"\n#EXTINF:4,\nseg1.ts\n";
        assert!(parse_playlist(encrypted, "https://cdn.example.com/p.m3u8").is_err());

        // METHOD=NONE — это открытый поток, его принимаем
        let clear = "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\nseg1.ts\n";
        match parse_playlist(clear, "https://cdn.example.com/p.m3u8").unwrap() {
            ParsedPlaylist::Media(media) => assert_eq!(media.segments.len(), 1),
            other => panic!("ожидали media-плейлист, получили {other:?}"),
        }
    }

    #[test]
    fn playlists_with_byte_ranges_are_rejected() {
        // Кусок файла вместо сегмента: скачав адрес целиком, получили бы склейку
        // не того, что просили, — честнее отказать
        let ranged = concat!(
            "#EXTM3U\n",
            "#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"\n",
            "#EXTINF:4,\n",
            "#EXT-X-BYTERANGE:128000@720\n",
            "seg.mp4\n",
        );
        let error = parse_playlist(ranged, "https://cdn.example.com/p.m3u8").unwrap_err();
        assert!(error.contains("BYTERANGE"), "получили: {error}");

        // Обычный плейлист с BYTERANGE только в MAP тоже не поддержан
        let map_range = concat!(
            "#EXTM3U\n",
            "#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"\n",
            "#EXTINF:4,\n",
            "seg.mp4\n",
        );
        assert!(parse_playlist(map_range, "https://cdn.example.com/p.m3u8").is_err());
    }

    #[test]
    fn hls_limits_cover_too_many_segments_and_empty_media() {
        // Много сегментов собираем текстом: разбор обязан пройти, предел
        // проверяется уже в download_hls, поэтому здесь только факт разбора.
        let mut text = String::from("#EXTM3U\n");
        for index in 0..(HLS_MAX_SEGMENTS + 5) {
            text.push_str(&format!("#EXTINF:1.0,\nseg-{index}.m4s\n"));
        }
        match parse_playlist(&text, "https://cdn.example.com/p.m3u8").unwrap() {
            ParsedPlaylist::Media(media) => {
                assert_eq!(media.segments.len(), HLS_MAX_SEGMENTS + 5);
                assert!(media.segments.len() > HLS_MAX_SEGMENTS);
            }
            other => panic!("ожидали media-плейлист, получили {other:?}"),
        }
    }

    #[test]
    fn index_is_written_and_read_back_as_camel_case() {
        let dir = temp_dir("index-round-trip");
        let first = record("soundcloud:1", "soundcloud_1__cache.mp3", "cache", 1_700_000_000_000);
        let second = OfflineRecord {
            kept: true,
            kind: "keep".to_string(),
            base_kind: "download".to_string(),
            title: "Второй".to_string(),
            artist: None,
            cover: Some("https://i1.sndcdn.com/art.jpg".to_string()),
            ..record("soundcloud:2", "soundcloud_2__download.m4a", "download", 1_700_000_100_000)
        };

        write_index(&dir, &[first.clone(), second.clone()]).unwrap();
        let raw = std::fs::read_to_string(index_path(&dir)).unwrap();
        // Файл должен читаться без переименований: поля в camelCase
        assert!(raw.contains("\"trackId\""), "нет trackId в {raw}");
        assert!(raw.contains("\"baseKind\""), "нет baseKind в {raw}");
        assert!(raw.contains("\"method\""), "нет method в {raw}");
        assert!(raw.contains("\"savedAt\""), "нет savedAt в {raw}");
        assert!(raw.contains("\"kept\""), "нет kept в {raw}");

        let back = read_index(&dir);
        assert_eq!(back, vec![first, second]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_index_is_ignored_and_unknown_fields_are_defaulted() {
        let dir = temp_dir("index-broken");
        std::fs::write(index_path(&dir), "{ это не json").unwrap();
        assert!(read_index(&dir).is_empty(), "битый реестр должен читаться как пустой");

        // Минимальная запись: режим и флаг выводятся из того, что есть
        std::fs::write(
            index_path(&dir),
            r#"[
                {"trackId":"soundcloud:7","file":"soundcloud_7__cache.mp3","kind":"keep"},
                {"trackId":"soundcloud:8","file":"soundcloud_8__cache.mp3","kind":"непонятно","baseKind":"keep","kept":true},
                {"trackId":"","file":"ghost.mp3"},
                {"trackId":"soundcloud:9","file":"../escape.mp3"}
            ]"#,
        )
        .unwrap();

        let records = read_index(&dir);
        assert_eq!(records.len(), 2);
        // «keep» без явного флага всё равно означает «держу офлайн»
        assert_eq!(records[0].kind, "keep");
        assert!(records[0].kept);
        assert_eq!(records[0].base_kind, "cache");
        assert_eq!(records[0].saved_at, 0);
        // Неизвестный режим превращается в кеш, а не в пустое состояние
        assert_eq!(records[1].kind, "keep");
        assert_eq!(records[1].base_kind, "cache");
        // Записи без id, без файла или с выходом из папки отбрасываются
        assert!(records.iter().all(|item| !item.track_id.is_empty()));
        assert!(records.iter().all(|item| !item.file.contains("..")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn method_follows_the_mode_and_never_stays_unknown() {
        // Режим известен точно: `download` — файл автора, `cache` — наш поток
        assert_eq!(method_from_kind("download", "download"), "download");
        assert_eq!(method_from_kind("cache", "cache"), "stream");
        // «Держу офлайн» исходный режим помнит в `baseKind`
        assert_eq!(method_from_kind("keep", "download"), "download");
        assert_eq!(method_from_kind("keep", "cache"), "stream");
        // Названный вызывающим способ не подменяется, а чужой выводится из режима
        assert_eq!(normalize_method("external", "cache", "cache"), "external");
        assert_eq!(normalize_method("import", "cache", "cache"), "import");
        assert_eq!(normalize_method("", "download", "download"), "download");
        assert_eq!(normalize_method("чужое", "cache", "cache"), "stream");
    }

    #[test]
    fn records_without_method_get_it_from_their_kind() {
        // Реестр прошлой версии: поля `method` в записях нет вовсе, а у
        // подхваченного с диска файла способ виден только по режиму из имени.
        let dir = temp_dir("method-legacy");
        dummy(&dir, "soundcloud_1__download.mp3");
        dummy(&dir, "soundcloud_2__cache.mp3");
        dummy(&dir, "soundcloud_9__cache.mp3");
        dummy(&dir, "soundcloud-3__keep.m4a");
        std::fs::write(
            index_path(&dir),
            r#"[
                {"trackId":"soundcloud:1","file":"soundcloud_1__download.mp3","kind":"download"},
                {"trackId":"soundcloud:2","file":"soundcloud_2__cache.mp3","kind":"cache"},
                {"trackId":"soundcloud:9","file":"soundcloud_9__cache.mp3","kind":"cache","method":"чепуха"}
            ]"#,
        )
        .unwrap();

        let files = list_in(&dir);
        let method_of = |id: &str| {
            files
                .iter()
                .find(|file| file.track_id == id)
                .unwrap_or_else(|| panic!("в списке нет {id}: {files:?}"))
                .method
                .clone()
        };
        assert_eq!(method_of("soundcloud:1"), "download", "старое скачивание остаётся скачиванием");
        assert_eq!(method_of("soundcloud:2"), "stream", "офлайн-копия — это наш поток");
        assert_eq!(method_of("soundcloud-3"), "stream", "подхваченный keep — это наш поток");
        assert_eq!(method_of("soundcloud:9"), "stream", "чужой способ выводим из режима");

        // В реестре способ уже записан: интерфейсу не придётся угадывать
        let stored = read_index(&dir);
        assert!(stored.iter().any(|item| item.track_id == "soundcloud:1" && item.method == "download"));
        assert!(stored.iter().all(|item| METHODS.contains(&item.method.as_str())));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn known_method_survives_and_unknown_is_rejected_on_adopt() {
        // Способ, названный вызывающим, не подменяется режимом
        let dir = temp_dir("method-known");
        std::fs::write(
            index_path(&dir),
            r#"[{"trackId":"soundcloud:1","file":"soundcloud_1__cache.mp3","kind":"cache","method":"external"}]"#,
        )
        .unwrap();
        assert_eq!(read_index(&dir)[0].method, "external");

        // Чужой способ отсекаем до любой работы с диском: реестр не должен
        // получить значение, которого интерфейс не знает
        let error = adopt_local_file(
            PathBuf::from("нет-такого-файла.part"),
            "mp3",
            "soundcloud:1",
            "cache",
            "как-то-иначе",
            "Трек",
            None,
            None,
        )
        .unwrap_err();
        assert!(error.contains("способ"), "получили: {error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn listing_drops_records_without_files() {
        let dir = temp_dir("index-missing");
        dummy(&dir, "soundcloud_1__cache.mp3");
        write_index(
            &dir,
            &[
                record("soundcloud:1", "soundcloud_1__cache.mp3", "cache", 1_700_000_000_000),
                record("soundcloud:2", "soundcloud_2__cache.mp3", "cache", 1_700_000_000_000),
            ],
        )
        .unwrap();

        let files = list_in(&dir);
        assert_eq!(files.len(), 1, "запись без файла не должна попадать в список");
        assert_eq!(files[0].track_id, "soundcloud:1");
        assert_eq!(files[0].kind, "cache");
        assert_eq!(files[0].size, 11);
        assert!(files[0].saved_at.starts_with("2023-11-14"));

        // И из реестра запись-призрак тоже уходит
        let left = read_index(&dir);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].track_id, "soundcloud:1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn files_missing_from_index_are_adopted() {
        let dir = temp_dir("index-adopt");
        dummy(&dir, "soundcloud-5__cache.mp3");
        dummy(&dir, "soundcloud-6__download.m4a");
        // Не наш формат: служебные файлы и случайные имена не подхватываем
        std::fs::write(dir.join("index.json"), b"[]").unwrap();
        std::fs::write(dir.join("note.txt"), b"note").unwrap();
        std::fs::write(dir.join("soundcloud-7.3.part"), b"part").unwrap();

        let files = list_in(&dir);
        assert_eq!(files.len(), 2, "подхватились не все файлы: {files:?}");
        let ids: Vec<&str> = files.iter().map(|file| file.track_id.as_str()).collect();
        assert!(ids.contains(&"soundcloud-5"), "нет скачанного из старой версии: {ids:?}");
        assert!(ids.contains(&"soundcloud-6"), "нет скачанного из старой версии: {ids:?}");
        assert!(files.iter().all(|file| !file.file_name.ends_with(".part")));
        assert!(files.iter().all(|file| file.file_name != "note.txt"));

        // Реестр перезаписан: в следующий раз подхватывать уже нечего
        let stored = read_index(&dir);
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().any(|item| item.file == "soundcloud-5__cache.mp3"));
        assert!(stored.iter().any(|item| item.kind == "download"));
        // Способ у подхваченного скачивания — «download»: он виден по режиму
        assert!(stored
            .iter()
            .any(|item| item.kind == "download" && item.method == "download"));

        // Идентификатор из очереди находит такую запись
        assert!(stored.iter().any(|item| same_track(&item.track_id, "soundcloud:5")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn listing_never_reads_file_tags() {
        let dir = temp_dir("list-fast");
        dummy(&dir, "soundcloud_1__cache.mp3");
        dummy(&dir, "soundcloud-2__cache.mp3");
        write_index(
            &dir,
            &[record("soundcloud:1", "soundcloud_1__cache.mp3", "cache", now_ms())],
        )
        .unwrap();

        let files = list_in(&dir);
        assert_eq!(files.len(), 2);
        assert_eq!(tag_reads(), 0, "list() не должен читать теги файлов: это тяжёлый диск I/O");

        // Метаданные берутся из реестра, а у подхваченного файла их ещё нет
        let stored = files.iter().find(|file| file.track_id == "soundcloud:1").unwrap();
        assert_eq!(stored.title, "Трек soundcloud:1");
        assert_eq!(stored.album.as_deref(), Some("Альбом"));
        assert_eq!(stored.duration_ms, 180_000);

        let adopted = files.iter().find(|file| file.track_id == "soundcloud-2").unwrap();
        assert_eq!(adopted.title, "soundcloud-2", "служебный хвост не показываем");
        assert!(adopted.album.is_none());
        assert_eq!(adopted.duration_ms, 0, "ноль означает «метаданные ещё не читали»");
        // И он уже в реестре: второй раз подхватывать нечего
        assert!(read_index(&dir).iter().any(|item| item.track_id == "soundcloud-2"));

        // Отдельный запрос метаданных — вот он читает теги, и ровно один раз
        let enriched = meta_in(&dir, "soundcloud-2").unwrap();
        assert_eq!(tag_reads(), 1, "метаданные читаются по явному запросу и один раз");
        assert_eq!(enriched.track_id, "soundcloud-2");
        assert!(read_index(&dir).iter().any(|item| item.title == "soundcloud-2"));

        // Неизвестный трек — понятная ошибка, а не паника
        let error = meta_in(&dir, "soundcloud:404").unwrap_err();
        assert!(error.contains("не найдена"), "получили: {error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_tags_fills_only_missing_fields() {
        let tags = player::TrackFile {
            path: "C:\\cache\\soundcloud_7__cache.mp3".into(),
            file_name: "soundcloud_7__cache.mp3".into(),
            title: "Настоящее название".into(),
            artist: Some("Исполнитель из тегов".into()),
            album: Some("Альбом из тегов".into()),
            duration_ms: 210_000,
            cover: Some("C:\\covers\\a.jpg".into()),
        };

        // Пустая запись: заполняется из тегов
        let mut empty = OfflineRecord {
            track_id: "soundcloud:7".into(),
            file: "soundcloud_7__cache.mp3".into(),
            kind: "cache".into(),
            base_kind: "cache".into(),
            method: "stream".into(),
            kept: false,
            saved_at: 0,
            size: 11,
            title: String::new(),
            artist: None,
            album: None,
            duration_ms: 0,
            cover: None,
        };
        assert!(merge_tags(&mut empty, &tags, "soundcloud_7__cache"));
        assert_eq!(empty.title, "Настоящее название");
        assert_eq!(empty.artist.as_deref(), Some("Исполнитель из тегов"));
        assert_eq!(empty.album.as_deref(), Some("Альбом из тегов"));
        assert_eq!(empty.duration_ms, 210_000);
        assert_eq!(empty.cover.as_deref(), Some("C:\\covers\\a.jpg"));

        // Данные сервиса важнее тегов: заполненное не перетираем, добавляем
        // только то, чего в записи не было (здесь — обложку)
        let mut filled = record("soundcloud:7", "soundcloud_7__cache.mp3", "cache", now_ms());
        assert!(merge_tags(&mut filled, &tags, "soundcloud_7__cache"));
        assert_eq!(filled.title, "Трек soundcloud:7");
        assert_eq!(filled.artist.as_deref(), Some("Артист"));
        assert_eq!(filled.album.as_deref(), Some("Альбом"));
        assert_eq!(filled.duration_ms, 180_000, "длительность из сервиса перетирать нельзя");
        assert_eq!(filled.cover.as_deref(), Some("C:\\covers\\a.jpg"));
        // Второй проход уже ничего не меняет: запись полная
        assert!(!merge_tags(&mut filled, &tags, "soundcloud_7__cache"));

        // Тегов нет: название — имя файла без служебного хвоста
        let mut no_tags = OfflineRecord { title: String::new(), artist: None, album: None, duration_ms: 0, cover: None, ..filled.clone() };
        let bare = player::TrackFile {
            title: "soundcloud_7__cache".into(),
            artist: None,
            album: None,
            duration_ms: 0,
            cover: None,
            ..tags.clone()
        };
        assert!(merge_tags(&mut no_tags, &bare, "soundcloud_7__cache"));
        assert_eq!(no_tags.title, "soundcloud_7");
        assert_eq!(no_tags.duration_ms, 0);
    }

    #[test]
    fn keeping_offline_flips_kind_and_back() {
        let dir = temp_dir("index-kept");
        let file = dummy(&dir, "soundcloud_5__cache.mp3");
        write_index(
            &dir,
            &[record("soundcloud:5", "soundcloud_5__cache.mp3", "cache", now_ms())],
        )
        .unwrap();

        // Идентификатор из очереди (с двоеточием) находит запись из имени файла
        set_kept_in(&dir, "soundcloud:5", true).unwrap();
        let stored = read_index(&dir);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].kind, "keep");
        assert!(stored[0].kept);
        assert_eq!(stored[0].base_kind, "cache", "исходный режим должен помниться");
        assert!(file.exists(), "файл при пометке не переименовывается и не удаляется");

        // Повторная пометка ничего не ломает
        set_kept_in(&dir, "soundcloud:5", true).unwrap();
        assert_eq!(read_index(&dir)[0].base_kind, "cache");

        // Снятие возвращает исходный режим
        set_kept_in(&dir, "soundcloud:5", false).unwrap();
        let stored = read_index(&dir);
        assert_eq!(stored[0].kind, "cache");
        assert!(!stored[0].kept);
        assert_eq!(stored[0].base_kind, "cache");
        assert!(file.exists());

        // Настоящее скачивание после снятия остаётся скачиванием
        std::fs::write(
            index_path(&dir),
            r#"[{"trackId":"soundcloud:5","file":"soundcloud_5__cache.mp3","kind":"keep","baseKind":"download","kept":true}]"#,
        )
        .unwrap();
        set_kept_in(&dir, "soundcloud-5", false).unwrap();
        assert_eq!(read_index(&dir)[0].kind, "download");

        // Неизвестный трек — понятная ошибка, а не паника
        let error = set_kept_in(&dir, "soundcloud:404", true).unwrap_err();
        assert!(error.contains("не найдена"), "получили: {error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cleanup_removes_only_old_cache_copies() {
        let dir = temp_dir("cleanup");
        let day = 24 * 60 * 60 * 1000u64;
        let now = now_ms();

        let old_cache = dummy(&dir, "old__cache.mp3");
        let old_download = dummy(&dir, "old__download.mp3");
        let old_keep = dummy(&dir, "old__keep.mp3");
        let fresh_cache = dummy(&dir, "fresh__cache.mp3");
        write_index(
            &dir,
            &[
                record("soundcloud:1", "old__cache.mp3", "cache", now - 10 * day),
                record("soundcloud:2", "old__download.mp3", "download", now - 10 * day),
                record("soundcloud:3", "old__keep.mp3", "keep", now - 40 * day),
                record("soundcloud:4", "fresh__cache.mp3", "cache", now - day),
            ],
        )
        .unwrap();

        assert_eq!(cleanup_in(&dir, 7), 1, "должна уйти только старая временная копия");
        assert!(!old_cache.exists(), "старая копия кеша должна быть удалена");
        assert!(old_download.exists(), "скачанное автором удалять нельзя");
        assert!(old_keep.exists(), "копию, которую держат офлайн, удалять нельзя");
        assert!(fresh_cache.exists(), "свежая копия кеша должна остаться");

        let stored = read_index(&dir);
        assert_eq!(stored.len(), 3);
        assert!(stored.iter().all(|item| item.file != "old__cache.mp3"));

        // Ноль дней — «вычистить весь кеш», но снова не трогая download и keep
        assert_eq!(cleanup_in(&dir, 0), 1);
        assert!(!fresh_cache.exists());
        assert!(old_download.exists() && old_keep.exists());
        assert_eq!(read_index(&dir).len(), 2);

        // Повторная уборка уже ничего не находит
        assert_eq!(cleanup_in(&dir, 0), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn total_size_counts_real_files_only() {
        let dir = temp_dir("total");
        dummy(&dir, "a__cache.mp3");
        dummy(&dir, "b__download.mp3");
        write_index(
            &dir,
            &[
                record("soundcloud:1", "a__cache.mp3", "cache", now_ms()),
                record("soundcloud:2", "b__download.mp3", "download", now_ms()),
                record("soundcloud:3", "gone__cache.mp3", "cache", now_ms()),
            ],
        )
        .unwrap();

        assert_eq!(total_bytes(&dir), 22, "считаются только существующие файлы");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn free_space_output_is_parsed() {
        // PowerShell `(Get-PSDrive -Name C).Free`
        assert_eq!(parse_free_bytes("203313143808\r\n"), Some(203313143808));
        // wmic `get FreeSpace /value`
        assert_eq!(parse_free_bytes("\r\nFreeSpace=123456789\r\n\r\n"), Some(123456789));
        // fsutil: подпись и число с пробелами, в любой локали
        assert_eq!(
            parse_free_bytes("Total free bytes        : 484 209 123 456\r\nTotal bytes : 999\r\n"),
            Some(484209123456)
        );
        assert_eq!(
            parse_free_bytes("Всего свободных байт : 484209123456\r\n"),
            Some(484209123456)
        );
        // Ничего разобрать не удалось — это не ноль байт, а «неизвестно»
        assert_eq!(parse_free_bytes(""), None);
        assert_eq!(parse_free_bytes("команда не найдена"), None);
    }

    #[test]
    fn volume_root_comes_from_the_cache_path() {
        assert_eq!(volume_root(Path::new("C:\\Users\\x\\AppData\\Roaming\\com.example.musichub\\cache")), "C");
        assert_eq!(volume_root(Path::new("d:\\music\\cache")), "D");
        assert_eq!(volume_root(Path::new("/tmp/cache")), "C");
    }

    #[test]
    fn only_files_from_cache_dir_are_removable() {
        let base = temp_dir("remove");
        let cache = base.join("cache");
        std::fs::create_dir_all(&cache).unwrap();

        let inside = cache.join("track__cache.mp3");
        std::fs::write(&inside, b"audio").unwrap();
        let nested_dir = cache.join("sub");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let nested = nested_dir.join("nested__download.mp3");
        std::fs::write(&nested, b"audio").unwrap();
        let outside = base.join("other.mp3");
        std::fs::write(&outside, b"audio").unwrap();

        assert!(checked_path(&cache, &inside.to_string_lossy()).is_ok());
        // Вложенная папка — всё ещё внутри кеша
        assert!(checked_path(&cache, &nested.to_string_lossy()).is_ok());
        // Соседний файл и сама папка кеша удалению не подлежат
        assert!(checked_path(&cache, &outside.to_string_lossy()).is_err());
        assert!(checked_path(&cache, &cache.to_string_lossy()).is_err());
        assert!(checked_path(&cache, "C:\\Windows\\notepad.exe").is_err());
        // Обход через «..» тоже не проходит
        let trick = cache.join("..").join("other.mp3");
        assert!(checked_path(&cache, &trick.to_string_lossy()).is_err());
        // Несуществующий файл — понятная ошибка, а не паника
        let missing = cache.join("gone.mp3");
        assert!(checked_path(&cache, &missing.to_string_lossy()).is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn unknown_kind_is_rejected_before_any_network() {
        let error = save("https://example.com/track.mp3", "1", "качать", "", None, None).unwrap_err();
        assert!(error.contains("режим"), "получили: {error}");
    }

    #[test]
    fn non_http_links_are_rejected() {
        let error = save("file:///C:/Windows/notepad.exe", "1", "cache", "", None, None).unwrap_err();
        assert!(error.contains("http"), "получили: {error}");
    }

    #[test]
    fn download_replaces_only_cache_copies_of_the_same_track() {
        let dir = temp_dir("stale");
        let cache = dir.join(file_name("soundcloud-5", "cache", "mp3"));
        std::fs::write(&cache, b"cache").unwrap();
        let downloaded = dir.join(file_name("soundcloud-5", "download", "mp3"));
        std::fs::write(&downloaded, b"download").unwrap();
        // Чужой трек и недокачанный файл трогать нельзя
        let other = dir.join(file_name("soundcloud-6", "cache", "mp3"));
        std::fs::write(&other, b"cache").unwrap();
        let temp = dir.join("soundcloud-5.1.part");
        std::fs::write(&temp, b"part").unwrap();

        let removed = remove_cache_copies(&dir, "soundcloud-5");
        assert_eq!(removed, vec!["soundcloud-5__cache.mp3".to_string()]);
        assert!(!cache.exists(), "временная копия должна исчезнуть");
        assert!(downloaded.exists(), "настоящее скачивание остаётся");
        assert!(other.exists(), "чужой трек не трогаем");
        assert!(temp.exists(), "недокачанный файл не трогаем");
        // Суффикс счётчика в имени .part не должен выглядеть как режим
        assert!(remove_cache_copies(&dir, "soundcloud-5").is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_of_real_cache_is_honest_about_kinds() {
        // Чтение папки не должно паниковать, а режим каждого файла обязан
        // быть одним из известных: интерфейс показывает его пользователю.
        for file in list() {
            assert!(ALL_KINDS.contains(&file.kind.as_str()), "неизвестный режим: {}", file.kind);
            // Способ показывается в интерфейсе отдельно от режима: у записи
            // прошлой версии он выводится из режима и обязан быть известным
            assert!(METHODS.contains(&file.method.as_str()), "неизвестный способ: {}", file.method);
            assert!(!file.path.ends_with(".part"), "недокачанный файл попал в список");
            assert!(!file.file_name.is_empty());
            assert!(!file.track_id.is_empty(), "у записи нет исходного id трека");
        }
    }
}
