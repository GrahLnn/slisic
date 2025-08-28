use std::path::PathBuf;

use crate::database::enums::table::{Rel, Table};
use crate::database::{Crud, HasId, Relation};
use crate::utils::config::resolve_save_path;
use crate::utils::enq::enqueue;
use crate::utils::ffmpeg::integrated_lufs;
use crate::utils::file::all_audio_recursive;
use crate::utils::ytdlp::Entry as YtdlpEntry;
use crate::{impl_crud, impl_id, impl_schema};
use anyhow::Result;
use futures::{future, stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use surrealdb::opt::PatchOp;
use surrealdb::RecordId;
use tauri::AppHandle;
use tokio::task;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Collection {
    pub name: String,
    pub avg_db: Option<f32>,
    // pub folders: Vec<Folder>, 用图来连接
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Playlist {
    pub name: String,
    pub avg_db: Option<f32>,
    pub folders: Vec<Entry>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct FolderSample {
    pub path: String,
    pub items: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub enum LinkStatus {
    Ok,
    Err,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct LinkSample {
    pub url: String,
    pub title_or_msg: String,
    pub status: Option<LinkStatus>,
    pub tracking: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct CollectMission {
    pub name: String,
    pub folders: Vec<FolderSample>,
    pub links: Vec<LinkSample>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Music {
    pub path: String,
    pub title: String,
    pub avg_db: Option<f32>,
    pub base_bias: f32,
    pub user_boost: f32,
    pub fatigue: f32,
    pub diversity: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Entry {
    pub path: Option<String>,
    pub name: String,
    pub musics: Vec<Music>,
    pub avg_db: Option<f32>,
    pub url: Option<String>,
    pub downloaded_ok: Option<bool>,
    pub tracking: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct DbEntry {
    pub id: RecordId,
    pub path: Option<String>,
    pub name: String,
    pub musics: Vec<Music>,
    pub avg_db: Option<f32>,
    pub url: Option<String>,
    pub downloaded_ok: Option<bool>,
    pub tracking: Option<bool>,
}

impl From<Entry> for DbEntry {
    fn from(e: Entry) -> Self {
        Self {
            id: DbEntry::record_id(e.name.clone()),
            path: e.path,
            name: e.name,
            musics: e.musics,
            url: e.url,
            downloaded_ok: e.downloaded_ok,
            tracking: e.tracking,
            avg_db: e.avg_db,
        }
    }
}

impl From<DbEntry> for Entry {
    fn from(e: DbEntry) -> Self {
        Self {
            path: e.path,
            name: e.name,
            musics: e.musics,
            url: e.url,
            downloaded_ok: e.downloaded_ok,
            tracking: e.tracking,
            avg_db: e.avg_db,
        }
    }
}

impl From<LinkSample> for YtdlpEntry {
    fn from(e: LinkSample) -> Self {
        Self {
            id: Uuid::new_v4(),
            url: e.url,
            title: String::new(),
            retries: 0,
            error: None,
            kind: None,
        }
    }
}

impl_crud!(Collection, Table::Collection);
impl_schema!(
    Collection,
    "DEFINE INDEX unique_name ON TABLE collection FIELDS name UNIQUE;"
);
impl_crud!(DbEntry, Table::Entry);
impl_schema!(
    DbEntry,
    "DEFINE INDEX unique_path ON TABLE entry FIELDS name UNIQUE;"
);
impl_id!(DbEntry, id);

impl Collection {
    pub async fn id(&self) -> Result<RecordId> {
        Self::select_record_id("name", &self.name).await
    }
}

impl Entry {
    pub async fn id(&self) -> Result<RecordId> {
        DbEntry::select_record_id("name", &self.name).await
    }
}

pub async fn relate_entry(entry: Entry, collection: Collection) -> Result<()> {
    let entry_id = entry.id().await?;
    let col_id = collection.id().await?;
    DbEntry::relate_by_id(col_id, entry_id, Rel::Collect).await
}
const CONC_LIMIT: usize = 8; // 或者 num_cpus::get().min(8)
#[tauri::command]
#[specta::specta]
pub async fn create(app: AppHandle, data: CollectMission) -> Result<(), String> {
    let base_folder = resolve_save_path(app.clone())?;
    let base_folder = Arc::new(base_folder);

    let CollectMission {
        name,
        folders,
        links,
    } = data;
    let col = Collection { name, avg_db: None };

    // ========== 并发处理 folders ==========
    // 每个 folder 内部的音乐条目也用受控并发测量 LUFS
    let folder_entries: Vec<DbEntry> = stream::iter(folders)
        .map(|folder| {
            let FolderSample { path, items } = folder;
            {
                let app_clone = app.clone(); // Clone the app here instead of moving it
                async move {
                    // 逐文件并发计算
                    let musics: Vec<Music> = stream::iter(items.into_iter().map(|p| {
                        // 注意：把可能阻塞/CPU 密集的 lufs 计算放到 spawn_blocking
                        let p_clone = p.clone();
                        {
                            let app_clone = app_clone.clone();
                            async move {
                                let lufs = task::spawn_blocking(move || {
                                    integrated_lufs(&app_clone, &p_clone)
                                })
                                .await
                                .map_err(|e| format!("spawn_blocking panic: {e}"))?
                                .ok()
                                .map(|v| v as f32);

                                Ok::<_, String>(Music {
                                    path: p.clone(),
                                    title: PathBuf::from(p)
                                        .file_stem()
                                        .unwrap()
                                        .to_str()
                                        .unwrap()
                                        .to_string(),
                                    avg_db: lufs,
                                    base_bias: 0.0,
                                    user_boost: 0.0,
                                    fatigue: 0.0,
                                    diversity: 0.0,
                                })
                            }
                        }
                    }))
                    .buffer_unordered(CONC_LIMIT)
                    .try_collect::<Vec<_>>()
                    .await?;

                    let entry = Entry {
                        path: Some(path.clone()),
                        name: PathBuf::from(path)
                            .file_name()
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_string(),
                        musics: musics.clone(),
                        url: None,
                        downloaded_ok: Some(true),
                        tracking: None,
                        avg_db: {
                            let sum: f32 = musics.clone().iter().filter_map(|m| m.avg_db).sum();
                            let count = musics.iter().filter(|m| m.avg_db.is_some()).count();
                            if count > 0 {
                                Some(sum / count as f32)
                            } else {
                                None
                            }
                        },
                    };

                    Ok::<DbEntry, String>(entry.into())
                }
            }
        })
        .buffer_unordered(CONC_LIMIT)
        .try_collect()
        .await?;

    // ========== 并发处理 links ==========
    // 既要生成 DbEntry 也要生成下载队列 YtdlpEntry
    let (link_entries, downloads_entry): (Vec<DbEntry>, Vec<YtdlpEntry>) = stream::iter(links)
        .map({
            let base_folder = Arc::clone(&base_folder);
            move |link| {
                // let base_folder = Arc::clone(&base_folder);
                async move {
                    // 组装路径等纯计算，不阻塞 IO，无需 spawn_blocking
                    // let out_path = base_folder
                    //     .join(&link.title_or_msg)
                    //     .to_string_lossy()
                    //     .into_owned();

                    let entry = Entry {
                        path: None,
                        name: link.title_or_msg.clone(),
                        musics: Vec::new(),
                        url: Some(link.url.clone()),
                        downloaded_ok: None,
                        tracking: Some(link.tracking.clone()),
                        avg_db: None,
                    };

                    let db: DbEntry = entry.into();
                    let ytdlp: YtdlpEntry = link.into();
                    Ok::<(DbEntry, YtdlpEntry), String>((db, ytdlp))
                }
            }
        })
        .buffer_unordered(CONC_LIMIT)
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .unzip();

    // 合并两部分 entries
    let mut entries: Vec<DbEntry> = Vec::with_capacity(folder_entries.len() + link_entries.len());
    entries.extend(folder_entries);
    entries.extend(link_entries);

    // ========== 后续数据库操作（保持原子序） ==========
    DbEntry::insert_jump(entries.clone())
        .await
        .map_err(|e| e.to_string())?;

    let col_id = col.create_return_id().await.map_err(|e| e.to_string())?;

    let relation: Vec<Relation> = entries
        .iter()
        .map(|e| Relation {
            _in: col_id.clone(),
            out: e.id.clone(),
        })
        .collect();

    DbEntry::insert_relation(Rel::Collect, relation)
        .await
        .map_err(|e| e.to_string())?;

    for y in downloads_entry {
        enqueue(y).await?;
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct DownloadAnswer {
    pub path: PathBuf,
    pub name: String,
}

pub async fn download_ok(app: &AppHandle, answer: DownloadAnswer) -> Result<(), String> {
    let items = if answer.path.is_dir() {
        all_audio_recursive(answer.path.clone().to_string_lossy().into_owned())?
    } else {
        vec![answer.path.clone()]
    };
    let musics: Vec<Music> = stream::iter(items.into_iter().map(|p| {
        let p_clone = p.clone();
        let app_clone = app.clone();
        async move {
            let lufs = task::spawn_blocking(move || integrated_lufs(&app_clone, &p_clone))
                .await
                .map_err(|e| format!("spawn_blocking panic: {e}"))?
                .ok()
                .map(|v| v as f32);

            Ok::<_, String>(Music {
                path: p.to_string_lossy().into_owned(),
                title: p.file_stem().unwrap().to_str().unwrap().to_string(),
                avg_db: lufs,
                base_bias: 0.0,
                user_boost: 0.0,
                fatigue: 0.0,
                diversity: 0.0,
            })
        }
    }))
    .buffer_unordered(CONC_LIMIT)
    .try_collect::<Vec<_>>()
    .await?;
    let avg_db = {
        let sum: f32 = musics.iter().filter_map(|m| m.avg_db).sum();
        let count = musics.iter().filter(|m| m.avg_db.is_some()).count();
        if count > 0 {
            Some(sum / count as f32)
        } else {
            None
        }
    };
    DbEntry::patch(
        DbEntry::record_id(answer.name),
        vec![
            PatchOp::replace("/musics", musics),
            PatchOp::replace("/downloaded_ok", true),
            PatchOp::replace("/avg_db", avg_db),
            PatchOp::replace("/path", answer.path.to_string_lossy().into_owned()),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn read(name: String) -> Result<Playlist, String> {
    let id = Collection::select_record_id("name", &name)
        .await
        .map_err(|e| e.to_string())?;
    let col = Collection::select_record(id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let outs = Collection::outs(id, Rel::Collect, Table::Entry)
        .await
        .map_err(|e| e.to_string())?;
    let entries_fut = outs.into_iter().map(|t| DbEntry::select_record(t));
    let entries: Vec<Entry> = future::try_join_all(entries_fut)
        .await
        .map_err(|e| e.to_string())?
        .iter()
        .map(|e| e.clone().into())
        .collect();
    Ok(Playlist {
        name: col.name,
        avg_db: col.avg_db,
        folders: entries,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn read_all() -> Result<Vec<Playlist>, String> {
    let cols = Collection::select_all().await.map_err(|e| e.to_string())?;
    let mut lists: Vec<Playlist> = Vec::new();
    for col in cols {
        let id = col.id().await.map_err(|e| e.to_string())?;
        let outs = Collection::outs(id, Rel::Collect, Table::Entry)
            .await
            .map_err(|e| e.to_string())?;
        let entries_fut = outs.into_iter().map(|t| DbEntry::select_record(t));
        let entries: Vec<Entry> = future::try_join_all(entries_fut)
            .await
            .map_err(|e| e.to_string())?
            .iter()
            .map(|e| e.clone().into())
            .collect();
        lists.push(Playlist {
            name: col.name,
            avg_db: col.avg_db,
            folders: entries,
        });
    }
    Ok(lists)
}

#[tauri::command]
#[specta::specta]
pub async fn update(data: CollectMission) -> Result<(), String> {
    // let id = data.id().await.map_err(|e| e.to_string())?;
    // Collection::update_by_id(id, data)
    //     .await
    //     .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete(name: String) -> Result<(), String> {
    let id = Collection::select_record_id("name", &name)
        .await
        .map_err(|e| e.to_string())?;
    Collection::delete_record(id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
