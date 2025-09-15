// MeshGradientTauri_V6.tsx
"use client";
import React, { useEffect, useRef } from "react";

type Props = {
  colors?: string[];
  speed?: number; // 动画速度：每秒 time 增量（内部乘以 60 做手感）
  distortion?: number; // 扭曲强度（编译进片段）
  swirl?: number; // 漩涡强度（编译进片段）
  className?: string;
  style?: React.CSSProperties;
  background?: string; // 透明窗口建议给底色以便对照
  zIndex?: number;
};

function hexToRGBA(s: string): [number, number, number, number] {
  let h = s.trim().toLowerCase();
  if (h.startsWith("0x")) h = "#" + h.slice(2);
  const to = (x: string) => Math.max(0, Math.min(255, parseInt(x, 16))) / 255;
  if (!h.startsWith("#")) return [1, 1, 1, 1];
  if (h.length === 4)
    return [to(h[1] + h[1]), to(h[2] + h[2]), to(h[3] + h[3]), 1];
  if (h.length === 5)
    return [to(h[1] + h[1]), to(h[2] + h[2]), to(h[3] + h[3]), to(h[4] + h[4])];
  if (h.length === 7)
    return [to(h.slice(1, 3)), to(h.slice(3, 5)), to(h.slice(5, 7)), 1];
  if (h.length === 9)
    return [
      to(h.slice(1, 3)),
      to(h.slice(3, 5)),
      to(h.slice(5, 7)),
      to(h.slice(7, 9)),
    ];
  return [1, 1, 1, 1];
}

