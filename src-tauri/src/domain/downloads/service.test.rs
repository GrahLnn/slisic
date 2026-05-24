use super::model::CollectionSourceKind;
use super::naming::{provider_segment, sanitize_path_component};
use super::repo::{list_tasks, save_task};
use super::service::{
    CompletedLeafDownload, derive_youtube_channel_url_from_uploads_playlist,
    expand_root_entries_to_planned_leafs, extract_olak_playlist_ids, handle_finished_leaf_download,
    leaf_download_parallelism, prepare_task_enqueue, resolve_existing_temp_downloaded_file,
    resolve_pasted_download_url, resolve_task_collection_folder, resume_download_task,
    should_interrupt_unresumable_active_task_after_restart,
    should_recover_download_task_after_restart, should_reprobe_single_leaf,
    should_resume_download_task_after_restart, try_claim_enqueue_url,
};
use super::yt_dlp::{
    DownloadProgress, DownloadedLeaf, LeafChapter, LeafProbe, LeafReference, PlaylistRoot,
    RootProbe, YtDlpClient,
};
/// Appdb-style domain tests stay inside a local Tokio runtime and a temporary
/// appdb instance. Keep this file free of Tauri host setup and `AppHandle`
/// dependencies so `cargo test` only exercises pure download-domain contracts.
/// Manual end-to-end download checks belong in `examples/manual_download_chain.rs`.
use crate::domain::collection_import::{
    CollectionShellPlan, CollectionSyncPlan, PlannedLeaf, apply_collection_plan_to_task,
    create_collection_shell, describe_download_resource, existing_leaf_identities,
    filter_new_planned_leaves, materialize_music_entries, normalize_music_titles_within_collection,
    persist_downloaded_leaf_music, persist_enqueued_collection_shell, resolve_existing_leaf_file,
};
use crate::domain::downloads::model::{
    DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTaskStatus, DownloadTrigger,
    PastedDownloadUrlResolutionStatus,
};
use crate::domain::playlists::PLAYLIST_DB_TEST_LOCK;
use crate::domain::playlists::model::{Collection, Group, Music, canonical_music_id_for_source};
use crate::domain::playlists::repo::upsert_collection;
use anyhow::{Result, anyhow};
use appdb::Id;
use appdb::connection::{InitDbOptions, reinit_db_with_options, reset_db};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, LazyLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;

#[test]
fn sanitize_path_component_replaces_windows_invalid_characters() {
    let sanitized = sanitize_path_component("My:Playlist?*Title. ");

    assert_eq!(sanitized, "My-Playlist--Title");
}

#[test]
fn provider_segment_normalizes_youtube_hosts() {
    assert_eq!(
        provider_segment("https://www.youtube.com/watch?v=abc123"),
        "youtube"
    );
    assert_eq!(provider_segment("https://youtu.be/abc123"), "youtube");
}

#[test]
fn only_direct_leaf_roots_can_reuse_initial_leaf_probe() {
    assert!(!should_reprobe_single_leaf(CollectionSourceKind::Single));
    assert!(should_reprobe_single_leaf(CollectionSourceKind::List));
}

#[test]
fn leaf_download_parallelism_keeps_single_downloads_serial_and_batches_lists() {
    assert_eq!(
        leaf_download_parallelism(CollectionSourceKind::Single, 0),
        0
    );
    assert_eq!(
        leaf_download_parallelism(CollectionSourceKind::Single, 3),
        1
    );
    assert_eq!(leaf_download_parallelism(CollectionSourceKind::List, 3), 3);
    assert_eq!(leaf_download_parallelism(CollectionSourceKind::List, 8), 4);
}

#[test]
fn restart_recovery_resumes_only_unfinished_download_tasks() {
    assert!(should_resume_download_task_after_restart(
        DownloadTaskStatus::Queued
    ));
    assert!(should_resume_download_task_after_restart(
        DownloadTaskStatus::Downloading
    ));
    assert!(should_resume_download_task_after_restart(
        DownloadTaskStatus::Interrupted
    ));
    assert!(!should_resume_download_task_after_restart(
        DownloadTaskStatus::Completed
    ));
    assert!(!should_resume_download_task_after_restart(
        DownloadTaskStatus::CompletedWithErrors
    ));
    assert!(!should_resume_download_task_after_restart(
        DownloadTaskStatus::Failed
    ));
    assert!(!should_resume_download_task_after_restart(
        DownloadTaskStatus::Cancelled
    ));
}

#[test]
fn restart_recovery_interrupts_local_import_wait_markers_without_resuming_them() {
    let mut local_import = DownloadTask::new(
        "local-import-task",
        "local://collection/pending",
        DownloadTrigger::LocalImport,
    );
    local_import.status = DownloadTaskStatus::Queued;
    let mut manual_download = DownloadTask::new(
        "manual-download-task",
        "https://example.com/album",
        DownloadTrigger::Manual,
    );
    manual_download.status = DownloadTaskStatus::Queued;

    assert!(should_interrupt_unresumable_active_task_after_restart(
        &local_import
    ));
    assert!(!should_recover_download_task_after_restart(&local_import));
    assert!(!should_interrupt_unresumable_active_task_after_restart(
        &manual_download
    ));
    assert!(should_recover_download_task_after_restart(&manual_download));
}

