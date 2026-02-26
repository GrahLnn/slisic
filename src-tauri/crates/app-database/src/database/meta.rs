use serde::{Deserialize, Serialize};
use surrealdb::types::{RecordId, RecordIdKey, SurrealValue};

use super::enums::table::Table;

pub trait HasId {
    fn id(&self) -> RecordId;
}

pub trait HasStringId {
    fn id_str(&self) -> &str;
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
    const TABLE: Table;

    fn record_id<T>(id: T) -> RecordId
    where
        RecordIdKey: From<T>,
    {
        RecordId::new(Self::TABLE.as_str(), id)
    }
}

#[macro_export]
macro_rules! impl_id {
    ($t:ty, $id:ident) => {
        impl $crate::database::meta::HasId for $t {
            fn id(&self) -> surrealdb::types::RecordId {
                self.$id.clone()
            }
        }
    };
    ($t:ty, $($path:tt)+) => {
        impl $crate::database::meta::HasId for $t {
            fn id(&self) -> surrealdb::types::RecordId {
                self.$($path)+.clone()
            }
        }
    };
}

#[macro_export]
macro_rules! impl_string_id {
    ($t:ty, $id:ident) => {
        impl $crate::database::meta::HasStringId for $t {
            fn id_str(&self) -> &str {
                self.$id.as_str()
            }
        }
    };
    ($t:ty, $($path:tt)+) => {
        impl $crate::database::meta::HasStringId for $t {
            fn id_str(&self) -> &str {
                self.$($path)+.as_str()
            }
        }
    };
}
