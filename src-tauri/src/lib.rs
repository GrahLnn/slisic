mod database;
mod domain;
mod utils;

use crate::{
    domain::models::music::fix_cur_data,
    utils::{
        enq::init_global_download_queue,
        ytdlp::{auto_resume_mission, spawn_ytdlp_auto_update},
    },
};
use anyhow::Result;
use database::{init_db, Crud};
use domain::models::music;
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

#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use utils::macos_titlebar::FullscreenStateManager;
#[cfg(target_os = "macos")]
thread_local! {
    static MAIN_WINDOW_OBSERVER: RefCell<Option<FullscreenStateManager>> = RefCell::new(None);
}
#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
#[cfg(target_os = "windows")]
use windows::core::Interface;

const DB_PATH: &str = "surreal.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let commands = collect_commands![
        utils::file::exists,
        utils::file::all_audio_recursive,
        utils::config::resolve_save_path,
        utils::config::update_save_path,
        utils::core::app_ready,
        utils::window::get_mouse_and_window_position,
        utils::ytdlp::ytdlp_download_and_install,
        utils::ytdlp::ytdlp_check_update,
        utils::ytdlp::check_exists,
        utils::ytdlp::github_ok,
        utils::ytdlp::look_media,
        utils::ytdlp::test_download_audio,
        utils::ffmpeg::ffmpeg_check_update,
        utils::ffmpeg::ffmpeg_download_and_install,
        utils::ffmpeg::ffmpeg_version,
        utils::ffmpeg::ffmpeg_check_exists,
        music::create,
        music::read,
        music::read_all,
        music::update,
        music::delete,
        music::fatigue,
        music::boost,
        music::cancle_boost,
        music::cancle_fatigue,
        music::unstar,
        music::reset_logits,
        music::delete_music,
        music::recheck_folder,
        music::rmexclude,
        music::update_weblist,
    ];
    let events = collect_events![
        event::FullScreenEvent,
        utils::ytdlp::ProcessResult,
        utils::ytdlp::YtdlpVersionChanged,
        music::ProcessMsg
    ];

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
            let _ = init_global_download_queue(handle.clone(), /*capacity*/ 1024);
            builder.mount_events(app);
            let _ = auto_resume_mission(handle.clone());

            block_in_place(|| {
                block_on(async move {
                    let local_data_dir = handle.path().app_local_data_dir()?;
                    let db_path = local_data_dir.join(DB_PATH);
                    println!("DB initialized on {}", db_path.display());
                    init_db(db_path).await?;
                    // fix_cur_data().await?;
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

                        #[cfg(target_os = "windows")]
                        {
                            window.set_decorations(false).unwrap();
                            window
                                .with_webview(|webview| unsafe {
                                    let core = webview.controller().CoreWebView2().unwrap();
                                    let settings = core.Settings().unwrap();
                                    let s4: ICoreWebView2Settings4 = settings.cast().unwrap(); // 提升到 Settings4
                                    s4.SetIsGeneralAutofillEnabled(false).unwrap();
                                    s4.SetIsPasswordAutosaveEnabled(false).unwrap();
                                })
                                .expect("disable autofill");
                        }
                        #[cfg(target_os = "macos")]
                        {
                            use objc2::MainThreadMarker;
                            use utils::macos_titlebar;
                            macos_titlebar::setup_custom_macos_titlebar(&window);

                            // Manage the FullscreenObserver's lifetime.
                            // This is a bit tricky because you need to store it somewhere
                            // so it doesn't get dropped immediately.
                            // One way is to put it in Tauri's state management if you have complex needs,
                            // or for a single main window, you might 'leak' it if it needs to live
                            // for the duration of the app and its Drop impl handles cleanup.
                            // A better way is to have a struct that holds it and is managed by Tauri's state.
                            if let Some(mtm) = MainThreadMarker::new() {
                                // Get MTM for the observer
                                if let Some(observer) =
                                    macos_titlebar::FullscreenStateManager::new(&window, mtm)
                                {
                                    // How to store `observer`?
                                    // Option 1: Put it in Tauri's managed state
                                    MAIN_WINDOW_OBSERVER.with(|cell| {
                                        let mut observer_ref = cell.borrow_mut();
                                        *observer_ref = Some(observer);
                                    });
                                // Option 2: If you absolutely must leak it (less ideal, but works for app lifetime objects)
                                // std::mem::forget(observer);
                                // println!("Fullscreen observer created and forgotten (will live for app duration).");
                                } else {
                                    eprintln!("Failed to create FullscreenObserver.");
                                }
                            } else {
                                eprintln!(
                                    "Failed to get MainThreadMarker for FullscreenObserver setup."
                                );
                            }

                            // Example: Listening for window events to re-hide traffic lights if needed (alternative to FullscreenObserver for other events)
                            let window_clone = window.clone();
                            window.on_window_event(move |event| {
                                match event {
                                    tauri::WindowEvent::Resized(_) => { // Or other relevant events
                                         // This is a more generic way, but NSWindowDidExitFullScreenNotification is more specific
                                         // For instance, if some other action makes them reappear.
                                         // #[cfg(target_os = "macos")]
                                         // {
                                         //     if let Some(mtm) = MainThreadMarker::new() {
                                         //         let ns_window_ptr = window_clone.ns_window().unwrap_or(std::ptr::null_mut()) as *mut objc2_app_kit::NSWindow;
                                         //         if !ns_window_ptr.is_null() {
                                         //             if let Some(ns_window_id) = unsafe { Id::retain(ns_window_ptr) } {
                                         //                 // unsafe { macos_titlebar::hide_native_traffic_lights(&ns_window_id, mtm); }
                                         //             }
                                         //         }
                                         //     }
                                         // }
                                    }
                                    _ => {}
                                }
                            });
                        }
                    }
                    Ok(())
                })
            })
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
