use appdb::{Id, Store};
use serde::{Deserialize, Serialize};
use surrealdb::types::SurrealValue;

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store)]
pub struct User {
    pub id: Id,
}

impl User {
    pub fn from_id(id: impl Into<Id>) -> Self {
        Self { id: id.into() }
    }
}
