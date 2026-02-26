use crate::{impl_crud, impl_schema};
use serde::{Deserialize, Serialize};
use surrealdb::types::SurrealValue;

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue)]
pub struct User {
    pub id: String,
}

impl_crud!(User);
impl_schema!(
    User,
    "DEFINE INDEX unique_id ON TABLE user FIELDS id UNIQUE;"
);

impl User {
    pub fn from_id(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}
