import { useSyncExternalStore } from "react";
import { recordTrace } from "@/src/debug/trace";
import {
  emptyAudioVisualizationSnapshot,
  shouldResolveAudioVisualizationReactiveSignal,
  normalizeAudioVisualizationFrame,
  type AudioVisualizationStoreSnapshot,
  type PlaybackAudioVisualizationFrame,
} from "./model";
import { resolveAudioVisualizationReactiveFrame } from "./reactivity";

type AudioVisualizationStoreListener = () => void;

let snapshot: AudioVisualizationStoreSnapshot = emptyAudioVisualizationSnapshot;
const listeners = new Set<AudioVisualizationStoreListener>();
let frameEpoch = 0;
let lastCommittedFrameTraceAtMs = 0;
let lastReactiveFrameTraceAtMs = 0;

function shouldRecordAudioVisualizationTrace(nowMs: number, lastTraceAtMs: number) {
  return nowMs - lastTraceAtMs >= 1_000;
}

function emitStoreChange() {
  listeners.forEach((listener) => listener());
}

export function commitAudioVisualizationFrame(frame: PlaybackAudioVisualizationFrame) {
  if (!frame.playing || frame.paused) {
    clearAudioVisualizationFrame();
    return;
  }

  const epoch = (frameEpoch += 1);
  const receivedAtMs = performance.now();
  snapshot = {
    frame: normalizeAudioVisualizationFrame(frame, receivedAtMs),
  };
  if (shouldRecordAudioVisualizationTrace(receivedAtMs, lastCommittedFrameTraceAtMs)) {
    lastCommittedFrameTraceAtMs = receivedAtMs;
    recordTrace("player-audio-visualizer-frame-committed", {
      canonicalMusicId: frame.canonical_music_id,
      currentPositionMs: frame.current_position_ms,
      dynamics: frame.dynamics,
      loudnessEnergy: frame.loudness_energy,
      musicName: frame.music_name,
      paused: frame.paused,
      playing: frame.playing,
      rangeEndMs: frame.range_end_ms,
      rangeStartMs: frame.range_start_ms,
      sessionGeneration: frame.session_generation,
    });
  }
  emitStoreChange();
  const committedFrame = snapshot.frame;
  if (!committedFrame) {
    return;
  }
  if (
    !shouldResolveAudioVisualizationReactiveSignal({
      frame: committedFrame,
      nowMs: committedFrame.received_at_ms,
    })
  ) {
    return;
  }

  void resolveAudioVisualizationReactiveFrame(committedFrame)
    .then((reactiveFrame) => {
      if (epoch !== frameEpoch) {
        return;
      }

      snapshot = {
        frame: reactiveFrame,
      };
      const nowMs = performance.now();
      if (shouldRecordAudioVisualizationTrace(nowMs, lastReactiveFrameTraceAtMs)) {
        lastReactiveFrameTraceAtMs = nowMs;
        recordTrace("player-audio-visualizer-reactive-frame-resolved", {
          brightTransient: reactiveFrame.bright_transient,
          canonicalMusicId: reactiveFrame.canonical_music_id,
          currentPositionMs: reactiveFrame.current_position_ms,
          instantEnergy: reactiveFrame.instant_energy,
          rangeProgress: reactiveFrame.range_progress,
          receivedAtMs: reactiveFrame.received_at_ms,
        });
      }
      emitStoreChange();
    })
    .catch((error) => {
      console.error("Failed to resolve audio visualization reactivity", error);
    });
}

export function clearAudioVisualizationFrame() {
  if (!snapshot.frame) {
    return;
  }

  frameEpoch += 1;
  snapshot = emptyAudioVisualizationSnapshot;
  emitStoreChange();
}

function subscribeAudioVisualizationStore(listener: AudioVisualizationStoreListener) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function readAudioVisualizationSnapshot() {
  return snapshot;
}

export function useAudioVisualizationSnapshot() {
  return useSyncExternalStore(
    subscribeAudioVisualizationStore,
    readAudioVisualizationSnapshot,
    () => emptyAudioVisualizationSnapshot,
  );
}
