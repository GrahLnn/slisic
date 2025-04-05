use super::enums::table::Table;

pub enum QueryKind {
    FindUser,
    CreatePost,
    InitAccess,
}

impl QueryKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            QueryKind::FindUser => "SELECT * FROM user WHERE name = $name",
            QueryKind::CreatePost => "INSERT INTO posts CONTENT $data",
            QueryKind::InitAccess => {
                r#"
                    DEFINE ACCESS account ON DATABASE TYPE RECORD
                    SIGNUP ( CREATE user SET name = root, pass = crypto::argon2::generate($pass) )
                    SIGNIN ( SELECT * FROM user WHERE name = root AND crypto::argon2::compare(pass, $pass) )
                    DURATION FOR TOKEN 15m, FOR SESSION 12h
                "#
            }
        }
    }
    pub fn range_query(table: Table, start: i64, end: i64) -> String {
        let table_name = table.as_str();
        format!("SELECT * FROM {table_name}:{start}..={end};")
    }
}
