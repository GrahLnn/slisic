use super::model::CollectionSourceKind;
use super::naming::{provider_segment, sanitize_path_component};
use super::planning::{
    expand_root_entries_to_planned_leafs, probe_root_with_limit, residual_collection_plan,
    resolve_collection_plan, resolve_collection_plan_with_root_probe,
    resolve_task_collection_folder, root_probe_parallelism, should_reprobe_single_leaf,
};
use super::repo::{list_tasks, save_task};
use super::service::{
    CompletedLeafDownload, LeafDownloadRetryPolicy, LeafDownloadWindow, LeafPipelineStage,
    accept_collection_download_for_test, accept_collection_download_with_root_shell_for_test,
    apply_completed_audio_duration_evidence, attach_root_shell_to_task,
    discard_materialized_planned_leaves, handle_finished_leaf_download,
    is_retryable_leaf_download_error, leaf_download_parallelism, leaf_pipeline_has_work,
    leaf_pipeline_next_stage, prepare_task_enqueue, probe_download_root_title_with_client,
    resolve_pasted_download_url, resolve_residual_temp_downloaded_file, resume_download_task,
    should_interrupt_unresumable_active_task_after_restart,
    should_recover_download_task_after_restart, should_resume_download_task_after_restart,
    try_claim_enqueue_url,
};
use super::yt_dlp::{
    DownloadProgress, DownloadedLeaf, LeafChapter, LeafProbe, LeafReference, PlaylistRoot,
    RootProbe, RootShellProbe, YtDlpClient,
};
/// Appdb-style domain tests stay inside a local Tokio runtime and a temporary
/// appdb instance. Keep this file free of Tauri host setup and `AppHandle`
/// dependencies so `cargo test` only exercises pure download-domain contracts.
/// Manual end-to-end download checks belong in `examples/manual_download_chain.rs`.
use crate::domain::collection_import::{
    CollectionSyncPlan, ExistingPlannedLeafCompletion, PlannedLeaf, apply_collection_plan_to_task,
    create_collection_shell, existing_leaf_identities, existing_planned_leaf_completions,
    filter_new_planned_leaves, load_collection_shell_with_local_duration_probe,
    load_download_transaction_collection_shell, materialize_music_entries,
    normalize_music_titles_within_collection, persist_download_collection_shell_from_task,
    persist_downloaded_leaf_music,
    persist_enqueued_collection_plan, resolve_existing_leaf_file,
};
use crate::domain::downloads::model::{
    DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTaskStatus, DownloadTrigger,
    PastedDownloadUrlResolutionStatus,
};
use crate::domain::playlists::PLAYLIST_DB_TEST_LOCK;
use crate::domain::playlists::model::{
    Collection, CollectionGroupOwner, Group, Music, canonical_music_id_for_source,
};
use crate::domain::playlists::repo::upsert_collection;
use anyhow::{Result, anyhow};
use appdb::Id;
use appdb::connection::{InitDbOptions, reinit_db_with_options, reset_db};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, LazyLock, Mutex};
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
fn leaf_download_window_grows_after_sustained_successes() {
    let mut window = LeafDownloadWindow::for_collection(CollectionSourceKind::List, 8);

    assert_eq!(window.current_limit(), 4);
    for _ in 0..3 {
        window.record_success();
        assert_eq!(window.current_limit(), 4);
    }

    window.record_success();
    assert_eq!(window.current_limit(), 5);

    for _ in 0..5 {
        window.record_success();
    }
    assert_eq!(window.current_limit(), 6);
}

#[test]
fn leaf_download_window_halves_after_failures_without_stalling_lists() {
    let mut window = LeafDownloadWindow::for_collection(CollectionSourceKind::List, 8);

    window.record_failure();
    assert_eq!(window.current_limit(), 2);

    window.record_failure();
    assert_eq!(window.current_limit(), 1);

    window.record_failure();
    assert_eq!(window.current_limit(), 1);

    window.record_success();
    assert_eq!(window.current_limit(), 2);
}

#[test]
fn leaf_download_window_keeps_single_downloads_serial() {
    let mut window = LeafDownloadWindow::for_collection(CollectionSourceKind::Single, 3);

    assert_eq!(window.current_limit(), 1);
    window.record_success();
    window.record_failure();
    assert_eq!(window.current_limit(), 1);
}

#[test]
fn leaf_pipeline_work_includes_ready_finalizations() {
    assert!(!leaf_pipeline_has_work(0, 0, 0, 0, 0));
    assert!(leaf_pipeline_has_work(0, 0, 0, 0, 1));
}

#[test]
fn leaf_pipeline_prioritizes_ready_finalizations_before_new_work() {
    assert_eq!(
        leaf_pipeline_next_stage(4, 0, 4, 1, 4),
        LeafPipelineStage::Finalize
    );
    assert_eq!(
        leaf_pipeline_next_stage(4, 0, 4, 0, 4),
        LeafPipelineStage::Download
    );
}

#[test]
fn leaf_download_retry_policy_cools_down_retryable_failures_then_stops() {
    let policy = LeafDownloadRetryPolicy::default();
    let error = anyhow!("yt-dlp download exited with status exit code: 1");

    assert_eq!(
        policy.cooldown_after_failure(1, "leaf-a", &error),
        Some(std::time::Duration::from_millis(2037))
    );
    assert_eq!(
        policy.cooldown_after_failure(2, "leaf-a", &error),
        Some(std::time::Duration::from_millis(4047))
    );
    assert_eq!(policy.cooldown_after_failure(3, "leaf-a", &error), None);
}

#[test]
fn leaf_download_retry_policy_does_not_retry_structural_failures() {
    let error = anyhow!("yt-dlp completed but final audio path could not be resolved");

    assert!(!is_retryable_leaf_download_error(&error));
    assert_eq!(
        LeafDownloadRetryPolicy::default().cooldown_after_failure(1, "leaf-a", &error),
        None
    );
}

#[test]
fn leaf_download_retry_policy_does_not_retry_private_or_auth_required_videos() {
    let errors = [
        "yt-dlp command failed: ERROR: [youtube] bZBdVE0B4qc: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.",
        "yt-dlp command failed: ERROR: [youtube] abc: Sign in to confirm your age",
        "yt-dlp download exited with status exit code: 1: members-only content",
        "yt-dlp download exited with status exit code: 1: Video unavailable",
    ];

    for message in errors {
        let error = anyhow!(message);

        assert!(!is_retryable_leaf_download_error(&error));
        assert_eq!(
            LeafDownloadRetryPolicy::default().cooldown_after_failure(1, "leaf-a", &error),
            None
        );
    }
}

#[test]
fn leaf_download_retry_policy_spreads_parallel_retries_by_leaf_identity() {
    let policy = LeafDownloadRetryPolicy::default();
    let error = anyhow!("yt-dlp download exited with status exit code: 1");

    assert_eq!(
        policy.cooldown_after_failure(1, "leaf-a", &error),
        Some(std::time::Duration::from_millis(2037))
    );
    assert_eq!(
        policy.cooldown_after_failure(1, "leaf-b", &error),
        Some(std::time::Duration::from_millis(2531))
    );
    assert_eq!(policy.cooldown_after_failure(0, "leaf-a", &error), None);
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
                    duration_ms: None,
                },
                progress: DownloadProgress::default(),
                retry_failures: 0,
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
                    duration_ms: None,
                },
                progress: DownloadProgress::default(),
                retry_failures: 0,
            }),
        )
        .await
        .expect("later leaf should still complete after earlier finalize failure");

        assert_eq!(task.completed_leaves, 1);
        assert_eq!(task.failed_leaves, 1);
        assert!(
            task.leafs
                .iter()
                .all(|leaf| leaf.id.to_string() != "leaf-b")
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
        duration_ms: Some(180_000),
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
        duration_ms: Some(245_500),
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
    assert_eq!(musics[0].end_ms, 245_500);
}

#[test]
fn materialize_music_entries_uses_precise_full_track_duration_evidence() {
    let probe = LeafProbe {
        title: "481772".to_string(),
        webpage_url: "https://www.youtube.com/watch?v=oFg0ABdknrQ".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_ms: Some(257_499),
        duration_seconds: Some(257),
        chapters: vec![],
    };

    let group = collection_group(
        "C418 - Releases",
        "https://example.com/c418-releases",
        "youtube/C418 - Releases",
    );
    let musics = materialize_music_entries(&probe, "148/481772.m4a", group);

    assert_eq!(musics.len(), 1);
    assert_eq!(musics[0].end_ms, 257_499);
    assert_eq!(
        musics[0].canonical_music_id,
        canonical_music_id_for_source("https://www.youtube.com/watch?v=oFg0ABdknrQ", 0, 257_499)
    );
}

#[test]
fn completed_leaf_download_duration_evidence_overrides_probe_metadata() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let save_root = temp_test_dir();
        let mut collection = Collection {
            name: "C418 - Releases".to_string(),
            url: "https://example.com/c418-releases".to_string(),
            folder: "youtube/C418 - Releases".to_string(),
            musics: vec![],
            last_updated: "2026-05-31T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        };
        let collection_owner = collection_group(
            "C418 - Releases",
            "https://example.com/c418-releases",
            "youtube/C418 - Releases",
        );
        let mut task = DownloadTask::new(
            "task-duration-evidence",
            "https://www.youtube.com/watch?v=oFg0ABdknrQ",
            DownloadTrigger::Manual,
        );
        let leaf = DownloadLeaf::new(
            "leaf-duration-evidence",
            "https://www.youtube.com/watch?v=oFg0ABdknrQ",
            0,
        );
        task.replace_leaf(leaf.clone());
        let mut task = save_task(task).await.expect("task should save");

        let target_dir = save_root.join(&collection.folder);
        std::fs::create_dir_all(&target_dir).expect("target dir should be created");
        let downloaded_path = target_dir.join("481772.__slisic_tmp__duration.m4a");
        std::fs::write(&downloaded_path, b"audio").expect("temp file should exist");
        let probe = LeafProbe {
            title: "481772".to_string(),
            webpage_url: "https://www.youtube.com/watch?v=oFg0ABdknrQ".to_string(),
            extractor_key: Some("Youtube".to_string()),
            album: None,
            duration_ms: Some(257_000),
            duration_seconds: Some(257),
            chapters: vec![],
        };

        handle_finished_leaf_download(
            &mut task,
            &mut collection,
            CollectionSourceKind::Single,
            &save_root,
            Ok(CompletedLeafDownload {
                leaf,
                probe: probe.clone(),
                music_probe: probe,
                group: Some(collection_owner),
                downloaded: DownloadedLeaf {
                    absolute_path: downloaded_path,
                    duration_ms: Some(257_499),
                },
                progress: DownloadProgress::default(),
                retry_failures: 0,
            }),
        )
        .await
        .expect("downloaded duration evidence should persist");

        assert_eq!(collection.musics.len(), 1);
        assert_eq!(collection.musics[0].end_ms, 257_499);

        reset_db();
        let _ = std::fs::remove_dir_all(save_root);
    });
}

