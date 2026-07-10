use super::*;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const TEST_CLIENT_ID: &str = "client-a";

fn test_track(title: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "PlayList 1".to_string(),
        music_name: title.to_string(),
        canonical_music_id: format!("source:https://example.test/{title}:0:180000"),
        music_url: format!("https://example.test/{title}"),
        file_path: PathBuf::from(format!("C:/music/{title}.m4a")),
        source_music: None,
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
        loudness_profile: None,
    }
}

fn playing_sessions(current: PlaybackTrack) -> Arc<Mutex<RemoteShareSessions>> {
    let mut session = RemoteShareSession {
        connected: true,
        playlist_name: Some(current.playlist_name.clone()),
        current: Some(current.clone()),
        queue: VecDeque::new(),
        recently_played: vec![current.clone()],
        state: RemotePlaybackState::Playing,
        audio_tokens: HashMap::new(),
        stream_token: None,
        hls_timeline: Vec::new(),
        hls_current_index: None,
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        hls_entries: Vec::new(),
        session_epoch: 1,
        timeline_revision: 0,
        next_token_id: 0,
    };

    let mut sessions = RemoteShareSessions::default();
    sessions
        .by_client
        .insert(TEST_CLIENT_ID.to_string(), session);
    Arc::new(Mutex::new(sessions))
}

#[test]
fn remote_next_queue_refill_updates_only_the_current_track_session() {
    let current = test_track("current");
    let duplicate_current = current.clone();
    let first_next = test_track("first-next");
    let second_next = test_track("second-next");
    let sessions = playing_sessions(current.clone());

    let commit = commit_remote_next_queue_for_current(
        &sessions,
        TEST_CLIENT_ID,
        &current,
        vec![duplicate_current, first_next.clone(), second_next.clone()],
    )
    .expect("queue refill should not fail")
    .expect("matching playing session should accept refill");

    let sessions = sessions
        .lock()
        .expect("sessions lock should not be poisoned");
    let session = sessions
        .by_client
        .get(TEST_CLIENT_ID)
        .expect("session should remain present");

    assert_eq!(session.queue.len(), 2);
    assert_eq!(session.queue[0].music_name, first_next.music_name);
    assert_eq!(session.queue[1].music_name, second_next.music_name);
    assert_eq!(commit.prewarm_tracks.len(), 2);
    assert_eq!(commit.prewarm_tracks[0].music_name, first_next.music_name);
    assert_eq!(commit.prewarm_tracks[1].music_name, second_next.music_name);
    assert!(session.audio_tokens.is_empty());
}

#[test]
fn remote_next_queue_refill_discards_stale_session_results() {
    let old_current = test_track("old-current");
    let new_current = test_track("new-current");
    let stale_next = test_track("stale-next");
    let sessions = playing_sessions(old_current.clone());

    {
        let mut sessions = sessions
            .lock()
            .expect("sessions lock should not be poisoned");
        let session = sessions
            .by_client
            .get_mut(TEST_CLIENT_ID)
            .expect("session should remain present");
        session.current = Some(new_current.clone());
        session.recently_played.push(new_current.clone());
    }

    let retained_tracks = commit_remote_next_queue_for_current(
        &sessions,
        TEST_CLIENT_ID,
        &old_current,
        vec![stale_next.clone()],
    )
    .expect("queue refill should not fail");

    assert!(retained_tracks.is_none());
    let sessions = sessions
        .lock()
        .expect("sessions lock should not be poisoned");
    let session = sessions
        .by_client
        .get(TEST_CLIENT_ID)
        .expect("session should remain present");
    assert_eq!(session.queue.len(), 0);
    assert_eq!(
        session
            .current
            .as_ref()
            .map(|track| track.music_name.as_str()),
        Some(new_current.music_name.as_str())
    );
    assert!(session.audio_tokens.values().all(|token| match token {
        RemoteAudioToken::HlsSegment { track, .. } => {
            !same_remote_track(track, &stale_next)
        }
        RemoteAudioToken::HlsPlaylist | RemoteAudioToken::HlsPrimingSegment { .. } => true,
    }));
}

