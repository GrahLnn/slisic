import { cn } from "@/lib/utils";
import "./App.css";
import "sileo/styles.css";
import "@fontsource/maple-mono";
import type { PropsWithChildren } from "react";
import { useTheme } from "next-themes";
import { Toaster } from "sileo";
import { useAppBootstrap } from "./flow/bootstrap";
import { crab } from "./cmd";
import TopBar from "./topbar";

function WindowMainArea({ children }: PropsWithChildren) {
  return (
    <main
      className={cn(
        "fixed top-0 left-0 h-screen w-full overflow-y-auto",
        "flex-1 flex flex-col hide-scrollbar",
      )}
    >
      <div className="min-h-8" />
      {children}
    </main>
  );
}

function WindowToaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Toaster
      position="bottom-right"
      theme={resolvedTheme === "dark" ? "dark" : "light"}
    />
  );
}

function Base({ children }: PropsWithChildren) {
  return (
    <div className="min-h-screen overflow-hidden hide-scrollbar">
      <TopBar />
      <WindowMainArea>{children}</WindowMainArea>
      <WindowToaster />
    </div>
  );
}

function MainWindowContent() {
  return (
    <div className="flex min-h-[calc(100vh-2rem)] items-center justify-center">
      <button
        className={cn(
          "rounded-full border border-black/10 bg-black px-6 py-3 text-sm font-medium text-white",
          "shadow-[0_14px_30px_rgba(15,23,42,0.16)] transition duration-200 ease-out",
          "hover:-translate-y-0.5 hover:bg-black/92",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20",
          "dark:border-white/10 dark:bg-white dark:text-black dark:hover:bg-white/92 dark:focus-visible:ring-white/20",
        )}
        type="button"
        onClick={() => {
          void crab.createWindow("Main", null).catch((error) => {
            console.error("Failed to create main window", error);
          });
        }}
      >
        Open Main Window
      </button>
    </div>
  );
}

function SupportWindowContent() {
  return null;
}

function MainWindowApp() {
  return (
    <Base>
      <MainWindowContent />
    </Base>
  );
}

function SupportWindowApp() {
  return (
    <Base>
      <SupportWindowContent />
    </Base>
  );
}

function App() {
  const app = useAppBootstrap();

  return app.window.match({
    main: () => <MainWindowApp />,
    support: () => <SupportWindowApp />,
  });
}

export default App;
