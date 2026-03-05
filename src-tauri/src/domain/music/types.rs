use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::Path;
use tauri_specta::Event;

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Playlist {
    pub name: String,
    pub avg_db: Option<f32>,
    pub entries: Vec<Entry>,
    pub exclude: Vec<Music>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct FolderSample {
    pub path: String,
    pub items: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub enum LinkStatus {
    Ok,
    Err,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct LinkSample {
    pub url: String,
    pub title_or_msg: String,
    pub entry_type: EntryType,
    pub count: Option<u32>,
    pub status: Option<LinkStatus>,
    pub tracking: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct CollectMission {
    pub name: String,
    pub folders: Vec<FolderSample>,
    pub links: Vec<LinkSample>,
    pub entries: Vec<Entry>,
    pub exclude: Vec<Music>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Music {
    pub path: String,
    pub title: String,
    pub avg_db: Option<f32>,
    pub true_peak_dbtp: Option<f32>,
    pub base_bias: f32,
    pub user_boost: f32,
    pub fatigue: f32,
    pub diversity: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Hash)]
pub enum EntryType {
    Local,
    WebList,
    WebVideo,
    Unknown,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Entry {
    pub path: Option<String>,
    pub name: String,
    pub musics: Vec<Music>,
    pub avg_db: Option<f32>,
    pub url: Option<String>,
    pub downloaded_ok: Option<bool>,
    pub tracking: Option<bool>,
    pub entry_type: EntryType,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct ProcessMsg {
    pub playlist: String,
    pub str: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct LibraryData {
    pub schema_version: u32,
    pub playlists: Vec<Playlist>,
}

pub fn sanitize_name(input: &str) -> String {
    let illegal = ['<', '>', '"', ':', '/', '\\', '|', '?', '*'];
    let mut out = String::new();
    for ch in input.chars() {
        if ch.is_control() || illegal.contains(&ch) {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn path_to_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(sanitize_name)
        .unwrap_or_else(|| sanitize_name(path))
}

pub fn default_music(path: String) -> Music {
    Music {
        title: path_to_title(&path),
        path,
        avg_db: None,
        true_peak_dbtp: None,
        base_bias: 0.0,
        user_boost: 0.0,
        fatigue: 0.0,
        diversity: 0.0,
    }
}

pub fn merge_music_with_template(path: String, template: Option<&Music>) -> Music {
    let mut base = default_music(path.clone());
    if let Some(m) = template {
        base.avg_db = m.avg_db;
        base.true_peak_dbtp = m.true_peak_dbtp;
        base.base_bias = m.base_bias;
        base.user_boost = m.user_boost;
        base.fatigue = m.fatigue;
        base.diversity = m.diversity;
    }
    if !path.is_empty() {
        base.title = path_to_title(&path);
    }
    base
}

pub fn entry_key(entry: &Entry) -> String {
    if let Some(path) = &entry.path {
        return format!("path:{path}");
    }
    if let Some(url) = &entry.url {
        return format!("url:{url}");
    }
    format!("name:{}", entry.name)
}

pub fn dedup_entries(mut entries: Vec<Entry>) -> Vec<Entry> {
    let mut seen = HashSet::new();
    entries.retain(|entry| seen.insert(entry_key(entry)));
    entries
}

pub fn recompute_entry_avg(entry: &mut Entry) {
    let (sum, count) = entry
        .musics
        .iter()
        .filter_map(|m| m.avg_db)
        .fold((0.0f32, 0usize), |(s, c), v| (s + v, c + 1));
    entry.avg_db = if count == 0 {
        None
    } else {
        Some(sum / count as f32)
    };
}

pub fn recompute_playlist_avg(playlist: &mut Playlist) {
    let (sum, count) = playlist
        .entries
        .iter()
        .filter_map(|e| e.avg_db)
        .fold((0.0f32, 0usize), |(s, c), v| (s + v, c + 1));
    playlist.avg_db = if count == 0 {
        None
    } else {
        Some(sum / count as f32)
    };
}

#[cfg(test)]
mod tests {
    use super::{dedup_entries, sanitize_name, Entry, EntryType};

    #[test]
    fn sanitize_name_should_replace_illegal_chars() {
        assert_eq!(sanitize_name("a:b/c"), "a_b_c");
    }

    #[test]
    fn dedup_entries_should_keep_unique_slots() {
        let entry_a = Entry {
            path: Some("x".to_string()),
            name: "a".to_string(),
            musics: vec![],
            avg_db: None,
            url: None,
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::Local,
        };
        let entry_b = Entry {
            path: Some("x".to_string()),
            name: "b".to_string(),
            musics: vec![],
            avg_db: None,
            url: None,
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::Local,
        };
        let out = dedup_entries(vec![entry_a, entry_b]);
        assert_eq!(out.len(), 1);
    }
}
