mod domain;
mod utils;

pub use app_database::database;
pub use app_database::{declare_relation, impl_crud, impl_id, impl_schema};

use anyhow::Result;
use database::{init_db_with_options, InitDbOptions, Repo};
use domain::models::user::User;
use domain::template;
use specta_typescript::{formatter::prettier, BigIntExportBehavior, Typescript};
use tauri::async_runtime::block_on;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};
use tokio::task::block_in_place;
use utils::event;

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
        template::template_bootstrap,
        template::template_snapshot,
        template::template_create_member,
        template::template_create_task,
        template::template_assign_task,
        template::template_unassign_task,
        template::template_bulk_set_status,
        template::template_reset,
    ];
    let events = collect_events![event::FullScreenEvent];

    let builder: Builder = Builder::new().commands(commands).events(events);

    #[cfg(debug_assertions)]
    builder
        .export(
            Typescript::default()
                .bigint(BigIntExportBehavior::Number)
                .formatter(prettier)
                .header(
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
                    std::fs::create_dir_all(&local_data_dir)?;
                    let db_path = local_data_dir.join(DB_PATH);
                    println!("DB initialized on {}", db_path.display());
                    let db_options = InitDbOptions::default()
                        .versioned(false)
                        .changefeed_gc_interval(None);
                    init_db_with_options(db_path, db_options).await?;

                    if let Some(window) = handle.get_webview_window("main") {
                        utils::window::apply_window_setup(&window, true);
                    }
                    utils::window::ensure_main_window_prewarm(&handle);
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
    let _ = Repo::<User>::insert_jump_string_id(vec![User::from_id(name)])
        .await
        .map_err(|e| e.to_string())?;
    let users = Repo::<User>::select_all_string_id()
        .await
        .map_err(|e| e.to_string())?;

    let ids = users
        .iter()
        .map(|u| u.id.as_str())
        .collect::<Vec<&str>>()
        .join(", ");

    Ok(format!("Hello, {}! You've been greeted from Rust!", ids))
}

#[tauri::command]
#[specta::specta]
async fn clean() -> Result<String, String> {
    Repo::<User>::clean().await.map_err(|e| e.to_string())?;
    Ok("message cleaned".to_string())
}
