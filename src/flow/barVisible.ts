import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let visible = true;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return visible;
}

export function toggleVisibility(shouldVisible: boolean) {
  if (visible === shouldVisible) return;
  visible = shouldVisible;
  emit();
}

export function useIsBarVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
