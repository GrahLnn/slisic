use crate::{impl_crud, impl_schema};
use app_database::{deserialize_string_or_record_id, serialize_string_id};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::{SystemTime, UNIX_EPOCH};
use surrealdb::types::SurrealValue;

#[derive(Debug, Serialize, Deserialize, Clone, Type, SurrealValue)]
pub struct Member {
    #[serde(
        deserialize_with = "deserialize_string_or_record_id",
        serialize_with = "serialize_string_id"
    )]
    pub id: String,
    pub name: String,
    pub role: String,
    pub created_at: i64,
}

impl Member {
    fn now_timestamp_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    pub fn new(id: impl Into<String>, name: impl Into<String>, role: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            role: role.into(),
            created_at: Self::now_timestamp_ms(),
        }
    }
}

impl_crud!(Member);
impl_schema!(
    Member,
    r#"
DEFINE TABLE member SCHEMAFULL;
DEFINE FIELD id ON TABLE member TYPE string;
DEFINE FIELD name ON TABLE member TYPE string;
DEFINE FIELD role ON TABLE member TYPE string;
DEFINE FIELD created_at ON TABLE member TYPE int;
DEFINE INDEX member_unique_id ON TABLE member FIELDS id UNIQUE;
"#
);
