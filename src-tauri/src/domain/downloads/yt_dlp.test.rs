use super::model::CollectionSourceKind;
use super::yt_dlp::{
    RootProbe, classify_root_preference, looks_like_direct_leaf_url, parse_leaf_probe,
    parse_progress_line, parse_root_probe,
};
use serde_json::json;

#[test]
fn classifies_youtube_mix_watch_url_with_list_query_as_single() {
    let url = "https://www.youtube.com/watch?v=ZE5zXLOyEOQ&list=RDMMIHIRrASFLcg&index=3";

    assert!(looks_like_direct_leaf_url(url));
    assert_eq!(classify_root_preference(url), CollectionSourceKind::Single);
}

#[test]
fn classifies_explicit_youtube_playlist_watch_url_as_list() {
    let url = "https://www.youtube.com/watch?v=1xMRU4D9ODc&list=PLqWr7dyJNgLK45KSPhhti4FcWLhEWlegt";

    assert!(!looks_like_direct_leaf_url(url));
    assert_eq!(classify_root_preference(url), CollectionSourceKind::List);
}

#[test]
fn parses_playlist_root_and_expands_youtube_video_ids_into_watch_urls() {
    let value = json!({
        "_type": "playlist",
        "title": "Test Playlist",
        "webpage_url": "https://www.youtube.com/playlist?list=PL123",
        "extractor_key": "YoutubeTab",
        "entries": [
            {
                "_type": "url",
                "id": "abc12345678",
                "url": "abc12345678",
                "title": "First"
            },
            {
                "_type": "url",
                "webpage_url": "https://www.youtube.com/watch?v=def12345678",
                "title": "Second"
            }
        ]
    });

    let parsed = parse_root_probe(value, "https://www.youtube.com/playlist?list=PL123")
        .expect("playlist probe should parse");

    let RootProbe::List(playlist) = parsed else {
        panic!("expected playlist root probe");
    };

    assert_eq!(playlist.entries.len(), 2);
    assert_eq!(
        playlist.entries[0].url,
        "https://www.youtube.com/watch?v=abc12345678"
    );
    assert_eq!(
        playlist.entries[1].url,
        "https://www.youtube.com/watch?v=def12345678"
    );
}

#[test]
fn parses_leaf_probe_with_chapters() {
    let value = json!({
        "title": "Leaf Title",
        "webpage_url": "https://www.youtube.com/watch?v=leaf1",
        "extractor_key": "Youtube",
        "duration": 301.2,
        "chapters": [
            {
                "title": "Intro",
                "start_time": 0.0,
                "end_time": 12.4
            },
            {
                "title": "Main",
                "start_time": 12.4,
                "end_time": 301.2
            }
        ]
    });

    let parsed = parse_leaf_probe(value).expect("leaf probe should parse");

    assert_eq!(parsed.title, "Leaf Title");
    assert_eq!(parsed.duration_seconds, Some(302));
    assert_eq!(parsed.chapters.len(), 2);
    assert_eq!(parsed.chapters[0].title, "Intro");
    assert_eq!(parsed.chapters[0].end_seconds, 13);
}

#[test]
fn parses_structured_progress_template_lines() {
    let progress = parse_progress_line("progress:1024|2048|512|9|downloading")
        .expect("progress line should parse");

    assert_eq!(progress.downloaded_bytes, Some(1024));
    assert_eq!(progress.total_bytes, Some(2048));
    assert_eq!(progress.speed_bytes_per_second, Some(512));
    assert_eq!(progress.eta_seconds, Some(9));
    assert_eq!(progress.phase.as_deref(), Some("downloading"));
}
