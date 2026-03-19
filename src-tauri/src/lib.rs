mod audio;
mod domain;
mod utils;

use anyhow::Result;

use audio::{
    audio_debug_pipeline_probe, audio_debug_spectrogram, audio_pause, audio_play, audio_resume,
    audio_status, audio_stop, AudioEnded, AudioFailed, AudioPaused, AudioResumed, AudioState,
    AudioStopped,
};
use domain::music;
use music::{
    boost, bootstrap_normalization, cancle_boost, cancle_fatigue, create, delete, delete_music,
    fatigue, playlist_names, read, read_all, recheck_folder, reset_logits, rmexclude, unstar,
    update_weblist, ClosureLifecycleFact, ProcessMsg,
};
use specta_typescript::BigIntExportBehavior;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};
use utils::config::{resolve_save_path, update_save_path};
use utils::core::app_ready;
use utils::event::FullScreenEvent;
use utils::ffmpeg::{
    ffmpeg_check_exists, ffmpeg_check_update, ffmpeg_download_and_install, ffmpeg_version,
};
use utils::file::{all_audio_recursive, collect_import_folder_entries, exists};
use utils::window::{create_window, get_mouse_and_window_position, get_window_kind};
use utils::ytdlp::{
    check_exists, github_ok, look_media, spawn_ytdlp_auto_update, test_download_audio,
    ytdlp_check_update, ytdlp_download_and_install, ProcessResult, YtdlpVersionChanged,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_updater::UpdaterExt;

pub fn run() {
    run_app().expect("error while running tauri application");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn run_app() -> Result<()> {
    let commands = collect_commands![
        audio_play,
        audio_pause,
        audio_resume,
        audio_stop,
        audio_status,
        audio_debug_spectrogram,
        audio_debug_pipeline_probe,
        exists,
        all_audio_recursive,
        collect_import_folder_entries,
        resolve_save_path,
        update_save_path,
        app_ready,
        get_window_kind,
        create_window,
        get_mouse_and_window_position,
        ytdlp_download_and_install,
        ytdlp_check_update,
        check_exists,
        github_ok,
        look_media,
        test_download_audio,
        ffmpeg_check_update,
        ffmpeg_download_and_install,
        ffmpeg_version,
        ffmpeg_check_exists,
        create,
        read,
        playlist_names,
        read_all,
        music::update,
        delete,
        fatigue,
        boost,
        cancle_boost,
        cancle_fatigue,
        unstar,
        reset_logits,
        delete_music,
        recheck_folder,
        rmexclude,
        update_weblist,
        bootstrap_normalization,
    ];

    let events = collect_events![
        AudioState,
        AudioEnded,
        AudioStopped,
        AudioPaused,
        AudioResumed,
        AudioFailed,
        ClosureLifecycleFact,
        FullScreenEvent,
        ProcessResult,
        YtdlpVersionChanged,
        ProcessMsg,
    ];

    let builder: Builder = Builder::new().commands(commands).events(events);

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default()
                .bigint(BigIntExportBehavior::Number)
                .header(
                    r#"/* eslint-disable */

type __WebviewWindow__ =
  | import("@tauri-apps/api/webview").Webview
  | import("@tauri-apps/api/window").Window;

type __EventObj__<T> = {
  listen: (cb: (event: { payload: T }) => void) => Promise<() => void>;
  once: (cb: (event: { payload: T }) => void) => Promise<() => void>;
  emit: T extends null ? () => Promise<void> : (payload: T) => Promise<void>;
};

export type EventsShape<T extends Record<string, any>> = {
  [K in keyof T]: __EventObj__<T[K]> & {
    (handle: __WebviewWindow__): __EventObj__<T[K]>;
  };
};

export function makeLiveEvent<T extends Record<string, any>>(ev: EventsShape<T>) {
  return function liveEvent<K extends keyof T>(key: K) {
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
            let label = window.label().to_string();
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    if utils::window::should_exit_on_window_close(&app, &label) {
                        utils::window::close_all_prewarm_windows(&app);
                        app.exit(0);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    let _ = utils::window::handle_window_destroyed(&label);
                }
                _ => {}
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            builder.mount_events(app);
            domain::music::repo::install_repository_app(handle.clone());

            if let Some(window) = handle.get_webview_window("main") {
                utils::window::apply_window_setup(&window, true);
            }
            utils::window::ensure_prewarm_for_existing_windows(&handle);
            spawn_ytdlp_auto_update(handle.clone());

            Ok(())
        })
        .run(tauri::generate_context!())?;

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::run_app;

    #[test]
    fn default_rust_test_surface_uses_fallible_runner_boundary() {
        let runner = run_app;

        let _ = runner;
    }
}
