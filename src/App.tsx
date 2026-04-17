import { cn } from "@/lib/utils";
import "./fonts.css";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-serif";
import "./App.css";
import "sileo/styles.css";
import { type PropsWithChildren } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";
import { Toaster } from "sileo";
import { PlayListPage } from "./components/PlayListPage";
import { ListConfig } from "./components/ListConfig";

import { hook as appLogicHook } from "./flow/appLogic";
import { useAppBootstrap } from "./flow/bootstrap";
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

  return <Toaster position="bottom-right" theme={resolvedTheme === "dark" ? "dark" : "light"} />;
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
      {/* Shared titles need the entering page to measure in its real slot. */}
      <AnimatePresence initial={false} mode="popLayout">
        {appLogicState.match({
          config: () => (
            // popLayout only works on direct DOM-backed motion children.
            <motion.div key="config" className="relative w-full">
              <ListConfig />
            </motion.div>
          ),
          configLoading: () => (
            <motion.div key="config" className="relative w-full">
              <ListConfig />
            </motion.div>
          ),
          configUpdatingCollectionUpdates: () => (
            <motion.div key="config" className="relative w-full">
              <ListConfig />
            </motion.div>
          ),
          idle: () => (
            <motion.div key="list" className="relative w-full">
              <PlayListPage />
            </motion.div>
          ),
          loading: () => (
            <motion.div key="list" className="relative w-full">
              <PlayListPage />
            </motion.div>
          ),
          ready: () => (
            <motion.div key="list" className="relative w-full">
              <PlayListPage />
            </motion.div>
          ),
          error: () => (
            <motion.div key="list" className="relative w-full">
              <PlayListPage />
            </motion.div>
          ),
        })}
      </AnimatePresence>
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
