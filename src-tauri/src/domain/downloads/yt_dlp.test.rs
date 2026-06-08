use super::model::CollectionSourceKind;
use super::yt_dlp::{
    RootProbe, build_leaf_audio_download_args, build_leaf_metadata_probe_args,
    build_root_playlist_probe_args, build_root_playlist_shell_probe_args, classify_root_preference,
    looks_like_direct_leaf_url, parse_leaf_probe, parse_progress_line, parse_root_probe,
    parse_root_shell_probe, resolve_downloaded_file,
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
fn classifies_plain_youtube_watch_url_as_single() {
    let url = "https://www.youtube.com/watch?v=ZE5zXLOyEOQ";

    assert!(looks_like_direct_leaf_url(url));
    assert_eq!(classify_root_preference(url), CollectionSourceKind::Single);
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
fn parses_nested_playlist_entries_as_playlist_urls_instead_of_failing() {
    let value = json!({
        "_type": "playlist",
        "title": "Channel Releases",
        "webpage_url": "https://www.youtube.com/channel/UCdemo",
        "entries": [
            {
                "_type": "playlist",
                "url": "OLAK5uy_nested_demo",
                "title": "Album One"
            }
        ]
    });

    let parsed = parse_root_probe(value, "https://www.youtube.com/channel/UCdemo")
        .expect("nested playlist entries should stay parseable");

    let RootProbe::List(playlist) = parsed else {
        panic!("expected playlist root probe");
    };

    assert_eq!(playlist.entries.len(), 1);
    assert_eq!(
        playlist.entries[0].url,
        "https://www.youtube.com/playlist?list=OLAK5uy_nested_demo"
    );
    assert_eq!(playlist.entries[0].title.as_deref(), Some("Album One"));
}

#[test]
fn parses_leaf_probe_with_chapters() {
    let value = json!({
        "title": "Leaf Title",
        "webpage_url": "https://www.youtube.com/watch?v=leaf1",
        "extractor_key": "Youtube",
        "album": "Album Title",
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
    assert_eq!(parsed.album.as_deref(), Some("Album Title"));
    assert_eq!(parsed.duration_ms, Some(301_200));
    assert_eq!(parsed.duration_seconds, Some(302));
    assert_eq!(parsed.chapters.len(), 2);
    assert_eq!(parsed.chapters[0].title, "Intro");
    assert_eq!(parsed.chapters[0].end_ms, 12_400);
}

#[test]
fn parses_selected_audio_duration_as_millisecond_boundary_evidence() {
    let value = json!({
        "title": "481772",
        "webpage_url": "https://www.youtube.com/watch?v=oFg0ABdknrQ",
        "extractor_key": "Youtube",
        "duration": 257,
        "requested_downloads": [
            {
                "format_id": "140",
                "ext": "m4a",
                "acodec": "mp4a.40.2",
                "vcodec": "none",
                "url": "https://rr1---sn.example/videoplayback?mime=audio%2Fmp4&dur=257.499&itag=140"
            }
        ]
    });

    let parsed = parse_leaf_probe(value).expect("leaf probe should parse");

    assert_eq!(parsed.duration_ms, Some(257_499));
    assert_eq!(parsed.duration_seconds, Some(258));
}

#[test]
fn collapses_single_full_duration_chapter_into_plain_leaf() {
    let value = json!({
        "title": "Leaf Title",
        "webpage_url": "https://www.youtube.com/watch?v=leaf1",
        "extractor_key": "Youtube",
        "duration": 245.0,
        "chapters": [
            {
                "title": "Leaf Title",
                "start_time": 0.0,
                "end_time": 245.0
            }
        ]
    });

    let parsed = parse_leaf_probe(value).expect("leaf probe should parse");

    assert_eq!(parsed.duration_ms, Some(245_000));
    assert_eq!(parsed.duration_seconds, Some(245));
    assert!(
        parsed.chapters.is_empty(),
        "single full-span pseudo chapter should collapse into plain leaf metadata"
    );
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

#[test]
fn leaf_metadata_probe_args_do_not_select_download_format() {
    let args = build_leaf_metadata_probe_args("https://www.youtube.com/watch?v=leaf1");

    assert!(args.iter().any(|arg| arg == "-J"));
    assert!(args.iter().any(|arg| arg == "--no-playlist"));
    assert!(
        !args.iter().any(|arg| arg == "--format"),
        "metadata probing must not fail because an audio download format is unavailable"
    );
    assert!(
        !args.iter().any(|arg| arg == "bestaudio[ext=m4a]/bestaudio"),
        "audio format selection belongs to the download lifecycle"
    );
}

#[test]
fn leaf_audio_download_args_select_audio_only_formats_before_extracting() {
    let args = build_leaf_audio_download_args(
        std::path::Path::new("C:/tools/ffmpeg"),
        "C:/music/%(ext)s",
        "https://www.youtube.com/watch?v=leaf1",
    );

    let format_index = args
        .iter()
        .position(|arg| arg == "--format")
        .expect("download args should choose a format explicitly");

    assert_eq!(
        args.get(format_index + 1).map(String::as_str),
        Some("bestaudio[ext=m4a]/bestaudio")
    );
    assert!(args.iter().any(|arg| arg == "--extract-audio"));
    assert!(
        !args.iter().any(|arg| arg.contains("bestvideo")),
        "audio downloads should never select a video stream"
    );
}

#[test]
fn rejects_partial_playlist_root_when_provider_reports_more_entries() {
    let value = json!({
        "_type": "playlist",
        "title": "Large Playlist",
        "webpage_url": "https://www.youtube.com/playlist?list=PLlarge",
        "playlist_count": 116,
        "entries": (0..100)
            .map(|index| {
                json!({
                    "_type": "url",
                    "url": format!("leaf{index:011}"),
                    "title": format!("Leaf {index}")
                })
            })
            .collect::<Vec<_>>()
    });

    let error = parse_root_probe(value, "https://www.youtube.com/playlist?list=PLlarge")
        .expect_err("partial playlist probes should fail explicitly");

    assert!(error.to_string().contains("100/116 playlist entries"));
}

#[test]
fn root_playlist_probe_args_request_youtube_continuation_pages() {
    let args = build_root_playlist_probe_args("https://www.youtube.com/playlist?list=PLPfHaI9XqTn");

    assert!(args.iter().any(|arg| arg == "--flat-playlist"));
    let playlist_items = args
        .windows(2)
        .find_map(|window| (window[0] == "--playlist-items").then_some(window[1].as_str()));
    assert!(playlist_items.is_none());
    let extractor_args = args
        .windows(2)
        .find_map(|window| (window[0] == "--extractor-args").then_some(window[1].as_str()))
        .expect("playlist probe should pass extractor args");
    assert!(extractor_args.contains("youtube:"));
    assert!(extractor_args.contains("playlist_ajax=true"));
    assert!(extractor_args.contains("tab_max_pages=50"));
}

#[test]
fn root_playlist_shell_probe_args_request_metadata_without_entries() {
    let args =
        build_root_playlist_shell_probe_args("https://www.youtube.com/playlist?list=PLPfHaI9XqTn");

    assert!(!args.iter().any(|arg| arg == "--flat-playlist"));
    let playlist_items = args
        .windows(2)
        .find_map(|window| (window[0] == "--playlist-items").then_some(window[1].as_str()))
        .expect("shell probe should explicitly suppress playlist item expansion");
    assert_eq!(playlist_items, "0");
}

#[test]
fn parses_playlist_shell_probe_without_entries() {
    let value = json!({
        "_type": "playlist",
        "title": "Large Playlist",
        "webpage_url": "https://www.youtube.com/playlist?list=PLlarge",
        "playlist_count": 312,
        "entries": []
    });

    let parsed = parse_root_shell_probe(value, "https://www.youtube.com/playlist?list=PLlarge")
        .expect("entryless shell metadata should parse");

    assert_eq!(parsed.source_kind, CollectionSourceKind::List);
    assert_eq!(parsed.title, "Large Playlist");
    assert_eq!(
        parsed.webpage_url,
        "https://www.youtube.com/playlist?list=PLlarge"
    );
}

#[test]
fn leaf_audio_download_args_allow_unicode_file_names() {
    let args = build_leaf_audio_download_args(
        std::path::Path::new("C:/tools/ffmpeg"),
        "C:/music/Ludwig Göransson.%(ext)s",
        "https://www.youtube.com/watch?v=leaf1",
    );

    assert!(args.iter().any(|arg| arg == "--no-restrict-filenames"));
    assert!(!args.iter().any(|arg| arg == "--restrict-filenames"));
}

#[test]
fn resolves_real_unicode_file_when_stdout_path_loses_diacritic() {
    let target_dir = std::env::temp_dir().join(format!(
        "slisic-yt-dlp-unicode-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&target_dir).expect("temp target dir should be created");

    let real_file_name =
        "TENET Official Soundtrack - MEETING NEIL - Ludwig Göransson.__slisic_tmp__6758e898.m4a";
    let file_stem =
        "TENET Official Soundtrack - MEETING NEIL - Ludwig Göransson.__slisic_tmp__6758e898";
    let corrupted_stdout_path = target_dir.join(
        "TENET Official Soundtrack - MEETING NEIL - Ludwig Gransson.__slisic_tmp__6758e898.m4a",
    );
    let real_path = target_dir.join(real_file_name);
    std::fs::write(&real_path, b"audio").expect("unicode temp file should be written");

    let resolved = resolve_downloaded_file(&target_dir, file_stem, Some(&corrupted_stdout_path))
        .expect("resolver should fall back to the real unicode file");

    assert_eq!(resolved, real_path);
    std::fs::remove_dir_all(&target_dir).expect("temp target dir should be removed");
}

#[test]
fn resolve_downloaded_file_rejects_partial_download_fragments() {
    let target_dir = std::env::temp_dir().join(format!(
        "slisic-yt-dlp-part-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&target_dir).expect("temp target dir should be created");

    let partial_path = target_dir.join("Track.__slisic_tmp__abc123.m4a.part");
    std::fs::write(&partial_path, b"partial").expect("partial download should be written");

    let resolved = resolve_downloaded_file(
        &target_dir,
        "Track.__slisic_tmp__abc123",
        Some(&partial_path),
    );

    assert_eq!(resolved, None);
    std::fs::remove_dir_all(&target_dir).expect("temp target dir should be removed");
}