#[test]
fn completed_audio_duration_evidence_replaces_integer_metadata_boundary() {
    let mut probe = LeafProbe {
        title: "481772".to_string(),
        webpage_url: "https://www.youtube.com/watch?v=oFg0ABdknrQ".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_ms: Some(257_000),
        duration_seconds: Some(257),
        chapters: vec![],
    };

    apply_completed_audio_duration_evidence(&mut probe, 257_520);

    assert_eq!(probe.duration_ms, Some(257_520));
    assert_eq!(probe.duration_seconds, Some(258));
}

#[test]
fn completed_audio_duration_evidence_replaces_full_span_chapter_boundary() {
    let mut probe = LeafProbe {
        title: "What Now".to_string(),
        webpage_url: "https://www.youtube.com/watch?v=Gv1CBp5NABw".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: Some("Life Changing Moments Seem Minor in Pictures".to_string()),
        duration_ms: Some(344_437),
        duration_seconds: Some(345),
        chapters: vec![LeafChapter {
            title: "What Now".to_string(),
            start_ms: 0,
            end_ms: 344_437,
        }],
    };

    apply_completed_audio_duration_evidence(&mut probe, 344_455);

    assert_eq!(probe.duration_ms, Some(344_455));
    assert_eq!(probe.duration_seconds, Some(345));
    assert_eq!(probe.chapters[0].end_ms, 344_455);
}