#[test]
fn remote_hls_timeline_starts_at_current_track() {
    let old = test_track("old");
    let current = test_track("current");
    let duplicate_current = current.clone();
    let next = test_track("next");
    let mut session = RemoteShareSession {
        connected: true,
        playlist_name: Some(current.playlist_name.clone()),
        current: Some(current.clone()),
        queue: VecDeque::from([duplicate_current, next.clone()]),
        recently_played: vec![old.clone(), current.clone()],
        state: RemotePlaybackState::Playing,
        audio_tokens: HashMap::new(),
        stream_token: None,
        hls_timeline: Vec::new(),
        hls_current_index: None,
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        hls_entries: Vec::new(),
        session_epoch: 1,
        timeline_revision: 0,
        next_token_id: 0,
    };

    let tracks = remote_hls_playlist_tracks(&mut session).expect("hls window should be available");

    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0].music_name, current.music_name);
    assert_eq!(tracks[1].music_name, next.music_name);
    assert!(tracks.iter().all(|track| !same_remote_track(track, &old)));
}

#[test]
fn remote_hls_stream_url_is_stable_for_the_session() {
    let current = test_track("current");
    let mut session = RemoteShareSession {
        connected: true,
        playlist_name: Some(current.playlist_name.clone()),
        current: Some(current),
        queue: VecDeque::new(),
        recently_played: Vec::new(),
        state: RemotePlaybackState::Playing,
        audio_tokens: HashMap::new(),
        stream_token: None,
        hls_timeline: Vec::new(),
        hls_current_index: None,
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        hls_entries: Vec::new(),
        session_epoch: 1,
        timeline_revision: 0,
        next_token_id: 0,
    };

    let first_url = session.create_stream_url();
    let second_url = session.create_stream_url();
    let first_token = first_url
        .strip_prefix("/api/audio/")
        .expect("first stream url should expose its token");
    let second_token = second_url
        .strip_prefix("/api/audio/")
        .expect("second stream url should expose its token");

    assert_eq!(first_token, second_token);
    assert!(matches!(
        session.audio_tokens.get(first_token),
        Some(RemoteAudioToken::HlsPlaylist)
    ));
}

#[test]
fn remote_hls_playlist_can_prime_before_current_track_exists() {
    let mut session = RemoteShareSession {
        connected: true,
        playlist_name: Some("playlist".to_string()),
        current: None,
        queue: VecDeque::new(),
        recently_played: Vec::new(),
        state: RemotePlaybackState::Preparing,
        audio_tokens: HashMap::new(),
        stream_token: None,
        hls_timeline: Vec::new(),
        hls_current_index: None,
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        hls_entries: Vec::new(),
        session_epoch: 1,
        timeline_revision: 0,
        next_token_id: 0,
    };
    session.create_stream_url();

    let tracks = remote_hls_playlist_tracks(&mut session).expect("priming hls should be available");

    assert!(tracks.is_empty());
}

#[test]
fn remote_hls_start_preserves_prepared_stream_and_priming_tokens() {
    let mut session = RemoteShareSession::default();
    session.reset_for_hls_prepare("playlist".to_string());
    session.begin_fresh_hls_epoch();
    let stream_url = session.stream_url().expect("prepared stream should exist");
    let priming_token = session.create_hls_priming_segment_token(0);

    session.reset_for_hls_start("playlist".to_string());

    assert_eq!(session.stream_url().as_deref(), Some(stream_url.as_str()));
    assert!(matches!(
        session.audio_tokens.get(&priming_token),
        Some(RemoteAudioToken::HlsPrimingSegment { index: 0 })
    ));
}

#[test]
fn remote_hls_fresh_prepare_replaces_previous_stream_tokens() {
    let mut session = RemoteShareSession::default();
    session.reset_for_hls_prepare("old".to_string());
    session.begin_fresh_hls_epoch();
    let old_stream_url = session.stream_url().expect("old stream should exist");
    let old_priming_token = session.create_hls_priming_segment_token(0);

    session.reset_for_hls_prepare("playlist".to_string());
    session.begin_fresh_hls_epoch();
    let new_stream_url = session.stream_url().expect("new stream should exist");
    let old_stream_token = old_stream_url
        .strip_prefix("/api/audio/")
        .expect("old stream url should expose its token");
    let new_stream_token = new_stream_url
        .strip_prefix("/api/audio/")
        .expect("new stream url should expose its token");

    assert_ne!(old_stream_url, new_stream_url);
    assert!(!session.audio_tokens.contains_key(old_stream_token));
    assert!(!session.audio_tokens.contains_key(&old_priming_token));
    assert!(matches!(
        session.audio_tokens.get(new_stream_token),
        Some(RemoteAudioToken::HlsPlaylist)
    ));
}

