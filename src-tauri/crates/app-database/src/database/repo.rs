use std::marker::PhantomData;

use anyhow::Result;
use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use surrealdb::opt::PatchOp;
use surrealdb::types::{RecordId, RecordIdKey, ToSql};

use super::error::DBError;
use super::meta::{HasId, HasStringId, ModelMeta};
use super::query::QueryKind;
use super::{get_db, query_take};

fn struct_field_names<T: Serialize>(data: &T) -> Result<Vec<String>> {
    let value = serde_json::to_value(data)?;
    match value {
        Value::Object(map) => Ok(map.keys().cloned().collect()),
        _ => Ok(vec![]),
    }
}

fn is_valid_identifier(input: &str) -> bool {
    let mut chars = input.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

pub struct Repo<T>(PhantomData<T>);

impl<T> Repo<T>
where
    T: ModelMeta,
{
    pub async fn create(data: T) -> Result<T> {
        let db = get_db()?;
        let created: Option<T> = db.create(T::TABLE.as_str()).content(data).await?;
        created.ok_or(DBError::NotFound.into())
    }

    pub async fn create_return_id(data: T) -> Result<RecordId> {
        let db = get_db()?;
        let created: Option<RecordId> = db
            .query(QueryKind::create_return_id(T::TABLE))
            .bind(("data", data))
            .await?
            .take(0)?;
        created.ok_or(DBError::NotFound.into())
    }

    pub async fn create_by_id<K>(id: K, data: T) -> Result<T>
    where
        RecordIdKey: From<K>,
        K: Send,
    {
        let db = get_db()?;
        let created: Option<T> = db.create((T::TABLE.as_str(), id)).content(data).await?;
        created.ok_or(DBError::NotFound.into())
    }

    pub async fn upsert(data: T) -> Result<T>
    where
        T: HasId,
    {
        let db = get_db()?;
        let updated: Option<T> = db.upsert(data.id()).content(data).await?;
        updated.ok_or(DBError::NotFound.into())
    }

    pub async fn upsert_by_id(id: RecordId, data: T) -> Result<T> {
        let db = get_db()?;
        let updated: Option<T> = db.upsert(id).content(data).await?;
        updated.ok_or(DBError::NotFound.into())
    }

    pub async fn select<K>(id: K) -> Result<T>
    where
        RecordIdKey: From<K>,
        K: Send,
    {
        let db = get_db()?;
        let record: Option<T> = db.select((T::TABLE.as_str(), id)).await?;
        record.ok_or(DBError::NotFound.into())
    }

    pub async fn select_record(record: RecordId) -> Result<T> {
        let db = get_db()?;
        let record: Option<T> = db.select(record).await?;
        record.ok_or(DBError::NotFound.into())
    }

    pub async fn select_all_unbounded() -> Result<Vec<T>> {
        let db = get_db()?;
        let records: Vec<T> = db.select(T::TABLE.as_str()).await?;
        Ok(records)
    }

    pub async fn select_limit(count: i64) -> Result<Vec<T>> {
        let db = get_db()?;
        let records: Vec<T> = db.query(QueryKind::limit(T::TABLE, count)).await?.take(0)?;
        Ok(records)
    }

    pub async fn update_by_id(id: RecordId, data: T) -> Result<T> {
        let db = get_db()?;
        let updated: Option<T> = db.update(id).content(data).await?;
        updated.ok_or(DBError::NotFound.into())
    }

    pub async fn merge(id: RecordId, data: Value) -> Result<T> {
        let db = get_db()?;
        let merged: Option<T> = db.update(id).merge(data).await?;
        merged.ok_or(DBError::NotFound.into())
    }

    pub async fn patch(id: RecordId, data: Vec<PatchOp>) -> Result<T> {
        let db = get_db()?;

        if data.is_empty() {
            let record: Option<T> = db.select(id).await?;
            return record.ok_or(DBError::NotFound.into());
        }

        let mut ops = data.into_iter();
        let first_op = ops.next().expect("non-empty patch ops");
        let initial_patch_query = db.update(id).patch(first_op);
        let final_query = ops.fold(initial_patch_query, |query, op| query.patch(op));
        let patched: Option<T> = final_query.await?;
        patched.ok_or(DBError::NotFound.into())
    }

    pub async fn insert(data: Vec<T>) -> Result<Vec<T>> {
        let db = get_db()?;
        let created: Vec<T> = db.insert(T::TABLE.as_str()).content(data).await?;
        Ok(created)
    }

    pub async fn insert_jump(data: Vec<T>) -> Result<Vec<T>> {
        let db = get_db()?;
        let chunk_size = 50_000;
        let mut inserted_all = Vec::with_capacity(data.len());

        for chunk in data.chunks(chunk_size) {
            let chunk_clone = chunk.to_vec();
            let inserted: Vec<T> = db
                .query(QueryKind::insert(T::TABLE))
                .bind(("data", chunk_clone))
                .await?
                .take(0)?;
            inserted_all.extend(inserted);
        }

        Ok(inserted_all)
    }

    pub async fn insert_replace(data: Vec<T>) -> Result<Vec<T>> {
        if data.is_empty() {
            return Ok(vec![]);
        }

        let db = get_db()?;
        let chunk_size = 50_000;
        let mut inserted_all = Vec::with_capacity(data.len());
        let keys = struct_field_names(&data[0])?;

        for chunk in data.chunks(chunk_size) {
            let chunk_clone = chunk.to_vec();
            let inserted: Vec<T> = db
                .query(QueryKind::insert_replace(T::TABLE, keys.clone()))
                .bind(("data", chunk_clone))
                .await?
                .take(0)?;
            inserted_all.extend(inserted);
            println!(
                "{} inserted: {}/{}",
                T::TABLE,
                inserted_all.len(),
                data.len()
            );
        }

        Ok(inserted_all)
    }

    pub async fn delete_by_key<K>(id: K) -> Result<()>
    where
        RecordIdKey: From<K>,
        K: Send,
    {
        let record = RecordId::new(T::TABLE.as_str(), id);
        Self::delete_record(record).await
    }

    pub async fn delete_record(id: RecordId) -> Result<()> {
        let db = get_db()?;
        let sql = format!("DELETE {} RETURN NONE;", id.to_sql());
        db.query(sql).await?.check()?;
        Ok(())
    }

    pub async fn clean() -> Result<()> {
        let db = get_db()?;
        let sql = format!("DELETE {} RETURN NONE;", T::TABLE.as_str());
        db.query(sql).await?.check()?;
        Ok(())
    }

    pub async fn select_record_id(k: &str, v: &str) -> Result<RecordId> {
        let db = get_db()?;
        if !is_valid_identifier(k) {
            return Err(anyhow::anyhow!("invalid field name: {k}"));
        }
        let sql = format!(
            "RETURN (SELECT id FROM ONLY {} WHERE {k} = $v LIMIT 1).id;",
            T::TABLE.as_str()
        );
        let ids: Vec<RecordId> = db.query(sql).bind(("v", v.to_owned())).await?.take(0)?;
        let id = ids.into_iter().next();
        id.ok_or(DBError::NotFound.into())
    }

    pub async fn all_record() -> Result<Vec<RecordId>> {
        let sql = QueryKind::all_id(T::TABLE);
        query_take(sql.as_str(), None).await
    }
}

impl<T> Repo<T>
where
    T: ModelMeta + HasStringId,
{
    pub async fn upsert_by_string_id(data: T) -> Result<T> {
        let db = get_db()?;
        let table = T::TABLE.as_str();
        let sql = format!(
            "UPSERT type::record('{table}', $id) CONTENT object::del($data, 'id');
RETURN (SELECT *, type::string(record::id(id)) AS id FROM ONLY type::record('{table}', $id))[0];"
        );
        let mut result = db
            .query(sql)
            .bind(("id", data.id_str().to_owned()))
            .bind(("data", data))
            .await?
            .check()?;
        let row: Option<T> = result.take(1)?;
        row.ok_or(DBError::NotFound.into())
    }

    pub async fn select_by_string_id(id: &str) -> Result<T> {
        let db = get_db()?;
        let table = T::TABLE.as_str();
        let sql = format!(
            "RETURN (SELECT *, type::string(record::id(id)) AS id FROM ONLY type::record('{table}', $id))[0];"
        );
        let mut result = db.query(sql).bind(("id", id.to_owned())).await?.check()?;
        let row: Option<T> = result.take(0)?;
        row.ok_or(DBError::NotFound.into())
    }

    pub async fn select_all_string_id() -> Result<Vec<T>> {
        let db = get_db()?;
        let table = T::TABLE.as_str();
        let sql = format!("SELECT *, type::string(record::id(id)) AS id FROM {table};");
        let mut result = db.query(sql).await?.check()?;
        let rows: Vec<T> = result.take(0)?;
        Ok(rows)
    }

    pub async fn select_limit_string_id(count: i64) -> Result<Vec<T>> {
        let db = get_db()?;
        let table = T::TABLE.as_str();
        let sql =
            format!("SELECT *, type::string(record::id(id)) AS id FROM {table} LIMIT $count;");
        let mut result = db.query(sql).bind(("count", count)).await?.check()?;
        let rows: Vec<T> = result.take(0)?;
        Ok(rows)
    }

    pub async fn insert_jump_string_id(data: Vec<T>) -> Result<Vec<T>> {
        if data.is_empty() {
            return Ok(vec![]);
        }

        let mut inserted_all = Vec::with_capacity(data.len());
        let chunk_size = 5_000;

        for chunk in data.chunks(chunk_size) {
            for row in chunk.iter().cloned() {
                let inserted = Self::upsert_by_string_id(row).await?;
                inserted_all.push(inserted);
            }
        }

        Ok(inserted_all)
    }
}

#[async_trait]
pub trait Crud: ModelMeta {
    fn record_id<T>(id: T) -> RecordId
    where
        RecordIdKey: From<T>,
    {
        <Self as ModelMeta>::record_id(id)
    }

    async fn create(&self) -> Result<Self> {
        Repo::<Self>::create(self.clone()).await
    }

    async fn create_return_id(&self) -> Result<RecordId> {
        Repo::<Self>::create_return_id(self.clone()).await
    }

    async fn create_by_id<T>(id: T, data: Self) -> Result<Self>
    where
        RecordIdKey: From<T>,
        T: Send,
    {
        Repo::<Self>::create_by_id(id, data).await
    }

    async fn upsert(&self) -> Result<Self>
    where
        Self: HasId,
    {
        Repo::<Self>::upsert(self.clone()).await
    }

    async fn upsert_by_id(id: RecordId, data: Self) -> Result<Self> {
        Repo::<Self>::upsert_by_id(id, data).await
    }

    async fn select<T>(id: T) -> Result<Self>
    where
        RecordIdKey: From<T>,
        T: Send,
    {
        Repo::<Self>::select(id).await
    }

    async fn select_record(record: RecordId) -> Result<Self> {
        Repo::<Self>::select_record(record).await
    }

    async fn select_all_unbounded() -> Result<Vec<Self>> {
        Repo::<Self>::select_all_unbounded().await
    }

    async fn select_all() -> Result<Vec<Self>> {
        Self::select_all_unbounded().await
    }

    async fn select_limit(count: i64) -> Result<Vec<Self>> {
        Repo::<Self>::select_limit(count).await
    }

    async fn update(self) -> Result<Self>
    where
        Self: HasId,
    {
        Repo::<Self>::update_by_id(self.id(), self).await
    }

    async fn update_by_id(self, id: RecordId) -> Result<Self> {
        Repo::<Self>::update_by_id(id, self).await
    }

    async fn merge(id: RecordId, data: Value) -> Result<Self> {
        Repo::<Self>::merge(id, data).await
    }

    async fn patch(id: RecordId, data: Vec<PatchOp>) -> Result<Self> {
        Repo::<Self>::patch(id, data).await
    }

    async fn insert(data: Vec<Self>) -> Result<Vec<Self>> {
        Repo::<Self>::insert(data).await
    }

    async fn insert_jump(data: Vec<Self>) -> Result<Vec<Self>> {
        Repo::<Self>::insert_jump(data).await
    }

    async fn insert_replace(data: Vec<Self>) -> Result<Vec<Self>> {
        Repo::<Self>::insert_replace(data).await
    }

    async fn delete(self) -> Result<()>
    where
        Self: HasId,
    {
        Repo::<Self>::delete_record(self.id()).await
    }

    async fn delete_by_key<T>(id: T) -> Result<()>
    where
        RecordIdKey: From<T>,
        T: Send,
    {
        Repo::<Self>::delete_by_key(id).await
    }

    async fn delete_by_idkey(id: &str) -> Result<()> {
        Self::delete_by_key(id).await
    }

    async fn delete_record(id: RecordId) -> Result<()> {
        Repo::<Self>::delete_record(id).await
    }

    async fn clean() -> Result<()> {
        Repo::<Self>::clean().await
    }

    async fn select_record_id(k: &str, v: &str) -> Result<RecordId> {
        Repo::<Self>::select_record_id(k, v).await
    }

    async fn all_record() -> Result<Vec<RecordId>> {
        Repo::<Self>::all_record().await
    }
}

#[macro_export]
macro_rules! impl_crud {
    ($t:ty, $table:expr) => {
        impl $crate::database::meta::ModelMeta for $t {
            const TABLE: $crate::database::enums::table::Table = $table;
        }

        impl $crate::database::repo::Crud for $t {}
    };
}