export default function MeshGradientTauri({
  colors = ["#bcecf6", "#00aaff", "#00f7ff", "#ffd447", "#33cc99", "#3399cc"],
  speed = 0.12,
  distortion = 0.8,
  swirl = 0.35,
  className,
  style,
  background,
  zIndex = 0,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // StrictMode 防抖：令牌 + 延迟销毁
  const tokenRef = useRef<symbol | null>(null);
  const teardownTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;

    // 本次 init 的令牌
    const myToken = Symbol("mesh-gl-session");
    tokenRef.current = myToken;

    // 取消上一次挂起的销毁
    if (teardownTimerRef.current) {
      clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    }

    // WebGL 资源
    let gl: WebGL2RenderingContext | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let vboPos: WebGLBuffer | null = null;
    let vboTime: WebGLBuffer | null = null;
    let prog: WebGLProgram | null = null;
    let tex: WebGLTexture | null = null;

    let raf = 0;
    let alive = true;
    let timeVal = 0;

    // —— Shader 源码（无任何 uniforms；时间=顶点属性；颜色=纹理）——
    const VERT = `#version 300 es
      precision mediump float;

      layout(location = 0) in vec2 a_pos;   // [-1,1] 覆盖全屏
      layout(location = 1) in vec2 a_misc;  // x=time, y=aspect(=width/height)

      out vec2 v_uv;
      out float v_time;
      out float v_aspect;

      void main() {
        v_uv = a_pos * 0.5 + 0.5;   // 屏幕 uv
        v_time = a_misc.x;
        v_aspect = max(a_misc.y, 1e-6); // 防 0
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const FRAG = `#version 300 es
precision mediump float;

in vec2 v_uv;
in float v_time;
in float v_aspect;

out vec4 fragColor;

uniform sampler2D u_colorsTex; // 10×1 颜色表（RGBA，A=0 表示未使用）

const int   MAXN          = 10;
const float U_DISTORTION  = 0.8;  // 如需动态改，可在 JS 侧写入源码再编译
const float U_SWIRL       = 0.35; // 同上

mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

// cover：始终保持方形比例，按较短边放大并裁剪
vec2 toSquareUV(vec2 uv, float ar) {
  vec2 c = uv - 0.5;
  if (ar > 1.0) {
    // 画布更宽：放大 x（裁左右），轨迹不被压扁
    c.x *= ar;
  } else {
    // 画布更高：放大 y（裁上下）
    c.y *= (1.0 / max(ar, 1e-6));
  }
  return c + 0.5;
}


vec4 getColorFromTex(int i){
  float u = (float(i) + 0.5) / 10.0;
  return texture(u_colorsTex, vec2(u, 0.5));
}

// 与原库保持一致的“彩点轨迹”频率
vec2 getPosition(int i, float t) {
  float a = float(i) * .37;
  float b = .6 + mod(float(i), 3.) * .3;
  float c = .8 + mod(float(i + 1), 4.) * 0.25;
  float x = sin(t * b + a);
  float y = cos(t * c + a * 1.5);
  return .5 + .5 * vec2(x, y);
}

// 轻度抖动，减弱条带
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  // 先把 uv 等比矫正到方形域，避免非正方形画布导致的“椭圆拉伸”
  vec2 shape_uv = toSquareUV(v_uv, v_aspect);

  // 时间与原库一致：0.5 倍缩放，并有 firstFrameOffset
  const float firstFrameOffset = 41.5;
  float t = .5 * (v_time + firstFrameOffset);

  // 半径与中心（与原库一致）
  float radius = smoothstep(0., 1., length(shape_uv - .5));
  float center = 1. - radius;

  // 扭曲（保持原参数/结构）
  for (float i = 1.; i <= 2.; i++) {
    shape_uv.x += U_DISTORTION * center / i
      * sin(t + i * .4 * smoothstep(.0, 1., shape_uv.y))
      * cos(.2 * t + i * 2.4 * smoothstep(.0, 1., shape_uv.y));
    shape_uv.y += U_DISTORTION * center / i
      * cos(t + i * 2. * smoothstep(.0, 1., shape_uv.x));
  }

  // 漩涡（在方形域中旋转）
  vec2 uvR = shape_uv - .5;
  float angle = 3. * U_SWIRL * radius;
  uvR = rot(-angle) * uvR;
  uvR += .5;

  // 颜色混合
  vec3 color = vec3(0.);
  float opacity = 0.;
  float total = 0.;

  for (int i = 0; i < MAXN; i++) {
    vec4 ci = getColorFromTex(i);
    if (ci.a <= 0.0001) continue;

    vec2 pos = getPosition(i, t);
    vec3 cf = ci.rgb * ci.a;
    float of = ci.a;

    float dist = length(uvR - pos);
    dist = pow(dist, 3.5);
    float w = 1. / (dist + 1e-3);

    color   += cf * w;
    opacity += of * w;
    total   += w;
  }

  color   /= max(total, 1e-5);
  opacity /= max(total, 1e-5);

  // 轻微抖动减少 banding（与库里的思路一致）
  float d = (hash12(gl_FragCoord.xy) - .5) / 255.0;
  color += d;

  fragColor = vec4(color, opacity);
}

    `;

    // —— 编译/链接 —— //
    const compile = (src: string, type: number) => {
      const sh = gl!.createShader(type);
      if (!sh) throw new Error("createShader -> null");
      gl!.shaderSource(sh, src);
      gl!.compileShader(sh);
      if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
        const info = gl!.getShaderInfoLog(sh);
        gl!.deleteShader(sh);
        throw new Error("Shader compile failed: " + info);
      }
      return sh;
    };

    const link = (vs: WebGLShader, fs: WebGLShader) => {
      const p = gl!.createProgram();
      if (!p) throw new Error("createProgram -> null");
      gl!.attachShader(p, vs);
      gl!.attachShader(p, fs);
      gl!.bindAttribLocation(p, 0, "a_pos");
      gl!.bindAttribLocation(p, 1, "a_time");
      gl!.linkProgram(p);
      if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) {
        const info = gl!.getProgramInfoLog(p);
        gl!.deleteProgram(p);
        throw new Error("Program link failed: " + info);
      }
      return p;
    };

    // —— 尺寸 & 视口 —— //
    const fit = () => {
      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      const r = wrap.getBoundingClientRect();
      const w = Math.max(2, Math.round(r.width * dpr));
      const h = Math.max(2, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      gl?.viewport(0, 0, w, h);
    };

    // —— 销毁（分软/硬两级） —— //
    const softDestroy = () => {
      alive = false;
      cancelAnimationFrame(raf);
      try {
        if (gl) {
          gl.useProgram(null);
          (gl as any).bindVertexArray?.(null);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }
      } catch {}
    };

    const hardDestroy = () => {
      try {
        if (gl) {
          if (vboPos) gl.deleteBuffer(vboPos);
          if (vboTime) gl.deleteBuffer(vboTime);
          if (vao) (gl as any).deleteVertexArray?.(vao);
          if (tex) gl.deleteTexture(tex);
          if (prog) gl.deleteProgram(prog);
          // 真要极限稳，可以不调用 loseContext（WK 对它较敏感）
          // const ext = (gl as any).getExtension?.("WEBGL_lose_context");
          // ext?.loseContext?.();
        }
      } catch {}
      gl = null;
      vao = null;
      vboPos = null;
      vboTime = null;
      prog = null;
      tex = null;
    };

    // —— 启动渲染 —— //
    const start = () => {
      fit();
      gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        powerPreference: "default",
        failIfMajorPerformanceCaveat: false,
      }) as WebGL2RenderingContext | null;

      if (!gl) {
        console.error("[MeshGL] WebGL2 unavailable");
        return;
      }

      // VAO + 顶点坐标
      vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);

      vboPos = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      // 顶点时间（每帧更新四个相同值）
      vboTime = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vboTime);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(4 * 2), gl.DYNAMIC_DRAW); // 4 个顶点 × 2 分量
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

      // 颜色纹理（10×1）
      tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const MAX = 10;
      const picked = colors.slice(0, MAX);
      const data = new Uint8Array(MAX * 4).fill(0);
      for (let i = 0; i < picked.length; i++) {
        const [r, g, b, a] = hexToRGBA(picked[i]);
        data[i * 4 + 0] = Math.round(r * 255);
        data[i * 4 + 1] = Math.round(g * 255);
        data[i * 4 + 2] = Math.round(b * 255);
        data[i * 4 + 3] = Math.round(a * 255);
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        MAX,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data
      );
      // 不设置 sampler 的 location，默认 0 → TEXTURE0

      // Program
      try {
        const vs = compile(VERT, gl.VERTEX_SHADER);
        const fs = compile(FRAG, gl.FRAGMENT_SHADER);
        prog = link(vs, fs);
      } catch (e) {
        console.error("[MeshGL] program build failed:", e);
        hardDestroy();
        return;
      }
      gl.useProgram(prog);

      fit();
      let t0 = performance.now();

      const loop = () => {
        if (!alive || !gl) return;

        const now = performance.now();
        const dt = (now - t0) / 1000;
        t0 = now;
        timeVal += dt * speed;

        // 更新 a_time
        gl.bindBuffer(gl.ARRAY_BUFFER, vboTime!);
        const aspect = canvas.width / canvas.height;
        const tv = new Float32Array([
          timeVal,
          aspect,
          timeVal,
          aspect,
          timeVal,
          aspect,
          timeVal,
          aspect,
        ]);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, tv);

        gl.bufferSubData(gl.ARRAY_BUFFER, 0, tv);

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        raf = requestAnimationFrame(loop);
      };

      raf = requestAnimationFrame(loop);
    };

    const onResize = () => fit();
    window.addEventListener("resize", onResize);

    // 避免 0×0：下一帧启动
    requestAnimationFrame(start);

    // —— Strict-safe cleanup：延迟销毁 + 令牌校验 —— //
    return () => {
      window.removeEventListener("resize", onResize);
      softDestroy();
      teardownTimerRef.current = window.setTimeout(() => {
        if (tokenRef.current === myToken) {
          hardDestroy();
          teardownTimerRef.current = null;
        }
      }, 60); // 跨过 StrictMode 的第二次 effect
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors.join(","), speed, distortion, swirl]);

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100dvh",
        zIndex,
        background: background ?? undefined,
        pointerEvents: "none",
        ...style,
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
