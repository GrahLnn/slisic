use super::{
    CollectionManifest, CollectionManifestCollection, CollectionManifestGroup,
    CollectionManifestMusic, LocalAudioFile, collection_folder_from_local_path,
    collection_from_manifest, duration_ms_from_f32le_bytes, finalize_downloaded_leaf,
    merge_collection_manifest, manifest_from_collection, normalize_manifest_relative_path,
    project_local_collection_shell,
};
use crate::domain::downloads::model::CollectionSourceKind;
use crate::domain::downloads::model::{DownloadTaskStatus, DownloadTrigger};
use crate::domain::playlists::model::{
    Collection, CollectionGroupOwner, Group, Music, canonical_music_id_for_source,
};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn manifest_import_restores_download_identity_for_playable_files() {
    let local_audio_files = vec![
        LocalAudioFile {
            absolute_path: PathBuf::from("C:/library/collection/Disc 1/intro.m4a"),
            relative_path: "Disc 1/intro.m4a".to_string(),
            duration_ms: 62_000,
        },
        LocalAudioFile {
            absolute_path: PathBuf::from("C:/library/collection/loose.flac"),
            relative_path: "loose.flac".to_string(),
            duration_ms: 30_000,
        },
        LocalAudioFile {
            absolute_path: PathBuf::from("C:/library/collection/missing-from-manifest.ogg"),
            relative_path: "missing-from-manifest.ogg".to_string(),
            duration_ms: 44_000,
        },
    ];
    let manifest = CollectionManifest {
        version: 1,
        collection: CollectionManifestCollection {
            name: "Downloaded Collection".to_string(),
            url: "https://example.com/playlist".to_string(),
            folder: "youtube/downloaded-collection".to_string(),
            source_kind: Some(CollectionSourceKind::List),
            enable_updates: Some(false),
            last_updated: Some("2026-05-24T00:00:00+00:00".to_string()),
        },
        groups: vec![CollectionManifestGroup {
            name: "Disc 1".to_string(),
            url: "https://example.com/disc-1".to_string(),
            folder: "Disc 1".to_string(),
        }],
        musics: vec![
            CollectionManifestMusic {
                name: "Intro".to_string(),
                alias: "Pinned Intro".to_string(),
                url: "https://example.com/watch?v=intro".to_string(),
                path: "Disc 1/intro.m4a".to_string(),
                group_url: "https://example.com/disc-1".to_string(),
                start_ms: 0,
                end_ms: 60_000,
                liked: true,
            },
            CollectionManifestMusic {
                name: "Missing".to_string(),
                alias: "Missing".to_string(),
                url: "https://example.com/watch?v=missing".to_string(),
                path: "missing.m4a".to_string(),
                group_url: "https://example.com/disc-1".to_string(),
                start_ms: 0,
                end_ms: 5_000,
                liked: false,
            },
            CollectionManifestMusic {
                name: "Too Long".to_string(),
                alias: "Too Long".to_string(),
                url: "https://example.com/watch?v=too-long".to_string(),
                path: "loose.flac".to_string(),
                group_url: "https://example.com/playlist".to_string(),
                start_ms: 0,
                end_ms: 90_000,
                liked: false,
            },
        ],
    };

    let collection =
        collection_from_manifest("D:/Music/collection".to_string(), manifest, &local_audio_files)
            .expect("manifest should restore playable identity records");

    assert_eq!(collection.name, "Downloaded Collection");
    assert_eq!(collection.url, "https://example.com/playlist");
    assert_eq!(collection.folder, "D:/Music/collection");
    assert_eq!(collection.enable_updates, Some(false));
    assert_eq!(collection.musics.len(), 3);

    let restored = &collection.musics[0];
    assert_eq!(restored.name, "Intro");
    assert_eq!(restored.alias, "Pinned Intro");
    assert_eq!(restored.url, "https://example.com/watch?v=intro");
    assert_eq!(restored.group.name, "Disc 1");
    assert_eq!(restored.group.url, "https://example.com/disc-1");
    assert_eq!(restored.group.folder, "Disc 1");
    assert_eq!(restored.path.as_deref(), Some("Disc 1/intro.m4a"));
    assert_eq!(restored.start_ms, 0);
    assert_eq!(restored.end_ms, 60_000);
    assert!(restored.liked);

    let loose_local_music = &collection.musics[1];
    assert_eq!(loose_local_music.name, "loose");
    assert_eq!(loose_local_music.url, "https://example.com/playlist#loose.flac");
    assert_eq!(loose_local_music.path.as_deref(), Some("loose.flac"));
    assert_eq!(loose_local_music.start_ms, 0);
    assert_eq!(loose_local_music.end_ms, 30_000);

    let missing_manifest_music = &collection.musics[2];
    assert_eq!(missing_manifest_music.name, "missing-from-manifest");
    assert_eq!(
        missing_manifest_music.url,
        "https://example.com/playlist#missing-from-manifest.ogg"
    );
    assert_eq!(
        missing_manifest_music.path.as_deref(),
        Some("missing-from-manifest.ogg")
    );
    assert_eq!(missing_manifest_music.start_ms, 0);
    assert_eq!(missing_manifest_music.end_ms, 44_000);
    assert!(
        collection
            .musics
            .iter()
            .all(|music| music.url != "https://example.com/watch?v=too-long")
    );
}

