import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";

export function MaskR() {
  return (
    <motion.div
      className="w-6 py-0.5 mask-lor"
      initial={{ backdropFilter: "blur(0px)" }}
      animate={{
        backdropFilter: "blur(1px)",
      }}
      exit={{
        backdropFilter: "blur(0px)",
      }}
      transition={{ duration: 0.2 }}
    >
      <div className="text-xs opacity-0">_</div>
    </motion.div>
  );
}

export function MaskL() {
  return (
    <motion.div
      className="w-6 py-0.5 mask-rol"
      initial={{ backdropFilter: "blur(0px)" }}
      animate={{
        backdropFilter: "blur(1px)",
      }}
      exit={{
        backdropFilter: "blur(0px)",
      }}
      transition={{ duration: 0.2 }}
    >
      <div className="text-xs opacity-0">_</div>
    </motion.div>
  );
}

export function MaskMiddle() {
  return (
    <motion.div
      className="w-1 py-0.5 backdrop-blur-[1px]"
      initial={{ backdropFilter: "blur(0px)" }}
      animate={{
        backdropFilter: "blur(1px)",
      }}
      exit={{
        backdropFilter: "blur(0px)",
      }}
      transition={{ duration: 0.2 }}
    >
      <div className="text-xs opacity-0">_</div>
    </motion.div>
  );
}

const TOOL_LABEL_OVERLAY_CLASS_NAME =
  "z-200 inline-flex cursor-default items-center overflow-visible";
type ToolLabelAnchor = "left" | "right";

export function resolveToolLabelOverlayVisibility(args: {
  isHovered: boolean;
  hasTool: boolean;
  interactionDisabled: boolean;
}) {
  return args.isHovered && args.hasTool && !args.interactionDisabled;
}

function ToolLabelOverlayBody({ tool }: { tool: React.ReactNode }) {
  return <div className="inline-flex h-full min-w-full items-center overflow-visible">{tool}</div>;
}

function isScrollableContainer(element: HTMLElement) {
  const { overflow, overflowX, overflowY } = window.getComputedStyle(element);
  const overflowValue = `${overflow} ${overflowX} ${overflowY}`;

  return /(auto|scroll|overlay)/.test(overflowValue);
}

