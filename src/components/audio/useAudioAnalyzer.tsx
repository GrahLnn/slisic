import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { AudioAnalyzer, Frame } from "./analyzer";

export function useAudioAnalyzer() {
  const analyzer = useMemo(() => new AudioAnalyzer(2048, 0.8), []);
  const stopRef = useRef<(() => void) | null>(null);

  const [frame, setFrame] = useState<Frame>({
    frequencyNorm: new Float32Array(1024),
    volume: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    bassPeak: 0,
    volumePeak: 0,
    intensityBurst: 0,
  });

  const initAudio = useCallback(
    async (audioEl: HTMLAudioElement) => {
      await analyzer.connect(audioEl);
      stopRef.current?.();
      stopRef.current = analyzer.onFrame((f) => {
        // 这里不拷贝频谱：保留同一块 Float32Array（render 时只读）
        setFrame(f);
      });
    },
    [analyzer]
  );

  useEffect(() => {
    return () => {
      stopRef.current?.();
      analyzer.disconnect();
    };
  }, [analyzer]);

  return { audioData: frame, initAudio };
}
