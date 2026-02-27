use crate::{impl_crud, impl_schema};
use appdb::Id;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::{SystemTime, UNIX_EPOCH};
use surrealdb::types::SurrealValue;

pub const STATUS_TODO: &str = "todo";
pub const STATUS_DOING: &str = "doing";
pub const STATUS_DONE: &str = "done";

#[derive(Debug, Serialize, Deserialize, Clone, Type, SurrealValue)]
pub struct Task {
    pub id: Id,
    pub title: String,
    pub notes: String,
    pub status: String,
    pub priority: i64,
    pub owner_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Task {
    fn now_timestamp_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    pub fn new(
        id: impl Into<Id>,
        title: impl Into<String>,
        notes: impl Into<String>,
        status: impl Into<String>,
        priority: i64,
    ) -> Self {
        let now = Self::now_timestamp_ms();
        Self {
            id: id.into(),
            title: title.into(),
            notes: notes.into(),
            status: status.into(),
            priority,
            owner_id: None,
            created_at: now,
            updated_at: now,
        }
    }
}

impl_crud!(Task);
impl_schema!(
    Task,
    r#"
DEFINE TABLE task SCHEMAFULL;
DEFINE FIELD id ON TABLE task TYPE string | int;
DEFINE FIELD title ON TABLE task TYPE string;
DEFINE FIELD notes ON TABLE task TYPE string;
DEFINE FIELD status ON TABLE task TYPE string;
DEFINE FIELD priority ON TABLE task TYPE int;
DEFINE FIELD owner_id ON TABLE task TYPE option<string>;
DEFINE FIELD created_at ON TABLE task TYPE int;
DEFINE FIELD updated_at ON TABLE task TYPE int;
DEFINE INDEX task_unique_id ON TABLE task FIELDS id UNIQUE;
"#
);
