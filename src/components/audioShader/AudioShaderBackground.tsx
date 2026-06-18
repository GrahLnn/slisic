import { useEffect, useRef } from "react";
import {
  resolveAudioShaderDevicePixelRatio,
  resolveAudioShaderPalette,
  resolveAudioShaderPhaseDeltaMs,
  resolveAudioShaderPhaseSpeed,
  resolveAudioShaderRenderFrame,
  resolveSmoothedAudioShaderRenderFrame,
  type AudioShaderRenderFrame,
  type AudioShaderStyle,
  type AudioShaderTheme,
} from "./AudioShaderBackground.model";
import { acquireAudioVisualizationEventListener } from "@/src/flow/audioVisualization/events";
import { resolveAudioVisualizationLiveFrame } from "@/src/flow/audioVisualization/reactivity";
import { useAudioVisualizationSnapshot } from "@/src/flow/audioVisualization/store";
import { usePrefersDarkColorScheme } from "@/src/components/colorScheme";
import { recordTrace } from "@/src/debug/trace";
import vertexShaderSource from "../../shaders/audio-visualizer/vertex.glsl";
import fragmentShaderSource from "../../shaders/audio-visualizer/meshGradient.fragment.glsl";

type AudioShaderBackgroundProps = {
  style?: AudioShaderStyle;
};

type AudioShaderUniforms = {
  background: WebGLUniformLocation;
  color0: WebGLUniformLocation;
  color1: WebGLUniformLocation;
  color2: WebGLUniformLocation;
  color3: WebGLUniformLocation;
  color4: WebGLUniformLocation;
  color5: WebGLUniformLocation;
  colorMix: WebGLUniformLocation;
  resolution: WebGLUniformLocation;
  phase: WebGLUniformLocation;
  shadow: WebGLUniformLocation;
  vignette: WebGLUniformLocation;
  gestures: Partial<Record<AudioShaderGestureUniformKey, WebGLUniformLocation>>;
};

const FULLSCREEN_TRIANGLES = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
const AUDIO_SHADER_GESTURE_UNIFORMS = [
  ["accentGesture", "u_accent_gesture"],
  ["bendGesture", "u_bend_gesture"],
  ["densityPulse", "u_density_pulse"],
  ["focusGesture", "u_focus_gesture"],
  ["flowGesture", "u_flow_gesture"],
  ["sizePulse", "u_size_pulse"],
  ["travelGesture", "u_travel_gesture"],
] as const satisfies readonly (readonly [keyof AudioShaderRenderFrame, string])[];

