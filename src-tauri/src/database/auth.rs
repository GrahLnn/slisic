use crate::database::query_raw;

use super::{get_db, query_return, QueryKind};

use anyhow::Result;
use serde::Serialize;
use surrealdb::opt::auth::Namespace;
use surrealdb::opt::auth::Record;

#[derive(Serialize)]
struct RootCredentials<'a> {
    user: &'a str,
    pass: &'a str,
}

fn root_user(pass: &str) -> Record<'_, RootCredentials<'_>> {
    Record {
        namespace: "app",
        database: "app",
        access: "account",
        params: RootCredentials { user: "root", pass },
    }
}

#[tauri::command]
#[specta::specta]
pub async fn ensure_root_user(pass: &str) -> Result<()> {
    let db = get_db()?;

    let exists = query_return::<bool>(QueryKind::CheckRootUser.as_str())
        .await?
        .unwrap();

    dbg!(exists);

    let l = query_raw("SELECT * FROM user").await?;
    // let l = query_return::<Vec<String>>("return (select * from user).map(|$v| $v)").await?;
    dbg!(l);

    if !exists {
        match db.signup(root_user(pass)).await {
            Ok(_) => {
                dbg!("signup");
                return Ok(());
            }
            Err(e) => {
                eprintln!(r"❌ signup failed: {:?}", e);
                return Err(e.into());
            }
        }
        // return Ok(());
    }

    db.signin(root_user(pass)).await?;
    // dbg!(res);
    // dbg!("signin");
    match db.signin(root_user(pass)).await {
        Ok(_) => {
            dbg!("signin");
            Ok(())
        }
        Err(e) => {
            eprintln!("❌ signin failed: {:?}", e);
            Err(e.into())
        }
    }
    // Ok(())
}
