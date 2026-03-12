use appdb::Sensitive;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Sensitive)]
struct InvalidRecord {
    #[secure]
    pub counter: u32,
}

fn main() {}
