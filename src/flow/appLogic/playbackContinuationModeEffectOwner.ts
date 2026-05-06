import type { PlaybackContinuationMode } from "@/src/cmd";

export interface PlaybackContinuationModeEffectPort {
  setPlaybackContinuationMode: (mode: PlaybackContinuationMode) => Promise<boolean>;
}

export interface PlaybackContinuationModeEffectOwner {
  request: (mode: PlaybackContinuationMode) => Promise<void>;
}

/**
 * Tauri commands cannot be cancelled after dispatch, so playback continuation
 * writes must be serialized by the owner that interprets page-level intent.
 */
export function createPlaybackContinuationModeEffectOwner(
  port: PlaybackContinuationModeEffectPort,
): PlaybackContinuationModeEffectOwner {
  let pendingMode: PlaybackContinuationMode | null = null;
  let activeMode: PlaybackContinuationMode | null = null;
  let flushPromise: Promise<void> | null = null;

  async function flush() {
    try {
      while (pendingMode !== null) {
        const mode = pendingMode;
        pendingMode = null;
        activeMode = mode;

        await port.setPlaybackContinuationMode(mode);

        activeMode = null;
        if (pendingMode === mode) {
          pendingMode = null;
        }
      }
    } finally {
      activeMode = null;
      flushPromise = null;
    }
  }

  function request(mode: PlaybackContinuationMode) {
    if (activeMode === mode) {
      pendingMode = null;
    } else {
      pendingMode = mode;
    }

    if (flushPromise !== null) {
      return flushPromise;
    }

    flushPromise = flush();

    return flushPromise;
  }

  return {
    request,
  };
}
