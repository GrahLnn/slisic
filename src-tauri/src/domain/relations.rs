use crate::{declare_relation, impl_schema};

declare_relation!(SignIn, "sign_in");
declare_relation!(TaskAssignment);

pub struct TaskAssignmentSchema;

impl_schema!(
    TaskAssignmentSchema,
    r#"
DEFINE TABLE task_assignment TYPE RELATION IN task OUT member;
DEFINE INDEX task_assignment_unique ON TABLE task_assignment FIELDS in, out UNIQUE;
"#
);