type AudioShaderGestureUniformKey = (typeof AUDIO_SHADER_GESTURE_UNIFORMS)[number][0];

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("Audio visualizer shader compilation failed", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function readRequiredUniform(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation | null {
  const location = gl.getUniformLocation(program, name);
  if (!location) {
    console.warn(`Audio visualizer shader uniform ${name} is unavailable.`);
    return null;
  }

  return location;
}

function readOptionalUniform(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation | null {
  return gl.getUniformLocation(program, name);
}

function createAudioShaderProgram(gl: WebGLRenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) {
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("Audio visualizer shader linking failed", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  return {
    fragmentShader,
    program,
    vertexShader,
  };
}

function createAudioShaderUniforms(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
): AudioShaderUniforms | null {
  const required = {
    background: readRequiredUniform(gl, program, "u_background"),
    color0: readRequiredUniform(gl, program, "u_color0"),
    color1: readRequiredUniform(gl, program, "u_color1"),
    color2: readRequiredUniform(gl, program, "u_color2"),
    color3: readRequiredUniform(gl, program, "u_color3"),
    color4: readRequiredUniform(gl, program, "u_color4"),
    color5: readRequiredUniform(gl, program, "u_color5"),
    colorMix: readRequiredUniform(gl, program, "u_color_mix"),
    resolution: readRequiredUniform(gl, program, "u_resolution"),
    phase: readRequiredUniform(gl, program, "u_phase"),
    shadow: readRequiredUniform(gl, program, "u_shadow"),
    vignette: readRequiredUniform(gl, program, "u_vignette"),
  };

  if (!Object.values(required).every(Boolean)) {
    return null;
  }

  return {
    ...(required as Omit<AudioShaderUniforms, "gestures">),
    gestures: Object.fromEntries(
      AUDIO_SHADER_GESTURE_UNIFORMS.flatMap(([key, uniform]) => {
        const location = readOptionalUniform(gl, program, uniform);
        return location ? [[key, location]] : [];
      }),
    ),
  };
}

class AudioShaderRenderer {
  private animationFrameId: number | null = null;
  private readonly canvas: HTMLCanvasElement;
  private fragmentShader: WebGLShader | null = null;
  private gl: WebGLRenderingContext | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private program: WebGLProgram | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private motionPhase = 0;
  private lastRenderTraceAtMs = 0;
  private smoothedFrame: AudioShaderRenderFrame | null = null;
  private uniforms: AudioShaderUniforms | null = null;
  private vertexShader: WebGLShader | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly readFrame: () => AudioShaderRenderFrame,
    private readonly readTheme: () => AudioShaderTheme,
  ) {
    this.canvas = canvas;
    this.initialize();
  }

  destroy() {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
    }
    this.resizeObserver?.disconnect();

    if (this.gl && this.positionBuffer) {
      this.gl.deleteBuffer(this.positionBuffer);
    }
    if (this.gl && this.program) {
      this.gl.deleteProgram(this.program);
    }
    if (this.gl && this.vertexShader) {
      this.gl.deleteShader(this.vertexShader);
    }
    if (this.gl && this.fragmentShader) {
      this.gl.deleteShader(this.fragmentShader);
    }
  }

  wake() {
    if (document.visibilityState !== "visible") {
      return;
    }

    if (this.animationFrameId === null) {
      this.animationFrameId = window.requestAnimationFrame(this.render);
    }
  }

  private initialize() {
    const gl = this.canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!gl) {
      return;
    }

    const shaderProgram = createAudioShaderProgram(gl);
    if (!shaderProgram) {
      return;
    }

    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) {
      return;
    }

    this.gl = gl;
    this.program = shaderProgram.program;
    this.vertexShader = shaderProgram.vertexShader;
    this.fragmentShader = shaderProgram.fragmentShader;
    this.positionBuffer = positionBuffer;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLES, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(this.program, "a_position");
    if (positionLocation < 0) {
      return;
    }

    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = createAudioShaderUniforms(gl, this.program);
    if (!this.uniforms) {
      return;
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.resize();
    this.wake();
  }

  private resize() {
    if (!this.gl || !this.uniforms) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const ratio = resolveAudioShaderDevicePixelRatio(window.devicePixelRatio);
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.gl.viewport(0, 0, width, height);
    this.gl.uniform2f(this.uniforms.resolution, width, height);
  }

  private scheduleNextDraw() {
    if (document.visibilityState !== "visible") {
      return;
    }

    this.animationFrameId = window.requestAnimationFrame(this.render);
  }

  private render = () => {
    this.animationFrameId = null;
    if (!this.gl || !this.program || !this.uniforms || document.visibilityState !== "visible") {
      return;
    }

    const targetFrame = this.readFrame();
    const previousTimeMs = this.smoothedFrame ? this.smoothedFrame.timeSeconds * 1_000 : null;
    const deltaMs =
      previousTimeMs === null ? 16 : Math.max(0, targetFrame.timeSeconds * 1_000 - previousTimeMs);
    const frame = resolveSmoothedAudioShaderRenderFrame({
      current: this.smoothedFrame,
      deltaMs,
      target: targetFrame,
    });
    this.smoothedFrame = frame;
    const palette = resolveAudioShaderPalette(this.readTheme());
    const phaseSpeed = resolveAudioShaderPhaseSpeed(frame);

    this.resize();
    this.gl.useProgram(this.program);
    this.motionPhase +=
      (resolveAudioShaderPhaseDeltaMs(deltaMs) / 1_000) * phaseSpeed;
    this.gl.uniform1f(this.uniforms.phase, this.motionPhase);
    for (const [key] of AUDIO_SHADER_GESTURE_UNIFORMS) {
      const uniform = this.uniforms.gestures[key];
      if (uniform) {
        this.gl.uniform1f(uniform, frame[key]);
      }
    }
    this.gl.uniform3f(this.uniforms.background, ...palette.background);
    this.gl.uniform3f(this.uniforms.color0, ...palette.colors[0]);
    this.gl.uniform3f(this.uniforms.color1, ...palette.colors[1]);
    this.gl.uniform3f(this.uniforms.color2, ...palette.colors[2]);
    this.gl.uniform3f(this.uniforms.color3, ...palette.colors[3]);
    this.gl.uniform3f(this.uniforms.color4, ...palette.colors[4]);
    this.gl.uniform3f(this.uniforms.color5, ...palette.colors[5]);
    this.gl.uniform1f(this.uniforms.colorMix, palette.material.colorMix);
    this.gl.uniform1f(this.uniforms.shadow, palette.material.shadow);
    this.gl.uniform1f(this.uniforms.vignette, palette.material.vignette);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    const nowMs = performance.now();
    if (nowMs - this.lastRenderTraceAtMs >= 1_000) {
      this.lastRenderTraceAtMs = nowMs;
      recordTrace("player-audio-visualizer-shader-render-frame", {
        accentGesture: frame.accentGesture,
        bendGesture: frame.bendGesture,
        brightTransient: frame.brightTransient,
        canonicalMusicId: frame.canonicalMusicId,
        densityPulse: frame.densityPulse,
        flowGesture: frame.flowGesture,
        focusGesture: frame.focusGesture,
        instantEnergy: frame.instantEnergy,
        phase: this.motionPhase,
        phaseSpeed,
        reactiveAudioActive: frame.reactiveAudioActive,
        sizePulse: frame.sizePulse,
        speedPulse: frame.speedPulse,
        theme: this.readTheme(),
        timeSeconds: frame.timeSeconds,
        travelGesture: frame.travelGesture,
      });
    }

    this.scheduleNextDraw();
  };
}

export function AudioShaderBackground({
  style = "mesh-gradient",
}: AudioShaderBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<AudioShaderRenderer | null>(null);
  const snapshot = useAudioVisualizationSnapshot();
  const snapshotRef = useRef(snapshot);
  const prefersDarkColorScheme = usePrefersDarkColorScheme();
  const theme = prefersDarkColorScheme ? "dark" : "light";
  const themeRef = useRef<AudioShaderTheme>(theme);
  const styleRef = useRef<AudioShaderStyle>(style);
  const timeOriginRef = useRef(performance.now());

  snapshotRef.current = snapshot;
  themeRef.current = theme;
  styleRef.current = style;

  useEffect(() => acquireAudioVisualizationEventListener(), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const renderer = new AudioShaderRenderer(
      canvas,
      () => {
        const nowMs = performance.now();

        return resolveAudioShaderRenderFrame({
          frame: snapshotRef.current.frame
            ? resolveAudioVisualizationLiveFrame(snapshotRef.current.frame, nowMs)
            : null,
          nowMs,
          timeOriginMs: timeOriginRef.current,
        });
      },
      () => themeRef.current,
    );
    rendererRef.current = renderer;

    const handleVisibilityChange = () => renderer.wake();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      renderer.destroy();
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.wake();
  }, [snapshot.frame?.received_at_ms, snapshot.frame?.instant_energy, theme]);

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-0 overflow-hidden pointer-events-none"
      data-audio-shader-background
      data-audio-shader-style={styleRef.current}
      data-audio-shader-theme={theme}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
