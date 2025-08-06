use anyhow::Result;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Type)]
pub enum MetaKey {
    SaveDir,
    FirstLaunch,
}

impl MetaKey {
    pub fn as_str(self) -> &'static str {
        match self {
            MetaKey::SaveDir => "save_dir",
            MetaKey::FirstLaunch => "first_launch",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "save_dir" => Ok(MetaKey::SaveDir),
            "first_launch" => Ok(MetaKey::FirstLaunch),
            _ => Err(format!("Unknown MetaKey: {}", s)),
        }
    }
}

impl std::str::FromStr for MetaKey {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        MetaKey::from_str(s)
    }
}
