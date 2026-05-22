#[cfg(not(test))]
pub mod cmd;
pub mod model;
pub mod recommendation;
pub mod service;

#[cfg(not(test))]
pub use cmd::*;

#[cfg(test)]
#[path = "service.test.rs"]
mod service_test;

#[cfg(test)]
#[path = "recommendation.test.rs"]
mod recommendation_test;
