import { useEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { usePrefersDarkColorScheme } from "@/src/components/colorScheme";
import fragmentShaderSource from "@/src/shaders/glass/lens.fragment.glsl";
import vertexShaderSource from "@/src/shaders/glass/vertex.glsl";

type GlassSurfaceVariant = "button" | "titlebar";

type GlassSurfaceProps = HTMLAttributes<HTMLSpanElement> & {
  variant: GlassSurfaceVariant;
};

type GlassUniforms = {
  activation: WebGLUniformLocation;
  pointer: WebGLUniformLocation;
  pressed: WebGLUniformLocation;
  resolution: WebGLUniformLocation;
  theme: WebGLUniformLocation;
  time: WebGLUniformLocation;
  variant: WebGLUniformLocation;
};

type GlassTarget = {
  element: HTMLElement;
  host: HTMLElement;
  readTheme: () => number;
  variant: GlassSurfaceVariant;
};

const FULLSCREEN_TRIANGLES = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

function resolveGlassDevicePixelRatio(devicePixelRatio: number) {
  return Math.min(Math.max(devicePixelRatio || 1, 1), 1.5);
}

function compileGlassShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("Glass shader compilation failed", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function readGlassUniform(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation | null {
  const location = gl.getUniformLocation(program, name);
  if (!location) {
    console.warn(`Glass shader uniform ${name} is unavailable.`);
    return null;
  }

  return location;
}

function createGlassProgram(gl: WebGLRenderingContext) {
  const vertexShader = compileGlassShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileGlassShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
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
    console.warn("Glass shader linking failed", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  return { fragmentShader, program, vertexShader };
}

function createGlassUniforms(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
): GlassUniforms | null {
  const uniforms = {
    activation: readGlassUniform(gl, program, "u_activation"),
    pointer: readGlassUniform(gl, program, "u_pointer"),
    pressed: readGlassUniform(gl, program, "u_pressed"),
    resolution: readGlassUniform(gl, program, "u_resolution"),
    theme: readGlassUniform(gl, program, "u_theme"),
    time: readGlassUniform(gl, program, "u_time"),
    variant: readGlassUniform(gl, program, "u_variant"),
  };

  if (!Object.values(uniforms).every(Boolean)) {
    return null;
  }

  return uniforms as GlassUniforms;
}

function approach(current: number, target: number, stiffness: number) {
  return current + (target - current) * stiffness;
}

class GlassSurfaceRenderer {
  private animationFrameId: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private disposed = false;
  private fragmentShader: WebGLShader | null = null;
  private gl: WebGLRenderingContext | null = null;
  private glContextLost = false;
  private lastFrameMs = performance.now();
  private positionBuffer: WebGLBuffer | null = null;
  private positionLocation = -1;
  private program: WebGLProgram | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private initializationAttempted = false;
  private uniforms: GlassUniforms | null = null;
  private vertexShader: WebGLShader | null = null;
  private readonly pointer = { x: 0.5, y: 0.5 };
  private readonly targetPointer = { x: 0.5, y: 0.5 };
  private activation = 0;
  private targetActivation = 0;
  private pressed = 0;
  private targetPressed = 0;
  private timeSeconds = 0;
  private theme = 0;

  constructor(private target: GlassTarget) {
    this.targetActivation = target.variant === "titlebar" ? 1 : 0;
    this.activation = this.targetActivation;
    this.attachTarget(target);
  }

  destroy() {
    this.disposed = true;
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

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
    this.gl = null;
    this.program = null;
    this.uniforms = null;
    this.positionBuffer = null;
    this.positionLocation = -1;
    this.vertexShader = null;
    this.fragmentShader = null;
    this.canvas?.removeEventListener("webglcontextlost", this.handleContextLost, false);
    this.canvas?.removeEventListener("webglcontextrestored", this.handleContextRestored, false);
    this.canvas?.remove();
    this.canvas = null;
  }

  setInteraction(active: boolean) {
    if (this.disposed) {
      return;
    }

    this.targetActivation = this.target.variant === "titlebar" ? 1 : active ? 1 : 0;
    this.wake();
  }

  setPressed(pressed: boolean) {
    if (this.disposed) {
      return;
    }

    this.targetPressed = pressed ? 1 : 0;
    this.wake();
  }

  setPointer(clientX: number, clientY: number) {
    if (this.disposed) {
      return;
    }

    const rect = this.target.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    this.targetPointer.x = (clientX - rect.left) / rect.width;
    this.targetPointer.y = (clientY - rect.top) / rect.height;
    this.wake();
  }

  attachTarget(target: GlassTarget) {
    if (this.disposed) {
      return;
    }

    if (this.target.host !== target.host) {
      this.canvas?.remove();
      target.host.appendChild(this.resolveCanvas());
    } else if (!this.canvas?.isConnected) {
      target.host.appendChild(this.resolveCanvas());
    }

    this.target = target;
    this.targetActivation = target.variant === "titlebar" ? 1 : this.targetActivation;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.gl || !this.initializationAttempted) {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
        this.wake();
      });
      this.resizeObserver.observe(this.target.element);
    }

    this.resize();
    this.wake();
  }

  wake() {
    if (
      this.disposed ||
      document.visibilityState !== "visible" ||
      this.animationFrameId !== null ||
      this.glContextLost
    ) {
      return;
    }

    if (!this.gl && !this.initializationAttempted) {
      this.initialize();
    }

    if (!this.gl || !this.program || !this.uniforms) {
      return;
    }

    this.animationFrameId = window.requestAnimationFrame(this.render);
  }

  private resolveCanvas() {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.className = "block h-full w-full";
      this.canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
      this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
    }

    return this.canvas;
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    if (this.disposed) {
      return;
    }

    this.glContextLost = true;
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.gl = null;
    this.program = null;
    this.uniforms = null;
    this.positionBuffer = null;
    this.positionLocation = -1;
    this.vertexShader = null;
    this.fragmentShader = null;
    this.initializationAttempted = false;
  };

  private handleContextRestored = () => {
    if (this.disposed) {
      return;
    }

    this.glContextLost = false;
    this.initialize();
  };

  private initialize() {
    if (this.disposed || this.glContextLost) {
      return;
    }

    this.initializationAttempted = true;
    const canvas = this.resolveCanvas();

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      powerPreference: this.target.variant === "titlebar" ? "low-power" : "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!gl) {
      return;
    }

    const shaderProgram = createGlassProgram(gl);
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
    this.positionLocation = positionLocation;

    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = createGlassUniforms(gl, this.program);
    if (!this.uniforms) {
      return;
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.wake();
    });
    this.resizeObserver.observe(this.target.element);
    this.resize();
    this.wake();
  }

  private resize() {
    if (this.disposed || this.glContextLost || !this.gl || !this.uniforms) {
      return;
    }

    if (!this.canvas) {
      return;
    }

    const rect = this.target.element.getBoundingClientRect();
    const ratio = resolveGlassDevicePixelRatio(window.devicePixelRatio);
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    if (this.gl.isContextLost()) {
      this.handleContextLost(new Event("webglcontextlost"));
      return;
    }

    this.gl.viewport(0, 0, width, height);
    this.gl.uniform2f(this.uniforms.resolution, width, height);
  }

  private render = (nowMs: number) => {
    this.animationFrameId = null;
    if (
      this.disposed ||
      !this.gl ||
      !this.program ||
      !this.uniforms ||
      !this.positionBuffer ||
      this.positionLocation < 0 ||
      this.glContextLost ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    if (this.gl.isContextLost()) {
      this.handleContextLost(new Event("webglcontextlost"));
      return;
    }

    const deltaSeconds = Math.min(Math.max((nowMs - this.lastFrameMs) / 1_000, 0), 0.05);
    this.lastFrameMs = nowMs;
    this.timeSeconds += deltaSeconds;
    this.theme = approach(this.theme, this.target.readTheme(), 0.12);
    this.activation = approach(this.activation, this.targetActivation, 0.18);
    this.pressed = approach(this.pressed, this.targetPressed, 0.2);
    this.pointer.x = approach(this.pointer.x, this.targetPointer.x, 0.16);
    this.pointer.y = approach(this.pointer.y, this.targetPointer.y, 0.16);

    this.resize();
    if (
      this.disposed ||
      !this.gl ||
      !this.program ||
      !this.uniforms ||
      !this.positionBuffer ||
      this.positionLocation < 0 ||
      this.glContextLost
    ) {
      return;
    }

    this.gl.useProgram(this.program);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.enableVertexAttribArray(this.positionLocation);
    this.gl.vertexAttribPointer(this.positionLocation, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.uniform1f(this.uniforms.time, this.timeSeconds);
    this.gl.uniform2f(this.uniforms.pointer, this.pointer.x, this.pointer.y);
    this.gl.uniform1f(this.uniforms.activation, this.activation);
    this.gl.uniform1f(this.uniforms.pressed, this.pressed);
    this.gl.uniform1f(this.uniforms.theme, this.theme);
    this.gl.uniform1f(this.uniforms.variant, this.target.variant === "titlebar" ? 1 : 0);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);

    const shouldContinue =
      this.target.variant === "titlebar" ||
      Math.abs(this.activation - this.targetActivation) > 0.005 ||
      Math.abs(this.pressed - this.targetPressed) > 0.005 ||
      this.activation > 0.01;
    if (shouldContinue) {
      this.wake();
    }
  };

  isDisposed() {
    return this.disposed;
  }
}