#[test]
fn manifest_merge_keeps_original_file_identity_once_recorded() {
    let existing = CollectionManifest {
        version: 1,
        collection: manifest_collection(),
        groups: vec![],
        musics: vec![manifest_music(
            "Original",
            "https://example.com/watch?v=a",
            "track.m4a",
            0,
            60_000,
        )],
    };
    let next = CollectionManifest {
        version: 1,
        collection: CollectionManifestCollection {
            last_updated: Some("2026-05-24T01:00:00+00:00".to_string()),
            ..manifest_collection()
        },
        groups: vec![],
        musics: vec![
            manifest_music(
                "Edited Later",
                "https://example.com/watch?v=a",
                "track.m4a",
                5_000,
                55_000,
            ),
            manifest_music(
                "New Track",
                "https://example.com/watch?v=b",
                "new.m4a",
                0,
                42_000,
            ),
        ],
    };

    let merged = merge_collection_manifest(existing, next);

    assert_eq!(merged.musics.len(), 2);
    assert_eq!(merged.musics[0].name, "Original");
    assert_eq!(merged.musics[0].start_ms, 0);
    assert_eq!(merged.musics[0].end_ms, 60_000);
    assert_eq!(merged.musics[1].name, "New Track");
    assert_eq!(merged.collection.last_updated.as_deref(), Some("2026-05-24T00:00:00+00:00"));
}