#[test]
fn list_download_marks_finalize_failures_on_leaf_without_aborting_task() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        let save_root = temp_test_dir();
        let collection_folder = "youtube/Finalize Failure".to_string();
        let target_dir = save_root.join(&collection_folder);
        std::fs::create_dir_all(&target_dir).expect("target dir should be created");

        let blocked_final_path = target_dir.join("Track A.m4a");
        std::fs::create_dir_all(&blocked_final_path)
            .expect("directory should block final file rename");
        let downloaded_path = target_dir.join("Track A.__slisic_tmp__leaf-a.m4a");
        std::fs::write(&downloaded_path, b"audio").expect("temp file should exist");

        let collection_owner = collection_group(
            "Finalize Failure",
            "https://example.com/playlist",
            &collection_folder,
        );
        let mut collection = Collection {
            name: "Finalize Failure".to_string(),
            url: "https://example.com/playlist".to_string(),
            folder: collection_folder,
            musics: vec![],
            last_updated: "2026-05-24T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        };
        upsert_collection(&collection)
            .await
            .expect("collection should save");

        let mut task = DownloadTask::new(
            "task-finalize-failure",
            "https://example.com/playlist",
            DownloadTrigger::Manual,
        );
        task.collection_url = Some(collection.url.clone());
        task.collection_name = Some(collection.name.clone());
        task.collection_folder = Some(collection.folder.clone());
        task.source_kind = Some(CollectionSourceKind::List);
        task.status = DownloadTaskStatus::Downloading;
        let mut failed_leaf = DownloadLeaf::new("leaf-a", "https://example.com/watch?v=a", 0);
        failed_leaf.status = DownloadLeafStatus::Downloading;
        let mut completed_leaf = DownloadLeaf::new("leaf-b", "https://example.com/watch?v=b", 1);
        completed_leaf.status = DownloadLeafStatus::Downloading;
        task.replace_leaf(failed_leaf.clone());
        task.replace_leaf(completed_leaf.clone());
        let mut task = save_task(task).await.expect("task should save");

        let probe_a = leaf_probe("Track A", "https://example.com/watch?v=a", 60);
        handle_finished_leaf_download(
            &mut task,
            &mut collection,
            CollectionSourceKind::List,
            &save_root,
            Ok(CompletedLeafDownload {
                leaf: failed_leaf,
                probe: probe_a.clone(),
                music_probe: probe_a,
                group: Some(collection_owner.clone()),
                downloaded: DownloadedLeaf {
                    absolute_path: downloaded_path,
                },
                progress: DownloadProgress::default(),
            }),
        )
        .await
        .expect("leaf finalize failure should not abort list task");

        assert_eq!(
            task.leafs
                .iter()
                .find(|leaf| leaf.id.to_string() == "leaf-a")
                .map(|leaf| leaf.status),
            Some(DownloadLeafStatus::Failed)
        );
        assert_eq!(task.failed_leaves, 1);

        let downloaded_path = target_dir.join("Track B.__slisic_tmp__leaf-b.m4a");
        std::fs::write(&downloaded_path, b"audio").expect("second temp file should exist");
        let probe_b = leaf_probe("Track B", "https://example.com/watch?v=b", 60);
        handle_finished_leaf_download(
            &mut task,
            &mut collection,
            CollectionSourceKind::List,
            &save_root,
            Ok(CompletedLeafDownload {
                leaf: completed_leaf,
                probe: probe_b.clone(),
                music_probe: probe_b,
                group: Some(collection_owner),
                downloaded: DownloadedLeaf {
                    absolute_path: downloaded_path,
                },
                progress: DownloadProgress::default(),
            }),
        )
        .await
        .expect("later leaf should still complete after earlier finalize failure");

        assert_eq!(task.completed_leaves, 1);
        assert_eq!(task.failed_leaves, 1);
        assert_eq!(
            task.leafs
                .iter()
                .find(|leaf| leaf.id.to_string() == "leaf-b")
                .and_then(|leaf| leaf.relative_path.as_deref()),
            Some("Track B.m4a")
        );

        reset_db();
        let _ = std::fs::remove_dir_all(save_root);
    });
}

#[test]
fn materialize_music_entries_expands_chapters_without_splitting_files() {
    let probe = LeafProbe {
        title: "Album".to_string(),
        webpage_url: "https://example.com/video".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_seconds: Some(180),
        chapters: vec![
            LeafChapter {
                title: "Intro".to_string(),
                start_ms: 0,
                end_ms: 60_000,
            },
            LeafChapter {
                title: "Main".to_string(),
                start_ms: 60_000,
                end_ms: 180_000,
            },
        ],
    };

    let group = collection_group(
        "Album Collection",
        "https://example.com/playlist",
        "youtube/album-collection",
    );
    let musics = materialize_music_entries(&probe, "album.m4a", group.clone());

    assert_eq!(musics.len(), 2);
    assert_eq!(musics[0].name, "Intro");
    assert_eq!(musics[0].alias, "Intro");
    assert_eq!(musics[1].name, "Main");
    assert_eq!(musics[1].alias, "Main");
    assert_eq!(musics[0].group.name, group.name);
    assert_eq!(musics[0].group.url, group.url);
    assert_eq!(musics[0].group.folder, group.folder);
    assert_eq!(musics[1].group.name, group.name);
    assert_eq!(musics[1].group.url, group.url);
    assert_eq!(musics[1].group.folder, group.folder);
    assert_eq!(musics[0].path.as_deref(), Some("album.m4a"));
    assert_eq!(musics[1].path.as_deref(), Some("album.m4a"));
    assert_eq!(musics[0].start_ms, 0);
    assert_eq!(musics[1].end_ms, 180_000);
}

#[test]
fn materialize_music_entries_falls_back_to_single_full_track_when_no_chapters_exist() {
    let probe = LeafProbe {
        title: "Single Track".to_string(),
        webpage_url: "https://example.com/video".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_seconds: Some(245),
        chapters: vec![],
    };

    let group = collection_group("Singles", "https://example.com/singles", "youtube/singles");
    let musics = materialize_music_entries(&probe, "single-track.m4a", group.clone());

    assert_eq!(musics.len(), 1);
    assert_eq!(musics[0].name, "Single Track");
    assert_eq!(musics[0].alias, "Single Track");
    assert_eq!(musics[0].group.name, group.name);
    assert_eq!(musics[0].group.url, group.url);
    assert_eq!(musics[0].group.folder, group.folder);
    assert_eq!(musics[0].url, "https://example.com/video");
    assert_eq!(musics[0].path.as_deref(), Some("single-track.m4a"));
    assert_eq!(musics[0].start_ms, 0);
    assert_eq!(musics[0].end_ms, 245_000);
}

