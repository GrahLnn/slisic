import {
  AUDIO_VISUALIZATION_IDLE_DYNAMICS,
  AUDIO_VISUALIZATION_IDLE_LOUDNESS_ENERGY,
  AUDIO_VISUALIZATION_IDLE_PRESENCE,
  isAudioVisualizationReactiveSignalLive,
  resolveAudioVisualizationActivity,
} from "@/src/flow/audioVisualization/model";
import type { AudioVisualizationFrameSnapshot } from "@/src/flow/audioVisualization/model";

export type AudioShaderTheme = "dark" | "light";
export type AudioShaderStyle = "mesh-gradient";

export type AudioShaderRenderFrame = {
  activity: number;
  accentGesture: number;
  bendGesture: number;
  canonicalMusicId: string | null;
  brightTransient: number;
  densityPulse: number;
  dynamics: number;
  energy: number;
  focusGesture: number;
  flowGesture: number;
  instantEnergy: number;
  presence: number;
  progress: number;
  reactiveAudioActive: boolean;
  sizePulse: number;
  speedPulse: number;
  timeSeconds: number;
  travelGesture: number;
};

export type AudioShaderPalette = {
  background: readonly [number, number, number];
  colors: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  material: {
    colorMix: number;
    shadow: number;
    vignette: number;
  };
};

export const audioShaderStyles: readonly AudioShaderStyle[] = ["mesh-gradient"];
export const AUDIO_SHADER_IDLE_PHASE_SPEED = 0;
export const AUDIO_SHADER_PLAYING_PHASE_SPEED = 1.25;
export const AUDIO_SHADER_MAX_PHASE_SPEED = 2.65;
export const AUDIO_SHADER_MAX_PHASE_DELTA_MS = 34;
export const AUDIO_SHADER_LIGHT_MESH_COLORS = [
  [0.737, 0.925, 0.965],
  [0.0, 0.667, 1.0],
  [0.0, 0.969, 1.0],
  [1.0, 0.831, 0.278],
  [0.2, 0.8, 0.6],
  [0.211, 0.6, 0.8],
] as const satisfies AudioShaderPalette["colors"];
export const AUDIO_SHADER_DARK_MESH_COLORS = [
  [0.38, 0.58, 0.86],
  [0.18, 0.74, 0.82],
  [0.1, 0.52, 0.7],
  [0.34, 0.34, 0.78],
  [0.24, 0.14, 0.5],
  [0.09, 0.06, 0.18],
] as const satisfies AudioShaderPalette["colors"];

export function resolveAudioShaderPhaseSpeed(frame: AudioShaderRenderFrame) {
  if (!frame.reactiveAudioActive) {
    return AUDIO_SHADER_IDLE_PHASE_SPEED;
  }

  const speed = Math.min(1, Math.max(0, frame.speedPulse));
  const flow = Math.min(1, Math.max(0, frame.flowGesture));
  const travel = Math.min(1, Math.max(0, frame.travelGesture));
  const density = Math.min(1, Math.max(0, frame.densityPulse));
  const baseline = AUDIO_SHADER_PLAYING_PHASE_SPEED;
  const targetSpeed =
    baseline + speed * 0.72 + flow * 0.28 + travel * 0.2 + density * 0.1;

  return Math.min(AUDIO_SHADER_MAX_PHASE_SPEED, Math.max(AUDIO_SHADER_IDLE_PHASE_SPEED, targetSpeed));
}

export function resolveAudioShaderPhaseDeltaMs(deltaMs: number) {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return 0;
  }

  return Math.min(AUDIO_SHADER_MAX_PHASE_DELTA_MS, deltaMs);
}

export function resolveAudioShaderDevicePixelRatio(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  return Math.min(1.5, Math.max(1, value));
}

export function resolveAudioShaderPalette(theme: AudioShaderTheme): AudioShaderPalette {
  if (theme === "dark") {
    return {
      background: [0.008, 0.007, 0.011],
      colors: AUDIO_SHADER_DARK_MESH_COLORS,
      material: {
        colorMix: 0.76,
        shadow: 0.18,
        vignette: 0.24,
      },
    };
  }

  return {
    background: [0.992, 0.97, 0.968],
    colors: AUDIO_SHADER_LIGHT_MESH_COLORS,
    material: {
      colorMix: 0.78,
      shadow: 0.05,
      vignette: 0.08,
    },
  };
}

