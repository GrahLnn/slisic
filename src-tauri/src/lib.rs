mod database;
mod domain;
mod utils;

use anyhow::Result;
use database::{init_db, Crud};
use domain::models::user::DbUser;
use futures::future;
use specta_typescript::{formatter::prettier, Typescript};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::async_runtime::block_on;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};
use tokio::task::block_in_place;
use tokio::time::sleep;
use utils::event::{self, WINDOW_READY};

const DB_PATH: &str = "surreal.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let commands = collect_commands![
        utils::file::exists,
        utils::core::app_ready,
        utils::window::get_mouse_and_window_position,
        utils::window::create_window,
        greet,
        clean,
    ];
    let events = collect_events![event::FullScreenEvent];

    let builder: Builder = Builder::new().commands(commands).events(events);

    #[cfg(debug_assertions)]
    builder
        .export(
            Typescript::default().formatter(prettier).header(
                r#"/* eslint-disable */

export type EventsShape<T extends Record<string, any>> = {
  [K in keyof T]: __EventObj__<T[K]> & {
    (handle: __WebviewWindow__): __EventObj__<T[K]>;
  };
};

export function makeLievt<T extends Record<string, any>>(ev: EventsShape<T>) {
  return function lievt<K extends keyof T>(key: K) {
    return (handler: (payload: T[K]) => void) => {
      const obj = ev[key] as __EventObj__<T[K]>;
      return obj.listen((e) => handler(e.payload));
    };
  };
}
"#,
            ),
            "../src/cmd/commands.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            let handle = app.handle().clone();
            builder.mount_events(app);
            block_in_place(|| {
                block_on(async move {
                    let local_data_dir = handle.path().app_local_data_dir()?;
                    let db_path = local_data_dir.join(DB_PATH);
                    println!("DB initialized on {}", db_path.display());
                    init_db(db_path).await?;

                    if let Some(window) = handle.get_webview_window("main") {
                        tokio::spawn({
                            let window = window.clone();
                            async move {
                                sleep(Duration::from_secs(5)).await;
                                if !window.is_visible().unwrap_or(true) {
                                    // This happens if the JS bundle crashes and hence doesn't send ready event.
                                    println!(
                                        "Window did not emit `app_ready` event fast enough. Showing window..."
                                    );
                                    window.show().expect("Main window should show");
                                    WINDOW_READY.store(true, Ordering::SeqCst);
                                }
                            }
                        });

                        utils::window::apply_window_setup(&window, true);
                    }
                    Ok(())
                })
            })
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
#[specta::specta]
async fn greet(name: &str) -> Result<String, String> {
    let _ = DbUser::insert_jump(vec![DbUser {
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
