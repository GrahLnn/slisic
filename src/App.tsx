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
import { installRenderPerformanceTrace } from "./debug/renderPerformanceTrace";
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
}: PropsWithChildren<{
  pageKey: string;
  pageState: string;
  scrollPositionRef: ScrollPositionRef;
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
        pageState === "play" ? "overflow-hidden" : "overflow-y-auto overscroll-y-contain",
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
  useLayoutEffect(() => {
    installRenderPerformanceTrace();
  }, []);

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

  return (
    <Base>
      <AnimatePresence initial={false}>
        {appLogicState.match({
          config: () => (
            <PageViewport
              key="config"
              pageKey="config"
              pageState="config"
              scrollPositionRef={pageScrollPositionRefs.current.config}
            >
              <ListConfig />
            </PageViewport>
          ),
          configLoading: () => (
            <PageViewport
              key="config"
              pageKey="config"
              pageState="config-loading"
              scrollPositionRef={pageScrollPositionRefs.current.config}
            >
              <ListConfig />
            </PageViewport>
          ),
          configUpdatingCollectionUpdates: () => (
            <PageViewport
              key="config"
              pageKey="config"
              pageState="config-updating"
              scrollPositionRef={pageScrollPositionRefs.current.config}
            >
              <ListConfig />
            </PageViewport>
          ),
          idle: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="idle"
              scrollPositionRef={pageScrollPositionRefs.current.list}
            >
              <PlayListPage scrollPositionRef={playListScrollPositionRef} />
            </PageViewport>
          ),
          loading: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="loading"
              scrollPositionRef={pageScrollPositionRefs.current.list}
            >
              <PlayListPage scrollPositionRef={playListScrollPositionRef} />
            </PageViewport>
          ),
          ready: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="ready"
              scrollPositionRef={pageScrollPositionRefs.current.list}
            >
              <PlayListPage scrollPositionRef={playListScrollPositionRef} />
            </PageViewport>
          ),
          play: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="play"
              scrollPositionRef={pageScrollPositionRefs.current.list}
            >
              <PlayListPage scrollPositionRef={playListScrollPositionRef} />
            </PageViewport>
          ),
          spectrumLoadingMusics: () => (
            <PageViewport
              key="spectrum"
              pageKey="spectrum"
              pageState="spectrum-loading-musics"
              scrollPositionRef={pageScrollPositionRefs.current.spectrum}
            >
              <SpectrumPage />
            </PageViewport>
          ),
          spectrum: () => (
            <PageViewport
              key="spectrum"
              pageKey="spectrum"
              pageState="spectrum"
              scrollPositionRef={pageScrollPositionRefs.current.spectrum}
            >
              <SpectrumPage />
            </PageViewport>
          ),
          spectrumUpdatingMusic: () => (
            <PageViewport
              key="spectrum"
              pageKey="spectrum"
              pageState="spectrum-updating"
              scrollPositionRef={pageScrollPositionRefs.current.spectrum}
            >
              <SpectrumPage />
            </PageViewport>
          ),
          spectrumDeletingMusic: () => (
            <PageViewport
              key="spectrum"
              pageKey="spectrum"
              pageState="spectrum-deleting"
              scrollPositionRef={pageScrollPositionRefs.current.spectrum}
            >
              <SpectrumPage />
            </PageViewport>
          ),
          error: () => (
            <PageViewport
              key="list"
              pageKey="list"
              pageState="error"
              scrollPositionRef={pageScrollPositionRefs.current.list}
            >
              <PlayListPage scrollPositionRef={playListScrollPositionRef} />
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
