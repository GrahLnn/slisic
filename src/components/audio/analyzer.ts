// audio/Analyzer.ts
export type Bands = {
  volume: number;
  bass: number;
  mid: number;
  treble: number;
};

export type Peaks = {
  bassPeak: number;
  volumePeak: number;
  intensityBurst: number;
};

export type Frame = {
  frequencyNorm: Float32Array; // 0..1 归一化（复用同一块内存）
  volume: number;
  bass: number;
  mid: number;
  treble: number;
  bassPeak: number;
  volumePeak: number;
  intensityBurst: number;
};

export class AudioAnalyzer {
  private ctx!: AudioContext;
  private analyser!: AnalyserNode;
  private source: MediaElementAudioSourceNode | null = null;
  private attachedEl: HTMLMediaElement | null = null;

  // 用 ArrayBuffer 背书，避免 TS 报错
  private freqBytes!: Uint8Array /* <ArrayBuffer> */; // 运行时就是 AB
  private freqNorm!: Float32Array;

  private rafId = 0;
  private running = false;

  // EMA 状态
  private volEma = 0;
  private bassEma = 0;
  private volPeak = 0;
  private bassPeak = 0;
  private intensity = 0;

  // 调试
  private debug = false;
  private tickCount = 0;
  private lastLogTs = 0;

  constructor(private fftSize = 2048, private smoothTimeConst = 0.8) {}

  setDebug(on: boolean) {
    this.debug = on;
  }

  private log(...args: any[]) {
    if (this.debug) console.log("[Analyzer]", ...args);
  }
  private warn(...args: any[]) {
    if (this.debug) console.warn("[Analyzer]", ...args);
  }
  private err(...args: any[]) {
    if (this.debug) console.error("[Analyzer]", ...args);
  }

  private ensureInit() {
    if (this.ctx) return;

    this.ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = this.smoothTimeConst;

    // 分配一次 buffer（用 slice() 让类型背书为 ArrayBuffer）
    const u8 = new Uint8Array(this.analyser.frequencyBinCount);
    this.freqBytes = u8.slice(); // 复制一次 → 背后是 ArrayBuffer
    this.freqNorm = new Float32Array(this.analyser.frequencyBinCount);

    this.log("init", {
      fftSize: this.fftSize,
      bins: this.analyser.frequencyBinCount,
    });
  }

  private makeSilentFrame(): Frame {
    // 保持 bin 数一致
    return {
      frequencyNorm: this.freqNorm, // 复用同一块 Float32Array
      volume: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      bassPeak: 0,
      volumePeak: 0,
      intensityBurst: 0,
    };
  }

  reset() {
    // 数组清 0
    this.freqBytes.fill(0);
    this.freqNorm.fill(0);

    // 指标清 0
    this.volEma = 0;
    this.bassEma = 0;
    this.volPeak = 0;
    this.bassPeak = 0;
    this.intensity = 0;

    this.log("reset state to zero");
  }

