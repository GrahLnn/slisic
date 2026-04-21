use super::model::PlaybackTrack;
use rand::RngExt;

pub trait PlaybackStrategy: Send {
    fn next_track<'a>(&mut self, tracks: &'a [PlaybackTrack]) -> Option<&'a PlaybackTrack>;
}

pub struct RandomPlaybackStrategy {
    remaining: Vec<usize>,
    track_count: usize,
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
