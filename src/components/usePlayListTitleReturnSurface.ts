import { useCallback, useState } from "react";
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

  const handleLayoutAnimationComplete = useCallback(
    (layoutId?: string) => {
      if (!layoutId) {
        return;
      }

      setConsumedEvidence((current) => {
        const next = resolvePlayListTitleReturnSurfaceAfterLayoutComplete({
          current,
          targetLayoutId,
          layoutId,
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
