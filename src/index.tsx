import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import WindowsControlsPortal from "./windowctrl/windows";
import MacOSControlsPortal from "./windowctrl/macos";
import { platform } from "@tauri-apps/plugin-os";
import { me } from "@grahlnn/fn";

const os = me(platform());

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
