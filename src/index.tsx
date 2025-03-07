import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import WindowsControlsPortal from "./windowctrl/windows";

const rootEl = document.getElementById("root");
if (rootEl) {
  const root = ReactDOM.createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <WindowsControlsPortal />
      <App />
    </React.StrictMode>
  );
}
