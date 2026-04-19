import { useCallback, useState } from "react";

/**
 * Page exits often need a stable render snapshot so shared-layout motion can
 * finish against one coherent frame instead of chasing live state updates from
 * the next transition step.
 */
export function usePageRenderFreeze<T>(liveValue: T) {
  const [frozenValue, setFrozenValue] = useState<T | null>(null);

  const freeze = useCallback(
    (snapshot?: T) => {
      setFrozenValue(snapshot ?? liveValue);
    },
    [liveValue],
  );

  return {
    renderValue: frozenValue ?? liveValue,
    isFrozen: frozenValue !== null,
    freeze,
  };
}