#[test]
fn persist_downloaded_leaf_music_replaces_only_the_matching_group_copy() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let first_group = collection_group("Disc 1", "https://example.com/disc-1", "Disc 1");
        let second_group = collection_group("Disc 2", "https://example.com/disc-2", "Disc 2");
        let mut collection = Collection {
            name: "Demo".to_string(),
            url: "https://example.com/root".to_string(),
            folder: "youtube/demo".to_string(),
            musics: vec![
                Music {
                    name: "Original First".to_string(),
                    alias: "Pinned First".to_string(),
                    group: first_group.clone(),
                    url: "https://example.com/watch?v=same".to_string(),
                    canonical_music_id: canonical_music_id_for_source(
                        &"https://example.com/watch?v=same".to_string(),
                        0,
                        180_000,
                    ),
                    path: Some("Disc 1/original.m4a".to_string()),
                    start_ms: 0,
                    end_ms: 10_000,
                    liked: false,
                },
                Music {
                    name: "Original Second".to_string(),
                    alias: "Pinned Second".to_string(),
                    group: second_group.clone(),
                    url: "https://example.com/watch?v=same".to_string(),
                    canonical_music_id: canonical_music_id_for_source(
                        &"https://example.com/watch?v=same".to_string(),
                        0,
                        180_000,
                    ),
                    path: Some("Disc 2/original.m4a".to_string()),
                    start_ms: 0,
                    end_ms: 10_000,
                    liked: false,
                },
            ],
            last_updated: "2026-04-12T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        };

        let probe = LeafProbe {
            title: "Replacement First".to_string(),
            webpage_url: "https://example.com/watch?v=same".to_string(),
            extractor_key: Some("Youtube".to_string()),
            album: None,
            duration_seconds: Some(10),
            chapters: vec![],
        };

        persist_downloaded_leaf_music(
            &mut collection,
            CollectionSourceKind::List,
            &probe,
            "Disc 1/replacement.m4a",
            first_group,
        )
        .await
        .expect("same video in one group should not remove another group copy");

        let by_group = collection
            .musics
            .iter()
            .map(|music| {
                (
                    music.group.url.as_str(),
                    music.path.as_deref(),
                    music.alias.as_str(),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(by_group.len(), 2);
        assert!(by_group.contains(&(
            "https://example.com/disc-1",
            Some("Disc 1/replacement.m4a"),
            "Pinned First"
        )));
        assert!(by_group.contains(&(
            "https://example.com/disc-2",
            Some("Disc 2/original.m4a"),
            "Pinned Second"
        )));

        reset_db();
    });
}

#[test]
fn normalize_music_titles_removes_common_group_affixes_inside_collection() {
    let group = collection_group(
        "ZWEI2 Original Soundtrack",
        "https://example.com/playlist/zwei2",
        "ZWEI2 Original Soundtrack",
    );
    let death_stranding_group = collection_group(
        "Death Stranding 2",
        "https://example.com/playlist/death-stranding-2",
        "Death Stranding 2",
    );
    let mut collection = Collection {
        name: "Mixed Downloads".to_string(),
        url: "https://example.com/root".to_string(),
        folder: "example/root".to_string(),
        musics: vec![
            Music {
                name: "ZWEI2 - Disturbing Atmosphere".to_string(),
                alias: "ZWEI2 - Disturbing Atmosphere".to_string(),
                group: group.clone(),
                url: "https://example.com/watch?v=zwei2-1".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=zwei2-1".to_string(), 0, 180_000),
                path: Some("zwei2-1.m4a".to_string()),
                start_ms: 0,
                end_ms: 79_000,
                liked: false,
            },
            Music {
                name: "ZWEI2 - Zahar's Ambition".to_string(),
                alias: "Pinned Alias".to_string(),
                group,
                url: "https://example.com/watch?v=zwei2-2".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=zwei2-2".to_string(), 0, 180_000),
                path: Some("zwei2-2.m4a".to_string()),
                start_ms: 0,
                end_ms: 152_000,
                liked: false,
            },
            Music {
                name: "Ludvig Forssell - A Heartfelt Apology | Death Stranding 2 On The Beach Original Video Game Score".to_string(),
                alias: "Ludvig Forssell - A Heartfelt Apology | Death Stranding 2 On The Beach Original Video Game Score".to_string(),
                group: death_stranding_group.clone(),
                url: "https://example.com/watch?v=ds2-1".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=ds2-1".to_string(), 0, 180_000),
                path: Some("ds2-1.m4a".to_string()),
                start_ms: 0,
                end_ms: 213_000,
                liked: false,
            },
            Music {
                name: "Ludvig Forssell - Drawbridge | Death Stranding 2 On The Beach Original Video Game Score".to_string(),
                alias: "Ludvig Forssell - Drawbridge | Death Stranding 2 On The Beach Original Video Game Score".to_string(),
                group: death_stranding_group,
                url: "https://example.com/watch?v=ds2-2".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=ds2-2".to_string(), 0, 180_000),
                path: Some("ds2-2.m4a".to_string()),
                start_ms: 0,
                end_ms: 180_000,
                liked: false,
            },
        ],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "Disturbing Atmosphere");
    assert_eq!(collection.musics[0].alias, "Disturbing Atmosphere");
    assert_eq!(collection.musics[1].name, "Zahar's Ambition");
    assert_eq!(collection.musics[1].alias, "Pinned Alias");
    assert_eq!(collection.musics[2].name, "A Heartfelt Apology");
    assert_eq!(collection.musics[2].alias, "A Heartfelt Apology");
    assert_eq!(collection.musics[3].name, "Drawbridge");
    assert_eq!(collection.musics[3].alias, "Drawbridge");
}

#[test]
fn normalize_music_titles_does_not_compare_across_download_groups() {
    let first_group = collection_group(
        "First Playlist",
        "https://example.com/playlist/first",
        "first",
    );
    let second_group = collection_group(
        "Second Playlist",
        "https://example.com/playlist/second",
        "second",
    );
    let mut collection = Collection {
        name: "Root".to_string(),
        url: "https://example.com/root".to_string(),
        folder: "example/root".to_string(),
        musics: vec![
            Music {
                name: "Album - Alpha".to_string(),
                alias: "Album - Alpha".to_string(),
                group: first_group,
                url: "https://example.com/watch?v=alpha".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/watch?v=alpha".to_string(),
                    0,
                    180_000,
                ),
                path: Some("alpha.m4a".to_string()),
                start_ms: 0,
                end_ms: 120_000,
                liked: false,
            },
            Music {
                name: "Album - Beta".to_string(),
                alias: "Album - Beta".to_string(),
                group: second_group,
                url: "https://example.com/watch?v=beta".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/watch?v=beta".to_string(),
                    0,
                    180_000,
                ),
                path: Some("beta.m4a".to_string()),
                start_ms: 0,
                end_ms: 120_000,
                liked: false,
            },
        ],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "Album - Alpha");
    assert_eq!(collection.musics[1].name, "Album - Beta");
}

#[test]
fn describe_download_resource_maps_single_probe_to_one_item_result() {
    let _guard = acquire_db_test_lock();
    let probe = run_async(async {
        ensure_db().await;
        let result = describe_download_resource(RootProbe::Single(LeafProbe {
            title: "Single Track".to_string(),
            webpage_url: "https://example.com/watch?v=single".to_string(),
            extractor_key: Some("Youtube".to_string()),
            album: None,
            duration_seconds: Some(245),
            chapters: vec![],
        }))
        .await;
        reset_db();
        result
    })
    .expect("single root probe should become a download resource");

    assert_eq!(probe.url, "https://example.com/watch?v=single");
    assert_eq!(probe.source_kind, CollectionSourceKind::Single);
    assert_eq!(probe.title, "Single Track");
    assert_eq!(probe.item_count, 1);
    assert_eq!(probe.collection_folder, "example/Single Track");
    assert_eq!(probe.enable_updates, None);
}

