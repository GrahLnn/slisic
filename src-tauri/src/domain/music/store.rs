use super::types::{LibraryData, Playlist};
use async_trait::async_trait;

#[async_trait]
pub trait SnapshotStore: Send + Sync {
    fn engine_name(&self) -> &'static str;

    async fn load_data(&self) -> Result<LibraryData, String>;

    async fn save_data(&self, data: &LibraryData) -> Result<(), String>;

    async fn replace_playlist(&self, anchor: &str, playlist: Playlist) -> Result<(), String> {
        let mut data = self.load_data().await?;
        let Some(idx) = data.playlists.iter().position(|p| p.name == anchor) else {
            return Err(format!("playlist not found: {anchor}"));
        };

        if playlist.name != anchor && data.playlists.iter().any(|p| p.name == playlist.name) {
            return Err(format!("playlist already exists: {}", playlist.name));
        }

        data.playlists[idx] = playlist;
        self.save_data(&data).await
    }
}