export function resolveAudioShaderRenderFrame(args: {
  frame: AudioVisualizationFrameSnapshot | null;
  nowMs: number;
  timeOriginMs: number;
}): AudioShaderRenderFrame {
  const activity = resolveAudioVisualizationActivity({
    frame: args.frame,
    nowMs: args.nowMs,
  });
  const reactiveSignalLive = args.frame
    ? isAudioVisualizationReactiveSignalLive({
        frame: args.frame,
        nowMs: args.nowMs,
      })
    : false;
  const staticEnergy = reactiveSignalLive
    ? (args.frame?.loudness_energy ?? AUDIO_VISUALIZATION_IDLE_LOUDNESS_ENERGY)
    : AUDIO_VISUALIZATION_IDLE_LOUDNESS_ENERGY;
  const reactiveInstantEnergy =
    reactiveSignalLive && args.frame?.instant_energy !== null ? args.frame?.instant_energy : 0;

  return {
    activity,
    accentGesture: 0,
    bendGesture: 0,
    brightTransient: reactiveSignalLive ? (args.frame?.bright_transient ?? 0) : 0,
    canonicalMusicId: args.frame ? args.frame.canonical_music_id : null,
    densityPulse: 0,
    dynamics: reactiveSignalLive
      ? (args.frame?.dynamics ?? AUDIO_VISUALIZATION_IDLE_DYNAMICS)
      : AUDIO_VISUALIZATION_IDLE_DYNAMICS,
    energy: staticEnergy,
    focusGesture: 0,
    flowGesture: 0,
    instantEnergy: reactiveInstantEnergy ?? 0,
    presence: reactiveSignalLive
      ? (args.frame?.presence ?? AUDIO_VISUALIZATION_IDLE_PRESENCE)
      : AUDIO_VISUALIZATION_IDLE_PRESENCE,
    progress: args.frame ? args.frame.range_progress : 0,
    reactiveAudioActive: reactiveSignalLive,
    sizePulse: 0,
    speedPulse: 0,
    timeSeconds: Math.max(0, args.nowMs - args.timeOriginMs) / 1_000,
    travelGesture: 0,
  };
}

function resolveAudioShaderSmoothingWeight(args: {
  current: number;
  target: number;
  deltaMs: number;
  attackMs: number;
  releaseMs: number;
}) {
  const durationMs = args.target > args.current ? args.attackMs : args.releaseMs;
  const safeDurationMs = Math.max(1, durationMs);
  const safeDeltaMs = Math.max(0, Math.min(args.deltaMs, 100));

  return 1 - Math.exp(-safeDeltaMs / safeDurationMs);
}

function smoothAudioShaderValue(args: {
  current: number;
  target: number;
  deltaMs: number;
  attackMs: number;
  releaseMs: number;
}) {
  const weight = resolveAudioShaderSmoothingWeight(args);

  return args.current + (args.target - args.current) * weight;
}

function resolveAudioShaderPerceptualEnergy(value: number) {
  const clamped = Math.min(1, Math.max(0, value));

  return Math.log1p(clamped * 9) / Math.log1p(9);
}

function resolveAudioShaderOnset(args: {
  currentInstantEnergy: number;
  targetInstantEnergy: number;
}) {
  const currentEnergy = resolveAudioShaderPerceptualEnergy(args.currentInstantEnergy);
  const targetEnergy = resolveAudioShaderPerceptualEnergy(args.targetInstantEnergy);
  const relativeLift = targetEnergy - currentEnergy * 1.04;

  return Math.min(1, Math.max(0, (relativeLift - 0.035) * 2.6));
}

function resolveAudioShaderPositiveMovement(args: {
  currentInstantEnergy: number;
  targetInstantEnergy: number;
}) {
  const currentEnergy = resolveAudioShaderPerceptualEnergy(args.currentInstantEnergy);
  const targetEnergy = resolveAudioShaderPerceptualEnergy(args.targetInstantEnergy);
  const movement = targetEnergy - currentEnergy;

  return Math.min(1, Math.max(0, (movement - 0.008) * 5.8));
}

