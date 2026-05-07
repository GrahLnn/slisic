use super::model::{PlaybackContinuationMode, PlaybackTrack};
use rand::RngExt;
use std::path::PathBuf;

pub trait PlaybackStrategy: Send {
    fn next_track<'a>(&mut self, tracks: &'a [PlaybackTrack]) -> Option<&'a PlaybackTrack>;
}

pub struct RandomPlaybackStrategy {
    remaining: Vec<usize>,
    track_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlaybackTrackIdentity {
    playlist_name: String,
    music_url: String,
    file_path: PathBuf,
    start_ms: u32,
    end_ms: u32,
}

pub struct PlaybackStrategySet {
    random: RandomPlaybackStrategy,
    current_track: Option<PlaybackTrackIdentity>,
}

impl PlaybackTrackIdentity {
    fn from_track(track: &PlaybackTrack) -> Self {
        Self {
            playlist_name: track.playlist_name.clone(),
            music_url: track.music_url.clone(),
            file_path: track.file_path.clone(),
            start_ms: track.start_ms,
            end_ms: track.end_ms,
        }
    }

    fn matches(&self, track: &PlaybackTrack) -> bool {
        self.playlist_name == track.playlist_name
            && self.music_url == track.music_url
            && self.file_path == track.file_path
            && self.start_ms == track.start_ms
            && self.end_ms == track.end_ms
    }

    fn matches_stable_media(&self, track: &PlaybackTrack) -> bool {
        self.playlist_name == track.playlist_name
            && self.music_url == track.music_url
            && self.file_path == track.file_path
    }

    fn matches_next_track(&self, track: &PlaybackTrack, next: &PlaybackTrack) -> bool {
        self.matches_stable_media(track)
            && track.start_ms == next.start_ms
            && track.end_ms == next.end_ms
    }
}

impl RandomPlaybackStrategy {
    pub fn new() -> Self {
        Self {
            remaining: vec![],
            track_count: 0,
        }
    }

    fn refill_remaining(&mut self, len: usize) {
        self.remaining = (0..len).collect();
        self.track_count = len;
    }
}

impl PlaybackStrategySet {
    pub fn new() -> Self {
        Self {
            random: RandomPlaybackStrategy::new(),
            current_track: None,
        }
    }

    pub fn next_track(
        &mut self,
        mode: PlaybackContinuationMode,
        tracks: &[PlaybackTrack],
    ) -> Option<PlaybackTrack> {
        let track = match mode {
            PlaybackContinuationMode::RepeatCurrent => self
                .current_track
                .as_ref()
                .and_then(|current| tracks.iter().find(|track| current.matches(track)))
                .cloned(),
            PlaybackContinuationMode::Random => self.random.next_track(tracks).cloned(),
        }?;

        self.current_track = Some(PlaybackTrackIdentity::from_track(&track));
        Some(track)
    }

    pub fn select_track(
        &mut self,
        requested: &PlaybackTrack,
        tracks: &[PlaybackTrack],
    ) -> Option<PlaybackTrack> {
        let track = tracks.iter().find(|track| {
            track.playlist_name == requested.playlist_name
                && track.music_url == requested.music_url
                && track.file_path == requested.file_path
                && track.start_ms == requested.start_ms
                && track.end_ms == requested.end_ms
        })?;

        self.current_track = Some(PlaybackTrackIdentity::from_track(track));
        Some(track.clone())
    }

    pub fn reconcile_current_track_identity(
        &mut self,
        previous_tracks: &[PlaybackTrack],
        next_tracks: &[PlaybackTrack],
        next_current_track: Option<&PlaybackTrack>,
    ) -> Option<PlaybackTrack> {
        let Some(current) = self.current_track.as_ref() else {
            return None;
        };

        if next_tracks.iter().any(|track| current.matches(track)) {
            return None;
        }

        if !previous_tracks.iter().any(|track| current.matches(track)) {
            return None;
        }

        if let Some(next_current_track) = next_current_track {
            let Some(track) = next_tracks
                .iter()
                .find(|track| current.matches_next_track(track, next_current_track))
            else {
                return None;
            };

            self.current_track = Some(PlaybackTrackIdentity::from_track(track));
            return Some(track.clone());
        }

        if next_tracks
            .iter()
            .filter(|track| current.matches_stable_media(track))
            .count()
            == 1
        {
            return next_tracks
                .iter()
                .find(|track| current.matches_stable_media(track))
                .map(|track| {
                    self.current_track = Some(PlaybackTrackIdentity::from_track(track));
                    track.clone()
                });
        };

        None
    }
}

impl Default for PlaybackStrategySet {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for RandomPlaybackStrategy {
    fn default() -> Self {
        Self::new()
    }
}

impl PlaybackStrategy for RandomPlaybackStrategy {
    fn next_track<'a>(&mut self, tracks: &'a [PlaybackTrack]) -> Option<&'a PlaybackTrack> {
        if tracks.is_empty() {
            return None;
        }

        if self.track_count != tracks.len() || self.remaining.is_empty() {
            self.refill_remaining(tracks.len());
        }

        let mut rng = rand::rng();
        let remaining_index = rng.random_range(0..self.remaining.len());
        let index = self.remaining.swap_remove(remaining_index);
        tracks.get(index)
    }
}
