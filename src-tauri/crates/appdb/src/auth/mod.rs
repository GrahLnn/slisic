use anyhow::Result;
use serde::Serialize;
use surrealdb::opt::auth::Record;
use surrealdb::types::SurrealValue;

use crate::connection::get_db;
use crate::query::query_return;

const CHECK_ROOT_USER_SQL: &str =
    r#"return (select * from user).find(|$v| $v.user = "root") != none"#;

#[derive(Serialize, SurrealValue)]
struct RootCredentials {
    user: String,
    pass: String,
}

fn root_user(pass: &str) -> Record<RootCredentials> {
    Record {
        namespace: "app".to_owned(),
        database: "app".to_owned(),
        access: "account".to_owned(),
        params: RootCredentials {
            user: "root".to_owned(),
            pass: pass.to_owned(),
        },
    }
}

pub async fn ensure_root_user(pass: &str) -> Result<()> {
    let db = get_db()?;

    let exists = query_return::<bool>(CHECK_ROOT_USER_SQL)
        .await?
        .unwrap_or(false);

    if !exists {
        db.signup(root_user(pass)).await?;
        return Ok(());
    }

    db.signin(root_user(pass)).await?;
    Ok(())
}
