use super::service::collect_playlist_tracks;
use crate::domain::playlists::model::{Collection, Group, Music, PlayList};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("ransic_player_service_test_{nanos}"))
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
        group,
        url: url.to_string(),
        path: Some(path.to_string()),
        start: 0,
        end: 180,
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
        vec![music(
            "Track A",
            "https://example.com/watch?v=track-a",
            "disc-1/track-a.m4a",
            disc.clone(),
        )],
    )];
    let playlist = PlayList {
        name: "Focus".to_string(),
        collections: vec![],
        groups: vec![disc],
    };

    let tracks = collect_playlist_tracks(&playlist, &library, &root);

    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].music_name, "Track A");
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
    };

    let tracks = collect_playlist_tracks(&playlist, &[selected_collection], &root);

    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].file_path, audio_path);

    let _ = std::fs::remove_dir_all(root);
}
