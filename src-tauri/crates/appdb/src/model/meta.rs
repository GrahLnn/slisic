use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use surrealdb::types::{RecordId, RecordIdKey, SurrealValue};

static TABLE_REGISTRY: LazyLock<Mutex<HashMap<&'static str, &'static str>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub trait HasId {
    fn id(&self) -> RecordId;
}

pub trait ModelMeta:
    Serialize
    + for<'de> Deserialize<'de>
    + SurrealValue
    + std::fmt::Debug
    + 'static
    + Clone
    + Send
    + Sync
{
    fn table_name() -> &'static str;

    fn record_id<T>(id: T) -> RecordId
    where
        RecordIdKey: From<T>,
    {
        RecordId::new(Self::table_name(), id)
    }
}

pub fn register_table(model: &'static str, table: &'static str) -> &'static str {
    let mut registry = TABLE_REGISTRY.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(existing) = registry.get(model) {
        return *existing;
    }
    registry.insert(model, table);
    table
}

pub fn default_table_name(type_name: &str) -> &'static str {
    let bare = type_name.rsplit("::").next().unwrap_or(type_name);
    let snake = to_snake_case(bare);
    Box::leak(snake.into_boxed_str())
}

fn to_snake_case(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 4);
    let mut prev_is_lower_or_digit = false;

    for ch in input.chars() {
        if ch.is_ascii_uppercase() {
            if prev_is_lower_or_digit {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
            prev_is_lower_or_digit = false;
        } else {
            out.push(ch);
            prev_is_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        }
    }

    out
}

#[macro_export]
macro_rules! impl_id {
    ($t:ty, $id:ident) => {
        impl $crate::model::meta::HasId for $t {
            fn id(&self) -> surrealdb::types::RecordId {
                self.$id.clone()
            }
        }
    };
    ($t:ty, $($path:tt)+) => {
        impl $crate::model::meta::HasId for $t {
            fn id(&self) -> surrealdb::types::RecordId {
                self.$($path)+.clone()
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use super::{default_table_name, register_table};

    #[test]
    fn table_name_is_snake_case() {
        assert_eq!(default_table_name("User"), "user");
        assert_eq!(default_table_name("UserProfile"), "user_profile");
        assert_eq!(default_table_name("crate::domain::DbUser"), "db_user");
    }

    #[test]
    fn register_table_is_idempotent_for_model() {
        let first = register_table("ModelA", "alpha");
        let second = register_table("ModelA", "beta");
        assert_eq!(first, "alpha");
        assert_eq!(second, "alpha");
    }
}
