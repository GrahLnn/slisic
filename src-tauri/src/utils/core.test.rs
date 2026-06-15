use super::core::{
    APP_DB_FILE_NAME, dev_reset_local_data_artifact_paths, remove_optional_artifacts,
};

#[test]
fn dev_reset_local_data_artifacts_include_pending_tasks_and_first_slot_cache() {
    let root = std::path::Path::new("C:/Users/admin/AppData/Local/slisic");
    let paths = dev_reset_local_data_artifact_paths(root);
    let names = paths
        .iter()
        .filter_map(|path| path.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(names.iter().any(|name| name == "first-slot-cache.json"));
    assert!(
        names
            .iter()
            .any(|name| name == "audio-style-model-evidence")
    );
    assert!(
        names
            .iter()
            .any(|name| name == "loudness-evidence-pending.json")
    );
    assert!(
        names
            .iter()
            .any(|name| name == "audio-tail-trim-pending.json")
    );
}

#[test]
fn remove_optional_artifacts_removes_files_and_directories_without_requiring_existence() {
    let root = unique_temp_path("dev-reset-artifacts");
    let file_path = root.join("loudness-evidence-pending.json");
    let dir_path = root.join("audio-style-embeddings");
    let missing_path = root.join("missing.json");

    std::fs::create_dir_all(&dir_path).expect("artifact directory should be created");
    std::fs::write(&file_path, b"pending").expect("artifact file should be written");
    std::fs::write(dir_path.join("entry.json"), b"cache").expect("cache file should be written");

    remove_optional_artifacts(&[file_path.clone(), dir_path.clone(), missing_path])
        .expect("optional reset artifacts should be removable");

    assert!(!file_path.exists());
    assert!(!dir_path.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn remove_optional_artifacts_removes_database_directory_itself() {
    let root = unique_temp_path("dev-reset-db");
    let db_path = root.join(APP_DB_FILE_NAME);
    let storage_artifact_dir = db_path.join("storage-artifacts");
    std::fs::create_dir_all(&storage_artifact_dir)
        .expect("db storage artifact directory should be created");
    std::fs::write(storage_artifact_dir.join("entry.bin"), b"storage")
        .expect("db storage artifact file should be written");

    remove_optional_artifacts(std::slice::from_ref(&db_path))
        .expect("database reset artifact should be removable");

    assert!(!db_path.exists());
    let _ = std::fs::remove_dir_all(root);
}

fn unique_temp_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "slisic_{label}_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos()
    ))
}
