import { useSyncExternalStore } from "react";

function subscribe(listener: () => void) {
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);

  return () => {
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
  };
}

function getSnapshot() {
  return document.hasFocus();
}

export function useIsWindowFocus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
