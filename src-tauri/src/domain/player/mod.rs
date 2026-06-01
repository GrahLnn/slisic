#[cfg(not(test))]
pub mod cmd;

#[cfg(not(test))]
pub mod event;
pub mod model;
pub mod service;
pub mod strategy;
pub mod track_identity_substitution;
pub mod waveform;

#[cfg(not(test))]
pub use cmd::*;

#[cfg(test)]
#[path = "strategy.test.rs"]
mod strategy_test;

#[cfg(test)]
#[path = "track_identity_substitution.test.rs"]
mod track_identity_substitution_test;

#[cfg(test)]
#[path = "service.test.rs"]
mod service_test;

#[cfg(test)]
#[path = "waveform.test.rs"]
mod waveform_test;
