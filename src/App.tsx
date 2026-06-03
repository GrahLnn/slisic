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
import {
  installRenderPerformanceTrace,
  recordTrace,
  type RenderPerformanceTraceProbe,
} from "./debug/renderPerformanceTrace";
import { PlayListPage } from "./components/PlayListPage";
import { ListConfig } from "./components/ListConfig";
import { SpectrumPage } from "./components/spectrum/SpectrumPage";

import { hook as appLogicHook } from "./flow/appLogic";
import { useAppBootstrap } from "./flow/bootstrap";
import TopBar from "./topbar";
import {
  recordStoredScrollTop,
  restoreStoredScrollTop,
  type ScrollPositionRef,
} from "./components/scrollPosition";
import { PageViewportScrollElementProvider } from "./components/pageViewportScroll";

const enabledRenderPerformanceTraceProbes = [
] satisfies RenderPerformanceTraceProbe[];

installRenderPerformanceTrace({
  enabledProbes: enabledRenderPerformanceTraceProbes,
});

type PageScrollKey = "list" | "config" | "spectrum";

function restorePageViewportScrollPosition(args: {
  node: HTMLElement | null;
  scrollPositionRef: ScrollPositionRef;
}) {
  restoreStoredScrollTop(args.node, args.scrollPositionRef);
}

function WindowMainArea({ children }: PropsWithChildren) {
  return (
    <motion.main
      layoutRoot
      className={cn("fixed top-0 left-0 h-screen w-full overflow-hidden", "flex-1 hide-scrollbar")}
    >
      {children}
    </motion.main>
  );
}

function PageViewport({
  children,
  pageKey,
  pageState,
  scrollPositionRef,
  scrollLocked = false,
}: PropsWithChildren<{
  pageKey: string;
  pageState: string;
  scrollPositionRef: ScrollPositionRef;
  scrollLocked?: boolean;
}>) {
  const viewportRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    restorePageViewportScrollPosition({
      node: viewportRef.current,
      scrollPositionRef,
    });
  }, [pageKey, scrollPositionRef]);

  return (
    <motion.section
      ref={(node) => {
        viewportRef.current = node;
        restorePageViewportScrollPosition({
          node,
          scrollPositionRef,
        });
      }}
      layoutScroll
      data-page-state={pageState}
      className={cn(
        "absolute inset-0 pt-8",
        scrollLocked || pageState === "play"
          ? "overflow-hidden"
          : "overflow-y-auto overscroll-y-contain",
        "hide-scrollbar",
      )}
      onScroll={(event) => {
        recordStoredScrollTop(event.currentTarget, scrollPositionRef);
      }}
    >
      <PageViewportScrollElementProvider scrollElementRef={viewportRef}>
        {children}
      </PageViewportScrollElementProvider>
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
  const pageScrollPositionRefs = useRef<Record<PageScrollKey, ScrollPositionRef>>({
    list: { current: 0 },
    config: { current: 0 },
    spectrum: { current: 0 },
  });
  const playListScrollPositionRef = useRef(0);

  const viewport = appLogicState.match({
    config: () => ({
      key: "config",
      pageKey: "config",
      pageState: "config",
      scrollPositionRef: pageScrollPositionRefs.current.config,
      sourceState: "config",
      surface: "config",
      children: <ListConfig />,
    }),
    configLoading: () => ({
      key: "config",
      pageKey: "config",
      pageState: "config-loading",
      scrollPositionRef: pageScrollPositionRefs.current.config,
      sourceState: "configLoading",
      surface: "config",
      children: <ListConfig />,
    }),
    configUpdatingCollectionUpdates: () => ({
      key: "config",
      pageKey: "config",
      pageState: "config-updating",
      scrollPositionRef: pageScrollPositionRefs.current.config,
      sourceState: "configUpdatingCollectionUpdates",
      surface: "config",
      children: <ListConfig />,
    }),
    idle: () => ({
      key: "list",
      pageKey: "list",
      pageState: "idle",
      scrollPositionRef: pageScrollPositionRefs.current.list,
      sourceState: "idle",
      surface: "playlist",
      children: <PlayListPage scrollPositionRef={playListScrollPositionRef} />,
    }),
    loading: () => ({
      key: "list",
      pageKey: "list",
      pageState: "loading",
      scrollPositionRef: pageScrollPositionRefs.current.list,
      sourceState: "loading",
      surface: "playlist",
      children: <PlayListPage scrollPositionRef={playListScrollPositionRef} />,
    }),
    ready: () => ({
      key: "list",
      pageKey: "list",
      pageState: "ready",
      scrollPositionRef: pageScrollPositionRefs.current.list,
      sourceState: "ready",
      surface: "playlist",
      children: <PlayListPage scrollPositionRef={playListScrollPositionRef} />,
    }),
    play: () => ({
      key: "list",
      pageKey: "list",
      pageState: "play",
      scrollPositionRef: pageScrollPositionRefs.current.list,
      sourceState: "play",
      surface: "playlist",
      children: <PlayListPage scrollPositionRef={playListScrollPositionRef} />,
    }),
    spectrum: () => ({
      key: "spectrum",
      pageKey: "spectrum",
      pageState: "spectrum",
      scrollPositionRef: pageScrollPositionRefs.current.spectrum,
      sourceState: "spectrum",
      surface: "spectrum",
      children: <SpectrumPage />,
    }),
    error: () => ({
      key: "list",
      pageKey: "list",
      pageState: "error",
      scrollPositionRef: pageScrollPositionRefs.current.list,
      sourceState: "error",
      surface: "playlist",
      children: <PlayListPage scrollPositionRef={playListScrollPositionRef} />,
    }),
  });
  const previousViewportTraceRef = useRef<string | null>(null);
  const viewportTracePayload = {
    key: viewport.key,
    pageKey: viewport.pageKey,
    pageState: viewport.pageState,
    sourceState: viewport.sourceState,
    surface: viewport.surface,
    surfacePageState: "surfacePageState" in viewport ? viewport.surfacePageState : undefined,
  };
  const viewportTraceKey = JSON.stringify(viewportTracePayload);
  useLayoutEffect(() => {
    if (previousViewportTraceRef.current === viewportTraceKey) {
      return;
    }

    previousViewportTraceRef.current = viewportTraceKey;
    recordTrace("app-viewport-projected", viewportTracePayload);
  }, [viewportTraceKey, viewportTracePayload]);

  return (
    <Base>
      <AnimatePresence initial={false}>
        <PageViewport
          key={viewport.key}
          pageKey={viewport.pageKey}
          pageState={viewport.pageState}
          scrollPositionRef={viewport.scrollPositionRef}
          scrollLocked={viewport.surface === "config"}
        >
          {viewport.children}
        </PageViewport>
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
