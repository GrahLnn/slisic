use serde_json::Value;
use surrealdb::types::{RecordId, ToSql};

pub struct QueryKind;

pub enum Order {
    Asc,
    Desc,
}

impl Order {
    fn as_str(&self) -> &'static str {
        match self {
            Order::Asc => "ASC",
            Order::Desc => "DESC",
        }
    }
}

impl QueryKind {
    pub fn range(table: &str, start: i64, end: i64) -> String {
        format!("SELECT * FROM {table}:{start}..={end};")
    }
    pub fn replace(id: RecordId, data: Value) -> String {
        format!("UPDATE {} REPLACE {data};", id.to_sql())
    }
    pub fn pagin(
        table: &str,
        count: i64,
        cursor: Option<String>,
        order: Order,
        order_key: &str,
    ) -> String {
        let than = match order {
            Order::Asc => ">",
            Order::Desc => "<",
        };
        match cursor {
            Some(cursor) => format!(
                "SELECT * FROM {table} WHERE {order_key} {than} {cursor} ORDER BY {order_key} {} LIMIT {count};",
                order.as_str()
            ),
            None => format!(
                "SELECT * FROM {table} ORDER BY {order_key} {} LIMIT {count};",
                order.as_str()
            ),
        }
    }
    pub fn rel_pagin(
        in_id: RecordId,
        table: &str,
        count: i64,
        cursor: Option<String>,
        order: Order,
        order_key: &str,
    ) -> String {
        let than = match order {
            Order::Asc => ">",
            Order::Desc => "<",
        };
        let in_id = in_id.to_sql();
        match cursor {
            Some(cursor) => format!(
                "SELECT * FROM {table} WHERE {order_key} {than} {cursor} AND in={in_id} ORDER BY {order_key} {} LIMIT {count};",
                order.as_str()
            ),
            None => format!(
                "SELECT * FROM {table} WHERE in={in_id} ORDER BY {order_key} {} LIMIT {count};",
                order.as_str()
            ),
        }
    }

    pub fn all_by_order(table: &str, order: Order, key: &str) -> String {
        format!("SELECT * FROM {table} ORDER BY {key} {};", order.as_str())
    }
    pub fn limit(table: &str, count: i64) -> String {
        format!("SELECT * FROM {table} LIMIT {count};")
    }
    pub fn insert(table: &str) -> String {
        format!("INSERT IGNORE INTO {table} $data;")
    }
    pub fn insert_replace(table: &str, keys: Vec<String>) -> String {
        let key_str = keys
            .iter()
            .map(|k| format!("{k}=$input.{k}"))
            .collect::<Vec<String>>()
            .join(",");
        format!("INSERT INTO {table} $data ON DUPLICATE KEY UPDATE {key_str};")
    }
    pub fn upsert_set(id: &str, key: &str, value: &str) -> String {
        format!("UPDATE {id} SET {key} = '{value}';")
    }
    pub fn select_id_single(table: &str) -> String {
        format!("RETURN (SELECT id FROM ONLY {table} WHERE $k = $v LIMIT 1).id;")
    }
    pub fn all_id(table: &str) -> String {
        format!("RETURN (SELECT id FROM {table}).id;")
    }
    pub fn single_field(table: &str, k: &str) -> String {
        format!("RETURN (SELECT {k} FROM {table}).{k};")
    }
    pub fn single_field_by_ids(ids: Vec<RecordId>, k: &str) -> String {
        format!(
            "RETURN (SELECT {k} FROM [{}]).{k};",
            ids.iter()
                .map(ToSql::to_sql)
                .collect::<Vec<String>>()
                .join(",")
        )
    }
    pub fn relate(self_id: RecordId, target_id: RecordId, rel: &str) -> String {
        format!(
            "RELATE {}->{rel}->{} SET created_at = time::now();",
            self_id.to_sql(),
            target_id.to_sql()
        )
    }
    pub fn unrelate(self_id: RecordId, target_id: RecordId, rel: &str) -> String {
        format!(
            "DELETE {}->{rel} WHERE out={} RETURN NONE;",
            self_id.to_sql(),
            target_id.to_sql()
        )
    }
    pub fn unrelate_all(self_id: RecordId, rel: &str) -> String {
        format!("DELETE {}->{rel};", self_id.to_sql())
    }
    pub fn rel_outs(in_id: RecordId, rel: &str, out_table: &str) -> String {
        format!("RETURN {}->{rel}->{out_table};", in_id.to_sql())
    }
    pub fn rel_ins(out_id: RecordId, rel: &str, in_table: &str) -> String {
        format!("RETURN {}<-{rel}<-{in_table};", out_id.to_sql())
    }
    pub fn rel_id(self_id: RecordId, rel: &str, target_id: RecordId) -> String {
        format!(
            "RETURN (SELECT * FROM ONLY {rel} WHERE in={} AND out={} LIMIT 1).id;",
            self_id.to_sql(),
            target_id.to_sql()
        )
    }
    pub fn create_return_id(table: &str) -> String {
        format!("RETURN (CREATE ONLY {table} CONTENT $data).id;")
    }
}