#[test]
fn materialize_music_entries_uses_completed_duration_evidence_for_chapter_end() {
    let mut probe = LeafProbe {
        title: "What Now".to_string(),
        webpage_url: "https://www.youtube.com/watch?v=Gv1CBp5NABw".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: Some("Life Changing Moments Seem Minor in Pictures".to_string()),
        duration_ms: Some(344_437),
        duration_seconds: Some(345),
        chapters: vec![LeafChapter {
            title: "What Now".to_string(),
            start_ms: 0,
            end_ms: 344_437,
        }],
    };
    apply_completed_audio_duration_evidence(&mut probe, 344_455);

    let group = collection_group(
        "Life Changing Moments Seem Minor in Pictures",
        "https://example.com/album",
        "youtube/C418 - Releases/Life Changing Moments Seem Minor in Pictures",
    );
    let musics = materialize_music_entries(&probe, "Life Changing Moments/What Now.m4a", group);

    assert_eq!(musics.len(), 1);
    assert_eq!(musics[0].end_ms, 344_455);
    assert_eq!(
        musics[0].canonical_music_id,
        canonical_music_id_for_source("https://www.youtube.com/watch?v=Gv1CBp5NABw", 0, 344_455)
    );
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
    occurrence_id: String::new(),
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
                    loudness_profile: None,
                },
                Music {
    occurrence_id: String::new(),
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
                    loudness_profile: None,
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
            duration_ms: Some(10_000),
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
fn persist_downloaded_leaf_music_rejects_partial_download_paths() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let group = collection_group("Disc 1", "https://example.com/disc-1", "Disc 1");
        let mut collection = Collection {
            name: "Demo".to_string(),
            url: "https://example.com/root".to_string(),
            folder: "youtube/demo".to_string(),
            musics: vec![],
            last_updated: "2026-04-12T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        };
        let probe = LeafProbe {
            title: "Partial".to_string(),
            webpage_url: "https://example.com/watch?v=partial".to_string(),
            extractor_key: Some("Youtube".to_string()),
            album: None,
            duration_ms: Some(10_000),
            duration_seconds: Some(10),
            chapters: vec![],
        };

        let error = persist_downloaded_leaf_music(
            &mut collection,
            CollectionSourceKind::List,
            &probe,
            "Disc 1/Partial.m4a.part",
            group,
        )
        .await
        .expect_err("partial paths must not be materialized as Music");

        assert!(error.to_string().contains("still incomplete"));
        assert!(collection.musics.is_empty());

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
    occurrence_id: String::new(),
                name: "ZWEI2 - Disturbing Atmosphere".to_string(),
                alias: "ZWEI2 - Disturbing Atmosphere".to_string(),
                group: group.clone(),
                url: "https://example.com/watch?v=zwei2-1".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=zwei2-1".to_string(), 0, 180_000),
                path: Some("zwei2-1.m4a".to_string()),
                start_ms: 0,
                end_ms: 79_000,
                liked: false,
                loudness_profile: None,
            },
            Music {
    occurrence_id: String::new(),
                name: "ZWEI2 - Zahar's Ambition".to_string(),
                alias: "Pinned Alias".to_string(),
                group,
                url: "https://example.com/watch?v=zwei2-2".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=zwei2-2".to_string(), 0, 180_000),
                path: Some("zwei2-2.m4a".to_string()),
                start_ms: 0,
                end_ms: 152_000,
                liked: false,
                loudness_profile: None,
            },
            Music {
    occurrence_id: String::new(),
                name: "Ludvig Forssell - A Heartfelt Apology | Death Stranding 2 On The Beach Original Video Game Score".to_string(),
                alias: "Ludvig Forssell - A Heartfelt Apology | Death Stranding 2 On The Beach Original Video Game Score".to_string(),
                group: death_stranding_group.clone(),
                url: "https://example.com/watch?v=ds2-1".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=ds2-1".to_string(), 0, 180_000),
                path: Some("ds2-1.m4a".to_string()),
                start_ms: 0,
                end_ms: 213_000,
                liked: false,
                loudness_profile: None,
            },
            Music {
    occurrence_id: String::new(),
                name: "Ludvig Forssell - Drawbridge | Death Stranding 2 On The Beach Original Video Game Score".to_string(),
                alias: "Ludvig Forssell - Drawbridge | Death Stranding 2 On The Beach Original Video Game Score".to_string(),
                group: death_stranding_group,
                url: "https://example.com/watch?v=ds2-2".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=ds2-2".to_string(), 0, 180_000),
                path: Some("ds2-2.m4a".to_string()),
                start_ms: 0,
                end_ms: 180_000,
                liked: false,
                loudness_profile: None,
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
fn normalize_music_titles_keeps_multi_part_track_title_language_core() {
    let group = collection_group(
        "Death Stranding 2",
        "https://example.com/playlist/death-stranding-2",
        "Death Stranding 2",
    );
    let mut collection = Collection {
        name: "Death Stranding 2".to_string(),
        url: "https://example.com/playlist/death-stranding-2".to_string(),
        folder: "youtube/death-stranding-2".to_string(),
        musics: vec![
            Music {
    occurrence_id: String::new(),
                name: "Ludvig Forssell - One Last Fight Pt.1 - Death Stranding 2- On The Beach (Original Video Game Score)".to_string(),
                alias: "Ludvig Forssell - One Last Fight Pt.1 - Death Stranding 2- On The Beach (Original Video Game Score)".to_string(),
                group: group.clone(),
                url: "https://example.com/watch?v=ds2-fight-1".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=ds2-fight-1".to_string(), 0, 180_000),
                path: Some("Ludvig Forssell - One Last Fight Pt.1 - Death Stranding 2- On The Beach (Original Video Game Score).m4a".to_string()),
                start_ms: 0,
                end_ms: 180_000,
                liked: false,
                loudness_profile: None,
            },
            Music {
    occurrence_id: String::new(),
                name: "Ludvig Forssell - One Last Fight Pt.2 - Death Stranding 2- On The Beach (Original Video Game Score)".to_string(),
                alias: "Ludvig Forssell - One Last Fight Pt.2 - Death Stranding 2- On The Beach (Original Video Game Score)".to_string(),
                group: group.clone(),
                url: "https://example.com/watch?v=ds2-fight-2".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=ds2-fight-2".to_string(), 0, 180_000),
                path: Some("Ludvig Forssell - One Last Fight Pt.2 - Death Stranding 2- On The Beach (Original Video Game Score).m4a".to_string()),
                start_ms: 0,
                end_ms: 180_000,
                liked: false,
                loudness_profile: None,
            },
            Music {
    occurrence_id: String::new(),
                name: "Ludvig Forssell - One Last Fight Pt.3 - Death Stranding 2- On The Beach (Original Video Game Score)".to_string(),
                alias: "Ludvig Forssell - One Last Fight Pt.3 - Death Stranding 2- On The Beach (Original Video Game Score)".to_string(),
                group,
                url: "https://example.com/watch?v=ds2-fight-3".to_string(),
                canonical_music_id: canonical_music_id_for_source(&"https://example.com/watch?v=ds2-fight-3".to_string(), 0, 180_000),
                path: Some("Ludvig Forssell - One Last Fight Pt.3 - Death Stranding 2- On The Beach (Original Video Game Score).m4a".to_string()),
                start_ms: 0,
                end_ms: 180_000,
                liked: false,
                loudness_profile: None,
            },
        ],
        last_updated: "2026-04-12T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "One Last Fight Pt.1");
    assert_eq!(collection.musics[1].name, "One Last Fight Pt.2");
    assert_eq!(collection.musics[2].name, "One Last Fight Pt.3");
    assert_eq!(collection.musics[2].alias, "One Last Fight Pt.3");
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
    occurrence_id: String::new(),
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
                loudness_profile: None,
            },
            Music {
    occurrence_id: String::new(),
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
                loudness_profile: None,
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
fn normalize_music_titles_uses_file_name_evidence_without_renaming_paths() {
    let group = collection_group(
        "ZWEI2 Original Soundtrack",
        "https://example.com/playlist/zwei2",
        "ZWEI2 Original Soundtrack",
    );
    let mut collection = Collection {
        name: "ZWEI2 Original Soundtrack".to_string(),
        url: "https://example.com/playlist/zwei2".to_string(),
        folder: "youtube/zwei2".to_string(),
        musics: vec![
            Music {
    occurrence_id: String::new(),
                name: "Help Alwen".to_string(),
                alias: "Help Alwen".to_string(),
                group: group.clone(),
                url: "https://example.com/watch?v=zwei2-help".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/watch?v=zwei2-help".to_string(),
                    0,
                    137_000,
                ),
                path: Some("ZWEI2 - Help Alwen.m4a".to_string()),
                start_ms: 0,
                end_ms: 137_000,
                liked: false,
                loudness_profile: None,
            },
            Music {
    occurrence_id: String::new(),
                name: "ZWEI2 - Help Alwen −Rushing in Version−".to_string(),
                alias: "ZWEI2 - Help Alwen −Rushing in Version−".to_string(),
                group,
                url: "https://example.com/watch?v=zwei2-rushing".to_string(),
                canonical_music_id: canonical_music_id_for_source(
                    &"https://example.com/watch?v=zwei2-rushing".to_string(),
                    0,
                    136_000,
                ),
                path: Some("ZWEI2 - Help Alwen −Rushing in Version−.m4a".to_string()),
                start_ms: 0,
                end_ms: 136_000,
                liked: false,
                loudness_profile: None,
            },
        ],
        last_updated: "2026-05-26T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "Help Alwen");
    assert_eq!(
        collection.musics[0].path.as_deref(),
        Some("ZWEI2 - Help Alwen.m4a")
    );
    assert_eq!(collection.musics[1].name, "Help Alwen −Rushing in Version−");
    assert_eq!(
        collection.musics[1].alias,
        "Help Alwen −Rushing in Version−"
    );
    assert_eq!(
        collection.musics[1].path.as_deref(),
        Some("ZWEI2 - Help Alwen −Rushing in Version−.m4a")
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
        collection: CollectionGroupOwner {
            name: "Test Collection".to_string(),
            url: "https://example.com/test-collection".to_string(),
            folder: "youtube/test-collection".to_string(),
            last_updated: "2026-05-27T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        },
        folder: folder.to_string(),
    }
}

fn expansion_owner() -> Collection {
    Collection {
        name: "Expansion Owner".to_string(),
        url: "https://example.com/expansion-owner".to_string(),
        folder: "youtube/expansion-owner".to_string(),
        musics: vec![],
        last_updated: "2026-05-27T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    }
}

fn planned_music_titles_from_playlist_titles(titles: &[String]) -> Vec<String> {
    run_async(async {
        let collection = expansion_owner();
        expand_root_entries_to_planned_leafs(
            &Id::from("task-bracket-title-normalization"),
            Arc::new(FakeYtDlpClient::default()),
            titles
                .iter()
                .enumerate()
                .map(|(index, title)| LeafReference {
                    url: format!("https://www.youtube.com/watch?v=bracket-{index}"),
                    title: Some(title.clone()),
                    sequence: index as u32,
                })
                .collect(),
            &collection,
            Some(collection_group(
                "Bracket Album",
                "https://example.com/playlist/bracket-album",
                "Bracket Album",
            )),
        )
        .await
        .expect("playlist titles should normalize without leaf probing")
        .into_iter()
        .map(|leaf| leaf.music_title.expect("leaf should preserve a title"))
        .collect()
    })
}

fn bracket_pair_cases() -> [(char, char); 4] {
    [('(', ')'), ('[', ']'), ('{', '}'), ('<', '>')]
}

fn leaf_probe(title: &str, url: &str, duration_seconds: u32) -> LeafProbe {
    LeafProbe {
        title: title.to_string(),
        webpage_url: url.to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_ms: Some(duration_seconds.saturating_mul(1_000)),
        duration_seconds: Some(duration_seconds),
        chapters: vec![],
    }
}

#[derive(Debug, Default)]
struct FakeYtDlpClient {
    roots: HashMap<String, RootProbe>,
    shells: HashMap<String, RootShellProbe>,
}

impl FakeYtDlpClient {
    fn with_roots(roots: HashMap<String, RootProbe>) -> Self {
        Self {
            roots,
            shells: HashMap::new(),
        }
    }

    fn with_shells(shells: HashMap<String, RootShellProbe>) -> Self {
        Self {
            roots: HashMap::new(),
            shells,
        }
    }
}

impl YtDlpClient for FakeYtDlpClient {
    fn probe_root_shell(&self, url: &str) -> Result<RootShellProbe> {
        self.shells
            .get(url)
            .cloned()
            .ok_or_else(|| anyhow!("missing fake root shell probe for {url}"))
    }

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

#[derive(Debug)]
struct CountingRootProbeClient {
    root: RootProbe,
    active: AtomicUsize,
    max_active: AtomicUsize,
    calls: Mutex<Vec<String>>,
}

impl CountingRootProbeClient {
    fn new(root: RootProbe) -> Self {
        Self {
            root,
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl YtDlpClient for CountingRootProbeClient {
    fn probe_root_shell(&self, url: &str) -> Result<RootShellProbe> {
        Err(anyhow!(
            "unexpected counting probe_root_shell call for {url}"
        ))
    }

    fn probe_root(&self, url: &str) -> Result<RootProbe> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(20));
        self.calls
            .lock()
            .expect("root probe calls should not poison")
            .push(url.to_string());
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(self.root.clone())
    }

    fn probe_leaf(&self, url: &str) -> Result<LeafProbe> {
        Err(anyhow!("unexpected counting probe_leaf call for {url}"))
    }

    fn download_leaf_audio(
        &self,
        url: &str,
        _target_dir: &Path,
        _file_stem: &str,
        _on_progress: &mut dyn FnMut(DownloadProgress),
    ) -> Result<DownloadedLeaf> {
        Err(anyhow!("unexpected counting download call for {url}"))
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
fn resolve_pasted_download_url_rejects_multiple_urls_in_one_paste() {
    let resolution = run_async(resolve_pasted_download_url(
        "https://example.com/first https://example.com/second".to_string(),
    ))
    .expect("multi-url pasted text should resolve into a candidate error");

    assert_eq!(
        resolution.status,
        PastedDownloadUrlResolutionStatus::InvalidUrl
    );
    assert_eq!(
        resolution.error.as_deref(),
        Some("Clipboard must contain exactly one URL.")
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
fn resolve_pasted_download_url_accepts_youtube_handle_tab_urls() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let resolution =
            resolve_pasted_download_url("https://www.youtube.com/@C418/releases".to_string())
                .await
                .expect("youtube handle tab url should resolve");

        assert_eq!(resolution.status, PastedDownloadUrlResolutionStatus::NewUrl);
        assert_eq!(
            resolution.url.as_deref(),
            Some("https://www.youtube.com/@C418/releases")
        );
        assert!(resolution.error.is_none());
        assert!(resolution.collection.is_none());

        reset_db();
    });
}

#[test]
fn resolve_pasted_download_url_canonicalizes_youtube_watch_playlist_item_as_single_video() {
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
            Some("https://www.youtube.com/watch?v=abc123")
        );

        reset_db();
    });
}

#[test]
fn resolve_pasted_download_url_keeps_youtube_watch_playlist_without_index_as_playlist() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let resolution = resolve_pasted_download_url(
            "https://www.youtube.com/watch?v=abc123&list=PLtenet".to_string(),
        )
        .await
        .expect("watch playlist url without index should resolve");

        assert_eq!(resolution.status, PastedDownloadUrlResolutionStatus::NewUrl);
        assert_eq!(
            resolution.url.as_deref(),
            Some("https://www.youtube.com/playlist?list=PLtenet")
        );

        reset_db();
    });
}

#[test]
fn resolve_pasted_download_url_canonicalizes_youtube_watch_context_params_as_single_video() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        for url in [
            "https://www.youtube.com/watch?v=abc123&index=14",
            "https://www.youtube.com/watch?v=abc123&t=3238s",
        ] {
            let resolution = resolve_pasted_download_url(url.to_string())
                .await
                .expect("watch url context params should resolve");

            assert_eq!(resolution.status, PastedDownloadUrlResolutionStatus::NewUrl);
            assert_eq!(
                resolution.url.as_deref(),
                Some("https://www.youtube.com/watch?v=abc123")
            );
        }

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
    occurrence_id: String::new(),
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
                loudness_profile: None,
            },
            Music {
    occurrence_id: String::new(),
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
                loudness_profile: None,
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
    occurrence_id: String::new(),
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
            loudness_profile: None,
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
fn existing_planned_leaf_completions_match_manifest_identity_with_group_context() {
    let root = temp_test_dir();
    let folder = "youtube/demo";
    let first_group = collection_group("First", "https://example.com/first", "First");
    let second_group = collection_group("Second", "https://example.com/second", "Second");
    std::fs::create_dir_all(root.join(folder).join(&second_group.folder))
        .expect("second group dir should be created");
    std::fs::write(
        root.join(folder)
            .join(&second_group.folder)
            .join("Shared Track.m4a"),
        b"audio",
    )
    .expect("existing audio file should be created");

    let collection = Collection {
        name: "Demo".to_string(),
        url: "https://example.com/root".to_string(),
        folder: folder.to_string(),
        musics: vec![Music {
    occurrence_id: String::new(),
            name: "Shared Track".to_string(),
            alias: "Shared Track".to_string(),
            group: second_group.clone(),
            canonical_music_id: canonical_music_id_for_source(
                "https://example.com/watch?v=same",
                0,
                120_000,
            ),
            url: "https://example.com/watch?v=same".to_string(),
            path: Some("Second/Shared Track.m4a".to_string()),
            start_ms: 0,
            end_ms: 120_000,
            liked: false,
            loudness_profile: None,
        }],
        last_updated: "2026-05-27T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };
    let plan = CollectionSyncPlan {
        source_kind: CollectionSourceKind::List,
        collection_name: collection.name.clone(),
        collection_url: collection.url.clone(),
        collection_folder: collection.folder.clone(),
        enable_updates: Some(false),
        leaves: vec![
            PlannedLeaf {
                id: Id::from("leaf-first"),
                url: "https://example.com/watch?v=same".to_string(),
                sequence: 0,
                initial_probe: None,
                music_title: Some("Shared Track".to_string()),
                group_hint: Some(first_group),
            },
            PlannedLeaf {
                id: Id::from("leaf-second"),
                url: "https://example.com/watch?v=same".to_string(),
                sequence: 1,
                initial_probe: None,
                music_title: Some("Shared Track".to_string()),
                group_hint: Some(second_group),
            },
        ],
    };

    let completions = existing_planned_leaf_completions(&collection, &plan, &root);

    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].leaf_id.to_string(), "leaf-second");
    assert_eq!(
        completions[0].relative_path,
        "Second/Shared Track.m4a".to_string()
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn discard_materialized_planned_leaves_consumes_existing_evidence_before_scheduling() {
    let mut task = DownloadTask::new(
        "task-existing-evidence",
        "https://example.com/root",
        DownloadTrigger::Manual,
    );
    task.replace_leaf(DownloadLeaf::new(
        "leaf-existing",
        "https://example.com/watch?v=existing",
        0,
    ));

    discard_materialized_planned_leaves(
        &mut task,
        vec![ExistingPlannedLeafCompletion {
            leaf_id: Id::from("leaf-existing"),
            title: Some("Existing Track".to_string()),
            relative_path: "Album/Existing Track.m4a".to_string(),
            duration_seconds: Some(180),
            chapter_count: Some(1),
        }],
    );

    assert_eq!(task.completed_leaves, 1);
    assert!(task.leafs.is_empty());
}

#[test]
fn discard_materialized_planned_leaves_consumes_existing_evidence_once() {
    let mut task = DownloadTask::new(
        "task-existing-evidence-once",
        "https://example.com/root",
        DownloadTrigger::Manual,
    );
    task.replace_leaf(DownloadLeaf::new(
        "leaf-existing",
        "https://example.com/watch?v=existing",
        0,
    ));

    discard_materialized_planned_leaves(
        &mut task,
        vec![
            ExistingPlannedLeafCompletion {
                leaf_id: Id::from("leaf-existing"),
                title: Some("Existing Track".to_string()),
                relative_path: "Album/Existing Track.m4a".to_string(),
                duration_seconds: Some(180),
                chapter_count: Some(1),
            },
            ExistingPlannedLeafCompletion {
                leaf_id: Id::from("leaf-existing"),
                title: Some("Existing Track".to_string()),
                relative_path: "Album/Existing Track.m4a".to_string(),
                duration_seconds: Some(180),
                chapter_count: Some(1),
            },
        ],
    );

    assert_eq!(task.completed_leaves, 1);
    assert!(task.leafs.is_empty());
}

#[test]
fn residual_collection_plan_rebuilds_resume_plan_without_root_probe() {
    let mut task = DownloadTask::new(
        "task-residual-plan",
        "https://example.com/root",
        DownloadTrigger::Manual,
    );
    task.collection_url = Some("https://example.com/root".to_string());
    task.collection_name = Some("Residual Root".to_string());
    task.collection_folder = Some("youtube/residual-root".to_string());
    task.source_kind = Some(CollectionSourceKind::List);

    let group = collection_group("Album", "https://example.com/album", "Album");
    let mut leaf = DownloadLeaf::new("leaf-residual", "https://example.com/watch?v=residual", 7);
    leaf.title = Some("Residual Track".to_string());
    leaf.group = Some(group.clone().into());
    task.replace_leaf(leaf);

    let plan = residual_collection_plan(&task).expect("residual task should rebuild a plan");

    assert_eq!(plan.collection_name, "Residual Root");
    assert_eq!(plan.collection_folder, "youtube/residual-root");
    assert_eq!(plan.leaves.len(), 1);
    assert_eq!(plan.leaves[0].id.to_string(), "leaf-residual");
    assert_eq!(
        plan.leaves[0].music_title.as_deref(),
        Some("Residual Track")
    );
    let group_hint = plan.leaves[0]
        .group_hint
        .as_ref()
        .expect("residual leaf should preserve group context");
    assert_eq!(group_hint.name, group.name);
    assert_eq!(group_hint.folder, group.folder);
    assert_eq!(group_hint.url, group.url);
}

#[test]
fn resolve_collection_plan_prefers_residual_leafs_without_root_probe() {
    let mut task = DownloadTask::new(
        "task-residual-no-probe",
        "https://example.com/root",
        DownloadTrigger::Manual,
    );
    task.collection_url = Some("https://example.com/root".to_string());
    task.collection_name = Some("Residual Root".to_string());
    task.collection_folder = Some("youtube/residual-root".to_string());
    task.source_kind = Some(CollectionSourceKind::List);
    task.replace_leaf(DownloadLeaf::new(
        "leaf-residual",
        "https://example.com/watch?v=residual",
        0,
    ));

    let plan = run_async(resolve_collection_plan(
        &task,
        Arc::new(FakeYtDlpClient::default()),
    ))
    .expect("residual task should not need a fake root probe");

    assert_eq!(plan.leaves.len(), 1);
    assert_eq!(plan.leaves[0].id.to_string(), "leaf-residual");
}

#[test]
fn resolve_collection_plan_rejects_empty_lists() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://example.com/empty-list";
        let task = DownloadTask::new("task-empty-list", url, DownloadTrigger::Manual);
        let client = Arc::new(FakeYtDlpClient::with_roots(HashMap::from([(
            url.to_string(),
            RootProbe::List(PlaylistRoot {
                title: "Empty List".to_string(),
                webpage_url: url.to_string(),
                extractor_key: Some("Generic".to_string()),
                entries: vec![],
            }),
        )])));

        let error = resolve_collection_plan(&task, client)
            .await
            .expect_err("empty provider lists should not become completed collections");

        assert!(
            error
                .to_string()
                .contains("download resource does not contain any downloadable entries")
        );

        reset_db();
    });
}

#[test]
fn collection_plan_for_youtube_watch_url_uses_probe_title_not_url_fallback_identity() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://www.youtube.com/watch?v=nnvjKf_mRYM";
        let task = DownloadTask::new("task-youtube-title", url, DownloadTrigger::Manual);
        let client = Arc::new(FakeYtDlpClient::with_roots(HashMap::from([(
            url.to_string(),
            RootProbe::Single(LeafProbe {
                title:
                    "[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan"
                        .to_string(),
                webpage_url: url.to_string(),
                extractor_key: Some("Youtube".to_string()),
                album: None,
                duration_ms: Some(7_200_000),
                duration_seconds: Some(7_200),
                chapters: vec![],
            }),
        )])));

        let plan = resolve_collection_plan(&task, client)
            .await
            .expect("probe title should define the collection identity");

        assert_eq!(
            plan.collection_name,
            "[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan"
        );
        assert_eq!(
            plan.collection_folder,
            "youtube/[Official] TUNIC (Original Soundtrack) - Full Album - Lifeformed × Janice Kwan"
        );
        assert_ne!(plan.collection_name, "YouTube video nnvjKf_mRYM");
        assert_ne!(plan.collection_folder, "youtube/YouTube video nnvjKf_mRYM");

        reset_db();
    });
}

