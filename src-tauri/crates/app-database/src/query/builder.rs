use serde_json::Value;
use surrealdb::types::RecordId;

pub struct QueryKind;

pub enum Order {
    Asc,
    Desc,
}

impl QueryKind {
    pub fn range(_table: &str, _start: i64, _end: i64) -> String {
        "SELECT * FROM type::record($table, $start)..=type::record($table, $end);".to_owned()
    }
    pub fn replace(_id: RecordId, _data: Value) -> String {
        "UPDATE $id REPLACE $data;".to_owned()
    }
    pub fn pagin(
        _table: &str,
        _count: i64,
        cursor: Option<String>,
        order: Order,
        _order_key: &str,
    ) -> String {
        match (cursor.is_some(), order) {
            (true, Order::Asc) => {
                "SELECT * FROM $table WHERE [$order_key] > $cursor ORDER BY [$order_key] ASC LIMIT $count;"
                    .to_owned()
            }
            (true, Order::Desc) => {
                "SELECT * FROM $table WHERE [$order_key] < $cursor ORDER BY [$order_key] DESC LIMIT $count;"
                    .to_owned()
            }
            (false, Order::Asc) => {
                "SELECT * FROM $table ORDER BY [$order_key] ASC LIMIT $count;"
                    .to_owned()
            }
            (false, Order::Desc) => {
                "SELECT * FROM $table ORDER BY [$order_key] DESC LIMIT $count;"
                    .to_owned()
            }
        }
    }
    pub fn rel_pagin(
        _in_id: &RecordId,
        _table: &str,
        _count: i64,
        cursor: Option<String>,
        order: Order,
        _order_key: &str,
    ) -> String {
        let (than, order_str) = match order {
            Order::Asc => (">", "ASC"),
            Order::Desc => ("<", "DESC"),
        };
        match cursor {
            Some(_) => format!(
                "SELECT * FROM $table WHERE [$order_key] {than} $cursor AND in = $in ORDER BY [$order_key] {order_str} LIMIT $count;"
            ),
            None => format!(
                "SELECT * FROM $table WHERE in = $in ORDER BY [$order_key] {order_str} LIMIT $count;"
            ),
        }
    }

    pub fn all_by_order(_table: &str, order: Order, _key: &str) -> String {
        match order {
            Order::Asc => "SELECT * FROM $table ORDER BY [$key] ASC;".to_owned(),
            Order::Desc => "SELECT * FROM $table ORDER BY [$key] DESC;".to_owned(),
        }
    }
    pub fn limit(_table: &str, _count: i64) -> String {
        "SELECT * FROM $table LIMIT $count;".to_owned()
    }
    pub fn insert(_table: &str) -> String {
        "INSERT IGNORE INTO $table $data;".to_owned()
    }
    pub fn insert_replace(_table: &str, keys: Vec<String>) -> String {
        let mut sql = String::from("INSERT INTO $table $data ON DUPLICATE KEY UPDATE ");
        for (idx, key) in keys.iter().enumerate() {
            if idx > 0 {
                sql.push(',');
            }
            sql.push_str(key);
            sql.push_str("=$input.");
            sql.push_str(key);
        }
        sql.push(';');
        sql
    }
    pub fn upsert_set(id: &str, key: &str, _value: &str) -> String {
        let _ = (id, key);
        "UPDATE $id SET [$key] = $value;".to_owned()
    }
    pub fn select_id_single(_table: &str) -> String {
        "RETURN (SELECT id FROM ONLY $table WHERE [$k] = $v LIMIT 1).id;".to_owned()
    }
    pub fn all_id(_table: &str) -> String {
        "RETURN (SELECT id FROM $table).id;".to_owned()
    }
    pub fn single_field(_table: &str, _k: &str) -> String {
        "RETURN (SELECT VALUE [$k] FROM $table);".to_owned()
    }
    pub fn single_field_by_ids(_ids: Vec<RecordId>, _k: &str) -> String {
        "RETURN (SELECT VALUE [$k] FROM $ids);".to_owned()
    }
    pub fn relate(_self_id: &RecordId, _target_id: &RecordId, _rel: &str) -> String {
        "INSERT RELATION INTO $rel [{ in: $in, out: $out, created_at: time::now() }] RETURN NONE;"
            .to_owned()
    }
    pub fn unrelate(_self_id: &RecordId, _target_id: &RecordId, _rel: &str) -> String {
        "DELETE $rel WHERE in = $in AND out = $out RETURN NONE;".to_owned()
    }
    pub fn unrelate_all(_self_id: &RecordId, _rel: &str) -> String {
        "DELETE $rel WHERE in = $in RETURN NONE;".to_owned()
    }
    pub fn rel_outs(_in_id: &RecordId, _rel: &str, _out_table: &str) -> String {
        "RETURN (SELECT VALUE out FROM $rel WHERE in = $in AND record::tb(out) = $out_table);"
            .to_owned()
    }
    pub fn rel_ins(_out_id: &RecordId, _rel: &str, _in_table: &str) -> String {
        "RETURN (SELECT VALUE in FROM $rel WHERE out = $out AND record::tb(in) = $in_table);"
            .to_owned()
    }
    pub fn rel_id(_self_id: &RecordId, _rel: &str, _target_id: &RecordId) -> String {
        "RETURN (SELECT * FROM ONLY $rel WHERE in = $in AND out = $out LIMIT 1).id;".to_owned()
    }
    pub fn create_return_id(_table: &str) -> String {
        "RETURN (CREATE ONLY $table CONTENT $data).id;".to_owned()
    }
    pub fn delete_record() -> String {
        "DELETE $record RETURN NONE;".to_owned()
    }
    pub fn delete_table() -> String {
        "DELETE $table RETURN NONE;".to_owned()
    }
    pub fn select_by_string_id() -> String {
        "RETURN (SELECT *, type::string(record::id(id)) AS id FROM ONLY $record);".to_owned()
    }
    pub fn select_all_string_id() -> String {
        "SELECT *, type::string(record::id(id)) AS id FROM $table;".to_owned()
    }
    pub fn select_limit_string_id() -> String {
        "SELECT *, type::string(record::id(id)) AS id FROM $table LIMIT $count;".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::QueryKind;
    use surrealdb::types::RecordId;

    #[test]
    fn pagin_uses_bind_placeholders() {
        let sql = QueryKind::pagin(
            "user",
            10,
            Some("abc'; DELETE user; --".to_owned()),
            super::Order::Asc,
            "id",
        );
        assert!(sql.contains("$cursor"));
        assert!(sql.contains("LIMIT $count"));
    }

    #[test]
    fn relation_lookups_use_bind_placeholders() {
        let in_id = RecordId::new("user", "u1");
        let sql = QueryKind::rel_outs(&in_id, "follows", "user");
        assert!(sql.contains("FROM $rel"));
        assert!(sql.contains("record::tb(out) = $out_table"));
    }

    #[test]
    fn relate_uses_relation_insert() {
        let in_id = RecordId::new("task", "t1");
        let out_id = RecordId::new("member", "m1");
        let sql = QueryKind::relate(&in_id, &out_id, "task_assignment");
        assert!(sql.starts_with("INSERT RELATION INTO $rel"));
    }
}
