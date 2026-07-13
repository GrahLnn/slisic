use super::recommendation::{
    AudioStyleCandidateSelectionSource, AudioStyleModelSnapshot,
    filter_recently_played_recommendation_candidates,
    recommendation_candidate_allowed_by_recent_history,
};
use super::service::{
    PlaylistInitialTrackRelease, PlaylistPlaybackRecentHistory, PlaylistPlaybackRecommendationMode,
    PlaylistPlaybackRecommendationRequest, PlaylistPlaybackRecommender,
    PlaylistQueueFillDemandWake, PlaylistQueueRecommendationReadiness,
    PlaylistTrackQueueRefreshOutcome, RandomPlaylistPlaybackRecommender,
    apply_initial_track_loudness_profile, audio_style_playlist_playback_proposal_is_complete,
    create_exclude_current_cargo_queue, create_start_anchor_playback_queue,
    exclude_current_next_cargo_queue, initial_track_release_requires_loudness_gate,
    place_track_at_queue_start, playlist_playback_proposal_contains_next_track,
    playlist_playback_queue_contains_next_track_after_anchor,
    playlist_selection_has_relevant_active_downloads, playlist_track_needs_loudness_evidence,
    prepared_first_track_can_replace_excluded_current,
    propose_audio_style_playlist_playback_queue_from_snapshots,
    propose_playlist_playback_queue_without_audio_style_model, propose_random_queue_after_exclude,
    resolve_playlist_playback_continuation_mode, resolve_playlist_playback_source_resolution,
    should_commit_playlist_queue_refresh, should_refresh_playlist_queue_for_anchor_after_startup,
    should_refresh_playlist_queue_for_same_anchor, should_retry_playlist_queue_fill_after_refresh,
    should_seed_playlist_next_from_prepared_pool, should_stop_playlist_queue_fill_after_refresh,
    shuffle_playback_tracks, wait_for_playlist_queue_fill_revision_or_poll,
};
use crate::domain::downloads::model::{
    DownloadLeaf, DownloadLeafStatus, DownloadTask, DownloadTaskStatus, DownloadTrigger,
};
use crate::domain::player::model::{PlaybackContinuationMode, PlaybackTrack};
use crate::domain::playlists::model::{
    CollectionGroupOwner, Group, LoudnessProfile, Music, canonical_music_id_for_source,
};
use crate::domain::playlists::repo::{
    PlaylistPlaybackCollectionRef, PlaylistPlaybackGroupRef, PlaylistPlaybackSelection,
    PlaylistPlaybackTrackSource,
};
use appdb::Id;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const TEST_EMBEDDING_WIDTH: usize = 64 * 2 + 64 * 2 + 64 * 64;

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("slisic_playlist_playback_service_test_{nanos}"))
}

fn playback_track(name: &str) -> PlaybackTrack {
    PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: name.to_string(),
        canonical_music_id: format!("source:https://example.com/{name}:0:60000"),
        music_url: format!("https://example.com/{name}"),
        file_path: PathBuf::from(format!("{name}.m4a")),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    }
}

fn test_embedding(active_index: usize) -> Vec<f32> {
    let mut values = vec![0.0; TEST_EMBEDDING_WIDTH];
    values[active_index] = 1.0;
    values
}

fn group(name: &str, url: &str, folder: &str) -> Group {
    Group {
        name: name.to_string(),
        url: url.to_string(),
        collection: CollectionGroupOwner {
            name: "Playback Test Collection".to_string(),
            url: "https://example.com/playback-test-collection".to_string(),
            folder: "youtube/playback-test-collection".to_string(),
            last_updated: "2026-05-27T00:00:00+00:00".to_string(),
            enable_updates: Some(false),
        },
        folder: folder.to_string(),
    }
}

fn music(name: &str, url: &str, path: &str, group: Group) -> Music {
    Music {
        occurrence_id: String::new(),
        name: name.to_string(),
        alias: name.to_string(),
        group,
        url: url.to_string(),
        canonical_music_id: canonical_music_id_for_source(&url.to_string(), 0, 180_000),
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
        loudness_profile: None,
    }
}

fn music_with_alias(name: &str, alias: &str, url: &str, path: &str, group: Group) -> Music {
    Music {
        occurrence_id: String::new(),
        name: name.to_string(),
        alias: alias.to_string(),
        group,
        url: url.to_string(),
        canonical_music_id: canonical_music_id_for_source(&url.to_string(), 0, 180_000),
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
        loudness_profile: None,
    }
}

fn download_task(
    url: &str,
    collection_url: Option<&str>,
    status: DownloadTaskStatus,
) -> DownloadTask {
    let mut task = DownloadTask::new(
        Id::from(format!("task-{}", url.len())),
        url.to_string(),
        DownloadTrigger::Manual,
    );
    task.collection_url = collection_url.map(str::to_string);
    task.status = status;
    task
}

