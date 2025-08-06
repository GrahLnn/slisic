use crate::database::{get_db, DBError, HasId, QueryKind};

use anyhow::Result;
use std::fmt;
use surrealdb::RecordId;

pub trait TableName {
    fn table_name(&self) -> &str;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Table {
    User,
}

impl Table {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Table::User => "user",
        }
    }
}

impl fmt::Display for Table {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl TableName for Table {
    fn table_name(&self) -> &str {
        self.as_str()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rel {
    SignIn,
}

impl Rel {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Rel::SignIn => "sign_in",
        }
    }
    pub async fn record_id(self, in_id: RecordId, out_id: RecordId) -> Result<RecordId> {
        let db = get_db()?;
        let sql = QueryKind::rel_id(in_id, self, out_id);
        let mut result = db.query(sql).await?;
        let record: Option<RecordId> = result.take(0)?;
        record.ok_or(DBError::NotFound.into())
    }
}

impl fmt::Display for Rel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl TableName for Rel {
    fn table_name(&self) -> &str {
        self.as_str()
    }
}