#[test]
fn describe_download_resource_rejects_empty_lists() {
    let _guard = acquire_db_test_lock();
    let error = run_async(async {
        ensure_db().await;
        let result = describe_download_resource(RootProbe::List(PlaylistRoot {
            title: "Empty Playlist".to_string(),
            webpage_url: "https://example.com/playlist".to_string(),
            extractor_key: Some("YoutubeTab".to_string()),
            entries: vec![],
        }))
        .await;
        reset_db();
        result
    })
    .expect_err("empty list probes should be rejected");

    assert!(
        error
            .to_string()
            .contains("download resource does not contain any downloadable entries")
    );
}

fn temp_test_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!(
        "slisic_service_test_{}_{}",
        std::process::id(),
        nanos
    ))
}

static SERVICE_TEST_RT: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("download service test runtime should be created"));

fn collection_group(name: &str, url: &str, folder: &str) -> Group {
    Group {
        name: name.to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
    }
}

fn leaf_probe(title: &str, url: &str, duration_seconds: u32) -> LeafProbe {
    LeafProbe {
        title: title.to_string(),
        webpage_url: url.to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_seconds: Some(duration_seconds),
        chapters: vec![],
    }
}

#[derive(Debug, Default)]
struct FakeYtDlpClient {
    roots: HashMap<String, RootProbe>,
}

impl YtDlpClient for FakeYtDlpClient {
    fn probe_root(&self, url: &str) -> Result<RootProbe> {
        self.roots
            .get(url)
            .cloned()
            .ok_or_else(|| anyhow!("missing fake root probe for {url}"))
    }

    fn probe_leaf(&self, url: &str) -> Result<LeafProbe> {
        Err(anyhow!("unexpected fake probe_leaf call for {url}"))
    }

    fn download_leaf_audio(
        &self,
        url: &str,
        _target_dir: &Path,
        _file_stem: &str,
        _on_progress: &mut dyn FnMut(DownloadProgress),
    ) -> Result<DownloadedLeaf> {
        Err(anyhow!("unexpected fake download call for {url}"))
    }
}

fn run_async<T>(fut: impl std::future::Future<Output = T>) -> T {
    SERVICE_TEST_RT.block_on(fut)
}

fn acquire_db_test_lock() -> std::sync::MutexGuard<'static, ()> {
    PLAYLIST_DB_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn ensure_db() {
    reinit_db_with_options(
        temp_test_dir(),
        InitDbOptions::default()
            .versioned(false)
            .changefeed_gc_interval(None),
    )
    .await
    .expect("download service database should initialize");
}

#[test]
fn resolve_pasted_download_url_rejects_invalid_urls_before_lookup() {
    let resolution = run_async(resolve_pasted_download_url("not a url".to_string()))
        .expect("invalid pasted text should resolve into a candidate error");

    assert_eq!(
        resolution.status,
        PastedDownloadUrlResolutionStatus::InvalidUrl
    );
    assert_eq!(
        resolution.error.as_deref(),
        Some("Clipboard does not contain a valid URL.")
    );
    assert!(resolution.url.is_none());
    assert!(resolution.collection.is_none());
}

#[test]
fn resolve_pasted_download_url_returns_new_url_when_library_has_no_match() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let resolution = resolve_pasted_download_url(" https://example.com/fresh ".to_string())
            .await
            .expect("fresh pasted url should resolve");

        assert_eq!(resolution.status, PastedDownloadUrlResolutionStatus::NewUrl);
        assert_eq!(resolution.url.as_deref(), Some("https://example.com/fresh"));
        assert!(resolution.error.is_none());
        assert!(resolution.collection.is_none());

        reset_db();
    });
}

#[test]
fn resolve_pasted_download_url_canonicalizes_youtube_watch_playlist_identity() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let resolution = resolve_pasted_download_url(
            "https://www.youtube.com/watch?v=abc123&list=PLtenet&index=14".to_string(),
        )
        .await
        .expect("watch playlist url should resolve");

        assert_eq!(resolution.status, PastedDownloadUrlResolutionStatus::NewUrl);
        assert_eq!(
            resolution.url.as_deref(),
            Some("https://www.youtube.com/playlist?list=PLtenet")
        );

        reset_db();
    });
}

#[test]
fn resolve_pasted_download_url_keeps_youtube_mix_watch_urls_as_single_identity() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let resolution = resolve_pasted_download_url(
            "https://www.youtube.com/watch?v=ZE5zXLOyEOQ&list=RDMMIHIRrASFLcg&index=3".to_string(),
        )
        .await
        .expect("mix watch url should resolve");

        assert_eq!(resolution.status, PastedDownloadUrlResolutionStatus::NewUrl);
        assert_eq!(
            resolution.url.as_deref(),
            Some("https://www.youtube.com/watch?v=ZE5zXLOyEOQ")
        );

        reset_db();
    });
}

#[test]
fn resolve_pasted_download_url_returns_existing_collection_for_known_url() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let collection = Collection {
            name: "Known".to_string(),
            url: "https://example.com/known".to_string(),
            folder: "example/known".to_string(),
            musics: vec![],
            last_updated: "2026-04-24T00:00:00+00:00".to_string(),
            enable_updates: None,
        };
        upsert_collection(&collection)
            .await
            .expect("known collection should be saved");

        let resolution = resolve_pasted_download_url(collection.url.clone())
            .await
            .expect("known pasted url should resolve");

        assert_eq!(
            resolution.status,
            PastedDownloadUrlResolutionStatus::ExistingCollection
        );
        assert_eq!(resolution.url.as_deref(), Some(collection.url.as_str()));
        assert!(resolution.error.is_none());
        assert_eq!(
            resolution
                .collection
                .as_ref()
                .map(|value| value.url.as_str()),
            Some(collection.url.as_str())
        );

        reset_db();
    });
}

