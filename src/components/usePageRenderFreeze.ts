import { useCallback, useRef, useState } from "react";

export function resolvePageRenderFreezeValue<T>(args: {
  freezeOnExit: boolean;
  frozenValue: T | null;
  isPresent: boolean;
  lastLiveValue: T;
  liveValue: T;
}) {
  const shouldUseExitSnapshot = args.freezeOnExit && !args.isPresent;

  return {
    renderValue: args.frozenValue ?? (shouldUseExitSnapshot ? args.lastLiveValue : args.liveValue),
    isFrozen: args.frozenValue !== null,
  };
}

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

  const freezeState = resolvePageRenderFreezeValue({
    freezeOnExit: options?.freezeOnExit === true,
    frozenValue,
    isPresent: options?.isPresent !== false,
    lastLiveValue: lastLiveValueRef.current,
    liveValue,
  });

  return {
    renderValue: freezeState.renderValue,
    isFrozen: freezeState.isFrozen,
    freeze,
  };
}
