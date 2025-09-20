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

  const speedRef = useRef(speed);
  speedRef.current = speed;

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

// ========== 复杂漩涡（哈密顿流场推进）的可调参数（JS 侧用 uniform1f 设） ==========
uniform float SWIRL_GAIN;     // 总体流场强度（建议 0.8~1.2）
uniform float SWIRL_DT;       // 单步 dt，步长（0.015~0.035）
uniform float SWIRL_STEPS;    // 推进步数（1~3，向下取整）
uniform float CORE_SIGMA;     // 涡核半径（0.2~0.6）
uniform float CORE_STRENGTH;  // 涡核强度（0.5~2.0）
uniform float CORE_COUNT;     // 涡核个数（1~6，向下取整）
uniform float CORE_SPIN;      // 叠加一点基础角速度（0.0~1.2）

// ========== 与原库一致的基本常量（若要热调可改成 uniform） ==========
const int   MAXN          = 10;
const float U_DISTORTION  = 0.8;   // 扭曲强度（域扭曲1）
const float U_SWIRL       = 0.35;  // 基础角速度系数（供 CORE_SPIN 使用）

// ========== 柔和混色内核（“长程”一些，防硬边&掉黑） ==========
const float KERNEL_TYPE = 0.6;   // 0=纯幂律, 1=纯高斯；这里 60% 高斯 + 40% 幂律
const float KERNEL_P    = 3.3;   // 幂律指数（备选）
const float KERNEL_BETA = 14.0;  // 高斯β：越小衰减越慢→更柔
const float KERNEL_R0   = 0.03;  // 最小半径钳制：避免核在中心过尖

// ====== 工具 ======
mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

// cover：方形域等比覆盖（裁切短边，避免非正方形拉伸）
vec2 toSquareUV(vec2 uv, float ar) {
  vec2 c = uv - 0.5;
  if (ar > 1.0) c.x *= ar;
  else          c.y *= (1.0 / max(ar, 1e-6));
  return c + 0.5;
}

// 颜色表采样（固定 10 格）
vec4 getColorFromTex(int i){
  float u = (float(i) + 0.5) / 10.0;
  return texture(u_colorsTex, vec2(u, 0.5));
}

// 彩点轨迹（与你原库一致的频率/相位）
vec2 getPosition(int i, float t) {
  float a = float(i) * 0.37;
  float b = 0.6 + mod(float(i), 3.0) * 0.3;
  float c = 0.8 + mod(float(i + 1), 4.0) * 0.25;
  float x = sin(t * b + a);
  float y = cos(t * c + a * 1.5);
  return 0.5 + 0.5 * vec2(x, y);
}

// 轻度抖动降带
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 轻量 Hopf 振子：给每个涡核不同相位/频率（核中心随时间游走）
vec2 hopfCenter(float k, float t) {
  float wx = 0.6 + 0.17*k;
  float wy = 0.9 + 0.13*k;
  float px = 1.2 + 0.31*k;
  float py = 0.7 + 0.19*k;
  return 0.5 + 0.32 * vec2(sin(wx*t + px), cos(wy*t + py));
}

// 速度场：v = ∇⊥ψ + 残留角速度；把 center 作为参数传入
vec2 swirlVelocity(vec2 pp, float t, float centerVal) {
  int   N    = int(clamp(floor(CORE_COUNT + 0.001), 1.0, 6.0));
  float sig2 = max(CORE_SIGMA, 0.05); sig2 *= sig2;

  // ∇ψ 累积（高斯核的梯度）
  vec2 grad = vec2(0.0);
  for (int i = 0; i < 6; ++i) {
    if (i >= N) break;
    vec2 ci = hopfCenter(float(i), t);
    vec2 d  = pp - ci;
    float r2 = dot(d, d);
    float e  = exp(-r2 / sig2);
    grad += (-2.0 / sig2) * d * e * CORE_STRENGTH;
  }

  // ∇⊥ψ（梯度旋转 90°）
  vec2 v = vec2(grad.y, -grad.x);

  // 残留角速度：避免全局停滞（保留一点原本的“随半径增加”）
  float R   = length(pp - 0.5);
  float ang = 3.0 * U_SWIRL * R;
  v += CORE_SPIN * ang * vec2(-(pp.y - 0.5), (pp.x - 0.5));

  // 中心衰减 + 总体增益
  return v * (SWIRL_GAIN * centerVal);
}

// 简单 hash：输入 (i, t) → [0,1]
float randCoeff(float i, float t) {
  return fract(sin(i*37.0 + t*0.73) * 43758.5453);
}

