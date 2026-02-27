use std::marker::PhantomData;

use anyhow::Result;
use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use surrealdb::opt::PatchOp;
use surrealdb::types::{RecordId, RecordIdKey, Table};

use crate::connection::get_db;
use crate::error::DBError;
use crate::model::meta::{HasId, ModelMeta};
use crate::query::builder::QueryKind;

fn struct_field_names<T: Serialize>(data: &T) -> Result<Vec<String>> {
    let value = serde_json::to_value(data)?;
    match value {
        Value::Object(map) => Ok(map.keys().cloned().collect()),
        _ => Ok(vec![]),
    }
}

fn strip_null_fields(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let null_keys = map
                .iter()
                .filter_map(|(key, value)| {
                    if value.is_null() {
                        Some(key.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();

            for key in null_keys {
                map.remove(&key);
            }

            for nested in map.values_mut() {
                strip_null_fields(nested);
            }
        }
        Value::Array(items) => {
            for nested in items {
                strip_null_fields(nested);
            }
        }
        _ => {}
    }
}

fn extract_string_id<T: Serialize>(data: &T) -> Result<String> {
    let value = serde_json::to_value(data)?;
    match value {
        Value::Object(map) => match map.get("id") {
            Some(Value::String(id)) if !id.is_empty() => Ok(id.clone()),
            Some(_) => Err(DBError::InvalidModel(format!(
                "model `{}` has `id` but it is not a non-empty string",
                std::any::type_name::<T>()
            ))
            .into()),
            None => Err(DBError::InvalidModel(format!(
                "model `{}` does not contain an `id` string field",
                std::any::type_name::<T>()
            ))
            .into()),
        },
        _ => Err(DBError::InvalidModel(format!(
            "model `{}` must serialize to an object",
            std::any::type_name::<T>()
        ))
        .into()),
    }
}

pub struct Repo<T>(PhantomData<T>);

impl<T> Repo<T>
where
    T: ModelMeta,
{
    pub async fn create(data: T) -> Result<T> {
        let db = get_db()?;
        let created: Option<T> = db.create(T::table_name()).content(data).await?;
        created.ok_or(DBError::EmptyResult("create").into())
    }

    pub async fn create_return_id(data: T) -> Result<RecordId> {
        let db = get_db()?;
        let created: Option<RecordId> = db
            .query(QueryKind::create_return_id(T::table_name()))
            .bind(("table", Table::from(T::table_name())))
            .bind(("data", data))
            .await?
            .check()?
            .take(0)?;
        created.ok_or(DBError::EmptyResult("create_return_id").into())
    }

    pub async fn create_by_id<K>(id: K, data: T) -> Result<T>
    where
        RecordIdKey: From<K>,
        K: Send,
    {
        let db = get_db()?;
        let created: Option<T> = db.create((T::table_name(), id)).content(data).await?;
        created.ok_or(DBError::EmptyResult("create_by_id").into())
    }

    pub async fn upsert(data: T) -> Result<T>
    where
        T: HasId,
    {
        let db = get_db()?;
        let updated: Option<T> = db.upsert(data.id()).content(data).await?;
        updated.ok_or(DBError::EmptyResult("upsert").into())
    }

    pub async fn upsert_by_id(id: RecordId, data: T) -> Result<T> {
        let db = get_db()?;
        let updated: Option<T> = db.upsert(id).content(data).await?;
        updated.ok_or(DBError::EmptyResult("upsert_by_id").into())
    }

    pub async fn select<K>(id: K) -> Result<T>
    where
        RecordIdKey: From<K>,
        K: Send,
    {
        let db = get_db()?;
        let record: Option<T> = db.select((T::table_name(), id)).await?;
        record.ok_or(DBError::NotFound.into())
    }

    pub async fn select_record(record: RecordId) -> Result<T> {
        let db = get_db()?;
        let record: Option<T> = db.select(record).await?;
        record.ok_or(DBError::NotFound.into())
    }

    pub async fn select_all_unbounded() -> Result<Vec<T>> {
        let db = get_db()?;
        let records: Vec<T> = db.select(T::table_name()).await?;
        Ok(records)
    }

    pub async fn select_limit(count: i64) -> Result<Vec<T>> {
        let db = get_db()?;
        let records: Vec<T> = db
            .query(QueryKind::limit(T::table_name(), count))
            .bind(("table", Table::from(T::table_name())))
            .bind(("count", count))
            .await?
            .check()?
            .take(0)?;
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
        let created: Vec<T> = db.insert(T::table_name()).content(data).await?;
        Ok(created)
    }

    pub async fn insert_jump(data: Vec<T>) -> Result<Vec<T>> {
        let db = get_db()?;
        let chunk_size = 50_000;
        let mut inserted_all = Vec::with_capacity(data.len());

        for chunk in data.chunks(chunk_size) {
            let chunk_clone = chunk.to_vec();
            let inserted: Vec<T> = db
                .query(QueryKind::insert(T::table_name()))
                .bind(("table", Table::from(T::table_name())))
                .bind(("data", chunk_clone))
                .await?
                .check()?
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
                .query(QueryKind::insert_replace(T::table_name(), keys.clone()))
                .bind(("table", Table::from(T::table_name())))
                .bind(("data", chunk_clone))
                .await?
                .check()?
                .take(0)?;
            inserted_all.extend(inserted);
            println!(
                "{} inserted: {}/{}",
                T::table_name(),
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
        let record = RecordId::new(T::table_name(), id);
        Self::delete_record(record).await
    }

    pub async fn delete_record(id: RecordId) -> Result<()> {
        let db = get_db()?;
        db.query(QueryKind::delete_record())
            .bind(("record", id))
            .await?
            .check()?;
        Ok(())
    }

    pub async fn clean() -> Result<()> {
        let db = get_db()?;
        let result = db
            .query(QueryKind::delete_table())
            .bind(("table", Table::from(T::table_name())))
            .await?;
        if let Err(err) = result.check() {
            let message = err.to_string();
            if !message.contains("does not exist") {
                return Err(err.into());
            }
        }
        Ok(())
    }

    pub async fn select_record_id(k: &str, v: &str) -> Result<RecordId> {
        let db = get_db()?;
        let ids: Vec<RecordId> = db
            .query(QueryKind::select_id_single(T::table_name()))
            .bind(("table", Table::from(T::table_name())))
            .bind(("k", k.to_owned()))
            .bind(("v", v.to_owned()))
            .await?
            .check()?
            .take(0)?;
        let id = ids.into_iter().next();
        id.ok_or(DBError::NotFound.into())
    }

    pub async fn all_record() -> Result<Vec<RecordId>> {
        let db = get_db()?;
        let mut result = db
            .query(QueryKind::all_id(T::table_name()))
            .bind(("table", Table::from(T::table_name())))
            .await?
            .check()?;
        let ids: Vec<RecordId> = result.take(0)?;
        Ok(ids)
    }
}

impl<T> Repo<T>
where
    T: ModelMeta,
{
    pub async fn upsert_by_string_id(data: T) -> Result<T> {
        let db = get_db()?;
        let table = T::table_name();
        let id = extract_string_id(&data)?;
        let mut content = serde_json::to_value(&data)?;
        if let Value::Object(map) = &mut content {
            map.remove("id");
        }
        strip_null_fields(&mut content);
        let record = RecordId::new(table, id.clone());
        let _: Option<surrealdb::types::Value> = db.upsert(record).content(content).await?;

        Self::select_by_string_id(&id).await
    }

    pub async fn select_by_string_id(id: &str) -> Result<T> {
        let db = get_db()?;
        let record = RecordId::new(T::table_name(), id.to_owned());
        let mut result = db
            .query(QueryKind::select_by_string_id())
            .bind(("record", record))
            .await?
            .check()?;
        let row: Option<T> = result.take(0)?;
        row.ok_or(DBError::NotFound.into())
    }

    pub async fn select_all_string_id() -> Result<Vec<T>> {
        let db = get_db()?;
        let mut result = db
            .query(QueryKind::select_all_string_id())
            .bind(("table", Table::from(T::table_name())))
            .await?
            .check()?;
        let rows: Vec<T> = result.take(0)?;
        Ok(rows)
    }

    pub async fn select_limit_string_id(count: i64) -> Result<Vec<T>> {
        let db = get_db()?;
        let mut result = db
            .query(QueryKind::select_limit_string_id())
            .bind(("table", Table::from(T::table_name())))
            .bind(("count", count))
            .await?
            .check()?;
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

#[cfg(test)]
mod tests {
    use super::extract_string_id;
    use crate::model::meta::ModelMeta;
    use serde::{Deserialize, Serialize};
    use surrealdb::types::SurrealValue;

    #[derive(Serialize)]
    struct GoodModel {
        id: String,
    }

    #[derive(Serialize)]
    struct MissingId {
        name: String,
    }

    #[derive(Serialize)]
    struct BadIdType {
        id: i64,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, SurrealValue)]
    struct AutoTableModel {
        id: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, SurrealValue)]
    struct CustomTableModel {
        id: String,
    }

    crate::impl_crud!(AutoTableModel);
    crate::impl_crud!(CustomTableModel, "custom_users");

    #[test]
    fn extract_string_id_succeeds_for_valid_model() {
        let model = GoodModel {
            id: "u1".to_owned(),
        };
        assert_eq!(extract_string_id(&model).expect("expected id"), "u1");
    }

    #[test]
    fn extract_string_id_fails_when_id_missing() {
        let model = MissingId {
            name: "alice".to_owned(),
        };
        let err = extract_string_id(&model).expect_err("expected missing id error");
        assert!(err.to_string().contains("does not contain an `id`"));
    }

    #[test]
    fn extract_string_id_fails_when_id_not_string() {
        let model = BadIdType { id: 123 };
        let err = extract_string_id(&model).expect_err("expected bad id type error");
        assert!(err.to_string().contains("not a non-empty string"));
    }

    #[test]
    fn extract_string_id_fails_when_id_empty() {
        let model = GoodModel { id: String::new() };
        let err = extract_string_id(&model).expect_err("expected empty id error");
        assert!(err.to_string().contains("not a non-empty string"));
    }

    #[test]
    fn default_table_name_from_impl_crud_is_applied() {
        assert_eq!(
            <AutoTableModel as ModelMeta>::table_name(),
            "auto_table_model"
        );
    }

    #[test]
    fn custom_table_name_from_impl_crud_override_is_applied() {
        assert_eq!(
            <CustomTableModel as ModelMeta>::table_name(),
            "custom_users"
        );
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
    ($t:ty) => {
        impl $crate::model::meta::ModelMeta for $t {
            fn table_name() -> &'static str {
                static TABLE_NAME: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
                TABLE_NAME.get_or_init(|| {
                    let table = $crate::model::meta::default_table_name(stringify!($t));
                    $crate::model::meta::register_table(stringify!($t), table)
                })
            }
        }

        impl $crate::repository::Crud for $t {}
    };
    ($t:ty, $table:expr) => {
        impl $crate::model::meta::ModelMeta for $t {
            fn table_name() -> &'static str {
                static TABLE_NAME: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
                TABLE_NAME.get_or_init(|| {
                    let table: &'static str = $table;
                    $crate::model::meta::register_table(stringify!($t), table)
                })
            }
        }

        impl $crate::repository::Crud for $t {}
    };
}
