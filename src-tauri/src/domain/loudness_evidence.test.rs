use super::{
    LoudnessEvidenceRequest, LoudnessEvidenceSource,
    deduplicate_pending_loudness_requests_for_test, loudness_identity_key_for_test,
    loudness_queue_insert_index, loudness_request_from_playback_track_for_test,
    read_loudness_pending_task_file_for_test, read_published_loudness_profile_for_test,
    remember_published_loudness_profile_for_test, remove_loudness_pending_task_from_file_for_test,
    should_close_loudness_request_after_error_for_test, upsert_loudness_pending_task_file_for_test,
};
use crate::domain::player::model::PlaybackTrack;
use crate::domain::playlists::model::LoudnessProfile;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_pending_path(test_name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir()
        .join(format!(
            "slisic_loudness_evidence_test_{}_{}",
            std::process::id(),
            nanos
        ))
        .join(test_name)
        .join("loudness-evidence-pending.json")
}

fn request_with_file(file_name: &str, start_ms: u32, end_ms: u32) -> LoudnessEvidenceRequest {
    LoudnessEvidenceRequest {
        canonical_music_id: "music:stable".to_string(),
        url: "https://example.com/watch?v=stable".to_string(),
        file_path: PathBuf::from(format!("C:/Media/{file_name}")),
        start_ms,
        end_ms,
    }
}

fn request(start_ms: u32, end_ms: u32) -> LoudnessEvidenceRequest {
    request_with_file("Track.m4a", start_ms, end_ms)
}

fn playback_track(loudness: f32) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "PlayList".to_string(),
        music_name: "Track".to_string(),
        canonical_music_id: "source:https://example.com/watch?v=stable:0:60000".to_string(),
        music_url: "https://example.com/watch?v=stable".to_string(),
        file_path: PathBuf::from("C:/Media/Track.m4a"),
        source_music: None,
        start_ms: 0,
        end_ms: 60_000,
        liked: false,
        loudness_profile: LoudnessProfile::from_integrated_lufs(loudness),
    }
}

#[test]
fn loudness_identity_key_is_range_specific() {
    assert_ne!(
        loudness_identity_key_for_test(&request(0, 60_000)),
        loudness_identity_key_for_test(&request(60_000, 120_000))
    );
}

#[test]
fn pending_loudness_requests_deduplicate_by_identity() {
    let original = request_with_file("Old.m4a", 0, 60_000);
    let replacement = request_with_file("New.m4a", 0, 60_000);
    let other_range = request_with_file("OtherRange.m4a", 60_000, 120_000);

    let deduplicated = deduplicate_pending_loudness_requests_for_test(vec![
        original,
        other_range.clone(),
        replacement.clone(),
    ]);

    assert_eq!(deduplicated, vec![other_range, replacement]);
}

#[test]
fn pending_loudness_task_file_round_trips_and_removes_completed_identity() {
    let path = temp_pending_path("round_trip_remove");
    let first = request_with_file("First.m4a", 0, 60_000);
    let first_replacement = request_with_file("FirstReplacement.m4a", 0, 60_000);
    let second = request_with_file("Second.m4a", 60_000, 120_000);

    upsert_loudness_pending_task_file_for_test(&path, &first)
        .expect("first pending loudness task should persist");
    upsert_loudness_pending_task_file_for_test(&path, &second)
        .expect("second pending loudness task should persist");
    upsert_loudness_pending_task_file_for_test(&path, &first_replacement)
        .expect("same identity should update the pending task cargo");

    assert_eq!(
        read_loudness_pending_task_file_for_test(&path)
            .expect("pending loudness tasks should reload"),
        vec![second.clone(), first_replacement.clone()]
    );

    remove_loudness_pending_task_from_file_for_test(&path, &first_replacement)
        .expect("completed first task should be removed");
    assert_eq!(
        read_loudness_pending_task_file_for_test(&path)
            .expect("remaining pending loudness tasks should reload"),
        vec![second.clone()]
    );

    remove_loudness_pending_task_from_file_for_test(&path, &second)
        .expect("completed final task should remove pending file");
    assert!(
        !path.exists(),
        "empty pending store should be eliminated instead of preserved as stale state"
    );
}

#[test]
fn missing_pending_loudness_task_file_reads_as_empty_startup_queue() {
    let path = temp_pending_path("missing_reads_empty");

    assert_eq!(
        read_loudness_pending_task_file_for_test(&path)
            .expect("missing pending loudness task file should be an empty queue"),
        Vec::<LoudnessEvidenceRequest>::new()
    );
}

#[test]
fn playback_track_with_existing_loudness_does_not_create_measurement_request() {
    assert!(
        loudness_request_from_playback_track_for_test(&playback_track(-14.25)).is_none(),
        "tracks that already carry LUFS evidence must not re-enter the measurement queue"
    );

    let request = loudness_request_from_playback_track_for_test(&playback_track(0.0))
        .expect("zero loudness track should request measurement");
    assert_eq!(request.start_ms, 0);
    assert_eq!(request.end_ms, 60_000);
    assert_eq!(request.file_path, PathBuf::from("C:/Media/Track.m4a"));
}

