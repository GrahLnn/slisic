use serde_json::Value;
use surrealdb::RecordId;

use super::enums::table::Table;

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
    pub fn pagin(table: Table, count: i64, cursor: Option<RecordId>, order: Order) -> String {
        let than = match order {
            Order::Asc => ">",
            Order::Desc => "<",
        };
        let table_name = table.as_str();
        match cursor {
            Some(cursor) => format!(
                "SELECT * FROM {table_name} WHERE id {than} {cursor} ORDER BY id {} LIMIT {count};",
                order.as_str()
            ),
            None => format!(
                "SELECT * FROM {table_name} ORDER BY id {} LIMIT {count};",
                order.as_str()
            ),
        }
    }
    pub fn all_by_order(table: Table, order: Order, key: &str) -> String {
        let table_name = table.as_str();
        format!(
            "SELECT * FROM {table_name} ORDER BY {key} {};",
            order.as_str()
        )
    }
    pub fn limit(table: Table, count: i64) -> String {
        let table_name = table.as_str();
        format!("SELECT * FROM {table_name} LIMIT {count};")
    }
    pub fn insert(table: &str) -> String {
        format!("INSERT INTO {table} $data ON DUPLICATE KEY UPDATE id = id;")
    }
    pub fn upsert_set(id: &str, key: &str, value: &str) -> String {
        format!("UPDATE {id} SET {key} = '{value}';")
    }
    pub fn select_id_single(table: Table, k: &str, v: &str) -> String {
        format!(
            "RETURN (SELECT id FROM ONLY {} WHERE {k} = '{v}' LIMIT 1).id;",
            table.as_str()
        )
    }
}
