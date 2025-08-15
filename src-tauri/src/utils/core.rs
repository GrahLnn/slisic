use super::event::WINDOW_READY;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn app_ready(app_handle: AppHandle) {
    let window = app_handle.get_webview_window("main").unwrap();
    window.show().unwrap();
    WINDOW_READY.store(true, Ordering::SeqCst);
}