#[test]
fn resolve_collection_plan_can_consume_manual_enqueue_root_probe_once() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let root_url = "https://example.com/root";
        let nested_url = "https://example.com/album";
        let task = DownloadTask::new("task-root-probe-carry", root_url, DownloadTrigger::Manual);
        let carried_root = RootProbe::List(PlaylistRoot {
            title: "Root".to_string(),
            webpage_url: root_url.to_string(),
            extractor_key: Some("Generic".to_string()),
            entries: vec![LeafReference {
                url: nested_url.to_string(),
                title: Some("Album".to_string()),
                sequence: 0,
            }],
        });
        let client = Arc::new(FakeYtDlpClient::with_roots(HashMap::from([(
            nested_url.to_string(),
            RootProbe::List(PlaylistRoot {
                title: "Album".to_string(),
                webpage_url: nested_url.to_string(),
                extractor_key: Some("Generic".to_string()),
                entries: vec![LeafReference {
                    url: "https://www.youtube.com/watch?v=leaf".to_string(),
                    title: Some("Leaf".to_string()),
                    sequence: 0,
                }],
            }),
        )])));

        let plan = resolve_collection_plan_with_root_probe(&task, client, Some(carried_root))
            .await
            .expect("carried root probe should avoid probing the root url again");

        assert_eq!(plan.collection_name, "Root");
        assert_eq!(plan.leaves.len(), 1);
        assert_eq!(plan.leaves[0].url, "https://www.youtube.com/watch?v=leaf");

        reset_db();
    });
}

#[test]
fn resolve_collection_plan_reuses_existing_collection_when_probe_title_already_exists() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let existing = Collection {
            name: "Shared Video".to_string(),
            url: "https://www.youtube.com/watch?v=canonical".to_string(),
            folder: "youtube/Shared Video".to_string(),
            musics: vec![],
            last_updated: "2026-04-24T00:00:00+00:00".to_string(),
            enable_updates: None,
        };
        upsert_collection(&existing)
            .await
            .expect("existing collection should be saved");

        let alias_url = "https://example.com/shared-video-alias";
        let task = DownloadTask::new("task-title-duplicate", alias_url, DownloadTrigger::Manual);
        let client = Arc::new(FakeYtDlpClient::with_roots(HashMap::from([(
            alias_url.to_string(),
            RootProbe::Single(leaf_probe("Shared Video", alias_url, 120)),
        )])));

        let plan = resolve_collection_plan(&task, client)
            .await
            .expect("title duplicate should resolve through the existing collection");

        assert_eq!(plan.collection_url, existing.url);
        assert_eq!(plan.collection_folder, existing.folder);
        assert_eq!(plan.leaves.len(), 1);
        assert_eq!(plan.leaves[0].url, existing.url);

        reset_db();
    });
}

