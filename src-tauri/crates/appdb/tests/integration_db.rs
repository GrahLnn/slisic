use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use appdb::connection::{get_db, init_db};
use appdb::graph::GraphRepo;
use appdb::model::relation::relation_name;
use appdb::repository::Repo;
use appdb::tx::{run_tx, TxStmt};
use appdb::{declare_relation, impl_crud, impl_id};
use serde::{Deserialize, Serialize};
use surrealdb::types::{RecordId, SurrealValue, Table};
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
struct ItNumberUser {
    id: i64,
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
impl_crud!(ItNumberUser, "it_number_user");
impl_crud!(ItRecordUser, "it_record_user");
impl_crud!(ItNoId, "it_no_id");
impl_id!(ItRecordUser, id);
declare_relation!(ItFollowsRel, "it_follows_rel");

fn test_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("appdb_it_{}_{}", std::process::id(), nanos))
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
fn id_repo_roundtrip_passes() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        Repo::<ItStringUser>::clean()
            .await
            .expect("clean should succeed");

        let inserted = Repo::<ItStringUser>::upsert_by_id_value(ItStringUser {
            id: "alice".to_owned(),
        })
        .await
        .expect("upsert_by_id_value should succeed");
        assert_eq!(inserted.id, "alice");

        let selected = Repo::<ItStringUser>::select_by_id_value("alice")
            .await
            .expect("select_by_id_value should succeed");
        assert_eq!(selected.id, "alice");
    });
}

#[test]
fn select_missing_record_fails() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        let _ = Repo::<ItStringUser>::upsert_by_id_value(ItStringUser {
            id: "seed".to_owned(),
        })
        .await
        .expect("seed insert should succeed");

        let err = Repo::<ItStringUser>::select_by_id_value("missing")
            .await
            .expect_err("missing record should fail");
        assert!(err.to_string().contains("Record not found"), "{err}");
    });
}

#[test]
fn number_id_repo_roundtrip_passes() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        Repo::<ItNumberUser>::clean()
            .await
            .expect("clean should succeed");

        let inserted = Repo::<ItNumberUser>::upsert_by_id_value(ItNumberUser { id: 42 })
            .await
            .expect("upsert_by_id_value should succeed");
        assert_eq!(inserted.id, 42);

        let selected = Repo::<ItNumberUser>::select_all_id()
            .await
            .expect("select_all_id should succeed");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, 42);
    });
}

#[test]
fn upsert_id_without_id_field_fails() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        let err = Repo::<ItNoId>::upsert_by_id_value(ItNoId {
            name: "alice".to_owned(),
        })
        .await
        .expect_err("missing `id` field should fail");
        assert!(err
            .to_string()
            .contains("does not contain an `id` string or i64 field"));
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
fn graph_relation_name_is_bound_as_identifier() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        Repo::<ItRecordUser>::clean()
            .await
            .expect("clean should succeed");

        let x = ItRecordUser {
            id: RecordId::new("it_record_user", "x"),
            name: "X".to_owned(),
        };
        let y = ItRecordUser {
            id: RecordId::new("it_record_user", "y"),
            name: "Y".to_owned(),
        };
        Repo::<ItRecordUser>::create_by_id("x", x.clone())
            .await
            .expect("create x should succeed");
        Repo::<ItRecordUser>::create_by_id("y", y.clone())
            .await
            .expect("create y should succeed");

        GraphRepo::relate_by_id(
            x.id.clone(),
            y.id.clone(),
            "bad-name; DELETE it_record_user RETURN NONE;",
        )
        .await
        .expect("relation name should be treated as bound identifier");

        let selected_x = Repo::<ItRecordUser>::select("x")
            .await
            .expect("x should still exist");
        let selected_y = Repo::<ItRecordUser>::select("y")
            .await
            .expect("y should still exist");
        assert_eq!(selected_x.name, "X");
        assert_eq!(selected_y.name, "Y");
    });
}

#[test]
fn delete_target_string_bind_fails_but_table_bind_passes() {
    let _guard = acquire_test_lock();
    run_async(async {
        ensure_db().await;

        Repo::<ItRecordUser>::clean()
            .await
            .expect("clean should succeed");

        Repo::<ItRecordUser>::create_by_id(
            "z",
            ItRecordUser {
                id: RecordId::new("it_record_user", "z"),
                name: "Z".to_owned(),
            },
        )
        .await
        .expect("seed record should be created");

        let db = get_db().expect("db should be initialized");

        let bad_res = db
            .query("DELETE $target RETURN NONE;")
            .bind(("target", "it_record_user".to_owned()))
            .await
            .expect("query should execute");
        let bad_err = bad_res
            .check()
            .expect_err("string bind should fail for DELETE target");
        assert!(bad_err
            .to_string()
            .contains("Cannot execute DELETE statement using value"));

        db.query("DELETE $target RETURN NONE;")
            .bind(("target", Table::from("it_record_user")))
            .await
            .expect("query should execute")
            .check()
            .expect("table bind should pass for DELETE target");
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
