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
}: PropsWithChildren<{
  pageKey: string;
  pageState: string;
  scrollKey: PageScrollKey;
  scrollPositionsRef: { current: Record<PageScrollKey, number> };
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
      data-page-state={pageState}
      data-title-trace-root={pageState}
      data-title-trace-scroll-root={scrollKey}
      className={cn(
        "absolute inset-0 pt-8",
        pageState === "play"
          ? "overflow-hidden"
          : "overflow-y-auto overscroll-y-contain",
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
            >
              <PlayListPage />
            </PageViewport>
          ),
          play: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="play"
              scrollKey="list"
              scrollPositionsRef={scrollPositionsRef}
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