#[test]
fn probe_root_with_limit_bounds_parallel_provider_processes() {
    run_async(async {
        let worker_count = root_probe_parallelism() + 3;
        let client = Arc::new(CountingRootProbeClient::new(RootProbe::List(
            PlaylistRoot {
                title: "Limited Root".to_string(),
                webpage_url: "https://example.com/limited-root".to_string(),
                extractor_key: Some("Generic".to_string()),
                entries: vec![LeafReference {
                    url: "https://example.com/watch?v=limited".to_string(),
                    title: Some("Limited Leaf".to_string()),
                    sequence: 0,
                }],
            },
        )));
        let start = Arc::new(Barrier::new(worker_count));

        let handles = (0..worker_count)
            .map(|index| {
                let client = Arc::clone(&client);
                let start = Arc::clone(&start);
                tokio::spawn(async move {
                    start.wait();
                    probe_root_with_limit(client, format!("https://example.com/root-{index}")).await
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle
                .await
                .expect("root probe task should join")
                .expect("root probe should finish");
        }

        assert_eq!(
            client
                .calls
                .lock()
                .expect("root probe calls should not poison")
                .len(),
            worker_count
        );
        assert!(client.max_active.load(Ordering::SeqCst) <= root_probe_parallelism());
    });
}

#[test]
fn completed_leaf_replace_removes_leaf_from_task_but_keeps_progress_count() {
    let mut task = DownloadTask::new(
        "task-completed-consume",
        "https://example.com/root",
        DownloadTrigger::Manual,
    );
    let mut leaf = DownloadLeaf::new("leaf-done", "https://example.com/watch?v=done", 0);
    task.replace_leaf(leaf.clone());

    leaf.status = DownloadLeafStatus::Completed;
    task.replace_leaf(leaf);

    assert!(task.leafs.is_empty());
    assert_eq!(task.completed_leaves, 1);
}

#[test]
fn materialize_music_entries_preserves_group_and_nested_relative_path() {
    let probe = LeafProbe {
        title: "Album".to_string(),
        webpage_url: "https://example.com/video".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_ms: Some(180_000),
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
        collection: CollectionGroupOwner {
            name: "Compilation Owner".to_string(),
            url: "https://example.com/compilation-owner".to_string(),
            folder: "youtube/compilation-owner".to_string(),
            last_updated: "2026-05-27T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        },
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
fn residual_temp_resolution_recovers_matching_temporary_audio() {
    let root = temp_test_dir();
    std::fs::create_dir_all(&root).expect("temp dir should be created");
    let expected = root.join("Track.__slisic_tmp__abc123.m4a");
    std::fs::write(&expected, b"downloaded").expect("temp audio should be created");
    std::fs::write(root.join("Track.__slisic_tmp__other.m4a"), b"other")
        .expect("other temp audio should be created");

    let resolution = resolve_residual_temp_downloaded_file(&root, "Track.__slisic_tmp__abc123");

    assert!(matches!(
        resolution,
        super::service::ResidualTempFileResolution::Ready(ref path) if path == &expected
    ));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn residual_temp_resolution_rejects_partial_download_fragments() {
    let root = temp_test_dir();
    std::fs::create_dir_all(&root).expect("temp dir should be created");
    std::fs::write(root.join("Track.__slisic_tmp__abc123.m4a.part"), b"partial")
        .expect("partial temp file should be created");

    let resolution = resolve_residual_temp_downloaded_file(&root, "Track.__slisic_tmp__abc123");

    assert!(matches!(
        resolution,
        super::service::ResidualTempFileResolution::Missing
    ));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn residual_temp_file_completion_moves_file_and_persists_music_once() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;
        let save_root = temp_test_dir();
        let collection_folder = "youtube/Recovered Temp".to_string();
        let target_dir = save_root.join(&collection_folder);
        std::fs::create_dir_all(&target_dir).expect("target dir should be created");
        let downloaded_path = target_dir.join("Recovered Track.__slisic_tmp__abc123.m4a");
        std::fs::write(&downloaded_path, b"audio").expect("temp audio should exist");

        let collection_owner = collection_group(
            "Recovered Temp",
            "https://example.com/playlist",
            &collection_folder,
        );
        let mut collection = Collection {
            name: "Recovered Temp".to_string(),
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
            "task-residual-temp",
            "https://example.com/playlist",
            DownloadTrigger::Manual,
        );
        task.collection_url = Some(collection.url.clone());
        task.collection_name = Some(collection.name.clone());
        task.collection_folder = Some(collection.folder.clone());
        task.source_kind = Some(CollectionSourceKind::List);
        task.status = DownloadTaskStatus::Downloading;
        let mut leaf = DownloadLeaf::new("leaf-a", "https://example.com/watch?v=a", 0);
        leaf.status = DownloadLeafStatus::Downloading;
        task.replace_leaf(leaf.clone());
        let mut task = save_task(task).await.expect("task should save");

        let probe = leaf_probe("Recovered Track", "https://example.com/watch?v=a", 60);
        handle_finished_leaf_download(
            &mut task,
            &mut collection,
            CollectionSourceKind::List,
            &save_root,
            Ok(CompletedLeafDownload {
                leaf,
                probe: probe.clone(),
                music_probe: probe,
                group: Some(collection_owner),
                downloaded: DownloadedLeaf {
                    absolute_path: downloaded_path.clone(),
                    duration_ms: None,
                },
                progress: DownloadProgress::default(),
                retry_failures: 0,
            }),
        )
        .await
        .expect("residual temp file should complete through normal leaf commit");

        assert!(!downloaded_path.exists());
        assert!(target_dir.join("Recovered Track.m4a").is_file());
        assert_eq!(task.completed_leaves, 1);
        assert_eq!(task.failed_leaves, 0);
        assert!(task.leafs.is_empty());
        assert_eq!(collection.musics.len(), 1);
        assert_eq!(
            collection.musics[0].path.as_deref(),
            Some("Recovered Track.m4a")
        );

        reset_db();
        let _ = std::fs::remove_dir_all(save_root);
    });
}

#[test]
fn residual_temp_resolution_recovers_unique_same_title_artifact_after_task_identity_changes() {
    let root = temp_test_dir();
    std::fs::create_dir_all(&root).expect("temp dir should be created");
    let expected = root.join("Track.__slisic_tmp__oldtask.m4a");
    std::fs::write(&expected, b"downloaded").expect("residual temp audio should be created");
    std::fs::write(root.join("Other.__slisic_tmp__oldtask.m4a"), b"other")
        .expect("unrelated temp audio should be created");

    let resolution = resolve_residual_temp_downloaded_file(&root, "Track.__slisic_tmp__newtask");

    assert!(matches!(
        resolution,
        super::service::ResidualTempFileResolution::Ready(ref path) if path == &expected
    ));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn residual_temp_resolution_rejects_ambiguous_same_title_artifacts() {
    let root = temp_test_dir();
    std::fs::create_dir_all(&root).expect("temp dir should be created");
    std::fs::write(root.join("Track.__slisic_tmp__first.m4a"), b"first")
        .expect("first temp audio should be created");
    std::fs::write(root.join("Track.__slisic_tmp__second.m4a"), b"second")
        .expect("second temp audio should be created");

    let resolution = resolve_residual_temp_downloaded_file(&root, "Track.__slisic_tmp__newtask");

    assert!(matches!(
        resolution,
        super::service::ResidualTempFileResolution::Ambiguous(ref paths) if paths.len() == 2
    ));

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

        let alias = "https://www.youtube.com/watch?v=ZE5zXLOyEOQ&t=3238s";
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
fn accept_collection_download_returns_task_evidence_without_collection_probe() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let accepted = accept_collection_download_for_test(
            "https://www.youtube.com/playlist?list=PLeqAWggBv41bmmAvAdBT18V6cZ90frMXP".to_string(),
            DownloadTrigger::Manual,
        )
        .await
        .expect("new playlist url should be accepted as a task");
        let tasks = list_tasks().await.expect("task listing should succeed");

        assert!(accepted.collection.is_none());
        assert_eq!(accepted.task.status, DownloadTaskStatus::Queued);
        assert_eq!(accepted.task.collection_url, None);
        assert_eq!(accepted.task.total_leaves, 0);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, accepted.task.id);
        assert_eq!(tasks[0].collection_url, None);

        reset_db();
    });
}

#[test]
fn persist_download_collection_shell_from_task_accepts_root_title_evidence() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://www.youtube.com/watch?v=nnvjKf_mRYM";
        let mut task = DownloadTask::new("task-shell-persist", url, DownloadTrigger::Manual);
        task.collection_url = Some(url.to_string());
        task.collection_name = Some(
            "[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan"
                .to_string(),
        );
        task.collection_folder = Some("youtube/tunic-soundtrack".to_string());
        task.source_kind = Some(CollectionSourceKind::Single);

        let collection = persist_download_collection_shell_from_task(&task)
            .await
            .expect("root title evidence should persist as a shell")
            .expect("complete root title evidence should create a collection shell");
        let loaded = crate::domain::collection_import::get_collection_by_url(url)
            .await
            .expect("collection lookup should succeed")
            .expect("persisted shell should be addressable by url");

        assert_eq!(
            collection.name,
            "[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan"
        );
        assert_eq!(collection.url, url);
        assert_eq!(collection.folder, "youtube/tunic-soundtrack");
        assert_eq!(collection.enable_updates, None);
        assert!(collection.musics.is_empty());
        assert_eq!(loaded.url, collection.url);
        assert_eq!(loaded.name, collection.name);

        reset_db();
    });
}

#[test]
fn accepted_root_shell_download_returns_collection_evidence_for_draft_commit() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://www.youtube.com/watch?v=nnvjKf_mRYM";
        let client = Arc::new(FakeYtDlpClient::with_shells(HashMap::from([(
            url.to_string(),
            RootShellProbe {
                source_kind: CollectionSourceKind::Single,
                title:
                    "[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan"
                        .to_string(),
                webpage_url: url.to_string(),
                extractor_key: Some("Youtube".to_string()),
            },
        )])));

        let accepted = accept_collection_download_with_root_shell_for_test(
            url.to_string(),
            DownloadTrigger::Manual,
            client,
        )
        .await
        .expect("accepted root shell should return collection evidence");
        let collection = accepted
            .collection
            .expect("root shell evidence should be a committable collection shell");

        assert_eq!(accepted.task.collection_url.as_deref(), Some(url));
        assert_eq!(
            accepted.task.collection_name.as_deref(),
            Some("[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan")
        );
        assert_eq!(
            collection.name,
            "[Official] TUNIC (Original Soundtrack) - Full Album / Lifeformed × Janice Kwan"
        );
        assert_eq!(collection.url, url);
        assert!(collection.musics.is_empty());

        reset_db();
    });
}

#[test]
fn probe_download_root_title_returns_prepared_collection_shell_evidence() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://www.youtube.com/playlist?list=PLtitle";
        let client = Arc::new(FakeYtDlpClient::with_shells(HashMap::from([(
            url.to_string(),
            RootShellProbe {
                source_kind: CollectionSourceKind::List,
                title: "Root Title Only".to_string(),
                webpage_url: url.to_string(),
                extractor_key: Some("YoutubeTab".to_string()),
            },
        )])));

        let evidence = probe_download_root_title_with_client(url.to_string(), client, None)
            .await
            .expect("root title evidence should resolve");
        let tasks = list_tasks().await.expect("task listing should succeed");
        let collection = crate::domain::collection_import::get_collection_by_url(url)
            .await
            .expect("collection lookup should succeed")
            .expect("title evidence should prepare a committable collection shell");

        assert_eq!(evidence.url, url);
        assert_eq!(evidence.title, "Root Title Only");
        assert_eq!(evidence.folder, "youtube/Root Title Only");
        assert_eq!(evidence.enable_updates, Some(false));
        assert_eq!(evidence.source_kind, CollectionSourceKind::List);
        assert!(tasks.is_empty());
        assert_eq!(evidence.collection.url, url);
        assert_eq!(evidence.collection.name, "Root Title Only");
        assert_eq!(evidence.collection.folder, "youtube/Root Title Only");
        assert_eq!(evidence.collection.enable_updates, Some(false));
        assert!(evidence.collection.musics.is_empty());
        assert_eq!(collection.url, evidence.collection.url);

        reset_db();
    });
}

#[test]
fn probe_download_root_title_reuses_existing_collection_when_probe_title_already_exists() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let existing = Collection {
            name: "Shared Root".to_string(),
            url: "https://www.youtube.com/playlist?list=PLcanonical".to_string(),
            folder: "youtube/shared-root".to_string(),
            musics: vec![],
            last_updated: "2026-04-24T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        };
        upsert_collection(&existing)
            .await
            .expect("existing collection should be saved");

        let alias_url = "https://www.youtube.com/playlist?list=PLalias";
        let client = Arc::new(FakeYtDlpClient::with_shells(HashMap::from([(
            alias_url.to_string(),
            RootShellProbe {
                source_kind: CollectionSourceKind::List,
                title: existing.name.clone(),
                webpage_url: alias_url.to_string(),
                extractor_key: Some("YoutubeTab".to_string()),
            },
        )])));

        let evidence = probe_download_root_title_with_client(alias_url.to_string(), client, None)
            .await
            .expect("root title evidence should reuse existing collection identity");
        let canonical = crate::domain::collection_import::get_collection_by_url(&existing.url)
            .await
            .expect("canonical collection lookup should succeed")
            .expect("canonical collection should remain persisted");
        let alias = crate::domain::collection_import::get_collection_by_url(alias_url)
            .await
            .expect("alias collection lookup should succeed");

        assert_eq!(evidence.url, existing.url);
        assert_eq!(evidence.title, existing.name);
        assert_eq!(evidence.folder, existing.folder);
        assert_eq!(evidence.collection.url, existing.url);
        assert_eq!(evidence.collection.folder, existing.folder);
        assert_eq!(canonical.url, existing.url);
        assert!(alias.is_none());

        reset_db();
    });
}

#[test]
fn probe_download_root_title_attaches_scope_to_existing_active_task() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://www.youtube.com/playlist?list=PLtitle";
        let accepted = prepare_task_enqueue(url.to_string(), DownloadTrigger::Manual)
            .await
            .expect("download task should be accepted before title evidence");
        assert_eq!(accepted.collection_url, None);

        let client = Arc::new(FakeYtDlpClient::with_shells(HashMap::from([(
            url.to_string(),
            RootShellProbe {
                source_kind: CollectionSourceKind::List,
                title: "Root Title Only".to_string(),
                webpage_url: url.to_string(),
                extractor_key: Some("YoutubeTab".to_string()),
            },
        )])));

        probe_download_root_title_with_client(url.to_string(), client, None)
            .await
            .expect("root title evidence should resolve");

        let tasks = list_tasks().await.expect("task listing should succeed");
        let task = tasks
            .iter()
            .find(|task| task.id == accepted.id)
            .expect("original task should remain active");
        assert_eq!(task.collection_url.as_deref(), Some(url));
        assert_eq!(task.collection_name.as_deref(), Some("Root Title Only"));
        assert_eq!(
            task.collection_folder.as_deref(),
            Some("youtube/Root Title Only")
        );
        assert_eq!(task.source_kind, Some(CollectionSourceKind::List));
        assert_eq!(task.status, DownloadTaskStatus::Queued);
        assert!(task.leafs.is_empty());

        reset_db();
    });
}

