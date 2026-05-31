#[cfg(not(test))]
pub mod cmd;
pub mod model;
pub mod repo;
pub mod startup_bootstrap;

#[cfg(not(test))]
pub use cmd::*;

#[cfg(test)]
pub(crate) static PLAYLIST_DB_TEST_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

#[cfg(test)]
#[path = "model.test.rs"]
mod model_test;

#[cfg(test)]
#[path = "repo.test.rs"]
mod repo_test;

#[cfg(test)]
#[path = "startup_bootstrap.test.rs"]
mod startup_bootstrap_test;