fn playback_selection(
    playlist_name: &str,
    collection_url: &str,
    group_url: Option<&str>,
) -> PlaylistPlaybackSelection {
    PlaylistPlaybackSelection {
        playlist_name: playlist_name.to_string(),
        collections: vec![PlaylistPlaybackCollectionRef::new_for_test(
            "Album",
            collection_url,
            "youtube/album",
        )],
        groups: group_url
            .map(|url| {
                vec![PlaylistPlaybackGroupRef::new_for_test(
                    "Disc 1", url, "disc-1",
                )]
            })
            .unwrap_or_default(),
        extra: vec![],

        download_scopes: std::iter::once(collection_url.to_string())
            .chain(group_url.map(str::to_string))
            .collect(),
    }
}

fn playback_source(
    _collection_url: &str,
    collection_folder: &str,
    music: Music,
) -> PlaylistPlaybackTrackSource {
    PlaylistPlaybackTrackSource {
        collection_folder: collection_folder.to_string(),
        music,
    }
}

#[test]
fn playback_source_resolution_includes_group_only_sources() {
    let root = temp_root();
    let folder = "youtube/album";
    let audio_path = root.join(folder).join("disc-1").join("track-a.m4a");
    std::fs::create_dir_all(
        audio_path
            .parent()
            .expect("overlap audio parent directory should exist"),
    )
    .expect("overlap audio parent should be created");
    std::fs::write(&audio_path, b"ok").expect("overlap audio file should be created");

    let selection = playback_selection("Focus", "https://example.com/album", None);
    let track = music_with_alias(
        "Track A",
        "Track Alpha",
        "https://example.com/watch?v=track-a",
        "disc-1/track-a.m4a",
        group("Disc 1", "https://example.com/disc-1", "disc-1"),
    );

    let resolution = resolve_playlist_playback_source_resolution(
        &selection,
        vec![playback_source("https://example.com/album", folder, track)],
        &root,
    );

    assert_eq!(resolution.tracks.len(), 1);
    assert_eq!(resolution.tracks[0].music_name, "Track Alpha");
    assert_eq!(resolution.tracks[0].file_path, audio_path);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn playlist_selection_active_downloads_match_collection_and_group_domains() {
    let selection = playback_selection(
        "Focus",
        "https://example.com/album",
        Some("https://example.com/disc-1"),
    );
    let tasks = vec![
        download_task(
            "https://example.com/album",
            Some("https://example.com/album"),
            DownloadTaskStatus::Downloading,
        ),
        download_task(
            "https://example.com/disc-1",
            None,
            DownloadTaskStatus::Resolving,
        ),
        download_task(
            "https://example.com/other",
            Some("https://example.com/other"),
            DownloadTaskStatus::Downloading,
        ),
    ];

    assert!(playlist_selection_has_relevant_active_downloads(
        &selection, &tasks
    ));
}

#[test]
fn playlist_selection_active_downloads_match_explicit_parent_download_scope() {
    let selection = PlaylistPlaybackSelection {
        playlist_name: "Focus".to_string(),
        collections: vec![],
        groups: vec![PlaylistPlaybackGroupRef::new_for_test(
            "Disc 1",
            "https://example.com/album#disc-1",
            "disc-1",
        )],
        extra: vec![],

        download_scopes: vec![
            "https://example.com/album#disc-1".to_string(),
            "https://example.com/album".to_string(),
        ],
    };
    let tasks = vec![download_task(
        "https://example.com/album",
        Some("https://example.com/album"),
        DownloadTaskStatus::Persisting,
    )];

    assert!(playlist_selection_has_relevant_active_downloads(
        &selection, &tasks
    ));
}

#[test]
fn playlist_selection_waits_for_active_leaf_after_root_task_resolves() {
    let selection = playback_selection("Focus", "https://example.com/album", None);
    let mut task = download_task(
        "https://example.com/album",
        Some("https://example.com/album"),
        DownloadTaskStatus::Completed,
    );
    let mut leaf = DownloadLeaf::new("leaf-a", "https://example.com/watch?v=a", 0);
    leaf.status = DownloadLeafStatus::Downloading;
    task.leafs.push(leaf);

    assert!(playlist_selection_has_relevant_active_downloads(
        &selection,
        &[task]
    ));
}

#[test]
fn playlist_selection_waits_for_local_import_collection_scope() {
    let selection = playback_selection("Focus", "local://collection/pending", None);
    let mut task = download_task(
        "local://collection/pending",
        Some("local://collection/pending"),
        DownloadTaskStatus::Queued,
    );
    task.trigger = DownloadTrigger::LocalImport;

    assert!(playlist_selection_has_relevant_active_downloads(
        &selection,
        &[task]
    ));
}

#[test]
fn playlist_playback_always_starts_in_random_continuation_mode() {
    assert_eq!(
        resolve_playlist_playback_continuation_mode(),
        PlaybackContinuationMode::Random
    );
}

#[test]
fn playback_source_resolution_keeps_only_playable_sources_from_the_selection() {
    let root = temp_root();
    let folder = "youtube/album";
    let audio_path = root.join(folder).join("track-a.m4a");
    std::fs::create_dir_all(
        audio_path
            .parent()
            .expect("audio parent directory should exist"),
    )
    .expect("audio parent should be created");
    std::fs::write(&audio_path, b"ok").expect("audio file should be created");

    let disc = group("Disc 1", "https://example.com/disc-1", "disc-1");
    let selection = playback_selection("Focus", "https://example.com/album", None);
    let playable = music_with_alias(
        "Track A",
        "Track Alpha",
        "https://example.com/watch?v=track-a",
        "track-a.m4a",
        disc.clone(),
    );
    let missing_file = music(
        "Missing",
        "https://example.com/watch?v=missing",
        "missing.m4a",
        disc,
    );

    let resolution = resolve_playlist_playback_source_resolution(
        &selection,
        vec![
            playback_source("https://example.com/album", folder, playable),
            playback_source("https://example.com/album", folder, missing_file),
        ],
        &root,
    );

    assert_eq!(resolution.tracks.len(), 1);
    assert_eq!(resolution.tracks[0].music_name, "Track Alpha");
    assert_eq!(resolution.tracks[0].file_path, audio_path);
    assert!(resolution.failure_description.contains("checked_sources=2"));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn random_recommender_shuffle_preserves_candidate_identity_set() {
    let mut tracks = (0..8)
        .map(|index| PlaybackTrack {
            playlist_name: "Focus".to_string(),
            music_name: format!("Track {index}"),
            canonical_music_id: format!(
                "source:https://example.com/{index}:{}:{}",
                index * 1_000,
                index * 1_000 + 500
            ),
            music_url: format!("https://example.com/{index}"),
            file_path: PathBuf::from(format!("track-{index}.m4a")),
            start_ms: index * 1_000,
            end_ms: index * 1_000 + 500,
            source_music: None,
            liked: false,
            loudness_profile: None,
        })
        .collect::<Vec<_>>();
    let mut before = tracks
        .iter()
        .map(|track| {
            (
                track.music_url.clone(),
                track.file_path.clone(),
                track.start_ms,
                track.end_ms,
            )
        })
        .collect::<Vec<_>>();

    shuffle_playback_tracks(&mut tracks);

    let mut after = tracks
        .iter()
        .map(|track| {
            (
                track.music_url.clone(),
                track.file_path.clone(),
                track.start_ms,
                track.end_ms,
            )
        })
        .collect::<Vec<_>>();
    before.sort();
    after.sort();
    assert_eq!(after, before);
}

#[test]
fn random_recommender_keeps_current_track_at_the_queue_start() {
    let current_track = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Current".to_string(),
        canonical_music_id: "source:https://example.com/current:0:60000".to_string(),
        music_url: "https://example.com/current".to_string(),
        file_path: PathBuf::from("current.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };
    let next = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Next".to_string(),
        canonical_music_id: "source:https://example.com/next:0:60000".to_string(),
        music_url: "https://example.com/next".to_string(),
        file_path: PathBuf::from("next.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };

    let proposed =
        RandomPlaylistPlaybackRecommender.propose_queue(PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current_track.clone(),
            candidates: vec![current_track.clone(), next.clone()],
            recently_played_tracks: vec![],
        });
    let identity = proposed
        .iter()
        .map(|track| track.music_url.as_str())
        .collect::<std::collections::HashSet<_>>();

    assert_eq!(identity.len(), 2);
    assert!(identity.contains(current_track.music_url.as_str()));
    assert!(identity.contains(next.music_url.as_str()));
    assert_eq!(proposed[0].music_url, current_track.music_url);
}

#[test]
fn queue_start_projection_preserves_the_initial_playback_anchor() {
    let initial_track = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Initial".to_string(),
        canonical_music_id: "source:https://example.com/initial:0:60000".to_string(),
        music_url: "https://example.com/initial".to_string(),
        file_path: PathBuf::from("initial.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };
    let next = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Next".to_string(),
        canonical_music_id: "source:https://example.com/next:0:60000".to_string(),
        music_url: "https://example.com/next".to_string(),
        file_path: PathBuf::from("next.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };

    let reordered =
        place_track_at_queue_start(vec![next.clone(), initial_track.clone()], &initial_track);
    assert_eq!(reordered[0].music_url, initial_track.music_url);
    assert_eq!(reordered.len(), 2);

    let inserted = place_track_at_queue_start(vec![next.clone()], &initial_track);
    assert_eq!(inserted[0].music_url, initial_track.music_url);
    assert_eq!(inserted[1].music_url, next.music_url);
}

#[test]
fn start_anchor_playback_queue_contains_only_the_random_start_anchor() {
    let initial_track = playback_track("initial");

    let queue = create_start_anchor_playback_queue(initial_track.clone());

    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].music_url, initial_track.music_url);
}

#[test]
fn keep_current_queue_without_audio_style_model_uses_playlist_scoped_random_next_track() {
    let current = playback_track("current");
    let random_candidate = playback_track("random_candidate");

    let queue = propose_playlist_playback_queue_without_audio_style_model(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current.clone(),
            candidates: vec![random_candidate.clone()],
            recently_played_tracks: vec![],
        },
        PlaylistPlaybackRecommendationMode::KeepCurrent,
    );

    assert_eq!(queue.len(), 2);
    assert_eq!(queue[0].music_url, current.music_url);
    assert_eq!(queue[1].music_url, random_candidate.music_url);
}

#[test]
fn model_unavailable_queue_is_still_commit_ready_with_random_next_track() {
    let current = playback_track("current");
    let random_candidate = playback_track("random_candidate");
    let readiness = PlaylistQueueRecommendationReadiness::model_unavailable();

    let queue = propose_playlist_playback_queue_without_audio_style_model(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current,
            candidates: vec![random_candidate],
            recently_played_tracks: vec![],
        },
        PlaylistPlaybackRecommendationMode::KeepCurrent,
    );

    assert_eq!(
        readiness.diagnostic_status(),
        "playlist_playback_model_unavailable",
    );
    assert!(should_commit_playlist_queue_refresh(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &queue,
    ));
}

#[test]
fn exclude_current_queue_without_audio_style_model_keeps_explicit_random_recovery() {
    let current = playback_track("current");
    let fallback = playback_track("fallback");

    let queue = propose_playlist_playback_queue_without_audio_style_model(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current.clone(),
            candidates: vec![fallback.clone()],
            recently_played_tracks: vec![],
        },
        PlaylistPlaybackRecommendationMode::ExcludeCurrent,
    );

    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].music_url, fallback.music_url);
}