let sharedButtonGlassRenderer: GlassSurfaceRenderer | null = null;

function acquireButtonGlassRenderer(target: GlassTarget) {
  if (!sharedButtonGlassRenderer || sharedButtonGlassRenderer.isDisposed()) {
    sharedButtonGlassRenderer = new GlassSurfaceRenderer(target);
  } else {
    sharedButtonGlassRenderer.attachTarget(target);
  }

  return sharedButtonGlassRenderer;
}

function readButtonGlassRenderer() {
  return sharedButtonGlassRenderer;
}

export function GlassSurface({ className, variant, ...props }: GlassSurfaceProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const rendererRef = useRef<GlassSurfaceRenderer | null>(null);
  const prefersDarkColorScheme = usePrefersDarkColorScheme();
  const themeRef = useRef(prefersDarkColorScheme ? 1 : 0);
  themeRef.current = prefersDarkColorScheme ? 1 : 0;

  useEffect(() => {
    const host = hostRef.current;
    const target = host?.parentElement;
    if (!host || !(target instanceof HTMLElement)) {
      return undefined;
    }

    const glassTarget = {
      element: target,
      host,
      readTheme: () => themeRef.current,
      variant,
    } satisfies GlassTarget;
    const renderer =
      variant === "button" ? readButtonGlassRenderer() : new GlassSurfaceRenderer(glassTarget);
    rendererRef.current = renderer;

    const handlePointerEnter = (event: PointerEvent) => {
      const activeRenderer = acquireButtonGlassRenderer(glassTarget);
      rendererRef.current = activeRenderer;
      activeRenderer.setPointer(event.clientX, event.clientY);
      activeRenderer.setInteraction(true);
    };
    const handlePointerMove = (event: PointerEvent) => {
      const activeRenderer = acquireButtonGlassRenderer(glassTarget);
      rendererRef.current = activeRenderer;
      activeRenderer.setPointer(event.clientX, event.clientY);
    };
    const handlePointerLeave = () => {
      const activeRenderer = acquireButtonGlassRenderer(glassTarget);
      rendererRef.current = activeRenderer;
      activeRenderer.setInteraction(false);
      activeRenderer.setPressed(false);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const activeRenderer = acquireButtonGlassRenderer(glassTarget);
      rendererRef.current = activeRenderer;
      activeRenderer.setPointer(event.clientX, event.clientY);
      activeRenderer.setPressed(true);
    };
    const handlePointerUp = () => {
      const activeRenderer = readButtonGlassRenderer();
      activeRenderer?.setPressed(false);
    };
    const handleFocusIn = () => {
      const activeRenderer = acquireButtonGlassRenderer(glassTarget);
      rendererRef.current = activeRenderer;
      activeRenderer.setInteraction(true);
    };
    const handleFocusOut = () => {
      const activeRenderer = acquireButtonGlassRenderer(glassTarget);
      rendererRef.current = activeRenderer;
      activeRenderer.setInteraction(false);
      activeRenderer.setPressed(false);
    };
    const handleVisibilityChange = () => {
      if (variant === "button") {
        readButtonGlassRenderer()?.wake();
        return;
      }

      renderer?.wake();
    };

    if (variant === "button") {
      target.addEventListener("pointerenter", handlePointerEnter);
      target.addEventListener("pointermove", handlePointerMove);
      target.addEventListener("pointerleave", handlePointerLeave);
      target.addEventListener("pointerdown", handlePointerDown);
      window.addEventListener("pointerup", handlePointerUp);
      target.addEventListener("focusin", handleFocusIn);
      target.addEventListener("focusout", handleFocusOut);
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (variant === "button") {
        target.removeEventListener("pointerenter", handlePointerEnter);
        target.removeEventListener("pointermove", handlePointerMove);
        target.removeEventListener("pointerleave", handlePointerLeave);
        target.removeEventListener("pointerdown", handlePointerDown);
        window.removeEventListener("pointerup", handlePointerUp);
        target.removeEventListener("focusin", handleFocusIn);
        target.removeEventListener("focusout", handleFocusOut);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (variant === "titlebar" && renderer) {
        renderer.destroy();
      }
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
    };
  }, [variant]);

  useEffect(() => {
    rendererRef.current?.wake();
  }, [prefersDarkColorScheme]);

  return (
    <span
      {...props}
      ref={hostRef}
      aria-hidden="true"
      className={cn("webgl-glass-surface pointer-events-none absolute overflow-hidden", className)}
      data-glass-surface={variant}
    />
  );
}
