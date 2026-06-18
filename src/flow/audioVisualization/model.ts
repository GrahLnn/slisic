export type PlaybackAudioVisualizationFrame = {
  session_generation: number;
  playlist_name: string;
  music_name: string;
  canonical_music_id: string;
  music_url: string;
  file_path: string;
  current_position_ms: number;
  range_start_ms: number;
  range_end_ms: number;
  range_progress: number | null;
  playing: boolean;
  paused: boolean;
  loudness_energy: number | null;
  presence: number | null;
  dynamics: number | null;
};

export type AudioVisualizationFrameSnapshot = Omit<
  PlaybackAudioVisualizationFrame,
  "dynamics" | "loudness_energy" | "presence" | "range_progress"
> & {
  bright_transient: number | null;
  dynamics: number;
  instant_energy: number | null;
  loudness_energy: number;
  presence: number;
  range_progress: number;
  received_at_ms: number;
};

export type AudioVisualizationStoreSnapshot = {
  frame: AudioVisualizationFrameSnapshot | null;
};

export const emptyAudioVisualizationSnapshot: AudioVisualizationStoreSnapshot = {
  frame: null,
};

export const AUDIO_VISUALIZATION_LIVE_SIGNAL_TTL_MS = 1_250;
export const AUDIO_VISUALIZATION_IDLE_LOUDNESS_ENERGY = 0.18;
export const AUDIO_VISUALIZATION_IDLE_PRESENCE = 0.18;
export const AUDIO_VISUALIZATION_IDLE_DYNAMICS = 0.24;

export function clampAudioVisualizationUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

export function normalizeAudioVisualizationFrame(
  frame: PlaybackAudioVisualizationFrame,
  receivedAtMs: number,
): AudioVisualizationFrameSnapshot {
  const playbackActive = frame.playing && !frame.paused;
  const rangeStartMs = Math.max(0, Math.floor(frame.range_start_ms));
  const rangeEndMs = Math.max(rangeStartMs + 1, Math.floor(frame.range_end_ms));
  const currentPositionMs = Math.min(
    rangeEndMs,
    Math.max(rangeStartMs, Math.floor(frame.current_position_ms)),
  );
  const rangeProgress =
    frame.range_progress !== null && Number.isFinite(frame.range_progress)
      ? clampAudioVisualizationUnit(frame.range_progress)
      : clampAudioVisualizationUnit(
          (currentPositionMs - rangeStartMs) / (rangeEndMs - rangeStartMs),
        );

  return {
    ...frame,
    current_position_ms: currentPositionMs,
    range_start_ms: rangeStartMs,
    range_end_ms: rangeEndMs,
    range_progress: rangeProgress,
    loudness_energy: playbackActive
      ? clampAudioVisualizationUnit(frame.loudness_energy ?? 0.35)
      : AUDIO_VISUALIZATION_IDLE_LOUDNESS_ENERGY,
    presence: playbackActive
      ? clampAudioVisualizationUnit(frame.presence ?? 0.35)
      : AUDIO_VISUALIZATION_IDLE_PRESENCE,
    dynamics: playbackActive
      ? clampAudioVisualizationUnit(frame.dynamics ?? 0.4)
      : AUDIO_VISUALIZATION_IDLE_DYNAMICS,
    bright_transient: null,
    instant_energy: null,
    received_at_ms: receivedAtMs,
  };
}

export function resolveAudioVisualizationFrameWithReactiveAudio(
  frame: AudioVisualizationFrameSnapshot,
  audio: {
    brightTransient?: number | null;
    instantEnergy?: number | null;
  },
): AudioVisualizationFrameSnapshot {
  return {
    ...frame,
    bright_transient:
      audio.brightTransient == null ? null : clampAudioVisualizationUnit(audio.brightTransient),
    instant_energy:
      audio.instantEnergy == null ? null : clampAudioVisualizationUnit(audio.instantEnergy),
  };
}

export function resolveAudioVisualizationFrameWithInstantEnergy(
  frame: AudioVisualizationFrameSnapshot,
  instantEnergy: number | null,
): AudioVisualizationFrameSnapshot {
  return resolveAudioVisualizationFrameWithReactiveAudio(frame, {
    brightTransient: frame.bright_transient,
    instantEnergy,
  });
}

export function resolveAudioVisualizationActivity(args: {
  frame: AudioVisualizationFrameSnapshot | null;
  nowMs: number;
}) {
  if (!args.frame) {
    return 0;
  }

  const ageMs = Math.max(0, args.nowMs - args.frame.received_at_ms);
  const ageFade = clampAudioVisualizationUnit(1 - ageMs / 4_000);
  const playbackGate = args.frame.playing && !args.frame.paused ? 1 : 0;

  return clampAudioVisualizationUnit(ageFade * playbackGate);
}

export function isAudioVisualizationReactiveSignalLive(args: {
  frame: AudioVisualizationFrameSnapshot;
  nowMs: number;
}) {
  if (!args.frame.playing || args.frame.paused) {
    return false;
  }

  const elapsedSinceFrameMs = Math.max(0, args.nowMs - args.frame.received_at_ms);

  return elapsedSinceFrameMs <= AUDIO_VISUALIZATION_LIVE_SIGNAL_TTL_MS;
}

export function shouldResolveAudioVisualizationReactiveSignal(args: {
  frame: AudioVisualizationFrameSnapshot;
  nowMs: number;
}) {
  return isAudioVisualizationReactiveSignalLive(args);
}
