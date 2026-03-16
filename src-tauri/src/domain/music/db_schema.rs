use appdb::impl_schema;

#[cfg_attr(not(test), allow(dead_code))]
pub const TABLE_PLAYLIST: &str = "music_playlist";
#[cfg_attr(not(test), allow(dead_code))]
pub const TABLE_ENTRY: &str = "music_entry";
#[cfg_attr(not(test), allow(dead_code))]
pub const TABLE_ASSET: &str = "music_asset";
#[cfg_attr(not(test), allow(dead_code))]
pub const TABLE_META: &str = "music_meta";

pub const REL_PLAYLIST_ENTRY: &str = "music_playlist_entry";
pub const REL_ENTRY_ASSET: &str = "music_entry_asset";
pub const REL_PLAYLIST_EXCLUDE: &str = "music_playlist_exclude";

pub struct MusicPlaylistEntrySchema;
pub struct MusicEntryAssetSchema;
pub struct MusicPlaylistExcludeSchema;

impl_schema!(
    MusicPlaylistEntrySchema,
    r#"
DEFINE TABLE music_playlist_entry TYPE RELATION IN music_playlist OUT music_entry;
DEFINE INDEX music_playlist_entry_unique ON TABLE music_playlist_entry FIELDS in, out UNIQUE;
DEFINE INDEX music_playlist_entry_order ON TABLE music_playlist_entry FIELDS in, order_index;
"#
);

impl_schema!(
    MusicEntryAssetSchema,
    r#"
DEFINE TABLE music_entry_asset TYPE RELATION IN music_entry OUT music_asset;
DEFINE INDEX music_entry_asset_unique ON TABLE music_entry_asset FIELDS in, out UNIQUE;
DEFINE INDEX music_entry_asset_order ON TABLE music_entry_asset FIELDS in, order_index;
"#
);

impl_schema!(
    MusicPlaylistExcludeSchema,
    r#"
DEFINE TABLE music_playlist_exclude TYPE RELATION IN music_playlist OUT music_asset;
DEFINE INDEX music_playlist_exclude_unique ON TABLE music_playlist_exclude FIELDS in, out UNIQUE;
DEFINE INDEX music_playlist_exclude_order ON TABLE music_playlist_exclude FIELDS in, order_index;
"#
);
