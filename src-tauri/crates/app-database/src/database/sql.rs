use anyhow::Result;
use surrealdb::types::SurrealValue;
use surrealdb::IndexedResults;

use super::get_db;

pub struct RawSql;

impl RawSql {
    pub async fn query_unchecked(sql: &str) -> Result<IndexedResults> {
        let db = get_db()?;
        let result = db.query(sql).await?;
        Ok(result)
    }

    pub async fn query_checked(sql: &str) -> Result<IndexedResults> {
        let result = Self::query_unchecked(sql).await?;
        Ok(result.check()?)
    }

    pub async fn query_take_typed<T>(sql: &str, idx: Option<usize>) -> Result<Vec<T>>
    where
        T: SurrealValue + 'static,
    {
        let mut result = Self::query_checked(sql).await?;
        let records: Vec<T> = result.take(idx.unwrap_or(0))?;
        Ok(records)
    }

    pub async fn query_return_typed<T>(sql: &str) -> Result<Option<T>>
    where
        T: SurrealValue + 'static,
    {
        let mut result = Self::query_checked(sql).await?;
        let value: Option<T> = result.take(0)?;
        Ok(value)
    }
}

pub async fn query_raw(sql: &str) -> Result<IndexedResults> {
    RawSql::query_unchecked(sql).await
}

pub async fn query_checked(sql: &str) -> Result<IndexedResults> {
    RawSql::query_checked(sql).await
}

pub async fn query_take<T>(sql: &str, idx: Option<usize>) -> Result<Vec<T>>
where
    T: SurrealValue + 'static,
{
    RawSql::query_take_typed(sql, idx).await
}

pub async fn query_return<T>(sql: &str) -> Result<Option<T>>
where
    T: SurrealValue + 'static,
{
    RawSql::query_return_typed(sql).await
}
