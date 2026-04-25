#[cfg(not(test))]
pub mod cmd;
pub mod model;
pub mod naming;
pub mod repo;
pub mod service;
pub mod yt_dlp;

#[cfg(not(test))]
pub use cmd::*;

#[cfg(test)]
#[path = "model.test.rs"]
mod model_test;

#[cfg(test)]
#[path = "repo.test.rs"]
mod repo_test;

#[cfg(test)]
#[path = "service.test.rs"]
mod service_test;

#[cfg(test)]
#[path = "yt_dlp.test.rs"]
mod yt_dlp_test;
