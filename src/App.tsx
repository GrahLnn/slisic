import { cn } from "@/lib/utils";
import "./App.css";
import "@fontsource/maple-mono";
import { memo, useEffect, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import reactLogo from "./assets/react.svg";
import { crab } from "./cmd";
import Input from "./components/Input";
import TopBar from "./topbar";
import { Toaster } from "@/components/ui/sonner";
import { action as updater } from "./state_machine/updater";
import { ME, me } from "@grahlnn/fn";

type WindowType = "main";

function which_window(windowLabel: string): ME<WindowType> {
  return me("main");
}

const GreetForm = memo(function GreetForm() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    if (name === "") {
      setGreetMsg("Your name?");
      return;
    }
    const res = await crab.greet(name);
    res.tap((v) => {
      setGreetMsg(v);
      setName("");
    });
  }

  async function clean() {
    const res = await crab.clean();
    res.tap((v) => {
      setGreetMsg(v);
      setName("");
    });
  }

  return (
    <>
      <form
        className="flex justify-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <Input
          id="greet-input"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name..."
          className={cn(
            "rounded-lg border border-transparent",
            "px-[1.2em] py-[0.6em]",
            "text-base font-medium text-[#0f0f0f] bg-white",
            "shadow-[0_2px_2px_rgba(0,0,0,0.2)] transition-[border-color] duration-[0.25s]",
            "outline-none",
            "dark:text-white dark:bg-[#0f0f0f98] dark:border-[#171717]",
          )}
        />
        <button
          className={cn(
            "rounded-lg border outline-none cursor-pointer",
            "px-[1.2em] py-[0.6em]",
            "border-transparent text-[#0f0f0f] bg-white",
            "text-base font-medium",
            "shadow-[0_2px_2px_rgba(0,0,0,0.2)] transition-[border-color] duration-[0.25s]",
            "hover:border-[#396cd8] active:border-[#396cd8] active:bg-[#e8e8e8]",
            "dark:text-white dark:bg-[#0f0f0f98] dark:active:bg-[#0f0f0f69]",
          )}
          type="submit"
        >
          Greet
        </button>
        <button
          className={cn(
            "rounded-lg border outline-none cursor-pointer",
            "px-[1.2em] py-[0.6em]",
            "border-transparent text-[#0f0f0f] bg-white",
            "text-base font-medium",
            "shadow-[0_2px_2px_rgba(0,0,0,0.2)] transition-[border-color] duration-[0.25s]",
            "hover:border-[#396cd8] active:border-[#396cd8] active:bg-[#e8e8e8]",
            "dark:text-white dark:bg-[#0f0f0f98] dark:active:bg-[#0f0f0f69]",
          )}
          type="reset"
          onClick={clean}
        >
          Clean
        </button>
      </form>
      <p className="min-h-[1.5rem] mt-2">{greetMsg}</p>
    </>
  );
});

function Content() {
  return (
    <div className="flex justify-center flex-col text-center gap-4 flex-1">
      <h1>Welcome to Tauri + React</h1>

      <div className="flex justify-center">
        <a href="https://vitejs.dev" target="_blank" rel="noreferrer">
          <img
            src="/rsbuild.svg"
            className="h-24 p-6 transition-[filter] duration-[0.75s] will-change-[filter] hover:drop-shadow-[0_0_2em_#FFD700]"
            alt="Vite logo"
          />
        </a>
        <a href="https://tauri.app" target="_blank" rel="noreferrer">
          <img
            src="/tauri.svg"
            className="h-24 p-6 transition-[filter] duration-[0.75s] will-change-[filter] hover:drop-shadow-[0_0_2em_#24c8db]"
            alt="Tauri logo"
          />
        </a>
        <a href="https://reactjs.org" target="_blank" rel="noreferrer">
          <img
            src={reactLogo}
            className="h-24 p-6 transition-[filter] duration-[0.75s] will-change-[filter] hover:drop-shadow-[0_0_2em_#61dafb]"
            alt="React logo"
          />
        </a>
      </div>
      <p style={{ fontFamily: '"Maple Mono", monospace' }}>
        Click on the Tauri, Rsbuild, and React logos to learn more.
      </p>
      <GreetForm />
    </div>
  );
}

function Base({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen overflow-hidden hide-scrollbar">
      <TopBar />
      <main
        className={cn(
          "fixed top-0 left-0 h-screen w-full overflow-y-auto",
          "flex-1 flex flex-col hide-scrollbar",
        )}
      >
        <div className="min-h-8" />
        {children}
      </main>
      <Toaster />
    </div>
  );
}

function App() {
  const window = which_window(WebviewWindow.getCurrent().label);
  useEffect(() => {
    crab.appReady();
    updater.run();
  }, []);
  return window.match({
    main: () => (
      <Base>
        <Content />
      </Base>
    ),
  });
}

export default App;
