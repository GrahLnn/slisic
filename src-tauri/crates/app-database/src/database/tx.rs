use std::collections::BTreeMap;

use anyhow::Result;
use surrealdb::types::{SurrealValue, Value};
use surrealdb::IndexedResults;

use super::get_db;

pub struct TxStmt {
    pub sql: String,
    pub bindings: BTreeMap<String, Value>,
}

impl TxStmt {
    pub fn new<S: Into<String>>(sql: S) -> Self {
        Self {
            sql: sql.into(),
            bindings: BTreeMap::new(),
        }
    }

    pub fn bind<K: Into<String>, V: SurrealValue>(mut self, key: K, val: V) -> Self {
        self.bindings.insert(key.into(), val.into_value());
        self
    }
}

pub struct TxRunner;

impl TxRunner {
    pub async fn run(stmts: Vec<TxStmt>) -> Result<IndexedResults> {
        let db = get_db()?;
        let tx = db.as_ref().clone().begin().await?;
        let mut last_response: Option<IndexedResults> = None;

        for stmt in stmts {
            let mut query = tx.query(&stmt.sql);
            for (k, v) in stmt.bindings {
                query = query.bind((k, v));
            }
            let response = query.await?.check()?;
            last_response = Some(response);
        }

        tx.commit().await?;

        if let Some(response) = last_response {
            Ok(response)
        } else {
            let response = db.query("RETURN NONE;").await?.check()?;
            Ok(response)
        }
    }
}

pub async fn run_tx(stmts: Vec<TxStmt>) -> Result<IndexedResults> {
    TxRunner::run(stmts).await
}
