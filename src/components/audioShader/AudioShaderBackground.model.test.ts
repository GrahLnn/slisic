import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIO_SHADER_DARK_MESH_COLORS,
  AUDIO_SHADER_IDLE_PHASE_SPEED,
  AUDIO_SHADER_LIGHT_MESH_COLORS,
  AUDIO_SHADER_MAX_PHASE_DELTA_MS,
  audioShaderStyles,
  AUDIO_SHADER_MAX_PHASE_SPEED,
  AUDIO_SHADER_PLAYING_PHASE_SPEED,
  type AudioShaderRenderFrame,
  resolveAudioShaderDevicePixelRatio,
  resolveAudioShaderPalette,
  resolveAudioShaderPhaseDeltaMs,
  resolveAudioShaderPhaseSpeed,
  resolveAudioShaderRenderFrame,
  resolveSmoothedAudioShaderRenderFrame,
} from "./AudioShaderBackground.model";
import { normalizeAudioVisualizationFrame } from "@/src/flow/audioVisualization/model";

const currentDir = dirname(fileURLToPath(import.meta.url));
const meshGradientShaderPath = resolve(
  currentDir,
  "../../shaders/audio-visualizer/meshGradient.fragment.glsl",
);

function resolveLuminance(color: readonly [number, number, number]) {
  return color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
}

function createRenderFrame(
  overrides: Partial<AudioShaderRenderFrame> = {},
): AudioShaderRenderFrame {
  return {
    activity: 0.2,
    accentGesture: 0,
    bendGesture: 0,
    brightTransient: 0,
    canonicalMusicId: "track:1",
    densityPulse: 0,
    dynamics: 0.2,
    energy: 0.2,
    focusGesture: 0,
    flowGesture: 0,
    instantEnergy: 0.2,
    presence: 0.2,
    progress: 0.1,
    reactiveAudioActive: true,
    sizePulse: 0,
    speedPulse: 0,
    timeSeconds: 1,
    travelGesture: 0,
    ...overrides,
  };
}

