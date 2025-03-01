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