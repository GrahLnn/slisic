use crate::database::{get_db, relation_name, run_tx, GraphRepo, ModelMeta, Repo, TxStmt};
use crate::domain::models::member::Member;
use crate::domain::models::task::{Task, STATUS_DOING, STATUS_DONE, STATUS_TODO};
use crate::domain::relations::TaskAssignment;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use surrealdb::types::{RecordId, RecordIdKey, Table, ToSql};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NewMemberInput {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NewTaskInput {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub status: String,
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AssignTaskInput {
    pub task_id: String,
    pub member_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UnassignTaskInput {
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BulkStatusInput {
    pub task_ids: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TaskAssignmentView {
    pub task_id: String,
    pub member_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DemoStats {
    pub total_members: i64,
    pub total_tasks: i64,
    pub todo_tasks: i64,
    pub doing_tasks: i64,
    pub done_tasks: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TemplateDashboard {
    pub members: Vec<Member>,
    pub tasks: Vec<Task>,
    pub assignments: Vec<TaskAssignmentView>,
    pub stats: DemoStats,
}

pub fn now_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn normalize_status(status: &str) -> Result<&'static str> {
    let value = status.trim().to_ascii_lowercase();
    match value.as_str() {
        STATUS_TODO => Ok(STATUS_TODO),
        STATUS_DOING => Ok(STATUS_DOING),
        STATUS_DONE => Ok(STATUS_DONE),
        _ => Err(anyhow!(
            "invalid status `{}`. expected one of: todo, doing, done",
            status
        )),
    }
}

fn record_key_to_string(key: RecordIdKey) -> String {
    match key {
        RecordIdKey::String(value) => value,
        RecordIdKey::Number(value) => value.to_string(),
        other => other.to_sql(),
    }
}

fn to_record_id<T: ModelMeta>(id: &str) -> RecordId {
    T::record_id(id.to_owned())
}

async fn clear_relation_table() -> Result<()> {
    let db = get_db()?;
    let response = db
        .query("DELETE $rel RETURN NONE;")
        .bind(("rel", Table::from(relation_name::<TaskAssignment>())))
        .await?;

    if let Err(err) = response.check() {
        let message = err.to_string();
        if message.contains("does not exist") {
            return Ok(());
        }

        if message.contains("not a relation but expected a RELATION") {
            let rel = relation_name::<TaskAssignment>();
            let task_table = Task::table_name();
            let member_table = Member::table_name();
            let unique_index = format!("{rel}_unique");
            let rebuild = format!(
                "REMOVE TABLE {rel};\
                 DEFINE TABLE {rel} TYPE RELATION IN {task_table} OUT {member_table};\
                 DEFINE INDEX {unique_index} ON TABLE {rel} FIELDS in, out UNIQUE;"
            );
            db.query(rebuild).await?.check()?;
            return Ok(());
        }

        return Err(err.into());
    }

    Ok(())
}

async fn clear_all() -> Result<()> {
    clear_relation_table().await?;
    Repo::<Task>::clean().await?;
    Repo::<Member>::clean().await?;
    Ok(())
}

async fn normalize_task_owner_id_nulls() -> Result<()> {
    let db = get_db()?;
    let table = Table::from(Task::table_name());
    let mut last_error: Option<anyhow::Error> = None;

    let attempts = [
        "UPDATE $table SET owner_id = NONE WHERE owner_id IS NULL RETURN NONE;",
        "UPDATE $table UNSET owner_id WHERE owner_id IS NULL RETURN NONE;",
        "DELETE $table WHERE owner_id IS NULL RETURN NONE;",
    ];

    for query in attempts {
        let response = db.query(query).bind(("table", table.clone())).await?;
        match response.check() {
            Ok(_) => return Ok(()),
            Err(err) => {
                let message = err.to_string();
                if message.contains("does not exist") {
                    return Ok(());
                }
                last_error = Some(err.into());
            }
        }
    }

    match last_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

async fn collect_assignments(tasks: &[Task]) -> Result<Vec<TaskAssignmentView>> {
    let rel = relation_name::<TaskAssignment>();
    let mut links = Vec::new();

    for task in tasks {
        let member_records =
            GraphRepo::outs(to_record_id::<Task>(&task.id), rel, Member::table_name()).await?;
        for member in member_records {
            links.push(TaskAssignmentView {
                task_id: task.id.clone(),
                member_id: record_key_to_string(member.key),
            });
        }
    }

    Ok(links)
}

fn build_stats(members: &[Member], tasks: &[Task]) -> DemoStats {
    DemoStats {
        total_members: members.len() as i64,
        total_tasks: tasks.len() as i64,
        todo_tasks: tasks
            .iter()
            .filter(|task| task.status == STATUS_TODO)
            .count() as i64,
        doing_tasks: tasks
            .iter()
            .filter(|task| task.status == STATUS_DOING)
            .count() as i64,
        done_tasks: tasks
            .iter()
            .filter(|task| task.status == STATUS_DONE)
            .count() as i64,
    }
}

async fn build_dashboard() -> Result<TemplateDashboard> {
    normalize_task_owner_id_nulls().await?;

    let mut members = Repo::<Member>::select_all_string_id().await?;
    members.sort_by(|left, right| left.name.cmp(&right.name));

    let mut tasks = Repo::<Task>::select_all_string_id().await?;
    tasks.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then(left.created_at.cmp(&right.created_at))
    });

    let assignments = collect_assignments(&tasks).await?;
    let stats = build_stats(&members, &tasks);

    Ok(TemplateDashboard {
        members,
        tasks,
        assignments,
        stats,
    })
}

async fn set_task_assignment(task_id: &str, member_id: &str) -> Result<()> {
    let _ = Repo::<Task>::select_by_string_id(task_id).await?;
    let _ = Repo::<Member>::select_by_string_id(member_id).await?;

    let now = now_timestamp_ms();
    let task_record = to_record_id::<Task>(task_id);
    let member_record = to_record_id::<Member>(member_id);
    let relation = Table::from(relation_name::<TaskAssignment>());

    let statements = vec![
        TxStmt::new(
            "UPDATE $task MERGE { owner_id: $owner_id, updated_at: $updated_at } RETURN NONE;",
        )
        .bind("task", task_record.clone())
        .bind("owner_id", member_id.to_owned())
        .bind("updated_at", now),
        TxStmt::new("DELETE $rel WHERE in = $task RETURN NONE;")
            .bind("rel", relation.clone())
            .bind("task", task_record.clone()),
        TxStmt::new(
            "INSERT RELATION INTO $rel [{ in: $task, out: $member, created_at: time::now() }] RETURN NONE;",
        )
        .bind("rel", relation)
        .bind("task", task_record)
        .bind("member", member_record),
    ];

    let _ = run_tx(statements).await?;
    Ok(())
}

async fn clear_task_assignment(task_id: &str) -> Result<()> {
    let _ = Repo::<Task>::select_by_string_id(task_id).await?;

    let now = now_timestamp_ms();
    let task_record = to_record_id::<Task>(task_id);
    let relation = Table::from(relation_name::<TaskAssignment>());

    let statements = vec![
        TxStmt::new("UPDATE $task MERGE { owner_id: NONE, updated_at: $updated_at } RETURN NONE;")
            .bind("task", task_record.clone())
            .bind("updated_at", now),
        TxStmt::new("DELETE $rel WHERE in = $task RETURN NONE;")
            .bind("rel", relation)
            .bind("task", task_record),
    ];

    let _ = run_tx(statements).await?;
    Ok(())
}

async fn set_many_task_status(task_ids: Vec<String>, status: &str) -> Result<()> {
    if task_ids.is_empty() {
        return Ok(());
    }

    let normalized = normalize_status(status)?.to_owned();
    let now = now_timestamp_ms();
    let mut seen = HashSet::new();
    let mut statements = Vec::new();

    for id in task_ids {
        if id.trim().is_empty() || !seen.insert(id.clone()) {
            continue;
        }

        let record = to_record_id::<Task>(&id);
        statements.push(
            TxStmt::new(
                "UPDATE $task MERGE { status: $status, updated_at: $updated_at } RETURN NONE;",
            )
            .bind("task", record)
            .bind("status", normalized.clone())
            .bind("updated_at", now),
        );
    }

    if statements.is_empty() {
        return Ok(());
    }

    statements.push(TxStmt::new("RETURN $count;").bind("count", statements.len() as i64));
    let _ = run_tx(statements).await?;
    Ok(())
}

async fn bootstrap_demo() -> Result<TemplateDashboard> {
    clear_all().await?;

    let members = [
        Member::new("mila", "Mila Chen", "Design"),
        Member::new("liam", "Liam Stone", "Engineering"),
        Member::new("sofia", "Sofia Park", "Operations"),
    ];

    for member in members {
        let _ = Repo::<Member>::upsert_by_string_id(member).await?;
    }

    let tasks = [
        Task::new(
            "landing-revamp",
            "Revamp landing hero",
            "Replace headline, compress illustration assets, and add social proof row.",
            STATUS_DOING,
            3,
        ),
        Task::new(
            "billing-audit",
            "Audit trial billing flow",
            "Verify tax rounding and retry logic in upgrade path.",
            STATUS_TODO,
            2,
        ),
        Task::new(
            "release-notes",
            "Ship v0.3 release notes",
            "Collect merged PR summaries and write migration section.",
            STATUS_DONE,
            1,
        ),
    ];

    for task in tasks {
        let _ = Repo::<Task>::upsert_by_string_id(task).await?;
    }

    set_task_assignment("landing-revamp", "mila").await?;
    set_task_assignment("billing-audit", "liam").await?;

    build_dashboard().await
}

#[tauri::command]
#[specta::specta]
pub async fn template_bootstrap() -> std::result::Result<TemplateDashboard, String> {
    bootstrap_demo().await.map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_snapshot() -> std::result::Result<TemplateDashboard, String> {
    build_dashboard().await.map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_create_member(
    input: NewMemberInput,
) -> std::result::Result<TemplateDashboard, String> {
    async {
        if input.id.trim().is_empty() {
            return Err(anyhow!("member id cannot be empty"));
        }
        if input.name.trim().is_empty() {
            return Err(anyhow!("member name cannot be empty"));
        }
        if input.role.trim().is_empty() {
            return Err(anyhow!("member role cannot be empty"));
        }

        let member = Member::new(input.id.trim(), input.name.trim(), input.role.trim());
        let _ = Repo::<Member>::upsert_by_string_id(member).await?;
        build_dashboard().await
    }
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_create_task(
    input: NewTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    async {
        if input.id.trim().is_empty() {
            return Err(anyhow!("task id cannot be empty"));
        }
        if input.title.trim().is_empty() {
            return Err(anyhow!("task title cannot be empty"));
        }
        if input.priority < 1 {
            return Err(anyhow!("priority must be >= 1"));
        }

        let status = normalize_status(&input.status)?;
        let task = Task::new(
            input.id.trim(),
            input.title.trim(),
            input.notes.trim(),
            status,
            input.priority,
        );
        let _ = Repo::<Task>::upsert_by_string_id(task).await?;
        build_dashboard().await
    }
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_assign_task(
    input: AssignTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    async {
        set_task_assignment(input.task_id.trim(), input.member_id.trim()).await?;
        build_dashboard().await
    }
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_unassign_task(
    input: UnassignTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    async {
        clear_task_assignment(input.task_id.trim()).await?;
        build_dashboard().await
    }
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_bulk_set_status(
    input: BulkStatusInput,
) -> std::result::Result<TemplateDashboard, String> {
    async {
        set_many_task_status(input.task_ids, &input.status).await?;
        build_dashboard().await
    }
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_reset() -> std::result::Result<TemplateDashboard, String> {
    async {
        clear_all().await?;
        build_dashboard().await
    }
    .await
    .map_err(|err| err.to_string())
}