#[test]
fn existing_leaf_identities_only_count_entries_with_present_files() {
    let root = temp_test_dir();
    let folder = "youtube/demo";
    let collection_dir = root.join(folder);
    std::fs::create_dir_all(&collection_dir).expect("test collection dir should be created");
    std::fs::write(collection_dir.join("present.m4a"), b"ok")
        .expect("present audio file should be created");

    let collection = Collection {
        name: "Demo".to_string(),
        url: "https://example.com/playlist".to_string(),
        folder: folder.to_string(),
        musics: vec![
            Music {
                name: "Present".to_string(),
                alias: "Present".to_string(),
                group: collection_group("Demo", "https://example.com/playlist", folder),
                url: "https://example.com/watch?v=present".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/watch?v=present".to_string(),
                    0,
                    180_000,
                ),
                path: Some("present.m4a".to_string()),
                start_ms: 0,
                end_ms: 60_000,
                liked: false,
            },
            Music {
                name: "Missing".to_string(),
                alias: "Missing".to_string(),
                group: collection_group("Demo", "https://example.com/playlist", folder),
                url: "https://example.com/watch?v=missing".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/watch?v=missing".to_string(),
                    0,
                    180_000,
                ),
                path: Some("missing.m4a".to_string()),
                start_ms: 0,
                end_ms: 60_000,
                liked: false,
            },
        ],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    let identities = existing_leaf_identities(Some(&collection), &root);

    let planned = vec![
        PlannedLeaf {
            id: Id::from("leaf-present"),
            url: "https://example.com/watch?v=present".to_string(),
            sequence: 0,
            initial_probe: None,
            music_title: None,
            group_hint: Some(collection_group(
                "Demo",
                "https://example.com/playlist",
                folder,
            )),
        },
        PlannedLeaf {
            id: Id::from("leaf-missing"),
            url: "https://example.com/watch?v=missing".to_string(),
            sequence: 1,
            initial_probe: None,
            music_title: None,
            group_hint: Some(collection_group(
                "Demo",
                "https://example.com/playlist",
                folder,
            )),
        },
    ];

    let remaining = filter_new_planned_leaves(&collection.url, planned, &identities);

    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].url, "https://example.com/watch?v=missing");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn existing_leaf_identities_keep_same_video_distinct_across_playlist_groups() {
    let root = temp_test_dir();
    let folder = "youtube/demo";
    std::fs::create_dir_all(root.join(folder).join("Disc 1"))
        .expect("first group dir should be created");
    std::fs::write(root.join(folder).join("Disc 1").join("track.m4a"), b"ok")
        .expect("first group audio file should be created");

    let collection = Collection {
        name: "Demo".to_string(),
        url: "https://example.com/playlist".to_string(),
        folder: folder.to_string(),
        musics: vec![Music {
            name: "Track".to_string(),
            alias: "Track".to_string(),
            group: collection_group("Disc 1", "https://example.com/disc-1", "Disc 1"),
            url: "https://example.com/watch?v=same".to_string(),
            canonical_music_id: canonical_music_id_for_source(
                &"https://example.com/watch?v=same".to_string(),
                0,
                180_000,
            ),
            path: Some("Disc 1/track.m4a".to_string()),
            start_ms: 0,
            end_ms: 60_000,
            liked: false,
        }],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    let identities = existing_leaf_identities(Some(&collection), &root);
    let planned = vec![
        PlannedLeaf {
            id: Id::from("leaf-disc-1"),
            url: "https://example.com/watch?v=same".to_string(),
            sequence: 0,
            initial_probe: None,
            music_title: None,
            group_hint: Some(collection_group(
                "Disc 1",
                "https://example.com/disc-1",
                "Disc 1",
            )),
        },
        PlannedLeaf {
            id: Id::from("leaf-disc-2"),
            url: "https://example.com/watch?v=same".to_string(),
            sequence: 1,
            initial_probe: None,
            music_title: None,
            group_hint: Some(collection_group(
                "Disc 2",
                "https://example.com/disc-2",
                "Disc 2",
            )),
        },
    ];

    let remaining = filter_new_planned_leaves(&collection.url, planned, &identities);

    assert_eq!(remaining.len(), 1);
    assert_eq!(
        remaining[0]
            .group_hint
            .as_ref()
            .map(|group| group.url.as_str()),
        Some("https://example.com/disc-2")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn filter_new_planned_leaves_collapses_same_group_duplicate_video_urls() {
    let collection_url = "https://example.com/root";
    let group = collection_group("Disc 1", "https://example.com/disc-1", "Disc 1");
    let planned = vec![
        PlannedLeaf {
            id: Id::from("leaf-first"),
            url: "https://example.com/watch?v=same".to_string(),
            sequence: 0,
            initial_probe: None,
            music_title: None,
            group_hint: Some(group.clone()),
        },
        PlannedLeaf {
            id: Id::from("leaf-duplicate"),
            url: "https://example.com/watch?v=same".to_string(),
            sequence: 1,
            initial_probe: None,
            music_title: None,
            group_hint: Some(group),
        },
    ];

    let remaining = filter_new_planned_leaves(collection_url, planned, &HashSet::new());

    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id.to_string(), "leaf-first");
}
#[test]
fn materialize_music_entries_preserves_group_and_nested_relative_path() {
    let probe = LeafProbe {
        title: "Album".to_string(),
        webpage_url: "https://example.com/video".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_seconds: Some(180),
        chapters: vec![LeafChapter {
            title: "Intro".to_string(),
            start_ms: 0,
            end_ms: 180_000,
        }],
    };
    let group = Group {
        name: "Compilation".to_string(),
        url: "https://example.com/group".to_string(),
        folder: "Compilation".to_string(),
    };
    let relative_path = Path::new(&group.folder)
        .join("album.m4a")
        .to_string_lossy()
        .to_string();

    let musics = materialize_music_entries(&probe, &relative_path, group.clone());

    assert_eq!(musics.len(), 1);
    let music_group = &musics[0].group;
    assert_eq!(music_group.name, group.name);
    assert_eq!(music_group.url, group.url);
    assert_eq!(music_group.folder, group.folder);
    assert_eq!(musics[0].path.as_deref(), Some(relative_path.as_str()));
}

#[test]
fn resolve_existing_leaf_file_matches_expected_final_m4a_path() {
    let root = temp_test_dir();
    let collection = Collection {
        name: "Recovered".to_string(),
        url: "https://example.com/collection".to_string(),
        folder: "example/recovered".to_string(),
        musics: vec![],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };
    let group = collection_group("Recovered", &collection.url, &collection.folder);
    let collection_dir = root.join(&collection.folder);
    std::fs::create_dir_all(&collection_dir).expect("test collection dir should be created");
    std::fs::write(collection_dir.join("Track One.m4a"), b"existing")
        .expect("existing audio file should be created");

    let relative_path = resolve_existing_leaf_file(&collection, &group, &root, "Track One");

    assert_eq!(relative_path.as_deref(), Some("Track One.m4a"));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn resolve_existing_leaf_file_matches_nested_group_path() {
    let root = temp_test_dir();
    let collection = Collection {
        name: "Recovered".to_string(),
        url: "https://example.com/collection".to_string(),
        folder: "example/recovered".to_string(),
        musics: vec![],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };
    let group = collection_group("Disc 1", "https://example.com/group", "Disc 1");
    let group_dir = root.join(&collection.folder).join(&group.folder);
    std::fs::create_dir_all(&group_dir).expect("test group dir should be created");
    std::fs::write(group_dir.join("Track One.m4a"), b"existing")
        .expect("existing nested audio file should be created");

    let relative_path = resolve_existing_leaf_file(&collection, &group, &root, "Track One");
    let expected = Path::new(&group.folder)
        .join("Track One.m4a")
        .to_string_lossy()
        .to_string();

    assert_eq!(relative_path.as_deref(), Some(expected.as_str()));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn resolve_existing_temp_downloaded_file_recovers_matching_temporary_audio() {
    let root = temp_test_dir();
    std::fs::create_dir_all(&root).expect("temp dir should be created");
    let expected = root.join("Track.__slisic_tmp__abc123.m4a");
    std::fs::write(&expected, b"downloaded").expect("temp audio should be created");
    std::fs::write(root.join("Track.__slisic_tmp__other.m4a"), b"other")
        .expect("other temp audio should be created");

    let recovered = resolve_existing_temp_downloaded_file(&root, "Track.__slisic_tmp__abc123");

    assert_eq!(recovered.as_deref(), Some(expected.as_path()));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn resolve_task_collection_folder_keeps_existing_task_download_folder_after_url_canonicalization() {
    let task = {
        let mut task = DownloadTask::new(
            "task-existing-folder",
            "https://www.youtube.com/playlist?list=PLtenet",
            DownloadTrigger::Manual,
        );
        task.collection_folder =
            Some("youtube/TENET Official Soundtrack - WaterTower Music".to_string());
        task
    };

    let folder = run_async(resolve_task_collection_folder(
        &task,
        "https://www.youtube.com/playlist?list=PLtenet",
        "TENET Official Soundtrack - WaterTower Music",
        None,
    ))
    .expect("existing task folder should resolve");

    assert_eq!(
        folder,
        "youtube/TENET Official Soundtrack - WaterTower Music"
    );
}

#[test]
fn derives_channel_url_from_uploads_playlist_id() {
    let derived = derive_youtube_channel_url_from_uploads_playlist(
        "https://www.youtube.com/playlist?list=UUyp_JApwUNqb9v595vPRvhg",
    );

    assert_eq!(
        derived.as_deref(),
        Some("https://www.youtube.com/channel/UCyp_JApwUNqb9v595vPRvhg")
    );
}

#[test]
fn extracts_unique_olak_playlist_ids_from_html() {
    let html = r#"
        <script>
            var a = "OLAK5uy_testAlpha-123";
            var b = "OLAK5uy_testBeta_456";
            var c = "OLAK5uy_testAlpha-123";
        </script>
    "#;

    let ids = extract_olak_playlist_ids(html);

    assert_eq!(
        ids,
        BTreeSet::from([
            "OLAK5uy_testAlpha-123".to_string(),
            "OLAK5uy_testBeta_456".to_string(),
        ])
    );
}

#[test]
fn try_claim_enqueue_url_allows_only_one_parallel_claim_for_same_url() {
    let barrier = Arc::new(Barrier::new(8));
    let winners = Arc::new(AtomicUsize::new(0));

    let handles = (0..8)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            let winners = Arc::clone(&winners);
            std::thread::spawn(move || {
                barrier.wait();
                let claim = try_claim_enqueue_url("https://example.com/list")
                    .expect("enqueue url claim should not poison");
                if claim.is_some() {
                    winners.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            })
        })
        .collect::<Vec<_>>();

    for handle in handles {
        handle.join().expect("parallel claim thread should finish");
    }

    assert_eq!(winners.load(Ordering::SeqCst), 1);
    assert!(
        try_claim_enqueue_url("https://example.com/list")
            .expect("claim should succeed after previous guard dropped")
            .is_some()
    );
}

#[test]
fn prepare_task_enqueue_deduplicates_same_url_under_concurrency() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let handles = (0..12)
            .map(|_| {
                tokio::spawn(prepare_task_enqueue(
                    "https://example.com/list".to_string(),
                    DownloadTrigger::Manual,
                ))
            })
            .collect::<Vec<_>>();

        let mut ids = BTreeSet::new();
        for handle in handles {
            let task = handle
                .await
                .expect("task join should succeed")
                .expect("enqueue should succeed");
            ids.insert(task.id.to_string());
        }

        let tasks = list_tasks().await.expect("task listing should succeed");
        assert_eq!(ids.len(), 1);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].url, "https://example.com/list");

        reset_db();
    });
}

