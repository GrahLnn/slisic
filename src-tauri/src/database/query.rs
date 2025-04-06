use super::enums::table::Table;

pub enum QueryKind {
    FindUser,
    CreatePost,
    InitAccess,
    CheckRootUser,
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
    pub fn insert(table: &str) -> String {
        format!("INSERT INTO {table} $data ON DUPLICATE KEY UPDATE id = id;")
    }
}
