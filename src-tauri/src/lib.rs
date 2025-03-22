mod database;
mod domain;
mod utils;

use anyhow::Result;
use database::core::{init_db, Curd};
use domain::models::user::DbUser;
use futures::future;
use specta_typescript::{formatter::prettier, Typescript};
use tauri::async_runtime::block_on;
use tauri::Manager;
use tauri_specta::{collect_commands, Builder};
use tokio::task::block_in_place;

const DB_PATH: &str = "surreal.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder: Builder = Builder::new().commands(collect_commands![greet, clean]);

    #[cfg(debug_assertions)]
    builder
        .export(
            Typescript::default()
                .formatter(prettier)
                .header("/* eslint-disable */"),
            "../src/cmd/commands.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let handle = app.handle().clone();

            block_in_place(|| {
                block_on(async move {
                    let local_data_dir = handle.path().app_local_data_dir()?;
                    let db_path = local_data_dir.join(DB_PATH);
                    init_db(db_path).await?;
                    Ok(())
                })
            })
        })
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
#[specta::specta]
async fn greet(name: &str) -> Result<String, String> {
    let _ = DbUser::insert_with_id(vec![DbUser {
        id: DbUser::record_id(name),
    }])
    .await
    .map_err(|e| e.to_string())?;
    let dbusers = DbUser::select_all().await.map_err(|e| e.to_string())?;

    let futures = dbusers.into_iter().map(|u| u.into_model());
    let users = future::try_join_all(futures)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!(
        "Hello, {}! You've been greeted from Rust!",
        users
            .iter()
            .map(|u| u.id.as_str())
            .collect::<Vec<&str>>()
            .join(", ")
    ))
}

#[tauri::command]
#[specta::specta]
async fn clean() -> Result<String, String> {
    DbUser::clean().await.map_err(|e| e.to_string())?;
    Ok("message cleaned".to_string())
}
