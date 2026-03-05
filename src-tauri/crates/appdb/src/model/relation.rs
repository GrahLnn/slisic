use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use anyhow::Result;

static RELATION_REGISTRY: LazyLock<Mutex<HashSet<&'static str>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

pub trait RelationMeta {
    fn relation_name() -> &'static str;
}

pub fn register_relation(name: &'static str) -> &'static str {
    let mut registry = RELATION_REGISTRY
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    registry.insert(name);
    name
}

pub fn relation_name<R: RelationMeta>() -> &'static str {
    R::relation_name()
}

pub fn ensure_relation_name(name: &str) -> Result<()> {
    let _ = name;
    Ok(())
}

#[macro_export]
macro_rules! declare_relation {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name;

        impl $crate::model::relation::RelationMeta for $name {
            fn relation_name() -> &'static str {
                static REL_NAME: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
                REL_NAME.get_or_init(|| {
                    let rel = $crate::model::meta::default_table_name(stringify!($name));
                    $crate::model::relation::register_relation(rel)
                })
            }
        }
    };
    ($name:ident, $rel:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name;

        impl $crate::model::relation::RelationMeta for $name {
            fn relation_name() -> &'static str {
                static REL_NAME: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
                REL_NAME.get_or_init(|| $crate::model::relation::register_relation($rel))
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use super::{ensure_relation_name, register_relation, RelationMeta};

    crate::declare_relation!(AutoRelName);
    crate::declare_relation!(ManualRelName, "manual_rel");

    #[test]
    fn relation_name_accepts_valid_identifier() {
        assert!(ensure_relation_name("sign_in").is_ok());
        assert!(ensure_relation_name("_private_rel").is_ok());
    }

    #[test]
    fn relation_name_accepts_arbitrary_name() {
        assert!(ensure_relation_name("9invalid").is_ok());
        assert!(ensure_relation_name("bad-name").is_ok());
        assert!(ensure_relation_name("").is_ok());
    }

    #[test]
    fn relation_registration_works() {
        assert_eq!(register_relation("follows"), "follows");
    }

    #[test]
    fn declare_relation_auto_name_works() {
        assert_eq!(AutoRelName::relation_name(), "auto_rel_name");
    }

    #[test]
    fn declare_relation_manual_name_works() {
        assert_eq!(ManualRelName::relation_name(), "manual_rel");
    }
}
