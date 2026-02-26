use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use surrealdb::types::{RecordId, SurrealValue};

use super::enums::table::{Rel, Table};
use super::query::QueryKind;
use super::{get_db, query_take, HasId};

#[derive(Debug, Serialize, Deserialize, SurrealValue)]
pub struct Relation {
    #[serde(rename = "in")]
    pub _in: RecordId,
    pub out: RecordId,
}

pub struct GraphRepo;

impl GraphRepo {
    pub async fn relate_by_id(in_id: RecordId, out_id: RecordId, rel: Rel) -> Result<()> {
        let db = get_db()?;
        let sql = QueryKind::relate(in_id, out_id, rel);
        db.query(sql).await?;
        Ok(())
    }

    pub async fn unrelate_by_id(self_id: RecordId, target_id: RecordId, rel: Rel) -> Result<()> {
        let db = get_db()?;
        db.query(QueryKind::unrelate(self_id, target_id, rel))
            .await?;
        Ok(())
    }

    pub async fn unrelate_all(self_id: RecordId, rel: Rel) -> Result<()> {
        let db = get_db()?;
        db.query(QueryKind::unrelate_all(self_id, rel)).await?;
        Ok(())
    }

    pub async fn outs(in_id: RecordId, rel: Rel, out_table: Table) -> Result<Vec<RecordId>> {
        let sql = QueryKind::rel_outs(in_id, rel, out_table);
        query_take(sql.as_str(), None).await
    }

    pub async fn ins(out_id: RecordId, rel: Rel, in_table: Table) -> Result<Vec<RecordId>> {
        let sql = QueryKind::rel_ins(out_id, rel, in_table);
        query_take(sql.as_str(), None).await
    }

    pub async fn insert_relation(rel: Rel, data: Vec<Relation>) -> Result<Vec<Relation>> {
        let db = get_db()?;
        let relate: Vec<Relation> = db.insert(rel.as_str()).relation(data).await?;
        Ok(relate)
    }
}

#[async_trait]
pub trait GraphCrud: HasId + Send + Sync {
    async fn relate<T>(&self, target: T, rel: Rel) -> Result<()>
    where
        T: HasId + Send + Sync,
    {
        GraphRepo::relate_by_id(self.id(), target.id(), rel).await
    }

    async fn unrelate<T>(&self, target: T, rel: Rel) -> Result<()>
    where
        T: HasId + Send + Sync,
    {
        GraphRepo::unrelate_by_id(self.id(), target.id(), rel).await
    }
}

impl<T> GraphCrud for T where T: HasId + Send + Sync {}

pub async fn relate_by_id(in_id: RecordId, out_id: RecordId, rel: Rel) -> Result<()> {
    GraphRepo::relate_by_id(in_id, out_id, rel).await
}

pub async fn unrelate_by_id(self_id: RecordId, target_id: RecordId, rel: Rel) -> Result<()> {
    GraphRepo::unrelate_by_id(self_id, target_id, rel).await
}
