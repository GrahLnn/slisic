import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import fragShader from "../shaders/holo-button/fragment.glsl";
import vertShader from "../shaders/holo-button/vertex.glsl";

class SpringPhysics {
  value: number;
  target: number;
  velocity: number;
  tension: number;
  friction: number;

  constructor(value: number, tension = 0.08, friction = 0.75) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.tension = tension;
    this.friction = friction;
  }

  update() {
    const delta = this.target - this.value;
    const force = delta * this.tension;
    this.velocity += force;
    this.velocity *= this.friction;
    this.value += this.velocity;
    return this.value;
  }
}

type Uniforms = {
  resolution: WebGLUniformLocation;
  mouse: WebGLUniformLocation;
  time: WebGLUniformLocation;
  hoverState: WebGLUniformLocation;
  clickState: WebGLUniformLocation;
};

class HoloFluidController {
  private readonly button: HTMLButtonElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly mouseX = new SpringPhysics(0.5, 0.06, 0.8);
  private readonly mouseY = new SpringPhysics(0.5, 0.06, 0.8);
  private readonly hoverState = new SpringPhysics(0.0, 0.05, 0.85);
  private readonly clickState = new SpringPhysics(0.0, 0.15, 0.7);
  private readonly teardown: Array<() => void> = [];
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vertexShader: WebGLShader | null = null;
  private fragmentShader: WebGLShader | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private uniforms: Uniforms | null = null;
  private animationFrameId = 0;
  private time = 0;
  private lastFrameTime = performance.now();

  constructor(button: HTMLButtonElement, canvas: HTMLCanvasElement) {
    this.button = button;
    this.canvas = canvas;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.canvas.style.display = "none";
      return;
    }