#[test]
fn manifest_does_not_materialize_collection_owner_as_group() {
    let collection_owner = Group {
        name: "Collection".to_string(),
        url: "https://example.com/playlist".to_string(),
        collection: test_collection_owner(
            "Collection",
            "https://example.com/playlist",
            "youtube/collection",
        ),
        folder: "youtube/collection".to_string(),
    };
    let nested_group = Group {
        name: "Disc 1".to_string(),
        url: "https://example.com/disc-1".to_string(),
        collection: test_collection_owner(
            "Collection",
            "https://example.com/playlist",
            "youtube/collection",
        ),
        folder: "Disc 1".to_string(),
    };
    let collection = Collection {
        name: "Collection".to_string(),
        url: "https://example.com/playlist".to_string(),
        folder: "youtube/collection".to_string(),
        musics: vec![
            music_with_group(
                "Root Track",
                "https://example.com/watch?v=root",
                "root.m4a",
                collection_owner,
            ),
            music_with_group(
                "Nested Track",
                "https://example.com/watch?v=nested",
                "Disc 1/nested.m4a",
                nested_group,
            ),
        ],
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    let manifest = manifest_from_collection(&collection, CollectionSourceKind::List);

    assert_eq!(manifest.groups.len(), 1);
    assert_eq!(manifest.groups[0].url, "https://example.com/disc-1");
    assert!(
        manifest
            .groups
            .iter()
            .all(|group| group.url != manifest.collection.url)
    );
    assert_eq!(manifest.musics[0].group_url, manifest.collection.url);
    assert_eq!(manifest.musics[1].group_url, "https://example.com/disc-1");
}

#[test]
fn import_ignores_manifest_music_with_missing_nested_group_and_keeps_local_file_identity() {
    let local_audio_files = vec![LocalAudioFile {
        absolute_path: PathBuf::from("C:/library/collection/nested.m4a"),
        relative_path: "nested.m4a".to_string(),
        duration_ms: 60_000,
    }];
    let manifest = CollectionManifest {
        version: 1,
        collection: manifest_collection(),
        groups: vec![],
        musics: vec![manifest_music_with_group(
            "Nested",
            "https://example.com/watch?v=nested",
            "nested.m4a",
            "https://example.com/missing-group",
            0,
            60_000,
        )],
    };

    let collection =
        collection_from_manifest("D:/Music/collection".to_string(), manifest, &local_audio_files)
            .expect("missing nested group should not fail the whole import");

    assert_eq!(collection.musics.len(), 1);
    assert_eq!(collection.musics[0].name, "nested");
    assert_eq!(
        collection.musics[0].url,
        "https://example.com/playlist#nested.m4a"
    );
    assert_eq!(collection.musics[0].group.url, collection.url);
}

#[test]
fn external_import_folder_remains_absolute_for_existing_playback_resolution() {
    let root = unique_temp_path("save-root");
    let collection = unique_temp_path("collection");
    std::fs::create_dir_all(&root).expect("save root should be creatable");
    std::fs::create_dir_all(&collection).expect("collection root should be creatable");

    let folder = collection_folder_from_local_path(&root, &collection)
        .expect("external collection folder should normalize");

    assert_eq!(folder, collection.to_string_lossy().replace('\\', "/"));

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&collection);
}

#[test]
fn local_collection_shell_uses_the_same_identity_projection_as_full_import() {
    let root = unique_temp_path("save-root");
    let collection = unique_temp_path("collection");
    std::fs::create_dir_all(&root).expect("save root should be creatable");
    std::fs::create_dir_all(&collection).expect("collection root should be creatable");

    let shell = project_local_collection_shell(&collection, &root)
        .expect("local collection shell should project identity");
    let imported = super::collection_from_local_audio_files(
        &collection.canonicalize().expect("collection should canonicalize"),
        &collection_folder_from_local_path(
            &root,
            &collection.canonicalize().expect("collection should canonicalize"),
        )
        .expect("collection folder should project"),
        &[LocalAudioFile {
            absolute_path: collection.join("track.m4a"),
            relative_path: "track.m4a".to_string(),
            duration_ms: 60_000,
        }],
    )
    .expect("local audio collection should project identity");

    assert_eq!(shell.name, imported.name);
    assert_eq!(shell.url, imported.url);
    assert_eq!(shell.folder, imported.folder);
    assert!(shell.musics.is_empty());

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&collection);
}

#[test]
fn local_collection_shell_restores_manifest_identity_without_scanning_audio() {
    let root = unique_temp_path("save-root");
    let collection = unique_temp_path("manifest-collection");
    std::fs::create_dir_all(&root).expect("save root should be creatable");
    std::fs::create_dir_all(&collection).expect("collection root should be creatable");
    let manifest = CollectionManifest {
        version: 1,
        collection: CollectionManifestCollection {
            name: "Downloaded Collection".to_string(),
            url: "https://example.com/playlist".to_string(),
            folder: "youtube/downloaded-collection".to_string(),
            source_kind: Some(CollectionSourceKind::List),
            enable_updates: Some(false),
            last_updated: Some("2026-05-24T00:00:00+00:00".to_string()),
        },
        groups: vec![CollectionManifestGroup {
            name: "Disc 1".to_string(),
            url: "https://example.com/disc-1".to_string(),
            folder: "Disc 1".to_string(),
        }],
        musics: vec![manifest_music(
            "Track",
            "https://example.com/watch?v=track",
            "track.m4a",
            0,
            60_000,
        )],
    };
    super::write_collection_manifest_file(&collection, &manifest)
        .expect("manifest should be writable");

    let shell = project_local_collection_shell(&collection, &root)
        .expect("manifest shell should project identity");

    assert_eq!(shell.name, "Downloaded Collection");
    assert_eq!(shell.url, "https://example.com/playlist");
    assert_eq!(shell.enable_updates, Some(false));
    assert_eq!(shell.last_updated, "2026-05-24T00:00:00+00:00");
    assert!(shell.musics.is_empty());

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&collection);
}

