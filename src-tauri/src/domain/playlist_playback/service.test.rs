use super::service::{
    collect_playlist_tracks, playlist_has_relevant_active_downloads,
    resolve_playlist_playback_continuation_mode, resolve_playlist_playback_inventory,
    resolve_selected_collections,
};
use crate::domain::downloads::model::{DownloadTask, DownloadTaskStatus, DownloadTrigger};
use crate::domain::player::model::PlaybackContinuationMode;
use crate::domain::playlists::model::{Collection, Group, Music, PlayList};
use appdb::{AutoFill, Id};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("ransic_playlist_playback_service_test_{nanos}"))
}

fn group(name: &str, url: &str, folder: &str) -> Group {
    Group {
        name: name.to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
    }
}

fn music(name: &str, url: &str, path: &str, group: Group) -> Music {
    Music {
        name: name.to_string(),
        alias: name.to_string(),
        group,
        url: url.to_string(),
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 180_000,
    }
}

fn music_with_alias(name: &str, alias: &str, url: &str, path: &str, group: Group) -> Music {
    Music {
        name: name.to_string(),
        alias: alias.to_string(),
        group,
        url: url.to_string(),
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 180_000,
    }
}

fn collection(name: &str, url: &str, folder: &str, musics: Vec<Music>) -> Collection {
    Collection {
        name: name.to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
        musics,
        last_updated: "2026-04-19T00:00:00Z".to_string(),
        enable_updates: Some(false),
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

#[test]
fn collect_playlist_tracks_includes_group_only_entries_from_library() {
    let root = temp_root();
    let folder = "youtube/library";
    let audio_path = root.join(folder).join("disc-1").join("track-a.m4a");
    std::fs::create_dir_all(
        audio_path
            .parent()
            .expect("audio parent directory should exist"),
    )
    .expect("group audio parent should be created");
    std::fs::write(&audio_path, b"ok").expect("group audio file should be created");

    let disc = group("Disc 1", "https://example.com/disc-1", "disc-1");
    let library = vec![collection(
        "Library",
        "https://example.com/library",
        folder,
        vec![music_with_alias(
            "Track A",
            "Track Alpha",
            "https://example.com/watch?v=track-a",
            "disc-1/track-a.m4a",
            disc.clone(),
        )],
    )];
    let playlist = PlayList {
        name: "Focus".to_string(),
        collections: vec![],
        groups: vec![disc],
        created_at: AutoFill::pending(),
    };

    let tracks = collect_playlist_tracks(&playlist, &[], &library, &root);

    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].music_name, "Track Alpha");
    assert_eq!(tracks[0].file_path, audio_path);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn collect_playlist_tracks_deduplicates_overlap_between_selected_collections_and_groups() {
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

    let disc = group("Disc 1", "https://example.com/disc-1", "disc-1");
    let selected_collection = collection(
        "Album",
        "https://example.com/album",
        folder,
        vec![music(
            "Track A",
            "https://example.com/watch?v=track-a",
            "disc-1/track-a.m4a",
            disc.clone(),
        )],
    );
    let playlist = PlayList {
        name: "Focus".to_string(),
        collections: vec![selected_collection.clone()],
        groups: vec![disc],
        created_at: AutoFill::pending(),
    };

    let tracks = collect_playlist_tracks(
        &playlist,
        std::slice::from_ref(&selected_collection),
        &[selected_collection.clone()],
        &root,
    );

    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].file_path, audio_path);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn resolve_selected_collections_uses_current_library_records_for_playlist_refs() {
    let stale_disc = group("Disc 1", "https://example.com/disc-1", "disc-1");
    let playlist = PlayList {
        name: "Focus".to_string(),
        collections: vec![collection(
            "Album",
            "https://example.com/album",
            "youtube/album",
            vec![],
        )],
        groups: vec![stale_disc],
        created_at: AutoFill::pending(),
    };
    let library = vec![collection(
        "Album",
        "https://example.com/album",
        "youtube/album",
        vec![music(
            "Track A",
            "https://example.com/watch?v=track-a",
            "disc-1/track-a.m4a",
            group("Disc 1", "https://example.com/disc-1", "disc-1"),
        )],
    )];

    let selected = resolve_selected_collections(&playlist, &library);

    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].url, "https://example.com/album");
    assert_eq!(selected[0].musics.len(), 1);
    assert_eq!(selected[0].musics[0].name, "Track A");
}