#[test]
fn prepare_task_enqueue_deduplicates_equivalent_single_video_aliases() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let alias = "https://www.youtube.com/watch?v=ZE5zXLOyEOQ&list=RDMMIHIRrASFLcg&index=3";
        let canonical = "https://www.youtube.com/watch?v=ZE5zXLOyEOQ";

        let first = prepare_task_enqueue(alias.to_string(), DownloadTrigger::Manual)
            .await
            .expect("aliased single video enqueue should succeed");
        let second = prepare_task_enqueue(canonical.to_string(), DownloadTrigger::Manual)
            .await
            .expect("canonical single video enqueue should succeed");
        let tasks = list_tasks().await.expect("task listing should succeed");

        assert_eq!(
            first.id, second.id,
            "equivalent single-video urls should resolve to one active task"
        );
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].url, canonical);

        reset_db();
    });
}

#[test]
fn prepare_task_enqueue_accepts_many_distinct_urls_concurrently() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let urls = (0..24)
            .map(|index| format!("https://example.com/list/{index}"))
            .collect::<Vec<_>>();
        let handles = urls
            .iter()
            .cloned()
            .map(|url| tokio::spawn(prepare_task_enqueue(url, DownloadTrigger::Manual)))
            .collect::<Vec<_>>();

        let mut ids = BTreeSet::new();
        for handle in handles {
            let task = handle
                .await
                .expect("task join should succeed")
                .expect("enqueue should succeed");
            ids.insert(task.id.to_string());
        }

        let tasks = list_tasks().await.expect("task listing should succeed");
        assert_eq!(ids.len(), urls.len());
        assert_eq!(tasks.len(), urls.len());

        reset_db();
    });
}

