use crate::database::core::{Curd, HasId};
use crate::domain::enums::table::Table;
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

impl Curd for DbUser {
    const TABLE: &'static str = Table::User.as_str();
}

impl HasId for DbUser {
    fn id(&self) -> RecordId {
        self.id.clone()
    }
}

impl DbUser {
    pub async fn into_model(self) -> Result<User, Error> {
        Ok(User {
            id: self.id.key().to_string(),
        })
    }

    pub async fn from_model(model: User) -> Result<Self, Error> {
        Ok(Self {
            id: RecordId::from((Self::TABLE, model.id)),
        })
    }
}
