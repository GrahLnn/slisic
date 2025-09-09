import "@fontsource/maple-mono";
import { useEffect } from "react";
import "./App.css";
import crab from "./cmd";
import { Scrollbar } from "./components/scrollbar/scrollbar";
import TopBar from "./topbar";
import Pages from "./pages/pages";
import { action } from "./state_machine/global/api";
import { station } from "./subpub/buses";
import { Provider } from "jotai";
import { appStore } from "./subpub/core";
import { AudioVisualizerCanvas } from "./components/audio/canvas";

function App() {
  useEffect(() => {
    crab.appReady();
    action.run();
  }, []);
  return (
    <Provider store={appStore}>
      <div
        className="h-screen flex flex-col overflow-hidden hide-scrollbar"
        onMouseEnter={() => station.cursorinapp.set(true)}
        onMouseLeave={() => station.cursorinapp.set(false)}
      >
        <TopBar />
        <div className="fixed top-0 left-0 w-full h-full">
          <AudioVisualizerCanvas />
        </div>
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
      </div>
    </Provider>
  );
}

export default App;
