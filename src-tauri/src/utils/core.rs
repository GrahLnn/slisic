use super::event::WINDOW_READY;
use super::window;
use std::sync::atomic::Ordering;
use tauri::WebviewWindow;

#[tauri::command]
#[specta::specta]
pub async fn app_ready(window: WebviewWindow) {
    let label = window.label().to_string();
    if window::mark_window_ready(&label) {
        WINDOW_READY.store(true, Ordering::SeqCst);
        return;
    }

    let _ = window.show();
    WINDOW_READY.store(true, Ordering::SeqCst);
}
