import { cn } from "@/lib/utils";
import "./fonts.css";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-serif";
import "./App.css";
import "sileo/styles.css";
import { useLayoutEffect, useRef, type PropsWithChildren } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";
import { Toaster } from "sileo";
import { PlayListPage } from "./components/PlayListPage";
import { ListConfig } from "./components/ListConfig";

import { hook as appLogicHook } from "./flow/appLogic";
import { useAppBootstrap } from "./flow/bootstrap";
import TopBar from "./topbar";

type PageScrollKey = "list" | "config";

function restorePageViewportScrollPosition(args: {
  node: HTMLElement | null;
  scrollKey: PageScrollKey;
  scrollPositionsRef: { current: Record<PageScrollKey, number> };
}) {
  if (!args.node) {
    return;
  }

  const nextScrollTop = args.scrollPositionsRef.current[args.scrollKey];
  if (Math.abs(args.node.scrollTop - nextScrollTop) < 1) {
    return;
  }

  args.node.scrollTop = nextScrollTop;
}

function WindowMainArea({ children }: PropsWithChildren) {
  return (
    <motion.main
      layoutRoot
      data-title-trace-root="window-main-area"
      className={cn(
        "fixed top-0 left-0 h-screen w-full overflow-hidden",
        "flex-1 hide-scrollbar",
      )}
    >
      {children}
    </motion.main>
  );
}

function PageViewport({
  children,
  pageKey,
  pageState,
  scrollKey,
  scrollPositionsRef,
  traceRoot,
}: PropsWithChildren<{
  pageKey: string;
  pageState: string;
  scrollKey: PageScrollKey;
  scrollPositionsRef: { current: Record<PageScrollKey, number> };
  traceRoot: string;
}>) {
  const viewportRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    restorePageViewportScrollPosition({
      node: viewportRef.current,
      scrollKey,
      scrollPositionsRef,
    });
  }, [pageKey, scrollKey, scrollPositionsRef]);

  return (
    <motion.section
      ref={(node) => {
        viewportRef.current = node;
        restorePageViewportScrollPosition({
          node,
          scrollKey,
          scrollPositionsRef,
        });
      }}
      layoutScroll
      data-title-trace-root={traceRoot}
      data-title-trace-scroll-root={traceRoot}
      data-page-state={pageState}
      className={cn(
        "absolute inset-0 overflow-y-auto overscroll-y-contain pt-8",
        "hide-scrollbar",
      )}
      onScrollCapture={(event) => {
        scrollPositionsRef.current[scrollKey] = event.currentTarget.scrollTop;
      }}
    >
      {children}
    </motion.section>
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
  const scrollPositionsRef = useRef<Record<PageScrollKey, number>>({
    list: 0,
    config: 0,
  });

  return (
    <Base>
      <AnimatePresence initial={false}>
        {appLogicState.match({
          config: () => (
            <PageViewport
              key="config"
              pageKey="config"
              pageState="config"
              scrollKey="config"
              scrollPositionsRef={scrollPositionsRef}
              traceRoot="app-page-config"
            >
              <ListConfig />
            </PageViewport>
          ),
          configLoading: () => (
            <PageViewport
              key="config"
              pageKey="config"
              pageState="config-loading"
              scrollKey="config"
              scrollPositionsRef={scrollPositionsRef}
              traceRoot="app-page-config-loading"
            >
              <ListConfig />
            </PageViewport>
          ),
          configUpdatingCollectionUpdates: () => (
            <PageViewport
              key="config"
              pageKey="config"
              pageState="config-updating"
              scrollKey="config"
              scrollPositionsRef={scrollPositionsRef}
              traceRoot="app-page-config-updating"
            >
              <ListConfig />
            </PageViewport>
          ),
          idle: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="idle"
              scrollKey="list"
              scrollPositionsRef={scrollPositionsRef}
              traceRoot="app-page-list-idle"
            >
              <PlayListPage />
            </PageViewport>
          ),
          loading: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="loading"
              scrollKey="list"
              scrollPositionsRef={scrollPositionsRef}
              traceRoot="app-page-list-loading"
            >
              <PlayListPage />
            </PageViewport>
          ),
          ready: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="ready"
              scrollKey="list"
              scrollPositionsRef={scrollPositionsRef}
              traceRoot="app-page-list-ready"
            >
              <PlayListPage />
            </PageViewport>
          ),
          error: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="error"
              scrollKey="list"
              scrollPositionsRef={scrollPositionsRef}
              traceRoot="app-page-list-error"
            >
              <PlayListPage />
            </PageViewport>
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
