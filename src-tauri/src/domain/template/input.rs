use crate::domain::models::member::Member;
use crate::domain::models::task::Task;
use serde::{Deserialize, Serialize};
use specta::Type;

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
