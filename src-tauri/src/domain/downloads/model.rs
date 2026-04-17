use crate::domain::playlists::model::Collection;
use appdb::{Id, Store};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use specta::Type;
use surrealdb_types::{Kind, SurrealValue, ToSql, Value, kind};

macro_rules! impl_string_surreal_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Type)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl SurrealValue for $name {
            fn kind_of() -> Kind {
                kind!(string)
            }

            fn is_value(value: &Value) -> bool {
                matches!(value, Value::String(_))
            }

            fn into_value(self) -> Value {
                Value::String(self.as_str().to_string())
            }

            fn from_value(value: Value) -> Result<Self, surrealdb_types::Error> {
                let Value::String(text) = value else {
                    return Err(surrealdb_types::Error::internal(format!(
                        "expected string for {}, got {}",
                        stringify!($name),
                        value.kind().to_sql()
                    )));
                };

                Self::parse(&text).ok_or_else(|| {
                    surrealdb_types::Error::internal(format!(
                        "invalid {} value `{text}`",
                        stringify!($name)
                    ))
                })
            }
        }
    };
}

impl_string_surreal_enum!(CollectionSourceKind {
    Single => "single",
    List => "list",
});

impl_string_surreal_enum!(DownloadTrigger {
    Manual => "manual",
    AutoUpdate => "auto_update",
});

impl_string_surreal_enum!(DownloadTaskStatus {
    Queued => "queued",
    Resolving => "resolving",
    Downloading => "downloading",
    Persisting => "persisting",
    Completed => "completed",
    CompletedWithErrors => "completed_with_errors",
    Failed => "failed",
    Cancelled => "cancelled",
    Interrupted => "interrupted",
});

impl_string_surreal_enum!(DownloadLeafStatus {
    Queued => "queued",
    Probing => "probing",
    Downloading => "downloading",
    Persisting => "persisting",
    Completed => "completed",
    Failed => "failed",
    Cancelled => "cancelled",
    Interrupted => "interrupted",
});

impl DownloadTaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed
                | Self::CompletedWithErrors
                | Self::Failed
                | Self::Cancelled
                | Self::Interrupted
        )
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Resolving | Self::Downloading | Self::Persisting
        )
    }
}

impl DownloadLeafStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Probing | Self::Downloading | Self::Persisting
        )
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct DownloadTask {
    pub id: Id,
    pub url: String,
    pub collection_url: Option<String>,
    pub collection_name: Option<String>,
    pub collection_folder: Option<String>,
    pub source_kind: Option<CollectionSourceKind>,
    pub trigger: DownloadTrigger,
    pub status: DownloadTaskStatus,
    #[relate("has_leaf")]
    pub leafs: Vec<DownloadLeaf>,
    pub total_leaves: u32,
    pub completed_leaves: u32,
    pub failed_leaves: u32,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq)]
pub struct DownloadResourceProbe {
    pub url: String,
    pub source_kind: CollectionSourceKind,
    pub title: String,
    pub item_count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct EnqueuedCollectionDownload {
    pub task: DownloadTask,
    pub collection: Collection,
}

impl DownloadTask {
    pub fn new(id: impl Into<Id>, url: impl Into<String>, trigger: DownloadTrigger) -> Self {
        let now = now_timestamp();
        Self {
            id: id.into(),
            url: url.into(),
            collection_url: None,
            collection_name: None,
            collection_folder: None,
            source_kind: None,
            trigger,
            status: DownloadTaskStatus::Queued,
            leafs: vec![],
            total_leaves: 0,
            completed_leaves: 0,
            failed_leaves: 0,
            last_error: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = now_timestamp();
    }

    pub fn refresh_counts(&mut self) {
        self.total_leaves = self.leafs.len() as u32;
        self.completed_leaves = self
            .leafs
            .iter()
            .filter(|leaf| leaf.status == DownloadLeafStatus::Completed)
            .count() as u32;
        self.failed_leaves = self
            .leafs
            .iter()
            .filter(|leaf| {
                matches!(
                    leaf.status,
                    DownloadLeafStatus::Failed
                        | DownloadLeafStatus::Cancelled
                        | DownloadLeafStatus::Interrupted
                )
            })
            .count() as u32;
        self.touch();
    }

    pub fn replace_leaf(&mut self, next: DownloadLeaf) {
        if let Some(current) = self.leafs.iter_mut().find(|leaf| leaf.id == next.id) {
            *current = next;
        } else {
            self.leafs.push(next);
            self.leafs.sort_by_key(|leaf| leaf.sequence);
        }
        self.refresh_counts();
    }

    pub fn mark_interrupted(&mut self) {
        if self.status.is_active() {
            self.status = DownloadTaskStatus::Interrupted;
        }

        for leaf in &mut self.leafs {
            if leaf.status.is_active() {
                leaf.status = DownloadLeafStatus::Interrupted;
                leaf.updated_at = now_timestamp();
            }
        }

        self.refresh_counts();
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, SurrealValue, Store, Type)]
pub struct DownloadLeaf {
    pub id: Id,
    pub url: String,
    pub title: Option<String>,
    pub file_name: Option<String>,
    pub relative_path: Option<String>,
    pub duration_seconds: Option<u32>,
    pub chapter_count: Option<u32>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_second: Option<u64>,
    pub eta_seconds: Option<u64>,
    pub status: DownloadLeafStatus,
    pub last_error: Option<String>,
    pub sequence: u32,
    pub created_at: String,
    pub updated_at: String,
}

impl DownloadLeaf {
    pub fn new(id: impl Into<Id>, url: impl Into<String>, sequence: u32) -> Self {
        let now = now_timestamp();
        Self {
            id: id.into(),
            url: url.into(),
            title: None,
            file_name: None,
            relative_path: None,
            duration_seconds: None,
            chapter_count: None,
            downloaded_bytes: None,
            total_bytes: None,
            speed_bytes_per_second: None,
            eta_seconds: None,
            status: DownloadLeafStatus::Queued,
            last_error: None,
            sequence,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = now_timestamp();
    }
}

pub fn now_timestamp() -> String {
    Utc::now().to_rfc3339()
}
