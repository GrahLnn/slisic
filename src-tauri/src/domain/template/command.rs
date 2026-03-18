use super::input::{
    AssignTaskInput, BulkStatusInput, NewMemberInput, NewTaskInput, TemplateDashboard,
    UnassignTaskInput,
};
use super::service;

#[tauri::command]
#[specta::specta]
pub async fn template_bootstrap() -> std::result::Result<TemplateDashboard, String> {
    service::bootstrap().await.map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_snapshot() -> std::result::Result<TemplateDashboard, String> {
    service::snapshot().await.map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_create_member(
    input: NewMemberInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::create_member(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_create_task(
    input: NewTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::create_task(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_assign_task(
    input: AssignTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::assign_task(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_unassign_task(
    input: UnassignTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::unassign_task(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_bulk_set_status(
    input: BulkStatusInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::bulk_set_status(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_reset() -> std::result::Result<TemplateDashboard, String> {
    service::reset().await.map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use appdb::connection::{reinit_db, reset_db};
    use std::path::PathBuf;
    use std::sync::{LazyLock, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::runtime::Runtime;

    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
    static TEST_RT: LazyLock<Runtime> =
        LazyLock::new(|| Runtime::new().expect("template command runtime should be created"));

    fn test_db_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "template_command_test_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    fn with_db(test: impl FnOnce()) {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = test_db_path();

        reset_db();
        TEST_RT.block_on(async {
            reinit_db(path.clone())
                .await
                .expect("database should initialize for template command tests");
        });

        test();

        reset_db();
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn tp_command_chain_roundtrip_succeeds() {
        with_db(|| {
            TEST_RT.block_on(async {
                let bootstrapped = template_bootstrap()
                    .await
                    .expect("bootstrap should succeed");
                assert_eq!(bootstrapped.stats.total_members, 3);
                assert_eq!(bootstrapped.stats.total_tasks, 3);

                let created_member = template_create_member(NewMemberInput {
                    id: "nina".to_owned(),
                    name: "Nina".to_owned(),
                    role: "QA".to_owned(),
                })
                .await
                .expect("create_member should succeed");
                assert_eq!(created_member.stats.total_members, 4);

                let created_task = template_create_task(NewTaskInput {
                    id: "qa-audit".to_owned(),
                    title: "QA audit".to_owned(),
                    notes: "Verify whole chain".to_owned(),
                    status: "todo".to_owned(),
                    priority: 2,
                })
                .await
                .expect("create_task should succeed");
                assert_eq!(created_task.stats.total_tasks, 4);

                let assigned = template_assign_task(AssignTaskInput {
                    task_id: "qa-audit".to_owned(),
                    member_id: "nina".to_owned(),
                })
                .await
                .expect("assign_task should succeed");
                assert!(assigned
                    .assignments
                    .iter()
                    .any(|link| link.task_id == "qa-audit" && link.member_id == "nina"));

                let bulked = template_bulk_set_status(BulkStatusInput {
                    task_ids: vec!["qa-audit".to_owned()],
                    status: "done".to_owned(),
                })
                .await
                .expect("bulk_set_status should succeed");
                assert!(bulked
                    .tasks
                    .iter()
                    .any(|task| task.id.to_string() == "qa-audit" && task.status == "done"));

                let unassigned = template_unassign_task(UnassignTaskInput {
                    task_id: "qa-audit".to_owned(),
                })
                .await
                .expect("unassign_task should succeed");
                let task = unassigned
                    .tasks
                    .iter()
                    .find(|task| task.id.to_string() == "qa-audit")
                    .expect("task should exist after unassign");
                assert_eq!(task.owner_id, None);
                assert!(!unassigned
                    .assignments
                    .iter()
                    .any(|link| link.task_id == "qa-audit"));
            });
        });
    }

    #[test]
    fn fp_invalid_status_is_rejected_instead_of_false_success() {
        with_db(|| {
            TEST_RT.block_on(async {
                let err = template_create_task(NewTaskInput {
                    id: "bad-status".to_owned(),
                    title: "Bad".to_owned(),
                    notes: String::new(),
                    status: "blocked".to_owned(),
                    priority: 1,
                })
                .await
                .expect_err("invalid status should fail");
                assert!(err.contains("invalid status"), "{err}");
            });
        });
    }

    #[test]
    fn tn_empty_bulk_status_is_noop_without_side_effects() {
        with_db(|| {
            TEST_RT.block_on(async {
                let bootstrapped = template_bootstrap()
                    .await
                    .expect("bootstrap should succeed");

                let snapshot = template_bulk_set_status(BulkStatusInput {
                    task_ids: Vec::new(),
                    status: "done".to_owned(),
                })
                .await
                .expect("empty bulk status should not fail");

                let snapshot_task_ids = snapshot
                    .tasks
                    .iter()
                    .map(|task| task.id.to_string())
                    .collect::<Vec<_>>();
                let bootstrapped_task_ids = bootstrapped
                    .tasks
                    .iter()
                    .map(|task| task.id.to_string())
                    .collect::<Vec<_>>();
                let snapshot_assignment_pairs = snapshot
                    .assignments
                    .iter()
                    .map(|link| format!("{}:{}", link.task_id, link.member_id))
                    .collect::<Vec<_>>();
                let bootstrapped_assignment_pairs = bootstrapped
                    .assignments
                    .iter()
                    .map(|link| format!("{}:{}", link.task_id, link.member_id))
                    .collect::<Vec<_>>();

                assert_eq!(snapshot_task_ids, bootstrapped_task_ids);
                assert_eq!(snapshot_assignment_pairs, bootstrapped_assignment_pairs);
                assert_eq!(snapshot.stats.total_tasks, bootstrapped.stats.total_tasks);
            });
        });
    }

    #[test]
    fn fn_valid_assignment_is_not_false_negative() {
        with_db(|| {
            TEST_RT.block_on(async {
                template_bootstrap()
                    .await
                    .expect("bootstrap should succeed");

                let assigned = template_assign_task(AssignTaskInput {
                    task_id: "release-notes".to_owned(),
                    member_id: "sofia".to_owned(),
                })
                .await
                .expect("valid assignment should succeed");

                assert!(assigned
                    .assignments
                    .iter()
                    .any(|link| link.task_id == "release-notes" && link.member_id == "sofia"));
            });
        });
    }
}
