use specta_typescript::Typescript;
use std::time::Duration;
use tauri::{async_runtime::block_on, Manager};
use tauri_specta::{collect_commands, Builder};
use tokio::task::block_in_place;
use tokio::time::sleep;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder: Builder = Builder::new().commands(collect_commands![greet]);

    #[cfg(debug_assertions)]
    builder
        .export(
            Typescript::default()
                .formatter(specta_typescript::formatter::prettier)
                .header("/* eslint-disable */"),
            "../src/commands.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            let handle = app.handle().clone();
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            block_in_place(|| {
                block_on(async move {
                    handle.windows().iter().for_each(|(_, window)| {
                        tokio::spawn({
                            let window = window.clone();
                            async move {
                                sleep(Duration::from_secs(3)).await;
                                if !window.is_visible().unwrap_or(true) {
                                    // This happens if the JS bundle crashes and hence doesn't send ready event.
                                    println!(
                            "Window did not emit `app_ready` event fast enough. Showing window..."
                          );
                                    window.show().expect("Main window should show");
                                }
                            }
                        });

                        #[cfg(target_os = "windows")]
                        window.set_decorations(false).unwrap();

                        #[cfg(target_os = "macos")]
                        {
                            unsafe {
                                sd_desktop_macos::set_titlebar_style(
                                    &window.ns_window().expect("NSWindows must exist on macOS"),
                                    false,
                                );
                                sd_desktop_macos::disable_app_nap(
                                    &"File indexer needs to run unimpeded".into(),
                                );
                            };
                        }
                    });

                    Ok(())
                })
            })
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
#[specta::specta]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