#[test]
fn prepare_task_enqueue_uses_prepared_shell_as_pending_playback_scope() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://www.youtube.com/playlist?list=PLtitle";
        let client = Arc::new(FakeYtDlpClient::with_shells(HashMap::from([(
            url.to_string(),
            RootShellProbe {
                source_kind: CollectionSourceKind::List,
                title: "Root Title Only".to_string(),
                webpage_url: url.to_string(),
                extractor_key: Some("YoutubeTab".to_string()),
            },
        )])));

        probe_download_root_title_with_client(url.to_string(), client, None)
            .await
            .expect("root title evidence should prepare the collection shell");

        let task = prepare_task_enqueue(url.to_string(), DownloadTrigger::Manual)
            .await
            .expect("download task should reuse prepared shell scope");
        let tasks = list_tasks().await.expect("task listing should succeed");

        assert_eq!(task.collection_url.as_deref(), Some(url));
        assert_eq!(task.collection_name.as_deref(), Some("Root Title Only"));
        assert_eq!(
            task.collection_folder.as_deref(),
            Some("youtube/Root Title Only")
        );
        assert_eq!(task.source_kind, Some(CollectionSourceKind::List));
        assert_eq!(task.status, DownloadTaskStatus::Queued);
        assert!(task.leafs.is_empty());
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].collection_url.as_deref(), Some(url));

        reset_db();
    });
}