#[test]
fn remote_hls_priming_segment_is_a_transport_stream() {
    for index in 0..REMOTE_HLS_PRIMING_SEGMENTS.len() {
        let cargo = remote_hls_priming_segment_cargo(index).expect("priming segment should decode");

        assert_eq!(cargo.content_type, "video/mp2t");
        assert!(cargo.content_length > 0);
        assert!(!cargo.body.is_empty());
    }
}

#[test]
fn remote_hls_priming_window_extends_until_real_prefix_is_ready() {
    let mut session = RemoteShareSession::default();
    session.reset_for_hls_prepare("playlist".to_string());
    session.hls_priming_started_at = Some(Instant::now() - Duration::from_secs(12));

    let waiting_segments = session.advance_hls_priming_window(false);
    assert!(waiting_segments >= 18);

    session.hls_priming_started_at = Some(Instant::now() - Duration::from_secs(30));
    let ready_segments = session.advance_hls_priming_window(true);

    assert_eq!(ready_segments, waiting_segments);
}

#[test]
fn remote_hls_reader_accepts_partial_event_playlist_without_endlist() {
    let hls_dir =
        std::env::temp_dir().join(format!("slisic-remote-hls-partial-{}", std::process::id()));
    let _ = std_fs::remove_dir_all(&hls_dir);
    std_fs::create_dir_all(&hls_dir).expect("hls fixture dir should be created");
    let segment_path = hls_dir.join("segment00000.ts");
    std_fs::write(&segment_path, [0x47, 0x40, 0x11, 0x10])
        .expect("hls fixture segment should be written");
    let playlist_path = hls_dir.join("playlist.m3u8");
    std_fs::write(
        &playlist_path,
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.000,\nsegment00000.ts\n",
    )
    .expect("hls fixture playlist should be written");

    let asset = parse_remote_hls_track_asset(&playlist_path, &hls_dir)
        .expect("partial event hls should parse");

    assert_eq!(asset.target_duration, 2);
    assert_eq!(asset.segments.len(), 1);
    assert_eq!(asset.segments[0].duration_seconds, 2.0);

    let _ = std_fs::remove_dir_all(&hls_dir);
}

#[test]
fn remote_hls_timeline_appends_new_queue_without_replacing_the_stream() {
    let current = test_track("current");
    let first_next = test_track("first-next");
    let second_next = test_track("second-next");
    let mut session = RemoteShareSession {
        connected: true,
        playlist_name: Some(current.playlist_name.clone()),
        current: Some(current.clone()),
        queue: VecDeque::from([first_next.clone()]),
        recently_played: vec![current.clone()],
        state: RemotePlaybackState::Playing,
        audio_tokens: HashMap::new(),
        stream_token: None,
        hls_timeline: Vec::new(),
        hls_current_index: None,
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        hls_entries: Vec::new(),
        session_epoch: 1,
        timeline_revision: 0,
        next_token_id: 0,
    };

    let stream_url = session.create_stream_url();
    let first_window =
        remote_hls_playlist_tracks(&mut session).expect("first hls window should be available");
    assert_eq!(
        first_window
            .iter()
            .map(|track| track.music_name.as_str())
            .collect::<Vec<_>>(),
        vec!["current", "first-next"]
    );

    session.current = Some(first_next.clone());
    session.queue = VecDeque::from([second_next.clone()]);
    let second_window =
        remote_hls_playlist_tracks(&mut session).expect("second hls window should be available");

    assert_eq!(session.create_stream_url(), stream_url);
    assert_eq!(
        second_window
            .iter()
            .map(|track| track.music_name.as_str())
            .collect::<Vec<_>>(),
        vec!["current", "first-next", "second-next"]
    );
}

#[test]
fn remote_hls_timeline_keeps_repeated_track_occurrences() {
    let liked = test_track("liked");
    let bridge = test_track("bridge");
    let mut session = RemoteShareSession {
        connected: true,
        playlist_name: Some(liked.playlist_name.clone()),
        current: Some(liked.clone()),
        queue: VecDeque::from([bridge.clone()]),
        recently_played: vec![liked.clone()],
        state: RemotePlaybackState::Playing,
        audio_tokens: HashMap::new(),
        stream_token: None,
        hls_timeline: Vec::new(),
        hls_current_index: None,
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        hls_entries: Vec::new(),
        session_epoch: 1,
        timeline_revision: 0,
        next_token_id: 0,
    };

    remote_hls_playlist_tracks(&mut session).expect("first window should be available");
    session.current = Some(bridge);
    session.queue = VecDeque::from([liked]);
    let timeline =
        remote_hls_playlist_tracks(&mut session).expect("repeat window should be available");

    assert_eq!(
        timeline
            .iter()
            .map(|track| track.music_name.as_str())
            .collect::<Vec<_>>(),
        vec!["liked", "bridge", "liked"]
    );
    assert_eq!(session.hls_current_index, Some(1));
}

