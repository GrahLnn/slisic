use super::event::WINDOW_READY;
use super::window;
use std::sync::atomic::Ordering;
use tauri::WebviewWindow;

#[tauri::command]
#[specta::specta]
pub async fn app_ready(window: WebviewWindow) {
    window::activate_window(&window);
    WINDOW_READY.store(true, Ordering::SeqCst);
}