describe("AudioShaderBackground model", () => {
  test("keeps style registry explicit for future GLSL shader additions", () => {
    assert.deepEqual(audioShaderStyles, ["mesh-gradient"]);
  });

  test("caps backing pixel ratio to bound WebGL canvas memory", () => {
    assert.equal(resolveAudioShaderDevicePixelRatio(0), 1);
    assert.equal(resolveAudioShaderDevicePixelRatio(1.25), 1.25);
    assert.equal(resolveAudioShaderDevicePixelRatio(3), 1.5);
  });

  test("uses distinct GLSL materials for dark and light backgrounds", () => {
    const dark = resolveAudioShaderPalette("dark");
    const light = resolveAudioShaderPalette("light");

    assert.notDeepEqual(dark, light);
    assert.deepEqual(dark.colors, AUDIO_SHADER_DARK_MESH_COLORS);
    assert.deepEqual(light.colors, AUDIO_SHADER_LIGHT_MESH_COLORS);
    assert.equal(resolveLuminance(dark.background) < 0.05, true);
    assert.equal(resolveLuminance(light.background) > 0.9, true);
    assert.equal(dark.material.shadow > light.material.shadow, true);
    assert.equal(dark.material.vignette > light.material.vignette, true);
  });

  test("keeps the historical mesh gradient theme palettes", () => {
    const dark = resolveAudioShaderPalette("dark");
    const light = resolveAudioShaderPalette("light");

    assert.deepEqual(dark.colors, [
      [0.38, 0.58, 0.86],
      [0.18, 0.74, 0.82],
      [0.1, 0.52, 0.7],
      [0.34, 0.34, 0.78],
      [0.24, 0.14, 0.5],
      [0.09, 0.06, 0.18],
    ]);
    assert.deepEqual(light.colors, [
      [0.737, 0.925, 0.965],
      [0.0, 0.667, 1.0],
      [0.0, 0.969, 1.0],
      [1.0, 0.831, 0.278],
      [0.2, 0.8, 0.6],
      [0.211, 0.6, 0.8],
    ]);
  });

  test("keeps mesh gradient phase speed forward and bounded", () => {
    assert.equal(
      resolveAudioShaderPhaseSpeed(
        createRenderFrame({
          reactiveAudioActive: false,
        }),
      ),
      AUDIO_SHADER_IDLE_PHASE_SPEED,
    );
    assert.equal(resolveAudioShaderPhaseSpeed(createRenderFrame()), AUDIO_SHADER_PLAYING_PHASE_SPEED);
    assert.equal(
      resolveAudioShaderPhaseSpeed(
        createRenderFrame({
          speedPulse: 1,
        }),
      ) > resolveAudioShaderPhaseSpeed(createRenderFrame()),
      true,
    );
    assert.equal(
      resolveAudioShaderPhaseSpeed(
        createRenderFrame({
          flowGesture: -1,
          reactiveAudioActive: false,
          travelGesture: -1,
        }),
      ),
      AUDIO_SHADER_IDLE_PHASE_SPEED,
    );
    const fastest = resolveAudioShaderPhaseSpeed(
        createRenderFrame({
          densityPulse: 8,
          flowGesture: 8,
          speedPulse: 8,
          travelGesture: 8,
        }),
    );
    assert.equal(fastest <= AUDIO_SHADER_MAX_PHASE_SPEED, true);
    assert.equal(fastest > 2.5, true);
  });

  test("keeps playback flow close to the historical mesh gradient baseline", () => {
    const idle = resolveAudioShaderPhaseSpeed(
      createRenderFrame({
        reactiveAudioActive: false,
      }),
    );
    const playing = resolveAudioShaderPhaseSpeed(createRenderFrame());

    assert.equal(idle, AUDIO_SHADER_IDLE_PHASE_SPEED);
    assert.equal(playing, AUDIO_SHADER_PLAYING_PHASE_SPEED);
    assert.equal(idle, 0);
    assert.equal(playing >= 1.25, true);
  });

  test("lets audio impulses push mesh flow into the historical accent speed range", () => {
    const accented = resolveAudioShaderPhaseSpeed(
      createRenderFrame({
        densityPulse: 0.5,
        flowGesture: 0.7,
        speedPulse: 0.8,
        travelGesture: 0.6,
      }),
    );

    assert.equal(accented > 1.85, true);
    assert.equal(accented <= AUDIO_SHADER_MAX_PHASE_SPEED, true);
  });

  test("caps mesh gradient phase step so dropped frames do not jump the field", () => {
    assert.equal(resolveAudioShaderPhaseDeltaMs(-1), 0);
    assert.equal(resolveAudioShaderPhaseDeltaMs(Number.NaN), 0);
    assert.equal(resolveAudioShaderPhaseDeltaMs(16), 16);
    assert.equal(resolveAudioShaderPhaseDeltaMs(120), AUDIO_SHADER_MAX_PHASE_DELTA_MS);
  });

  test("keeps audio gestures out of mesh coordinates so releases cannot pull motion backward", () => {
    const shaderSource = readFileSync(meshGradientShaderPath, "utf8");
    const coordinateSection = shaderSource.slice(
      shaderSource.indexOf("vec2 forwardMeshField"),
      shaderSource.indexOf("void main()"),
    );

    assert.equal(shaderSource.includes("forwardMeshField"), true);
    assert.equal(shaderSource.includes("danceField"), false);
    assert.equal(shaderSource.includes("vec2 tangent"), false);
    assert.equal(shaderSource.includes("accentStep"), false);
    assert.equal(shaderSource.includes("walk ="), false);
    assert.equal(shaderSource.includes("rotate2d(angle)"), true);
    assert.equal(shaderSource.includes("float angle = t * 0.34;"), true);
    assert.equal(shaderSource.includes("float stride = t * (0.52 + index * 0.045) + a;"), true);
    assert.equal(shaderSource.includes("float angle = -"), false);
    assert.equal(shaderSource.includes("float stride = -"), false);
    assert.equal(coordinateSection.includes("travel"), false);
    assert.equal(coordinateSection.includes("flow"), false);
    assert.equal(coordinateSection.includes("bend"), false);
    assert.equal(coordinateSection.includes("accent"), false);
    assert.equal(coordinateSection.includes("density"), false);
    assert.equal(coordinateSection.includes("size"), false);
  });

  test("routes size and density audio gestures into GLSL material uniforms", () => {
    const shaderSource = readFileSync(meshGradientShaderPath, "utf8");

    assert.equal(AUDIO_SHADER_DARK_MESH_COLORS.length, 6);
    assert.equal(AUDIO_SHADER_LIGHT_MESH_COLORS.length, 6);
    assert.equal(shaderSource.includes("uniform vec3 u_color5;"), true);
    assert.equal(shaderSource.includes("for (int i = 0; i < 6; i++)"), true);
    assert.equal(shaderSource.includes("uniform float u_size_pulse;"), true);
    assert.equal(shaderSource.includes("uniform float u_density_pulse;"), true);
    assert.equal(shaderSource.includes("float density = clamp(u_density_pulse"), true);
    assert.equal(shaderSource.includes("float size = clamp(u_size_pulse"), true);
    assert.equal(shaderSource.includes("length(shapeUv - pos) / (1.0 + size"), true);
    assert.equal(shaderSource.includes("vec3 avgColor ="), true);
    assert.equal(shaderSource.includes("avgColor * 0.42"), true);
    assert.equal(shaderSource.includes("float clarity = focus * 0.78 + density * 0.5"), true);
    assert.equal(shaderSource.includes("melt * 0.009"), true);
    assert.equal(shaderSource.includes("float saturation = clamp"), true);
    assert.equal(shaderSource.includes("finalColor = mix(avgColor, finalColor, 0.9);"), true);
  });

  test("projects instant waveform energy into shader uniforms", () => {
    const frame = normalizeAudioVisualizationFrame(
      {
        canonical_music_id: "track:1",
        current_position_ms: 1_500,
        dynamics: 0.5,
        file_path: "C:/music/demo.m4a",
        loudness_energy: 0.7,
        music_name: "Demo",
        music_url: "https://example.com/demo",
        paused: false,
        playing: true,
        playlist_name: "List",
        presence: 0.4,
        range_end_ms: 2_000,
        range_progress: null,
        range_start_ms: 1_000,
        session_generation: 1,
      },
      100,
    );

    const renderFrame = resolveAudioShaderRenderFrame({
      frame: {
        ...frame,
        instant_energy: 0.92,
      },
      nowMs: 120,
      timeOriginMs: 20,
    });

    assert.equal(renderFrame.canonicalMusicId, "track:1");
    assert.equal(renderFrame.instantEnergy, 0.92);
    assert.equal(renderFrame.energy, 0.7);
    assert.equal(renderFrame.activity > 0.9, true);
  });

  test("does not project stale or stopped audio frames into reactive shader signal", () => {
    const frame = normalizeAudioVisualizationFrame(
      {
        canonical_music_id: "track:1",
        current_position_ms: 1_500,
        dynamics: 0.5,
        file_path: "C:/music/demo.m4a",
        loudness_energy: 0.7,
        music_name: "Demo",
        music_url: "https://example.com/demo",
        paused: false,
        playing: false,
        playlist_name: "List",
        presence: 0.4,
        range_end_ms: 2_000,
        range_progress: null,
        range_start_ms: 1_000,
        session_generation: 1,
      },
      100,
    );

    const renderFrame = resolveAudioShaderRenderFrame({
      frame: {
        ...frame,
        bright_transient: 0.88,
        instant_energy: 0.92,
      },
      nowMs: 120,
      timeOriginMs: 20,
    });

    assert.equal(renderFrame.brightTransient, 0);
    assert.equal(renderFrame.instantEnergy, 0);
    assert.equal(renderFrame.activity, 0);
    assert.equal(renderFrame.energy, 0.18);
    assert.equal(renderFrame.presence, 0.18);
    assert.equal(renderFrame.dynamics, 0.24);
  });

  test("does not turn inactive target residue into dance gestures", () => {
    const current = createRenderFrame({
      activity: 0,
      instantEnergy: 0.1,
      reactiveAudioActive: false,
    });
    const smoothed = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target: {
        ...current,
        activity: 0.2,
        brightTransient: 0.9,
        instantEnergy: 1,
        reactiveAudioActive: false,
        timeSeconds: 1.016,
      },
    });

    assert.equal(smoothed.speedPulse, 0);
    assert.equal(smoothed.sizePulse, 0);
    assert.equal(smoothed.densityPulse, 0);
    assert.equal(smoothed.travelGesture, 0);
    assert.equal(smoothed.bendGesture, 0);
    assert.equal(smoothed.accentGesture, 0);
    assert.equal(smoothed.focusGesture, 0);
    assert.equal(smoothed.flowGesture, 0);
  });

  test("turns off reactive playback immediately and decays gestures when playback stops", () => {
    const current = createRenderFrame({
      activity: 1,
      accentGesture: 0.6,
      bendGesture: 0.5,
      densityPulse: 0.7,
      dynamics: 0.86,
      energy: 0.8,
      flowGesture: 0.6,
      focusGesture: 0.5,
      instantEnergy: 0.9,
      presence: 0.75,
      sizePulse: 0.7,
      speedPulse: 0.8,
      travelGesture: 0.6,
    });
    const stopped = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target: createRenderFrame({
        activity: 0,
        canonicalMusicId: current.canonicalMusicId,
        dynamics: 0.24,
        energy: 0.18,
        instantEnergy: 0,
        presence: 0.18,
        reactiveAudioActive: false,
        timeSeconds: 1.016,
      }),
    });

    assert.equal(stopped.reactiveAudioActive, false);
    assert.equal(resolveAudioShaderPhaseSpeed(stopped), AUDIO_SHADER_IDLE_PHASE_SPEED);
    assert.equal(stopped.speedPulse < current.speedPulse, true);
    assert.equal(stopped.sizePulse < current.sizePulse, true);
    assert.equal(stopped.densityPulse < current.densityPulse, true);
    assert.equal(stopped.travelGesture < current.travelGesture, true);
    assert.equal(stopped.bendGesture < current.bendGesture, true);
    assert.equal(stopped.accentGesture < current.accentGesture, true);
    assert.equal(stopped.focusGesture < current.focusGesture, true);
    assert.equal(stopped.flowGesture < current.flowGesture, true);
  });

  test("keeps playback anchors reactive while their range can still advance", () => {
    const frame = normalizeAudioVisualizationFrame(
      {
        canonical_music_id: "track:1",
        current_position_ms: 1_500,
        dynamics: 0.5,
        file_path: "C:/music/demo.m4a",
        loudness_energy: 0.7,
        music_name: "Demo",
        music_url: "https://example.com/demo",
        paused: false,
        playing: true,
        playlist_name: "List",
        presence: 0.4,
        range_end_ms: 2_000,
        range_progress: null,
        range_start_ms: 1_000,
        session_generation: 1,
      },
      100,
    );

    const renderFrame = resolveAudioShaderRenderFrame({
      frame: {
        ...frame,
        bright_transient: 0.88,
        instant_energy: 0.92,
      },
      nowMs: 1_500,
      timeOriginMs: 20,
    });

    assert.equal(renderFrame.brightTransient, 0.88);
    assert.equal(renderFrame.instantEnergy, 0.92);
  });

  test("smooths sudden audio jumps before they become dance gestures", () => {
    const current = createRenderFrame({
      instantEnergy: 0.1,
    });
    const target = createRenderFrame({
      activity: 1,
      dynamics: 1,
      energy: 1,
      instantEnergy: 1,
      presence: 1,
      progress: 0.8,
      timeSeconds: 1.016,
    });

    const smoothed = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target,
    });

    assert.equal(smoothed.timeSeconds, target.timeSeconds);
    assert.equal(smoothed.progress, target.progress);
    assert.equal(smoothed.instantEnergy > current.instantEnergy, true);
    assert.equal(smoothed.instantEnergy < 0.34, true);
    assert.equal(smoothed.energy < 0.24, true);
    assert.equal(smoothed.activity < 0.24, true);
    assert.equal(smoothed.flowGesture > 0, true);
    assert.equal(smoothed.travelGesture > smoothed.bendGesture, true);
    assert.equal(smoothed.focusGesture > smoothed.accentGesture, true);
    assert.equal(smoothed.accentGesture > smoothed.bendGesture, true);
  });

  test("maps only transient onset into dance gestures", () => {
    const current = createRenderFrame({
      instantEnergy: 0.5,
    });

    const sustained = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target: {
        ...current,
        activity: 1,
        dynamics: 1,
        energy: 1,
        instantEnergy: 0.5,
        presence: 1,
        timeSeconds: 1.016,
      },
    });

    const onset = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target: {
        ...current,
        instantEnergy: 0.95,
        timeSeconds: 1.016,
      },
    });

    assert.equal(sustained.speedPulse, 0);
    assert.equal(sustained.sizePulse, 0);
    assert.equal(sustained.densityPulse, 0);
    assert.equal(sustained.travelGesture, 0);
    assert.equal(sustained.bendGesture, 0);
    assert.equal(sustained.accentGesture, 0);
    assert.equal(sustained.focusGesture, 0);
    assert.equal(sustained.flowGesture, 0);
    assert.equal(onset.speedPulse > onset.sizePulse, true);
    assert.equal(onset.sizePulse > onset.densityPulse, true);
    assert.equal(onset.travelGesture > onset.bendGesture, true);
    assert.equal(onset.focusGesture > onset.accentGesture, true);
    assert.equal(onset.accentGesture > onset.bendGesture, true);
  });

  test("resets transient pulses when the music identity changes", () => {
    const current = createRenderFrame({
      activity: 1,
      accentGesture: 0.12,
      bendGesture: 0.2,
      densityPulse: 0.1,
      focusGesture: 0.25,
      flowGesture: 0.3,
      instantEnergy: 0.1,
      sizePulse: 0.2,
      speedPulse: 0.3,
      travelGesture: 0.4,
    });

    const switched = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target: {
        ...current,
        canonicalMusicId: "track:2",
        densityPulse: 0,
        instantEnergy: 1,
        sizePulse: 0,
        speedPulse: 0,
        timeSeconds: 1.016,
      },
    });

    assert.equal(switched.canonicalMusicId, "track:2");
    assert.equal(switched.speedPulse > 0, true);
    assert.equal(switched.sizePulse > 0, true);
    assert.equal(switched.densityPulse > 0, true);
    assert.equal(switched.travelGesture > 0, true);
    assert.equal(switched.bendGesture > 0, true);
    assert.equal(switched.brightTransient, 0);
    assert.equal(switched.accentGesture > 0, true);
    assert.equal(switched.focusGesture > 0, true);
    assert.equal(switched.flowGesture > 0, true);
    assert.equal(switched.speedPulse <= 1, true);
    assert.equal(switched.travelGesture <= 1, true);
    assert.equal(switched.sizePulse !== current.sizePulse, true);
    assert.equal(switched.densityPulse !== current.densityPulse, true);
  });

  test("does not swallow the first reactive audio frame as a new idle baseline", () => {
    const firstReactive = resolveSmoothedAudioShaderRenderFrame({
      current: null,
      deltaMs: 16,
      target: createRenderFrame({
        activity: 1,
        brightTransient: 0.75,
        instantEnergy: 0.88,
        timeSeconds: 1,
      }),
    });

    assert.equal(firstReactive.reactiveAudioActive, true);
    assert.equal(firstReactive.instantEnergy > 0, true);
    assert.equal(firstReactive.speedPulse > 0.25, true);
    assert.equal(firstReactive.sizePulse > 0.1, true);
    assert.equal(firstReactive.densityPulse > 0.1, true);
    assert.equal(firstReactive.travelGesture > 0.15, true);
    assert.equal(firstReactive.accentGesture > 0.1, true);
    assert.equal(resolveAudioShaderPhaseSpeed(firstReactive) > AUDIO_SHADER_PLAYING_PHASE_SPEED, true);
  });

  test("does not map falling waveform movement into a reverse gesture", () => {
    const current = createRenderFrame({
      instantEnergy: 0.5,
    });

    const dip = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target: {
        ...current,
        instantEnergy: 0.42,
        timeSeconds: 1.016,
      },
    });

    assert.equal(dip.accentGesture, 0);
    assert.equal(dip.focusGesture, 0);
    assert.equal(dip.flowGesture, 0);
    assert.equal(dip.travelGesture, 0);
    assert.equal(dip.speedPulse, 0);
  });

  test("maps bright transient timbre events into the same dance path", () => {
    const current = createRenderFrame({
      instantEnergy: 0.5,
    });

    const bright = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target: {
        ...current,
        brightTransient: 0.85,
        instantEnergy: 0.5,
        timeSeconds: 1.016,
      },
    });

    assert.equal(bright.accentGesture > 0, true);
    assert.equal(bright.focusGesture > 0, true);
    assert.equal(bright.flowGesture > 0, true);
    assert.equal(bright.travelGesture > 0, true);
    assert.equal(bright.densityPulse > 0, true);
  });

  test("projects strong drum transients into visible material gestures", () => {
    const current = createRenderFrame({
      instantEnergy: 0.15,
    });

    const strong = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 48,
      target: {
        ...current,
        brightTransient: 0.95,
        instantEnergy: 0.95,
        timeSeconds: 1.048,
      },
    });

    assert.equal(strong.speedPulse > 0.5, true);
    assert.equal(strong.sizePulse > 0.25, true);
    assert.equal(strong.densityPulse > 0.25, true);
    assert.equal(strong.focusGesture > 0.3, true);
    assert.equal(strong.accentGesture > 0.22, true);
    assert.equal(resolveAudioShaderPhaseSpeed(strong) > 1.85, true);
  });

  test("releases audio impulses by reducing future acceleration without reversing phase speed", () => {
    const current = createRenderFrame({
      densityPulse: 0.3,
      flowGesture: 0.42,
      instantEnergy: 0.8,
      sizePulse: 0.22,
      speedPulse: 0.5,
      travelGesture: 0.46,
    });
    const released = resolveSmoothedAudioShaderRenderFrame({
      current,
      deltaMs: 16,
      target: {
        ...current,
        brightTransient: 0,
        instantEnergy: 0.62,
        timeSeconds: 1.016,
      },
    });

    assert.equal(resolveAudioShaderPhaseSpeed(released) >= AUDIO_SHADER_IDLE_PHASE_SPEED, true);
    assert.equal(released.speedPulse > 0, true);
    assert.equal(released.travelGesture > 0, true);
    assert.equal(released.flowGesture > 0, true);
    assert.equal(released.speedPulse <= current.speedPulse, true);
    assert.equal(released.travelGesture <= current.travelGesture, true);
  });

  test("compresses loud transients before mapping them into dance gestures", () => {
    const base = createRenderFrame();

    const quietLift = resolveSmoothedAudioShaderRenderFrame({
      current: base,
      deltaMs: 16,
      target: {
        ...base,
        instantEnergy: 0.4,
        timeSeconds: 1.016,
      },
    });
    const loudLift = resolveSmoothedAudioShaderRenderFrame({
      current: {
        ...base,
        instantEnergy: 0.8,
      },
      deltaMs: 16,
      target: {
        ...base,
        instantEnergy: 1,
        timeSeconds: 1.016,
      },
    });

    assert.equal(loudLift.speedPulse <= quietLift.speedPulse, true);
    assert.equal(loudLift.sizePulse <= quietLift.sizePulse, true);
    assert.equal(loudLift.travelGesture <= quietLift.travelGesture, true);
    assert.equal(loudLift.bendGesture <= quietLift.bendGesture, true);
    assert.equal(loudLift.accentGesture <= quietLift.accentGesture, true);
    assert.equal(loudLift.focusGesture <= quietLift.focusGesture, true);
    assert.equal(loudLift.flowGesture <= quietLift.flowGesture, true);
  });
});