#[test]
fn remote_hls_published_timeline_is_append_only() {
    let first_track = test_track("first");
    let second_track = test_track("second");
    let first = RemoteHlsTimelineEntry {
        id: "0:first".to_string(),
        track: RemoteTrackView::from_track(&first_track),
        start_seconds: 4.0,
        end_seconds: 184.0,
    };
    let second = RemoteHlsTimelineEntry {
        id: "1:second".to_string(),
        track: RemoteTrackView::from_track(&second_track),
        start_seconds: 184.0,
        end_seconds: 364.0,
    };
    let mut session = RemoteShareSession::default();

    assert!(session.publish_hls_entries(vec![first.clone()]));
    assert!(session.publish_hls_entries(vec![first.clone(), second.clone()]));
    assert_eq!(session.timeline_revision, 2);
    assert!(!session.publish_hls_entries(vec![RemoteHlsTimelineEntry {
        start_seconds: 5.0,
        end_seconds: 185.0,
        ..first
    }]));
    assert_eq!(session.hls_entries.len(), 2);
    assert_eq!(session.hls_entries[1].id, second.id);
    assert_eq!(session.timeline_revision, 2);
}

#[test]
fn remote_hls_stream_token_survives_track_token_retention() {
    let current = test_track("current");
    let next = test_track("next");
    let mut session = RemoteShareSession {
        connected: true,
        playlist_name: Some(current.playlist_name.clone()),
        current: Some(current.clone()),
        queue: VecDeque::from([next.clone()]),
        recently_played: vec![current.clone()],
        state: RemotePlaybackState::Playing,
        audio_tokens: HashMap::new(),
        stream_token: None,
        hls_timeline: vec![current.clone(), next.clone()],
        hls_current_index: None,
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        hls_entries: Vec::new(),
        session_epoch: 1,
        timeline_revision: 0,
        next_token_id: 0,
    };

    let stream_url = session.create_stream_url();
    let current_segment = session.create_hls_segment_token(&current, PathBuf::from("current.ts"));
    let next_segment = session.create_hls_segment_token(&next, PathBuf::from("next.ts"));
    session.retain_audio_tokens_for_tracks(&[current.clone(), next.clone()]);

    let stream_token = stream_url
        .strip_prefix("/api/audio/")
        .expect("stream url should expose its token");
    assert!(matches!(
        session.audio_tokens.get(stream_token),
        Some(RemoteAudioToken::HlsPlaylist)
    ));
    assert!(matches!(
        session.audio_tokens.get(&current_segment),
        Some(RemoteAudioToken::HlsSegment { track, .. }) if same_remote_track(track, &current)
    ));
    assert!(matches!(
        session.audio_tokens.get(&next_segment),
        Some(RemoteAudioToken::HlsSegment { track, .. }) if same_remote_track(track, &next)
    ));
}

#[test]
fn remote_hls_segment_token_does_not_imply_playback_transition() {
    let current = test_track("current");
    let next = test_track("next");
    let mut session = RemoteShareSession {
        connected: true,
        playlist_name: Some(current.playlist_name.clone()),
        current: Some(current.clone()),
        queue: VecDeque::from([next.clone()]),
        recently_played: vec![current.clone()],
        state: RemotePlaybackState::Playing,
        audio_tokens: HashMap::new(),
        stream_token: None,
        hls_timeline: vec![current.clone(), next.clone()],
        hls_current_index: None,
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        hls_entries: Vec::new(),
        session_epoch: 1,
        timeline_revision: 0,
        next_token_id: 0,
    };

    session.create_hls_segment_token(&next, PathBuf::from("next.ts"));

    assert_eq!(
        session
            .current
            .as_ref()
            .map(|track| track.music_name.as_str()),
        Some("current")
    );
    assert_eq!(session.queue.len(), 1);
    assert_eq!(session.queue[0].music_name, next.music_name);
    assert_eq!(
        session
            .recently_played
            .iter()
            .map(|track| track.music_name.as_str())
            .collect::<Vec<_>>(),
        vec!["current"]
    );
}
