use std::fmt::Display;

use serde_json::Value;
use surrealdb::RecordId;

use super::enums::table::{Rel, Table, TableName};

pub enum QueryKind {
    FindUser,
    CreatePost,
    InitAccess,
    CheckRootUser,
}

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
    pub fn as_str(&self) -> &'static str {
        match self {
            QueryKind::FindUser => "SELECT * FROM user WHERE name = $name",
            QueryKind::CreatePost => "INSERT INTO posts CONTENT $data",
            QueryKind::InitAccess => {
                r#"
                    DEFINE TABLE user SCHEMAFULL;
                    DEFINE FIELD user ON user TYPE string;
                    DEFINE FIELD pass ON user TYPE string;
                    DEFINE INDEX idx_unique_user ON user FIELDS user UNIQUE;

                    DEFINE ACCESS account ON DATABASE TYPE RECORD
                    SIGNUP (
                        CREATE user SET user = $user, pass = crypto::argon2::generate($pass)
                    )
                    SIGNIN (
                        SELECT * FROM user WHERE user = $user AND crypto::argon2::compare(pass, $pass)
                    )
                    DURATION FOR TOKEN 15m, FOR SESSION 12h;
                "#
            }
            QueryKind::CheckRootUser => {
                r#"return (select * from user).find(|$v| $v.user = "root") != none"#
            }
        }
    }
    pub fn range(table: Table, start: i64, end: i64) -> String {
        let table_name = table.as_str();
        format!("SELECT * FROM {table_name}:{start}..={end};")
    }
    pub fn replace(id: RecordId, data: Value) -> String {
        format!("UPDATE {id} REPLACE {data};")
    }
    pub fn pagin<T: TableName>(
        table: T,
        count: i64,
        cursor: Option<String>,
        order: Order,
        order_key: &str,
    ) -> String {
        let than = match order {
            Order::Asc => ">",
            Order::Desc => "<",
        };
        let table_name = table.table_name();
        match cursor {
            Some(cursor) => format!(
                "SELECT * FROM {table_name} WHERE {order_key} {than} {cursor} ORDER BY {order_key} {} LIMIT {count};",
                order.as_str()
            ),
            None => format!(
                "SELECT * FROM {table_name} ORDER BY {order_key} {} LIMIT {count};",
                order.as_str()
            ),
        }
    }
    pub fn rel_pagin<T: TableName>(
        in_id: RecordId,
        table: T,
        count: i64,
        cursor: Option<String>,
        order: Order,
        order_key: &str,
    ) -> String {
        let than = match order {
            Order::Asc => ">",
            Order::Desc => "<",
        };
        let table_name = table.table_name();
        match cursor {
            Some(cursor) => format!(
                "SELECT * FROM {table_name} WHERE {order_key} {than} {cursor} AND in={in_id} ORDER BY {order_key} {} LIMIT {count};",
                order.as_str()
            ),
            None => format!(
                "SELECT * FROM {table_name} WHERE in={in_id} ORDER BY {order_key} {} LIMIT {count};",
                order.as_str()
            ),
        }
    }

    pub fn all_by_order<T: TableName>(table: T, order: Order, key: &str) -> String {
        let table_name = table.table_name();
        format!(
            "SELECT * FROM {table_name} ORDER BY {key} {};",
            order.as_str()
        )
    }
    pub fn limit<T: TableName>(table: T, count: i64) -> String {
        let table_name = table.table_name();
        format!("SELECT * FROM {table_name} LIMIT {count};")
    }
    pub fn insert(table: Table) -> String {
        format!("INSERT IGNORE INTO {table} $data;")
    }
    pub fn insert_replace(table: Table, keys: Vec<String>) -> String {
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
    pub fn select_id_single(table: Table) -> String {
        format!(
            "RETURN (SELECT id FROM ONLY {} WHERE $k = $v LIMIT 1).id;",
            table.table_name()
        )
    }
    pub fn all_id(table: Table) -> String {
        format!("RETURN (SELECT id FROM {table}).id;")
    }
    pub fn single_field<T: TableName + Display>(table: T, k: &str) -> String {
        format!("RETURN (SELECT {k} FROM {table}).{k};")
    }
    pub fn single_field_by_ids(ids: Vec<RecordId>, k: &str) -> String {
        format!(
            "RETURN (SELECT {k} FROM [{}]).{k};",
            ids.iter()
                .map(|id| id.to_string())
                .collect::<Vec<String>>()
                .join(",")
        )
    }
    pub fn relate(self_id: RecordId, target_id: RecordId, rel: Rel) -> String {
        format!("RELATE {self_id}->{rel}->{target_id} SET created_at = time::now();")
    }
    pub fn unrelate(self_id: RecordId, target_id: RecordId, rel: Rel) -> String {
        format!("DELETE {self_id}->{rel} WHERE out={target_id} RETURN NONE;")
    }
    pub fn unrelate_all(self_id: RecordId, rel: Rel) -> String {
        format!("DELETE {self_id}->{rel};")
    }
    pub fn rel_outs(in_id: RecordId, rel: Rel, out_table: Table) -> String {
        format!("RETURN {in_id}->{rel}->{out_table};")
    }
    pub fn rel_ins(out_id: RecordId, rel: Rel, in_table: Table) -> String {
        format!("RETURN {out_id}<-{rel}<-{in_table};")
    }
    pub fn rel_id(self_id: RecordId, rel: Rel, target_id: RecordId) -> String {
        format!(
            "RETURN (SELECT * FROM ONLY {rel} WHERE in={self_id} AND out={target_id} LIMIT 1).id;"
        )
    }
    pub fn create_return_id(table: Table) -> String {
        format!("RETURN (CREATE ONLY {table} CONTENT $data).id;")
    }
}
