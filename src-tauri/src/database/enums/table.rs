use std::fmt;

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
