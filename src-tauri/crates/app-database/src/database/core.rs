use super::error::DBError;
use super::schema;
use anyhow::Result;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use surrealdb::engine::local::{Db, SurrealKv};
use surrealdb::Surreal;
use sysinfo::{Pid, System};
use tokio::sync::OnceCell;

pub type DbHandle = Arc<Surreal<Db>>;

static DB: LazyLock<OnceCell<DbHandle>> = LazyLock::new(OnceCell::new);

fn is_process_running(pid: u32) -> bool {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.process(Pid::from_u32(pid)).is_some()
}

fn clear_stale_lock_if_needed(path: &PathBuf) -> Result<bool> {
    if !path.is_dir() {
        return Ok(false);
    }

    let lock_path = path.join("LOCK");
    if !lock_path.exists() {
        return Ok(false);
    }

    let lock_pid = fs::read_to_string(&lock_path).ok();
    let lock_pid = lock_pid.as_deref().map(str::trim).unwrap_or_default();
    let is_live_owner = lock_pid
        .parse::<u32>()
        .ok()
        .map(is_process_running)
        .unwrap_or(false);

    if is_live_owner {
        return Ok(false);
    }

    fs::remove_file(&lock_path)?;
    Ok(true)
}

pub async fn init_db(path: PathBuf) -> Result<()> {
    fs::create_dir_all(&path)?;
    let db = match Surreal::new::<SurrealKv>(path.clone()).await {
        Ok(db) => db,
        Err(first_err) => {
            if clear_stale_lock_if_needed(&path)? {
                Surreal::new::<SurrealKv>(path).await?
            } else {
                return Err(first_err.into());
            }
        }
    };
    db.use_ns("app").use_db("app").await?;

    // let _ = db.query(QueryKind::InitAccess.as_str()).await?;
    DB.set(Arc::new(db)).map_err(|_| DBError::NotInitialized)?;
    let db = get_db()?;
    for item in inventory::iter::<schema::SchemaItem> {
        db.query(item.ddl).await?;
    }
    Ok(())
}

pub fn get_db() -> Result<DbHandle> {
    DB.get().cloned().ok_or(DBError::NotInitialized.into())
}
