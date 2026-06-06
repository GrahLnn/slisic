use super::binaries::{
    BinaryInstallState, BinaryMaintenanceActivity, GitHubLatestReleaseAsset,
    GitHubReleaseAssetMatcher, ManagedBinary, RemoteIdentity, StagedBinary, activate_staged_binary,
    binary_http_retry_delay, build_github_api_url, build_github_relay_url, needs_install_or_update,
    parse_sha256, release_asset_matcher_matches, select_release_asset_name,
    should_retry_binary_http_status, with_binary_kind_lock,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn temp_binary_test_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after epoch")
        .as_nanos();

    std::env::temp_dir().join(format!(
        "slisic-binary-{prefix}-{}-{nanos}",
        std::process::id()
    ))
}

#[test]
fn build_github_relay_url_uses_single_canonical_base() {
    let url = build_github_relay_url("yt-dlp", "yt-dlp", "releases/latest/download/yt-dlp.exe");

    assert_eq!(
        url,
        "https://xget.r2g2.org/gh/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    );
}

#[test]
fn build_github_api_url_uses_the_official_release_metadata_endpoint() {
    let url = build_github_api_url("BtbN", "FFmpeg-Builds", "releases/latest");

    assert_eq!(
        url,
        "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest"
    );
}

#[test]
fn parse_sha256_extracts_matching_asset_hash() {
    let sums = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  other-file\n\
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  yt-dlp.exe\n";

    let hash = parse_sha256(sums, "yt-dlp.exe");

    assert_eq!(
        hash.as_deref(),
        Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
}

#[test]
fn binary_http_retry_policy_retries_only_transient_statuses() {
    assert!(should_retry_binary_http_status(
        reqwest::StatusCode::REQUEST_TIMEOUT
    ));
    assert!(should_retry_binary_http_status(
        reqwest::StatusCode::TOO_MANY_REQUESTS
    ));
    assert!(should_retry_binary_http_status(
        reqwest::StatusCode::BAD_GATEWAY
    ));
    assert!(should_retry_binary_http_status(
        reqwest::StatusCode::SERVICE_UNAVAILABLE
    ));

    assert!(!should_retry_binary_http_status(reqwest::StatusCode::OK));
    assert!(!should_retry_binary_http_status(
        reqwest::StatusCode::UNAUTHORIZED
    ));
    assert!(!should_retry_binary_http_status(
        reqwest::StatusCode::NOT_FOUND
    ));
}

#[test]
fn binary_http_retry_delay_is_bounded_and_increasing() {
    assert_eq!(binary_http_retry_delay(0), Duration::from_millis(350));
    assert_eq!(binary_http_retry_delay(1), Duration::from_millis(700));
    assert_eq!(binary_http_retry_delay(2), Duration::from_millis(1050));
}

#[test]
fn release_asset_matcher_matches_exact_and_suffix_rules() {
    assert!(release_asset_matcher_matches(
        GitHubReleaseAssetMatcher::Exact("yt-dlp.exe"),
        "yt-dlp.exe"
    ));
    assert!(!release_asset_matcher_matches(
        GitHubReleaseAssetMatcher::Exact("yt-dlp.exe"),
        "yt-dlp_x86.exe"
    ));
    assert!(release_asset_matcher_matches(
        GitHubReleaseAssetMatcher::Suffix("-win64-gpl.zip"),
        "ffmpeg-N-124055-gc67a4554d1-win64-gpl.zip"
    ));
    assert!(!release_asset_matcher_matches(
        GitHubReleaseAssetMatcher::Suffix("-win64-gpl.zip"),
        "ffmpeg-N-124055-gc67a4554d1-win64-gpl-shared.zip"
    ));
}

#[test]
fn select_release_asset_name_picks_the_current_release_asset_without_hardcoding_build_ids() {
    let assets = vec![
        GitHubLatestReleaseAsset {
            name: "ffmpeg-N-124055-gc67a4554d1-win64-gpl-shared.zip".to_string(),
        },
        GitHubLatestReleaseAsset {
            name: "ffmpeg-N-124055-gc67a4554d1-win64-gpl.zip".to_string(),
        },
    ];

    let selected =
        select_release_asset_name(&assets, GitHubReleaseAssetMatcher::Suffix("-win64-gpl.zip"))
            .expect("suffix matcher should resolve the non-shared win64 gpl asset");

    assert_eq!(selected, "ffmpeg-N-124055-gc67a4554d1-win64-gpl.zip");
}

#[test]
fn needs_install_or_update_forces_first_managed_sync_without_state() {
    let remote = RemoteIdentity {
        etag: Some("\"etag-1\"".to_string()),
        last_modified: Some("Sat, 11 Apr 2026 08:59:22 GMT".to_string()),
        content_length: Some(42),
    };

    assert!(needs_install_or_update(true, None, &remote));
}

#[test]
fn needs_install_or_update_skips_when_remote_identity_matches_state() {
    let remote = RemoteIdentity {
        etag: Some("\"etag-1\"".to_string()),
        last_modified: Some("Sat, 11 Apr 2026 08:59:22 GMT".to_string()),
        content_length: Some(42),
    };
    let state = BinaryInstallState {
        remote: remote.clone(),
        installed_version: Some("2026.04.10".to_string()),
    };

    assert!(!needs_install_or_update(true, Some(&state), &remote));
}

#[test]
fn needs_install_or_update_detects_remote_identity_change() {
    let remote = RemoteIdentity {
        etag: Some("\"etag-2\"".to_string()),
        last_modified: Some("Sat, 11 Apr 2026 08:59:22 GMT".to_string()),
        content_length: Some(42),
    };
    let state = BinaryInstallState {
        remote: RemoteIdentity {
            etag: Some("\"etag-1\"".to_string()),
            last_modified: Some("Sat, 11 Apr 2026 08:59:22 GMT".to_string()),
            content_length: Some(42),
        },
        installed_version: Some("2026.04.10".to_string()),
    };

    assert!(needs_install_or_update(true, Some(&state), &remote));
}

#[test]
fn binary_kind_lock_serializes_same_binary_operations() {
    let active = Arc::new(AtomicUsize::new(0));
    let max_seen = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();

    for _ in 0..2 {
        let active = Arc::clone(&active);
        let max_seen = Arc::clone(&max_seen);
        handles.push(thread::spawn(move || {
            with_binary_kind_lock(ManagedBinary::YtDlp, || {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                let mut observed = max_seen.load(Ordering::SeqCst);
                while current > observed
                    && max_seen
                        .compare_exchange(observed, current, Ordering::SeqCst, Ordering::SeqCst)
                        .is_err()
                {
                    observed = max_seen.load(Ordering::SeqCst);
                }

                thread::sleep(Duration::from_millis(40));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
            .expect("same-kind locked work should succeed");
        }));
    }

    for handle in handles {
        handle.join().expect("same-kind worker should join");
    }

    assert_eq!(
        max_seen.load(Ordering::SeqCst),
        1,
        "the same managed binary should never execute two operations concurrently"
    );
}

#[test]
fn binary_kind_lock_allows_different_binaries_to_progress_independently() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_ffmpeg_tx, release_ffmpeg_rx) = mpsc::channel();
    let (release_ytdlp_tx, release_ytdlp_rx) = mpsc::channel();

    let ffmpeg_tx = entered_tx.clone();
    let ffmpeg = thread::spawn(move || {
        with_binary_kind_lock(ManagedBinary::Ffmpeg, || {
            ffmpeg_tx
                .send("ffmpeg")
                .expect("ffmpeg enter signal should send");
            release_ffmpeg_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("ffmpeg release should arrive");
            Ok(())
        })
        .expect("ffmpeg locked work should succeed");
    });

    let ytdlp = thread::spawn(move || {
        with_binary_kind_lock(ManagedBinary::YtDlp, || {
            entered_tx
                .send("yt-dlp")
                .expect("yt-dlp enter signal should send");
            release_ytdlp_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("yt-dlp release should arrive");
            Ok(())
        })
        .expect("yt-dlp locked work should succeed");
    });

    let first = entered_rx
        .recv_timeout(Duration::from_millis(300))
        .expect("first binary should enter promptly");
    let second = entered_rx
        .recv_timeout(Duration::from_millis(300))
        .expect("different binary should not be blocked by the first lock");

    assert_ne!(first, second, "two different binaries should both enter");

    release_ffmpeg_tx
        .send(())
        .expect("ffmpeg release should send");
    release_ytdlp_tx
        .send(())
        .expect("yt-dlp release should send");

    ffmpeg.join().expect("ffmpeg worker should join");
    ytdlp.join().expect("yt-dlp worker should join");
}

#[test]
fn binary_maintenance_activity_reports_busy_from_either_runtime() {
    let active_player_binary_tasks = Arc::new(AtomicUsize::new(0));
    let active_tasks = Arc::new(AtomicUsize::new(0));
    let active_loudness_binary_tasks = Arc::new(AtomicUsize::new(0));
    let player_binary_task_probe = Arc::clone(&active_player_binary_tasks);
    let task_probe = Arc::clone(&active_tasks);
    let loudness_binary_task_probe = Arc::clone(&active_loudness_binary_tasks);
    let activity = BinaryMaintenanceActivity::new(
        move || player_binary_task_probe.load(Ordering::SeqCst) > 0,
        move || task_probe.load(Ordering::SeqCst) > 0,
        move || loudness_binary_task_probe.load(Ordering::SeqCst) > 0,
    );

    assert!(!activity.is_busy());

    active_player_binary_tasks.store(1, Ordering::SeqCst);
    assert!(activity.is_busy());

    active_player_binary_tasks.store(0, Ordering::SeqCst);
    active_tasks.store(1, Ordering::SeqCst);
    assert!(activity.is_busy());

    active_tasks.store(0, Ordering::SeqCst);
    active_loudness_binary_tasks.store(1, Ordering::SeqCst);
    assert!(activity.is_busy());
}

#[test]
fn activate_staged_binary_replaces_current_binary_only_when_called() {
    let root = temp_binary_test_dir("activation");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("temp activation root should be created");

    let install_path = root.join("yt-dlp.exe");
    let staged_dir = root.join("staged");
    let staged_path = staged_dir.join("yt-dlp.exe");
    let state_path = root.join("yt-dlp.state.json");
    std::fs::create_dir_all(&staged_dir).expect("staged dir should be created");
    std::fs::write(&install_path, b"old").expect("old binary should be written");
    std::fs::write(&staged_path, b"new").expect("staged binary should be written");

    let staged = StagedBinary {
        executable_path: staged_path,
        remote: RemoteIdentity {
            etag: Some("\"next\"".to_string()),
            last_modified: None,
            content_length: Some(3),
        },
        stage_dir: staged_dir,
        version: Some("2026.05.02".to_string()),
    };

    activate_staged_binary(ManagedBinary::YtDlp, &install_path, &state_path, &staged)
        .expect("staged binary should activate");

    assert_eq!(
        std::fs::read(&install_path).expect("installed binary should read"),
        b"new"
    );
    let state = std::fs::read_to_string(&state_path).expect("state should be written");
    assert!(state.contains("2026.05.02"));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn activate_staged_binary_keeps_current_binary_when_staged_source_is_missing() {
    let root = temp_binary_test_dir("activation-missing-source");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("temp activation root should be created");

    let install_path = root.join("ffmpeg.exe");
    let staged_dir = root.join("staged");
    let staged_path = staged_dir.join("ffmpeg.exe");
    let state_path = root.join("ffmpeg.state.json");
    std::fs::create_dir_all(&staged_dir).expect("staged dir should be created");
    std::fs::write(&install_path, b"old").expect("old binary should be written");

    let staged = StagedBinary {
        executable_path: staged_path,
        remote: RemoteIdentity {
            etag: Some("\"next\"".to_string()),
            last_modified: None,
            content_length: Some(3),
        },
        stage_dir: staged_dir,
        version: Some("N-124300".to_string()),
    };

    let result = activate_staged_binary(ManagedBinary::Ffmpeg, &install_path, &state_path, &staged);

    assert!(result.is_err());
    assert_eq!(
        std::fs::read(&install_path).expect("current binary should still read"),
        b"old"
    );
    assert!(
        !state_path.exists(),
        "failed activation should not record the staged version"
    );

    let _ = std::fs::remove_dir_all(&root);
}
