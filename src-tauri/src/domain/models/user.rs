use crate::database::enums::table::Table;
use crate::database::{Crud, HasId};
use crate::{impl_crud, impl_id, impl_schema};
use anyhow::Error;
use serde::{Deserialize, Serialize};
use specta::Type;
use surrealdb::RecordId;

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct User {
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DbUser {
    pub id: RecordId,
}

impl_crud!(DbUser, Table::User);
impl_id!(DbUser, id);
impl_schema!(
    User,
    "DEFINE INDEX unique_id ON TABLE user FIELDS id UNIQUE;"
);

impl DbUser {
    pub async fn into_model(self) -> Result<User, Error> {
        Ok(User {
            id: self.id.key().to_string(),
        })
    }

    pub async fn from_model(model: User) -> Result<Self, Error> {
        Ok(Self {
            id: RecordId::from((Self::TABLE.as_str(), model.id)),
        })
    }
}
