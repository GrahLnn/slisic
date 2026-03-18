use appdb::Id;
use appdb::Store;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::{SystemTime, UNIX_EPOCH};
use surrealdb_types::SurrealValue;

#[derive(Debug, Serialize, Deserialize, Clone, Type, SurrealValue, Store)]
pub struct Member {
    pub id: Id,
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

    pub fn new(id: impl Into<Id>, name: impl Into<String>, role: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            role: role.into(),
            created_at: Self::now_timestamp_ms(),
        }
    }
}
