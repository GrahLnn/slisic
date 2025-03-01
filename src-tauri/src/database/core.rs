use async_trait::async_trait;
use futures::future::try_join_all;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use surrealdb::engine::local::{Db, SurrealKv};
use surrealdb::Surreal;
use surrealdb::{RecordId, RecordIdKey};
use thiserror::Error;
use tokio::sync::OnceCell;

static DB: LazyLock<OnceCell<Arc<Surreal<Db>>>> = LazyLock::new(|| OnceCell::new());

#[derive(Debug, Error)]
pub enum DBError {
    #[error("Database error: {0}")]
    SurrealError(#[from] surrealdb::Error),
    #[error("Database not initialized")]
    NotInitialized,
    #[error("Record not found")]
    NotFound,
}

pub type Result<T> = std::result::Result<T, DBError>;

pub async fn init_db(path: PathBuf) -> Result<()> {
    // 1) 创建 Surreal<Db>（异步）
    let db = Surreal::new::<SurrealKv>(path)
        .await
        .map_err(DBError::SurrealError)?;
    db.use_ns("quill")
        .use_db("quill")
        .await
        .map_err(DBError::SurrealError)?;

    // 2) 把它包装进 Arc，然后放进全局 OnceCell
    DB.set(Arc::new(db)).map_err(|_| DBError::NotInitialized)?;

    Ok(())
}

pub fn get_db() -> Result<Arc<Surreal<Db>>> {
    DB.get().cloned().ok_or(DBError::NotInitialized)
}

pub trait HasId {
    fn id(&self) -> RecordId;
}

#[async_trait]
pub trait Curd:
    Serialize + for<'de> Deserialize<'de> + std::fmt::Debug + 'static + Clone + Send + Sync
{
    const TABLE: &'static str;

    fn record_id<T>(id: T) -> RecordId
    where
        RecordIdKey: From<T>,
    {
        RecordId::from((Self::TABLE, id))
    }

    async fn create(data: Self) -> Result<Self> {
        let db = get_db()?;
        let created: Option<Self> = db.create(Self::TABLE).content(data).await?;
        created.ok_or(DBError::NotFound)
    }

    async fn create_by_id(id: &str, data: Self) -> Result<Self> {
        let db = get_db()?;
        let created: Option<Self> = db.create((Self::TABLE, id)).content(data).await?;
        created.ok_or(DBError::NotFound)
    }

    async fn create_or_update(id: &str, data: Self) -> Result<Self> {
        let db = get_db()?;
        let created = match db.create((Self::TABLE, id)).content(data.clone()).await {
            Ok(Some(record)) => Ok(record),
            Ok(None) => Err(DBError::NotFound),
            Err(_) => db
                .update((Self::TABLE, id))
                .content(data)
                .await?
                .ok_or(DBError::NotFound),
        };
        created
    }

    async fn select<T>(id: T) -> Result<Self>
    where
        RecordIdKey: From<T>,
        T: Send + 'static,
    {
        let db = get_db()?;
        let record: Option<Self> = db.select((Self::TABLE, id)).await?;
        record.ok_or(DBError::NotFound)
    }

    async fn select_record(record: RecordId) -> Result<Self> {
        let db = get_db()?;
        let record: Option<Self> = db.select(record).await?;
        record.ok_or(DBError::NotFound)
    }

    async fn select_all() -> Result<Vec<Self>> {
        let db = get_db()?;
        let records: Vec<Self> = db.select(Self::TABLE).await?;
        Ok(records)
    }

    async fn update(id: &str, data: Self) -> Result<Self> {
        let db = get_db()?;
        let updated: Option<Self> = db.update((Self::TABLE, id)).content(data).await?;
        updated.ok_or(DBError::NotFound)
    }

    async fn merge(id: Option<&str>, data: Self) -> Result<Self> {
        let db = get_db()?;
        let merged: Option<Self> = if let Some(id) = id {
            db.update((Self::TABLE, id)).merge(data).await?
        } else {
            db.update(Self::TABLE).merge(data).await?.into_iter().next() // TODO: 兼容Vec的返回
        };
        merged.ok_or(DBError::NotFound)
    }

    async fn insert(data: Vec<Self>) -> Result<Vec<Self>> {
        let db = get_db()?;
        let created: Vec<Self> = db.insert(Self::TABLE).content(data).await?;
        Ok(created)
    }

    async fn insert_with_id(data: Vec<Self>) -> Result<Vec<Self>>
    where
        Self: HasId,
    {
        let db = get_db()?;

        let chunk_size = 50_000;
        let chunk_vecs: Vec<Vec<Self>> = data.chunks(chunk_size).map(|c| c.to_vec()).collect();

        let insert_futures = chunk_vecs.into_iter().map(|chunk| {
            let db_clone = db.clone();
            async move {
                let inserted: Vec<Self> = db_clone
                    .query(format!(
                        "INSERT INTO {} $data ON DUPLICATE KEY UPDATE id = id",
                        Self::TABLE
                    ))
                    .bind(("data", chunk))
                    .await?
                    .take(0)?;
                Ok::<Vec<Self>, DBError>(inserted)
            }
        });

        let done: Vec<Vec<Self>> = try_join_all(insert_futures).await?;
        let done: Vec<Self> = done.into_iter().flatten().collect();
        Ok(done)
    }

    async fn delete(id: &str) -> Result<()> {
        let db = get_db()?;
        let _: Option<Self> = db.delete((Self::TABLE, id)).await?;
        Ok(())
    }

    async fn clean() -> Result<()> {
        let db = get_db()?;
        let _: Vec<Self> = db.delete(Self::TABLE).await?;
        Ok(())
    }

    async fn query(sql: &str) -> Result<()> {
        let db = get_db()?;
        db.query(sql).await?;
        Ok(())
    }

    async fn query_take(sql: &str, idx: Option<usize>) -> Result<Vec<Self>> {
        let db = get_db()?;
        let mut result = db.query(sql).await?;
        let records: Vec<Self> = result.take(idx.unwrap_or(0))?;
        Ok(records)
    }

    // async fn set(variable: &str, value: Self) -> Result<()> {
    //     let db = get_db()?;
    //     db.set(variable, value).await?;
    //     Ok(())
    // }

    // async fn unset(variable: &str) -> Result<()> {
    //     let db = get_db()?;
    //     db.unset(variable).await?;
    //     Ok(())
    // }
}

pub async fn query_take<T>(sql: &str, idx: Option<usize>) -> Result<Vec<T>>
where
    T: for<'de> Deserialize<'de> + 'static,
{
    let db = get_db()?;
    let mut result = db.query(sql).await?;
    let records: Vec<T> = result.take(idx.unwrap_or(0))?;
    Ok(records)
}
