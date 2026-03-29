use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tauri::path::BaseDirectory;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, specta::Type)]
pub struct BunSidecarOutput {
    pub ok: bool,
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn resolve_hello_entry(app: &AppHandle) -> std::result::Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let dev_entry = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar-bun/hello.ts");
        if dev_entry.exists() {
            return Ok(dev_entry);
        }
    }

    app.path()
        .resolve("sidecar-bun/hello.ts", BaseDirectory::Resource)
        .map_err(|err: tauri::Error| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn run_bun_hello_sidecar(
    app: AppHandle,
    input: Option<String>,
) -> std::result::Result<BunSidecarOutput, String> {
    let entry = resolve_hello_entry(&app)?;
    let value = input.unwrap_or_else(|| "hello".to_string());

    let output = app
        .shell()
        .sidecar("bun-runtime")
        .map_err(|err| err.to_string())?
        .arg(entry.to_string_lossy().to_string())
        .arg(value)
        .output()
        .await
        .map_err(|err| err.to_string())?;

    let stdout = String::from_utf8(output.stdout).map_err(|err| err.to_string())?;
    let stderr = String::from_utf8(output.stderr).map_err(|err| err.to_string())?;

    Ok(BunSidecarOutput {
        ok: output.status.success(),
        status: output.status.code(),
        stdout: stdout.trim().to_owned(),
        stderr: stderr.trim().to_owned(),
    })
}