#[test]
fn random_recommender_after_exclude_does_not_reinsert_current_track() {
    let current = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Current".to_string(),
        canonical_music_id: "source:https://example.com/current:0:60000".to_string(),
        music_url: "https://example.com/current".to_string(),
        file_path: PathBuf::from("current.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };
    let next = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Next".to_string(),
        canonical_music_id: "source:https://example.com/next:0:60000".to_string(),
        music_url: "https://example.com/next".to_string(),
        file_path: PathBuf::from("next.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };

    let proposed = RandomPlaylistPlaybackRecommender.propose_queue_after_exclude(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current.clone(),
            candidates: vec![next.clone()],
            recently_played_tracks: vec![],
        },
    );

    assert_eq!(proposed.len(), 1);
    assert_eq!(proposed[0].music_url, next.music_url);
    assert!(
        !proposed
            .iter()
            .any(|track| track.music_url == current.music_url)
    );
}

#[test]
fn random_queue_after_exclude_filters_current_track_before_selecting_next() {
    let current = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Current".to_string(),
        canonical_music_id: "source:https://example.com/current:0:60000".to_string(),
        music_url: "https://example.com/current".to_string(),
        file_path: PathBuf::from("current.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };
    let next = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Next".to_string(),
        canonical_music_id: "source:https://example.com/next:0:60000".to_string(),
        music_url: "https://example.com/next".to_string(),
        file_path: PathBuf::from("next.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };
    let mut candidates = vec![current.clone(), next.clone(), current.clone()];

    let proposed = propose_random_queue_after_exclude(&mut candidates, &current);

    assert_eq!(proposed.len(), 1);
    assert_eq!(proposed[0].music_url, next.music_url);
    assert!(candidates.is_empty());
}

#[test]
fn random_recommender_keeps_current_track_ahead_of_newly_loaded_queue_window() {
    let current_track = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Current".to_string(),
        canonical_music_id: "source:https://example.com/current:0:60000".to_string(),
        music_url: "https://example.com/current".to_string(),
        file_path: PathBuf::from("current.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };
    let next = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Next".to_string(),
        canonical_music_id: "source:https://example.com/next:0:60000".to_string(),
        music_url: "https://example.com/next".to_string(),
        file_path: PathBuf::from("next.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };

    let proposed =
        RandomPlaylistPlaybackRecommender.propose_queue(PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current_track.clone(),
            candidates: vec![next.clone()],
            recently_played_tracks: vec![],
        });

    assert_eq!(proposed[0].music_url, current_track.music_url);
    assert_eq!(proposed[1].music_url, next.music_url);
}

#[test]
fn recommendation_history_excludes_played_non_liked_music() {
    let played = playback_track("played");
    let fresh = playback_track("fresh");

    let filtered = filter_recently_played_recommendation_candidates(
        vec![played.clone(), fresh.clone()],
        std::slice::from_ref(&played),
    );

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].music_url, fresh.music_url);
}

#[test]
fn recommendation_history_excludes_same_played_music_across_track_ranges() {
    let played = playback_track("played");
    let mut same_music_other_range = playback_track("played_other_range");
    same_music_other_range.canonical_music_id = played.canonical_music_id.clone();
    same_music_other_range.music_url = "https://example.com/played?range=2".to_string();
    same_music_other_range.file_path = PathBuf::from("played-other-range.m4a");
    same_music_other_range.start_ms = 60_000;
    same_music_other_range.end_ms = 120_000;
    let fresh = playback_track("fresh");

    let filtered = filter_recently_played_recommendation_candidates(
        vec![same_music_other_range, fresh.clone()],
        std::slice::from_ref(&played),
    );

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].music_url, fresh.music_url);
}

