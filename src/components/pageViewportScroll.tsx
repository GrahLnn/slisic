import { createContext, useContext, type PropsWithChildren, type RefObject } from "react";

type PageViewportScrollElementRef = RefObject<HTMLElement | null>;

const PageViewportScrollElementContext = createContext<PageViewportScrollElementRef | null>(null);

export function PageViewportScrollElementProvider({
  children,
  scrollElementRef,
}: PropsWithChildren<{
  scrollElementRef: PageViewportScrollElementRef;
}>) {
  return (
    <PageViewportScrollElementContext.Provider value={scrollElementRef}>
      {children}
    </PageViewportScrollElementContext.Provider>
  );
}

export function usePageViewportScrollElementRef() {
  const scrollElementRef = useContext(PageViewportScrollElementContext);
  if (!scrollElementRef) {
    throw new Error("Page viewport scroll element is not available.");
  }

  return scrollElementRef;
}
