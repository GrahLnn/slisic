use appdb::impl_schema;

pub const TABLE_PLAYLIST: &str = "music_playlist";
pub const TABLE_ENTRY: &str = "music_entry";
pub const TABLE_ASSET: &str = "music_asset";
pub const TABLE_META: &str = "music_meta";

pub const REL_PLAYLIST_ENTRY: &str = "music_playlist_entry";
pub const REL_ENTRY_ASSET: &str = "music_entry_asset";
pub const REL_PLAYLIST_EXCLUDE: &str = "music_playlist_exclude";

pub struct MusicPlaylistSchema;
pub struct MusicEntrySchema;
pub struct MusicAssetSchema;
pub struct MusicMetaSchema;
pub struct MusicPlaylistEntrySchema;
pub struct MusicEntryAssetSchema;
pub struct MusicPlaylistExcludeSchema;

impl_schema!(
    MusicPlaylistSchema,
    r#"
DEFINE INDEX music_playlist_unique_name ON TABLE music_playlist FIELDS name UNIQUE;
"#
);

impl_schema!(
    MusicEntrySchema,
    r#"
DEFINE INDEX music_entry_unique_key ON TABLE music_entry FIELDS entry_key_norm UNIQUE;
"#
);

impl_schema!(
    MusicAssetSchema,
    r#"
DEFINE INDEX music_asset_unique_path ON TABLE music_asset FIELDS path UNIQUE;
"#
);

impl_schema!(
    MusicMetaSchema,
    r#"
DEFINE INDEX music_meta_unique_key ON TABLE music_meta FIELDS key UNIQUE;
"#
);

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