#[test]
fn recommendation_history_keeps_liked_played_music() {
    let mut liked = playback_track("liked");
    liked.liked = true;
    let fresh = playback_track("fresh");

    let filtered = filter_recently_played_recommendation_candidates(
        vec![liked.clone(), fresh.clone()],
        std::slice::from_ref(&liked),
    );

    assert_eq!(filtered.len(), 2);
    assert!(
        filtered
            .iter()
            .any(|track| track.music_url == liked.music_url)
    );
    assert!(
        filtered
            .iter()
            .any(|track| track.music_url == fresh.music_url)
    );
}

#[test]
fn recent_history_observe_moves_replayed_track_to_latest_event_position() {
    let first = playback_track("first");
    let second = playback_track("second");
    let third = playback_track("third");
    let mut history = PlaylistPlaybackRecentHistory::from_initial_track(first.clone());

    history.observe(second.clone());
    history.observe(third.clone());
    history.observe(first.clone());

    let snapshot = history.snapshot();

    assert_eq!(snapshot.len(), 3);
    assert_eq!(snapshot[0].music_url, second.music_url);
    assert_eq!(snapshot[1].music_url, third.music_url);
    assert_eq!(snapshot[2].music_url, first.music_url);
}

#[test]
fn recommendation_history_falls_back_when_every_candidate_was_recently_played() {
    let played = playback_track("played");

    let filtered = filter_recently_played_recommendation_candidates(
        vec![played.clone()],
        std::slice::from_ref(&played),
    );

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].music_url, played.music_url);
}

