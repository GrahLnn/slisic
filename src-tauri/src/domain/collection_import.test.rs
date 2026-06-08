use super::{
    CollectionManifest, CollectionManifestCollection, CollectionManifestGroup,
    CollectionManifestMusic, LocalAudioFile, collection_folder_from_local_path,
    collection_from_manifest, finalize_downloaded_leaf, manifest_from_raw_leaf_evidence,
    merge_raw_leaf_manifest_evidence, normalize_manifest_relative_path,
    normalize_music_titles_within_collection, project_local_collection_shell,
};
use crate::domain::downloads::model::CollectionSourceKind;
use crate::domain::downloads::model::{DownloadTaskStatus, DownloadTrigger};
use crate::domain::downloads::yt_dlp::LeafProbe;
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

    let collection = collection_from_manifest(
        "D:/Music/collection".to_string(),
        manifest,
        &local_audio_files,
    )
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
    assert_eq!(
        loose_local_music.url,
        "https://example.com/playlist#loose.flac"
    );
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
fn raw_leaf_manifest_records_probe_text_and_measured_file_boundary_not_db_projection() {
    let raw_title = "BB's Theme (Instrumental) - Death Stranding OST";
    let normalized_title = "BB's Theme (Instrumental)";
    let path = "BB's Theme (Instrumental) - Death Stranding OST.m4a";
    let url = "https://www.youtube.com/watch?v=bb-theme-instrumental";
    let group = collection_group(
        "Death Stranding",
        "https://example.com/playlist",
        "youtube/Death Stranding (Original Soundtrack)",
    );
    let collection = Collection {
        name: "Death Stranding".to_string(),
        url: "https://example.com/playlist".to_string(),
        folder: "youtube/Death Stranding (Original Soundtrack)".to_string(),
        musics: vec![music_with_group(normalized_title, url, path, group.clone())],
        last_updated: "2026-06-07T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };
    let probe = LeafProbe {
        title: raw_title.to_string(),
        webpage_url: url.to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: Some("Death Stranding (Original Soundtrack)".to_string()),
        duration_ms: Some(186_688),
        duration_seconds: Some(187),
        chapters: vec![],
    };
    let polluted_existing = CollectionManifest {
        version: 1,
        collection: manifest_collection(),
        groups: vec![],
        musics: vec![CollectionManifestMusic {
            name: "BB's Theme (Instrumental".to_string(),
            alias: "BB's Theme (Instrumental".to_string(),
            url: url.to_string(),
            path: path.to_string(),
            group_url: group.url.clone(),
            start_ms: 0,
            end_ms: 180_000,
            liked: false,
        }],
    };

    let raw_manifest = manifest_from_raw_leaf_evidence(
        &collection,
        CollectionSourceKind::List,
        &probe,
        path,
        &group,
    );
    let merged = merge_raw_leaf_manifest_evidence(polluted_existing, raw_manifest);

    assert_eq!(collection.musics[0].name, normalized_title);
    assert_eq!(merged.musics.len(), 1);
    assert_eq!(merged.musics[0].name, raw_title);
    assert_eq!(merged.musics[0].alias, raw_title);
    assert_eq!(merged.musics[0].path, path);
    assert_eq!(merged.musics[0].end_ms, 186_688);
}

#[test]
fn raw_leaf_manifest_keeps_existing_root_metadata_when_db_collection_was_edited() {
    let url = "https://www.youtube.com/watch?v=next-track";
    let group = collection_group(
        "User Edited Collection",
        "https://example.com/playlist",
        "youtube/Raw Root Title",
    );
    let existing = CollectionManifest {
        version: 1,
        collection: CollectionManifestCollection {
            name: "Raw Root Title".to_string(),
            url: "https://example.com/playlist".to_string(),
            folder: "youtube/Raw Root Title".to_string(),
            source_kind: Some(CollectionSourceKind::List),
            enable_updates: Some(false),
            last_updated: Some("2026-06-07T00:00:00+00:00".to_string()),
        },
        groups: vec![],
        musics: vec![manifest_music(
            "Existing Raw Track",
            "https://www.youtube.com/watch?v=existing",
            "Existing Raw Track.m4a",
            0,
            120_000,
        )],
    };
    let edited_collection = Collection {
        name: "User Edited Collection".to_string(),
        url: "https://example.com/playlist".to_string(),
        folder: "youtube/User Edited Collection".to_string(),
        musics: vec![music_with_group(
            "Normalized Next Track",
            url,
            "Next Track.m4a",
            group.clone(),
        )],
        last_updated: "2026-06-07T01:00:00+00:00".to_string(),
        enable_updates: Some(true),
    };
    let probe = LeafProbe {
        title: "Next Raw Track".to_string(),
        webpage_url: url.to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_ms: Some(90_000),
        duration_seconds: Some(90),
        chapters: vec![],
    };

    let next = manifest_from_raw_leaf_evidence(
        &edited_collection,
        CollectionSourceKind::List,
        &probe,
        "Next Track.m4a",
        &group,
    );
    let merged = merge_raw_leaf_manifest_evidence(existing, next);

    assert_eq!(merged.collection.name, "Raw Root Title");
    assert_eq!(merged.collection.folder, "youtube/Raw Root Title");
    assert_eq!(merged.collection.enable_updates, Some(false));
    assert_eq!(merged.musics.len(), 2);
    assert_eq!(merged.musics[1].name, "Next Raw Track");
}

#[test]
fn raw_leaf_manifest_does_not_materialize_collection_owner_as_group() {
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
        musics: vec![],
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };
    let root_probe = LeafProbe {
        title: "Root Track".to_string(),
        webpage_url: "https://example.com/watch?v=root".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_ms: Some(60_000),
        duration_seconds: Some(60),
        chapters: vec![],
    };
    let nested_probe = LeafProbe {
        title: "Nested Track".to_string(),
        webpage_url: "https://example.com/watch?v=nested".to_string(),
        extractor_key: Some("Youtube".to_string()),
        album: None,
        duration_ms: Some(60_000),
        duration_seconds: Some(60),
        chapters: vec![],
    };
    let owner_group = collection_group(
        "Collection",
        "https://example.com/playlist",
        "youtube/collection",
    );
    let manifest = merge_raw_leaf_manifest_evidence(
        manifest_from_raw_leaf_evidence(
            &collection,
            CollectionSourceKind::List,
            &root_probe,
            "root.m4a",
            &owner_group,
        ),
        manifest_from_raw_leaf_evidence(
            &collection,
            CollectionSourceKind::List,
            &nested_probe,
            "Disc 1/nested.m4a",
            &nested_group,
        ),
    );

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

    let collection = collection_from_manifest(
        "D:/Music/collection".to_string(),
        manifest,
        &local_audio_files,
    )
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
fn manifest_import_restores_precise_local_duration_for_full_file_boundary() {
    let local_audio_files = vec![LocalAudioFile {
        absolute_path: PathBuf::from("C:/library/collection/What Now.m4a"),
        relative_path: "What Now.m4a".to_string(),
        duration_ms: 344_455,
    }];
    let manifest = CollectionManifest {
        version: 1,
        collection: manifest_collection(),
        groups: vec![],
        musics: vec![manifest_music(
            "What Now",
            "https://www.youtube.com/watch?v=Gv1CBp5NABw",
            "What Now.m4a",
            0,
            344_000,
        )],
    };

    let collection = collection_from_manifest(
        "D:/Music/collection".to_string(),
        manifest,
        &local_audio_files,
    )
    .expect("manifest full-file boundary should restore");

    assert_eq!(collection.musics.len(), 1);
    assert_eq!(collection.musics[0].end_ms, 344_455);
    assert_eq!(
        collection.musics[0].canonical_music_id,
        canonical_music_id_for_source("https://www.youtube.com/watch?v=Gv1CBp5NABw", 0, 344_455)
    );
}

#[test]
fn manifest_import_preserves_partial_ranges_that_do_not_target_file_end() {
    let local_audio_files = vec![LocalAudioFile {
        absolute_path: PathBuf::from("C:/library/collection/long-track.m4a"),
        relative_path: "long-track.m4a".to_string(),
        duration_ms: 344_455,
    }];
    let manifest = CollectionManifest {
        version: 1,
        collection: manifest_collection(),
        groups: vec![],
        musics: vec![manifest_music(
            "Partial",
            "https://example.com/watch?v=partial",
            "long-track.m4a",
            0,
            120_000,
        )],
    };

    let collection = collection_from_manifest(
        "D:/Music/collection".to_string(),
        manifest,
        &local_audio_files,
    )
    .expect("manifest partial range should restore");

    assert_eq!(collection.musics.len(), 1);
    assert_eq!(collection.musics[0].end_ms, 120_000);
    assert_eq!(
        collection.musics[0].canonical_music_id,
        canonical_music_id_for_source("https://example.com/watch?v=partial", 0, 120_000)
    );
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
        &collection
            .canonicalize()
            .expect("collection should canonicalize"),
        &collection_folder_from_local_path(
            &root,
            &collection
                .canonicalize()
                .expect("collection should canonicalize"),
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
    write_manifest_fixture(&collection, &manifest).expect("manifest should be writable");

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
    assert_eq!(
        task.collection_url.as_deref(),
        Some(collection.url.as_str())
    );
    assert_eq!(
        task.collection_name.as_deref(),
        Some(collection.name.as_str())
    );
    assert_eq!(
        task.collection_folder.as_deref(),
        Some(collection.folder.as_str())
    );
    assert_eq!(task.trigger, DownloadTrigger::LocalImport);
    assert_eq!(task.status, DownloadTaskStatus::Queued);
}

#[test]
fn normalize_music_titles_restores_bracketed_title_from_downloaded_file_name_evidence() {
    let group = collection_group(
        "TENET Official Soundtrack",
        "https://www.youtube.com/playlist?list=PLtenet",
        "TENET Official Soundtrack - WaterTower Music",
    );
    let mut collection = Collection {
        name: "TENET Official Soundtrack".to_string(),
        url: "https://www.youtube.com/playlist?list=PLtenet".to_string(),
        folder: "youtube/TENET Official Soundtrack - WaterTower Music".to_string(),
        musics: vec![
            music_with_group(
                "FAST CARS - Ludwig Göransson",
                "https://www.youtube.com/watch?v=fast-cars",
                "TENET Official Soundtrack - FAST CARS - Ludwig Göransson - WaterTower.m4a",
                group.clone(),
            ),
            music_with_group(
                "TURNSTILE - Ludwig Göransson",
                "https://www.youtube.com/watch?v=turnstile",
                "TENET Official Soundtrack - TURNSTILE - Ludwig Göransson - WaterTower.m4a",
                group.clone(),
            ),
            music_with_group(
                "INVERTED] FULL ALBUM - Ludwig Göransson",
                "https://www.youtube.com/watch?v=inverted",
                "TENET Official Soundtrack - [INVERTED] FULL ALBUM - Ludwig Göransson - WaterTower.m4a",
                group.clone(),
            ),
            music_with_group(
                "FULL ALBUM - Ludwig Göransson",
                "https://www.youtube.com/watch?v=full-album",
                "TENET Official Soundtrack - FULL ALBUM - Ludwig Göransson - WaterTower.m4a",
                group,
            ),
        ],
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[2].name, "[INVERTED] FULL ALBUM");
    assert_eq!(collection.musics[2].alias, "[INVERTED] FULL ALBUM");
}

#[test]
fn normalize_music_titles_deletes_separator_suffix_as_one_semantic_block() {
    let group = collection_group(
        "Death Stranding 2",
        "https://www.youtube.com/playlist?list=PLdeath-stranding-2",
        "Death Stranding 2- On the Beach – All Official Soundtracks",
    );
    let mut collection = Collection {
        name: "Death Stranding 2".to_string(),
        url: "https://www.youtube.com/playlist?list=PLdeath-stranding-2".to_string(),
        folder: "youtube/Death Stranding 2- On the Beach – All Official Soundtracks".to_string(),
        musics: vec![
            music_with_group(
                "Should We Have Connected? | Death",
                "https://www.youtube.com/watch?v=connected",
                "Should We Have Connected- - Death Stranding 2- On The Beach (Original Video Game Score).m4a",
                group.clone(),
            ),
            music_with_group(
                "DHV Magellan Integrate! | Death",
                "https://www.youtube.com/watch?v=magellan",
                "DHV Magellan Integrate! - Death Stranding 2- On The Beach (Original Video Game Score).m4a",
                group.clone(),
            ),
            music_with_group(
                "Over The Dunes",
                "https://www.youtube.com/watch?v=dunes",
                "Ludvig Forssell - Over The Dunes - Death Stranding 2- On The Beach (Original Video Game Score).m4a",
                group.clone(),
            ),
            music_with_group(
                "We Should Not Have Connected",
                "https://www.youtube.com/watch?v=not-connected",
                "We Should Not Have Connected - Death Stranding 2- On The Beach (Original Video Game Score).m4a",
                group,
            ),
        ],
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "Should We Have Connected?");
    assert_eq!(collection.musics[1].name, "DHV Magellan Integrate!");
}

#[test]
fn normalize_music_titles_never_projects_complete_suffix_to_partial_suffix() {
    let group = collection_group(
        "Death Stranding 2",
        "https://www.youtube.com/playlist?list=PLdeath-stranding-2",
        "Death Stranding 2- On the Beach – All Official Soundtracks",
    );
    let mut collection = Collection {
        name: "Death Stranding 2".to_string(),
        url: "https://www.youtube.com/playlist?list=PLdeath-stranding-2".to_string(),
        folder: "youtube/Death Stranding 2- On the Beach – All Official Soundtracks".to_string(),
        musics: vec![
            music_with_group(
                "Should We Have Connected? | Death Stranding 2 On The Beach Original Video Game Score",
                "https://www.youtube.com/watch?v=connected",
                "Should We Have Connected- - Death Stranding 2- On The Beach (Original Video Game Score).m4a",
                group.clone(),
            ),
            music_with_group(
                "DHV Magellan Integrate! | Death Stranding 2 On The Beach Original Video Game Score",
                "https://www.youtube.com/watch?v=magellan",
                "DHV Magellan Integrate! - Death Stranding 2- On The Beach (Original Video Game Score).m4a",
                group.clone(),
            ),
            music_with_group(
                "We Should Not Have Connected | Death Stranding 2 On The Beach Original Video Game Score",
                "https://www.youtube.com/watch?v=not-connected",
                "We Should Not Have Connected - Death Stranding 2- On The Beach (Original Video Game Score).m4a",
                group,
            ),
        ],
        last_updated: "2026-05-24T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "Should We Have Connected?");
    assert_eq!(collection.musics[1].name, "DHV Magellan Integrate!");
    assert_eq!(collection.musics[2].name, "We Should Not Have Connected");
    assert!(
        collection
            .musics
            .iter()
            .all(|music| !music.name.ends_with(" | Death"))
    );
}

#[test]
fn normalize_music_titles_removes_download_source_notes_without_destroying_title_variants() {
    let group = collection_group(
        "Death Stranding 2",
        "https://www.youtube.com/playlist?list=PLdeath-stranding-2",
        "Death Stranding 2- On the Beach – All Official Soundtracks",
    );
    let mut collection = Collection {
        name: "Death Stranding 2".to_string(),
        url: "https://www.youtube.com/playlist?list=PLdeath-stranding-2".to_string(),
        folder: "youtube/Death Stranding 2- On the Beach – All Official Soundtracks".to_string(),
        musics: vec![
            music_with_group(
                "Any Love of Any Kind feat. Bryce Dessner (from \"DEATH STRANDING 2 : ON THE BEACH\" Soundtra...",
                "https://www.youtube.com/watch?v=any-love",
                "Any Love of Any Kind feat. Bryce Dessner (from -DEATH STRANDING 2 - ON THE BEACH- Soundtra.m4a",
                group.clone(),
            ),
            music_with_group(
                "To the Wilder feat. Elle Fanning (from \"DEATH STRANDING 2 : ON THE BEACH\" Soundtrack) (Off...",
                "https://www.youtube.com/watch?v=wilder",
                "To the Wilder feat. Elle Fanning (from -DEATH STRANDING 2 - ON THE BEACH- Soundtrack) (Off.m4a",
                group.clone(),
            ),
            music_with_group(
                "Any Love of Any Kind (Choir Version) (from \"DEATH STRANDING 2 : ON THE BEACH\" Soundtrack) ...",
                "https://www.youtube.com/watch?v=choir",
                "Any Love of Any Kind (Choir Version) (from -DEATH STRANDING 2 - ON THE BEACH- Soundtrack).m4a",
                group.clone(),
            ),
            music_with_group(
                "Black Drift",
                "https://www.youtube.com/watch?v=black-drift",
                "Woodkid - Black Drift (from -DEATH STRANDING 2 - ON THE BEACH- Soundtrack) (Official Audio).m4a",
                group.clone(),
            ),
            music_with_group(
                "Story of Rainy",
                "https://www.youtube.com/watch?v=story-rainy",
                "Woodkid - Story of Rainy (from -DEATH STRANDING 2 - ON THE BEACH- Soundtrack) (Official Audio).m4a",
                group,
            ),
        ],
        last_updated: "2026-06-07T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(
        collection.musics[0].name,
        "Any Love of Any Kind feat. Bryce Dessner"
    );
    assert_eq!(
        collection.musics[1].name,
        "To the Wilder feat. Elle Fanning"
    );
    assert_eq!(
        collection.musics[2].name,
        "Any Love of Any Kind (Choir Version)"
    );
    assert_eq!(collection.musics[3].name, "Black Drift");
    assert_eq!(collection.musics[4].name, "Story of Rainy");
}

#[test]
fn normalize_music_titles_repairs_bracketed_variant_from_file_name_evidence() {
    let group = collection_group(
        "Death Stranding",
        "https://www.youtube.com/playlist?list=PLdeath-stranding",
        "Death Stranding (Original Soundtrack)",
    );
    let mut collection = Collection {
        name: "Death Stranding".to_string(),
        url: "https://www.youtube.com/playlist?list=PLdeath-stranding".to_string(),
        folder: "youtube/Death Stranding (Original Soundtrack)".to_string(),
        musics: vec![
            music_with_group(
                "BB's Theme",
                "https://www.youtube.com/watch?v=bb-theme",
                "BB's Theme - Death Stranding OST.m4a",
                group.clone(),
            ),
            music_with_group(
                "BB's Theme (Instrumental",
                "https://www.youtube.com/watch?v=bb-theme-instrumental",
                "BB's Theme (Instrumental) - Death Stranding OST.m4a",
                group,
            ),
        ],
        last_updated: "2026-06-07T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "BB's Theme");
    assert_eq!(collection.musics[1].name, "BB's Theme (Instrumental)");
    assert_eq!(collection.musics[1].alias, "BB's Theme (Instrumental)");
}

#[test]
fn normalize_music_titles_handles_catalog_prefixes_without_cutting_title_apostrophes() {
    let terraria_group = collection_group(
        "Terraria",
        "https://www.youtube.com/playlist?list=PLterraria",
        "Terraria Soundtrack 2026 Terraria Music",
    );
    let blue_archive_group = collection_group(
        "Blue Archive OST",
        "https://www.youtube.com/playlist?list=PLblue-archive",
        "Blue Archive OST",
    );
    let mut collection = Collection {
        name: "Mixed Catalogs".to_string(),
        url: "https://example.com/root".to_string(),
        folder: "youtube/mixed".to_string(),
        musics: vec![
            music_with_group(
                "Terraria OST - Journey's Beginning",
                "https://www.youtube.com/watch?v=journey-beginning",
                "Terraria OST - Journey's Beginning.m4a",
                terraria_group.clone(),
            ),
            music_with_group(
                "Terraria: Otherworld OST - Every Adventure Has A Beginning",
                "https://www.youtube.com/watch?v=adventure",
                "Terraria- Otherworld OST - Every Adventure Has A Beginning (1.4.0.1 Version).m4a",
                terraria_group.clone(),
            ),
            music_with_group(
                "Terraria Music - Space Day (Console Space)",
                "https://www.youtube.com/watch?v=space-day",
                "Terraria Music - Space Day (Console Space).m4a",
                terraria_group,
            ),
            music_with_group(
                "ブルーアーカイブ Blue Archive OST 19",
                "https://www.youtube.com/watch?v=virtual-storm",
                "ブルーアーカイブ Blue Archive OST 19. Virtual Storm.m4a",
                blue_archive_group.clone(),
            ),
            music_with_group(
                "ブルーアーカイブ Blue Archive OST 60",
                "https://www.youtube.com/watch?v=sakura-punch",
                "ブルーアーカイブ Blue Archive OST 60. SAKURA PUNCH (Hard Arrange).m4a",
                blue_archive_group,
            ),
        ],
        last_updated: "2026-06-07T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "Journey's Beginning");
    assert_eq!(collection.musics[1].name, "Every Adventure Has A Beginning");
    assert_eq!(collection.musics[2].name, "Space Day (Console Space)");
    assert_eq!(collection.musics[3].name, "Virtual Storm");
    assert_eq!(collection.musics[4].name, "SAKURA PUNCH (Hard Arrange)");
}

#[test]
fn normalize_music_titles_rejects_noise_deletions_that_leave_only_numbers() {
    let group = collection_group(
        "Numbered Album",
        "https://www.youtube.com/playlist?list=PLnumbered",
        "Numbered Album",
    );
    let mut collection = Collection {
        name: "Numbered Album".to_string(),
        url: "https://www.youtube.com/playlist?list=PLnumbered".to_string(),
        folder: "youtube/numbered".to_string(),
        musics: vec![
            music_with_group(
                "Album - 1",
                "https://www.youtube.com/watch?v=one",
                "Album - 1.m4a",
                group.clone(),
            ),
            music_with_group(
                "Album - 2",
                "https://www.youtube.com/watch?v=two",
                "Album - 2.m4a",
                group.clone(),
            ),
            music_with_group(
                "Album - Pt.3",
                "https://www.youtube.com/watch?v=pt-three",
                "Album - Pt.3.m4a",
                group.clone(),
            ),
            music_with_group(
                "Album - Pt.4",
                "https://www.youtube.com/watch?v=pt-four",
                "Album - Pt.4.m4a",
                group,
            ),
        ],
        last_updated: "2026-06-07T00:00:00+00:00".to_string(),
        enable_updates: Some(false),
    };

    normalize_music_titles_within_collection(&mut collection);

    assert_eq!(collection.musics[0].name, "Album - 1");
    assert_eq!(collection.musics[1].name, "Album - 2");
    assert_eq!(collection.musics[2].name, "Album - Pt.3");
    assert_eq!(collection.musics[3].name, "Album - Pt.4");
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
fn finalize_downloaded_leaf_rejects_partial_download_fragments() {
    let save_root = unique_temp_path("download-finalize-part-root");
    let collection_folder = "youtube/Partial Download";
    let target_dir = save_root.join(collection_folder);
    std::fs::create_dir_all(&target_dir).expect("download target dir should be creatable");
    let downloaded_path = target_dir.join("Track.__slisic_tmp__abc123.m4a.part");
    std::fs::write(&downloaded_path, b"partial").expect("partial file should exist");
    let collection = Collection {
        name: "Partial Download".to_string(),
        url: "https://www.youtube.com/playlist?list=PLpartial".to_string(),
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

    let error = finalize_downloaded_leaf(
        &collection,
        "https://www.youtube.com/watch?v=partial",
        &group,
        &save_root,
        "Track",
        downloaded_path.clone(),
    )
    .expect_err("partial downloads must not enter the stable music domain");

    assert!(error.to_string().contains("still incomplete"));
    assert!(downloaded_path.is_file());

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

fn collection_group(name: &str, url: &str, folder: &str) -> Group {
    Group {
        name: name.to_string(),
        url: url.to_string(),
        collection: test_collection_owner(
            "Collection",
            "https://example.com/playlist",
            "youtube/collection",
        ),
        folder: folder.to_string(),
    }
}

fn music_with_group(name: &str, url: &str, path: &str, group: Group) -> Music {
    Music {
        occurrence_id: String::new(),
        name: name.to_string(),
        alias: name.to_string(),
        group,
        canonical_music_id: canonical_music_id_for_source(url, 0, 60_000),
        url: url.to_string(),
        path: Some(path.to_string()),
        start_ms: 0,
        end_ms: 60_000,
        liked: false,
        loudness_profile: None,
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

fn write_manifest_fixture(
    collection_root: &std::path::Path,
    manifest: &CollectionManifest,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(collection_root)?;
    let text = toml::to_string_pretty(manifest)?;
    std::fs::write(collection_root.join(".slisic.collection.toml"), text)?;
    Ok(())
}