function resetAudioShaderTransientMotion(frame: AudioShaderRenderFrame): AudioShaderRenderFrame {
  return {
    ...frame,
    accentGesture: 0,
    bendGesture: 0,
    brightTransient: 0,
    densityPulse: 0,
    focusGesture: 0,
    flowGesture: 0,
    sizePulse: 0,
    speedPulse: 0,
    travelGesture: 0,
  };
}

function seedAudioShaderReactiveMotion(frame: AudioShaderRenderFrame): AudioShaderRenderFrame {
  if (!frame.reactiveAudioActive) {
    return resetAudioShaderTransientMotion(frame);
  }

  return {
    ...resetAudioShaderTransientMotion(frame),
    activity: 0,
    brightTransient: 0,
    dynamics: AUDIO_VISUALIZATION_IDLE_DYNAMICS,
    energy: AUDIO_VISUALIZATION_IDLE_LOUDNESS_ENERGY,
    instantEnergy: 0,
    presence: AUDIO_VISUALIZATION_IDLE_PRESENCE,
  };
}

function resolveAudioShaderForwardImpulse(args: {
  current: number;
  deltaMs: number;
  event: number;
  releaseMs: number;
}) {
  const safeDeltaMs = Math.max(0, Math.min(args.deltaMs, 100));
  const release = Math.exp(-safeDeltaMs / Math.max(1, args.releaseMs));
  const residual = Math.max(0, args.current) * release;

  return Math.min(1, Math.max(residual, args.event));
}

