import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import { Torph } from "@grahlnn/comps";

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
const TOOL_LABEL_PLAIN_TEXT_CLASS_NAME = "inline-block leading-[18px]";
type ToolLabelAnchor = "left" | "right";
type ToolLabelTextRenderMode = "torph" | "plain";
type ToolLabelPointerPosition = {
  clientX: number;
  clientY: number;
};

type ToolLabelPointerTracker = {
  position: ToolLabelPointerPosition | null;
  refCount: number;
  updatePosition: (event: PointerEvent) => void;
  clearPosition: () => void;
};

const toolLabelPointerTrackers = new WeakMap<Document, ToolLabelPointerTracker>();

export function resolveToolLabelPlainTextClassName() {
  return TOOL_LABEL_PLAIN_TEXT_CLASS_NAME;
}

function retainToolLabelPointerTracker(ownerDocument: Document) {
  let tracker = toolLabelPointerTrackers.get(ownerDocument);

  if (!tracker) {
    tracker = {
      position: null,
      refCount: 0,
      updatePosition: (event) => {
        tracker!.position = {
          clientX: event.clientX,
          clientY: event.clientY,
        };
      },
      clearPosition: () => {
        tracker!.position = null;
      },
    };
    toolLabelPointerTrackers.set(ownerDocument, tracker);
    ownerDocument.addEventListener("pointerdown", tracker.updatePosition, {
      passive: true,
    });
    ownerDocument.addEventListener("pointermove", tracker.updatePosition, {
      passive: true,
    });
    ownerDocument.addEventListener("pointerleave", tracker.clearPosition, {
      passive: true,
    });
    ownerDocument.defaultView?.addEventListener("blur", tracker.clearPosition);
  }

  tracker.refCount += 1;

  return () => {
    const currentTracker = toolLabelPointerTrackers.get(ownerDocument);

    if (!currentTracker) {
      return;
    }

    currentTracker.refCount -= 1;

    if (currentTracker.refCount > 0) {
      return;
    }

    ownerDocument.removeEventListener("pointerdown", currentTracker.updatePosition);
    ownerDocument.removeEventListener("pointermove", currentTracker.updatePosition);
    ownerDocument.removeEventListener("pointerleave", currentTracker.clearPosition);
    ownerDocument.defaultView?.removeEventListener("blur", currentTracker.clearPosition);
    toolLabelPointerTrackers.delete(ownerDocument);
  };
}

function readToolLabelPointerPosition(ownerDocument: Document | null) {
  return ownerDocument ? (toolLabelPointerTrackers.get(ownerDocument)?.position ?? null) : null;
}

function ToolLabelTextSurface({
  text,
  textRenderMode,
}: {
  text: string;
  textRenderMode: ToolLabelTextRenderMode;
}) {
  if (textRenderMode === "plain") {
    return (
      <span
        data-tool-label-debug-role="text-surface"
        className={resolveToolLabelPlainTextClassName()}
      >
        {text}
      </span>
    );
  }

  return <Torph text={text} />;
}

export function resolveToolLabelOverlayVisibility(args: {
  isHovered: boolean;
  hasTool: boolean;
  interactionDisabled: boolean;
}) {
  return args.isHovered && args.hasTool && !args.interactionDisabled;
}

function isPointInsideRect(point: ToolLabelPointerPosition, rect: DOMRect | DOMRectReadOnly) {
  return (
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top &&
    point.clientY <= rect.bottom
  );
}

/**
 * Layout changes can move a label underneath a stationary pointer without
 * producing another enter event. Re-probe against geometry instead of relying
 * on `:hover`, otherwise overlays stay stale until the mouse moves again.
 */