function collectScrollContainers(anchor: HTMLElement | null) {
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

function canScrollContainer(container: HTMLElement, deltaX: number, deltaY: number) {
  const canScrollVertically = deltaY !== 0 && container.scrollHeight > container.clientHeight;
  const canScrollHorizontally = deltaX !== 0 && container.scrollWidth > container.clientWidth;

  return canScrollVertically || canScrollHorizontally;
}

function findScrollableAncestor(element: HTMLElement | null, deltaX: number, deltaY: number) {
  let current = element;

  while (current) {
    if (isScrollableContainer(current) && canScrollContainer(current, deltaX, deltaY)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function findUnderlyingScrollContainer(
  anchor: HTMLElement | null,
  overlay: HTMLElement | null,
  clientX: number,
  clientY: number,
  deltaX: number,
  deltaY: number,
) {
  const doc = anchor?.ownerDocument;

  if (!doc) {
    return null;
  }

  return doc
    .elementsFromPoint(clientX, clientY)
    .filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && !anchor?.contains(element) && !overlay?.contains(element),
    )
    .map((element) => findScrollableAncestor(element, deltaX, deltaY))
    .find((container): container is HTMLElement => !!container);
}

function forwardWheelToScrollContainer(
  anchor: HTMLElement | null,
  overlay: HTMLElement | null,
  clientX: number,
  clientY: number,
  deltaX: number,
  deltaY: number,
) {
  if (!anchor) {
    return;
  }

  const scrollContainer =
    findUnderlyingScrollContainer(anchor, overlay, clientX, clientY, deltaX, deltaY) ??
    collectScrollContainers(anchor).find((container) =>
      canScrollContainer(container, deltaX, deltaY),
    );

  if (scrollContainer) {
    scrollContainer.scrollBy({
      left: deltaX,
      top: deltaY,
    });
    return;
  }

  anchor.ownerDocument.defaultView?.scrollBy({
    left: deltaX,
    top: deltaY,
  });
}

function toOverlayStyle(
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

function sameRect(a: DOMRectReadOnly | null, b: DOMRectReadOnly) {
  return (
    !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
  );
}

/**
 * Portal tool rendering must stay as a dedicated branch instead of being merged
 * into the inline overlay path.
 *
 * The inline branch depends on local absolute positioning and therefore stays
 * inside the anchor's compositing tree. That is fine for normal content, but it
 * fails for tool content that relies on nested `backdrop-filter`/`mask` because
 * blurred ancestors create a new backdrop root and cut off the sampling chain.
 *
 * The portal branch solves a different problem: it measures the anchor in
 * viewport coordinates and renders the tool outside the blurred ancestor tree so
 * the inner tool effects can sample the real page backdrop again. Unifying the
 * two branches would either reintroduce the compositing bug for portal use cases
 * or force every inline overlay to pay the global measurement/scroll-sync cost.
 */
function ToolLabelPortalOverlay({
  anchorRef,
  overlayRef,
  onMouseEnter,
  onMouseLeave,
  onWheelCapture,
  tool,
  toolAnchor,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  overlayRef: React.RefObject<HTMLDivElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: (event: React.MouseEvent<HTMLDivElement>) => void;
  onWheelCapture: (event: React.WheelEvent<HTMLDivElement>) => void;
  tool: React.ReactNode;
  toolAnchor: ToolLabelAnchor;
}) {
  const [anchorRect, setAnchorRect] = useState<DOMRectReadOnly | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const ownerWindow = anchor?.ownerDocument.defaultView;

    if (!anchor || !ownerWindow) {
      setAnchorRect(null);
      return;
    }

    const syncRect = () => {
      const nextRect = anchor.getBoundingClientRect();

      setAnchorRect((currentRect) => (sameRect(currentRect, nextRect) ? currentRect : nextRect));
    };

    syncRect();

    const resizeObserver = new ResizeObserver(syncRect);
    resizeObserver.observe(anchor);

    ownerWindow.addEventListener("resize", syncRect);

    const scrollContainers = collectScrollContainers(anchor);
    scrollContainers.forEach((container) => {
      container.addEventListener("scroll", syncRect, { passive: true });
    });

    return () => {
      resizeObserver.disconnect();
      ownerWindow.removeEventListener("resize", syncRect);
      scrollContainers.forEach((container) => {
        container.removeEventListener("scroll", syncRect);
      });
    };
  }, [anchorRef]);

  const portalTarget = anchorRef.current?.ownerDocument.body;
  const viewportWidth = anchorRef.current?.ownerDocument.defaultView?.innerWidth ?? 0;

  if (!portalTarget || !anchorRect || viewportWidth <= 0) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onWheelCapture={onWheelCapture}
      className={cn("fixed", TOOL_LABEL_OVERLAY_CLASS_NAME)}
      style={toOverlayStyle(anchorRect, toolAnchor, viewportWidth)}
    >
      <ToolLabelOverlayBody tool={tool} />
    </div>,
    portalTarget,
  );
}

export function ToolLabel({
  text,
  tool,
  textClassName,
  className,
  layoutId,
  hoverMode = "self",
  interactionDisabled = false,
  toolLayer = "inline",
  toolAnchor = "left",
}: {
  text: string;
  textClassName?: string;
  tool?: React.ReactNode;
  layoutId?: string;
  hoverMode?: "self" | "group";
  interactionDisabled?: boolean;
  toolLayer?: "inline" | "portal";
  toolAnchor?: ToolLabelAnchor;
} & ComponentProps<"div">) {
  const [isHovered, setIsHovered] = useState(false);
  const [isLayoutAnimating, setIsLayoutAnimating] = useState(false);
  const resolvedTextClassName = textClassName ?? "";
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hoverSyncFrameRef = useRef<number | null>(null);
  const effectiveInteractionDisabled = interactionDisabled || isLayoutAnimating;
  const isOverlayVisible = resolveToolLabelOverlayVisibility({
    isHovered,
    hasTool: Boolean(tool),
    interactionDisabled: effectiveInteractionDisabled,
  });

  function containsTarget(container: HTMLElement | null, target: EventTarget | null) {
    return target instanceof Node && !!container?.contains(target);
  }

  function clearPendingHoverSync() {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;

    if (!ownerWindow || hoverSyncFrameRef.current === null) {
      hoverSyncFrameRef.current = null;
      return;
    }

    ownerWindow.cancelAnimationFrame(hoverSyncFrameRef.current);
    hoverSyncFrameRef.current = null;
  }

  function syncHoverStateFromPointer() {
    const root = rootRef.current;
    const hoverTarget = hoverMode === "group" ? root?.closest(".group") : root;
    const shouldShowHover =
      !interactionDisabled &&
      !!tool &&
      hoverTarget instanceof HTMLElement &&
      hoverTarget.matches(":hover");

    setIsHovered(shouldShowHover);
  }

  function scheduleHoverSync() {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;

    clearPendingHoverSync();

    if (!ownerWindow) {
      syncHoverStateFromPointer();
      return;
    }

    hoverSyncFrameRef.current = ownerWindow.requestAnimationFrame(() => {
      hoverSyncFrameRef.current = null;
      syncHoverStateFromPointer();
    });
  }

  function openOverlay() {
    if (effectiveInteractionDisabled || !tool) {
      return;
    }

    setIsHovered(true);
  }

  function closeOverlay(nextTarget: EventTarget | null) {
    if (
      containsTarget(rootRef.current, nextTarget) ||
      containsTarget(overlayRef.current, nextTarget)
    ) {
      return;
    }

    setIsHovered(false);
  }

  function handlePortalOverlayWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (effectiveInteractionDisabled) {
      return;
    }

    event.preventDefault();
    forwardWheelToScrollContainer(
      rootRef.current,
      overlayRef.current,
      event.clientX,
      event.clientY,
      event.deltaX,
      event.deltaY,
    );
  }

  useLayoutEffect(() => {
    if (!isHovered || !tool) {
      return;
    }
  }, [isHovered, tool, text]);

  useLayoutEffect(() => {
    if (!effectiveInteractionDisabled) {
      return;
    }

    clearPendingHoverSync();
    setIsHovered(false);
  }, [effectiveInteractionDisabled]);

  useLayoutEffect(() => {
    return () => {
      clearPendingHoverSync();
    };
  }, []);

  useLayoutEffect(() => {
    if (hoverMode !== "group") {
      return;
    }

    const root = rootRef.current;
    const group = root?.closest(".group");

    if (!(group instanceof HTMLElement)) {
      return;
    }

    const handleEnter = () => {
      if (effectiveInteractionDisabled || !tool) {
        return;
      }

      setIsHovered(true);
    };

    const handleLeave = (event: MouseEvent) => {
      const nextTarget = event.relatedTarget;

      if (
        (nextTarget instanceof Node && !!rootRef.current?.contains(nextTarget)) ||
        (nextTarget instanceof Node && !!overlayRef.current?.contains(nextTarget))
      ) {
        return;
      }

      setIsHovered(false);
    };

    group.addEventListener("mouseenter", handleEnter);
    group.addEventListener("mouseleave", handleLeave);

    return () => {
      group.removeEventListener("mouseenter", handleEnter);
      group.removeEventListener("mouseleave", handleLeave);
    };
  }, [hoverMode, effectiveInteractionDisabled, tool]);

  return (
    <>
      <motion.div
        ref={rootRef}
        layoutId={layoutId}
        onLayoutAnimationStart={() => {
          clearPendingHoverSync();
          setIsLayoutAnimating(true);
          setIsHovered(false);
        }}
        onLayoutAnimationComplete={() => {
          setIsLayoutAnimating(false);
          scheduleHoverSync();
        }}
        onMouseEnter={hoverMode === "self" ? openOverlay : undefined}
        onMouseLeave={
          hoverMode === "self" ? (event) => closeOverlay(event.relatedTarget) : undefined
        }
        className={cn("relative inline-flex w-fit select-none items-center", className)}
      >
        <div className={cn("inline-flex w-fit", resolvedTextClassName)}>{text}</div>
        <AnimatePresence initial={false}>
          {isOverlayVisible &&
            tool &&
            (toolLayer === "portal" ? (
              <ToolLabelPortalOverlay
                anchorRef={rootRef}
                overlayRef={overlayRef}
                onMouseEnter={openOverlay}
                onMouseLeave={(event) => closeOverlay(event.relatedTarget)}
                onWheelCapture={handlePortalOverlayWheel}
                tool={tool}
                toolAnchor={toolAnchor}
              />
            ) : (
              <div
                ref={overlayRef}
                onMouseEnter={openOverlay}
                onMouseLeave={(event) => closeOverlay(event.relatedTarget)}
                className={cn(
                  "absolute inset-y-0 h-full min-w-full",
                  toolAnchor === "right" ? "right-0" : "left-0",
                  TOOL_LABEL_OVERLAY_CLASS_NAME,
                )}
              >
                <ToolLabelOverlayBody tool={tool} />
              </div>
            ))}
        </AnimatePresence>
      </motion.div>
    </>
  );
}
