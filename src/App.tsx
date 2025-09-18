import "@fontsource/maple-mono";
import "./App.css";
import crab from "./cmd";
import { Scrollbar } from "./components/scrollbar/scrollbar";
import TopBar from "./topbar";
import Pages from "./pages/pages";
import { action } from "./state_machine/global/api";
import { station } from "./subpub/buses";
import { Provider } from "jotai";
import { appStore } from "./subpub/core";
import AudioVisualizerCanvas from "./components/audio/canvas";
import { useEffect } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

async function checkUpdate() {
  const update = await check();
  if (update) {
    console.log(
      `found update ${update.version} from ${update.date} with notes ${update.body}`
    );
    let downloaded = 0;
    let contentLength = 0;
    // alternatively we could also call update.download() and update.install() separately
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength!;
          console.log(`started downloading ${event.data.contentLength} bytes`);
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          console.log(`downloaded ${downloaded} from ${contentLength}`);
          break;
        case "Finished":
          console.log("download finished");
          break;
      }
    });

    console.log("update installed");
    toast.success("Restart to apply update");
  } else {
    console.log("No update found");
    toast.error("No update found");
  }
}

function App() {
  useEffect(() => {
    crab.appReady();
    action.run();
    checkUpdate();
  }, []);
  return (
    <Provider store={appStore}>
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
        <svg className="invisible h-0 w-0" aria-hidden="true">
          <filter
            id="glass-distortion"
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            filterUnits="objectBoundingBox"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.01 0.01"
              numOctaves="1"
              seed="5"
              result="turbulence"
            />

            <feComponentTransfer in="turbulence" result="mapped">
              <feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5" />
              <feFuncG type="gamma" amplitude="0" exponent="1" offset="0" />
              <feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5" />
            </feComponentTransfer>

            <feGaussianBlur in="turbulence" stdDeviation="3" result="softMap" />

            <feSpecularLighting
              in="softMap"
              surfaceScale="5"
              specularConstant="1"
              specularExponent="100"
              lightingColor="white"
              result="specLight"
            >
              <fePointLight x="-200" y="-200" z="300" />
            </feSpecularLighting>

            <feComposite
              in="specLight"
              operator="arithmetic"
              k1="0"
              k2="1"
              k3="1"
              k4="0"
              result="litImage"
            />

            <feDisplacementMap
              in="SourceGraphic"
              in2="softMap"
              scale="150"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </svg>
        <Toaster />
      </div>
    </Provider>
  );
}

export default App;
