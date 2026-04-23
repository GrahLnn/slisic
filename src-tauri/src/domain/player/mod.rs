#[cfg(not(test))]
pub mod cmd;

#[cfg(not(test))]
pub mod event;
pub mod model;
pub mod service;
pub mod strategy;

#[cfg(not(test))]
pub use cmd::*;

#[cfg(test)]
#[path = "service.test.rs"]
mod service_test;

#[cfg(test)]
#[path = "strategy.test.rs"]
mod strategy_test;
