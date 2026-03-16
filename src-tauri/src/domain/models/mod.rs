pub mod member;
pub mod task;
pub mod user;

#[cfg(test)]
mod tests {
    use super::{member::Member, task::Task, user::User};
    use appdb::model::meta::{ModelMeta, UniqueLookupMeta};

    #[test]
    fn appdb_domain_models_true_positive_register_expected_table_names() {
        assert_eq!(User::table_name(), "user");
        assert_eq!(Member::table_name(), "member");
        assert_eq!(Task::table_name(), "task");
    }

    #[test]
    fn appdb_domain_models_true_negative_exclude_id_from_lookup_fields() {
        assert_eq!(User::lookup_fields(), &[] as &[&str]);
        assert!(!Member::lookup_fields().contains(&"id"));
        assert!(!Task::lookup_fields().contains(&"id"));
    }
}
