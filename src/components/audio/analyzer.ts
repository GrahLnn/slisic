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
  private puller?: GainNode;
  private td?: Float32Array;
  private tappedFrom?: AudioNode;
  // 用 ArrayBuffer 背书，避免 TS 报错
  private freqBytes!: Uint8Array /* <ArrayBuffer> */;
  private freqNorm!: Float32Array;

  private rafId = 0;
  private running = false;
  private tapped = false;

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

  // —— 新增：必要时可从外部拿到 ctx/analyser 做调试或接线 —— //
  get audioContext() {
    this.ensureInit();
    return this.ctx;
  }
  get analyserNode() {
    this.ensureInit();
    return this.analyser;
  }

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
  attachTo(ctx: AudioContext) {
    const needRebuild = !this.ctx || this.ctx !== ctx;
    this.ctx = ctx;
    if (needRebuild) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = this.smoothTimeConst;

      const u8 = new Uint8Array(this.analyser.frequencyBinCount);
      this.freqBytes = u8.slice();
      this.freqNorm = new Float32Array(this.analyser.frequencyBinCount);
      this.log("[attachTo] ok", {
        bins: this.analyser.frequencyBinCount,
      });
    }
  }
  startSampling(cb: (f: Frame) => void) {
    // 如果已在跑，先停
    this.stopSampling();
    this.running = true;

    const tick = () => {
      if (!this.running) return;

      // 拉数据
      this.analyser.getByteFrequencyData(
        this.freqBytes as Uint8Array<ArrayBuffer>
      );

      // 归一化 + 你已有的统计
      for (let i = 0; i < this.freqBytes.length; i++) {
        this.freqNorm[i] = this.freqBytes[i] / 255;
      }
      const n = this.freqNorm.length;
      const volume = avg(this.freqNorm, 0, n);
      const bass = avg(this.freqNorm, 0, Math.min(32, n));
      const mid = avg(this.freqNorm, 32, Math.min(256, n));
      const treble = avg(this.freqNorm, 256, Math.min(512, n));

      // 你已有的 EMA/峰值逻辑...
      const alpha = 0.15;
      this.volEma = lerp(this.volEma, volume, alpha);
      this.bassEma = lerp(this.bassEma, bass, alpha);
      const volRise = Math.max(0, volume - this.volEma);
      const bassRise = Math.max(0, bass - this.bassEma);
      this.volPeak = Math.max(this.volPeak * 0.95, volRise * 3);
      this.bassPeak = Math.max(this.bassPeak * 0.95, bassRise * 3);
      this.intensity = Math.max(this.intensity * 0.9, (volRise + bassRise) * 2);

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

    tick();
    // 返回停止函数，方便上层管理生命周期
    return () => this.stopSampling();
  }

  stopSampling() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }
  setTapFrom(node: AudioNode) {
    if (!this.ctx || !this.analyser) throw new Error("attachTo(ctx) first");
    if (node.context !== this.ctx)
      throw new Error("tap node && analyzer ctx mismatch");

    try {
      this.tappedFrom?.disconnect(this.analyser);
    } catch {}
    node.connect(this.analyser);
    this.tappedFrom = node;
    this.log("[tap] retapped from", node.constructor.name);
  }

  private ensureInit() {
    if (this.ctx) return;

    this.ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = this.smoothTimeConst;

    const u8 = new Uint8Array(this.analyser.frequencyBinCount);
    this.freqBytes = u8.slice(); // 复制一份确保背后是 ArrayBuffer
    this.freqNorm = new Float32Array(this.analyser.frequencyBinCount);

    this.log("init", {
      fftSize: this.fftSize,
      bins: this.analyser.frequencyBinCount,
    });
  }

  reset() {
    this.freqBytes.fill(0);
    this.freqNorm.fill(0);
    this.volEma = 0;
    this.bassEma = 0;
    this.volPeak = 0;
    this.bassPeak = 0;
    this.intensity = 0;
    this.log("reset state to zero");
  }

  /**
   * 连接 audio 元素（只创建一次 MediaElementSource）。
   * 重要：不再连接到 destination —— Analyzer 只做“观察”，不出声！
   */

  /** 软断开：仅断观察端口；不涉及 destination（因为我们不再连它）。 */
  disconnect() {
    try {
      this.tappedFrom?.disconnect(this.analyser);
    } catch {}
    this.tappedFrom = undefined;
    try {
      this.puller?.disconnect();
    } catch {}
    this.puller = undefined;
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** 启动采样循环；返回清理函数（= stop）。 */
  onFrame(cb: (f: Frame) => void) {
    this.stop();
    this.running = true;
    this.tickCount = 0;
    this.lastLogTs = performance.now();
    let tickNo = 0;

    const tick = () => {
      if (!this.running) return;
      if (this.ctx.state === "suspended") this.warn("ctx suspended");
      // 频域
      this.analyser.getByteFrequencyData(
        this.freqBytes as Uint8Array<ArrayBuffer>
      );
      if (tickNo % 60 === 2) {
        const fsum =
          this.freqBytes[0] +
          this.freqBytes[1] +
          this.freqBytes[2] +
          this.freqBytes[3];
        const vol = (() => {
          let s = 0;
          for (let i = 0; i < this.freqBytes.length; i++)
            s += this.freqBytes[i];
          return s / (255 * this.freqBytes.length);
        })();
        this.log("tick", tickNo, {
          fsum,
          vol,
          ctx: this.ctx.state,
        });
      }
      for (let i = 0; i < this.freqBytes.length; i++)
        this.freqNorm[i] = this.freqBytes[i] / 255;

      // 时域 RMS（辅助判断有没有真实音频）
      let rms = 0;
      if (this.td) {
        this.analyser.getFloatTimeDomainData(
          this.td as Float32Array<ArrayBuffer>
        );
        let s = 0;
        for (let i = 0; i < this.td.length; i++) s += this.td[i] * this.td[i];
        rms = Math.sqrt(s / this.td.length);
      }

      const n = this.freqNorm.length;
      const volume = avg(this.freqNorm, 0, n);
      const bass = avg(this.freqNorm, 0, Math.min(32, n));
      const mid = avg(this.freqNorm, 32, Math.min(256, n));
      const treble = avg(this.freqNorm, 256, Math.min(512, n));

      const alpha = 0.15;
      this.volEma = lerp(this.volEma, volume, alpha);
      this.bassEma = lerp(this.bassEma, bass, alpha);
      const volRise = Math.max(0, volume - this.volEma);
      const bassRise = Math.max(0, bass - this.bassEma);
      this.volPeak = Math.max(this.volPeak * 0.95, volRise * 3);
      this.bassPeak = Math.max(this.bassPeak * 0.95, bassRise * 3);
      this.intensity = Math.max(this.intensity * 0.9, (volRise + bassRise) * 2);

      // 每 ~500ms 打一次关键数据
      this.tickCount++;
      const now = performance.now();
      if (now - this.lastLogTs > 500) {
        const fsum =
          this.freqBytes[0] +
          this.freqBytes[1] +
          this.freqBytes[2] +
          this.freqBytes[3];
        this.log("tick", this.tickCount, {
          fsum,
          rms: +rms.toFixed(4),
          vol: +volume.toFixed(3),
          ctx: this.ctx.state,
        });
        this.lastLogTs = now;
      }

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

    tick();
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