#[test]
fn attach_root_shell_to_task_publishes_title_without_expanding_playlist_entries() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let url = "https://www.youtube.com/@Epicmountainmusic/playlists";
        let task = save_task(DownloadTask::new(
            "task-shell",
            url,
            DownloadTrigger::Manual,
        ))
        .await
        .expect("task should save before shell attachment");
        let client = Arc::new(FakeYtDlpClient::with_shells(HashMap::from([(
            url.to_string(),
            RootShellProbe {
                source_kind: CollectionSourceKind::List,
                title: "Epic Mountain Music - Playlists".to_string(),
                webpage_url: url.to_string(),
                extractor_key: Some("YoutubeTab".to_string()),
            },
        )])));

        let attached = attach_root_shell_to_task(task, client)
            .await
            .expect("root shell should attach to task");
        let tasks = list_tasks().await.expect("task listing should succeed");
        let collection = crate::domain::collection_import::get_collection_by_url(url)
            .await
            .expect("collection lookup should succeed");

        assert_eq!(
            attached.collection_name.as_deref(),
            Some("Epic Mountain Music - Playlists")
        );
        assert_eq!(attached.collection_url.as_deref(), Some(url));
        assert_eq!(attached.source_kind, Some(CollectionSourceKind::List));
        assert_eq!(attached.status, DownloadTaskStatus::Queued);
        assert_eq!(attached.total_leaves, 0);
        assert!(attached.leafs.is_empty());
        assert_eq!(
            tasks[0].collection_name.as_deref(),
            Some("Epic Mountain Music - Playlists")
        );
        assert!(tasks[0].leafs.is_empty());
        assert!(
            collection.is_none(),
            "root shell evidence belongs to the task, not a fake collection"
        );

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
        let client = Arc::new(FakeYtDlpClient::with_roots(HashMap::from([(
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
        )])));

        let collection = expansion_owner();
        let leaves = expand_root_entries_to_planned_leafs(
            &Id::from("task-expand"),
            client,
            vec![LeafReference {
                url: nested_url.to_string(),
                title: Some("Album One".to_string()),
                sequence: 0,
            }],
            &collection,
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
        let collection = expansion_owner();
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
            &collection,
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
fn expand_root_entries_to_planned_leafs_keeps_terminal_punctuation_after_prefix_removal() {
    let titles = planned_music_titles_from_playlist_titles(&[
        "ZWEI2 - Dog Fight!!".to_string(),
        "ZWEI2 - Now Relax...".to_string(),
        "ZWEI2 - Let's Exercise!!".to_string(),
        "ZWEI2 - The Great Sorcery War Once More...".to_string(),
    ]);

    assert_eq!(
        titles,
        vec![
            "Dog Fight!!",
            "Now Relax...",
            "Let's Exercise!!",
            "The Great Sorcery War Once More...",
        ]
    );
}

#[test]
fn expand_root_entries_to_planned_leafs_keeps_word_apostrophe_title_core() {
    let titles = planned_music_titles_from_playlist_titles(&[
        "Terraria OST - Journey's Beginning [Extended]".to_string(),
        "Journey's End OST- Space Day (Console Space)".to_string(),
        "Terraria OST - Old One's Army [Extended]".to_string(),
        "Terraria OST - Sandstorm [Extended]".to_string(),
        "Terraria Journey's End OST- Slime Rain".to_string(),
        "Terraria Journey's End OST- Queen Slime".to_string(),
    ]);

    assert_eq!(
        titles,
        vec![
            "Journey's Beginning",
            "Journey's End OST- Space Day (Console Space)",
            "Old One's Army",
            "Sandstorm",
            "Slime Rain",
            "Queen Slime",
        ]
    );
}

#[test]
fn expand_root_entries_to_planned_leafs_removes_language_prefix_noise_by_evidence_only() {
    let titles = planned_music_titles_from_playlist_titles(&[
        "Album - ...And Then".to_string(),
        "Album - \"Quoted\"".to_string(),
        "Album - (Hidden)".to_string(),
        "Album - What?".to_string(),
    ]);

    assert_eq!(
        titles,
        vec!["...And Then", "\"Quoted\"", "(Hidden)", "What?"]
    );
}

#[test]
fn expand_root_entries_to_planned_leafs_keeps_symbol_only_boundary_repetition() {
    let titles = planned_music_titles_from_playlist_titles(&[
        "#01 Alpha #99".to_string(),
        "#01 Beta #99".to_string(),
    ]);

    assert_eq!(titles, vec!["#01 Alpha #99", "#01 Beta #99"]);
}

#[test]
fn expand_root_entries_to_planned_leafs_normalizes_zwei2_playlist_titles() {
    let raw_titles = [
        "ZWEI2 - Bokura no Mirai (Opening Version)",
        "ZWEI2 - To the Frontier of Unlimited Adventures",
        "ZWEI2 - The Legend of Granvallen",
        "ZWEI2 - Dog Fight!!",
        "ZWEI2 - Driven by Passion",
        "ZWEI2 - Leave it to Ragna",
        "ZWEI2 - Meal is at the Giant Panda's Tower",
        "ZWEI2 - Now Relax...",
        "ZWEI2 - Artte Village",
        "ZWEI2 - Floating Island \"Ilvard\"",
        "ZWEI2 - Artte Airfield",
        "ZWEI2 - Brandy Hill",
        "ZWEI2 - Secundum Abandoned Mine",
        "ZWEI2 - Montblanc's Theme",
        "ZWEI2 - Roar! Anchor Gear!!",
        "ZWEI2 - Even If I Use Up All of My Energy...",
        "ZWEI2 - Roalta Village",
        "ZWEI2 - Ordium Shrine",
        "ZWEI2 - Stand in the Night Wind",
        "ZWEI2 - Masked Superman Gallandou",
        "ZWEI2 - Let's Exercise!!",
        "ZWEI2 - Gloomgeld Woods",
        "ZWEI2 - Witch Ra-Laira",
        "ZWEI2 - Aurone Forgetower",
        "ZWEI2 - Help Alwen",
        "ZWEI2 - Disturbing Atmosphere",
        "ZWEI2 - Moonbria Castle",
        "ZWEI2 - Dance in the Dark Night",
        "ZWEI2 - Restless Prison",
        "ZWEI2 - A Prayer to Espina",
        "ZWEI2 - Zahar's Ambition",
        "ZWEI2 - Prostrate Yourself Before Me",
        "ZWEI2 - Mechanical Girl",
        "ZWEI2 - Ragna in Despair",
        "ZWEI2 - Warm Feelings",
        "ZWEI2 - Starry Peak",
        "ZWEI2 - Starfall Hamlet",
        "ZWEI2 - Prepare Yourself",
        "ZWEI2 - Imposed Mission",
        "ZWEI2 - Crystal Valley",
        "ZWEI2 - Moon World \"Luna Mundus\"",
        "ZWEI2 - The Force of a Trueblood",
        "ZWEI2 - Destined Girl",
        "ZWEI2 - The Great Sorcery War Once More...",
        "ZWEI2 - The Worst Situation",
        "ZWEI2 - A Heart Connected with Another",
        "ZWEI2 - Help Alwen Rushing in Version",
        "ZWEI2 - Spiral Fortress Melzedek",
        "ZWEI2 - For My Master",
        "ZWEI2 - Break Through Obstacles",
        "ZWEI2 - Risk Everything on This Moment",
        "ZWEI2 - Demise of Destiny",
        "ZWEI2 - Irreplaceable Days",
        "ZWEI2 - Pledge Another Meeting",
        "ZWEI2 - ZWEI II End Credit",
        "ZWEI2 - Bokura no Mirai",
    ];
    let titles = planned_music_titles_from_playlist_titles(
        &raw_titles
            .iter()
            .map(|title| (*title).to_string())
            .collect::<Vec<_>>(),
    );
    let expected_titles = [
        "Bokura no Mirai (Opening Version)",
        "To the Frontier of Unlimited Adventures",
        "The Legend of Granvallen",
        "Dog Fight!!",
        "Driven by Passion",
        "Leave it to Ragna",
        "Meal is at the Giant Panda's Tower",
        "Now Relax...",
        "Artte Village",
        "Floating Island \"Ilvard\"",
        "Artte Airfield",
        "Brandy Hill",
        "Secundum Abandoned Mine",
        "Montblanc's Theme",
        "Roar! Anchor Gear!!",
        "Even If I Use Up All of My Energy...",
        "Roalta Village",
        "Ordium Shrine",
        "Stand in the Night Wind",
        "Masked Superman Gallandou",
        "Let's Exercise!!",
        "Gloomgeld Woods",
        "Witch Ra-Laira",
        "Aurone Forgetower",
        "Help Alwen",
        "Disturbing Atmosphere",
        "Moonbria Castle",
        "Dance in the Dark Night",
        "Restless Prison",
        "A Prayer to Espina",
        "Zahar's Ambition",
        "Prostrate Yourself Before Me",
        "Mechanical Girl",
        "Ragna in Despair",
        "Warm Feelings",
        "Starry Peak",
        "Starfall Hamlet",
        "Prepare Yourself",
        "Imposed Mission",
        "Crystal Valley",
        "Moon World \"Luna Mundus\"",
        "The Force of a Trueblood",
        "Destined Girl",
        "The Great Sorcery War Once More...",
        "The Worst Situation",
        "A Heart Connected with Another",
        "Help Alwen Rushing in Version",
        "Spiral Fortress Melzedek",
        "For My Master",
        "Break Through Obstacles",
        "Risk Everything on This Moment",
        "Demise of Destiny",
        "Irreplaceable Days",
        "Pledge Another Meeting",
        "ZWEI II End Credit",
        "Bokura no Mirai",
    ];

    assert_eq!(titles, expected_titles);
}

#[test]
fn expand_root_entries_to_planned_leafs_preserves_real_tenet_bracketed_album_title() {
    let titles = planned_music_titles_from_playlist_titles(&[
        "TENET Official Soundtrack | RAINY NIGHT IN TALLINN - Ludwig Göransson | WaterTower"
            .to_string(),
        "TENET Official Soundtrack | WINDMILLS - Ludwig Göransson | WaterTower".to_string(),
        "TENET Official Soundtrack | Full Album [Expanded Edition] - Ludwig Göransson | WaterTower"
            .to_string(),
        "TENET Official Soundtrack | [INVERTED] FULL ALBUM - Ludwig Göransson | WaterTower"
            .to_string(),
        "TENET Official Soundtrack | FULL ALBUM - Ludwig Göransson | WaterTower".to_string(),
    ]);

    assert_eq!(
        titles,
        vec![
            "RAINY NIGHT IN TALLINN",
            "WINDMILLS",
            "Full Album [Expanded Edition]",
            "[INVERTED] FULL ALBUM",
            "FULL ALBUM",
        ]
    );
}

#[test]
fn expand_root_entries_to_planned_leafs_preserves_real_tenet_full_playlist_titles() {
    let raw_titles = [
        "TENET Official Soundtrack | RAINY NIGHT IN TALLINN - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | WINDMILLS - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | MEETING NEIL - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | PRIYA - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | BETRAYAL - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | FREEPORT - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | 747 - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | FROM MUMBAI TO AMALFI - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | FOILS - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | SATOR - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | TRUCKS IN PLACE - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | RED ROOM BLUE ROOM - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | INVERSION - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | RETRIEVING THE CASE - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | THE ALGORITHM - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | POSTERITY - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | THE PROTAGONIST - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | THE PLAN - Travis Scott | WaterTower",
        "TENET Official Soundtrack | FAST CARS - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | TURNSTILE - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | Full Album [Expanded Edition] - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | [INVERTED] FULL ALBUM - Ludwig Göransson | WaterTower",
        "TENET Official Soundtrack | FULL ALBUM - Ludwig Göransson | WaterTower",
    ];
    let titles = planned_music_titles_from_playlist_titles(
        &raw_titles
            .iter()
            .map(|title| (*title).to_string())
            .collect::<Vec<_>>(),
    );

    assert_eq!(titles[20], "Full Album [Expanded Edition]");
    assert_eq!(titles[21], "[INVERTED] FULL ALBUM");
    assert_eq!(titles[22], "FULL ALBUM");
}

#[test]
fn expand_root_entries_to_planned_leafs_preserves_half_bracket_owned_by_title_body() {
    let titles = planned_music_titles_from_playlist_titles(&[
        "Album [INVERTED] Track".to_string(),
        "Album [FORWARD] Track".to_string(),
    ]);

    assert_eq!(titles, vec!["[INVERTED]", "[FORWARD]"]);
}

#[test]
fn expand_root_entries_to_planned_leafs_preserves_bracketed_variable_title_after_common_prefix() {
    for (opening, closing) in bracket_pair_cases() {
        let titles = planned_music_titles_from_playlist_titles(&[
            format!("Album {opening}Track A{closing}"),
            format!("Album {opening}Track B{closing}"),
        ]);

        assert_eq!(
            titles,
            vec![
                format!("{opening}Track A{closing}"),
                format!("{opening}Track B{closing}"),
            ]
        );
    }
}

#[test]
fn expand_root_entries_to_planned_leafs_preserves_bracketed_variable_title_before_common_suffix() {
    for (opening, closing) in bracket_pair_cases() {
        let titles = planned_music_titles_from_playlist_titles(&[
            format!("{opening}Track A{closing} Album"),
            format!("{opening}Track B{closing} Album"),
        ]);

        assert_eq!(
            titles,
            vec![
                format!("{opening}Track A{closing}"),
                format!("{opening}Track B{closing}"),
            ]
        );
    }
}

#[test]
fn expand_root_entries_to_planned_leafs_preserves_bracketed_variable_title_between_common_affixes()
{
    for (opening, closing) in bracket_pair_cases() {
        let titles = planned_music_titles_from_playlist_titles(&[
            format!("Album {opening}Track A{closing} OST"),
            format!("Album {opening}Track B{closing} OST"),
        ]);

        assert_eq!(
            titles,
            vec![
                format!("{opening}Track A{closing}"),
                format!("{opening}Track B{closing}"),
            ]
        );
    }
}

#[test]
fn expand_root_entries_to_planned_leafs_preserves_unmatched_opening_brackets_in_common_prefix() {
    for (opening, _) in bracket_pair_cases() {
        let titles = planned_music_titles_from_playlist_titles(&[
            format!("Album {opening}Track A"),
            format!("Album {opening}Track B"),
        ]);

        assert_eq!(
            titles,
            vec![format!("{opening}Track A"), format!("{opening}Track B")]
        );
    }
}

#[test]
fn expand_root_entries_to_planned_leafs_preserves_unmatched_closing_brackets_in_common_suffix() {
    for (_, closing) in bracket_pair_cases() {
        let titles = planned_music_titles_from_playlist_titles(&[
            format!("Track A{closing} - Album"),
            format!("Track B{closing} - Album"),
        ]);

        assert_eq!(
            titles,
            vec![format!("Track A{closing}"), format!("Track B{closing}")]
        );
    }
}

#[test]
fn expand_root_entries_to_planned_leafs_removes_repeated_subset_affixes_from_all_matches() {
    let titles = planned_music_titles_from_playlist_titles(&[
        "Magnolian - Indigo (Official Video)".to_string(),
        "Magnolian - Famous Men (Official Video)".to_string(),
        "Grimm Grimm - Deathly (Official Video)".to_string(),
        "Grimm Grimm - Mothers (Official Video)".to_string(),
        "Hania Rani — 'Leaving' (Official Video) [Gondwana Records]".to_string(),
        "Hania Rani – Dancing with Ghosts ft. Patrick Watson (Official Video)".to_string(),
    ]);

    assert_eq!(
        titles,
        vec![
            "Indigo",
            "Famous Men",
            "Deathly",
            "Mothers",
            "Hania Rani — 'Leaving' [Gondwana Records]",
            "Hania Rani – Dancing with Ghosts ft. Patrick Watson",
        ]
    );
}

#[test]
fn expand_root_entries_to_planned_leafs_keeps_mixed_separator_artist_prefixes() {
    let titles = planned_music_titles_from_playlist_titles(&[
        "SILENT POETS / Asylums For The Feeling feat. Leila Adu".to_string(),
        "SILENT POETS - Chariot I Plead feat. Tim Smith (Official Audio)".to_string(),
    ]);

    assert_eq!(
        titles,
        vec![
            "SILENT POETS / Asylums For The Feeling feat. Leila Adu",
            "SILENT POETS - Chariot I Plead feat. Tim Smith (Official Audio)",
        ]
    );
}

#[test]
fn expand_root_entries_to_planned_leafs_keeps_same_video_distinct_across_groups() {
    run_async(async {
        let first_url = "https://www.youtube.com/playlist?list=PLfirst";
        let second_url = "https://www.youtube.com/playlist?list=PLsecond";
        let repeated_video_url = "https://www.youtube.com/watch?v=same";
        let client = Arc::new(FakeYtDlpClient::with_roots(HashMap::from([
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
        ])));

        let collection = expansion_owner();
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
            &collection,
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
    occurrence_id: String::new(),
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
            loudness_profile: None,
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
fn load_collection_shell_restores_manifest_music_evidence_from_disk() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let save_root = temp_test_dir();
        let collection_folder = "youtube/Manifest Restore";
        let collection_dir = save_root.join(collection_folder);
        let group_dir = collection_dir.join("Album One");
        std::fs::create_dir_all(&group_dir).expect("group dir should be created");
        std::fs::write(group_dir.join("Track One.m4a"), b"audio")
            .expect("existing audio should be created");
        std::fs::write(
            collection_dir.join(".slisic.collection.toml"),
            r#"version = 1

[collection]
name = "Manifest Restore"
url = "https://example.com/root"
folder = "youtube/Manifest Restore"
source_kind = "list"
enable_updates = false
last_updated = "2026-05-27T00:00:00+00:00"

[[groups]]
name = "Album One"
url = "https://example.com/album-one"
folder = "Album One"

[[music]]
name = "Track One"
alias = "Track One"
url = "https://example.com/watch?v=one"
path = "Album One/Track One.m4a"
group_url = "https://example.com/album-one"
start_ms = 0
end_ms = 180000
liked = false
"#,
        )
        .expect("manifest should be written");

        upsert_collection(&Collection {
            name: "Manifest Restore".to_string(),
            url: "https://example.com/root".to_string(),
            folder: collection_folder.to_string(),
            musics: vec![],
            last_updated: "2026-05-27T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        })
        .await
        .expect("collection shell should be saved");

        let plan = CollectionSyncPlan {
            source_kind: CollectionSourceKind::List,
            collection_name: "Manifest Restore".to_string(),
            collection_url: "https://example.com/root".to_string(),
            collection_folder: collection_folder.to_string(),
            enable_updates: Some(false),
            leaves: vec![PlannedLeaf {
                id: Id::from("leaf-one"),
                url: "https://example.com/watch?v=one".to_string(),
                sequence: 0,
                initial_probe: None,
                music_title: Some("Track One".to_string()),
                group_hint: Some(collection_group(
                    "Album One",
                    "https://example.com/album-one",
                    "Album One",
                )),
            }],
        };

        let collection = load_collection_shell_with_local_duration_probe(&plan, &save_root, |_| {
            Ok(Some(180_000))
        })
        .await
        .expect("manifest evidence should restore");
        let completions = existing_planned_leaf_completions(&collection, &plan, &save_root);

        assert_eq!(collection.musics.len(), 1);
        assert_eq!(collection.musics[0].name, "Track One");
        assert_eq!(collection.musics[0].end_ms, 180_000);
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].leaf_id.to_string(), "leaf-one");

        reset_db();
        let _ = std::fs::remove_dir_all(save_root);
    });
}

#[test]
fn load_collection_shell_restores_manifest_music_end_from_local_duration_evidence() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let save_root = temp_test_dir();
        let collection_folder = "youtube/Manifest Restore Duration";
        let collection_dir = save_root.join(collection_folder);
        std::fs::create_dir_all(&collection_dir).expect("collection dir should be created");
        std::fs::write(collection_dir.join("What Now.m4a"), b"audio")
            .expect("existing audio should be created");
        std::fs::write(
            collection_dir.join(".slisic.collection.toml"),
            r#"version = 1

groups = []

[collection]
name = "Manifest Restore Duration"
url = "https://example.com/root"
folder = "youtube/Manifest Restore Duration"
source_kind = "list"
enable_updates = false
last_updated = "2026-05-27T00:00:00+00:00"

[[music]]
name = "What Now"
alias = "What Now"
url = "https://www.youtube.com/watch?v=Gv1CBp5NABw"
path = "What Now.m4a"
group_url = "https://example.com/root"
start_ms = 0
end_ms = 344000
liked = false
"#,
        )
        .expect("manifest should be written");

        upsert_collection(&Collection {
            name: "Manifest Restore Duration".to_string(),
            url: "https://example.com/root".to_string(),
            folder: collection_folder.to_string(),
            musics: vec![],
            last_updated: "2026-05-27T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        })
        .await
        .expect("collection shell should be saved");

        let plan = CollectionSyncPlan {
            source_kind: CollectionSourceKind::List,
            collection_name: "Manifest Restore Duration".to_string(),
            collection_url: "https://example.com/root".to_string(),
            collection_folder: collection_folder.to_string(),
            enable_updates: Some(false),
            leaves: vec![PlannedLeaf {
                id: Id::from("leaf-what-now"),
                url: "https://www.youtube.com/watch?v=Gv1CBp5NABw".to_string(),
                sequence: 0,
                initial_probe: None,
                music_title: Some("What Now".to_string()),
                group_hint: None,
            }],
        };

        let collection = load_collection_shell_with_local_duration_probe(&plan, &save_root, |_| {
            Ok(Some(344_455))
        })
        .await
        .expect("manifest duration evidence should restore");
        let completions = existing_planned_leaf_completions(&collection, &plan, &save_root);

        assert_eq!(collection.musics.len(), 1);
        assert_eq!(collection.musics[0].end_ms, 344_455);
        assert_eq!(
            collection.musics[0].canonical_music_id,
            canonical_music_id_for_source(
                "https://www.youtube.com/watch?v=Gv1CBp5NABw",
                0,
                344_455
            )
        );
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].leaf_id.to_string(), "leaf-what-now");

        reset_db();
        let _ = std::fs::remove_dir_all(save_root);
    });
}

