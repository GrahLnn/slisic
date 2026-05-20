use crate::{domain, utils};
use appdb::prelude::{InitDbOptions, init_db_with_options};
use tauri::Manager;
use tauri::async_runtime::block_on;
use tauri_specta::{Builder, collect_commands, collect_events};
use tokio::task::block_in_place;
use utils::event;

const COMMANDS_TYPESCRIPT_HEADER: &str = include_str!("commands.header.ts");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::new()
        .commands(collect_commands![
            utils::file::exists,
            utils::core::app_ready,
            utils::core::reset_dev_database_and_restart,
            utils::window::get_mouse_and_window_position,
            utils::window::get_window_kind,
            utils::window::warm_window,
            utils::window::cold_window,
            utils::window::prewarm_window,
            utils::window::discard_prewarm_window,
            utils::window::record_renderer_bootstrap_ready,
            utils::window::create_window,
            utils::sidecar::run_bun_hello_sidecar,
            domain::meta::get_meta_info,
            domain::meta::save_meta_info,
            domain::playlists::check_list,
            domain::playlists::list_collections,
            domain::playlists::list_playlists,
            domain::playlists::list_config_library,
            domain::playlists::get_collection,
            domain::playlists::get_playlist,
            domain::playlists::get_playlist_config,
            domain::playlists::delete_playlist,
            domain::playlists::upsert_playlist,
            domain::playlists::set_collection_updates,
            domain::playlists::update_music,
            domain::playlists::create_music,
            domain::playlists::delete_music,
            domain::playlists::list_musics_by_file_path,
            domain::playlists::load_spectrum_music_context,
            domain::playlists::add_exclude,
            domain::playlists::remove_exclude,
            domain::playlist_playback::play_playlist,
            domain::playlist_playback::exclude_current_music_and_skip,
            domain::player::set_playback_continuation_mode,
            domain::player::enter_spectrum_playback_scope,
            domain::player::exit_spectrum_playback_scope,
            domain::player::stop_playback,
            domain::player::pause_playback,
            domain::player::resume_playback,
            domain::player::play_spectrum_music,
            domain::player::restore_spectrum_music,
            domain::player::pause_spectrum_music,
            domain::player::resume_spectrum_music,
            domain::player::update_spectrum_playback_loop_signal,
            domain::player::begin_playback_seek,
            domain::player::cancel_playback_seek,
            domain::player::seek_playback,
            domain::player::get_playback_status,
            domain::player::analyze_track_waveform,
            domain::player::prepare_track_waveform,
            domain::player::get_track_waveform_tile,
            domain::downloads::enqueue_collection_download,
            domain::downloads::probe_download_resource,
            domain::downloads::resolve_pasted_download_url,
            domain::downloads::resume_download_task,
            domain::downloads::get_download_task,
            domain::downloads::list_download_tasks,
        ])
        .events(collect_events![
            event::FullScreenEvent,
            utils::hardware_wheel::HardwareHorizontalWheelEvent,
            domain::player::event::NowPlayingTrackChangedEvent
        ]);

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default().header(COMMANDS_TYPESCRIPT_HEADER),
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
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if utils::window::should_exit_on_window_close(&app, &label) {
                        api.prevent_close();
                        utils::window::begin_graceful_shutdown(&app, &label);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    utils::window::handle_window_destroyed(&app, &label);
                }
                _ => {}
            }
        })
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            let handle = app.handle().clone();
            builder.mount_events(app);
            block_in_place(|| {
                block_on(async move {
                    let local_data_dir = handle.path().app_local_data_dir()?;
                    std::fs::create_dir_all(&local_data_dir)?;
                    let db_path = local_data_dir.join(utils::core::APP_DB_FILE_NAME);
                    println!("DB initialized on {}", db_path.display());
                    let db_options = InitDbOptions::default()
                        .versioned(false)
                        .changefeed_gc_interval(None);
                    init_db_with_options(db_path, db_options).await?;

                    utils::window::configure_existing_primary_windows(&handle);
                    domain::downloads::service::initialize_runtime(handle.clone());
                    domain::player::service::initialize_runtime(handle.clone());
                    utils::binaries::spawn_binary_maintenance(
                        handle.clone(),
                        utils::binaries::BinaryMaintenanceActivity::new(
                            domain::player::service::has_active_player_binary_tasks,
                            domain::downloads::service::has_active_download_tasks,
                        ),
                    );
                    Ok(())
                })
            })
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
