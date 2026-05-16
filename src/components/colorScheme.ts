import { useSyncExternalStore } from "react";

function subscribeToColorScheme(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = () => onStoreChange();
  mediaQuery.addEventListener("change", handleChange);

  return () => {
    mediaQuery.removeEventListener("change", handleChange);
  };
}

function readColorSchemeSnapshot() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function usePrefersDarkColorScheme() {
  return useSyncExternalStore(subscribeToColorScheme, readColorSchemeSnapshot, () => false);
}
