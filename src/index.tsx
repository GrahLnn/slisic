import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import WindowsControlsPortal from "./windowctrl/windows";
import MacOSControlsPortal from "./windowctrl/macos";
import { me } from "@grahlnn/fn";
import { getPlatform } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";

const os = me(getPlatform());
const startupReadyEvent = "factory://startup-ready";

function signalStartupReady() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const tauriWindow = window as typeof window & {
    __TAURI_INTERNALS__?: unknown;
  };

  if (!tauriWindow.__TAURI_INTERNALS__) {
    return;
  }

  const notifyReady = async () => {
    try {
      await getCurrentWindow().once(startupReadyEvent, () => {
        console.info("startup: received native ready event");
      });
      console.info("startup: renderer awaiting native ready event");
    } catch (error) {
      console.error("startup: failed to subscribe to native ready event", error);
      throw error;
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void notifyReady();
    }, { once: true });
    return;
  }

  void notifyReady();
}

signalStartupReady();

const rootEl = document.getElementById("root");
if (rootEl) {
  const root = ReactDOM.createRoot(rootEl);
  root.render(
    <React.StrictMode>
      {os.match({
        windows: () => <WindowsControlsPortal />,
        macos: () => <MacOSControlsPortal />,
        _: () => null,
      })}
      <App />
    </React.StrictMode>,
  );
}