  /** 连接 audio 元素。对同一元素只 createMediaElementSource 一次；复用即可。 */
  async connect(el: HTMLAudioElement) {
    this.ensureInit();

    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
        this.log("context resumed");
      } catch (e) {
        this.warn("resume failed", e);
      }
    }

    // 如果已绑定同一个元素，复用，不要再次 create
    if (this.source && this.attachedEl === el) {
      try {
        this.source.connect(this.analyser);
        this.source.connect(this.ctx.destination);
        this.log("reconnect existing source");
      } catch (e) {
        // 多次 connect 可能抛幂等相关错误，忽略即可
        this.warn("reconnect warn", e);
      }
      return;
    }

    // 绑定了不同元素：最稳做法是重建 AudioContext（避免“一个 el → 多个 SourceNode”限制）
    if (this.source && this.attachedEl && this.attachedEl !== el) {
      this.warn("different element detected; rebuild context");
      try {
        this.source.disconnect();
      } catch {}
      try {
        await this.ctx.close();
      } catch {}
      // 重建
      this.ctx = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = this.smoothTimeConst;

      const u8 = new Uint8Array(this.analyser.frequencyBinCount);
      this.freqBytes = u8.slice();
      this.freqNorm = new Float32Array(this.analyser.frequencyBinCount);
    }

    // 第一次绑定这个元素
    try {
      this.source = this.ctx.createMediaElementSource(el);
      this.source.connect(this.analyser);
      this.source.connect(this.ctx.destination);
      this.attachedEl = el;
      this.log("createMediaElementSource OK");
    } catch (e) {
      this.err(
        "createMediaElementSource failed (was it already created elsewhere?)",
        e
      );
      throw e;
    }
  }

  /** 软断开：可选。保留 source 引用，避免下次再 create。 */
  disconnect() {
    try {
      this.source?.disconnect(this.analyser);
      this.source?.disconnect(this.ctx.destination);
      this.log("soft disconnect source (kept for reuse)");
    } catch (e) {
      this.warn("disconnect warn", e);
    }
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** 启动采样循环；返回清理函数（等价 stop）。 */
  onFrame(cb: (f: Frame) => void) {
    // 1) 先停旧循环
    this.stop();

    // 2) 再打开
    this.running = true;
    this.tickCount = 0;
    this.lastLogTs = performance.now();

    const tick = () => {
      if (!this.running) return;

      // 如果 context 被系统挂起，提示一下
      if (this.ctx.state === "suspended") {
        this.warn("context is suspended");
      }

      // 采样
      try {
        // 这里的 this.freqBytes 是 ArrayBuffer 背书（通过 slice()），类型安全
        this.analyser.getByteFrequencyData(
          this.freqBytes as Uint8Array<ArrayBuffer>
        );
      } catch (e) {
        this.err("getByteFrequencyData failed", e);
      }

      // 归一化
      for (let i = 0; i < this.freqBytes.length; i++) {
        this.freqNorm[i] = this.freqBytes[i] / 255;
      }

      // 简单分段
      const n = this.freqNorm.length;
      const volume = avg(this.freqNorm, 0, n);
      const bass = avg(this.freqNorm, 0, Math.min(32, n));
      const mid = avg(this.freqNorm, 32, Math.min(256, n));
      const treble = avg(this.freqNorm, 256, Math.min(512, n));

      // EMA
      const alpha = 0.15;
      this.volEma = lerp(this.volEma, volume, alpha);
      this.bassEma = lerp(this.bassEma, bass, alpha);

      const volRise = Math.max(0, volume - this.volEma);
      const bassRise = Math.max(0, bass - this.bassEma);

      // 峰值
      this.volPeak = Math.max(this.volPeak * 0.95, volRise * 3);
      this.bassPeak = Math.max(this.bassPeak * 0.95, bassRise * 3);

      // 爆发度
      this.intensity = Math.max(this.intensity * 0.9, (volRise + bassRise) * 2);

      // 调试：每 ~500ms 打一行，避免刷屏
      this.tickCount++;
      const now = performance.now();
      if (now - this.lastLogTs > 500) {
        const sum =
          this.freqBytes[0] +
          this.freqBytes[1] +
          this.freqBytes[2] +
          this.freqBytes[3];
        this.log(
          `tick=${this.tickCount}, bytes[0..3]=${sum}, vol=${volume.toFixed(
            3
          )}, bass=${bass.toFixed(3)}, peaks=[${this.bassPeak.toFixed(
            3
          )}, ${this.volPeak.toFixed(3)}], ctx=${this.ctx.state}`
        );
        this.lastLogTs = now;
      }

      // 回调
      cb({
        frequencyNorm: this.freqNorm,
        volume,
        bass,
        mid,
        treble,
        bassPeak: this.bassPeak,
        volumePeak: this.volPeak,
        intensityBurst: this.intensity,
      });

      this.rafId = requestAnimationFrame(tick);
    };

    // 3) 开始
    tick();

    // 4) 返回清理
    return () => this.stop();
  }
}

/* ============ helpers ============ */
function avg(a: Float32Array, start: number, end: number) {
  let s = 0,
    n = Math.max(0, end - start);
  for (let i = start; i < end; i++) s += a[i];
  return n ? s / n : 0;
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