#[test]
fn local_import_task_uses_collection_url_as_active_playback_scope() {
    let collection = Collection {
        name: "Local Album".to_string(),
        url: "local://collection/example".to_string(),
        folder: "C:/Music/Local Album".to_string(),
        musics: vec![],
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: None,
    };

    let task = super::create_local_import_task(&collection);

    assert_eq!(task.url, collection.url);
    assert_eq!(task.collection_url.as_deref(), Some(collection.url.as_str()));
    assert_eq!(task.collection_name.as_deref(), Some(collection.name.as_str()));
    assert_eq!(
        task.collection_folder.as_deref(),
        Some(collection.folder.as_str())
    );
    assert_eq!(task.trigger, DownloadTrigger::LocalImport);
    assert_eq!(task.status, DownloadTaskStatus::Queued);
}

#[test]
fn finalize_downloaded_leaf_commits_the_actual_downloaded_file_name_without_temp_marker() {
    let save_root = unique_temp_path("download-finalize-root");
    let collection_folder = "youtube/TENET Official Soundtrack - WaterTower Music";
    let target_dir = save_root.join(collection_folder);
    std::fs::create_dir_all(&target_dir).expect("download target dir should be creatable");
    let downloaded_path = target_dir.join(
        "TENET Official Soundtrack - PRIYA - Ludwig Gransson - WaterTower.__slisic_tmp__cf9328d7.m4a",
    );
    std::fs::write(&downloaded_path, b"audio").expect("downloaded temp file should exist");
    let collection = Collection {
        name: "TENET Official Soundtrack - WaterTower Music".to_string(),
        url: "https://www.youtube.com/playlist?list=PLtenet".to_string(),
        folder: collection_folder.to_string(),
        musics: vec![],
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };
    let group = Group {
        name: collection.name.clone(),
        url: collection.url.clone(),
        collection: CollectionGroupOwner::from(&collection),
        folder: collection.folder.clone(),
    };

    let relative_path = finalize_downloaded_leaf(
        &collection,
        "https://www.youtube.com/watch?v=3tVuo-WQmkI",
        &group,
        &save_root,
        "TENET Official Soundtrack - PRIYA - Ludwig Göransson - WaterTower",
        downloaded_path.clone(),
    )
    .expect("downloaded leaf should finalize from actual path");

    assert_eq!(
        relative_path,
        "TENET Official Soundtrack - PRIYA - Ludwig Gransson - WaterTower.m4a"
    );
    assert!(target_dir.join(&relative_path).is_file());
    assert!(!downloaded_path.exists());
    assert!(
        !target_dir
            .join("TENET Official Soundtrack - PRIYA - Ludwig Göransson - WaterTower.m4a")
            .exists()
    );

    let _ = std::fs::remove_dir_all(save_root);
}

