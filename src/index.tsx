import React from "react";
import ReactDOM from "react-dom/client";
import { me } from "@grahlnn/fn";
import { getPlatform } from "@/lib/utils";
import App from "./App";
import { ensureAppLogicStarted } from "./flow/appLogic";
import { AppBootstrapProvider, useAppBootstrap } from "./flow/bootstrap";
import MacOSControlsPortal from "./windowctrl/macos";
import WindowsControlsPortal from "./windowctrl/windows";

const os = me(getPlatform());

function WindowControlsRoot() {
  const app = useAppBootstrap();

  if (!app.showWindowControls) {
    return null;
  }

  return os.match({
    windows: () => <WindowsControlsPortal />,
    macos: () => <MacOSControlsPortal />,
    _: () => null,
  });
}

const rootEl = document.getElementById("root");
if (rootEl) {
  ensureAppLogicStarted();
  const root = ReactDOM.createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <AppBootstrapProvider>
        <WindowControlsRoot />
        <App />
      </AppBootstrapProvider>
    </React.StrictMode>,
  );
}
