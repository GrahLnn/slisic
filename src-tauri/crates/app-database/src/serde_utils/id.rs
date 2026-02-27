use serde::{Deserialize, Deserializer, Serializer};
use surrealdb::types::{RecordId, RecordIdKey, ToSql};

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StringOrRecordId {
    String(String),
    Record(RecordId),
}

fn record_key_to_string(key: RecordIdKey) -> String {
    match key {
        RecordIdKey::String(value) => value,
        RecordIdKey::Number(value) => value.to_string(),
        other => other.to_sql(),
    }
}

pub fn deserialize_string_or_record_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = StringOrRecordId::deserialize(deserializer)?;
    match value {
        StringOrRecordId::String(value) => Ok(value),
        StringOrRecordId::Record(record) => Ok(record_key_to_string(record.key)),
    }
}

pub fn serialize_string_id<S>(value: &str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(value)
}

#[cfg(test)]
mod tests {
    use super::{deserialize_string_or_record_id, serialize_string_id};
    use serde::{Deserialize, Serialize};
    use surrealdb::types::RecordId;

    #[derive(Debug, Deserialize)]
    struct RawId {
        #[serde(deserialize_with = "deserialize_string_or_record_id")]
        id: String,
    }

    #[derive(Debug, Serialize)]
    struct OutId {
        #[serde(serialize_with = "serialize_string_id")]
        id: String,
    }

    #[test]
    fn deserializes_string_id() {
        let row: RawId = serde_json::from_str(r#"{"id":"alice"}"#).expect("must deserialize");
        assert_eq!(row.id, "alice");
    }

    #[test]
    fn deserializes_record_id() {
        let record = RecordId::new("user", "alice");
        let json = format!(r#"{{"id":{}}}"#, serde_json::to_string(&record).unwrap());
        let row: RawId = serde_json::from_str(&json).expect("must deserialize record id");
        assert_eq!(row.id, "alice");
    }

    #[test]
    fn serializes_string_id() {
        let row = OutId {
            id: "alice".to_owned(),
        };
        let json = serde_json::to_string(&row).expect("must serialize");
        assert_eq!(json, r#"{"id":"alice"}"#);
    }
}
