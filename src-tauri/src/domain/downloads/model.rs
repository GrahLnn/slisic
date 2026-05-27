use crate::domain::playlists::model::{Collection, Group};
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
    LocalImport => "local_import",
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, SurrealValue, Type)]
pub struct DownloadLeafGroupContext {
    pub name: String,
    pub url: String,
    pub folder: String,
}

impl From<Group> for DownloadLeafGroupContext {
    fn from(value: Group) -> Self {
        Self {
            name: value.name,
            url: value.url,
            folder: value.folder,
        }
    }
}

impl From<DownloadLeafGroupContext> for Group {
    fn from(value: DownloadLeafGroupContext) -> Self {
        Self {
            name: value.name,
            url: value.url,
            folder: value.folder,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum PastedDownloadUrlResolutionStatus {
    InvalidUrl,
    ExistingCollection,
    NewUrl,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PastedDownloadUrlResolution {
    pub status: PastedDownloadUrlResolutionStatus,
    pub url: Option<String>,
    pub error: Option<String>,
    pub collection: Option<Collection>,
}

impl PastedDownloadUrlResolution {
    pub fn invalid_url(error: impl Into<String>) -> Self {
        Self {
            status: PastedDownloadUrlResolutionStatus::InvalidUrl,
            url: None,
            error: Some(error.into()),
            collection: None,
        }
    }

    pub fn existing_collection(url: String, collection: Collection) -> Self {
        Self {
            status: PastedDownloadUrlResolutionStatus::ExistingCollection,
            url: Some(url),
            error: None,
            collection: Some(collection),
        }
    }

    pub fn new_url(url: String) -> Self {
        Self {
            status: PastedDownloadUrlResolutionStatus::NewUrl,
            url: Some(url),
            error: None,
            collection: None,
        }
    }
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
        self.failed_leaves = self
            .leafs
            .iter()
            .filter(|leaf| {
                leaf.status.is_terminal() && leaf.status != DownloadLeafStatus::Completed
            })
            .count() as u32;
        self.touch();
    }

    pub fn replace_leaf(&mut self, next: DownloadLeaf) {
        if next.status == DownloadLeafStatus::Completed {
            if self.remove_leaf(&next.id).is_some() {
                self.completed_leaves = self.completed_leaves.saturating_add(1);
                self.touch();
            }
            return;
        }

        if let Some(current) = self.leafs.iter_mut().find(|leaf| leaf.id == next.id) {
            *current = next;
        } else {
            self.leafs.push(next);
            self.leafs.sort_by_key(|leaf| leaf.sequence);
        }
        self.refresh_counts();
    }

    pub fn remove_leaf(&mut self, leaf_id: &Id) -> Option<DownloadLeaf> {
        let index = self.leafs.iter().position(|leaf| &leaf.id == leaf_id)?;
        let removed = self.leafs.remove(index);
        self.refresh_counts();
        Some(removed)
    }

    pub fn discard_completed_leafs(&mut self) {
        self.leafs
            .retain(|leaf| leaf.status != DownloadLeafStatus::Completed);
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
    pub group: Option<DownloadLeafGroupContext>,
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
            group: None,
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
