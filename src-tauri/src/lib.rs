mod domain;

mod utils;

#[cfg(not(test))]
mod app;

#[cfg(not(test))]
pub use app::run;
