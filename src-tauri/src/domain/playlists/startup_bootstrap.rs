use super::model::{Collection, ConfigLibraryView, PlayListListView};
#[cfg(not(test))]
use crate::domain::meta;
#[cfg(not(test))]
use appdb::error::{DBError, classify_db_error};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(test))]
use std::time::Instant;
#[cfg(not(test))]
use tauri::AppHandle;

const STARTUP_BOOTSTRAP_LOG_TARGET: &str = "playlist_startup_bootstrap";

static STARTUP_BOOTSTRAP: OnceLock<Arc<Mutex<StartupBootstrapState>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlaylistStartupBootstrap {
    pub has_playlist: bool,
    pub playlists: Vec<PlayListListView>,
    pub collections: Vec<Collection>,
    pub config_library: ConfigLibraryView,
    pub save_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "status", content = "value")]
pub enum PlaylistStartupBootstrapSnapshot {
    Pending,
    Ready(PlaylistStartupBootstrap),
    Error(String),
}

#[derive(Debug, Clone)]
enum StartupBootstrapState {
    Pending,
    Ready(PlaylistStartupBootstrap),
    Error(String),
}

impl StartupBootstrapState {
    fn snapshot(&self) -> PlaylistStartupBootstrapSnapshot {
        match self {
            Self::Pending => PlaylistStartupBootstrapSnapshot::Pending,
            Self::Ready(value) => PlaylistStartupBootstrapSnapshot::Ready(value.clone()),
            Self::Error(error) => PlaylistStartupBootstrapSnapshot::Error(error.clone()),
        }
    }
}

#[cfg(not(test))]
pub fn initialize_runtime(app: AppHandle) {
    let runtime = STARTUP_BOOTSTRAP
        .get_or_init(|| Arc::new(Mutex::new(StartupBootstrapState::Pending)))
        .clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        log::info!(
            target: STARTUP_BOOTSTRAP_LOG_TARGET,
            "playlist_startup_bootstrap_started"
        );
        let next = match load_startup_bootstrap(&app).await {
            Ok(bootstrap) => {
                log::info!(
                    target: STARTUP_BOOTSTRAP_LOG_TARGET,
                    "playlist_startup_bootstrap_ready has_playlist={} playlists={} collections={} elapsed_ms={}",
                    bootstrap.has_playlist,
                    bootstrap.playlists.len(),
                    bootstrap.config_library.collections.len(),
                    started.elapsed().as_millis()
                );
                StartupBootstrapState::Ready(bootstrap)
            }
            Err(error) => {
                log::error!(
                    target: STARTUP_BOOTSTRAP_LOG_TARGET,
                    "playlist_startup_bootstrap_failed elapsed_ms={} error=\"{}\"",
                    started.elapsed().as_millis(),
                    error
                );
                StartupBootstrapState::Error(error)
            }
        };

        match runtime.lock() {
            Ok(mut state) => *state = next,
            Err(_) => log::error!(
                target: STARTUP_BOOTSTRAP_LOG_TARGET,
                "playlist_startup_bootstrap_commit_failed error=\"lock_poisoned\""
            ),
        }
    });
}

pub fn snapshot() -> PlaylistStartupBootstrapSnapshot {
    STARTUP_BOOTSTRAP
        .get()
        .and_then(|runtime| runtime.lock().ok().map(|state| state.snapshot()))
        .unwrap_or(PlaylistStartupBootstrapSnapshot::Pending)
}

#[cfg(not(test))]
async fn load_startup_bootstrap(app: &AppHandle) -> Result<PlaylistStartupBootstrap, String> {
    let save_path = meta::service::default_save_root(app)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .to_string();
    meta::repo::ensure_meta_info(save_path.clone())
        .await
        .map_err(|error| error.to_string())?;

    let has_playlist = match super::repo::has_collections().await {
        Ok(value) => value,
        Err(error) => match classify_db_error(&error) {
            DBError::MissingTable(_) => false,
            other => return Err(other.to_string()),
        },
    };

    if !has_playlist {
        return Ok(PlaylistStartupBootstrap {
            has_playlist: false,
            playlists: vec![],
            collections: vec![],
            config_library: empty_config_library(),
            save_path,
        });
    }

    let playlists = super::repo::list_playlists()
        .await
        .map_err(|error| error.to_string())?;
    let config_library = super::repo::list_config_library()
        .await
        .map_err(|error| error.to_string())?;

    Ok(PlaylistStartupBootstrap {
        has_playlist: true,
        playlists,
        collections: vec![],
        config_library,
        save_path,
    })
}

#[cfg(not(test))]
fn empty_config_library() -> ConfigLibraryView {
    ConfigLibraryView {
        collections: vec![],
        groups: vec![],
        collection_group_memberships: vec![],
        excludes: vec![],
        exclude_availability: super::model::ExcludeAvailability {
            fully_excluded_collection_urls: vec![],
            fully_excluded_group_urls: vec![],
        },
    }
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    if let Some(runtime) = STARTUP_BOOTSTRAP.get()
        && let Ok(mut state) = runtime.lock()
    {
        *state = StartupBootstrapState::Pending;
    }
}

#[cfg(test)]
pub(crate) fn publish_for_test(bootstrap: PlaylistStartupBootstrap) {
    let runtime = STARTUP_BOOTSTRAP
        .get_or_init(|| Arc::new(Mutex::new(StartupBootstrapState::Pending)))
        .clone();
    *runtime
        .lock()
        .expect("startup bootstrap test lock should not be poisoned") =
        StartupBootstrapState::Ready(bootstrap);
}
