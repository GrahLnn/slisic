use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use surrealdb::types::{RecordId, SurrealValue, Table};

use crate::connection::get_db;
use crate::model::meta::HasId;
use crate::query::builder::QueryKind;

#[derive(Debug, Serialize, Deserialize, SurrealValue)]
pub struct Relation {
    #[serde(rename = "in")]
    pub _in: RecordId,
    pub out: RecordId,
}

pub struct GraphRepo;

impl GraphRepo {
    pub async fn relate_by_id(in_id: RecordId, out_id: RecordId, rel: &str) -> Result<()> {
        let db = get_db()?;
        let sql = QueryKind::relate(&in_id, &out_id, rel);
        db.query(sql)
            .bind(("rel", Table::from(rel)))
            .bind(("in", in_id))
            .bind(("out", out_id))
            .await?
            .check()?;
        Ok(())
    }

    pub async fn unrelate_by_id(self_id: RecordId, target_id: RecordId, rel: &str) -> Result<()> {
        let db = get_db()?;
        db.query(QueryKind::unrelate(&self_id, &target_id, rel))
            .bind(("rel", Table::from(rel)))
            .bind(("in", self_id))
            .bind(("out", target_id))
            .await?
            .check()?;
        Ok(())
    }

    pub async fn unrelate_all(self_id: RecordId, rel: &str) -> Result<()> {
        let db = get_db()?;
        db.query(QueryKind::unrelate_all(&self_id, rel))
            .bind(("rel", Table::from(rel)))
            .bind(("in", self_id))
            .await?
            .check()?;
        Ok(())
    }

    pub async fn outs(in_id: RecordId, rel: &str, out_table: &str) -> Result<Vec<RecordId>> {
        let sql = QueryKind::rel_outs(&in_id, rel, out_table);
        let db = get_db()?;
        let mut result = db
            .query(sql)
            .bind(("rel", Table::from(rel)))
            .bind(("in", in_id))
            .bind(("out_table", out_table.to_owned()))
            .await?
            .check()?;
        let rows: Vec<RecordId> = result.take(0)?;
        Ok(rows)
    }

    pub async fn ins(out_id: RecordId, rel: &str, in_table: &str) -> Result<Vec<RecordId>> {
        let sql = QueryKind::rel_ins(&out_id, rel, in_table);
        let db = get_db()?;
        let mut result = db
            .query(sql)
            .bind(("rel", Table::from(rel)))
            .bind(("out", out_id))
            .bind(("in_table", in_table.to_owned()))
            .await?
            .check()?;
        let rows: Vec<RecordId> = result.take(0)?;
        Ok(rows)
    }

    pub async fn insert_relation(rel: &str, data: Vec<Relation>) -> Result<Vec<Relation>> {
        let db = get_db()?;
        let relate: Vec<Relation> = db.insert(rel).relation(data).await?;
        Ok(relate)
    }
}

#[async_trait]
pub trait GraphCrud: HasId + Send + Sync {
    async fn relate<T>(&self, target: T, rel: &str) -> Result<()>
    where
        T: HasId + Send + Sync,
    {
        GraphRepo::relate_by_id(self.id(), target.id(), rel).await
    }

    async fn unrelate<T>(&self, target: T, rel: &str) -> Result<()>
    where
        T: HasId + Send + Sync,
    {
        GraphRepo::unrelate_by_id(self.id(), target.id(), rel).await
    }
}

impl<T> GraphCrud for T where T: HasId + Send + Sync {}

pub async fn relate_by_id(in_id: RecordId, out_id: RecordId, rel: &str) -> Result<()> {
    GraphRepo::relate_by_id(in_id, out_id, rel).await
}

pub async fn unrelate_by_id(self_id: RecordId, target_id: RecordId, rel: &str) -> Result<()> {
    GraphRepo::unrelate_by_id(self_id, target_id, rel).await
}
