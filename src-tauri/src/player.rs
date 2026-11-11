//! Локальная музыка: выбор файлов, обход папок и чтение тегов.
//!
//! Воспроизведение делает WebView (HTMLAudioElement) по ссылке вида
//! `asset://…`, которую даёт convertFileSrc — поэтому здесь только метаданные.

use serde::Serialize;
use std::path::{Path, PathBuf};

const AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "mp3", "wav", "ogg", "oga", "opus", "m4a", "mp4", "aac", "wma", "aiff", "ape", "wv",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackFile {
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: i64,
    /// Путь к извлечённой обложке (кэш в папке приложения).
    pub cover: Option<String>,
}

fn md5_hex(value: &str) -> String {
    use md5::{Digest, Md5};
    Md5::digest(value.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Сохраняет обложку из тегов в кэш рядом с базой и возвращает путь к файлу.
/// Так списки не тянут base64 из каждого файла заново.
fn cache_cover(path: &Path, picture: &lofty::picture::Picture) -> Option<String> {
    let appdata = std::env::var("APPDATA").ok()?;
    let dir = PathBuf::from(appdata).join("com.example.musichub").join("covers");
    std::fs::create_dir_all(&dir).ok()?;

    let data = picture.data();
    if data.is_empty() {
        return None;
    }
    let extension = match picture.mime_type() {
        Some(lofty::picture::MimeType::Png) => "png",
        Some(lofty::picture::MimeType::Jpeg) => "jpg",
        Some(lofty::picture::MimeType::Gif) => "gif",
        Some(lofty::picture::MimeType::Bmp) => "bmp",
        _ => "img",
    };
    let key = md5_hex(&format!("{}|{}", path.display(), data.len()));
    let file = dir.join(format!("{key}.{extension}"));
    if !file.exists() {
        std::fs::write(&file, data).ok()?;
    }
    Some(file.to_string_lossy().to_string())
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Читает теги и длительность; если тегов нет — берёт имя файла.
pub fn read_track(path: &Path) -> TrackFile {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());

    let mut track = TrackFile {
        path: path.to_string_lossy().to_string(),
        file_name,
        title: stem,
        artist: None,
        album: None,
        duration_ms: 0,
        cover: None,
    };

    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::probe::Probe;
    use lofty::tag::Accessor;

    if let Ok(tagged) = Probe::open(path).and_then(|probe| probe.read()) {
        track.duration_ms = tagged.properties().duration().as_millis() as i64;
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(title) = tag.title() {
                if !title.trim().is_empty() {
                    track.title = title.to_string();
                }
            }
            track.artist = tag.artist().map(|value| value.to_string());
            track.album = tag.album().map(|value| value.to_string());
            if let Some(picture) = tag.pictures().first() {
                track.cover = cache_cover(path, picture);
            }
        }
    }

    track
}

/// Диалог выбора файлов (можно несколько сразу).
pub fn pick_files() -> Vec<TrackFile> {
    // На Android системный диалог выбирает файлы через Kotlin-слой, поэтому
    // здесь пустой список вместо паники из-за отсутствующего rfd.
    #[cfg(desktop)]
    {
        rfd::FileDialog::new()
            .set_title("Выбери музыку")
            .add_filter("Аудио", AUDIO_EXTENSIONS)
            .pick_files()
            .map(|paths| paths.iter().map(|path| read_track(path)).collect())
            .unwrap_or_default()
    }
    #[cfg(not(desktop))]
    {
        Vec::new()
    }
}

/// Диалог выбора папки для библиотеки.
pub fn pick_folder() -> Option<String> {
    #[cfg(desktop)]
    {
        rfd::FileDialog::new()
            .set_title("Выбери папку с музыкой")
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string())
    }
    #[cfg(not(desktop))]
    {
        None
    }
}

/// Обходит папку (включая вложенные) и собирает аудиофайлы.
pub fn scan_folder(dir: &Path) -> Result<Vec<TrackFile>, String> {
    if !dir.is_dir() {
        return Err(format!("Это не папка: {}", dir.display()));
    }

    let mut found = Vec::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = std::fs::read_dir(&current)
            .map_err(|e| format!("Не читается папка {}: {e}", current.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if is_audio(&path) {
                found.push(read_track(&path));
            }
        }
    }

    found.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_extensions_are_detected() {
        assert!(is_audio(Path::new("C:/music/track.FLAC")));
        assert!(is_audio(Path::new("C:/music/track.mp3")));
        assert!(!is_audio(Path::new("C:/music/cover.jpg")));
        assert!(!is_audio(Path::new("C:/music/notes.txt")));
    }

    #[test]
    fn missing_tags_fall_back_to_file_name() {
        let track = read_track(Path::new("C:/music/Неизвестный трек.mp3"));
        assert_eq!(track.title, "Неизвестный трек");
        assert_eq!(track.duration_ms, 0);
        assert!(track.artist.is_none());
    }

    #[test]
    fn scanning_missing_folder_is_reported() {
        let error = scan_folder(Path::new("C:/definitely/not/here")).unwrap_err();
        assert!(error.contains("не папка"), "получили: {error}");
    }
}
