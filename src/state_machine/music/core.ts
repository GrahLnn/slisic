import {
  Playlist,
  CollectMission,
  Music,
  ProcessMsg,
} from "@/src/cmd/commands";

import { Actor, ActorRefFromLogic } from "xstate";
import { machine } from "../muinfo";
import { check_folder_machine } from "../foldercheck";
import { update_weblist_machine } from "../updateweblist";
import { Howl, Howler } from "howler";

interface HowlerTap {
  analyser: AnalyserNode;
  start: (onframe: (f: Frame) => void) => void;
  stop: () => void;
}

/** 频段辅助：给定 Hz → bin index 区间 */
function binRange(
  sampleRate: number,
  fftSize: number,
  fromHz: number,
  toHz: number
) {
  const hzPerBin = sampleRate / fftSize;
  const lo = Math.max(0, Math.floor(fromHz / hzPerBin));
  const hi = Math.min(fftSize / 2 - 1, Math.ceil(toHz / hzPerBin));
  return [lo, hi] as const;
}

/** 把 dB 频谱归一化到 0..1（基于 analyser 的 min/max dB）。*/
function normalizeDbArray(
  out: Float32Array,
  db: Float32Array,
  minDb: number,
  maxDb: number
) {
  const span = maxDb - minDb || 1;
  for (let i = 0; i < out.length; i++) {
    // clamp 后线性映射
    const v = Math.max(minDb, Math.min(maxDb, db[i]));
    out[i] = (v - minDb) / span; // 0..1
  }
}

/** 在 [lo,hi] 取均值（0..1 的归一数组） */
function bandMean(norm: Float32Array, lo: number, hi: number) {
  let acc = 0;
  const n = Math.max(1, hi - lo + 1);
  for (let i = lo; i <= hi; i++) acc += norm[i] ?? 0;
  return acc / n;
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}

export function createHowlerTap(fftSize = 2048, smoothing = 0.8): HowlerTap {
  if (!Howler.usingWebAudio)
    throw new Error("当前是 HTML5 Audio 回退，无法取帧。");

  const ctx = Howler.ctx as AudioContext;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = smoothing;
  // 你也可以按口味调范围（默认 -100..-30 左右）
  // analyser.minDecibels = -100;
  // analyser.maxDecibels = -30;

  // 并联监听 masterGain
  (Howler.masterGain as GainNode).connect(analyser);

  const specDb = new Float32Array(analyser.frequencyBinCount);
  const timeU8 = new Uint8Array(analyser.fftSize); // 0..255
  const freqNorm = new Float32Array(analyser.frequencyBinCount);

  // 频段索引（固定一次即可）
  const [bLo, bHi] = binRange(ctx.sampleRate, analyser.fftSize, 20, 250);
  const [mLo, mHi] = binRange(ctx.sampleRate, analyser.fftSize, 250, 2000);
  const [tLo, tHi] = binRange(ctx.sampleRate, analyser.fftSize, 2000, 12000);

  // 峰值/爆发度跟踪
  let volumePeak = 0;
  let bassPeak = 0;
  let lastVolume = 0;
  const peakDecay = 0.04; // 每帧衰减
  const burstDecay = 0.06;
  let intensityBurst = 0;

  let raf: number | null = null;
  const start = (onframe: (f: Frame) => void) => {
    const tick = () => {
      analyser.getFloatFrequencyData(specDb);
      analyser.getByteTimeDomainData(timeU8);

      // 归一化频谱到 0..1
      normalizeDbArray(
        freqNorm,
        specDb,
        analyser.minDecibels,
        analyser.maxDecibels
      );

      // 简单 RMS 音量（时域 0..1）
      let acc = 0;
      for (let i = 0; i < timeU8.length; i++) {
        const v = (timeU8[i] - 128) / 128; // -1..1
        acc += v * v;
      }
      const rms = Math.sqrt(acc / timeU8.length); // 0..~1
      const volume = rms;

      // 频段特征（用归一后的 0..1）
      const bass = bandMean(freqNorm, bLo, bHi);
      const mid = bandMean(freqNorm, mLo, mHi);
      const treble = bandMean(freqNorm, tLo, tHi);

      // 峰值与爆发度
      volumePeak = Math.max(volume, volumePeak - peakDecay);
      bassPeak = Math.max(bass, bassPeak - peakDecay);
      // 爆发度：当前音量 - 上一帧音量（正向脉冲），再做衰减
      const rise = Math.max(0, volume - lastVolume);
      intensityBurst = Math.max(rise, intensityBurst - burstDecay);
      lastVolume = volume;

      onframe({
        frequencyNorm: freqNorm.slice(),
        volume: round2(volume),
        bass,
        mid,
        treble,
        bassPeak,
        volumePeak: round2(volumePeak),
        intensityBurst: round2(intensityBurst),
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  };

  return { analyser, start, stop };
}

export interface Review {
  url: string;
  actor: ActorRefFromLogic<typeof machine>;
}

export interface FolderReview {
  path: string;
  actor: ActorRefFromLogic<typeof check_folder_machine>;
}

export interface UpdateWeblistReview {
  url: string;
  actor: ActorRefFromLogic<typeof update_weblist_machine>;
}

export type Frame = {
  frequencyNorm: Float32Array;
  volume: number;
  bass: number;
  mid: number;
  treble: number;
  bassPeak: number;
  volumePeak: number;
  intensityBurst: number;
};

export function new_frame(): Frame {
  return {
    frequencyNorm: new Float32Array(1024),
    volume: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    bassPeak: 0,
    volumePeak: 0,
    intensityBurst: 0,
  };
}

export interface Context {
  collections: Playlist[];
  saving_record?: string[];
  selected?: Playlist;
  flatList: Array<Music>;
  slot?: CollectMission;
  reviews: Review[];
  folderReviews: FolderReview[];
  updateWeblistReviews: UpdateWeblistReview[];
  ref?: any;
  audio?: Howl;
  nowPlaying?: Music;
  nowJudge?: "Up" | "Down";
  lastPlay?: Music;
  playToken?: number;
  processMsg?: ProcessMsg;
  tap?: HowlerTap;
}

export function new_slot(): CollectMission {
  return {
    name: "",
    folders: [],
    links: [],
    entries: [],
    exclude: [],
  };
}

export function into_slot(playlist: Playlist): CollectMission {
  return {
    name: playlist.name,
    entries: playlist.entries,
    folders: [],
    links: [],
    exclude: playlist.exclude,
  };
}