#[test]
fn published_loudness_profile_survives_active_task_release_by_identity() {
    let mut profiles = HashMap::new();
    let first_slot_request = request_with_file("PreparedFirst.m4a", 0, 95_086);
    let same_identity_request = request_with_file("PreparedFirstMoved.m4a", 0, 95_086);
    let other_range_request = request_with_file("PreparedFirst.m4a", 95_086, 180_000);
    let profile = LoudnessProfile::from_integrated_lufs(-13.87).expect("test LUFS should be valid");

    remember_published_loudness_profile_for_test(&mut profiles, &first_slot_request, profile);

    assert_eq!(
        read_published_loudness_profile_for_test(&profiles, &first_slot_request),
        Some(profile),
        "published evidence should remain readable after the measuring task releases its active identity"
    );
    assert_eq!(
        read_published_loudness_profile_for_test(&profiles, &same_identity_request),
        Some(profile),
        "file path is transport cargo; loudness evidence identity is canonical source range"
    );
    assert_eq!(
        read_published_loudness_profile_for_test(&profiles, &other_range_request),
        None,
        "a different range must not inherit the first-slot loudness profile"
    );
}

#[test]
fn loudness_queue_insert_index_preserves_first_slot_priority_without_reversing_pending_fifo() {
    assert_eq!(
        loudness_queue_insert_index(
            [
                LoudnessEvidenceSource::PendingStore,
                LoudnessEvidenceSource::PendingStore,
            ],
            2,
            LoudnessEvidenceSource::PendingStore,
        ),
        2,
        "restored pending tasks should stay FIFO"
    );
    assert_eq!(
        loudness_queue_insert_index(
            [
                LoudnessEvidenceSource::PendingStore,
                LoudnessEvidenceSource::PendingStore,
            ],
            2,
            LoudnessEvidenceSource::DirectRequest,
        ),
        0,
        "direct playback requests should outrank restored pending tasks"
    );
    assert_eq!(
        loudness_queue_insert_index(
            [
                LoudnessEvidenceSource::DirectRequest,
                LoudnessEvidenceSource::DownloadedLeaf,
                LoudnessEvidenceSource::PendingStore,
            ],
            3,
            LoudnessEvidenceSource::DownloadedLeaf,
        ),
        1,
        "downloaded leaf evidence should stay behind playback requests but ahead of restored pending tasks"
    );
    assert_eq!(
        loudness_queue_insert_index(
            [
                LoudnessEvidenceSource::DirectRequest,
                LoudnessEvidenceSource::PendingStore,
            ],
            2,
            LoudnessEvidenceSource::FirstSlot,
        ),
        0,
        "prepared FirstSlot evidence should be measured before ordinary playback requests"
    );
    assert_eq!(
        loudness_queue_insert_index(
            [
                LoudnessEvidenceSource::FirstSlot,
                LoudnessEvidenceSource::DirectRequest,
                LoudnessEvidenceSource::PendingStore,
            ],
            3,
            LoudnessEvidenceSource::DirectRequest,
        ),
        1,
        "ordinary playback requests must not demote an already queued FirstSlot request"
    );
}

#[test]
fn all_explicit_loudness_cargo_sources_are_pending_restorable() {
    assert!(
        LoudnessEvidenceSource::DownloadedLeaf.persists_pending(),
        "downloaded leaf cargo must survive queue pressure because no library scan will recreate it"
    );
    assert!(
        LoudnessEvidenceSource::AudioTailTrim.persists_pending(),
        "tail-trim cargo must survive queue pressure because the trimmed identity is explicit cargo"
    );
    assert!(
        LoudnessEvidenceSource::DirectRequest.persists_pending(),
        "direct playback requests can be retried from pending after transient failures"
    );
    assert!(
        LoudnessEvidenceSource::FirstSlot.persists_pending(),
        "first-slot requests can be retried from pending without scanning the library"
    );
    assert!(
        !LoudnessEvidenceSource::PendingStore.persists_pending(),
        "restored pending tasks are already durable and must not rewrite themselves on restore"
    );
}

#[test]
fn loudness_error_classification_closes_only_terminal_or_stale_tasks() {
    assert!(
        should_close_loudness_request_after_error_for_test(&anyhow::anyhow!(
            "music loudness evidence target not found for https://example.com/watch 0..60000"
        )),
        "a task whose DB target no longer exists is stale and must be eliminated from pending"
    );
    assert!(
        should_close_loudness_request_after_error_for_test(&anyhow::anyhow!(
            "missing loudness evidence audio file C:/Media/Missing.m4a"
        )),
        "a missing audio file is terminal for this request cargo"
    );
    assert!(
        !should_close_loudness_request_after_error_for_test(&anyhow::anyhow!(
            "failed to write loudness evidence to database"
        )),
        "transient DB failures must keep the pending task for retry"
    );
}
