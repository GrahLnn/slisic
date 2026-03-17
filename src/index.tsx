import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import WindowsControlsPortal from "./windowctrl/windows";
import MacOSControlsPortal from "./windowctrl/macos";
import { me } from "@grahlnn/fn";
import { getPlatform } from "@/lib/utils";

const os = me(getPlatform());

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
