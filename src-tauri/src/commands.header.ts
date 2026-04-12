/* eslint-disable */

type __WebviewWindow__ =
  | import("@tauri-apps/api/webview").Webview
  | import("@tauri-apps/api/window").Window;

type __EventObj__<T> = {
  listen: (cb: (event: { payload: T }) => void) => Promise<() => void>;
  once: (cb: (event: { payload: T }) => void) => Promise<() => void>;
  emit: T extends null ? () => Promise<void> : (payload: T) => Promise<void>;
};

export type EventsShape<T extends Record<string, any>> = {
  [K in keyof T]: __EventObj__<T[K]> & {
    (handle: __WebviewWindow__): __EventObj__<T[K]>;
  };
};

export function makeLiveEvent<T extends Record<string, any>>(ev: EventsShape<T>) {
  return function liveEvent<K extends keyof T>(key: K) {
    return (handler: (payload: T[K]) => void) => {
      const obj = ev[key] as __EventObj__<T[K]>;
      return obj.listen((e) => handler(e.payload));
    };
  };
}