#[test]
fn resume_download_task_rejects_completed_tasks() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let mut task = DownloadTask::new(
            "completed-task".to_string(),
            "https://example.com/video".to_string(),
            DownloadTrigger::Manual,
        );
        task.status = DownloadTaskStatus::Completed;
        save_task(task).await.expect("completed task should save");

        let error = resume_download_task("completed-task".to_string())
            .await
            .expect_err("completed tasks should not resume");

        assert!(
            error
                .to_string()
                .contains("completed download tasks cannot be resumed")
        );

        reset_db();
    });
}

#[test]
fn save_task_retries_surrealdb_failed_transaction_wrappers() {
    let error =
        anyhow!("Query response error: The query was not executed due to a failed transaction");

    assert!(super::repo::is_retryable_transaction_conflict(&error));
}

#[test]
fn expand_root_entries_to_planned_leafs_flattens_nested_playlists_into_grouped_leaves() {
    run_async(async {
        let nested_url = "https://www.youtube.com/playlist?list=PLnested";
        let client = Arc::new(FakeYtDlpClient {
            roots: HashMap::from([(
                nested_url.to_string(),
                RootProbe::List(PlaylistRoot {
                    title: "Album One".to_string(),
                    webpage_url: nested_url.to_string(),
                    extractor_key: Some("YoutubeTab".to_string()),
                    entries: vec![
                        LeafReference {
                            url: "https://www.youtube.com/watch?v=track1".to_string(),
                            title: Some("Track 1".to_string()),
                            sequence: 0,
                        },
                        LeafReference {
                            url: "https://www.youtube.com/watch?v=track2".to_string(),
                            title: Some("Track 2".to_string()),
                            sequence: 1,
                        },
                    ],
                }),
            )]),
        });

        let leaves = expand_root_entries_to_planned_leafs(
            &Id::from("task-expand"),
            client,
            vec![LeafReference {
                url: nested_url.to_string(),
                title: Some("Album One".to_string()),
                sequence: 0,
            }],
            None,
        )
        .await
        .expect("nested playlist should expand into leaf downloads");

        assert_eq!(leaves.len(), 2);
        assert_eq!(leaves[0].url, "https://www.youtube.com/watch?v=track1");
        assert_eq!(leaves[1].url, "https://www.youtube.com/watch?v=track2");
        assert_eq!(
            leaves[0]
                .initial_probe
                .as_ref()
                .map(|probe| probe.title.as_str()),
            None
        );
        assert_eq!(
            leaves[0]
                .initial_probe
                .as_ref()
                .map(|probe| probe.webpage_url.as_str()),
            None
        );
        assert_eq!(
            leaves[0]
                .initial_probe
                .as_ref()
                .and_then(|probe| probe.album.as_deref()),
            None
        );
        assert_eq!(leaves[0].music_title.as_deref(), Some("Track 1"));
        assert_eq!(leaves[1].music_title.as_deref(), Some("Track 2"));
        assert_eq!(leaves[0].sequence, 0);
        assert_eq!(leaves[1].sequence, 1);
        let group = leaves[0]
            .group_hint
            .as_ref()
            .expect("nested playlist leaves should inherit group hint");
        assert_eq!(group.name, "Album One");
        assert_eq!(group.url, nested_url);
        assert_eq!(group.folder, "Album One");
    });
}

#[test]
fn expand_root_entries_to_planned_leafs_normalizes_music_titles_from_playlist_context() {
    run_async(async {
        let leaves = expand_root_entries_to_planned_leafs(
            &Id::from("task-galacticare"),
            Arc::new(FakeYtDlpClient::default()),
            vec![
                LeafReference {
                    url: "https://www.youtube.com/watch?v=patient".to_string(),
                    title: Some("One Patient at a Time - Galacticare Soundtrack".to_string()),
                    sequence: 0,
                },
                LeafReference {
                    url: "https://www.youtube.com/watch?v=algaemist".to_string(),
                    title: Some("Algaemist - Galacticare Soundtrack".to_string()),
                    sequence: 1,
                },
            ],
            Some(collection_group(
                "Galacticare",
                "https://example.com/playlist/galacticare",
                "Galacticare",
            )),
        )
        .await
        .expect("flat playlist leaf titles should normalize without leaf probing");

        assert_eq!(
            leaves
                .iter()
                .map(|leaf| leaf
                    .initial_probe
                    .as_ref()
                    .map(|probe| probe.title.as_str()))
                .collect::<Vec<_>>(),
            vec![None, None]
        );
        assert_eq!(
            leaves
                .iter()
                .map(|leaf| leaf.music_title.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("One Patient at a Time"), Some("Algaemist")]
        );
    });
}

#[test]
fn expand_root_entries_to_planned_leafs_keeps_same_video_distinct_across_groups() {
    run_async(async {
        let first_url = "https://www.youtube.com/playlist?list=PLfirst";
        let second_url = "https://www.youtube.com/playlist?list=PLsecond";
        let repeated_video_url = "https://www.youtube.com/watch?v=same";
        let client = Arc::new(FakeYtDlpClient {
            roots: HashMap::from([
                (
                    first_url.to_string(),
                    RootProbe::List(PlaylistRoot {
                        title: "First Album".to_string(),
                        webpage_url: first_url.to_string(),
                        extractor_key: Some("YoutubeTab".to_string()),
                        entries: vec![LeafReference {
                            url: repeated_video_url.to_string(),
                            title: Some("Shared Track".to_string()),
                            sequence: 0,
                        }],
                    }),
                ),
                (
                    second_url.to_string(),
                    RootProbe::List(PlaylistRoot {
                        title: "Second Album".to_string(),
                        webpage_url: second_url.to_string(),
                        extractor_key: Some("YoutubeTab".to_string()),
                        entries: vec![LeafReference {
                            url: repeated_video_url.to_string(),
                            title: Some("Shared Track".to_string()),
                            sequence: 0,
                        }],
                    }),
                ),
            ]),
        });

        let leaves = expand_root_entries_to_planned_leafs(
            &Id::from("task-shared-video"),
            client,
            vec![
                LeafReference {
                    url: first_url.to_string(),
                    title: Some("First Album".to_string()),
                    sequence: 0,
                },
                LeafReference {
                    url: second_url.to_string(),
                    title: Some("Second Album".to_string()),
                    sequence: 1,
                },
            ],
            None,
        )
        .await
        .expect("same video can belong to two playlist groups");

        assert_eq!(leaves.len(), 2);
        assert_eq!(leaves[0].url, repeated_video_url);
        assert_eq!(leaves[1].url, repeated_video_url);
        assert_ne!(leaves[0].id, leaves[1].id);
        assert_eq!(
            leaves
                .iter()
                .map(|leaf| leaf.group_hint.as_ref().map(|group| group.url.as_str()))
                .collect::<Vec<_>>(),
            vec![Some(first_url), Some(second_url)]
        );
    });
}

