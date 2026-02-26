use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use app_database::connection::init_db;
use app_database::graph::GraphRepo;
use app_database::model::relation::relation_name;
use app_database::repository::Repo;
use app_database::tx::{run_tx, TxStmt};
use app_database::{declare_relation, impl_crud, impl_id};
use serde::{Deserialize, Serialize};
use surrealdb::types::{RecordId, SurrealValue};
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;

static INIT: OnceCell<()> = OnceCell::const_new();
static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static TEST_RT: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("integration runtime should be created"));

#[derive(Debug, Clone, Serialize, Deserialize, SurrealValue)]
struct ItStringUser {
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, SurrealValue)]
struct ItRecordUser {
    id: RecordId,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, SurrealValue)]
struct ItNoId {
    name: String,
}

impl_crud!(ItStringUser, "it_string_user");
impl_crud!(ItRecordUser, "it_record_user");
impl_crud!(ItNoId, "it_no_id");
impl_id!(ItRecordUser, id);
declare_relation!(ItFollowsRel, "it_follows_rel");

fn test_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("app_database_it_{}_{}", std::process::id(), nanos))
}

fn run_async<T>(fut: impl std::future::Future<Output = T>) -> T {
    TEST_RT.block_on(fut)
}

fn acquire_test_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn ensure_db() {
    INIT.get_or_init(|| async {
        let path = test_db_path();
        init_db(path).await.expect("database should initialize");
    })
    .await;
}

#[test]
fn string_id_repo_roundtrip_passes() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        Repo::<ItStringUser>::clean()
            .await
            .expect("clean should succeed");

        let inserted = Repo::<ItStringUser>::upsert_by_string_id(ItStringUser {
            id: "alice".to_owned(),
        })
        .await
        .expect("upsert_by_string_id should succeed");
        assert_eq!(inserted.id, "alice");

        let selected = Repo::<ItStringUser>::select_by_string_id("alice")
            .await
            .expect("select_by_string_id should succeed");
        assert_eq!(selected.id, "alice");
    });
}

#[test]
fn select_missing_record_fails() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        let _ = Repo::<ItStringUser>::upsert_by_string_id(ItStringUser {
            id: "seed".to_owned(),
        })
        .await
        .expect("seed insert should succeed");

        let err = Repo::<ItStringUser>::select_by_string_id("missing")
            .await
            .expect_err("missing record should fail");
        assert!(err.to_string().contains("Record not found"), "{err}");
    });
}

#[test]
fn upsert_string_id_without_id_field_fails() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        let err = Repo::<ItNoId>::upsert_by_string_id(ItNoId {
            name: "alice".to_owned(),
        })
        .await
        .expect_err("missing `id` field should fail");
        assert!(err
            .to_string()
            .contains("does not contain an `id` string field"));
    });
}

#[test]
fn graph_relation_roundtrip_passes() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        Repo::<ItRecordUser>::clean()
            .await
            .expect("clean should succeed");

        let a = ItRecordUser {
            id: RecordId::new("it_record_user", "a"),
            name: "A".to_owned(),
        };
        let b = ItRecordUser {
            id: RecordId::new("it_record_user", "b"),
            name: "B".to_owned(),
        };

        Repo::<ItRecordUser>::create_by_id("a", a.clone())
            .await
            .expect("create a should succeed");
        Repo::<ItRecordUser>::create_by_id("b", b.clone())
            .await
            .expect("create b should succeed");

        let rel = relation_name::<ItFollowsRel>();
        GraphRepo::relate_by_id(a.id.clone(), b.id.clone(), rel)
            .await
            .expect("relate should succeed");

        let outs = GraphRepo::outs(a.id.clone(), rel, "it_record_user")
            .await
            .expect("outs should succeed");
        assert!(outs.iter().any(|id| id == &b.id));

        GraphRepo::unrelate_by_id(a.id.clone(), b.id.clone(), rel)
            .await
            .expect("unrelate should succeed");

        let outs_after = GraphRepo::outs(a.id.clone(), rel, "it_record_user")
            .await
            .expect("outs after unrelate should succeed");
        assert!(!outs_after.iter().any(|id| id == &b.id));
    });
}

#[test]
fn graph_relation_with_invalid_name_fails() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        let err = GraphRepo::relate_by_id(
            RecordId::new("it_record_user", "x"),
            RecordId::new("it_record_user", "y"),
            "bad-name",
        )
        .await
        .expect_err("invalid relation should fail");

        assert!(err.to_string().contains("invalid relation name"));
    });
}

#[test]
fn transaction_runner_executes_and_returns_value() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        let stmt = TxStmt::new("RETURN $v;").bind("v", 42i64);
        let mut res = run_tx(vec![stmt]).await.expect("tx should succeed");
        let value: Option<i64> = res.take(0).expect("take should decode value");
        assert_eq!(value, Some(42));
    });
}
