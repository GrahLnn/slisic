import { cn } from "@/lib/utils";
import "./fonts.css";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-serif";
import "./App.css";
import "sileo/styles.css";
import { type PropsWithChildren } from "react";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { useTheme } from "next-themes";
import { Toaster } from "sileo";
import { PlayListPage } from "./components/PlayListPage";
import { ListConfig } from "./components/ListConfig";

import { hook as appLogicHook } from "./flow/appLogic";
import { useAppBootstrap } from "./flow/bootstrap";
import { useInteractionBootstrap } from "./flow/interaction";
import TopBar from "./topbar";

function WindowMainArea({ children }: PropsWithChildren) {
  return (
    <main
      className={cn(
        "fixed top-0 left-0 h-screen w-full overflow-y-auto overscroll-y-contain",
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

function SupportWindowContent() {
  return null;
}

function MainWindowApp() {
  const appLogicState = appLogicHook.useState();

  return (
    <Base>
      {appLogicState.match({
        config: () => <ListConfig key="config" />,
        idle: () => <PlayListPage key="list" />,
        loading: () => <PlayListPage key="list" />,
        ready: () => <PlayListPage key="list" />,
        error: () => <PlayListPage key="list" />,
      })}
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
  useInteractionBootstrap(app);

  return app.window.match({
    main: () => <MainWindowApp />,
    support: () => <SupportWindowApp />,
  });
}

export default App;
