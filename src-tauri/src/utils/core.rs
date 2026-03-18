use super::event::WINDOW_READY;
use super::window;
use std::sync::atomic::Ordering;
use tauri::WebviewWindow;

#[tauri::command]
#[specta::specta]
pub async fn app_ready(window: WebviewWindow) {
    if window::should_activate_window_on_app_ready(window.label()) {
        window::activate_window(&window);
    }
    WINDOW_READY.store(true, Ordering::SeqCst);
}
