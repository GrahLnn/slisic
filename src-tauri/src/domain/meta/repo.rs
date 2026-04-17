use super::model::MetaInfo;
use anyhow::Result;
use appdb::error::{DBError, classify_db_error};
use appdb::model::meta::ModelMeta;
use appdb::repository::Repo;
use surrealdb::types::RecordId;

const META_INFO_RECORD_KEY: &str = "singleton";

pub async fn get_meta_info() -> Result<Option<MetaInfo>> {
    match Repo::<MetaInfo>::get_record(meta_info_record_id()).await {
        Ok(meta) => Ok(Some(meta)),
        Err(error) => match classify_db_error(&error) {
            DBError::NotFound | DBError::MissingTable(_) => Ok(None),
            other => Err(other.into()),
        },
    }
}

pub async fn save_meta_info(meta: MetaInfo) -> Result<MetaInfo> {
    Repo::<MetaInfo>::upsert_at(meta_info_record_id(), meta).await
}

pub fn resolve_meta_info(meta: Option<MetaInfo>, default_save_path: String) -> MetaInfo {
    let mut meta = meta.unwrap_or(MetaInfo { save_path: None });

    if meta.save_path.is_none() {
        meta.save_path = Some(default_save_path);
    }

    meta
}

pub async fn ensure_meta_info(default_save_path: String) -> Result<MetaInfo> {
    let current = get_meta_info().await?;
    let resolved = resolve_meta_info(current.clone(), default_save_path);
    let current_save_path = current.as_ref().and_then(|meta| meta.save_path.as_ref());
    let resolved_save_path = resolved.save_path.as_ref();

    if current.is_some() && current_save_path == resolved_save_path {
        return Ok(resolved);
    }

    save_meta_info(resolved).await
}

fn meta_info_record_id() -> RecordId {
    RecordId::new(MetaInfo::table_name(), META_INFO_RECORD_KEY)
}
