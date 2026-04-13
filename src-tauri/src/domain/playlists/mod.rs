pub mod cmd;
pub mod model;
pub mod repo;
pub use cmd::*;

#[cfg(test)]
pub(crate) static PLAYLIST_DB_TEST_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

#[cfg(test)]
#[path = "cmd.test.rs"]
mod cmd_test;

#[cfg(test)]
#[path = "model.test.rs"]
mod model_test;

#[cfg(test)]
#[path = "repo.test.rs"]
mod repo_test;
