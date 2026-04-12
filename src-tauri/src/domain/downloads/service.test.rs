use super::service::{materialize_music_entries, provider_segment, sanitize_path_component};
use super::yt_dlp::{LeafChapter, LeafProbe};

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
fn materialize_music_entries_expands_chapters_without_splitting_files() {
    let probe = LeafProbe {
        title: "Album".to_string(),
        webpage_url: "https://example.com/video".to_string(),
        extractor_key: Some("Youtube".to_string()),
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

    let musics = materialize_music_entries(&probe, "album.m4a");

    assert_eq!(musics.len(), 2);
    assert_eq!(musics[0].name, "Intro");
    assert_eq!(musics[1].name, "Main");
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
        duration_seconds: Some(245),
        chapters: vec![],
    };

    let musics = materialize_music_entries(&probe, "single-track.m4a");

    assert_eq!(musics.len(), 1);
    assert_eq!(musics[0].name, "Single Track");
    assert_eq!(musics[0].url, "https://example.com/video");
    assert_eq!(musics[0].path.as_deref(), Some("single-track.m4a"));
    assert_eq!(musics[0].start, 0);
    assert_eq!(musics[0].end, 245);
}
