// somewhere like src/hooks/useDisableReloadInProd.ts
import { useEffect } from "react";

export function useDisableReloadInProd() {
  useEffect(() => {
    if (import.meta.env.DEV) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const isReloadCombo =
        e.key === "F5" ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") ||
        // 有些人会按 Ctrl/Cmd + Shift + R
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "r");

      if (isReloadCombo) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // capture: true 能更早拦截，防止下游库先处理
    window.addEventListener("keydown", onKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", onKeyDown, {
        capture: true,
      } as any);
    };
  }, []);
}
