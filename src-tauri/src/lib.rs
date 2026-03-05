mod audio;
mod domain;
mod utils;

use domain::music;
use specta_typescript::Typescript;
use tauri::async_runtime::block_on;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};
use tokio::task::block_in_place;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_updater::UpdaterExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let commands = collect_commands![
        audio::audio_play,
        audio::audio_pause,
        audio::audio_resume,
        audio::audio_stop,
        audio::audio_status,
        audio::audio_debug_spectrogram,
        audio::audio_debug_pipeline_probe,
        utils::file::exists,
        utils::file::all_audio_recursive,
        utils::config::resolve_save_path,
        utils::config::update_save_path,
        utils::core::app_ready,
        utils::window::get_window_kind,
        utils::window::create_window,
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
        audio::AudioState,
        audio::AudioEnded,
        utils::event::FullScreenEvent,
        utils::ytdlp::ProcessResult,
        utils::ytdlp::YtdlpVersionChanged,
        music::types::ProcessMsg,
    ];

    let builder: Builder = Builder::new().commands(commands).events(events);

    #[cfg(debug_assertions)]
    builder
        .export(
            Typescript::default().header(
                r#"// @ts-nocheck
/* eslint-disable */

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
        .invoke_handler(builder.invoke_handler())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label().to_string();
                let app = window.app_handle();
                if utils::window::should_exit_on_window_close(&app, &label) {
                    utils::window::close_all_prewarm_windows(&app);
                    app.exit(0);
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            builder.mount_events(app);

            block_in_place(|| {
                block_on(async move {
                    domain::music::repo::init_repository(&handle).await?;

                    if let Some(window) = handle.get_webview_window("main") {
                        utils::window::apply_window_setup(&window, true);
                    }
                    utils::window::ensure_prewarm_for_existing_windows(&handle);
                    utils::ytdlp::spawn_ytdlp_auto_update(handle.clone());

                    Ok::<(), String>(())
                })
            })
            .map_err(|error| anyhow::anyhow!(error))?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[allow(dead_code)]
async fn update(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        let mut downloaded = 0;
        update
            .download_and_install(
                |chunk_length, content_length| {
                    downloaded += chunk_length;
                    println!("downloaded {downloaded} from {content_length:?}");
                },
                || {
                    println!("download finished");
                },
            )
            .await?;

        println!("update installed");
        app.restart();
    }

    Ok(())
}
