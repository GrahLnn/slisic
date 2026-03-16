use crate::impl_crud;
use appdb::Id;
use serde::{Deserialize, Serialize};
use surrealdb::types::SurrealValue;

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue)]
pub struct User {
    pub id: Id,
}

impl_crud!(User);

impl User {
    pub fn from_id(id: impl Into<Id>) -> Self {
        Self { id: id.into() }
    }
}
