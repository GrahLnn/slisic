use super::enums::table::Table;
use super::error::DBError;
use super::Result;
use super::{get_db, HasId, QueryKind};

use async_trait::async_trait;
use futures::future::try_join_all;
use serde::{Deserialize, Serialize};
use surrealdb::{RecordId, RecordIdKey, Response};

#[async_trait]
pub trait Crud:
    Serialize + for<'de> Deserialize<'de> + std::fmt::Debug + 'static + Clone + Send + Sync
{
    const TABLE: Table;

    fn record_id<T>(id: T) -> RecordId
    where
        RecordIdKey: From<T>,
    {
        RecordId::from((Self::TABLE.as_str(), id))
    }

    async fn create(data: Self) -> Result<Self> {
        let db = get_db()?;
        let created: Option<Self> = db.create(Self::TABLE.as_str()).content(data).await?;
        created.ok_or(DBError::NotFound.into())
    }

    async fn create_by_id<T>(id: T, data: Self) -> Result<Self>
    where
        RecordIdKey: From<T>,
        T: Send + 'static,
    {
        let db = get_db()?;
        let created: Option<Self> = db.create((Self::TABLE.as_str(), id)).content(data).await?;
        created.ok_or(DBError::NotFound.into())
    }

    async fn create_or_update(id: &str, data: Self) -> Result<Self> {
        let db = get_db()?;
        let created = match db
            .create((Self::TABLE.as_str(), id))
            .content(data.clone())
            .await
        {
            Ok(Some(record)) => Ok(record),
            Ok(None) => Err(DBError::NotFound.into()),
            Err(_) => db
                .update((Self::TABLE.as_str(), id))
                .content(data)
                .await?
                .ok_or(DBError::NotFound.into()),
        };
        created
    }

    async fn select<T>(id: T) -> Result<Self>
    where
        RecordIdKey: From<T>,
        T: Send + 'static,
    {
        let db = get_db()?;
        let record: Option<Self> = db.select((Self::TABLE.as_str(), id)).await?;
        record.ok_or(DBError::NotFound.into())
    }

    async fn select_record(record: RecordId) -> Result<Self> {
        let db = get_db()?;
        let record: Option<Self> = db.select(record).await?;
        record.ok_or(DBError::NotFound.into())
    }

    async fn select_all() -> Result<Vec<Self>> {
        let db = get_db()?;
        let records: Vec<Self> = db.select(Self::TABLE.as_str()).await?;
        Ok(records)
    }

    async fn update(id: &str, data: Self) -> Result<Self> {
        let db = get_db()?;
        let updated: Option<Self> = db.update((Self::TABLE.as_str(), id)).content(data).await?;
        updated.ok_or(DBError::NotFound.into())
    }

    async fn merge(id: Option<&str>, data: Self) -> Result<Self> {
        let db = get_db()?;
        let merged: Option<Self> = if let Some(id) = id {
            db.update((Self::TABLE.as_str(), id)).merge(data).await?
        } else {
            db.update(Self::TABLE.as_str())
                .merge(data)
                .await?
                .into_iter()
                .next() // TODO: 兼容Vec的返回
        };
        merged.ok_or(DBError::NotFound.into())
    }

    async fn insert(data: Vec<Self>) -> Result<Vec<Self>> {
        let db = get_db()?;
        let created: Vec<Self> = db.insert(Self::TABLE.as_str()).content(data).await?;
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
                    .query(QueryKind::insert(Self::TABLE.as_str()))
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
        let _: Option<Self> = db.delete((Self::TABLE.as_str(), id)).await?;
        Ok(())
    }

    async fn clean() -> Result<()> {
        let db = get_db()?;
        let _: Vec<Self> = db.delete(Self::TABLE.as_str()).await?;
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

    async fn range_select(start: i64, end: i64) -> Result<Vec<Self>> {
        let db = get_db()?;
        let mut result = db
            .query(QueryKind::range(Self::TABLE, start, end))
            .await?;
        let records: Vec<Self> = result.take(0)?;
        Ok(records)
    }
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

pub async fn query_return<T>(sql: &str) -> Result<Option<T>>
where
    T: for<'de> Deserialize<'de> + 'static,
{
    let db = get_db()?;
    let mut result = db.query(sql).await?;
    let value: Option<T> = result.take(0)?;
    Ok(value)
}

pub async fn query_raw(sql: &str) -> Result<Response> {
    let db = get_db()?;
    let result = db.query(sql).await?;
    Ok(result)
}
