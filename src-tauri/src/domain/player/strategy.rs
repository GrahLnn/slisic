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
    music_url: String,
    file_path: PathBuf,
    start: u32,
    end: u32,
}

pub struct PlaybackStrategySet {
    random: RandomPlaybackStrategy,
    current_track: Option<PlaybackTrackIdentity>,
}

impl PlaybackTrackIdentity {
    fn from_track(track: &PlaybackTrack) -> Self {
        Self {
            music_url: track.music_url.clone(),
            file_path: track.file_path.clone(),
            start: track.start,
            end: track.end,
        }
    }

    fn matches(&self, track: &PlaybackTrack) -> bool {
        self.music_url == track.music_url
            && self.file_path == track.file_path
            && self.start == track.start
            && self.end == track.end
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
                .cloned()
                .or_else(|| self.random.next_track(tracks).cloned()),
            PlaybackContinuationMode::Random => self.random.next_track(tracks).cloned(),
        }?;

        self.current_track = Some(PlaybackTrackIdentity::from_track(&track));
        Some(track)
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
