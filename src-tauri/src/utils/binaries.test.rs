use super::binaries::{
    BinaryInstallState, ManagedBinary, RemoteIdentity, build_github_relay_url,
    needs_install_or_update, parse_sha256, with_binary_kind_lock,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

#[test]
fn build_github_relay_url_uses_single_canonical_base() {
    let url = build_github_relay_url("yt-dlp", "yt-dlp", "releases/latest/download/yt-dlp.exe");

    assert_eq!(
        url,
        "https://xget.r2g2.org/gh/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
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
