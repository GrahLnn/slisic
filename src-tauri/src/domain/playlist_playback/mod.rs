#[cfg(not(test))]
pub mod cmd;
pub mod model;
pub mod playable_index;
pub mod recommendation;
pub mod service;
pub(crate) mod temporal_memory;

#[cfg(not(test))]
pub use cmd::*;

#[cfg(test)]
#[path = "service.test.rs"]
mod service_test;

#[cfg(test)]
#[path = "recommendation.test.rs"]
mod recommendation_test;

#[cfg(test)]
#[path = "playable_index.test.rs"]
mod playable_index_test;

#[cfg(test)]
#[path = "temporal_memory.test.rs"]
mod temporal_memory_test;
