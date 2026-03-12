use appdb::Sensitive;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Sensitive)]
struct PlainRecord {
    pub issuer: String,
}

fn main() {}
