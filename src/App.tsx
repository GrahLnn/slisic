import { useState } from "react";
import reactLogo from "./assets/react.svg";
import "./App.css";
import { commands } from "./commands";
import TopBar from "./topbar";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    // using tauri-specta automatically generates bindings for you
    setGreetMsg(await commands.greet(name));
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar />
      <main className="flex justify-center flex-col text-center gap-4">
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
        <p>Click on the Tauri, Rsbuild, and React logos to learn more.</p>

        <form
          className="flex justify-center"
          onSubmit={(e) => {
            e.preventDefault();
            greet();
          }}
        >
          <input
            id="greet-input"
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Enter a name..."
            className="mr-[5px] rounded-lg border border-transparent px-[1.2em] py-[0.6em] text-base font-medium text-[#0f0f0f] bg-white shadow-[0_2px_2px_rgba(0,0,0,0.2)] transition-[border-color] duration-[0.25s] outline-none dark:text-white dark:bg-[#0f0f0f98]"
          />
          <button
            className="rounded-lg border border-transparent px-[1.2em] py-[0.6em] text-base font-medium text-[#0f0f0f] bg-white shadow-[0_2px_2px_rgba(0,0,0,0.2)] transition-[border-color] duration-[0.25s] cursor-pointer outline-none hover:border-[#396cd8] active:border-[#396cd8] active:bg-[#e8e8e8] dark:text-white dark:bg-[#0f0f0f98] dark:active:bg-[#0f0f0f69]"
            type="submit"
          >
            Greet
          </button>
        </form>
        <p>{greetMsg}</p>
      </main>
    </div>
  );
}

export default App;
