use tauri::ipc::InvokeError;
use thiserror::Error;

#[derive(Debug, Error, specta::Type)]
pub enum DBError {
    #[error("Database error: {0}")]
    SurrealError(String),
    #[error("Database not initialized")]
    NotInitialized,
    #[error("Record not found")]
    NotFound,
}

impl From<DBError> for InvokeError {
    fn from(err: DBError) -> Self {
        InvokeError::from(err.to_string())
    }
}

impl From<surrealdb::Error> for DBError {
    fn from(err: surrealdb::Error) -> Self {
        DBError::SurrealError(err.to_string())
    }
}

impl From<anyhow::Error> for DBError {
    fn from(err: anyhow::Error) -> Self {
        DBError::SurrealError(err.to_string())
    }
}
