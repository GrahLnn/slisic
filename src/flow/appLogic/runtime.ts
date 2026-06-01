import { createSender } from "@grahlnn/fn/flow";
import { createActor } from "xstate";
import { payloads } from "./events";
import { machine } from "./machine";

export let actor = createActor(machine);
export let send = createSender(actor);

export const openPlaylist = payloads["playlist.open"];
export const playPlaylist = payloads["playlist.play"];
export const playlistPlaybackAccepted = payloads["playlist.playback.accepted"];
export const playlistPlaybackStopped = payloads["playlist.playback.stopped"];
export const playlistUpserted = payloads["playlist.upserted"];
export const playlistDeleted = payloads["playlist.deleted"];
export const playlistPreviewChanged = payloads["playlist.preview.changed"];
export const draftNameChanged = payloads["draft.name.changed"];
export const spectrumMusicNameChanged = payloads["spectrum.music_name.changed"];
export const spectrumMusicRangeChanged = payloads["spectrum.music_range.changed"];
export const spectrumMusicDeleted = payloads["spectrum.music_deleted"];
export const spectrumMusicCreateStarted = payloads["spectrum.music_create_started"];
export const spectrumMusicDraftReset = payloads["spectrum.music_draft.reset"];
export const spectrumPlaybackScopeChanged = payloads["spectrum.playback_scope.changed"];
export const spectrumMusicUpdatesCommitted = payloads["spectrum.music_updates.committed"];
export const spectrumMusicCreatesCommitted = payloads["spectrum.music_creates.committed"];
export const spectrumMusicDeletesCommitted = payloads["spectrum.music_deletes.committed"];
export const spectrumMusicCommitFailed = payloads["spectrum.music_commit.failed"];
export const savePathChanged = payloads["save_path.changed"];
export const collectionUpserted = payloads["collection.upserted"];
export const draftCollectionUpserted = payloads["draft.collection.upserted"];
export const draftItemIncluded = payloads["draft.item.included"];
export const draftItemRemoved = payloads["draft.item.removed"];
export const draftExtraRemoved = payloads["draft.extra.removed"];
export const collectionUpdatesRequested = payloads["collection.updates.requested"];
export const excludeAdded = payloads["exclude.added"];
export const excludeRemoved = payloads["exclude.removed"];
export const nowPlayingTrackChanged = payloads["player.now_playing_track.changed"];

export function resetRuntimeActor() {
  actor = createActor(machine);
  send = createSender(actor);
}
