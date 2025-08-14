use super::event::WINDOW_READY;
use arboard::Clipboard;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn app_ready(app_handle: AppHandle) {
    let window = app_handle.get_webview_window("main").unwrap();
    window.show().unwrap();
    WINDOW_READY.store(true, Ordering::SeqCst);
}

#[tauri::command]
#[specta::specta]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())?;
    Ok(())
}