#[test]
fn finalize_downloaded_leaf_is_idempotent_after_temp_file_was_already_committed() {
    let save_root = unique_temp_path("download-finalize-idempotent-root");
    let collection_folder = "youtube/Recovered Temp";
    let target_dir = save_root.join(collection_folder);
    std::fs::create_dir_all(&target_dir).expect("download target dir should be creatable");
    let final_path = target_dir.join("Recovered Track.m4a");
    std::fs::write(&final_path, b"audio").expect("stable file should exist");
    let collection = Collection {
        name: "Recovered Temp".to_string(),
        url: "https://www.youtube.com/playlist?list=PLtemp".to_string(),
        folder: collection_folder.to_string(),
        musics: vec![music_with_group(
            "Recovered Track",
            "https://www.youtube.com/watch?v=temp",
            "Recovered Track.m4a",
            Group {
                name: "Recovered Temp".to_string(),
                url: "https://www.youtube.com/playlist?list=PLtemp".to_string(),
                collection: test_collection_owner(
                    "Recovered Temp",
                    "https://www.youtube.com/playlist?list=PLtemp",
                    collection_folder,
                ),
                folder: collection_folder.to_string(),
            },
        )],
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };
    let group = Group {
        name: collection.name.clone(),
        url: collection.url.clone(),
        collection: CollectionGroupOwner::from(&collection),
        folder: collection.folder.clone(),
    };

    let relative_path = finalize_downloaded_leaf(
        &collection,
        "https://www.youtube.com/watch?v=temp",
        &group,
        &save_root,
        "Recovered Track",
        final_path.clone(),
    )
    .expect("already committed stable files should be accepted");

    assert_eq!(relative_path, "Recovered Track.m4a");
    assert!(final_path.is_file());

    let _ = std::fs::remove_dir_all(save_root);
}

#[test]
fn manifest_relative_paths_cannot_escape_collection_folder() {
    assert!(normalize_manifest_relative_path("../escape.m4a").is_err());
    assert!(normalize_manifest_relative_path("Disc 1/track.m4a").is_ok());
}

#[test]
fn decoded_f32le_byte_count_maps_to_duration_ms() {
    assert_eq!(duration_ms_from_f32le_bytes(48_000 * 4 * 2, 48_000), 2_000);
    assert_eq!(duration_ms_from_f32le_bytes(24_000 * 4, 48_000), 500);
}

fn manifest_collection() -> CollectionManifestCollection {
    CollectionManifestCollection {
        name: "Collection".to_string(),
        url: "https://example.com/playlist".to_string(),
        folder: "youtube/collection".to_string(),
        source_kind: Some(CollectionSourceKind::List),
        enable_updates: Some(false),
        last_updated: Some("2026-05-24T00:00:00+00:00".to_string()),
    }
}

fn manifest_music(
    name: &str,
    url: &str,
    path: &str,
    start_ms: u32,
    end_ms: u32,
) -> CollectionManifestMusic {
    CollectionManifestMusic {
        name: name.to_string(),
        alias: name.to_string(),
        url: url.to_string(),
        path: path.to_string(),
        group_url: "https://example.com/playlist".to_string(),
        start_ms,
        end_ms,
        liked: false,
    }
}

fn manifest_music_with_group(
    name: &str,
    url: &str,
    path: &str,
    group_url: &str,
    start_ms: u32,
    end_ms: u32,
) -> CollectionManifestMusic {
    CollectionManifestMusic {
        name: name.to_string(),
        alias: name.to_string(),
        url: url.to_string(),
        path: path.to_string(),
        group_url: group_url.to_string(),
        start_ms,
        end_ms,
        liked: false,
    }
}

fn music_with_group(name: &str, url: &str, path: &str, group: Group) -> Music {
    Music {
        name: name.to_string(),
        alias: name.to_string(),
        group,
        canonical_music_id: canonical_music_id_for_source(url, 0, 60_000),
        url: url.to_string(),
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 60_000,
        liked: false,
    }
}

fn test_collection_owner(name: &str, url: &str, folder: &str) -> CollectionGroupOwner {
    CollectionGroupOwner {
        name: name.to_string(),
        url: url.to_string(),
        folder: folder.to_string(),
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    }
}

fn unique_temp_path(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();

    std::env::temp_dir().join(format!(
        "slisic_collection_import_{label}_{}_{}",
        std::process::id(),
        nanos
    ))
}