#[test]
fn prepared_next_candidate_does_not_use_list_history_fallback_for_single_recent_track() {
    let played = playback_track("played");
    let fresh = playback_track("fresh");

    assert!(!recommendation_candidate_allowed_by_recent_history(
        &played,
        std::slice::from_ref(&played),
    ));
    assert!(recommendation_candidate_allowed_by_recent_history(
        &fresh,
        std::slice::from_ref(&played),
    ));
}

#[test]
fn prepared_next_candidate_keeps_recent_liked_track_sampleable() {
    let mut liked = playback_track("liked");
    liked.liked = true;

    assert!(recommendation_candidate_allowed_by_recent_history(
        &liked,
        std::slice::from_ref(&liked),
    ));
}

#[test]
fn random_recommender_uses_recent_history_before_selecting_next() {
    let current = playback_track("current");
    let played = playback_track("played");
    let fresh = playback_track("fresh");

    let proposed =
        RandomPlaylistPlaybackRecommender.propose_queue(PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current.clone(),
            candidates: vec![played.clone(), fresh.clone()],
            recently_played_tracks: vec![played.clone()],
        });

    assert_eq!(proposed.len(), 2);
    assert_eq!(proposed[0].music_url, current.music_url);
    assert_eq!(proposed[1].music_url, fresh.music_url);
}

#[test]
fn start_anchor_queue_contains_only_the_resolved_initial_track() {
    let current = playback_track("current");

    let queue = create_start_anchor_playback_queue(current.clone());

    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].music_url, current.music_url);
}

