use super::model::{ActivePlaybackRange, PlaybackTrack, PlaybackTrackPayload};
use crate::domain::playlists::model::{Exclude, ExcludeAvailability};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackSurfaceStatus {
    Preparing,
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct NowPlayingTrackChangedEvent {
    pub session_generation: u64,
    pub playlist_name: String,
    pub music_name: String,
    pub canonical_music_id: String,
    pub music_url: String,
    pub file_path: String,
    pub start_ms: u32,
    pub end_ms: u32,
    pub liked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct NowPlayingTrackLikedChangedEvent {
    pub session_generation: u64,
    pub playlist_name: String,
    pub canonical_music_id: String,
    pub liked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlaybackSurfaceStatusChangedEvent {
    pub session_generation: u64,
    pub playlist_name: String,
    pub status: PlaybackSurfaceStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlaybackDiagnosticTraceDetail {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlaybackDiagnosticTraceEvent {
    pub event: String,
    pub playlist_name: Option<String>,
    pub music_name: Option<String>,
    pub music_url: Option<String>,
    pub start_ms: Option<u32>,
    pub end_ms: Option<u32>,
    pub elapsed_ms: Option<u128>,
    pub candidate_count: Option<usize>,
    pub queue_count: Option<usize>,
    pub status: Option<String>,
    pub error: Option<String>,
    pub details: Option<Vec<PlaybackDiagnosticTraceDetail>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlaybackAudioVisualizationFrameEvent {
    pub session_generation: u64,
    pub playlist_name: String,
    pub music_name: String,
    pub canonical_music_id: String,
    pub music_url: String,
    pub file_path: String,
    pub current_position_ms: u32,
    pub range_start_ms: u32,
    pub range_end_ms: u32,
    pub range_progress: f32,
    pub playing: bool,
    pub paused: bool,
    pub loudness_energy: f32,
    pub presence: f32,
    pub dynamics: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlaybackExcludeCommittedEvent {
    pub exclude: Exclude,
    pub exclude_availability: ExcludeAvailability,
}

impl PlaybackAudioVisualizationFrameEvent {
    pub(crate) fn from_session_track(
        session_generation: u64,
        track: &PlaybackTrack,
        current_position_ms: u32,
        active_range: ActivePlaybackRange,
        playing: bool,
        paused: bool,
    ) -> Self {
        let range_start_ms = active_range.start_ms;
        let range_end_ms = active_range.end_ms;
        let range_duration = range_end_ms.saturating_sub(range_start_ms).max(1);
        let range_elapsed = current_position_ms.saturating_sub(range_start_ms);
        let range_progress = (range_elapsed as f32 / range_duration as f32).clamp(0.0, 1.0);
        let loudness_energy = track
            .loudness_profile
            .as_ref()
            .map(|profile| ((profile.integrated_lufs + 36.0) / 30.0).clamp(0.0, 1.0))
            .unwrap_or(0.35);
        let presence = track
            .loudness_profile
            .as_ref()
            .and_then(|profile| profile.presence_db)
            .map(|value| ((value + 18.0) / 18.0).clamp(0.0, 1.0))
            .unwrap_or(0.35);
        let dynamics = track
            .loudness_profile
            .as_ref()
            .and_then(|profile| profile.lra)
            .map(|value| (value / 24.0).clamp(0.0, 1.0))
            .unwrap_or(0.4);

        Self {
            session_generation,
            playlist_name: track.playlist_name.clone(),
            music_name: track.music_name.clone(),
            canonical_music_id: track.canonical_music_id.clone(),
            music_url: track.music_url.clone(),
            file_path: track.file_path.to_string_lossy().to_string(),
            current_position_ms,
            range_start_ms,
            range_end_ms,
            range_progress,
            playing,
            paused,
            loudness_energy,
            presence,
            dynamics,
        }
    }
}

impl NowPlayingTrackChangedEvent {
    pub(crate) fn from_session_track(session_generation: u64, value: PlaybackTrackPayload) -> Self {
        Self {
            session_generation,
            playlist_name: value.playlist_name,
            music_name: value.music_name,
            canonical_music_id: value.canonical_music_id,
            music_url: value.music_url,
            file_path: value.file_path,
            start_ms: value.start_ms,
            end_ms: value.end_ms,
            liked: value.liked,
        }
    }
}

impl NowPlayingTrackLikedChangedEvent {
    pub(crate) fn from_session_track(
        session_generation: u64,
        value: &PlaybackTrackPayload,
    ) -> Self {
        Self {
            session_generation,
            playlist_name: value.playlist_name.clone(),
            canonical_music_id: value.canonical_music_id.clone(),
            liked: value.liked,
        }
    }
}