    const gl = this.canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
    });

    if (!gl) {
      this.disableFluid("WebGL not supported in this environment.");
      return;
    }

    this.gl = gl;

    if (!this.initWebGL()) {
      return;
    }

    this.bindEvents();
    this.handleResize();
    this.animationFrameId = window.requestAnimationFrame(this.render);
  }

  destroy() {
    if (this.animationFrameId) {
      window.cancelAnimationFrame(this.animationFrameId);
    }

    this.resizeObserver?.disconnect();

    for (const cleanup of this.teardown) {
      cleanup();
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

    if (this.gl && this.positionBuffer) {
      this.gl.deleteBuffer(this.positionBuffer);
    }
  }

  private disableFluid(message: string) {
    console.warn(message);
    this.canvas.style.display = "none";
  }

  private compileShader(type: number, source: string) {
    if (!this.gl) {
      return null;
    }

    const shader = this.gl.createShader(type);

    if (!shader) {
      this.disableFluid("Unable to allocate WebGL shader.");
      return null;
    }

    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const error = this.gl.getShaderInfoLog(shader) ?? "Unknown shader error.";
      this.disableFluid(`Shader compilation failed: ${error}`);
      this.gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  private getUniformLocation(name: string) {
    if (!this.gl || !this.program) {
      throw new Error(`WebGL program is unavailable while reading ${name}.`);
    }

    const location = this.gl.getUniformLocation(this.program, name);

    if (!location) {
      throw new Error(`Uniform ${name} was not found in the shader program.`);
    }

    return location;
  }

  private initWebGL() {
    if (!this.gl) {
      return false;
    }

    const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vertShader);
    const fragmentShader = this.compileShader(
      this.gl.FRAGMENT_SHADER,
      fragShader,
    );

    if (!vertexShader || !fragmentShader) {
      return false;
    }

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    const program = this.gl.createProgram();

    if (!program) {
      this.disableFluid("Unable to allocate WebGL program.");
      return false;
    }

    this.program = program;
    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const error =
        this.gl.getProgramInfoLog(program) ?? "Unknown linking error.";
      this.disableFluid(`Program linking failed: ${error}`);
      return false;
    }

    this.gl.useProgram(program);

    const vertices = new Float32Array([
      -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
    ]);

    const positionBuffer = this.gl.createBuffer();

    if (!positionBuffer) {
      this.disableFluid("Unable to allocate WebGL vertex buffer.");
      return false;
    }

    this.positionBuffer = positionBuffer;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);

    const positionLocation = this.gl.getAttribLocation(program, "a_position");

    if (positionLocation < 0) {
      this.disableFluid("Shader attribute a_position is unavailable.");
      return false;
    }

    this.gl.enableVertexAttribArray(positionLocation);
    this.gl.vertexAttribPointer(
      positionLocation,
      2,
      this.gl.FLOAT,
      false,
      0,
      0,
    );

    this.uniforms = {
      resolution: this.getUniformLocation("u_resolution"),
      mouse: this.getUniformLocation("u_mouse"),
      time: this.getUniformLocation("u_time"),
      hoverState: this.getUniformLocation("u_hover_state"),
      clickState: this.getUniformLocation("u_click_state"),
    };

    return true;
  }

  private bindEvents() {
    const addListener = <
      Target extends Window | HTMLButtonElement,
      EventName extends keyof GlobalEventHandlersEventMap,
    >(
      target: Target,
      type: EventName,
      listener: (event: GlobalEventHandlersEventMap[EventName]) => void,
    ) => {
      const handler = listener as EventListener;
      target.addEventListener(type, handler);
      this.teardown.push(() => target.removeEventListener(type, handler));
    };

    const syncPointer = (clientX: number, clientY: number) => {
      const rect = this.button.getBoundingClientRect();
      const x = (clientX - rect.left) / rect.width;
      const y = 1 - (clientY - rect.top) / rect.height;
      this.mouseX.target = x;
      this.mouseY.target = y;
    };

    addListener(this.button, "pointermove", (event) => {
      syncPointer(event.clientX, event.clientY);
    });

    addListener(this.button, "pointerenter", (event) => {
      this.hoverState.target = 1;
      syncPointer(event.clientX, event.clientY);
      this.mouseX.value = this.mouseX.target;
      this.mouseY.value = this.mouseY.target;
    });

    addListener(this.button, "pointerleave", () => {
      this.hoverState.target = 0;
      this.clickState.target = 0;
    });

    addListener(this.button, "pointerdown", () => {
      this.clickState.target = 1;
    });

    addListener(window, "pointerup", () => {
      this.clickState.target = 0;
    });

    addListener(this.button, "focus", () => {
      this.hoverState.target = 1;
      this.mouseX.value = 0.5;
      this.mouseX.target = 0.5;
      this.mouseY.value = 0.5;
      this.mouseY.target = 0.5;
    });

    addListener(this.button, "blur", () => {
      this.hoverState.target = 0;
      this.clickState.target = 0;
    });

    addListener(this.button, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        this.clickState.target = 1;
      }
    });

    addListener(this.button, "keyup", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        this.clickState.target = 0;
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.button);

    const resizeHandler = () => {
      this.handleResize();
    };

    window.addEventListener("resize", resizeHandler);
    this.teardown.push(() =>
      window.removeEventListener("resize", resizeHandler),
    );
  }

  private handleResize() {
    if (!this.gl || !this.uniforms) {
      return;
    }

    const rect = this.button.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.gl.viewport(0, 0, width, height);
    this.gl.uniform2f(this.uniforms.resolution, width, height);
  }

  private render = (currentTime: number) => {
    if (!this.gl || !this.uniforms) {
      return;
    }

    const deltaTime = Math.min((currentTime - this.lastFrameTime) / 1000, 0.05);
    this.lastFrameTime = currentTime;
    this.time += deltaTime;

    const mouseX = this.mouseX.update();
    const mouseY = this.mouseY.update();
    const hoverState = this.hoverState.update();
    const clickState = this.clickState.update();

    this.gl.uniform1f(this.uniforms.time, this.time);
    this.gl.uniform2f(this.uniforms.mouse, mouseX, mouseY);
    this.gl.uniform1f(this.uniforms.hoverState, hoverState);
    this.gl.uniform1f(this.uniforms.clickState, clickState);

    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);

    this.animationFrameId = window.requestAnimationFrame(this.render);
  };
}

export type HoloButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  canvasClassName?: string;
  contentClassName?: string;
  icon?: ReactNode;
  iconClassName?: string;
  label?: string;
  labelClassName?: string;
};

export function HoloButton({
  canvasClassName,
  className,
  contentClassName,
  icon,
  iconClassName,
  label = "",
  labelClassName,
  type = "button",
  "aria-label": ariaLabel,
  ...props
}: HoloButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const button = buttonRef.current;
    const canvas = canvasRef.current;

    if (!button || !canvas) {
      return;
    }

    const controller = new HoloFluidController(button, canvas);
    return () => controller.destroy();
  }, []);

  return (
    <button
      {...props}
      ref={buttonRef}
      type={type}
      aria-label={ariaLabel ?? (label || undefined)}
      className={cn(
        "group relative isolate inline-flex items-center justify-center overflow-hidden whitespace-nowrap select-none outline-none",
        "transform-[translateZ(0)] will-change-transform",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        className={cn(
          "pointer-events-none absolute inset-0 z-0 h-full w-full",
          canvasClassName,
        )}
        aria-hidden="true"
      />
      <span
        className={cn(
          "pointer-events-none relative z-10 inline-flex items-center",
          contentClassName,
        )}
      >
        {icon && (
          <span className={iconClassName} aria-hidden="true">
            {icon}
          </span>
        )}
        {label && <span className={labelClassName}>{label}</span>}
      </span>
    </button>
  );
}
