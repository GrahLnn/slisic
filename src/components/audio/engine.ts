// audio/engine.ts

export class AudioEngine {
  private debug = false;
  ctx: AudioContext;
  master: GainNode;
  fade: GainNode;
  lufs: GainNode;
  limiter: DynamicsCompressorNode;
  src?: MediaElementAudioSourceNode;
  attached?: HTMLMediaElement;
  private srcConnectedTo: "lufs" | "master" | "limiter" | null = null;

  constructor(ctx?: AudioContext) {
    this.ctx =
      ctx ?? new (window.AudioContext || (window as any).webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.fade = this.ctx.createGain();
    this.fade.gain.value = 0; // 开始静音
    this.lufs = this.ctx.createGain();
    this.lufs.gain.value = 1;

    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1; // 软限幅兜底
    this.limiter.knee.value = 1;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    // lufs → fade → limiter → master → destination
    this.lufs.connect(this.fade);
    this.fade.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  private log(...args: any[]) {
    if (this.debug) console.log("[engine]", ...args);
  }
  private warn(...args: any[]) {
    if (this.debug) console.warn("[engine]", ...args);
  }
  private err(...args: any[]) {
    if (this.debug) console.error("[engine]", ...args);
  }

  private nodeFor(where: "lufs" | "master" | "limiter") {
    return where === "lufs"
      ? this.lufs
      : where === "limiter"
      ? this.limiter
      : this.master;
  }

  private connectSrcTo(where: "lufs" | "master" | "limiter" = "lufs") {
    if (!this.src) return;
    const dest = this.nodeFor(where);
    if (this.srcConnectedTo) {
      try {
        this.src.disconnect(this.nodeFor(this.srcConnectedTo));
      } catch {}
    }
    this.src.connect(dest);
    this.srcConnectedTo = where;
    this.log("[connectSrcTo]", { where });
  }

  ensureSource(el: HTMLAudioElement) {
    this.log("[ensureSource] BEFORE", {
      hasSrc: !!this.src,
      sameEl: this.attached === el,
      elSrc: el.src,
      readyState: el.readyState,
      muted: el.muted,
      volume: el.volume,
    });

    if (this.src && this.attached === el) {
      // 已有就复用，不做额外判断
      this.log("[ensureSource] reuse existing MediaElementSource");
      return this.src;
    }
    if (this.src && this.attached && this.attached !== el) {
      try {
        this.src.disconnect();
      } catch {}
      this.src = undefined;
    }
    this.src = this.ctx.createMediaElementSource(el);
    this.src.connect(this.lufs);
    this.attached = el;

    this.log("[ensureSource] AFTER", { connectedTo: "lufs" });
    return this.src;
  }

  tapForAnalyzer(
    an: { setTapFrom(node: AudioNode): void },
    where: "lufs" | "master" | "limiter" = "lufs"
  ) {
    const node =
      where === "lufs"
        ? this.lufs
        : where === "limiter"
        ? this.limiter
        : this.master;
    an.setTapFrom(node);
    this.log("[tapForAnalyzer]", { where });
  }

  private ramp(param: AudioParam, v: number, ms: number) {
    const now = this.ctx.currentTime,
      t = Math.max(0.001, ms / 1000);
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(v, now + t);
  }
  fadeIn(ms = 25) {
    this.ramp(this.fade.gain, 1, ms);
  }
  fadeOut(ms = 25) {
    this.ramp(this.fade.gain, 0, ms);
  }

  /**
   * 用 avg_db 对齐响度：
   * 这里把 avg_db 视为 LUFS（典型为 -8…-24）。目标设为 -14 LUFS（流媒体常用）。
   * 线性增益 = 10^((target - avg_db)/20)，并用 clampDb 限幅防止极端拉升。
   */
  setLoudnessFromAvgDb(
    avg_db: number | null | undefined,
    targetLufs = -14,
    clampDb = 12
  ) {
    if (avg_db == null || Number.isNaN(avg_db)) {
      // 没数据就不动增益
      this.lufs.gain.setValueAtTime(1, this.ctx.currentTime);
      return;
    }
    const delta = Math.max(-clampDb, Math.min(clampDb, targetLufs - avg_db));
    const lin = Math.pow(10, delta / 20);
    this.lufs.gain.setValueAtTime(lin, this.ctx.currentTime);
  }

  async resume() {
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {}
    }
  }

  testTone(durationMs = 1000) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    g.gain.value = 0.2;
    osc.connect(g);
    g.connect(this.lufs); // 或 this.master
    osc.start();
    setTimeout(() => {
      osc.stop();
      osc.disconnect();
      g.disconnect();
    }, durationMs);
  }
  debugSnapshot(tag: string, el?: HTMLAudioElement) {
    // el 可选，方便在 ensureSource/play_audio 两头都调
    const info: any = {
      tag,
      ctx: this.ctx ? this.ctx.state : "NO_CTX",
      hasSrcNode: !!this.src,
      lufs: dbgParam(this.lufs.gain),
      fade: dbgParam(this.fade.gain),
      master: dbgParam(this.master.gain),
    };
    if (el) {
      info.media = {
        src: el.src,
        readyState: el.readyState, // 0..4
        paused: el.paused,
        muted: el.muted,
        volume: el.volume,
        currentTime: el.currentTime,
        duration: el.duration,
        networkState: el.networkState, // 0..3
      };
    }
    // eslint-disable-next-line no-console
    this.log("[snap]", info);
  }
  injectTestTone(ms = 120) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    g.gain.value = 0.05; // 很小，不扰民
    osc.frequency.value = 440;
    osc.connect(g);
    g.connect(this.lufs);
    osc.start();
    setTimeout(() => {
      try {
        osc.stop();
        osc.disconnect();
        g.disconnect();
      } catch {}
    }, ms);
  }
}
// 1) 打点某个 AudioParam
function dbgParam(p: AudioParam) {
  return { value: p.value, automationRate: p.automationRate };
}
