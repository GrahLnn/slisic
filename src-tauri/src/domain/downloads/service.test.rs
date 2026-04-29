use super::model::CollectionSourceKind;
use super::naming::{provider_segment, sanitize_path_component};
use super::repo::{list_tasks, save_task};
use super::service::{
    derive_youtube_channel_url_from_uploads_playlist, expand_root_entries_to_planned_leafs,
    extract_olak_playlist_ids, leaf_download_parallelism, prepare_task_enqueue,
    resolve_pasted_download_url, resume_download_task, should_reprobe_single_leaf,
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
    CollectionSyncPlan, PlannedLeaf, apply_collection_plan_to_task, create_collection_shell,
    describe_download_resource, existing_leaf_urls, materialize_music_entries,
    persist_enqueued_collection_state,
};
use crate::domain::downloads::model::{
    DownloadTask, DownloadTaskStatus, DownloadTrigger, PastedDownloadUrlResolutionStatus,
};
use crate::domain::playlists::PLAYLIST_DB_TEST_LOCK;
use crate::domain::playlists::model::{Collection, Group, Music};
use crate::domain::playlists::repo::upsert_collection;
use anyhow::{Result, anyhow};
use appdb::Id;
use appdb::connection::{InitDbOptions, reinit_db_with_options, reset_db};
use std::collections::{BTreeSet, HashMap};
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
                start_seconds: 0,
                end_seconds: 60,
            },
            LeafChapter {
                title: "Main".to_string(),
                start_seconds: 60,
                end_seconds: 180,
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
    assert_eq!(musics[0].start, 0);
    assert_eq!(musics[1].end, 180);
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
    assert_eq!(musics[0].start, 0);
    assert_eq!(musics[0].end, 245);
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
        "ransic_service_test_{}_{}",
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
fn existing_leaf_urls_only_counts_entries_with_present_files() {
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
                path: Some("present.m4a".to_string()),
                start: 0,
                end: 60,
            },
            Music {
                name: "Missing".to_string(),
                alias: "Missing".to_string(),
                group: collection_group("Demo", "https://example.com/playlist", folder),
                url: "https://example.com/watch?v=missing".to_string(),
                path: Some("missing.m4a".to_string()),
                start: 0,
                end: 60,
            },
        ],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    let urls = existing_leaf_urls(Some(&collection), &root);

    assert!(urls.contains("https://example.com/watch?v=present"));
    assert!(!urls.contains("https://example.com/watch?v=missing"));

    let _ = std::fs::remove_dir_all(root);
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
            start_seconds: 0,
            end_seconds: 180,
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
            path: Some("Disc 1/track-1.m4a".to_string()),
            start: 0,
            end: 120,
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
fn persist_enqueued_collection_state_saves_collection_before_leaf_downloads_start() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let task = save_task(DownloadTask::new(
            "task-persist",
            "https://example.com/list",
            DownloadTrigger::Manual,
        ))
        .await
        .expect("task should save before bootstrap persistence");
        let plan = CollectionSyncPlan {
            source_kind: CollectionSourceKind::List,
            collection_name: "Bootstrap Persist".to_string(),
            collection_url: "https://example.com/list".to_string(),
            collection_folder: "youtube/bootstrap-persist".to_string(),
            enable_updates: Some(false),
            leaves: vec![PlannedLeaf {
                id: Id::from("leaf-persist"),
                url: "https://example.com/watch?v=persist".to_string(),
                sequence: 0,
                initial_probe: None,
                group_hint: None,
            }],
        };

        let (saved_task, saved_collection) = persist_enqueued_collection_state(task, &plan)
            .await
            .expect("enqueue bootstrap should persist collection and task metadata");
        let reloaded_collection =
            crate::domain::playlists::repo::get_collection_by_url(&plan.collection_url)
                .await
                .expect("collection lookup should succeed")
                .expect("collection should exist immediately after bootstrap");

        assert_eq!(
            saved_task.collection_url.as_deref(),
            Some(plan.collection_url.as_str())
        );
        assert_eq!(saved_task.leafs.len(), 1);
        assert_eq!(saved_collection.url, plan.collection_url);
        assert_eq!(reloaded_collection.name, plan.collection_name);
        assert!(reloaded_collection.musics.is_empty());

        reset_db();
    });
}