void main() {
  // 方形域坐标 + 时间（与原库一致：0.5 倍缩放 + firstFrameOffset）
  vec2 shape_uv = toSquareUV(v_uv, v_aspect);
  const float firstFrameOffset = 41.5;
  float t = 0.5 * (v_time + firstFrameOffset);

  // 半径与中心（用于边缘衰减）
  float radius = smoothstep(0.0, 1.0, length(shape_uv - 0.5));
  float center = 1.0 - radius;

  // ========== 域扭曲 1：原始扭曲（保持你原来的观感） ==========
  float GAIN = 0.45 * U_DISTORTION;   // 总体强度，原来≈1.0，先降
  float lfo  = 0.65 + 0.35*sin(0.11*t);     // 低频摆动（拍频）
  float tw   = t + 0.23*sin(0.07*t) * cos(0.033*t); // 时间扭曲（缓慢相位弯折）

  for (float i = 1.0; i <= 2.0; i++) {
    // 位相仍然随 uv 平滑变换，但频率慢慢“呼吸”
    float sy = smoothstep(0.0, 1.0, shape_uv.y);
    float sx = smoothstep(0.0, 1.0, shape_uv.x);

    float k = (GAIN * center / i) * lfo;

    float px = sin(tw + i * (0.38 + 0.05*lfo) * sy);
    float qx = cos(0.2*tw + i * (2.2 + 0.25*lfo) * sy);

    float py = cos(tw + i * (1.9 + 0.15*lfo) * sx);

    shape_uv.x += k * px * qx;
    shape_uv.y += k * py;
  }

  // ========== 域扭曲 2：复杂漩涡（哈密顿流场推进，RK2） ==========
  vec2 p = shape_uv;
  float steps = clamp(floor(SWIRL_STEPS + 0.001), 0.0, 4.0);
  float dt    = SWIRL_DT;

  for (int s = 0; s < 4; ++s) {
    if (float(s) >= steps) break;
    vec2 k1 = swirlVelocity(p, t, center);
    vec2 k2 = swirlVelocity(p + 0.5 * dt * k1, t + 0.5 * dt, center);
    p += dt * k2;
  }

  // 关键改动①：推进后坐标软夹回画布，避免 UV 出界→大片变黑
  vec2 uvR = clamp(p, 0.0, 1.0);

  // ========== 颜色混合 ==========
  vec3  color   = vec3(0.0);
  float opacity = 0.0;
  float total   = 0.0;

  // 关键改动②：先算“调色板平均色”，作为背景权重使用，杜绝掉黑
  vec3 avgColor = vec3(0.0);
  float aSum = 0.0;
  for (int i = 0; i < MAXN; ++i) {
    vec4 ci0 = getColorFromTex(i);
    if (ci0.a <= 0.0001) continue;
    avgColor += ci0.rgb * ci0.a;
    aSum += ci0.a;
  }
  avgColor /= max(aSum, 1e-6);

  // 正式累加各彩点
  for (int i = 0; i < MAXN; i++) {
    vec4 ci = getColorFromTex(i);
    if (ci.a <= 0.0001) continue;

    vec2 pos = getPosition(i, t);
    vec3 cf  = ci.rgb * ci.a;
    float of = ci.a;

    vec2  dvec = uvR - pos;
    float dist = length(dvec);

    // 关键改动③：柔化核（高斯+幂律混合，带最小半径）
    float d_clamped = max(dist, KERNEL_R0);
    float w_pow   = 1.0 / (pow(d_clamped, max(KERNEL_P, 0.0001)) + 1e-3);
    float w_gauss = exp(-KERNEL_BETA * (dist*dist));
    float w       = mix(w_pow, w_gauss, clamp(KERNEL_TYPE, 0.0, 1.0));

    color   += cf * w;
    opacity += of * w;
    total   += w;
  }

  // 背景权重（建议 0.12~0.20）
  float w_bg = 0.18;
  color += avgColor * w_bg;
  total += w_bg;

  // 归一化
  color   /= max(total, 1e-5);
  opacity /= max(total, 1e-5);

  // 抖动，减少 banding
  color += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;

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
      gl!.bindAttribLocation(p, 1, "a_misc");
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
      const U = (n: string) => gl!.getUniformLocation(prog!, n);
      gl.uniform1f(U("SWIRL_GAIN"), 0.9);
      gl.uniform1f(U("SWIRL_DT"), 0.025); // 可以从 0.015~0.035 试
      gl.uniform1f(U("SWIRL_STEPS"), 2.0); // 1~2 足够；3 开始更费
      gl.uniform1f(U("CORE_SIGMA"), 0.35);
      gl.uniform1f(U("CORE_STRENGTH"), 1.0);
      gl.uniform1f(U("CORE_COUNT"), 3.0);
      gl.uniform1f(U("CORE_SPIN"), 0.7);

      fit();
      let t0 = performance.now();

      const loop = () => {
        if (!alive || !gl) return;

        const now = performance.now();
        const dt = (now - t0) / 1000;
        t0 = now;
        timeVal += dt * (speedRef.current ?? 0);

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
  }, [colors.join(","), distortion, swirl]); // 甚至只依赖 colors.join(",")

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
