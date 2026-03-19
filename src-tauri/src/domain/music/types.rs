use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::Path;
use tauri_specta::Event;

pub const MUSIC_LIBRARY_SCHEMA_VERSION: u32 = 2;
pub const MUSIC_ANALYSIS_VERSION: u32 = 1;

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
    // Legacy compatibility field. New playback should use integrated_lufs.
    pub avg_db: Option<f32>,
    pub integrated_lufs: Option<f32>,
    pub true_peak_dbtp: Option<f32>,
    pub loudness_range_lu: Option<f32>,
    pub loudness_threshold_lufs: Option<f32>,
    pub analyzed_at_ms: Option<i64>,
    pub analysis_version: Option<u32>,
    pub source_mtime_ms: Option<i64>,
    pub source_size_bytes: Option<i64>,
    pub normalization_status: Option<NormalizationStatus>,
    pub normalization_error: Option<String>,
    pub base_bias: f32,
    pub user_boost: f32,
    pub fatigue: f32,
    pub diversity: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub enum NormalizationStatus {
    Pending,
    Ready,
    Failed,
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

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub enum ClosureLifecyclePhase {
    Saved,
    Downloaded,
    Analyzed,
    Failed,
    Notified,
}

impl ClosureLifecyclePhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Saved => "saved",
            Self::Downloaded => "downloaded",
            Self::Analyzed => "analyzed",
            Self::Failed => "failed",
            Self::Notified => "notified",
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct ClosureLifecycleFact {
    pub owner_session_id: u64,
    pub entry_identity: String,
    pub phase: ClosureLifecyclePhase,
    pub event_id: String,
    pub playlist: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub notification_text: Option<String>,
}

pub fn closure_entry_identity(entry: &Entry) -> Option<String> {
    match (entry.url.as_deref(), entry.path.as_deref()) {
        (Some(url), Some(path)) if !url.is_empty() && !path.is_empty() => {
            Some(format!("url-path:{url}::{path}"))
        }
        (Some(url), _) if !url.is_empty() => Some(format!("url:{url}")),
        (_, Some(path)) if !path.is_empty() => Some(format!("path:{path}")),
        _ => None,
    }
}

pub fn closure_event_id(
    owner_session_id: u64,
    entry_identity: &str,
    phase: &ClosureLifecyclePhase,
) -> String {
    format!(
        "{owner_session_id}:{entry_identity}:{}",
        phase.as_str()
    )
}

pub fn build_closure_lifecycle_fact(
    owner_session_id: u64,
    playlist: &str,
    entry: &Entry,
    phase: ClosureLifecyclePhase,
    notification_text: Option<String>,
) -> Option<ClosureLifecycleFact> {
    let entry_identity = closure_entry_identity(entry)?;
    Some(ClosureLifecycleFact {
        owner_session_id,
        event_id: closure_event_id(owner_session_id, &entry_identity, &phase),
        entry_identity,
        phase,
        playlist: playlist.to_string(),
        path: entry.path.clone(),
        url: entry.url.clone(),
        notification_text,
    })
}

pub fn closure_owner_session_id_from_entry(entry: &Entry) -> Option<u64> {
    let entry_identity = closure_entry_identity(entry)?;
    Some(closure_owner_session_id_from_identity(&entry_identity))
}

pub fn closure_owner_session_id_from_identity(entry_identity: &str) -> u64 {
    entry_identity
        .bytes()
        .fold(0u64, |acc, byte| acc.wrapping_mul(16777619).wrapping_add(byte as u64))
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
        integrated_lufs: None,
        true_peak_dbtp: None,
        loudness_range_lu: None,
        loudness_threshold_lufs: None,
        analyzed_at_ms: None,
        analysis_version: None,
        source_mtime_ms: None,
        source_size_bytes: None,
        normalization_status: None,
        normalization_error: None,
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
        base.integrated_lufs = m.integrated_lufs;
        base.true_peak_dbtp = m.true_peak_dbtp;
        base.loudness_range_lu = m.loudness_range_lu;
        base.loudness_threshold_lufs = m.loudness_threshold_lufs;
        base.analyzed_at_ms = m.analyzed_at_ms;
        base.analysis_version = m.analysis_version;
        base.source_mtime_ms = m.source_mtime_ms;
        base.source_size_bytes = m.source_size_bytes;
        base.normalization_status = m.normalization_status.clone();
        base.normalization_error = m.normalization_error.clone();
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

pub fn music_loudness_lufs(music: &Music) -> Option<f32> {
    music.integrated_lufs
}

pub fn canonical_mean_lufs<I>(values: I) -> Option<f32>
where
    I: IntoIterator<Item = f32>,
{
    let (sum, count) = values
        .into_iter()
        .fold((0.0f32, 0usize), |(sum, count), value| {
            (sum + value, count + 1)
        });

    if count == 0 {
        None
    } else {
        Some(sum / count as f32)
    }
}

pub fn sync_legacy_loudness_fields(music: &mut Music) {
    let _ = music;
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
    entry.avg_db = canonical_mean_lufs(entry.musics.iter().filter_map(music_loudness_lufs));
}

pub fn recompute_playlist_avg(playlist: &mut Playlist) {
    playlist.avg_db = canonical_mean_lufs(
        playlist
            .entries
            .iter()
            .flat_map(|entry| entry.musics.iter())
            .filter_map(music_loudness_lufs),
    );
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_mean_lufs, closure_owner_session_id_from_entry,
        closure_owner_session_id_from_identity, dedup_entries, merge_music_with_template,
        music_loudness_lufs, recompute_entry_avg, recompute_playlist_avg, sanitize_name, Entry,
        EntryType, Music, NormalizationStatus, Playlist,
    };

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

    #[test]
    fn merge_music_with_template_should_not_promote_legacy_avg_db() {
        let merged = merge_music_with_template(
            "fresh.flac".to_string(),
            Some(&Music {
                path: "legacy.flac".to_string(),
                title: "legacy".to_string(),
                avg_db: Some(-14.5),
                integrated_lufs: None,
                true_peak_dbtp: None,
                loudness_range_lu: None,
                loudness_threshold_lufs: None,
                analyzed_at_ms: Some(1),
                analysis_version: Some(1),
                source_mtime_ms: Some(2),
                source_size_bytes: Some(3),
                normalization_status: Some(NormalizationStatus::Ready),
                normalization_error: None,
                base_bias: 0.0,
                user_boost: 0.0,
                fatigue: 0.0,
                diversity: 0.0,
            }),
        );

        assert_eq!(merged.avg_db, Some(-14.5));
        assert_eq!(merged.integrated_lufs, None);
        assert_eq!(music_loudness_lufs(&merged), None);
    }

    #[test]
    fn canonical_mean_lufs_returns_none_for_empty_sets() {
        assert_eq!(canonical_mean_lufs(Vec::<f32>::new()), None);
    }

    #[test]
    fn recompute_entry_avg_should_ignore_legacy_only_tracks_and_null_when_no_canonical_tracks() {
        let mut entry = Entry {
            path: Some("entry".to_string()),
            name: "entry".to_string(),
            musics: vec![
                Music {
                    path: "legacy.flac".to_string(),
                    title: "legacy".to_string(),
                    avg_db: Some(-9.0),
                    integrated_lufs: None,
                    true_peak_dbtp: None,
                    loudness_range_lu: None,
                    loudness_threshold_lufs: None,
                    analyzed_at_ms: None,
                    analysis_version: None,
                    source_mtime_ms: None,
                    source_size_bytes: None,
                    normalization_status: Some(NormalizationStatus::Ready),
                    normalization_error: None,
                    base_bias: 0.0,
                    user_boost: 0.0,
                    fatigue: 0.0,
                    diversity: 0.0,
                },
                Music {
                    path: "canonical.flac".to_string(),
                    title: "canonical".to_string(),
                    avg_db: Some(-1.0),
                    integrated_lufs: Some(-18.0),
                    true_peak_dbtp: Some(-1.0),
                    loudness_range_lu: Some(6.0),
                    loudness_threshold_lufs: None,
                    analyzed_at_ms: Some(1),
                    analysis_version: Some(1),
                    source_mtime_ms: Some(2),
                    source_size_bytes: Some(3),
                    normalization_status: Some(NormalizationStatus::Ready),
                    normalization_error: None,
                    base_bias: 0.0,
                    user_boost: 0.0,
                    fatigue: 0.0,
                    diversity: 0.0,
                },
            ],
            avg_db: Some(-99.0),
            url: None,
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::Local,
        };

        recompute_entry_avg(&mut entry);
        assert_eq!(entry.avg_db, Some(-18.0));

        entry.musics[1].integrated_lufs = None;
        recompute_entry_avg(&mut entry);
        assert_eq!(entry.avg_db, None);
    }

    #[test]
    fn recompute_playlist_avg_should_average_canonical_tracks_only_across_entries() {
        let mut playlist = Playlist {
            name: "mix".to_string(),
            avg_db: Some(-99.0),
            entries: vec![
                Entry {
                    path: Some("entry-a".to_string()),
                    name: "entry-a".to_string(),
                    musics: vec![
                        Music {
                            path: "a.flac".to_string(),
                            title: "a".to_string(),
                            avg_db: Some(-4.0),
                            integrated_lufs: Some(-20.0),
                            true_peak_dbtp: Some(-1.0),
                            loudness_range_lu: Some(5.0),
                            loudness_threshold_lufs: None,
                            analyzed_at_ms: Some(1),
                            analysis_version: Some(1),
                            source_mtime_ms: Some(2),
                            source_size_bytes: Some(3),
                            normalization_status: Some(NormalizationStatus::Ready),
                            normalization_error: None,
                            base_bias: 0.0,
                            user_boost: 0.0,
                            fatigue: 0.0,
                            diversity: 0.0,
                        },
                        Music {
                            path: "legacy.flac".to_string(),
                            title: "legacy".to_string(),
                            avg_db: Some(-6.0),
                            integrated_lufs: None,
                            true_peak_dbtp: None,
                            loudness_range_lu: None,
                            loudness_threshold_lufs: None,
                            analyzed_at_ms: None,
                            analysis_version: None,
                            source_mtime_ms: None,
                            source_size_bytes: None,
                            normalization_status: Some(NormalizationStatus::Ready),
                            normalization_error: None,
                            base_bias: 0.0,
                            user_boost: 0.0,
                            fatigue: 0.0,
                            diversity: 0.0,
                        },
                    ],
                    avg_db: None,
                    url: None,
                    downloaded_ok: Some(true),
                    tracking: Some(false),
                    entry_type: EntryType::Local,
                },
                Entry {
                    path: Some("entry-b".to_string()),
                    name: "entry-b".to_string(),
                    musics: vec![Music {
                        path: "b.flac".to_string(),
                        title: "b".to_string(),
                        avg_db: Some(-8.0),
                        integrated_lufs: Some(-14.0),
                        true_peak_dbtp: Some(-1.5),
                        loudness_range_lu: Some(4.0),
                        loudness_threshold_lufs: None,
                        analyzed_at_ms: Some(1),
                        analysis_version: Some(1),
                        source_mtime_ms: Some(2),
                        source_size_bytes: Some(3),
                        normalization_status: Some(NormalizationStatus::Ready),
                        normalization_error: None,
                        base_bias: 0.0,
                        user_boost: 0.0,
                        fatigue: 0.0,
                        diversity: 0.0,
                    }],
                    avg_db: None,
                    url: None,
                    downloaded_ok: Some(true),
                    tracking: Some(false),
                    entry_type: EntryType::Local,
                },
            ],
            exclude: vec![Music {
                path: "excluded.flac".to_string(),
                title: "excluded".to_string(),
                avg_db: Some(-30.0),
                integrated_lufs: Some(-30.0),
                true_peak_dbtp: Some(-1.0),
                loudness_range_lu: Some(2.0),
                loudness_threshold_lufs: None,
                analyzed_at_ms: Some(1),
                analysis_version: Some(1),
                source_mtime_ms: Some(2),
                source_size_bytes: Some(3),
                normalization_status: Some(NormalizationStatus::Ready),
                normalization_error: None,
                base_bias: 0.0,
                user_boost: 0.0,
                fatigue: 0.0,
                diversity: 0.0,
            }],
        };

        for entry in &mut playlist.entries {
            recompute_entry_avg(entry);
        }
        recompute_playlist_avg(&mut playlist);

        assert_eq!(playlist.entries[0].avg_db, Some(-20.0));
        assert_eq!(playlist.entries[1].avg_db, Some(-14.0));
        assert_eq!(playlist.avg_db, Some(-17.0));

        playlist.entries[0].musics[0].integrated_lufs = None;
        playlist.entries[1].musics[0].integrated_lufs = None;
        for entry in &mut playlist.entries {
            recompute_entry_avg(entry);
        }
        recompute_playlist_avg(&mut playlist);

        assert_eq!(playlist.entries[0].avg_db, None);
        assert_eq!(playlist.entries[1].avg_db, None);
        assert_eq!(playlist.avg_db, None);
    }

    #[test]
    fn closure_owner_session_id_should_stay_stable_for_the_same_canonical_entry_identity() {
        let entry = Entry {
            path: Some("C:/music/replacement".to_string()),
            name: "replacement".to_string(),
            musics: vec![],
            avg_db: None,
            url: Some("https://example.com/remote-replacement".to_string()),
            downloaded_ok: Some(true),
            tracking: Some(false),
            entry_type: EntryType::WebList,
        };

        let identity = "url-path:https://example.com/remote-replacement::C:/music/replacement";

        assert_eq!(closure_owner_session_id_from_entry(&entry), Some(closure_owner_session_id_from_identity(identity)));
    }
}
