use super::enums::table::{Rel, Table};
use super::error::DBError;
use super::{get_db, HasId, QueryKind};
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use surrealdb::opt::PatchOp;
use surrealdb::{RecordId, RecordIdKey, Response};

fn struct_field_names<T: Serialize>(data: &T) -> Vec<String> {
    // serialize struct to serde_json::Value
    let value = serde_json::to_value(data).unwrap();
    match value {
        Value::Object(map) => map.keys().cloned().collect(),
        _ => vec![],
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Relation {
    #[serde(rename = "in")]
    pub _in: RecordId,
    pub out: RecordId,
}

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

    async fn create_return_id(&self) -> Result<RecordId> {
        let db = get_db()?;
        let created: Option<RecordId> = db
            .query(QueryKind::create_return_id(Self::TABLE))
            .bind(("data", self.clone()))
            .await?
            .take(0)?;
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

    async fn upsert_by_id(id: RecordId, data: Self) -> Result<Self> {
        let db = get_db()?;
        let updated: Option<Self> = db.upsert(id).content(data).await?;
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

    async fn update(self) -> Result<Self>
    where
        Self: HasId,
    {
        let id = self.clone().id();
        self.update_by_id(id).await
    }

    async fn update_by_id(self, id: RecordId) -> Result<Self> {
        let db = get_db()?;
        let updated: Option<Self> = db.update(id).content(self).await?;
        updated.ok_or(DBError::NotFound.into())
    }

    async fn merge(id: RecordId, data: Value) -> Result<Self> {
        let db = get_db()?;

        let merged: Option<Self> = db.update(id).merge(data).await?;
        merged.ok_or(DBError::NotFound.into())
    }

    async fn patch(id: RecordId, data: Vec<PatchOp>) -> Result<Self> {
        let db = get_db()?;

        // 如果 patch 操作的列表为空，则直接返回当前记录，避免不必要的操作
        if data.is_empty() {
            let record: Option<Self> = db.select(id).await?;
            return record.ok_or(DBError::NotFound.into());
        }

        // 将 Vec<PatchOp> 转换为迭代器
        let mut ops = data.into_iter();

        // 取出第一个操作，用它来完成从 `Update` 到 `Patch` 的类型转换。
        // 因为我们已经检查过 data 不为空，所以这里的 unwrap 是安全的。
        let first_op = ops.next().unwrap();
        let initial_patch_query = db.update(id).patch(first_op);

        // 使用 fold 来链式调用剩余的 patch 操作。
        // `initial_patch_query` 是累加器的初始值。
        // `query` 是上一次迭代的结果（一个 Patch 查询）。
        // `op` 是当前迭代的 PatchOp。
        // `query.patch(op)` 返回一个新的 Patch 查询，作为下一次迭代的 `query`。
        let final_query = ops.fold(initial_patch_query, |query, op| query.patch(op));

        // 执行最终构建好的查询
        let patched: Option<Self> = final_query.await?;

        // 返回结果
        patched.ok_or(DBError::NotFound.into())
    }

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
                .query(QueryKind::insert(Self::TABLE))
                .bind(("data", chunk_clone)) // Use the cloned chunk
                .await?
                .take(0)?;
            inserted_all.extend(inserted);
        }

        Ok(inserted_all)
    }

    async fn insert_relation(rel: Rel, data: Vec<Relation>) -> Result<Vec<Relation>> {
        let db = get_db()?;
        let relate: Vec<Relation> = db.insert(rel.as_str()).relation(data).await?;
        Ok(relate)
    }

    async fn insert_replace(data: Vec<Self>) -> Result<Vec<Self>> {
        let db = get_db()?;
        let chunk_size = 50_000;
        let mut inserted_all = Vec::with_capacity(data.len());
        let keys = struct_field_names(&data[0]);

        for chunk in data.chunks(chunk_size) {
            let chunk_clone = chunk.to_vec();
            let inserted: Vec<Self> = db
                .query(QueryKind::insert_replace(Self::TABLE, keys.clone()))
                .bind(("data", chunk_clone))
                .await?
                .take(0)?;
            inserted_all.extend(inserted);
            println!(
                "{} inserted: {}/{}",
                Self::TABLE,
                inserted_all.len(),
                data.len()
            );
        }

        Ok(inserted_all)
    }

    async fn delete(self) -> Result<()>
    where
        Self: HasId,
    {
        Self::delete_record(self.id()).await
    }

    async fn delete_by_idkey(id: &str) -> Result<()> {
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

    async fn relate_by_id(in_id: RecordId, out_id: RecordId, rel: Rel) -> Result<()> {
        let db = get_db()?;
        let sql = QueryKind::relate(in_id, out_id, rel);
        db.query(sql).await?;
        Ok(())
    }

    async fn unrelate_by_id(self_id: RecordId, target_id: RecordId, rel: Rel) -> Result<()> {
        let db = get_db()?;
        db.query(QueryKind::unrelate(self_id, target_id, rel))
            .await?;
        Ok(())
    }

    async fn unrelate_all(self_id: RecordId, rel: Rel) -> Result<()> {
        let db = get_db()?;
        db.query(QueryKind::unrelate_all(self_id, rel)).await?;
        Ok(())
    }

    async fn relate<T>(&self, target: T, rel: Rel) -> Result<()>
    where
        Self: HasId + Send + Sync,
        T: HasId + Send + Sync,
    {
        Self::relate_by_id(self.id(), target.id(), rel).await
    }

    async fn unrelate<T>(&self, target: T, rel: Rel) -> Result<()>
    where
        Self: HasId + Send + Sync,
        T: HasId + Send + Sync,
    {
        Self::unrelate_by_id(self.id(), target.id(), rel).await
    }

    async fn outs(in_id: RecordId, rel: Rel, out_table: Table) -> Result<Vec<RecordId>> {
        let sql = QueryKind::rel_outs(in_id, rel, out_table);
        query_take(sql.as_str(), None).await
    }

    async fn ins(out_id: RecordId, rel: Rel, in_table: Table) -> Result<Vec<RecordId>> {
        let sql = QueryKind::rel_ins(out_id, rel, in_table);
        query_take(sql.as_str(), None).await
    }

    async fn select_record_id(k: &str, v: &str) -> Result<RecordId> {
        let db = get_db()?;
        let ids: Vec<RecordId> = db
            .query("RETURN (SELECT id FROM ONLY type::table($table) WHERE type::field($k) = $v LIMIT 1).id;")
            .bind(("table", Self::TABLE.as_str()))
            .bind(("k", k.to_owned()))
            .bind(("v", v.to_owned()))
            .await?
            .take(0)?;
        let id = ids.into_iter().next();
        id.ok_or(DBError::NotFound.into())
    }

    async fn all_record() -> Result<Vec<RecordId>> {
        let sql = QueryKind::all_id(Self::TABLE);
        query_take(sql.as_str(), None).await
    }
}

pub async fn relate_by_id(in_id: RecordId, out_id: RecordId, rel: Rel) -> Result<()> {
    let db = get_db()?;
    db.query(QueryKind::relate(in_id, out_id, rel)).await?;
    Ok(())
}

pub async fn unrelate_by_id(self_id: RecordId, target_id: RecordId, rel: Rel) -> Result<()> {
    let db = get_db()?;
    db.query(QueryKind::unrelate(self_id, target_id, rel))
        .await?;
    Ok(())
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
