import { Window } from "@tauri-apps/api/window";
import { useSyncExternalStore } from "react";

const appWindow = Window.getCurrent();
const listeners = new Set<() => void>();
let maximized = false;
let booted = false;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

async function refreshMaximized() {
  try {
    const next = await appWindow.isMaximized();
    if (next === maximized) return;
    maximized = next;
    emit();
  } catch {
    // swallow window-state errors and keep previous snapshot
  }
}

async function ensureBooted() {
  if (booted) return;
  booted = true;

  await refreshMaximized();
  await appWindow.onResized(() => {
    void refreshMaximized();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void ensureBooted();

  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return maximized;
}

export function useIsWindowMaximized(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
