use appdb::model::relation::relation_name;
use appdb::{Relation, impl_schema};

#[derive(Debug, Clone, Copy, Relation)]
#[relation(name = "sign_in")]
pub struct SignIn;

#[derive(Debug, Clone, Copy, Relation)]
pub struct TaskAssignment;

pub struct TaskAssignmentSchema;

impl_schema!(
    TaskAssignmentSchema,
    r#"
DEFINE TABLE task_assignment TYPE RELATION IN task OUT member;
DEFINE INDEX task_assignment_unique ON TABLE task_assignment FIELDS in, out UNIQUE;
"#
);

#[cfg(test)]
mod tests {
    use super::{SignIn, TaskAssignment};
    use appdb::model::relation::relation_name;

    #[test]
    fn appdb_domain_relations_true_positive_register_expected_relation_names() {
        assert_eq!(relation_name::<SignIn>(), "sign_in");
        assert_eq!(relation_name::<TaskAssignment>(), "task_assignment");
    }
}
