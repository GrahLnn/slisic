import { useMemo } from "react";
import { hook } from "@/src/flow/music";
import { useIsDark } from "@/src/flow/normal";
import MeshGradientTauri from "../meshgrad";

export default function AudioVisualizerCanvas() {
  const isDark = useIsDark();
  const isPlaying = hook.useIsPlaying();
  const judge = hook.useJudge();

  // Keep React static; animation is driven by WebGL RAF inside MeshGradientTauri.
  const colors = useMemo(
    () =>
      isDark
        ? ["#d4d0c8", "#4b8ca5", "#330953", "#180117"]
        : ["#bcecf6", "#00aaff", "#00f7ff", "#ffd447", "#33cc99", "#3399cc"],
    [isDark],
  );

  const speed = useMemo(() => {
    if (!isPlaying) return 0.32;
    if (judge === "Up") return 1.85;
    if (judge === "Down") return 1.45;
    return 1.25;
  }, [isPlaying, judge]);

  return (
    <MeshGradientTauri
      colors={colors}
      speed={speed}
      swirl={0.8}
      distortion={0.8}
      className="fixed left-0 top-0 h-full w-full"
    />
  );
}
