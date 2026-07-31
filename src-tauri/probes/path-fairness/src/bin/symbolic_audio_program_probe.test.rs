use super::{ProgramEncoding, TrackMetadata, write_migrated_stable_model};
use serde_json::json;
use std::fs;

#[test]
fn stable_migration_writes_v2_candidate_without_overwriting_source() {
    // @forma observes observation Domain.CrossRuntimeProgramEncoding
    let root = std::env::temp_dir().join(format!(
        "slisic-symbolic-stable-migration-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let stable_path = root.join("stable-v1.json");
    let output_path = root.join("stable-v2.json");
    fs::write(
        &stable_path,
        serde_json::to_vec(&json!({
            "version": "audio-style-stable-model-v1",
            "generation": 7,
            "state": {
                "embeddings": [{"key": "preserved"}],
                "indexed_tracks": []
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let encoding = ProgramEncoding {
        schema: "slisic.symbolic-audio-program-encoding.v1".to_string(),
        stable_generation: 7,
        track_count: 1,
        track_key_signature: "audio-track-order:test".to_string(),
        candidate_width: 1,
        candidate_relation_signature: "audio-candidate-relation:test".to_string(),
        candidate_rows: vec![vec![0]],
        program_lineages: vec!["program:test".to_string()],
        program_encoding_signature: "audio-program-encoding:test".to_string(),
    };
    let metadata = TrackMetadata {
        generation: 7,
        track_keys: vec!["track:test".to_string()],
        track_titles: vec!["Test".to_string()],
        file_paths: vec!["test.mp3".to_string()],
    };

    write_migrated_stable_model(&stable_path, &output_path, &encoding, &metadata).unwrap();

    let source: serde_json::Value =
        serde_json::from_slice(&fs::read(&stable_path).unwrap()).unwrap();
    let migrated: serde_json::Value =
        serde_json::from_slice(&fs::read(&output_path).unwrap()).unwrap();
    assert_eq!(source["version"], "audio-style-stable-model-v1");
    assert_eq!(migrated["version"], "audio-style-stable-model-v2");
    assert_eq!(
        migrated["state"]["symbolic_program_encoding"]["stable_generation"],
        7
    );
    assert_eq!(
        migrated["state"]["embeddings"],
        source["state"]["embeddings"]
    );
    assert!(write_migrated_stable_model(&stable_path, &output_path, &encoding, &metadata).is_err());

    fs::remove_dir_all(&root).unwrap();
}
