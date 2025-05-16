use super::error::DBError;
use anyhow::Result;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use surrealdb::engine::local::{Db, SurrealKv};
use surrealdb::RecordId;
use surrealdb::Surreal;
use tokio::sync::OnceCell;

static DB: LazyLock<OnceCell<Arc<Surreal<Db>>>> = LazyLock::new(|| OnceCell::new());

pub async fn init_db(path: PathBuf) -> Result<()> {
    let db = Surreal::new::<SurrealKv>(path).await?;
    db.use_ns("app").use_db("app").await?;

    // let _ = db.query(QueryKind::InitAccess.as_str()).await?;
    DB.set(Arc::new(db)).map_err(|_| DBError::NotInitialized)?;
    Ok(())
}

pub fn get_db() -> Result<Arc<Surreal<Db>>> {
    DB.get().cloned().ok_or(DBError::NotInitialized.into())
}

pub trait HasId {
    fn id(&self) -> RecordId;
}
