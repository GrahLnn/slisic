#[cfg(not(test))]
use super::event::WINDOW_READY;
#[cfg(not(test))]
use super::window;
#[cfg(not(test))]
use appdb::prelude::reset_db_and_remove_path;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::process::Command;
#[cfg(not(test))]
use std::sync::atomic::Ordering;
#[cfg(not(test))]
use tauri::{AppHandle, Manager, WebviewWindow};

pub const APP_DB_FILE_NAME: &str = "surreal.db";
pub const STARTUP_PROJECTION_FILE_NAME: &str = "startup-projection.json";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[tauri::command]
#[specta::specta]
#[cfg(not(test))]
pub async fn app_ready(window: WebviewWindow) {
    if window::should_activate_window_on_app_ready(window.label()) {
        window::activate_window(&window);
    }
    WINDOW_READY.store(true, Ordering::SeqCst);
}

#[tauri::command]
#[specta::specta]
#[cfg(not(test))]
pub async fn record_playlist_bootstrap_ready() {
    crate::domain::playlist_playback::playable_index::record_playlist_bootstrap_ready();
}

#[tauri::command]
#[specta::specta]
#[cfg(not(test))]
pub async fn reset_dev_database_and_restart(app: AppHandle) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        return Err("reset_dev_database_and_restart is only available in dev builds".to_string());
    }

    #[cfg(debug_assertions)]
    {
        let _ = crate::domain::player::service::stop_playback().await;

        let local_data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?;
        let db_path = local_data_dir.join(APP_DB_FILE_NAME);
        reset_db_and_remove_path(&db_path).map_err(|error| error.to_string())?;
        let mut reset_artifact_paths = Vec::new();
        reset_artifact_paths.extend(dev_reset_local_data_artifact_paths(&local_data_dir));
        reset_artifact_paths.extend(dev_reset_cache_artifact_paths(&app)?);
        schedule_dev_reset_cleanup(&reset_artifact_paths)?;
        app.exit(0);
        Ok(())
    }
}

pub(super) fn dev_reset_local_data_artifact_paths(local_data_dir: &Path) -> Vec<PathBuf> {
    vec![
        local_data_dir.join(STARTUP_PROJECTION_FILE_NAME),
        local_data_dir
            .join(crate::domain::playlist_playback::playable_index::FIRST_SLOT_CACHE_FILE_NAME),
        local_data_dir.join(
            crate::domain::playlist_playback::recommendation::AUDIO_STYLE_MODEL_EVIDENCE_DIR_NAME,
        ),
        local_data_dir.join(
            crate::domain::playlist_playback::recommendation::AUDIO_STYLE_TRAINING_INVALIDATION_ARTIFACT_FILE_NAME,
        ),
        local_data_dir.join(
            crate::domain::playlist_playback::recommendation::AUDIO_STYLE_PENDING_TRAINING_INPUT_ARTIFACT_FILE_NAME,
        ),
        local_data_dir.join(crate::domain::loudness_evidence::LOUDNESS_PENDING_TASK_FILE_NAME),
        local_data_dir.join(crate::domain::audio_tail_trim::AUDIO_TAIL_TRIM_PENDING_TASK_FILE_NAME),
    ]
}

#[cfg(not(test))]
pub(crate) fn cleanup_derived_state_for_blank_database(
    local_data_dir: &Path,
    app: &AppHandle,
) -> Result<(), String> {
    let mut reset_artifact_paths = Vec::new();
    reset_artifact_paths.extend(dev_reset_local_data_artifact_paths(local_data_dir));
    reset_artifact_paths.extend(dev_reset_cache_artifact_paths(app)?);
    remove_optional_artifacts(&reset_artifact_paths)
}

#[cfg(not(test))]
fn dev_reset_cache_artifact_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    crate::domain::playlist_playback::recommendation::audio_style_model_artifact_paths(app)
        .map_err(|error| error.to_string())
}

fn remove_optional_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove `{}`: {error}", path.display())),
    }
}

pub(crate) fn remove_optional_artifacts(paths: &[PathBuf]) -> Result<(), String> {
    for path in paths {
        remove_optional_artifact(path)?;
    }
    Ok(())
}

fn remove_optional_artifact(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)
            .map_err(|error| format!("failed to remove `{}`: {error}", path.display())),
        Ok(_) => remove_optional_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to inspect `{}`: {error}", path.display())),
    }
}

#[cfg(not(test))]
fn schedule_dev_reset_cleanup(paths: &[PathBuf]) -> Result<(), String> {
    spawn_delayed_reset_cleanup(std::process::id(), paths)
}

#[cfg(all(windows, not(test)))]
fn spawn_delayed_reset_cleanup(owner_pid: u32, paths: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let escaped_paths = paths
        .iter()
        .map(|path| format!("'{}'", escape_powershell_single_quoted(path)))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        "$paths = @({escaped_paths}); \
         try {{ Wait-Process -Id {owner_pid} -Timeout 30 -ErrorAction SilentlyContinue }} catch {{ }}; \
         $deadline = (Get-Date).AddSeconds(10); \
         do {{ \
             foreach ($path in $paths) {{ Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }}; \
             $remaining = @($paths | Where-Object {{ Test-Path -LiteralPath $_ }}); \
             if ($remaining.Count -eq 0) {{ break }}; \
             Start-Sleep -Milliseconds 200; \
         }} while ((Get-Date) -lt $deadline)"
    );

    Command::new("pwsh")
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
        .map_err(|error| format!("failed to schedule dev reset cleanup: {error}"))
}

#[cfg(all(not(windows), not(test)))]
fn spawn_delayed_reset_cleanup(owner_pid: u32, paths: &[PathBuf]) -> Result<(), String> {
    let escaped_paths = paths
        .iter()
        .map(|path| shell_single_quote(&path.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "while kill -0 {owner_pid} 2>/dev/null; do sleep 0.1; done; \
         sleep 0.3; \
         attempts=0; \
         while [ \"$attempts\" -lt 50 ]; do \
             remaining=0; \
             for path in {escaped_paths}; do rm -rf -- \"$path\"; [ -e \"$path\" ] && remaining=1; done; \
             [ \"$remaining\" -eq 0 ] && break; \
             attempts=$((attempts + 1)); \
             sleep 0.2; \
         done"
    );

    Command::new("sh")
        .args(["-c", &script])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to schedule dev reset cleanup: {error}"))
}

#[cfg(all(not(windows), not(test)))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(all(windows, not(test)))]
fn escape_powershell_single_quoted(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}
