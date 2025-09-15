import { MeshGradient } from "@paper-design/shaders-react";
import { Frame } from "./analyzer";
import { useIsDark } from "@/src/state_machine/normal";
import { station } from "@/src/subpub/buses";

export function AudioVisualizerCanvas() {
  const audioData = station.audioFrame.useSee();
  const { speed } = computeParams(audioData);
  const isDark = useIsDark();
  return (
    <MeshGradient
      colors={
        isDark
          ? ["#d4d0c8", "#4b8ca5", "#330953", "#180117"]
          : ["#bcecf6","#00aaff","#00f7ff","#ffd447","#33cc99","#3399cc"]
      }
      speed={speed}
      swirl={0.8}
      distortion={0.8}
      className="w-full h-full"
    />
  );
}

// 把“混沌/波形调制”独立为纯函数
function computeParams(a: Frame) {
  const { volume, bass, mid, treble, bassPeak, volumePeak, intensityBurst } = a;

  let speed = 0.1,
    inten = 1.0;
  if (
    !volume &&
    !bass &&
    !mid &&
    !treble &&
    !bassPeak &&
    !volumePeak &&
    !intensityBurst
  ) {
    return { speed: 0.3, intensity: 1 };
  }
  const sp = bass * 2 + mid * 3 + treble * 3.5;
  const ip = bass * 3 + mid * 4 + treble * 4.5;

  const t = performance.now() * 0.001;
  const totalChaos = (() => {
    const w1 = Math.sin(t * 0.23 + Math.PI * 0.17) * 0.6;
    const w2 = Math.cos(t * 0.41 + Math.PI * 0.73) * 0.4;
    const w3 = Math.sin(t * 0.67 + Math.PI * 1.31) * 0.35;
    const w4 = Math.cos(t * 0.89 + Math.PI * 0.91) * 0.25;
    const w5 = Math.sin(t * 1.13 + Math.PI * 1.67) * 0.2;

    const m1 = Math.sin(t * 0.31 + w1 * 2) * 0.3;
    const m2 = Math.cos(t * 0.53 + w2 * 1.5) * 0.25;
    const m3 = Math.sin(t * 0.79 + w3 * 3) * 0.2;

    const f1 = Math.sin(t * 0.19 + Math.sin(t * 0.37) * 4) * 0.4;
    const f2 = Math.cos(t * 0.43 + Math.cos(t * 0.61) * 3) * 0.3;
    const f3 = Math.sin(t * 0.71 + Math.sin(t * 0.97) * 2) * 0.25;

    const nx1 =
      Math.sin(t * 0.47 + Math.PI * 0.29) * Math.cos(t * 0.83 + Math.PI * 0.71);
    const ny1 =
      Math.cos(t * 0.59 + Math.PI * 0.43) * Math.sin(t * 0.37 + Math.PI * 0.89);
    const nx2 = Math.sin(t * 0.73 + nx1 * 2) * Math.cos(t * 1.17 + ny1 * 1.5);
    const ny2 = Math.cos(t * 0.91 + ny1 * 2.5) * Math.sin(t * 0.61 + nx1 * 1.8);
    const noise = (nx1 + ny1 + nx2 + ny2) * 0.2;

    const ba =
      bass *
      Math.sin(t * 2.17 + bass * 15 + mid * 8) *
      Math.cos(t * 1.73 + treble * 12) *
      0.4;
    const ma =
      mid *
      Math.cos(t * 1.89 + mid * 11 + bass * 6) *
      Math.sin(t * 2.31 + volume * 10) *
      0.35;
    const ta =
      treble *
      Math.sin(t * 3.41 + treble * 18 + mid * 9) *
      Math.cos(t * 2.67 + bass * 7) *
      0.3;
    const va =
      volume *
      Math.cos(t * 1.23 + volume * 13 + treble * 11) *
      Math.sin(t * 3.07 + mid * 14) *
      0.25;

    const pt1 =
      bassPeak *
      Math.sin(t * 4.13 + bassPeak * 20) *
      Math.cos(t * 3.71 + intensityBurst * 15) *
      0.5;
    const pt2 =
      volumePeak *
      Math.cos(t * 3.89 + volumePeak * 17) *
      Math.sin(t * 4.23 + bassPeak * 12) *
      0.4;
    const bt =
      intensityBurst *
      Math.sin(t * 5.07 + intensityBurst * 25) *
      Math.cos(t * 4.61 + volumePeak * 18) *
      0.45;

    return (
      (w1 + w2 + w3 + w4 + w5) * 0.3 +
      (m1 + m2 + m3) * 0.25 +
      (f1 + f2 + f3) * 0.35 +
      noise * 0.4 +
      (ba + ma + ta + va) * 0.6 +
      (pt1 + pt2 + bt) * 0.8
    );
  })();

  const peakS = bassPeak * 3 + intensityBurst * 3;
  const peakI = intensityBurst + bassPeak;

  const finalSpeed = Math.max(0.01, speed + sp + peakS + totalChaos * 0.7);
  const finalInten = Math.max(
    0.1,
    inten + ip + peakI + Math.abs(totalChaos) * 0.3
  );
  return { speed: finalSpeed, intensity: finalInten };
}
