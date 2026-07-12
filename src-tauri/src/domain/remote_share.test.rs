use super::*;
use futures_util::future::pending;
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

#[tokio::test]
async fn relay_write_timeout_releases_a_stuck_connection() {
    let result = await_remote_relay_write(
        pending::<std::result::Result<(), std::io::Error>>(),
        Duration::from_millis(10),
    )
    .await;

    assert_eq!(
        result
            .expect_err("a permanently pending write must be released")
            .to_string(),
        "remote relay write timed out"
    );
}

#[test]
fn relay_rpc_requests_use_the_nonblocking_dispatch_lane() {
    assert!(remote_relay_message_is_rpc_request(
        r#"{"kind":"rpc_request","id":"1","method":"session.start"}"#,
    ));
    assert!(!remote_relay_message_is_rpc_request(
        r#"{"kind":"p2p_signal","signal":{"type":"close"}}"#,
    ));
    assert!(!remote_relay_message_is_rpc_request("not-json"));
}

#[test]
fn adaptive_prefetch_target_is_bounded_and_owns_one_fill_at_a_time() {
    let current = test_track("current");
    let mut session = RemoteShareSession {
        current: Some(current.clone()),
        state: RemotePlaybackState::Playing,
        ..Default::default()
    };

    assert!(session.set_prefetch_target(1, usize::MAX));
    let plan = session
        .begin_queue_fill()
        .expect("larger inventory should request a fill");
    assert_eq!(plan.target_tracks, REMOTE_PREFETCH_MAX_FUTURE_TRACKS);
    assert!(plan.existing_queue.is_empty());
    assert!(session.begin_queue_fill().is_none());

    session.finish_queue_fill(&current);
    assert!(session.begin_queue_fill().is_some());
}

#[test]
fn lowering_prefetch_target_never_discards_an_already_published_frontier() {
    let current = test_track("current");
    let mut session = RemoteShareSession {
        current: Some(current),
        queue: VecDeque::from([
            test_track("future-1"),
            test_track("future-2"),
            test_track("future-3"),
        ]),
        state: RemotePlaybackState::Playing,
        prefetch_target_tracks: REMOTE_PREFETCH_MAX_FUTURE_TRACKS,
        ..Default::default()
    };

    assert!(session.set_prefetch_target(1, REMOTE_PREFETCH_MIN_FUTURE_TRACKS));
    assert_eq!(session.queue.len(), 3);
    assert!(session.begin_queue_fill().is_none());
}

#[test]
fn stale_unordered_prefetch_hint_cannot_shrink_newer_inventory() {
    let mut session = RemoteShareSession::default();

    assert!(session.set_prefetch_target(2, REMOTE_PREFETCH_MAX_FUTURE_TRACKS));
    assert!(!session.set_prefetch_target(1, REMOTE_PREFETCH_MIN_FUTURE_TRACKS));
    assert_eq!(
        session.prefetch_target_tracks,
        REMOTE_PREFETCH_MAX_FUTURE_TRACKS
    );
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
