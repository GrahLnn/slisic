use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::atomic::AtomicBool;
use tauri_specta::Event;

#[derive(Serialize, Deserialize, Debug, Clone, Type, Event)]
pub struct ImportEvent {
    pub done: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type, Event)]
pub struct FullScreenEvent {
    pub is_fullscreen: bool,
}

pub static WINDOW_READY: AtomicBool = AtomicBool::new(false);
