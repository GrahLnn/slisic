use std::path::PathBuf;

#[tauri::command]
#[specta::specta]
pub fn exists(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(path).exists())
}
