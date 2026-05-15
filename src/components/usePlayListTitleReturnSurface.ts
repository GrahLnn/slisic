import { useCallback, useState } from "react";
import { recordRenderPerformanceTrace } from "@/src/debug/renderPerformanceTrace";
import {
  INACTIVE_TITLE_RETURN_SURFACE,
  resolvePlayListTitleReturnSurfaceState,
  resolvePlayListTitleReturnSurfaceAfterLayoutComplete,
  resolvePlayListTitleReturnSurfaceSnapshot,
  type PlayListTitleReturnSurfaceState,
} from "./playListTitleReturnSurface.model";

export function usePlayListTitleReturnSurface(targetLayoutId: string | null) {
  const [consumedEvidence, setConsumedEvidence] = useState<PlayListTitleReturnSurfaceState>(
    INACTIVE_TITLE_RETURN_SURFACE,
  );
  const resolvedTitleReturnSurface = resolvePlayListTitleReturnSurfaceState({
    targetLayoutId,
    consumedLayoutId: consumedEvidence.consumedLayoutId,
  });

  recordRenderPerformanceTrace("playlist-title-return-surface-render", {
    targetLayoutId,
    consumedEvidence,
    resolvedTitleReturnSurface,
    snapshot: resolvePlayListTitleReturnSurfaceSnapshot({
      targetLayoutId,
      state: resolvedTitleReturnSurface,
    }),
  });

  const handleLayoutAnimationComplete = useCallback(
    (layoutId?: string) => {
      if (!layoutId) {
        recordRenderPerformanceTrace("playlist-title-return-surface-layout-complete", {
          action: "ignored",
          reason: "missing-layout-id",
          targetLayoutId,
          layoutId: null,
        });
        return;
      }

      setConsumedEvidence((current) => {
        const next = resolvePlayListTitleReturnSurfaceAfterLayoutComplete({
          current,
          targetLayoutId,
          layoutId,
        });

        recordRenderPerformanceTrace("playlist-title-return-surface-layout-complete", {
          action: current === next ? "ignored" : "consumed",
          reason:
            targetLayoutId === null
              ? "missing-target"
              : targetLayoutId !== layoutId
                ? "layout-mismatch"
                : "target-complete",
          targetLayoutId,
          layoutId,
          current,
          next,
        });

        return next;
      });
    },
    [targetLayoutId],
  );

  return {
    titleReturnSurface: resolvedTitleReturnSurface,
    titleReturnSurfaceSnapshot: resolvePlayListTitleReturnSurfaceSnapshot({
      targetLayoutId,
      state: resolvedTitleReturnSurface,
    }),
    handleLayoutAnimationComplete,
  };
}
