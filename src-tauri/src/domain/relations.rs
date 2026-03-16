#[derive(crate::Relation)]
pub struct TaskAssignment;

pub struct TaskAssignmentSchema;

crate::impl_schema!(
    TaskAssignmentSchema,
    r#"
DEFINE TABLE IF NOT EXISTS task_assignment TYPE RELATION IN task OUT member;
DEFINE INDEX IF NOT EXISTS task_assignment_unique ON task_assignment FIELDS in, out UNIQUE;
"#
);
