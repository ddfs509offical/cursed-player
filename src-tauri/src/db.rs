//! Локальное хранилище профилей на SQLite.
//!
//! Один файл `profiles.db` в папке данных приложения. Схема намеренно плоская:
//! жанры и ссылки лежат JSON-строками — для локального однопользовательского
//! приложения это проще и предсказуемее, чем отдельные таблицы.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLink {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStats {
    pub hours: f64,
    pub tracks: i64,
    pub top_artist: Option<String>,
}

impl Default for ProfileStats {
    fn default() -> Self {
        Self { hours: 0.0, tracks: 0, top_artist: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub username: String,
    pub display_name: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub banner: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub links: Vec<ProfileLink>,
    #[serde(default)]
    pub now_playing: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub stats: ProfileStats,
    #[serde(default)]
    pub pin: Option<String>,
    #[serde(default)]
    pub guest: bool,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  bio          TEXT NOT NULL DEFAULT '',
  email        TEXT,
  avatar       TEXT,
  banner       TEXT,
  genres       TEXT NOT NULL DEFAULT '[]',
  links        TEXT NOT NULL DEFAULT '[]',
  now_playing  TEXT,
  created_at   TEXT NOT NULL,
  hours        REAL NOT NULL DEFAULT 0,
  tracks       INTEGER NOT NULL DEFAULT 0,
  top_artist   TEXT,
  pin          TEXT,
  guest        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS integrations (
  service       TEXT PRIMARY KEY,
  refresh_token TEXT,
  access_token  TEXT,
  expires_at    INTEGER NOT NULL DEFAULT 0,
  extra         TEXT,
  updated_at    TEXT NOT NULL DEFAULT ''
);
";

fn friendly(error: rusqlite::Error) -> String {
    let text = error.to_string();
    if text.contains("UNIQUE constraint failed: profiles.username") {
        return "Это имя уже занято на устройстве".into();
    }
    text
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // WAL: чтение не блокируется записью, что важно при нескольких окнах
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    migrate(&conn)?;
    Ok(conn)
}

/// Догоняем схему для баз, созданных предыдущими версиями приложения.
fn migrate(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn.prepare("PRAGMA table_info(profiles)").map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    if !columns.iter().any(|name| name == "email") {
        conn.execute("ALTER TABLE profiles ADD COLUMN email TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    let genres: String = row.get("genres")?;
    let links: String = row.get("links")?;
    Ok(Profile {
        id: row.get("id")?,
        username: row.get("username")?,
        display_name: row.get("display_name")?,
        bio: row.get("bio")?,
        email: row.get("email")?,
        avatar: row.get("avatar")?,
        banner: row.get("banner")?,
        genres: serde_json::from_str(&genres).unwrap_or_default(),
        links: serde_json::from_str(&links).unwrap_or_default(),
        now_playing: row.get("now_playing")?,
        created_at: row.get("created_at")?,
        stats: ProfileStats {
            hours: row.get("hours")?,
            tracks: row.get("tracks")?,
            top_artist: row.get("top_artist")?,
        },
        pin: row.get("pin")?,
        guest: row.get::<_, i64>("guest")? != 0,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Profile>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM profiles ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_profile).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

pub fn count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

/// Вставка или полное обновление профиля по id.
pub fn save(conn: &Connection, profile: &Profile) -> Result<(), String> {
    let genres = serde_json::to_string(&profile.genres).map_err(|e| e.to_string())?;
    let links = serde_json::to_string(&profile.links).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO profiles (id, username, display_name, bio, email, avatar, banner, genres, links,
                               now_playing, created_at, hours, tracks, top_artist, pin, guest)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           bio = excluded.bio,
           email = excluded.email,
           avatar = excluded.avatar,
           banner = excluded.banner,
           genres = excluded.genres,
           links = excluded.links,
           now_playing = excluded.now_playing,
           hours = excluded.hours,
           tracks = excluded.tracks,
           top_artist = excluded.top_artist,
           pin = excluded.pin,
           guest = excluded.guest",
        params![
            profile.id,
            profile.username,
            profile.display_name,
            profile.bio,
            profile.email,
            profile.avatar,
            profile.banner,
            genres,
            links,
            profile.now_playing,
            profile.created_at,
            profile.stats.hours,
            profile.stats.tracks,
            profile.stats.top_artist,
            profile.pin,
            if profile.guest { 1 } else { 0 },
        ],
    )
    .map_err(friendly)?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM profiles WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn active_get(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM app_state WHERE key = 'active_profile'", [], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

pub fn active_set(conn: &Connection, id: Option<&str>) -> Result<(), String> {
    match id {
        Some(value) => {
            conn.execute(
                "INSERT INTO app_state (key, value) VALUES ('active_profile', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![value],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            conn.execute("DELETE FROM app_state WHERE key = 'active_profile'", [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Перенос профилей из старого localStorage-хранилища.
pub fn import(conn: &Connection, profiles: &[Profile]) -> Result<usize, String> {
    let mut imported = 0usize;
    for profile in profiles {
        // Пропускаем уже существующие id и занятые имена
        let exists: Option<String> = conn
            .query_row("SELECT id FROM profiles WHERE id = ?1", params![profile.id], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_some() {
            continue;
        }
        if save(conn, profile).is_ok() {
            imported += 1;
        }
    }
    Ok(imported)
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Секунды Unix — для сроков жизни токенов.
pub fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Подключённый сервис: токены лежат в базе, а не в файлах рядом.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub service: String,
    pub refresh_token: Option<String>,
    pub access_token: Option<String>,
    pub expires_at: i64,
    pub extra: Option<String>,
    pub updated_at: String,
}

pub fn integration_get(conn: &Connection, service: &str) -> Result<Option<Integration>, String> {
    conn.query_row(
        "SELECT service, refresh_token, access_token, expires_at, extra, updated_at
         FROM integrations WHERE service = ?1",
        params![service],
        |row| {
            Ok(Integration {
                service: row.get(0)?,
                refresh_token: row.get(1)?,
                access_token: row.get(2)?,
                expires_at: row.get(3)?,
                extra: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn integration_save(conn: &Connection, item: &Integration) -> Result<(), String> {
    conn.execute(
        "INSERT INTO integrations (service, refresh_token, access_token, expires_at, extra, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(service) DO UPDATE SET
           refresh_token = excluded.refresh_token,
           access_token = excluded.access_token,
           expires_at = excluded.expires_at,
           extra = excluded.extra,
           updated_at = excluded.updated_at",
        params![
            item.service,
            item.refresh_token,
            item.access_token,
            item.expires_at,
            item.extra,
            item.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn integration_delete(conn: &Connection, service: &str) -> Result<(), String> {
    conn.execute("DELETE FROM integrations WHERE service = ?1", params![service])
        .map_err(|e| e.to_string())?;
    Ok(())
}
