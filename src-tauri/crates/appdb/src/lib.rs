extern crate self as appdb;

pub mod auth;
pub mod connection;
pub mod crypto;
pub mod database;
pub mod error;
pub mod graph;
pub mod model;
pub mod query;
pub mod repository;
pub mod serde_utils;
pub mod tx;

pub use appdb_macros::Sensitive;
pub use auth::*;
pub use connection::*;
pub use crypto::*;
pub use error::*;
pub use graph::*;
pub use model::meta::*;
pub use model::relation::*;
pub use model::schema::*;
pub use query::builder::*;
pub use query::sql::*;
pub use repository::*;
pub use serde_utils::id::*;
pub use surrealdb::types::{RecordId, Table};
pub use tx::*;

pub trait Sensitive: Sized {
    type Encrypted;

    fn encrypt(
        &self,
        context: &crate::crypto::CryptoContext,
    ) -> Result<Self::Encrypted, crate::crypto::CryptoError>;

    fn decrypt(
        encrypted: &Self::Encrypted,
        context: &crate::crypto::CryptoContext,
    ) -> Result<Self, crate::crypto::CryptoError>;
}