#[test]
fn create_collection_shell_reuses_existing_music_and_updates_collection_metadata() {
    let existing = Collection {
        name: "Original List".to_string(),
        url: "https://example.com/list".to_string(),
        folder: "youtube/original-list".to_string(),
        musics: vec![Music {
            name: "Track 1".to_string(),
            alias: "Track 1".to_string(),
            group: collection_group("Disc 1", "https://example.com/list#disc-1", "Disc 1"),
            url: "https://example.com/watch?v=track-1".to_string(),
            canonical_music_id: canonical_music_id_for_source(
                &"https://example.com/watch?v=track-1".to_string(),
                0,
                180_000,
            ),
            path: Some("Disc 1/track-1.m4a".to_string()),
            start_ms: 0,
            end_ms: 120_000,
            liked: false,
        }],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };
    let plan = CollectionSyncPlan {
        source_kind: CollectionSourceKind::List,
        collection_name: "Renamed List".to_string(),
        collection_url: existing.url.clone(),
        collection_folder: "youtube/renamed-list".to_string(),
        enable_updates: Some(true),
        leaves: vec![],
    };

    let collection = create_collection_shell(&plan, Some(existing.clone()));

    assert_eq!(collection.name, "Renamed List");
    assert_eq!(collection.folder, "youtube/renamed-list");
    assert_eq!(collection.enable_updates, Some(true));
    assert_eq!(collection.musics.len(), existing.musics.len());
    assert_eq!(collection.musics[0].url, existing.musics[0].url);
    assert_eq!(collection.musics[0].group.url, existing.musics[0].group.url);
}

#[test]
fn apply_collection_plan_to_task_populates_collection_metadata_and_leaf_queue() {
    let mut task = DownloadTask::new(
        "task-bootstrap",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let plan = CollectionSyncPlan {
        source_kind: CollectionSourceKind::List,
        collection_name: "Bootstrapped List".to_string(),
        collection_url: "https://example.com/list".to_string(),
        collection_folder: "youtube/bootstrapped-list".to_string(),
        enable_updates: Some(false),
        leaves: vec![PlannedLeaf {
            id: Id::from("leaf-bootstrap"),
            url: "https://example.com/watch?v=leaf".to_string(),
            sequence: 0,
            initial_probe: None,
            music_title: None,
            group_hint: None,
        }],
    };

    apply_collection_plan_to_task(&mut task, &plan);

    assert_eq!(
        task.collection_url.as_deref(),
        Some("https://example.com/list")
    );
    assert_eq!(task.collection_name.as_deref(), Some("Bootstrapped List"));
    assert_eq!(
        task.collection_folder.as_deref(),
        Some("youtube/bootstrapped-list")
    );
    assert_eq!(task.source_kind, Some(CollectionSourceKind::List));
    assert_eq!(task.leafs.len(), 1);
    assert_eq!(task.leafs[0].url, "https://example.com/watch?v=leaf");
}

#[test]
fn apply_collection_plan_to_task_preserves_existing_leaf_evidence_when_plan_is_partial() {
    let mut task = DownloadTask::new(
        "task-existing",
        "https://example.com/list",
        DownloadTrigger::Manual,
    );
    let mut completed = crate::domain::downloads::model::DownloadLeaf::new(
        "leaf-completed",
        "https://example.com/watch?v=completed",
        0,
    );
    completed.status = crate::domain::downloads::model::DownloadLeafStatus::Completed;
    completed.file_name = Some("completed.m4a".to_string());
    task.replace_leaf(completed);

    let plan = CollectionSyncPlan {
        source_kind: CollectionSourceKind::List,
        collection_name: "Partial List".to_string(),
        collection_url: "https://example.com/list".to_string(),
        collection_folder: "youtube/partial-list".to_string(),
        enable_updates: Some(false),
        leaves: vec![PlannedLeaf {
            id: Id::from("leaf-new"),
            url: "https://example.com/watch?v=new".to_string(),
            sequence: 1,
            initial_probe: None,
            music_title: None,
            group_hint: None,
        }],
    };

    apply_collection_plan_to_task(&mut task, &plan);

    assert_eq!(task.leafs.len(), 2);
    assert_eq!(task.leafs[0].id.to_string(), "leaf-completed");
    assert_eq!(task.leafs[0].file_name.as_deref(), Some("completed.m4a"));
    assert_eq!(task.leafs[1].id.to_string(), "leaf-new");
}

#[test]
fn persist_enqueued_collection_shell_does_not_require_leaf_expansion() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let task = save_task(DownloadTask::new(
            "task-shell",
            "https://example.com/channel",
            DownloadTrigger::Manual,
        ))
        .await
        .expect("task should save before shell persistence");
        let plan = CollectionShellPlan {
            source_kind: CollectionSourceKind::List,
            collection_name: "Channel Shell".to_string(),
            collection_url: "https://example.com/channel".to_string(),
            collection_folder: "example/channel-shell".to_string(),
            enable_updates: Some(false),
        };

        let (saved_task, saved_collection) = persist_enqueued_collection_shell(task, &plan)
            .await
            .expect("enqueue shell should persist without expanded leaves");
        let reloaded_collection =
            crate::domain::playlists::repo::get_collection_by_url(&plan.collection_url)
                .await
                .expect("collection lookup should succeed")
                .expect("collection should exist immediately after shell persistence");

        assert_eq!(
            saved_task.collection_url.as_deref(),
            Some(plan.collection_url.as_str())
        );
        assert_eq!(saved_task.collection_name.as_deref(), Some("Channel Shell"));
        assert_eq!(saved_task.source_kind, Some(CollectionSourceKind::List));
        assert_eq!(saved_task.status, DownloadTaskStatus::Queued);
        assert!(saved_task.leafs.is_empty());
        assert_eq!(saved_task.total_leaves, 0);
        assert_eq!(saved_collection.url, plan.collection_url);
        assert_eq!(reloaded_collection.name, plan.collection_name);
        assert!(reloaded_collection.musics.is_empty());

        reset_db();
    });
}