#[test]
fn playlist_playback_keep_current_proposal_without_next_track_is_not_complete() {
    let current_track = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Current".to_string(),
        canonical_music_id: "source:https://example.com/current:0:60000".to_string(),
        music_url: "https://example.com/current".to_string(),
        file_path: PathBuf::from("current.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };

    assert!(!playlist_playback_proposal_contains_next_track(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &[current_track]
    ));
}

#[test]
fn playlist_playback_keep_current_proposal_with_distinct_next_track_is_complete() {
    let current_track = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Current".to_string(),
        canonical_music_id: "source:https://example.com/current:0:60000".to_string(),
        music_url: "https://example.com/current".to_string(),
        file_path: PathBuf::from("current.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };
    let next = PlaybackTrack {
        playlist_name: "Focus".to_string(),
        music_name: "Next".to_string(),
        canonical_music_id: "source:https://example.com/next:0:60000".to_string(),
        music_url: "https://example.com/next".to_string(),
        file_path: PathBuf::from("next.m4a"),
        start_ms: 0,
        end_ms: 60_000,
        source_music: None,
        liked: false,
        loudness_profile: None,
    };

    assert!(playlist_playback_proposal_contains_next_track(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &[current_track, next]
    ));
}

#[test]
fn playlist_queue_next_check_uses_active_anchor_not_first_track() {
    let previous = playback_track("previous");
    let active = playback_track("active");

    assert!(!playlist_playback_queue_contains_next_track_after_anchor(
        &[previous, active.clone()],
        &active,
    ));
}

#[test]
fn playlist_queue_next_check_requires_anchor_presence() {
    let active = playback_track("active");
    let next = playback_track("next");

    assert!(!playlist_playback_queue_contains_next_track_after_anchor(
        &[next],
        &active,
    ));
}

#[test]
fn playlist_queue_next_check_accepts_distinct_track_after_anchor() {
    let previous = playback_track("previous");
    let active = playback_track("active");
    let next = playback_track("next");

    assert!(playlist_playback_queue_contains_next_track_after_anchor(
        &[previous, active.clone(), next],
        &active,
    ));
}

#[test]
fn exclude_current_session_next_uses_only_tracks_after_active_anchor() {
    let previous = playback_track("previous");
    let active = playback_track("active");
    let next = playback_track("next");

    let tracks = [previous, active.clone(), next.clone()];
    let cargo = exclude_current_next_cargo_queue(&tracks, &active);

    assert_eq!(cargo.len(), 2);
    assert_eq!(cargo[0].music_url, active.music_url);
    assert_eq!(cargo[1].music_url, next.music_url);
}

#[test]
fn exclude_current_session_next_is_empty_when_anchor_is_missing() {
    let previous = playback_track("previous");
    let active = playback_track("active");
    let next = playback_track("next");

    let tracks = [previous, next];
    let cargo = exclude_current_next_cargo_queue(&tracks, &active);

    assert!(cargo.is_empty());
}

#[test]
fn exclude_current_session_next_skips_duplicate_anchor_entries() {
    let active = playback_track("active");
    let next = playback_track("next");

    let tracks = [active.clone(), active.clone(), next.clone()];
    let cargo = exclude_current_next_cargo_queue(&tracks, &active);

    assert_eq!(cargo.len(), 2);
    assert_eq!(cargo[0].music_url, active.music_url);
    assert_eq!(cargo[1].music_url, next.music_url);
}

#[test]
fn exclude_current_session_next_is_empty_when_only_duplicate_anchor_entries_remain() {
    let active = playback_track("active");

    let tracks = [active.clone(), active.clone()];
    let cargo = exclude_current_next_cargo_queue(&tracks, &active);

    assert!(cargo.is_empty());
}

#[test]
fn exclude_current_first_cargo_queue_keeps_current_anchor_before_first() {
    let current = playback_track("current");
    let first = playback_track("first");

    let cargo = create_exclude_current_cargo_queue(current.clone(), first.clone());

    assert_eq!(cargo.len(), 2);
    assert_eq!(cargo[0].music_url, current.music_url);
    assert_eq!(cargo[1].music_url, first.music_url);
}

#[test]
fn exclude_current_first_replacement_must_not_be_the_excluded_current_track() {
    let current = playback_track("current");
    let first = playback_track("first");

    assert!(!prepared_first_track_can_replace_excluded_current(
        &current, &current,
    ));
    assert!(prepared_first_track_can_replace_excluded_current(
        &first, &current,
    ));
}

#[test]
fn playlist_queue_fill_retries_same_anchor_until_next_track_exists() {
    let current = playback_track("current");

    assert!(should_refresh_playlist_queue_for_anchor_after_startup(
        Some(&current),
        &current,
        false,
    ));
    assert!(!should_refresh_playlist_queue_for_anchor_after_startup(
        Some(&current),
        &current,
        true,
    ));
}

#[test]
fn playlist_queue_fill_does_not_replan_startup_anchor_when_startup_next_exists() {
    let current = playback_track("current");

    assert!(!should_refresh_playlist_queue_for_anchor_after_startup(
        None, &current, true,
    ));
}

#[test]
fn playlist_queue_fill_repairs_startup_anchor_when_startup_next_is_missing() {
    let current = playback_track("current");

    assert!(should_refresh_playlist_queue_for_anchor_after_startup(
        None, &current, false,
    ));
}

#[test]
fn playlist_queue_fill_refreshes_when_anchor_changes_even_if_queue_has_next() {
    let current = playback_track("current");
    let next = playback_track("next");

    assert!(should_refresh_playlist_queue_for_anchor_after_startup(
        Some(&current),
        &next,
        true,
    ));
}

#[test]
fn playlist_queue_fill_keeps_unconsumed_next_when_audio_style_model_generation_changes() {
    let current = playback_track("current");

    assert!(!should_refresh_playlist_queue_for_anchor_after_startup(
        Some(&current),
        &current,
        true,
    ));
}

#[test]
fn playlist_queue_refresh_for_same_anchor_only_runs_when_next_is_missing() {
    assert!(should_refresh_playlist_queue_for_same_anchor(false));
    assert!(!should_refresh_playlist_queue_for_same_anchor(true));
}

#[test]
fn playlist_queue_fill_uses_prepared_first_slot_only_after_proposal_misses_next() {
    assert!(should_seed_playlist_next_from_prepared_pool(false));
    assert!(!should_seed_playlist_next_from_prepared_pool(true));
}

#[tokio::test]
async fn playlist_queue_fill_wait_polls_when_revision_signal_was_missed() {
    let outcome =
        wait_for_playlist_queue_fill_revision_or_poll(std::future::pending::<Result<(), ()>>(), 1)
            .await;

    assert_eq!(outcome, PlaylistQueueFillDemandWake::PollElapsed);
}

#[test]
fn playlist_queue_fill_retries_immediately_when_refresh_result_is_stale_anchor() {
    assert!(should_retry_playlist_queue_fill_after_refresh(
        PlaylistTrackQueueRefreshOutcome::StaleAnchor
    ));
    assert!(!should_retry_playlist_queue_fill_after_refresh(
        PlaylistTrackQueueRefreshOutcome::Committed
    ));
    assert!(!should_retry_playlist_queue_fill_after_refresh(
        PlaylistTrackQueueRefreshOutcome::NoCandidates
    ));
    assert!(!should_retry_playlist_queue_fill_after_refresh(
        PlaylistTrackQueueRefreshOutcome::MissingNext
    ));
}

#[test]
fn playlist_queue_fill_stops_when_no_distinct_next_candidate_exists() {
    assert!(should_stop_playlist_queue_fill_after_refresh(
        PlaylistTrackQueueRefreshOutcome::NoCandidates,
    ));
    assert!(should_stop_playlist_queue_fill_after_refresh(
        PlaylistTrackQueueRefreshOutcome::NoDistinctCandidate,
    ));
    assert!(!should_stop_playlist_queue_fill_after_refresh(
        PlaylistTrackQueueRefreshOutcome::MissingNext,
    ));
}

#[test]
fn playlist_track_loudness_warmup_requires_missing_evidence_and_real_file() {
    let root = temp_root();
    std::fs::create_dir_all(&root).expect("temp root should be created");
    let file_path = root.join("next.m4a");
    std::fs::write(&file_path, []).expect("test audio placeholder should exist");

    let mut missing = playback_track("next");
    missing.file_path = file_path.clone();
    assert!(playlist_track_needs_loudness_evidence(&missing));

    let mut measured = missing.clone();
    measured.loudness_profile = LoudnessProfile::from_integrated_lufs(-21.0);
    assert!(!playlist_track_needs_loudness_evidence(&measured));

    let mut invalid_range = missing.clone();
    invalid_range.end_ms = invalid_range.start_ms;
    assert!(!playlist_track_needs_loudness_evidence(&invalid_range));

    let mut missing_file = missing;
    missing_file.file_path = root.join("missing.m4a");
    assert!(!playlist_track_needs_loudness_evidence(&missing_file));

    std::fs::remove_dir_all(root).expect("temp root should be removed");
}

#[test]
fn initial_first_slot_release_waits_for_loudness_evidence() {
    let root = temp_root();
    std::fs::create_dir_all(&root).expect("temp root should be created");
    let file_path = root.join("direct-first.m4a");
    std::fs::write(&file_path, []).expect("test audio placeholder should exist");
    let mut track = playback_track("direct-first");
    track.file_path = file_path;

    assert!(playlist_track_needs_loudness_evidence(&track));
    assert!(
        initial_track_release_requires_loudness_gate(
            PlaylistInitialTrackRelease::DirectFirstSlot,
            &track,
        ),
        "prepared FirstSlot cargo is not release-ready until its normalization evidence is ready"
    );
    assert!(
        initial_track_release_requires_loudness_gate(
            PlaylistInitialTrackRelease::PreparingFirstSlot,
            &track,
        ),
        "preparing owns the wait because no normalized cargo has been released to player yet"
    );

    std::fs::remove_dir_all(root).expect("temp root should be removed");
}

#[test]
fn preparing_initial_track_requires_loudness_before_playback_gate_opens() {
    let root = temp_root();
    std::fs::create_dir_all(&root).expect("temp root should be created");
    let file_path = root.join("first.m4a");
    std::fs::write(&file_path, []).expect("test audio placeholder should exist");
    let mut track = playback_track("first");
    track.file_path = file_path;

    assert!(
        apply_initial_track_loudness_profile(track.clone(), None).is_err(),
        "preparing must not release a track that still needs LUFS evidence"
    );
    assert!(
        apply_initial_track_loudness_profile(
            track.clone(),
            LoudnessProfile::from_integrated_lufs(0.0)
        )
        .is_err(),
        "zero LUFS is missing evidence, not a playable normalization value"
    );

    let ready =
        apply_initial_track_loudness_profile(track, LoudnessProfile::from_integrated_lufs(-13.0))
            .expect("finite non-zero LUFS should release the preparing gate");
    assert_eq!(
        ready
            .loudness_profile
            .expect("ready track should carry loudness profile")
            .integrated_lufs,
        -13.0
    );

    std::fs::remove_dir_all(root).expect("temp root should be removed");
}

#[test]
fn preparing_initial_track_loudness_updates_source_music_cargo() {
    let root = temp_root();
    std::fs::create_dir_all(&root).expect("temp root should be created");
    let file_path = root.join("first-source.m4a");
    std::fs::write(&file_path, []).expect("test audio placeholder should exist");
    let source_music = music(
        "first-source",
        "https://example.com/first-source",
        "first-source.m4a",
        group("G", "https://example.com/g", "g"),
    );
    let mut track = playback_track("first-source");
    track.file_path = file_path;
    track.source_music = Some(Box::new(source_music));

    let ready =
        apply_initial_track_loudness_profile(track, LoudnessProfile::from_integrated_lufs(-17.5))
            .expect("finite non-zero LUFS should update source cargo");

    assert_eq!(
        ready
            .loudness_profile
            .expect("ready track should carry loudness profile")
            .integrated_lufs,
        -17.5
    );
    assert_eq!(
        ready
            .source_music
            .as_ref()
            .expect("source music should stay attached")
            .loudness_profile
            .expect("source music should carry loudness profile")
            .integrated_lufs,
        -17.5
    );

    std::fs::remove_dir_all(root).expect("temp root should be removed");
}

#[test]
fn playlist_queue_refresh_commit_requires_next_track() {
    let current = playback_track("current");
    let next = playback_track("next");

    assert!(!should_commit_playlist_queue_refresh(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &[current.clone()],
    ));
    assert!(should_commit_playlist_queue_refresh(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &[current, next],
    ));
}

#[test]
fn playlist_queue_recommendation_readiness_reports_model_state_without_owning_training() {
    assert_eq!(
        PlaylistQueueRecommendationReadiness::model_unavailable().diagnostic_status(),
        "playlist_playback_model_unavailable",
    );
    assert_eq!(
        PlaylistQueueRecommendationReadiness::missing_current_embedding(7).diagnostic_status(),
        "playlist_playback_missing_current_embedding",
    );
    assert_eq!(
        PlaylistQueueRecommendationReadiness::ready(8).diagnostic_status(),
        "playlist_playback_ready",
    );
}

#[test]
fn keep_current_audio_style_random_fallback_source_is_not_a_complete_recommendation() {
    let current_track = playback_track("current");
    let candidate = playback_track("candidate");

    assert!(!audio_style_playlist_playback_proposal_is_complete(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &[current_track, candidate],
        Some(AudioStyleCandidateSelectionSource::RandomFallback),
    ));
}

#[test]
fn keep_current_audio_style_source_is_a_complete_recommendation_with_distinct_next() {
    let current_track = playback_track("current");
    let candidate = playback_track("candidate");

    assert!(audio_style_playlist_playback_proposal_is_complete(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &[current_track, candidate],
        Some(AudioStyleCandidateSelectionSource::AudioStyle),
    ));
}

#[test]
fn keep_current_audio_style_proposal_falls_back_to_older_complete_snapshot() {
    let current = playback_track("current");
    let unusable_next = playback_track("unusable_next");
    let older_next = playback_track("older_next");
    let latest = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        12,
        [(current.clone(), test_embedding(2))],
    ));
    let older = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        11,
        [
            (current.clone(), test_embedding(2)),
            (older_next.clone(), test_embedding(2)),
        ],
    ));

    let proposal = propose_audio_style_playlist_playback_queue_from_snapshots(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current.clone(),
            candidates: vec![unusable_next, older_next.clone()],
            recently_played_tracks: vec![],
        },
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        [latest, older],
    )
    .expect("older complete audio-style snapshot should still serve the queue");

    assert_eq!(proposal.tracks.len(), 2);
    assert_eq!(proposal.tracks[0].music_url, current.music_url);
    assert_eq!(proposal.tracks[1].music_url, older_next.music_url);
    assert_eq!(
        proposal
            .selection
            .as_ref()
            .map(|selection| selection.source),
        Some(AudioStyleCandidateSelectionSource::AudioStyle)
    );
    assert_eq!(
        proposal
            .selection
            .as_ref()
            .and_then(|selection| selection.model_generation),
        Some(11)
    );
}

