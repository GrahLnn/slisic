import type { PlaybackStatusPayload } from "@/src/cmd";
import { recordRenderPerformanceTrace } from "@/src/debug/renderPerformanceTrace";
import type { SpectrumPlaybackIdentity } from "./SpectrumPage.view-model";

type SpectrumPlaybackResumeTraceInput = {
  identity: SpectrumPlaybackIdentity;
  positionMs: number | null;
};

function hashTraceValue(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
}

export function createSpectrumPlaybackIdentityTracePayload(
  identity: SpectrumPlaybackIdentity | null,
) {
  if (identity === null) {
    return null;
  }

  return {
    endMs: identity.endMs,
    fileHash: hashTraceValue(identity.normalizedFilePath),
    keyHash: hashTraceValue(identity.key),
    playlistHash: hashTraceValue(identity.playlistName),
    startMs: identity.startMs,
    urlHash: hashTraceValue(identity.url),
  };
}

export function createSpectrumPlaybackResumeTracePayload(
  resume: SpectrumPlaybackResumeTraceInput | null,
) {
  if (resume === null) {
    return null;
  }

  return {
    identity: createSpectrumPlaybackIdentityTracePayload(resume.identity),
    positionMs: resume.positionMs,
  };
}

export function createSpectrumPlaybackStatusTracePayload(status: PlaybackStatusPayload | null) {
  if (status === null) {
    return null;
  }

  return {
    durationMs: status.duration_ms ?? null,
    fileHash: hashTraceValue(status.path),
    musicUrlHash: hashTraceValue(status.music_url ?? null),
    paused: status.paused,
    playbackEndMs: status.playback_end_ms ?? null,
    playbackStartMs: status.playback_start_ms ?? null,
    playing: status.playing,
    playlistHash: hashTraceValue(status.playlist_name ?? null),
    positionMs: status.position_ms,
    trackEndMs: status.track_end_ms ?? null,
    trackStartMs: status.track_start_ms ?? null,
  };
}

export function recordSpectrumPlaybackTrace(event: string, payload: Record<string, unknown> = {}) {
  recordRenderPerformanceTrace(`spectrum-playback-${event}`, payload);
}