export function resolveSmoothedAudioShaderRenderFrame(args: {
  current: AudioShaderRenderFrame | null;
  target: AudioShaderRenderFrame;
  deltaMs: number;
}): AudioShaderRenderFrame {
  if (!args.current || args.current.canonicalMusicId !== args.target.canonicalMusicId) {
    return resolveSmoothedAudioShaderRenderFrame({
      current: seedAudioShaderReactiveMotion(args.target),
      deltaMs: Math.max(16, args.deltaMs),
      target: args.target,
    });
  }
  const onset = resolveAudioShaderOnset({
    currentInstantEnergy: args.current.instantEnergy,
    targetInstantEnergy: args.target.instantEnergy,
  });
  const positiveMovement = resolveAudioShaderPositiveMovement({
    currentInstantEnergy: args.current.instantEnergy,
    targetInstantEnergy: args.target.instantEnergy,
  });
  const reactiveGate = args.target.reactiveAudioActive ? 1 : 0;
  const brightTransient = Math.min(1, Math.max(0, args.target.brightTransient)) * reactiveGate;
  const gatedOnset = onset * reactiveGate;
  const gatedMovement = positiveMovement * reactiveGate;
  const brightEvent = Math.min(1, Math.pow(brightTransient, 0.82));
  const forwardEvent = Math.min(
    1,
    Math.pow(gatedOnset, 0.82) * 0.92 +
      Math.pow(gatedMovement, 0.72) * 0.28 +
      brightEvent * 0.68,
  );
  const brightMaterialEvent = Math.min(1, Math.pow(brightEvent, 0.88));
  const speedTarget = resolveAudioShaderForwardImpulse({
    current: args.current.speedPulse,
    deltaMs: args.deltaMs,
    event: Math.min(1, forwardEvent * 1.22 + brightMaterialEvent * 0.36),
    releaseMs: 380,
  });
  const sizeTarget = resolveAudioShaderForwardImpulse({
    current: args.current.sizePulse,
    deltaMs: args.deltaMs,
    event: Math.min(1, Math.pow(gatedOnset, 0.88) * 0.72 + brightMaterialEvent * 0.42),
    releaseMs: 360,
  });
  const densityTarget = resolveAudioShaderForwardImpulse({
    current: args.current.densityPulse,
    deltaMs: args.deltaMs,
    event: Math.min(1, Math.pow(gatedOnset, 0.95) * 0.48 + brightMaterialEvent * 0.56),
    releaseMs: 360,
  });
  const travelTarget = resolveAudioShaderForwardImpulse({
    current: args.current.travelGesture,
    deltaMs: args.deltaMs,
    event: Math.min(1, forwardEvent * 0.96 + brightMaterialEvent * 0.26),
    releaseMs: 520,
  });
  const bendTarget = Math.min(1, Math.pow(gatedOnset, 0.96) * 0.38 + brightMaterialEvent * 0.22);
  const accentTarget = Math.min(1, Math.pow(gatedOnset, 0.9) * 0.62 + brightMaterialEvent * 0.72);
  const focusTarget = Math.min(1, Math.pow(gatedOnset, 0.86) * 0.72 + brightMaterialEvent * 0.9);
  const flowTarget = resolveAudioShaderForwardImpulse({
    current: args.current.flowGesture,
    deltaMs: args.deltaMs,
    event: Math.min(1, Math.pow(gatedMovement, 0.8) * 0.7 + brightMaterialEvent * 0.52),
    releaseMs: 540,
  });

  return {
    activity: smoothAudioShaderValue({
      current: args.current.activity,
      target: args.target.activity,
      deltaMs: args.deltaMs,
      attackMs: 420,
      releaseMs: 1_600,
    }),
    accentGesture: smoothAudioShaderValue({
      current: args.current.accentGesture,
      target: accentTarget,
      deltaMs: args.deltaMs,
      attackMs: 30,
      releaseMs: 220,
    }),
    bendGesture: smoothAudioShaderValue({
      current: args.current.bendGesture,
      target: bendTarget,
      deltaMs: args.deltaMs,
      attackMs: 45,
      releaseMs: 310,
    }),
    brightTransient: smoothAudioShaderValue({
      current: args.current.brightTransient,
      target: brightTransient,
      deltaMs: args.deltaMs,
      attackMs: 28,
      releaseMs: 180,
    }),
    canonicalMusicId: args.target.canonicalMusicId,
    dynamics: smoothAudioShaderValue({
      current: args.current.dynamics,
      target: args.target.dynamics,
      deltaMs: args.deltaMs,
      attackMs: 1_200,
      releaseMs: 1_600,
    }),
    energy: smoothAudioShaderValue({
      current: args.current.energy,
      target: args.target.energy,
      deltaMs: args.deltaMs,
      attackMs: 900,
      releaseMs: 1_700,
    }),
    focusGesture: smoothAudioShaderValue({
      current: args.current.focusGesture,
      target: focusTarget,
      deltaMs: args.deltaMs,
      attackMs: 24,
      releaseMs: 260,
    }),
    flowGesture: smoothAudioShaderValue({
      current: args.current.flowGesture,
      target: flowTarget,
      deltaMs: args.deltaMs,
      attackMs: 42,
      releaseMs: 420,
    }),
    instantEnergy: smoothAudioShaderValue({
      current: args.current.instantEnergy,
      target: args.target.instantEnergy,
      deltaMs: args.deltaMs,
      attackMs: 55,
      releaseMs: 190,
    }),
    presence: smoothAudioShaderValue({
      current: args.current.presence,
      target: args.target.presence,
      deltaMs: args.deltaMs,
      attackMs: 1_100,
      releaseMs: 1_600,
    }),
    progress: args.target.progress,
    reactiveAudioActive: args.target.reactiveAudioActive,
    densityPulse: smoothAudioShaderValue({
      current: args.current.densityPulse,
      target: densityTarget,
      deltaMs: args.deltaMs,
      attackMs: 42,
      releaseMs: 260,
    }),
    sizePulse: smoothAudioShaderValue({
      current: args.current.sizePulse,
      target: sizeTarget,
      deltaMs: args.deltaMs,
      attackMs: 55,
      releaseMs: 320,
    }),
    speedPulse: smoothAudioShaderValue({
      current: args.current.speedPulse,
      target: speedTarget,
      deltaMs: args.deltaMs,
      attackMs: 38,
      releaseMs: 420,
    }),
    timeSeconds: args.target.timeSeconds,
    travelGesture: smoothAudioShaderValue({
      current: args.current.travelGesture,
      target: travelTarget,
      deltaMs: args.deltaMs,
      attackMs: 42,
      releaseMs: 520,
    }),
  };
}
