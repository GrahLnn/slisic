use super::model::PlaybackTrack;
use rand::seq::SliceRandom;

pub trait PlaybackStrategy: Send {
    fn next_track<'a>(&mut self, tracks: &'a [PlaybackTrack]) -> Option<&'a PlaybackTrack>;
}

pub struct RandomPlaybackStrategy {
    order: Vec<usize>,
    cursor: usize,
}

impl RandomPlaybackStrategy {
    pub fn new() -> Self {
        Self {
            order: vec![],
            cursor: 0,
        }
    }

    fn refill_order(&mut self, len: usize) {
        self.order = (0..len).collect();
        self.cursor = 0;
        let mut rng = rand::rng();
        self.order.shuffle(&mut rng);
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

        if self.order.len() != tracks.len() || self.cursor >= self.order.len() {
            self.refill_order(tracks.len());
        }

        let index = self.order[self.cursor];
        self.cursor += 1;
        tracks.get(index)
    }
}
