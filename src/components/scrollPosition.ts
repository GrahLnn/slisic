export type ScrollPositionRef = {
  current: number;
};

export function shouldApplyStoredScrollTop(args: {
  currentScrollTop: number;
  storedScrollTop: number;
  tolerancePx?: number;
}) {
  return Math.abs(args.currentScrollTop - args.storedScrollTop) >= (args.tolerancePx ?? 1);
}

export function restoreStoredScrollTop(
  node: HTMLElement | null,
  scrollPositionRef: ScrollPositionRef,
) {
  if (!node) {
    return;
  }

  if (
    shouldApplyStoredScrollTop({
      currentScrollTop: node.scrollTop,
      storedScrollTop: scrollPositionRef.current,
    })
  ) {
    node.scrollTop = scrollPositionRef.current;
  }
}

export function recordStoredScrollTop(node: HTMLElement, scrollPositionRef: ScrollPositionRef) {
  scrollPositionRef.current = node.scrollTop;
}
