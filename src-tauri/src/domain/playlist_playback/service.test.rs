use super::recommendation::{
    AudioStyleCandidateSelectionSource, filter_recently_played_recommendation_candidates,
};
use super::service::{
    PlaylistPlaybackRecommendationMode, PlaylistPlaybackRecommendationRequest,
    PlaylistPlaybackRecommender, RandomPlaylistPlaybackRecommender,
    audio_style_playlist_playback_proposal_is_complete, create_short_playback_queue,
    create_start_anchor_playback_queue, place_track_at_queue_start,
    playlist_playback_proposal_contains_next_track,
    playlist_selection_has_relevant_active_downloads,
    propose_playlist_playback_queue_without_audio_style_model, propose_random_queue_after_exclude,
    resolve_playlist_playback_continuation_mode, resolve_playlist_playback_source_resolution,
    shuffle_playback_tracks,
};
use crate::domain::downloads::model::{DownloadTask, DownloadTaskStatus, DownloadTrigger};
use crate::domain::player::model::{PlaybackContinuationMode, PlaybackTrack};
use crate::domain::playlists::model::{
    CollectionGroupOwner, Group, Music, canonical_music_id_for_source,
};
use crate::domain::playlists::repo::{
    PlaylistPlaybackCollectionRef, PlaylistPlaybackGroupRef, PlaylistPlaybackSelection,
    PlaylistPlaybackTrackSource,
};
use appdb::Id;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

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
    }
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
        name: name.to_string(),
        alias: name.to_string(),
        group,
        url: url.to_string(),
        canonical_music_id: canonical_music_id_for_source(&url.to_string(), 0, 180_000),
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
    }
}

fn music_with_alias(name: &str, alias: &str, url: &str, path: &str, group: Group) -> Music {
    Music {
        name: name.to_string(),
        alias: alias.to_string(),
        group,
        url: url.to_string(),
        canonical_music_id: canonical_music_id_for_source(&url.to_string(), 0, 180_000),
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 180_000,
        liked: false,
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
fn recommended_startup_queue_keeps_random_anchor_before_recommended_next() {
    let initial_track = playback_track("initial");
    let recommended_next = playback_track("recommended_next");
    let queue = create_short_playback_queue(initial_track.clone(), vec![recommended_next.clone()]);

    assert_eq!(queue.len(), 2);
    assert_eq!(queue[0].music_url, initial_track.music_url);
    assert_eq!(queue[1].music_url, recommended_next.music_url);
}

#[test]
fn keep_current_queue_without_audio_style_model_does_not_randomize_next_track() {
    let current = playback_track("current");
    let random_candidate = playback_track("random_candidate");

    let queue = propose_playlist_playback_queue_without_audio_style_model(
        PlaylistPlaybackRecommendationRequest {
            playlist_name: "Focus".to_string(),
            current_track: current.clone(),
            candidates: vec![random_candidate],
            recently_played_tracks: vec![],
        },
        PlaylistPlaybackRecommendationMode::KeepCurrent,
    );

    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].music_url, current.music_url);
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
fn recommendation_history_excludes_recent_non_liked_candidates() {
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
fn recommendation_history_keeps_liked_recent_candidates() {
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
    };

    assert!(playlist_playback_proposal_contains_next_track(
        PlaylistPlaybackRecommendationMode::KeepCurrent,
        &[current_track, next]
    ));
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
