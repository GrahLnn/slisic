import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let cursorInApp = false;

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
  return cursorInApp;
}

export function setCursorInApp(next: boolean) {
  if (cursorInApp === next) return;
  cursorInApp = next;
  emit();
}

export function useCursorInApp(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
