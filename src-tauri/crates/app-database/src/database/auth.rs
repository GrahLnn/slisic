use crate::database::query_raw;

use super::{get_db, query_return, QueryKind};

use anyhow::Result;
use serde::Serialize;
use surrealdb::opt::auth::Record;
use surrealdb::types::SurrealValue;

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