#[test]
fn keep_current_audio_style_proposal_uses_centerless_next_when_anchor_is_missing() {
    let current = playback_track("current");
    let embedded_next = playback_track("embedded_next");
    let embedded_other = playback_track("embedded_other");
    let missing_next = playback_track("missing_next");
    let snapshot = std::sync::Arc::new(AudioStyleModelSnapshot::from_test_embeddings(
        12,
        [
            (embedded_next.clone(), test_embedding(2)),
            (embedded_other.clone(), test_embedding(3)),
        ],
    ));

    let proposal = propose_audio_style_playlist_playback_queue_from_snapshots(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current.clone(),
            candidates: vec![missing_next, embedded_next.clone(), embedded_other],
            recently_played_tracks: vec![],
        },
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        [snapshot],
    )
    .expect("stable model should still serve centerless next when anchor lacks embedding");

    assert_eq!(proposal.tracks.len(), 2);
    assert_eq!(proposal.tracks[0].music_url, current.music_url);
    assert!(
        proposal.tracks[1].music_url == embedded_next.music_url
            || proposal.tracks[1].music_url == "https://example.com/embedded_other"
    );
    assert_eq!(
        proposal
            .selection
            .as_ref()
            .map(|selection| selection.source),
        Some(AudioStyleCandidateSelectionSource::AudioStyle)
    );
    assert_eq!(
        proposal
            .selection
            .as_ref()
            .and_then(|selection| selection.model_generation),
        Some(12)
    );
}
