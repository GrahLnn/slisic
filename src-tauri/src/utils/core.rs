use super::event::WINDOW_READY;
use super::window;
use appdb::connection::reset_db;
use std::sync::atomic::Ordering;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager, WebviewWindow};

pub const APP_DB_FILE_NAME: &str = "surreal.db";
const DEV_RESET_TRIGGER_FILE_NAME: &str = "dev-reset-trigger.txt";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[tauri::command]
#[specta::specta]
pub async fn app_ready(window: WebviewWindow) {
    if window::should_activate_window_on_app_ready(window.label()) {
        window::activate_window(&window);
    }
    crate::domain::playlist_playback::playable_index::request_ready_refresh_for_app(
        window.app_handle().clone(),
    );
    WINDOW_READY.store(true, Ordering::SeqCst);
}

#[tauri::command]
#[specta::specta]
pub async fn reset_dev_database_and_restart(app: AppHandle) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        return Err("reset_dev_database_and_restart is only available in dev builds".to_string());
    }

    #[cfg(debug_assertions)]
    {
        let _ = crate::domain::player::service::stop_playback().await;
        reset_db();

        let local_data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?;
        let db_path = local_data_dir.join(APP_DB_FILE_NAME);
        remove_db_artifacts(&db_path)?;
        schedule_dev_reset_trigger()?;
        app.exit(0);
        Ok(())
    }
}

fn remove_db_artifacts(db_path: &Path) -> Result<(), String> {
    let Some(parent) = db_path.parent() else {
        return Err("database path parent directory is missing".to_string());
    };
    if !parent.exists() {
        return Ok(());
    }

    let Some(file_name) = db_path.file_name().and_then(|value| value.to_str()) else {
        return Err("database file name is invalid".to_string());
    };

    for entry in fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let Some(candidate) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !candidate.starts_with(file_name) {
            continue;
        }

        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
        } else if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn schedule_dev_reset_trigger() -> Result<(), String> {
    let trigger_path = dev_reset_trigger_path();
    let payload = format!("{:?}\n", std::time::SystemTime::now());
    spawn_delayed_trigger_writer(&trigger_path, &payload)
}

fn dev_reset_trigger_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(DEV_RESET_TRIGGER_FILE_NAME)
}

#[cfg(windows)]
fn spawn_delayed_trigger_writer(path: &Path, payload: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let escaped_path = escape_powershell_single_quoted(path);
    let escaped_payload = payload.replace('\'', "''");
    let script = format!(
        "Start-Sleep -Milliseconds 500; Set-Content -LiteralPath '{escaped_path}' -Value '{escaped_payload}'"
    );

    Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to schedule dev reset trigger: {error}"))
}

#[cfg(not(windows))]
fn spawn_delayed_trigger_writer(path: &Path, payload: &str) -> Result<(), String> {
    let escaped_path = path.to_string_lossy().replace('\'', "'\"'\"'");
    let escaped_payload = payload.replace('\'', "'\"'\"'");
    let script = format!("sleep 0.5; printf '%s' '{escaped_payload}' > '{escaped_path}'");

    Command::new("sh")
        .args(["-c", &script])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to schedule dev reset trigger: {error}"))
}

#[cfg(windows)]
fn escape_powershell_single_quoted(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}
