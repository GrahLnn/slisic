import type { CSSProperties } from "react";

export type ToolLabelAnchor = "left" | "right";

export function isScrollableContainer(element: HTMLElement) {
  const { overflow, overflowX, overflowY } = window.getComputedStyle(element);
  const overflowValue = `${overflow} ${overflowX} ${overflowY}`;

  return /(auto|scroll|overlay)/.test(overflowValue);
}

export function collectScrollContainers(anchor: HTMLElement | null) {
  const containers: HTMLElement[] = [];
  let current = anchor?.parentElement ?? null;

  while (current) {
    if (isScrollableContainer(current)) {
      containers.push(current);
    }

    current = current.parentElement;
  }

  return containers;
}

export function collectHoverSyncScrollTargets(anchor: HTMLElement | null) {
  const containers = collectScrollContainers(anchor);
  const ownerWindow = anchor?.ownerDocument.defaultView;

  return {
    containers,
    ownerWindow: ownerWindow ?? null,
  };
}

export function toOverlayStyle(
  rect: DOMRectReadOnly,
  anchor: ToolLabelAnchor,
  viewportWidth: number,
): CSSProperties {
  return anchor === "right"
    ? {
        top: rect.top,
        right: viewportWidth - rect.right,
        height: rect.height,
        minWidth: rect.width,
      }
    : {
        top: rect.top,
        left: rect.left,
        height: rect.height,
        minWidth: rect.width,
      };
}

export function sameRect(a: DOMRectReadOnly | null, b: DOMRectReadOnly) {
  return (
    !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
  );
}
