import { useCallback, useRef, useState } from "react";

/**
 * Page exits often need a stable render snapshot so shared-layout motion can
 * finish against one coherent frame instead of chasing live state updates from
 * the next transition step.
 */
export function usePageRenderFreeze<T>(
  liveValue: T,
  options?: {
    isPresent?: boolean;
    freezeOnExit?: boolean;
  },
) {
  const lastLiveValueRef = useRef(liveValue);
  if (options?.isPresent !== false) {
    lastLiveValueRef.current = liveValue;
  }

  const [frozenValue, setFrozenValue] = useState<T | null>(null);

  const freeze = useCallback((snapshot?: T) => {
    setFrozenValue(snapshot ?? lastLiveValueRef.current);
  }, []);

  const shouldUseExitSnapshot = options?.freezeOnExit === true && options?.isPresent === false;
  const renderValue = frozenValue ?? (shouldUseExitSnapshot ? lastLiveValueRef.current : liveValue);

  return {
    renderValue,
    isFrozen: frozenValue !== null,
    freeze,
  };
}
