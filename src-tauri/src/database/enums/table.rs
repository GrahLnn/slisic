use std::fmt;

pub trait TableName {
    fn table_name(&self) -> &str;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Table {
    User,
}

impl Table {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Table::User => "user",
        }
    }
}

impl fmt::Display for Table {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl TableName for Table {
    fn table_name(&self) -> &str {
        self.as_str()
    }
}