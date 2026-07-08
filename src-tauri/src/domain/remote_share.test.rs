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
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        next_token_id: 0,
    };
    session.create_audio_token(current);

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
    assert_eq!(commit.frontier.len(), 2);
    assert_eq!(commit.frontier[0].track.title, first_next.music_name);
    assert_eq!(commit.frontier[1].track.title, second_next.music_name);
    assert_eq!(session.audio_tokens.len(), 3);
    assert!(
        session
            .audio_tokens
            .values()
            .any(|token| matches!(token, RemoteAudioToken::Track(track) if same_remote_track(track, &current)))
    );
    assert!(
        session
            .audio_tokens
            .values()
            .any(|token| matches!(token, RemoteAudioToken::Track(track) if same_remote_track(track, &first_next)))
    );
    assert!(
        session
            .audio_tokens
            .values()
            .any(|token| matches!(token, RemoteAudioToken::Track(track) if same_remote_track(track, &second_next)))
    );
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
        RemoteAudioToken::Track(track) | RemoteAudioToken::HlsSegment { track, .. } => {
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
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
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
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
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
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        next_token_id: 0,
    };
    session.create_stream_url();

    let tracks = remote_hls_playlist_tracks(&mut session).expect("priming hls should be available");

    assert!(tracks.is_empty());
}

#[test]
fn remote_hls_prepare_preserves_stream_and_priming_tokens() {
    let current = test_track("current");
    let mut session = RemoteShareSession::default();
    let stream_url = session.create_stream_url();
    let priming_token = session.create_hls_priming_segment_token(0);
    let track_token = session.create_audio_token(current.clone());
    let segment_token = session.create_hls_segment_token(&current, PathBuf::from("current.ts"));

    session.reset_for_hls_prepare("playlist".to_string());

    assert_eq!(session.stream_url().as_deref(), Some(stream_url.as_str()));
    assert!(matches!(
        session.audio_tokens.get(&priming_token),
        Some(RemoteAudioToken::HlsPrimingSegment { index: 0 })
    ));
    assert!(!session.audio_tokens.contains_key(&track_token));
    assert!(!session.audio_tokens.contains_key(&segment_token));
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
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
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
        hls_priming_started_at: None,
        hls_priming_published_segments: 0,
        next_token_id: 0,
    };

    let stream_url = session.create_stream_url();
    let current_segment = session.create_hls_segment_token(&current, PathBuf::from("current.ts"));
    let next_segment = session.create_hls_segment_token(&next, PathBuf::from("next.ts"));
    session.create_audio_token(current.clone());
    session.create_audio_token(next.clone());

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