#[test]
fn load_collection_shell_replaces_existing_manifest_music_boundary_without_duplication() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let save_root = temp_test_dir();
        let collection_folder = "youtube/Manifest Restore Boundary Replace";
        let collection_dir = save_root.join(collection_folder);
        std::fs::create_dir_all(&collection_dir).expect("collection dir should be created");
        std::fs::write(collection_dir.join("What Now.m4a"), b"audio")
            .expect("existing audio should be created");
        std::fs::write(
            collection_dir.join(".slisic.collection.toml"),
            r#"version = 1

groups = []

[collection]
name = "Manifest Restore Boundary Replace"
url = "https://example.com/root"
folder = "youtube/Manifest Restore Boundary Replace"
source_kind = "list"
enable_updates = false
last_updated = "2026-05-27T00:00:00+00:00"

[[music]]
name = "What Now"
alias = "What Now"
url = "https://www.youtube.com/watch?v=Gv1CBp5NABw"
path = "What Now.m4a"
group_url = "https://example.com/root"
start_ms = 0
end_ms = 344000
liked = false
"#,
        )
        .expect("manifest should be written");

        upsert_collection(&Collection {
            name: "Manifest Restore Boundary Replace".to_string(),
            url: "https://example.com/root".to_string(),
            folder: collection_folder.to_string(),
            musics: vec![Music {
    occurrence_id: String::new(),
                name: "What Now".to_string(),
                alias: "What Now".to_string(),
                group: collection_group(
                    "Manifest Restore Boundary Replace",
                    "https://example.com/root",
                    collection_folder,
                ),
                canonical_music_id: canonical_music_id_for_source(
                    "https://www.youtube.com/watch?v=Gv1CBp5NABw",
                    0,
                    344_000,
                ),
                url: "https://www.youtube.com/watch?v=Gv1CBp5NABw".to_string(),
                path: Some("What Now.m4a".to_string()),
                start_ms: 0,
                end_ms: 344_000,
                liked: false,
                loudness_profile: None,
            }],
            last_updated: "2026-05-27T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        })
        .await
        .expect("collection shell should be saved");

        let plan = CollectionSyncPlan {
            source_kind: CollectionSourceKind::List,
            collection_name: "Manifest Restore Boundary Replace".to_string(),
            collection_url: "https://example.com/root".to_string(),
            collection_folder: collection_folder.to_string(),
            enable_updates: Some(false),
            leaves: vec![PlannedLeaf {
                id: Id::from("leaf-what-now"),
                url: "https://www.youtube.com/watch?v=Gv1CBp5NABw".to_string(),
                sequence: 0,
                initial_probe: None,
                music_title: Some("What Now".to_string()),
                group_hint: None,
            }],
        };

        let collection = load_collection_shell_with_local_duration_probe(&plan, &save_root, |_| {
            Ok(Some(344_455))
        })
        .await
        .expect("manifest duration evidence should update existing music");

        assert_eq!(collection.musics.len(), 1);
        assert_eq!(collection.musics[0].end_ms, 344_455);
        assert_eq!(
            collection.musics[0].canonical_music_id,
            canonical_music_id_for_source(
                "https://www.youtube.com/watch?v=Gv1CBp5NABw",
                0,
                344_455
            )
        );

        reset_db();
        let _ = std::fs::remove_dir_all(save_root);
    });
}

#[test]
fn download_transaction_shell_does_not_restore_manifest_music_evidence() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let save_root = temp_test_dir();
        let collection_folder = "youtube/TENET Official Soundtrack";
        let collection_dir = save_root.join(collection_folder);
        let raw_file_name =
            "TENET Official Soundtrack - [INVERTED] FULL ALBUM - Ludwig Göransson - WaterTower.m4a";
        std::fs::create_dir_all(&collection_dir).expect("collection dir should be created");
        std::fs::write(collection_dir.join(raw_file_name), b"audio")
            .expect("existing audio should be created");
        std::fs::write(
            collection_dir.join(".slisic.collection.toml"),
            r#"version = 1

groups = []

[collection]
name = "TENET Official Soundtrack"
url = "https://www.youtube.com/playlist?list=PLtenet"
folder = "youtube/TENET Official Soundtrack"
source_kind = "list"
enable_updates = false
last_updated = "2026-06-07T00:00:00+00:00"

[[music]]
name = "INVERTED] FULL ALBUM - Ludwig Göransson"
alias = "INVERTED] FULL ALBUM - Ludwig Göransson"
url = "https://www.youtube.com/watch?v=inverted"
path = "TENET Official Soundtrack - [INVERTED] FULL ALBUM - Ludwig Göransson - WaterTower.m4a"
group_url = "https://www.youtube.com/playlist?list=PLtenet"
start_ms = 0
end_ms = 236000
liked = false
"#,
        )
        .expect("polluted manifest should be written");

        upsert_collection(&Collection {
            name: "TENET Official Soundtrack".to_string(),
            url: "https://www.youtube.com/playlist?list=PLtenet".to_string(),
            folder: collection_folder.to_string(),
            musics: vec![],
            last_updated: "2026-06-07T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        })
        .await
        .expect("collection shell should be saved");

        let plan = CollectionSyncPlan {
            source_kind: CollectionSourceKind::List,
            collection_name: "TENET Official Soundtrack".to_string(),
            collection_url: "https://www.youtube.com/playlist?list=PLtenet".to_string(),
            collection_folder: collection_folder.to_string(),
            enable_updates: Some(false),
            leaves: vec![PlannedLeaf {
                id: Id::from("leaf-inverted"),
                url: "https://www.youtube.com/watch?v=inverted".to_string(),
                sequence: 0,
                initial_probe: None,
                music_title: Some("[INVERTED] FULL ALBUM".to_string()),
                group_hint: None,
            }],
        };

        let restored = load_collection_shell_with_local_duration_probe(&plan, &save_root, |_| {
            Ok(Some(236_000))
        })
        .await
        .expect("ordinary manifest restore should remain available");
        assert_eq!(restored.musics.len(), 1);
        assert_eq!(restored.musics[0].name, "INVERTED] FULL ALBUM - Ludwig Göransson");
        assert_eq!(
            existing_planned_leaf_completions(&restored, &plan, &save_root).len(),
            1
        );

        upsert_collection(&Collection {
            name: "TENET Official Soundtrack".to_string(),
            url: "https://www.youtube.com/playlist?list=PLtenet".to_string(),
            folder: collection_folder.to_string(),
            musics: vec![],
            last_updated: "2026-06-07T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        })
        .await
        .expect("collection shell should be reset before transaction load");

        let transaction_collection = load_download_transaction_collection_shell(&plan)
            .await
            .expect("download transaction shell should load");

        assert!(transaction_collection.musics.is_empty());
        assert!(
            existing_planned_leaf_completions(&transaction_collection, &plan, &save_root)
                .is_empty()
        );

        reset_db();
        let _ = std::fs::remove_dir_all(save_root);
    });
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
fn apply_collection_plan_to_task_discards_completed_leaf_evidence_when_plan_is_partial() {
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

    assert_eq!(task.leafs.len(), 1);
    assert_eq!(task.leafs[0].id.to_string(), "leaf-new");
}

#[test]
fn persist_enqueued_collection_plan_saves_residual_leaves_for_single_probe_startup() {
    let _guard = acquire_db_test_lock();

    run_async(async {
        ensure_db().await;

        let task = save_task(DownloadTask::new(
            "task-plan",
            "https://example.com/playlist",
            DownloadTrigger::Manual,
        ))
        .await
        .expect("task should save before plan persistence");
        let plan = CollectionSyncPlan {
            source_kind: CollectionSourceKind::List,
            collection_name: "Probe Once Playlist".to_string(),
            collection_url: "https://example.com/playlist".to_string(),
            collection_folder: "example/probe-once-playlist".to_string(),
            enable_updates: Some(false),
            leaves: vec![
                PlannedLeaf {
                    id: Id::from("leaf-one"),
                    url: "https://example.com/watch?v=one".to_string(),
                    sequence: 0,
                    initial_probe: None,
                    music_title: Some("Track One".to_string()),
                    group_hint: None,
                },
                PlannedLeaf {
                    id: Id::from("leaf-two"),
                    url: "https://example.com/watch?v=two".to_string(),
                    sequence: 1,
                    initial_probe: None,
                    music_title: Some("Track Two".to_string()),
                    group_hint: Some(collection_group(
                        "Disc Two",
                        "https://example.com/playlist/disc-two",
                        "Disc Two",
                    )),
                },
            ],
        };

        let (saved_task, saved_collection) = persist_enqueued_collection_plan(task, &plan)
            .await
            .expect("enqueue plan should persist residual leaves");

        assert_eq!(
            saved_task.collection_url.as_deref(),
            Some(plan.collection_url.as_str())
        );
        assert_eq!(
            saved_task.collection_name.as_deref(),
            Some("Probe Once Playlist")
        );
        assert_eq!(saved_task.source_kind, Some(CollectionSourceKind::List));
        assert_eq!(saved_task.leafs.len(), 2);
        assert_eq!(saved_task.total_leaves, 2);
        assert_eq!(saved_task.leafs[0].title.as_deref(), Some("Track One"));
        assert_eq!(saved_task.leafs[1].title.as_deref(), Some("Track Two"));
        assert_eq!(
            saved_task.leafs[1]
                .group
                .as_ref()
                .map(|group| group.name.as_str()),
            Some("Disc Two")
        );
        assert_eq!(saved_collection.url, plan.collection_url);

        let recovered_plan =
            resolve_collection_plan(&saved_task, Arc::new(FakeYtDlpClient::default()))
                .await
                .expect("persisted residual leaves should eliminate a second root probe");
        assert_eq!(recovered_plan.leaves.len(), 2);
        assert_eq!(recovered_plan.leaves[0].id.to_string(), "leaf-one");
        assert_eq!(recovered_plan.leaves[1].id.to_string(), "leaf-two");

        reset_db();
    });
}