export function resolveToolLabelHoverFromPointerProbe(args: {
  interactionDisabled: boolean;
  hasTool: boolean;
  pointerPosition: ToolLabelPointerPosition | null;
  hoverTarget: HTMLElement | null;
  overlay: HTMLElement | null;
}) {
  if (args.interactionDisabled || !args.hasTool || !args.pointerPosition || !args.hoverTarget) {
    return false;
  }

  const hoverTarget = args.hoverTarget;
  const overlay = args.overlay;
  const { clientX, clientY } = args.pointerPosition;
  const hitElements = hoverTarget.ownerDocument.elementsFromPoint(clientX, clientY);

  if (overlay && hitElements.some((element) => element === overlay || overlay.contains(element))) {
    return true;
  }

  if (hitElements.some((element) => element === hoverTarget || hoverTarget.contains(element))) {
    return true;
  }

  return isPointInsideRect(args.pointerPosition, hoverTarget.getBoundingClientRect());
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
  const trackingFrameRef = useRef<number | null>(null);

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

    const trackAnchorRect = () => {
      syncRect();
      trackingFrameRef.current = ownerWindow.requestAnimationFrame(trackAnchorRect);
    };

    // Portal overlays render outside the anchor tree, so layout-driven motion
    // does not emit a local resize/scroll signal. Keep a lightweight frame loop
    // while the overlay is mounted so the portal can stay locked to the moving label.
    trackingFrameRef.current = ownerWindow.requestAnimationFrame(trackAnchorRect);

    return () => {
      if (trackingFrameRef.current !== null) {
        ownerWindow.cancelAnimationFrame(trackingFrameRef.current);
        trackingFrameRef.current = null;
      }
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
      data-tool-label-overlay="true"
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
  dismissHoverSignal,
  onRootNodeChange,
  restClassName,
  restStyle,
  layoutId,
  hoverMode = "self",
  interactionDisabled = false,
  toolLayer = "inline",
  toolAnchor = "left",
  textRenderMode = "torph",
}: {
  text: string;
  textClassName?: string;
  tool?: React.ReactNode;
  layoutId?: string;
  dismissHoverSignal?: number | string | null;
  onRootNodeChange?: (node: HTMLDivElement | null) => void;
  restClassName?: string;
  restStyle?: CSSProperties;
  hoverMode?: "self" | "group";
  interactionDisabled?: boolean;
  toolLayer?: "inline" | "portal";
  toolAnchor?: ToolLabelAnchor;
  textRenderMode?: ToolLabelTextRenderMode;
} & ComponentProps<"div">) {
  const [isHovered, setIsHovered] = useState(false);
  const [isLayoutAnimating, setIsLayoutAnimating] = useState(false);
  const resolvedTextClassName = textClassName ?? "";
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hoverSyncFrameRef = useRef<number | null>(null);
  const hasTool = Boolean(tool);
  const effectiveInteractionDisabled = interactionDisabled || isLayoutAnimating;
  const previousEffectiveInteractionDisabledRef = useRef(effectiveInteractionDisabled);
  const isOverlayVisible = resolveToolLabelOverlayVisibility({
    isHovered,
    hasTool,
    interactionDisabled: effectiveInteractionDisabled,
  });

  function containsTarget(container: HTMLElement | null, target: EventTarget | null) {
    return target instanceof Node && !!container?.contains(target);
  }

  const clearPendingHoverSync = useCallback(() => {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;

    if (!ownerWindow || hoverSyncFrameRef.current === null) {
      hoverSyncFrameRef.current = null;
      return;
    }

    ownerWindow.cancelAnimationFrame(hoverSyncFrameRef.current);
    hoverSyncFrameRef.current = null;
  }, []);

  const syncHoverStateFromPointer = useCallback(() => {
    const root = rootRef.current;
    const hoverTarget = hoverMode === "group" ? root?.closest(".group") : root;
    const shouldShowHover =
      hoverTarget instanceof HTMLElement &&
      resolveToolLabelHoverFromPointerProbe({
        interactionDisabled: effectiveInteractionDisabled,
        hasTool,
        pointerPosition: readToolLabelPointerPosition(root?.ownerDocument ?? null),
        hoverTarget,
        overlay: overlayRef.current,
      });

    setIsHovered(shouldShowHover);
  }, [effectiveInteractionDisabled, hasTool, hoverMode]);

  const scheduleHoverSync = useCallback(() => {
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
  }, [clearPendingHoverSync, syncHoverStateFromPointer]);

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
    if (effectiveInteractionDisabled) {
      clearPendingHoverSync();
      setIsHovered(false);
    }
  }, [clearPendingHoverSync, effectiveInteractionDisabled]);

  useLayoutEffect(() => {
    if (!hasTool) {
      clearPendingHoverSync();
      setIsHovered(false);
      return;
    }

    scheduleHoverSync();
  }, [clearPendingHoverSync, hasTool, scheduleHoverSync, text]);

  useLayoutEffect(() => {
    const wasInteractionDisabled = previousEffectiveInteractionDisabledRef.current;

    previousEffectiveInteractionDisabledRef.current = effectiveInteractionDisabled;

    if (wasInteractionDisabled && !effectiveInteractionDisabled) {
      scheduleHoverSync();
    }
  }, [effectiveInteractionDisabled, scheduleHoverSync]);

  useLayoutEffect(() => {
    if (dismissHoverSignal == null) {
      return;
    }

    clearPendingHoverSync();
    setIsHovered(false);
  }, [clearPendingHoverSync, dismissHoverSignal]);

  useLayoutEffect(() => {
    return () => {
      clearPendingHoverSync();
    };
  }, [clearPendingHoverSync]);

  useLayoutEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument;

    if (!ownerDocument) {
      return;
    }

    return retainToolLabelPointerTracker(ownerDocument);
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
      <div
        ref={(node) => {
          rootRef.current = node;
          onRootNodeChange?.(node);
        }}
        onMouseEnter={hoverMode === "self" ? openOverlay : undefined}
        onMouseLeave={
          hoverMode === "self" ? (event) => closeOverlay(event.relatedTarget) : undefined
        }
        className={cn(
          "relative inline-flex w-fit select-none items-center",
          className,
          !isLayoutAnimating && restClassName,
        )}
        style={!isLayoutAnimating ? restStyle : undefined}
      >
        <motion.div
          ref={textRef}
          layoutId={layoutId}
          data-tool-label-debug-role="text-container"
          data-tool-label-debug-layout-animating={isLayoutAnimating ? "true" : "false"}
          data-tool-label-debug-text-render-mode={textRenderMode}
          data-tool-label-debug-layout-id={layoutId}
          onLayoutAnimationStart={() => {
            clearPendingHoverSync();
            setIsLayoutAnimating(true);
            setIsHovered(false);
          }}
          onLayoutAnimationComplete={() => {
            setIsLayoutAnimating(false);
          }}
          className={cn("inline-flex w-fit", resolvedTextClassName)}
        >
          <ToolLabelTextSurface text={text} textRenderMode={textRenderMode} />
        </motion.div>
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
                data-tool-label-overlay="true"
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
      </div>
    </>
  );
}
