use super::model::PlaybackTrack;

#[derive(Debug, Clone)]
pub(crate) struct PlaybackTrackIdentityUpdate {
    pub(crate) music_name: String,
    pub(crate) music_url: String,
    pub(crate) start_ms: u32,
    pub(crate) end_ms: u32,
    pub(crate) next_start_ms: u32,
    pub(crate) next_end_ms: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct TrackIdentitySubstitutionPlan {
    pub(crate) previous_tracks: Vec<PlaybackTrack>,
    pub(crate) next_tracks: Vec<PlaybackTrack>,
    pub(crate) next_active_request_track: Option<PlaybackTrack>,
    pub(crate) should_clear_spectrum_playback_loop_signal: bool,
}

pub(crate) fn plan_track_identity_substitution(
    tracks: &[PlaybackTrack],
    active_request_track: Option<&PlaybackTrack>,
    update: &PlaybackTrackIdentityUpdate,
) -> Option<TrackIdentitySubstitutionPlan> {
    let next_tracks = resolve_session_track_identity_update(tracks, update)?;
    let next_active_request_track =
        resolve_active_request_track_identity_update(active_request_track, update);
    let active_request_track_changed = next_active_request_track.is_some();

    Some(TrackIdentitySubstitutionPlan {
        previous_tracks: tracks.to_vec(),
        next_tracks,
        next_active_request_track,
        should_clear_spectrum_playback_loop_signal: active_request_track_changed,
    })
}

pub(crate) fn resolve_session_track_identity_update(
    tracks: &[PlaybackTrack],
    update: &PlaybackTrackIdentityUpdate,
) -> Option<Vec<PlaybackTrack>> {
    let mut changed = false;
    let next_tracks = tracks
        .iter()
        .map(|track| {
            if track.music_url != update.music_url
                || track.start_ms != update.start_ms
                || track.end_ms != update.end_ms
            {
                return track.clone();
            }

            let mut next = track.clone();
            next.music_name = update.music_name.clone();
            next.start_ms = update.next_start_ms;
            next.end_ms = update.next_end_ms;
            sync_playback_track_source_music(&mut next);
            changed = changed || !playback_tracks_match_one(track, &next);
            next
        })
        .collect::<Vec<_>>();

    changed.then_some(next_tracks)
}

pub(crate) fn resolve_active_request_track_identity_update(
    active_request_track: Option<&PlaybackTrack>,
    update: &PlaybackTrackIdentityUpdate,
) -> Option<PlaybackTrack> {
    let track = active_request_track?;

    if track.music_url != update.music_url
        || track.start_ms != update.start_ms
        || track.end_ms != update.end_ms
    {
        return None;
    }

    let mut next = track.clone();
    next.music_name = update.music_name.clone();
    next.start_ms = update.next_start_ms;
    next.end_ms = update.next_end_ms;
    sync_playback_track_source_music(&mut next);
    Some(next)
}

fn playback_tracks_match_one(left: &PlaybackTrack, right: &PlaybackTrack) -> bool {
    left.playlist_name == right.playlist_name
        && left.music_name == right.music_name
        && left.music_url == right.music_url
        && left.file_path == right.file_path
        && left.start_ms == right.start_ms
        && left.end_ms == right.end_ms
        && left.liked == right.liked
}

fn sync_playback_track_source_music(track: &mut PlaybackTrack) {
    let Some(music) = track.source_music.as_mut() else {
        return;
    };

    music.alias = track.music_name.clone();
    music.path = Some(track.file_path.to_string_lossy().to_string());
    music.start_ms = track.start_ms;
    music.end_ms = track.end_ms;
    music.liked = track.liked;
}
