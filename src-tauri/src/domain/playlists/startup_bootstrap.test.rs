use super::model::{ConfigLibraryView, ExcludeAvailability};
use super::startup_bootstrap::{
    PlaylistStartupBootstrap, PlaylistStartupBootstrapSnapshot, publish_for_test, reset_for_test,
    snapshot,
};

fn empty_config_library() -> ConfigLibraryView {
    ConfigLibraryView {
        collections: vec![],
        groups: vec![],
        collection_group_memberships: vec![],
        excludes: vec![],
        exclude_availability: ExcludeAvailability {
            fully_excluded_collection_urls: vec![],
            fully_excluded_group_urls: vec![],
        },
    }
}

#[test]
fn startup_bootstrap_snapshot_starts_pending() {
    reset_for_test();

    assert!(matches!(
        snapshot(),
        PlaylistStartupBootstrapSnapshot::Pending
    ));
}

#[test]
fn startup_bootstrap_snapshot_returns_published_ready_value() {
    reset_for_test();
    publish_for_test(PlaylistStartupBootstrap {
        has_playlist: true,
        playlists: vec![],
        collections: vec![],
        config_library: empty_config_library(),
        save_path: "C:/Users/admin/Documents/slisic".to_string(),
    });

    let PlaylistStartupBootstrapSnapshot::Ready(value) = snapshot() else {
        panic!("startup bootstrap snapshot should be ready");
    };

    assert!(value.has_playlist);
    assert_eq!(value.save_path, "C:/Users/admin/Documents/slisic");
}
