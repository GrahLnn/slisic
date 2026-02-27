use serde::{Deserialize, Deserializer, Serialize, Serializer};
use specta::Type;
use std::fmt;
use surrealdb::types::{kind, Kind, Number, RecordId, RecordIdKey, SurrealValue, ToSql, Value};

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum IdOrRecordId {
    String(String),
    Number(i64),
    Record(RecordId),
}

fn record_key_to_id(key: RecordIdKey) -> Result<Id, String> {
    match key {
        RecordIdKey::String(value) => Ok(Id::String(value)),
        RecordIdKey::Number(value) => Ok(Id::Number(value)),
        other => Err(format!(
            "only string/number id is supported right now, got {}",
            other.to_sql()
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Type)]
#[serde(untagged)]
pub enum Id {
    String(String),
    Number(i64),
}

impl Id {
    pub fn as_string(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value.as_str()),
            Self::Number(_) => None,
        }
    }

    pub fn as_number(&self) -> Option<i64> {
        match self {
            Self::String(_) => None,
            Self::Number(value) => Some(*value),
        }
    }

    pub fn into_record_id_key(self) -> RecordIdKey {
        match self {
            Self::String(value) => RecordIdKey::String(value),
            Self::Number(value) => RecordIdKey::Number(value),
        }
    }
}

impl From<String> for Id {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for Id {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

impl From<i64> for Id {
    fn from(value: i64) -> Self {
        Self::Number(value)
    }
}

impl From<Id> for RecordIdKey {
    fn from(value: Id) -> Self {
        value.into_record_id_key()
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::String(value) => f.write_str(value),
            Self::Number(value) => write!(f, "{value}"),
        }
    }
}

impl Serialize for Id {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::String(value) => serializer.serialize_str(value),
            Self::Number(value) => serializer.serialize_i64(*value),
        }
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = IdOrRecordId::deserialize(deserializer)?;
        match value {
            IdOrRecordId::String(value) => Ok(Self::String(value)),
            IdOrRecordId::Number(value) => Ok(Self::Number(value)),
            IdOrRecordId::Record(record) => record_key_to_id(record.key).map_err(|message| {
                <D::Error as serde::de::Error>::custom(format!(
                    "failed to deserialize id from record id: {message}"
                ))
            }),
        }
    }
}

impl SurrealValue for Id {
    fn kind_of() -> Kind {
        kind!(string | number)
    }

    fn is_value(value: &Value) -> bool {
        match value {
            Value::String(_) | Value::Number(Number::Int(_)) => true,
            Value::RecordId(record) => {
                matches!(record.key, RecordIdKey::String(_) | RecordIdKey::Number(_))
            }
            _ => false,
        }
    }

    fn into_value(self) -> Value {
        match self {
            Self::String(value) => Value::String(value),
            Self::Number(value) => Value::Number(Number::Int(value)),
        }
    }

    fn from_value(value: Value) -> Result<Self, surrealdb::types::Error> {
        match value {
            Value::String(value) => Ok(Self::String(value)),
            Value::Number(Number::Int(value)) => Ok(Self::Number(value)),
            Value::RecordId(record) => record_key_to_id(record.key)
                .map_err(|message| surrealdb::types::Error::internal(message)),
            other => Err(surrealdb::types::Error::internal(format!(
                "expected string/number/record id for Id, got {}",
                other.kind().to_sql()
            ))),
        }
    }
}

pub fn deserialize_id_or_record_id_as_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Id::deserialize(deserializer)?;
    Ok(value.to_string())
}

pub fn serialize_id_as_string<S>(value: &str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(value)
}

#[cfg(test)]
mod tests {
    use super::{deserialize_id_or_record_id_as_string, serialize_id_as_string, Id};
    use serde::{Deserialize, Serialize};
    use surrealdb::types::RecordId;

    #[derive(Debug, Deserialize)]
    struct RawId {
        #[serde(deserialize_with = "deserialize_id_or_record_id_as_string")]
        id: String,
    }

    #[derive(Debug, Serialize)]
    struct OutId {
        #[serde(serialize_with = "serialize_id_as_string")]
        id: String,
    }

    #[derive(Debug, Deserialize)]
    struct WrappedId {
        id: Id,
    }

    #[derive(Debug, Serialize)]
    struct OutWrappedId {
        id: Id,
    }

    #[test]
    fn deserializes_id_string() {
        let row: RawId = serde_json::from_str(r#"{"id":"alice"}"#).expect("must deserialize");
        assert_eq!(row.id, "alice");
    }

    #[test]
    fn deserializes_number_id_into_string() {
        let row: RawId = serde_json::from_str(r#"{"id":42}"#).expect("must deserialize");
        assert_eq!(row.id, "42");
    }

    #[test]
    fn deserializes_record_id() {
        let record = RecordId::new("user", "alice");
        let json = format!(r#"{{"id":{}}}"#, serde_json::to_string(&record).unwrap());
        let row: RawId = serde_json::from_str(&json).expect("must deserialize record id");
        assert_eq!(row.id, "alice");
    }

    #[test]
    fn serializes_id_string() {
        let row = OutId {
            id: "alice".to_owned(),
        };
        let json = serde_json::to_string(&row).expect("must serialize");
        assert_eq!(json, r#"{"id":"alice"}"#);
    }

    #[test]
    fn id_accepts_plain_string() {
        let row: WrappedId = serde_json::from_str(r#"{"id":"alice"}"#).expect("must deserialize");
        assert_eq!(row.id, Id::String("alice".to_owned()));
    }

    #[test]
    fn id_accepts_plain_number() {
        let row: WrappedId = serde_json::from_str(r#"{"id":42}"#).expect("must deserialize");
        assert_eq!(row.id, Id::Number(42));
    }

    #[test]
    fn id_accepts_record_id_string() {
        let record = RecordId::new("user", "alice");
        let json = format!(r#"{{"id":{}}}"#, serde_json::to_string(&record).unwrap());
        let row: WrappedId = serde_json::from_str(&json).expect("must deserialize record id");
        assert_eq!(row.id, Id::String("alice".to_owned()));
    }

    #[test]
    fn id_accepts_record_id_number() {
        let record = RecordId::new("user", 42i64);
        let json = format!(r#"{{"id":{}}}"#, serde_json::to_string(&record).unwrap());
        let row: WrappedId = serde_json::from_str(&json).expect("must deserialize record id");
        assert_eq!(row.id, Id::Number(42));
    }

    #[test]
    fn id_serializes_string_as_string() {
        let row = OutWrappedId {
            id: Id::from("alice"),
        };
        let json = serde_json::to_string(&row).expect("must serialize");
        assert_eq!(json, r#"{"id":"alice"}"#);
    }

    #[test]
    fn id_serializes_number_as_number() {
        let row = OutWrappedId {
            id: Id::from(42i64),
        };
        let json = serde_json::to_string(&row).expect("must serialize");
        assert_eq!(json, r#"{"id":42}"#);
    }
}
