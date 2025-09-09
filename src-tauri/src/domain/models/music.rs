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
use std::collections::HashSet;
use std::hash::Hash;
use surrealdb::opt::PatchOp;
use surrealdb::RecordId;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::task;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Collection {
    pub name: String,
    pub avg_db: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct Playlist {
    pub name: String,
    pub avg_db: Option<f32>,
    pub entries: Vec<Entry>,
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
    pub entry_type: String,
    pub count: Option<u32>,
    pub status: Option<LinkStatus>,
    pub tracking: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq)]
pub struct CollectMission {
    pub name: String,
    pub folders: Vec<FolderSample>,
    pub links: Vec<LinkSample>,
    pub entries: Vec<Entry>,
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct DbMusic {
    pub id: RecordId,
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
            // musics: e.musics,
            url: e.url,
            downloaded_ok: e.downloaded_ok,
            tracking: e.tracking,
            avg_db: e.avg_db,
        }
    }
}

impl DbEntry {
    pub async fn musics(&self) -> Result<Vec<Music>> {
        let outs = DbEntry::outs(self.id.clone(), Rel::HasMusic, Table::Music).await?;
        let musics_fut = outs.into_iter().map(|t| DbMusic::select_record(t));
        let musics: Vec<Music> = future::try_join_all(musics_fut)
            .await?
            .iter()
            .map(|e| e.clone().into())
            .collect();
        Ok(musics)
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

impl From<Music> for DbMusic {
    fn from(e: Music) -> Self {
        Self {
            id: DbMusic::record_id(e.path.clone()),
            path: e.path,
            title: e.title,
            avg_db: e.avg_db,
            base_bias: e.base_bias,
            user_boost: e.user_boost,
            fatigue: e.fatigue,
            diversity: e.diversity,
        }
    }
}

impl From<DbMusic> for Music {
    fn from(e: DbMusic) -> Self {
        Self {
            path: e.path,
            title: e.title,
            avg_db: e.avg_db,
            base_bias: e.base_bias,
            user_boost: e.user_boost,
            fatigue: e.fatigue,
            diversity: e.diversity,
        }
    }
}

impl_crud!(Collection, Table::Collection);
impl_schema!(
    Collection,
    "DEFINE INDEX unique_name ON TABLE collection FIELDS name UNIQUE;"
);
impl_crud!(DbMusic, Table::Music);
impl_schema!(
    DbMusic,
    "DEFINE INDEX unique_name ON TABLE music FIELDS path UNIQUE;"
);
impl_id!(DbMusic, id);
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

#[derive(Debug, Clone, PartialEq)]
struct EntryPayload {
    entry: DbEntry,
    musics: Vec<Music>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Type, Event)]
pub struct ProcessMsg {
    pub str: String,
}

pub fn diff_by_key<'a, T, K, F>(new_: &'a [T], old: &'a [T], key: F) -> (Vec<&'a T>, Vec<&'a T>)
where
    K: Eq + Hash,
    F: Fn(&T) -> K,
{
    let oldk: HashSet<K> = old.iter().map(&key).collect();
    let newk: HashSet<K> = new_.iter().map(&key).collect();

    let to_add = new_.iter().filter(|x| !oldk.contains(&key(x))).collect();
    let to_remove = old.iter().filter(|x| !newk.contains(&key(x))).collect();
    (to_add, to_remove)
}

const CONC_LIMIT: usize = 8; // 或者 num_cpus::get().min(8)
#[tauri::command]
#[specta::specta]
pub async fn create(app: AppHandle, data: CollectMission) -> Result<(), String> {
    let CollectMission {
        name,
        folders,
        links,
        entries: _,
    } = data;

    if !folders.is_empty() {
        ProcessMsg {
            str: "Measuring LUFS".into(),
        }
        .emit(&app)
        .ok();
    }

    // ========== 并发处理 folders ==========
    // 每个 folder 内部的音乐条目也用受控并发测量 LUFS
    let folder_entries: Vec<EntryPayload> = stream::iter(folders)
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
                        musics: Vec::new(),
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

                    Ok::<EntryPayload, String>(EntryPayload {
                        entry: entry.into(),
                        musics,
                    })
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
            move |link| async move {
                let entry = Entry {
                    path: None,
                    musics: Vec::new(),
                    name: link.title_or_msg.clone(),
                    url: Some(link.url.clone()),
                    downloaded_ok: None,
                    tracking: Some(link.tracking.clone()),
                    avg_db: None,
                };

                let db: DbEntry = entry.into();
                let ytdlp: YtdlpEntry = link.into();
                Ok::<(DbEntry, YtdlpEntry), String>((db, ytdlp))
            }
        })
        .buffer_unordered(CONC_LIMIT)
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .unzip();

    // 合并两部分 entries
    let mut entries: Vec<DbEntry> = Vec::with_capacity(folder_entries.len() + link_entries.len());
    entries.extend(folder_entries.clone().into_iter().map(|e| e.entry));
    entries.extend(link_entries);

    let col = Collection { name, avg_db: None };
    // ========== 后续数据库操作（保持原子序） ==========
    DbEntry::insert_jump(entries.clone())
        .await
        .map_err(|e| e.to_string())?;

    let db_musics: Vec<DbMusic> = folder_entries
        .clone()
        .into_iter()
        .flat_map(|e| e.musics.into_iter().map(DbMusic::from))
        .collect();
    DbMusic::insert_jump(db_musics)
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

    let entry_rel_music: Vec<Relation> = folder_entries
        .into_iter()
        .flat_map(|e| {
            let entry_id = e.entry.id.clone();
            e.musics.into_iter().map(move |m| Relation {
                _in: entry_id.clone(),
                out: DbMusic::record_id(m.path.clone()),
            })
        })
        .collect();

    DbEntry::insert_relation(Rel::Collect, relation)
        .await
        .map_err(|e| e.to_string())?;

    DbEntry::insert_relation(Rel::HasMusic, entry_rel_music)
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
    let path = answer.path.to_string_lossy().into_owned();
    let musics: Vec<DbMusic> = musics.into_iter().map(DbMusic::from).collect();
    let entry_rel_music: Vec<Relation> = musics
        .clone()
        .into_iter()
        .map(|m| Relation {
            _in: DbEntry::record_id(answer.name.clone()),
            out: DbMusic::record_id(m.path.clone()),
        })
        .collect();
    DbMusic::insert_jump(musics)
        .await
        .map_err(|e| e.to_string())?;
    DbEntry::insert_relation(Rel::HasMusic, entry_rel_music)
        .await
        .map_err(|e| e.to_string())?;
    DbEntry::patch(
        DbEntry::record_id(answer.name.clone()),
        vec![
            PatchOp::replace("/downloaded_ok", true),
            PatchOp::replace("/avg_db", avg_db),
            PatchOp::replace("/path", path),
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
    let dbentries: Vec<DbEntry> = future::try_join_all(entries_fut)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    let entries: Vec<Entry> = stream::iter(dbentries)
        .map(|dbe| async move {
            // 先把需要的字段拷到本地，避免借用/移动冲突
            let path = dbe.path.clone();
            let name = dbe.name.clone();
            let avg_db = dbe.avg_db;
            let url = dbe.url.clone();
            let downloaded_ok = dbe.downloaded_ok;
            let tracking = dbe.tracking;

            let musics = dbe.musics().await.map_err(|e| e.to_string())?;

            Ok::<Entry, String>(Entry {
                path,
                name,
                musics,
                avg_db,
                url,
                downloaded_ok,
                tracking,
            })
        })
        .buffer_unordered(CONC_LIMIT)
        .try_collect()
        .await?;
    let (sum, count) = entries
        .iter()
        .filter_map(|e| e.avg_db)
        .fold((0.0f32, 0usize), |(s, c), v| (s + v, c + 1));
    let avg_db = if count == 0 {
        None
    } else {
        Some(sum / count as f32)
    };
    Ok(Playlist {
        name: col.name,
        avg_db,
        entries,
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
        let dbentries: Vec<DbEntry> = future::try_join_all(entries_fut)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        let entries: Vec<Entry> = stream::iter(dbentries)
            .map(|dbe| async move {
                // 先把需要的字段拷到本地，避免借用/移动冲突
                let path = dbe.path.clone();
                let name = dbe.name.clone();
                let avg_db = dbe.avg_db;
                let url = dbe.url.clone();
                let downloaded_ok = dbe.downloaded_ok;
                let tracking = dbe.tracking;

                let musics = dbe.musics().await.map_err(|e| e.to_string())?;

                Ok::<Entry, String>(Entry {
                    path,
                    name,
                    musics,
                    avg_db,
                    url,
                    downloaded_ok,
                    tracking,
                })
            })
            .buffer_unordered(CONC_LIMIT)
            .try_collect()
            .await?;
        let (sum, count) = entries
            .iter()
            .filter_map(|e| e.avg_db)
            .fold((0.0f32, 0usize), |(s, c), v| (s + v, c + 1));
        let avg_db = if count == 0 {
            None
        } else {
            Some(sum / count as f32)
        };
        lists.push(Playlist {
            name: col.name,
            avg_db,
            entries,
        });
    }
    Ok(lists)
}

#[tauri::command]
#[specta::specta]
pub async fn update(app: AppHandle, data: CollectMission, anchor: Playlist) -> Result<(), String> {
    let CollectMission {
        name,
        folders,
        links,
        entries,
    } = data;
    let id = Collection::select_record_id("name", &anchor.name)
        .await
        .map_err(|e| e.to_string())?;
    if name != anchor.name {
        Collection::patch(id.clone(), vec![PatchOp::replace("/name", name)])
            .await
            .map_err(|e| e.to_string())?;
    }
    let (_to_add_ref, to_remove_ref) =
        diff_by_key(&entries, &anchor.entries, |e: &Entry| e.path.clone());
    let rm_fut = to_remove_ref
        .into_iter()
        .map(|e| DbEntry::from(e.clone()))
        .map(|p| Collection::unrelate_by_id(id.clone(), p.id, Rel::Collect));
    future::try_join_all(rm_fut)
        .await
        .map_err(|e| e.to_string())?;

    if !folders.is_empty() {
        ProcessMsg {
            str: "Measuring LUFS".into(),
        }
        .emit(&app)
        .ok();
    }

    // ========== 并发处理 folders ==========
    // 每个 folder 内部的音乐条目也用受控并发测量 LUFS
    let folder_entries: Vec<EntryPayload> = stream::iter(folders)
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
                        musics: Vec::new(),
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

                    Ok::<EntryPayload, String>(EntryPayload {
                        entry: entry.into(),
                        musics,
                    })
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
            move |link| async move {
                let entry = Entry {
                    path: None,
                    musics: Vec::new(),
                    name: link.title_or_msg.clone(),
                    url: Some(link.url.clone()),
                    downloaded_ok: None,
                    tracking: Some(link.tracking.clone()),
                    avg_db: None,
                };

                let db: DbEntry = entry.into();
                let ytdlp: YtdlpEntry = link.into();
                Ok::<(DbEntry, YtdlpEntry), String>((db, ytdlp))
            }
        })
        .buffer_unordered(CONC_LIMIT)
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .unzip();

    // 合并两部分 entries
    let mut entries: Vec<DbEntry> = Vec::with_capacity(folder_entries.len() + link_entries.len());
    entries.extend(folder_entries.clone().into_iter().map(|e| e.entry));
    entries.extend(link_entries);

    DbEntry::insert_jump(entries.clone())
        .await
        .map_err(|e| e.to_string())?;

    let db_musics: Vec<DbMusic> = folder_entries
        .clone()
        .into_iter()
        .flat_map(|e| e.musics.into_iter().map(DbMusic::from))
        .collect();
    DbMusic::insert_jump(db_musics)
        .await
        .map_err(|e| e.to_string())?;
    let relation: Vec<Relation> = entries
        .iter()
        .map(|e| Relation {
            _in: id.clone(),
            out: e.id.clone(),
        })
        .collect();

    let entry_rel_music: Vec<Relation> = folder_entries
        .into_iter()
        .flat_map(|e| {
            let entry_id = e.entry.id.clone();
            e.musics.into_iter().map(move |m| Relation {
                _in: entry_id.clone(),
                out: DbMusic::record_id(m.path.clone()),
            })
        })
        .collect();

    DbEntry::insert_relation(Rel::Collect, relation)
        .await
        .map_err(|e| e.to_string())?;

    DbEntry::insert_relation(Rel::HasMusic, entry_rel_music)
        .await
        .map_err(|e| e.to_string())?;

    for y in downloads_entry {
        enqueue(y).await?;
    }
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

#[tauri::command]
#[specta::specta]
pub async fn fatigue(music: Music) -> Result<(), String> {
    let mut music: DbMusic = music.into();
    music.user_boost = (music.user_boost + 0.1).min(0.9);
    music.update().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn boost(music: Music) -> Result<(), String> {
    let mut music: DbMusic = music.into();
    music.user_boost += 0.1;
    music.update().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn unstar(list: Playlist, music: Music) -> Result<(), String> {
    let target = music.path.clone();
    let music: DbMusic = music.into();

    let entries: Vec<DbEntry> = list
        .entries
        .into_iter()
        .filter(|e| e.musics.iter().any(|m| m.path == target))
        .map(Into::into)
        .collect();

    let futs = entries
        .iter()
        .map(|e| e.unrelate(music.clone(), Rel::HasMusic));

    futures::future::try_join_all(futs)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
