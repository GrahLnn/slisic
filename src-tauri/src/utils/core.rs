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

    if let Err(error) = window.unminimize() {
        eprintln!("[app_ready] failed to unminimize window `{label}`: {error}");
    }
    if let Err(error) = window.show() {
        eprintln!("[app_ready] failed to show window `{label}`: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("[app_ready] failed to focus window `{label}`: {error}");
    }
    WINDOW_READY.store(true, Ordering::SeqCst);
}
