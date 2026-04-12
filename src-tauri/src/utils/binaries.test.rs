use super::binaries::{
    BinaryInstallState, RemoteIdentity, build_github_relay_url, needs_install_or_update,
    parse_sha256,
};

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
