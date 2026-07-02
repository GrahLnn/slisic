use super::*;
use std::path::PathBuf;

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
            .any(|token| same_remote_track(&token.track, &current))
    );
    assert!(
        session
            .audio_tokens
            .values()
            .any(|token| same_remote_track(&token.track, &first_next))
    );
    assert!(
        session
            .audio_tokens
            .values()
            .any(|token| same_remote_track(&token.track, &second_next))
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
    assert!(
        session
            .audio_tokens
            .values()
            .all(|token| !same_remote_track(&token.track, &stale_next))
    );
}
