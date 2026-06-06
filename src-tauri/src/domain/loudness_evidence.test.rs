use super::{
    LoudnessEvidenceRequest, deduplicate_pending_loudness_requests_for_test,
    loudness_identity_key_for_test,
};
use std::path::PathBuf;

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
