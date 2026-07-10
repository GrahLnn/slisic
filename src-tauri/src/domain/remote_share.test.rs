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
    let session = RemoteShareSession {
        connected: true,
        playlist_name: Some(current.playlist_name.clone()),
        current: Some(current.clone()),
        recently_played: vec![current],
        state: RemotePlaybackState::Playing,
        ..Default::default()
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
    let first_next = test_track("first-next");
    let second_next = test_track("second-next");
    let sessions = playing_sessions(current.clone());

    let committed = commit_remote_next_queue_for_current(
        &sessions,
        TEST_CLIENT_ID,
        &current,
        vec![current.clone(), first_next.clone(), second_next.clone()],
    )
    .expect("queue refill should not fail");

    assert!(committed.is_some());
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
}

#[test]
fn remote_next_queue_refill_discards_stale_session_results() {
    let old_current = test_track("old-current");
    let new_current = test_track("new-current");
    let sessions = playing_sessions(old_current.clone());
    sessions
        .lock()
        .expect("sessions lock should not be poisoned")
        .by_client
        .get_mut(TEST_CLIENT_ID)
        .expect("session should remain present")
        .current = Some(new_current.clone());

    let committed = commit_remote_next_queue_for_current(
        &sessions,
        TEST_CLIENT_ID,
        &old_current,
        vec![test_track("stale-next")],
    )
    .expect("queue refill should not fail");

    assert!(committed.is_none());
    let sessions = sessions
        .lock()
        .expect("sessions lock should not be poisoned");
    let session = sessions
        .by_client
        .get(TEST_CLIENT_ID)
        .expect("session should remain present");
    assert!(session.queue.is_empty());
    assert_eq!(
        session.current.as_ref().map(|track| &track.music_name),
        Some(&new_current.music_name)
    );
}

#[test]
fn remote_next_queue_refill_preserves_the_existing_forward_frontier() {
    let current = test_track("current");
    let existing = test_track("existing");
    let appended = test_track("appended");
    let sessions = playing_sessions(current.clone());
    sessions
        .lock()
        .expect("sessions lock should not be poisoned")
        .by_client
        .get_mut(TEST_CLIENT_ID)
        .expect("session should remain present")
        .queue
        .push_back(existing.clone());

    let committed = commit_remote_next_queue_for_current(
        &sessions,
        TEST_CLIENT_ID,
        &current,
        vec![existing.clone(), appended.clone()],
    )
    .expect("queue refill should not fail")
    .expect("queue refill should still target the active session");

    assert_eq!(committed.len(), 1);
    assert_eq!(committed[0].music_name, appended.music_name);
    let sessions = sessions
        .lock()
        .expect("sessions lock should not be poisoned");
    let queue = &sessions
        .by_client
        .get(TEST_CLIENT_ID)
        .expect("session should remain present")
        .queue;
    assert_eq!(queue[0].music_name, existing.music_name);
    assert_eq!(queue[1].music_name, appended.music_name);
}

#[test]
fn failed_hls_publication_rolls_back_only_its_new_queue_suffix() {
    let current = test_track("current");
    let existing = test_track("existing");
    let first = test_track("first");
    let second = test_track("second");
    let sessions = playing_sessions(current.clone());
    {
        let mut sessions_guard = sessions
            .lock()
            .expect("sessions lock should not be poisoned");
        let queue = &mut sessions_guard
            .by_client
            .get_mut(TEST_CLIENT_ID)
            .expect("session should remain present")
            .queue;
        queue.push_back(existing.clone());
        queue.push_back(first.clone());
        queue.push_back(second.clone());
    }

    rollback_remote_queue_append(&sessions, TEST_CLIENT_ID, &current, &[first, second]);

    let sessions = sessions
        .lock()
        .expect("sessions lock should not be poisoned");
    let queue = &sessions
        .by_client
        .get(TEST_CLIENT_ID)
        .expect("session should remain present")
        .queue;
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].music_name, existing.music_name);
}

#[test]
fn hls_boundary_identity_advances_repeated_tracks_exactly_once() {
    let repeated = test_track("repeated");
    let following = test_track("following");
    let mut session = RemoteShareSession {
        state: RemotePlaybackState::Playing,
        current: Some(repeated.clone()),
        current_hls_entry_id: Some("entry-1".to_owned()),
        queue: VecDeque::from([repeated.clone(), following]),
        ..Default::default()
    };

    assert!(session.commit_hls_boundary("entry-2", &repeated).unwrap());
    assert_eq!(session.current_hls_entry_id.as_deref(), Some("entry-2"));
    assert_eq!(session.queue.len(), 1);
    assert!(!session.commit_hls_boundary("entry-2", &repeated).unwrap());
    assert_eq!(session.queue.len(), 1);
}
