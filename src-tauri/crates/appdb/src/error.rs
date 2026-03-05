use thiserror::Error;

#[derive(Debug, Error)]
pub enum DBError {
    #[error("SurrealDB error: {0}")]
    Surreal(String),
    #[error("Query response error: {0}")]
    QueryResponse(String),
    #[error("Database not initialized")]
    NotInitialized,
    #[error("Database has already been initialized")]
    AlreadyInitialized,
    #[error("Record not found")]
    NotFound,
    #[error("Empty result from database operation: {0}")]
    EmptyResult(&'static str),
    #[error("Invalid identifier: {0}")]
    InvalidIdentifier(String),
    #[error("Invalid model shape: {0}")]
    InvalidModel(String),
}

impl From<surrealdb::Error> for DBError {
    fn from(err: surrealdb::Error) -> Self {
        DBError::Surreal(err.to_string())
    }
}

impl From<anyhow::Error> for DBError {
    fn from(err: anyhow::Error) -> Self {
        DBError::Surreal(err.to_string())
    }
}
