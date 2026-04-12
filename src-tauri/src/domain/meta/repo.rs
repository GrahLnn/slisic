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

fn meta_info_record_id() -> RecordId {
    RecordId::new(MetaInfo::table_name(), META_INFO_RECORD_KEY)
}
