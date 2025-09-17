import { MeshGradient } from "@paper-design/shaders-react";
import { Frame } from "@/src/state_machine/music/core";
import { useIsDark } from "@/src/state_machine/normal";
import { station } from "@/src/subpub/buses";
import MeshGradientTauri from "../meshgrad";

export default function AudioVisualizerCanvas() {
  const audioData = station.audioFrame.useSee();
  const speed = computeParams(audioData);
  const isDark = useIsDark();
  return (
    <MeshGradientTauri
      colors={
        isDark
          ? ["#d4d0c8", "#4b8ca5", "#330953", "#180117"]
          : ["#bcecf6", "#00aaff", "#00f7ff", "#ffd447", "#33cc99", "#3399cc"]
      }
      speed={speed}
      swirl={0.8}
      distortion={0.8}
      className="fixed top-0 left-0 w-full h-full"
    />
  );
}

function computeParams(a: Frame) {
  const { volume, bass, mid, treble, bassPeak, volumePeak, intensityBurst } = a;

  // 全零/无信号：固定速度
  if (!bass && !mid && !treble && !bassPeak && !intensityBurst) {
    return 0.3;
  }

  // —— 常量：可按手感微调 —— //
  const MIN_SPEED = 0.25;
  const MAX_SPEED = 10;

  const W_VOL = 0.55; // 音量权重
  const W_TILT = 0.3; // 高频倾斜权重（treble 相对 bass）
  const W_PEAK = 0.25; // 峰值权重（volumePeak/bassPeak 混合）
  const W_MID = 0.05; // 中频轻权

  const BURST_GAIN = 3; // 脉冲瞬时增益
  const BURST_CLAMP = 10; // 脉冲上限

  // —— 归一化/合成 —— //
  const clamp01 = (x: number) => (x < 0 ? 0 : x);

  //   const v = clamp01(volume);
  const b = clamp01(bass);
  const m = clamp01(mid);
  const t = clamp01(treble);
  //   const vp = clamp01(volumePeak);
  const bp = clamp01(bassPeak);

  // 频谱倾斜：高频多 → 更快，低频多 → 更慢
  // treble - bass ∈ [-1,1]，线性映射到 [0,1]
  const tilt = (t - b) * 0.5 + 0.5;

  // 峰值：综合整体峰值与低频踢点
  const peaks = clamp01(0.4 * bp);

  // 基础原始速度（0..1）
  let speedRaw = W_TILT * tilt + W_PEAK * peaks + W_MID * m;

  // 脉冲瞬时增益
  const burst = Math.min(BURST_CLAMP, intensityBurst * BURST_GAIN);
  speedRaw = clamp01(speedRaw + burst);

  // 映射到目标区间
  const speed = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * speedRaw;
  //   console.log(speedRaw, speed);
  return speed;
}
