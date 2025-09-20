import "@fontsource/maple-mono";
import "./App.css";
import crab from "./cmd";
import { Scrollbar } from "./components/scrollbar/scrollbar";
import TopBar from "./topbar";
import Pages from "./pages/pages";
import { action } from "./state_machine/global";
import { action as updater } from "./state_machine/updater";
import { station } from "./subpub/buses";
import { Provider } from "jotai";
import { appStore } from "./subpub/core";
import AudioVisualizerCanvas from "./components/audio/canvas";
import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { useIsDark } from "./state_machine/normal";
import Filter from "./components/svg_filter";

function App() {
  const isDark = useIsDark();
  useEffect(() => {
    crab.appReady();
    action.run();
    updater.run();
  }, []);
  return (
    <Provider store={appStore}>
      <Filter />
      <AudioVisualizerCanvas />
      <div
        className="h-screen flex flex-col overflow-hidden hide-scrollbar"
        onMouseEnter={() => station.cursorinapp.set(true)}
        onMouseLeave={() => station.cursorinapp.set(false)}
        onContextMenu={
          !import.meta.env.DEV ? (e) => e.preventDefault() : undefined
        }
      >
        <TopBar />
        <main className="flex-1 flex overflow-hidden hide-scrollbar">
          <Pages />
        </main>
        <Scrollbar />

        <Toaster
          toastOptions={{
            style: {
              background: isDark
                ? "rgba(0, 0, 0, 0.2)"
                : "rgba(255, 255, 255, 0.2)",
              backdropFilter: "url(#filter) blur(4px)",
              border: "none",
              transition: "all 0.3s cubic-bezier(0.2, 0.9, 0.3, 1.5)",
            },
            classNames: {
              actionButton: "lg-btn-action gl",
            },
          }}
        />
      </div>
    </Provider>
  );
}

export default App;