#[test]
fn playlist_has_relevant_active_downloads_matches_collection_and_group_domains() {
    let playlist = PlayList {
        name: "Focus".to_string(),
        collections: vec![collection(
            "Album",
            "https://example.com/album",
            "youtube/album",
            vec![],
        )],
        groups: vec![group("Disc 1", "https://example.com/disc-1", "disc-1")],
        created_at: AutoFill::pending(),
    };
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
        download_task(
            "https://example.com/album",
            Some("https://example.com/album"),
            DownloadTaskStatus::Completed,
        ),
    ];

    assert!(playlist_has_relevant_active_downloads(&playlist, &tasks));
}

#[test]
fn playlist_playback_always_starts_in_random_continuation_mode() {
    assert_eq!(
        resolve_playlist_playback_continuation_mode(),
        PlaybackContinuationMode::Random
    );
}

#[test]
fn resolve_playlist_playback_inventory_waits_for_matching_downloads_when_tracks_are_not_ready() {
    let root = temp_root();
    let playlist = PlayList {
        name: "Focus".to_string(),
        collections: vec![collection(
            "Album",
            "https://example.com/album",
            "youtube/album",
            vec![],
        )],
        groups: vec![],
        created_at: AutoFill::pending(),
    };
    let library = vec![collection(
        "Album",
        "https://example.com/album",
        "youtube/album",
        vec![],
    )];
    let inventory = resolve_playlist_playback_inventory(
        &playlist,
        &library,
        &library,
        &[download_task(
            "https://example.com/album",
            Some("https://example.com/album"),
            DownloadTaskStatus::Downloading,
        )],
        &root,
    );

    assert!(inventory.tracks.is_empty());
    assert!(inventory.has_relevant_active_downloads);
    assert!(
        inventory
            .failure_description
            .contains("does not contain any playable tracks")
    );
}

#[test]
fn resolve_playlist_playback_inventory_sees_downloaded_collection_growth() {
    let root = temp_root();
    let folder = "youtube/album";
    let first_path = root.join(folder).join("track-a.m4a");
    let second_path = root.join(folder).join("track-b.m4a");
    std::fs::create_dir_all(root.join(folder)).expect("collection folder should be created");
    std::fs::write(&first_path, b"ok").expect("first audio file should be created");
    std::fs::write(&second_path, b"ok").expect("second audio file should be created");

    let album = group("Album", "https://example.com/album", folder);
    let playlist = PlayList {
        name: "Focus".to_string(),
        collections: vec![collection(
            "Album",
            "https://example.com/album",
            folder,
            vec![],
        )],
        groups: vec![],
        created_at: AutoFill::pending(),
    };
    let initial_collection = collection(
        "Album",
        "https://example.com/album",
        folder,
        vec![music(
            "Track A",
            "https://example.com/watch?v=track-a",
            "track-a.m4a",
            album.clone(),
        )],
    );
    let refreshed_collection = collection(
        "Album",
        "https://example.com/album",
        folder,
        vec![
            music(
                "Track A",
                "https://example.com/watch?v=track-a",
                "track-a.m4a",
                album.clone(),
            ),
            music(
                "Track B",
                "https://example.com/watch?v=track-b",
                "track-b.m4a",
                album,
            ),
        ],
    );
    let active_downloads = [download_task(
        "https://example.com/album",
        Some("https://example.com/album"),
        DownloadTaskStatus::Downloading,
    )];

    let initial = resolve_playlist_playback_inventory(
        &playlist,
        std::slice::from_ref(&initial_collection),
        std::slice::from_ref(&initial_collection),
        &active_downloads,
        &root,
    );
    let refreshed = resolve_playlist_playback_inventory(
        &playlist,
        std::slice::from_ref(&refreshed_collection),
        std::slice::from_ref(&refreshed_collection),
        &active_downloads,
        &root,
    );

    assert_eq!(initial.tracks.len(), 1);
    assert!(initial.has_relevant_active_downloads);
    assert_eq!(refreshed.tracks.len(), 2);
    assert!(refreshed.has_relevant_active_downloads);

    let _ = std::fs::remove_dir_all(root);
}
