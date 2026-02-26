use crate::error::DBError;
use crate::model::schema;
use anyhow::Result;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use surrealdb::engine::local::{Db, SurrealKv};
use surrealdb::opt::Config;
use surrealdb::Surreal;
use sysinfo::{Pid, System};
use tokio::sync::OnceCell;

pub type DbHandle = Arc<Surreal<Db>>;

static DB: LazyLock<OnceCell<DbHandle>> = LazyLock::new(OnceCell::new);

#[derive(Debug, Clone)]
pub struct InitDbOptions {
    pub versioned: bool,
    pub version_retention: Option<Duration>,
    pub query_timeout: Option<Duration>,
    pub transaction_timeout: Option<Duration>,
    pub changefeed_gc_interval: Option<Duration>,
    pub ast_payload: bool,
}

impl Default for InitDbOptions {
    fn default() -> Self {
        Self {
            versioned: false,
            version_retention: None,
            query_timeout: None,
            transaction_timeout: None,
            changefeed_gc_interval: None,
            ast_payload: false,
        }
    }
}

impl InitDbOptions {
    pub fn versioned(mut self, enabled: bool) -> Self {
        self.versioned = enabled;
        self
    }

    pub fn version_retention(mut self, duration: Option<Duration>) -> Self {
        self.version_retention = duration;
        self
    }

    pub fn query_timeout(mut self, duration: Option<Duration>) -> Self {
        self.query_timeout = duration;
        self
    }

    pub fn transaction_timeout(mut self, duration: Option<Duration>) -> Self {
        self.transaction_timeout = duration;
        self
    }

    pub fn changefeed_gc_interval(mut self, duration: Option<Duration>) -> Self {
        self.changefeed_gc_interval = duration;
        self
    }

    pub fn ast_payload(mut self, enabled: bool) -> Self {
        self.ast_payload = enabled;
        self
    }
}

fn is_schema_already_defined_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("already exists") || lower.contains("already defined")
}

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

async fn open_db(path: PathBuf, options: &InitDbOptions) -> Result<Surreal<Db>> {
    let config = Config::new()
        .set_ast_payload(options.ast_payload)
        .query_timeout(options.query_timeout)
        .transaction_timeout(options.transaction_timeout)
        .changefeed_gc_interval(options.changefeed_gc_interval);

    let mut builder = Surreal::new::<SurrealKv>((path, config));
    if options.versioned {
        builder = builder.versioned();
        if let Some(retention) = options.version_retention {
            builder = builder.retention(retention);
        }
    }

    Ok(builder.await?)
}

pub async fn init_db(path: PathBuf) -> Result<()> {
    init_db_with_options(path, InitDbOptions::default()).await
}

pub async fn init_db_with_options(path: PathBuf, options: InitDbOptions) -> Result<()> {
    fs::create_dir_all(&path)?;
    let db = match open_db(path.clone(), &options).await {
        Ok(db) => db,
        Err(first_err) => {
            if clear_stale_lock_if_needed(&path)? {
                open_db(path, &options).await?
            } else {
                return Err(first_err.into());
            }
        }
    };
    db.use_ns("app").use_db("app").await?;

    DB.set(Arc::new(db))
        .map_err(|_| DBError::AlreadyInitialized)?;
    let db = get_db()?;
    for item in inventory::iter::<schema::SchemaItem> {
        let response = db.query(item.ddl).await?;
        if let Err(err) = response.check() {
            let message = err.to_string();
            if !is_schema_already_defined_error(&message) {
                return Err(DBError::QueryResponse(message).into());
            }
        }
    }
    Ok(())
}

pub fn get_db() -> Result<DbHandle> {
    DB.get().cloned().ok_or(DBError::NotInitialized.into())
}

#[cfg(test)]
mod tests {
    use super::InitDbOptions;
    use std::time::Duration;

    #[test]
    fn default_init_options_are_non_versioned() {
        let options = InitDbOptions::default();
        assert!(!options.versioned);
        assert!(options.version_retention.is_none());
        assert!(options.query_timeout.is_none());
        assert!(options.transaction_timeout.is_none());
        assert!(options.changefeed_gc_interval.is_none());
        assert!(!options.ast_payload);
    }

    #[test]
    fn init_options_builders_override_values() {
        let options = InitDbOptions::default()
            .versioned(true)
            .version_retention(Some(Duration::from_secs(60)))
            .query_timeout(Some(Duration::from_secs(3)))
            .transaction_timeout(Some(Duration::from_secs(9)))
            .changefeed_gc_interval(Some(Duration::from_secs(30)))
            .ast_payload(true);

        assert!(options.versioned);
        assert_eq!(options.version_retention, Some(Duration::from_secs(60)));
        assert_eq!(options.query_timeout, Some(Duration::from_secs(3)));
        assert_eq!(options.transaction_timeout, Some(Duration::from_secs(9)));
        assert_eq!(
            options.changefeed_gc_interval,
            Some(Duration::from_secs(30))
        );
        assert!(options.ast_payload);
    }
}
