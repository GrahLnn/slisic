use appdb::model::meta::ModelMeta;
use appdb::prelude::{query_bound_checked, relation_name, Crud, GraphCrud, HasId, RawSqlStmt};
use crate::domain::models::member::Member;
use crate::domain::models::task::{Task, STATUS_DOING, STATUS_DONE, STATUS_TODO};
use crate::domain::relations::TaskAssignment;
use anyhow::{anyhow, Result};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use surrealdb::types::{RecordIdKey, Table, ToSql};

use super::input::{
    AssignTaskInput, BulkStatusInput, DemoStats, NewMemberInput, NewTaskInput, TaskAssignmentView,
    TemplateDashboard, UnassignTaskInput,
};

const TASK_ASSIGNMENT_RELATION: &str = "task_assignment";

fn now_timestamp_ms() -> i64 {
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

async fn clear_relation_table() -> Result<()> {
    let rel = relation_name::<TaskAssignment>();
    let result = query_bound_checked(
        RawSqlStmt::new("DELETE $table RETURN NONE;").bind("table", Table::from(rel)),
    )
    .await;

    if let Err(err) = result {
        let message = err.to_string();
        if message.contains("does not exist") {
            return Ok(());
        }

        if message.contains("not a relation but expected a RELATION") {
            rebuild_task_assignment_relation(rel).await?;
            return Ok(());
        }

        return Err(err.into());
    }

    Ok(())
}

async fn rebuild_task_assignment_relation(rel: &str) -> Result<()> {
    let rel_name = rel.to_owned();
    let unique_index = format!("{rel_name}_unique");
    query_bound_checked(
        RawSqlStmt::new(
            "REMOVE TABLE $rel;\
             DEFINE TABLE $rel TYPE RELATION IN $task_table OUT $member_table;\
             DEFINE INDEX $index ON TABLE $rel FIELDS in, out UNIQUE;",
        )
        .bind("rel", Table::from(rel_name))
        .bind("task_table", Table::from(Task::table_name()))
        .bind("member_table", Table::from(Member::table_name()))
        .bind("index", Table::from(unique_index)),
    )
    .await?;
    Ok(())
}

async fn clear_all() -> Result<()> {
    clear_relation_table().await?;
    Task::delete_all().await?;
    Member::delete_all().await?;
    Ok(())
}

async fn normalize_task_owner_id_nulls() -> Result<()> {
    let mut last_error: Option<anyhow::Error> = None;

    let attempts = [
        RawSqlStmt::new("UPDATE $table SET owner_id = NONE WHERE owner_id IS NULL RETURN NONE;")
            .bind("table", Table::from(Task::table_name())),
        RawSqlStmt::new("UPDATE $table UNSET owner_id WHERE owner_id IS NULL RETURN NONE;")
            .bind("table", Table::from(Task::table_name())),
        RawSqlStmt::new("DELETE $table WHERE owner_id IS NULL RETURN NONE;")
            .bind("table", Table::from(Task::table_name())),
    ];

    for query in attempts {
        match query_bound_checked(query).await {
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
    let mut links = Vec::new();

    for task in tasks {
        let member_records = appdb::graph::out_ids(
            task.id(),
            TASK_ASSIGNMENT_RELATION,
            Member::table_name(),
        )
        .await?;
        for member in member_records {
            links.push(TaskAssignmentView {
                task_id: task.id.to_string(),
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

    let mut members = Member::list().await?;
    members.sort_by(|left, right| left.name.cmp(&right.name));

    let mut tasks = Task::list().await?;
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
    let _ = Task::get(task_id).await?;
    let _ = Member::get(member_id).await?;

    let now = now_timestamp_ms();
    let task = Task::get(task_id).await?;
    let member = Member::get(member_id).await?;

    Task::merge(
        task.id(),
        serde_json::json!({
            "owner_id": member_id,
            "updated_at": now,
        }),
    )
    .await?;
    task.unrelate::<TaskAssignment, _>(&member).await.ok();
    appdb::graph::GraphRepo::unrelate_all(task.id(), TASK_ASSIGNMENT_RELATION).await?;
    task.relate::<TaskAssignment, _>(&member).await?;
    Ok(())
}

async fn clear_task_assignment(task_id: &str) -> Result<()> {
    let task = Task::get(task_id).await?;

    let now = now_timestamp_ms();

    Task::merge(
        task.id(),
        serde_json::json!({
            "owner_id": serde_json::Value::Null,
            "updated_at": now,
        }),
    )
    .await?;
    appdb::graph::GraphRepo::unrelate_all(task.id(), TASK_ASSIGNMENT_RELATION).await?;
    Ok(())
}

async fn set_many_task_status(task_ids: Vec<String>, status: &str) -> Result<()> {
    if task_ids.is_empty() {
        return Ok(());
    }

    let normalized = normalize_status(status)?.to_owned();
    let now = now_timestamp_ms();
    let mut seen = HashSet::new();

    for id in task_ids {
        if id.trim().is_empty() || !seen.insert(id.clone()) {
            continue;
        }

        let task = Task::get(id).await?;
        Task::merge(
            task.id(),
            serde_json::json!({
                "status": normalized,
                "updated_at": now,
            }),
        )
        .await?;
    }

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
        let _ = member.save().await?;
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
        let _ = task.save().await?;
    }

    set_task_assignment("landing-revamp", "mila").await?;
    set_task_assignment("billing-audit", "liam").await?;

    build_dashboard().await
}

pub async fn bootstrap() -> Result<TemplateDashboard> {
    bootstrap_demo().await
}

pub async fn snapshot() -> Result<TemplateDashboard> {
    build_dashboard().await
}

pub async fn create_member(input: NewMemberInput) -> Result<TemplateDashboard> {
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
    let _ = member.save().await?;
    build_dashboard().await
}

pub async fn create_task(input: NewTaskInput) -> Result<TemplateDashboard> {
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
    let _ = task.save().await?;
    build_dashboard().await
}

pub async fn assign_task(input: AssignTaskInput) -> Result<TemplateDashboard> {
    set_task_assignment(input.task_id.trim(), input.member_id.trim()).await?;
    build_dashboard().await
}

pub async fn unassign_task(input: UnassignTaskInput) -> Result<TemplateDashboard> {
    clear_task_assignment(input.task_id.trim()).await?;
    build_dashboard().await
}

pub async fn bulk_set_status(input: BulkStatusInput) -> Result<TemplateDashboard> {
    set_many_task_status(input.task_ids, &input.status).await?;
    build_dashboard().await
}

pub async fn reset() -> Result<TemplateDashboard> {
    clear_all().await?;
    build_dashboard().await
}
