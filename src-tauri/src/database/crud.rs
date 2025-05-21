use super::enums::table::Table;
use super::error::DBError;
use super::{get_db, HasId, QueryKind};
use anyhow::Result;
use async_trait::async_trait;
use futures::future::try_join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
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

    async fn create(&self) -> Result<Self> {
        let db = get_db()?;
        let created: Option<Self> = db
            .create(Self::TABLE.as_str())
            .content(self.clone())
            .await?;
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

    async fn upsert(&self) -> Result<Self>
    where
        Self: HasId,
    {
        let db = get_db()?;
        let updated: Option<Self> = db.upsert(self.id()).content(self.clone()).await?;
        updated.ok_or(DBError::NotFound.into())
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

    async fn select_limit(count: i64) -> Result<Vec<Self>> {
        let db = get_db()?;
        let records: Vec<Self> = db
            .query(QueryKind::limit(Self::TABLE, count))
            .await?
            .take(0)?;
        Ok(records)
    }

    async fn update(id: RecordId, data: Self) -> Result<Self>
    where
        Self: HasId,
    {
        let db = get_db()?;
        let updated: Option<Self> = db.update(id).content(data).await?;
        updated.ok_or(DBError::NotFound.into())
    }

    async fn merge(id: RecordId, data: Value) -> Result<Self> {
        let db = get_db()?;

        let merged: Option<Self> = db.update(id).merge(data).await?;
        merged.ok_or(DBError::NotFound.into())
    }

    // async fn patch(id: RecordId, data: Value) -> Result<Self> {
    //     let db = get_db()?;

    //     let patched: Option<Self> = db.update(id).patch(data).await?;
    //     patched.ok_or(DBError::NotFound.into())
    // }

    // async fn replace(id: RecordId, data: Value) -> Result<Self> {
    //     let replaced: Option<Self> = Self::query_take(&QueryKind::replace(id, data), None)
    //         .await?
    //         .into_iter()
    //         .next();
    //     replaced.ok_or(DBError::NotFound.into())
    // }

    async fn insert(data: Vec<Self>) -> Result<Vec<Self>> {
        let db = get_db()?;
        let created: Vec<Self> = db.insert(Self::TABLE.as_str()).content(data).await?;
        Ok(created)
    }

    async fn insert_jump(data: Vec<Self>) -> Result<Vec<Self>>
    where
        Self: HasId,
    {
        let db = get_db()?;
        let chunk_size = 50_000;
        let mut inserted_all = Vec::with_capacity(data.len());

        // 順序处理，每次只持有一个 Vec
        for chunk in data.chunks(chunk_size) {
            let chunk_clone = chunk.to_vec(); // Clone the chunk to ensure it lives long enough
            let inserted: Vec<Self> = db
                .query(QueryKind::insert(Self::TABLE.as_str()))
                .bind(("data", chunk_clone)) // Use the cloned chunk
                .await?
                .take(0)?;
            inserted_all.extend(inserted);
        }

        Ok(inserted_all)
    }

    async fn delete(id: &str) -> Result<()> {
        let db = get_db()?;
        let _: Option<Self> = db.delete((Self::TABLE.as_str(), id)).await?;
        Ok(())
    }

    async fn delete_record(id: RecordId) -> Result<()> {
        let db = get_db()?;
        let _: Option<Self> = db.delete(id).await?;
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

    async fn query_response(sql: &str) -> Result<Response> {
        let db = get_db()?;
        db.query(sql)
            .await
            .map_err(|e| anyhow::anyhow!("query error: {}", e))
    }

    async fn query_take(sql: &str, idx: Option<usize>) -> Result<Vec<Self>> {
        let db = get_db()?;
        let mut result = db.query(sql).await?;
        let records: Vec<Self> = result.take(idx.unwrap_or(0))?;
        Ok(records)
    }

    async fn range_select(start: i64, end: i64) -> Result<Vec<Self>> {
        let db = get_db()?;
        let mut result = db.query(QueryKind::range(Self::TABLE, start, end)).await?;
        let records: Vec<Self> = result.take(0)?;
        Ok(records)
    }

    async fn relate_by_id(self_id: RecordId, target_id: RecordId, rel: &str) -> Result<()> {
        let db = get_db()?;
        let sql = format!("RELATE {self_id}->{rel}->{target_id};");
        db.query(&sql).await?;
        Ok(())
    }

    async fn unrelate_by_id(self_id: RecordId, target_id: RecordId, rel: &str) -> Result<()> {
        let db = get_db()?;
        let sql = format!("DELETE {self_id}->{rel} WHERE out={target_id} RETURN NONE;");
        db.query(&sql).await?;
        Ok(())
    }

    async fn relate<T>(&self, target: T, rel: &str) -> Result<()>
    where
        Self: HasId + Send + Sync,
        T: HasId + Send + Sync,
    {
        Self::relate_by_id(self.id(), target.id(), rel).await
    }

    async fn unrelate<T>(&self, target: T, rel: &str) -> Result<()>
    where
        Self: HasId + Send + Sync,
        T: HasId + Send + Sync,
    {
        Self::unrelate_by_id(self.id(), target.id(), rel).await
    }

    async fn select_record_id(k: &str, v: &str) -> Result<RecordId> {
        let sql = QueryKind::select_id_single(Self::TABLE, k, v);
        let ids: Vec<RecordId> = query_take(sql.as_str(), None).await?;
        let id = ids.into_iter().next();
        id.ok_or(DBError::NotFound.into())
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

#[macro_export]
macro_rules! impl_crud {
    ($t:ty, $table:expr) => {
        impl Crud for $t {
            const TABLE: Table = $table;
        }
    };
}

#[macro_export]
macro_rules! impl_id {
    ($t:ty, $id:ident) => {
        impl HasId for $t {
            fn id(&self) -> RecordId {
                self.$id.clone()
            }
        }
    };
    ($t:ty, $($path:tt)+) => {
        impl HasId for $t {
            fn id(&self) -> RecordId {
                self.$($path)+.clone()
            }
        }
    };
}

pub struct TxStmt {
    pub sql: String,
    pub bindings: BTreeMap<String, Value>,
}

impl TxStmt {
    /// 构造一个新的 SQL 语句
    pub fn new<S: Into<String>>(sql: S) -> Self {
        Self {
            sql: sql.into(),
            bindings: BTreeMap::new(),
        }
    }

    /// 绑定一个值（会被序列化为 JSON）
    pub fn bind<K: Into<String>, V: Serialize>(mut self, key: K, val: V) -> Self {
        let v = serde_json::to_value(val).expect("Serialize to Value should never fail");
        self.bindings.insert(key.into(), v);
        self
    }
}

pub async fn run_tx(stmts: Vec<TxStmt>) -> Result<Response> {
    let db = get_db()?;
    // 开始事务
    let mut chain = db.query("BEGIN");

    // 链式拼接每条语句
    for stmt in stmts {
        let mut q = chain.query(&stmt.sql);
        for (k, v) in stmt.bindings {
            // 直接把 serde_json::Value 传进去
            q = q.bind((k, v));
        }
        chain = q;
    }

    // 提交事务
    let resp = chain.query("COMMIT").await?;
    // 检查 SQL 层面错误（若发生，会自动 CANCEL）
    let resp = resp.check()?;
    Ok(resp)
}
