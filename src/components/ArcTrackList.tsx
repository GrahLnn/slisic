import {
  memo,
  startTransition,
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion, type MotionProps } from "motion/react";
import type { ConfigSidebarItem } from "@/src/flow/appLogic/core";
import { createListConfigToolLabelLayoutId } from "./ListConfig.view-model";
import { ToolLabel, MaskL } from "./toollabel";
import { CoverTool } from "./coverTool";

const ARC_VIEWBOX_WIDTH = 288;
const ARC_LEADING_PADDING = 220;
const ARC_TRAILING_PADDING = 112;
const ARC_ITEM_GAP = 78;
const ARC_VIEWPORT_FALLBACK_HEIGHT = 640;
const ARC_LOOKUP_STEPS = 240;
const ARC_PATH_STEPS = 96;
const arcPathCache = new Map<number, string>();
const arcLookupCache = new Map<number, ArcSample[]>();

type ArcTrackListProps = {
  items: readonly ConfigSidebarItem[];
  onPushItem?: (item: ConfigSidebarItem) => void;
  motionProps?: MotionProps;
};

type ArcSample = {
  x: number;
  y: number;
};

type ArcProjection = ArcSample & {
  angle: number;
};

type ArcTrackItemRegistryKey = string | number | bigint;

type ArcTrackItemNodeState = {
  node: HTMLLIElement;
  start: number;
};

type ArcTrackItemNodeRegistry = Map<ArcTrackItemRegistryKey, ArcTrackItemNodeState>;

type ArcTrackPositionController = {
  itemRegistryRef: RefObject<ArcTrackItemNodeRegistry>;
  positionFrameRef: RefObject<number | null>;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  scrollOffsetRef: RefObject<number>;
};

type ArcTrackScrollOwnerCleanupRef = RefObject<(() => void) | null>;

type ArcTrackItemProps = {
  item: ConfigSidebarItem;
  itemKey: ArcTrackItemRegistryKey;
  itemRegistryRef: RefObject<ArcTrackItemNodeRegistry>;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  scrollOffsetRef: RefObject<number>;
  onPushItem?: (item: ConfigSidebarItem) => void;
  start: number;
};

export function resolveArcTrackViewportScrollTop(args: {
  currentScrollTop: number;
  trackHeight: number;
  viewportHeight: number;
}) {
  const maxScrollTop = Math.max(args.trackHeight - args.viewportHeight, 0);

  return Math.min(Math.max(args.currentScrollTop, 0), maxScrollTop);
}

export function createArcTrackListIdentity(items: readonly ConfigSidebarItem[]) {
  return JSON.stringify(
    items.map((item) => ({
      kind: item.kind,
      url: item.url,
      name: item.name,
      folder: item.folder,
    })),
  );
}

export function resolveArcTrackVirtualPaddingEnd(itemCount: number) {
  return itemCount > 0 ? Math.max(ARC_TRAILING_PADDING - ARC_ITEM_GAP, 0) : ARC_TRAILING_PADDING;
}

export function resolveArcTrackPathClassName(itemCount: number) {
  return itemCount === 0
    ? "stroke-[#b7b7b7]/52 dark:stroke-[#676767]/58"
    : "stroke-[#b7b7b7]/32 dark:stroke-[#676767]/38";
}

export function resolveArcTrackPathStrokeWidth(itemCount: number) {
  return itemCount === 0 ? 1.7 : 1.25;
}

function resolveArcTrackViewportHeight(scrollElement: HTMLDivElement | null) {
  return scrollElement?.clientHeight ?? ARC_VIEWPORT_FALLBACK_HEIGHT;
}

function getArcGeometry(viewportHeight: number) {
  const topInset = 0;
  const bottomInset = 0;
  const drawableHeight = Math.max(1, viewportHeight - topInset - bottomInset);

  return {
    topInset,
    bottomInset,
    drawableHeight,
    topX: 244,
    bottomX: 150,
    circleRadius: Math.max(drawableHeight * 2.1, 2600),
  };
}

function createArcCurveSamples(viewportHeight: number, steps: number) {
  const { topInset, drawableHeight, topX, bottomX, circleRadius } = getArcGeometry(viewportHeight);
  const start = { x: topX, y: topInset };
  const end = { x: bottomX, y: topInset + drawableHeight };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  const safeRadius = Math.max(circleRadius, chord / 2 + 1);
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const perpX = dy / chord;
  const perpY = -dx / chord;
  const offset = Math.sqrt(Math.max(0, safeRadius * safeRadius - (chord * chord) / 4));
  const centerX = midX + perpX * offset;
  const centerY = midY + perpY * offset;
  const startAngle = Math.atan2(start.y - centerY, start.x - centerX);
  const endAngle = Math.atan2(end.y - centerY, end.x - centerX);
  const deltaAngle = Math.atan2(Math.sin(endAngle - startAngle), Math.cos(endAngle - startAngle));

  return Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;
    const angle = startAngle + deltaAngle * progress;
    const x = centerX + safeRadius * Math.cos(angle);
    const y = centerY + safeRadius * Math.sin(angle);

    return { x, y };
  });
}

function getArcPath(viewportHeight: number) {
  const cachedPath = arcPathCache.get(viewportHeight);

  if (cachedPath) {
    return cachedPath;
  }

  const path = createArcCurveSamples(viewportHeight, ARC_PATH_STEPS)
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join("");

  arcPathCache.set(viewportHeight, path);

  return path;
}

function buildArcLookup(viewportHeight: number) {
  const cachedLookup = arcLookupCache.get(viewportHeight);

  if (cachedLookup) {
    return cachedLookup;
  }

  const lookup = createArcCurveSamples(viewportHeight, ARC_LOOKUP_STEPS);

  arcLookupCache.set(viewportHeight, lookup);

  return lookup;
}

function getArcSampleAtY(targetY: number, samples: ArcSample[]): ArcProjection | null {
  if (samples.length < 2) {
    return null;
  }

  if (targetY <= samples[0].y) {
    const current = samples[0];
    const next = samples[1];
    const dy = next.y - current.y;
    const dx = next.x - current.x;
    const slope = dx / Math.max(1e-6, dy);

    return {
      x: current.x + slope * (targetY - current.y),
      y: targetY,
      angle: (Math.atan2(next.x - current.x, next.y - current.y) * 180) / Math.PI,
    };
  }

  const lastIndex = samples.length - 1;

  if (targetY >= samples[lastIndex].y) {
    const previous = samples[lastIndex - 1];
    const current = samples[lastIndex];
    const dy = current.y - previous.y;
    const dx = current.x - previous.x;
    const slope = dx / Math.max(1e-6, dy);

    return {
      x: current.x + slope * (targetY - current.y),
      y: targetY,
      angle: (Math.atan2(current.x - previous.x, current.y - previous.y) * 180) / Math.PI,
    };
  }

  let low = 0;
  let high = lastIndex;

  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);

    if (samples[mid].y < targetY) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const start = samples[low];
  const end = samples[high];
  const ratio = (targetY - start.y) / Math.max(1e-6, end.y - start.y);
  const x = start.x + (end.x - start.x) * ratio;
  const y = start.y + (end.y - start.y) * ratio;
  const angle = (Math.atan2(end.x - start.x, end.y - start.y) * 180) / Math.PI;

  return { x, y, angle };
}

function createArcTrackItemTransform(sample: ArcProjection) {
  return (
    `translate3d(${sample.x}px, ${sample.y}px, 0) ` +
    `translate3d(calc(-100% + 2px), -50%, 0) rotate(${sample.angle}deg)`
  );
}

function applyArcTrackItemPosition(args: {
  node: HTMLLIElement;
  samples: ArcSample[];
  scrollOffset: number;
  start: number;
}) {
  const sample = getArcSampleAtY(args.start - args.scrollOffset, args.samples);

  if (!sample) {
    if (args.node.style.opacity !== "0") {
      args.node.style.opacity = "0";
    }
    return;
  }

  const transform = createArcTrackItemTransform(sample);

  if (args.node.style.transform !== transform) {
    args.node.style.transform = transform;
  }

  if (args.node.style.opacity !== "1") {
    args.node.style.opacity = "1";
  }
}

function updateArcTrackItemPositions(controller: ArcTrackPositionController) {
  const viewportHeight = resolveArcTrackViewportHeight(controller.scrollElementRef.current);
  const samples = buildArcLookup(viewportHeight);

  for (const { node, start } of controller.itemRegistryRef.current.values()) {
    applyArcTrackItemPosition({
      node,
      samples,
      scrollOffset: controller.scrollOffsetRef.current,
      start,
    });
  }
}

function scheduleArcTrackItemPositionUpdate(controller: ArcTrackPositionController) {
  const scrollElement = controller.scrollElementRef.current;
  const targetWindow = scrollElement?.ownerDocument.defaultView;

  if (!targetWindow) {
    updateArcTrackItemPositions(controller);
    return;
  }

  if (controller.positionFrameRef.current !== null) {
    return;
  }

  controller.positionFrameRef.current = targetWindow.requestAnimationFrame(() => {
    controller.positionFrameRef.current = null;
    updateArcTrackItemPositions(controller);
  });
}

function registerArcTrackItemNode(args: {
  itemKey: ArcTrackItemRegistryKey;
  node: HTMLLIElement | null;
  registryRef: RefObject<ArcTrackItemNodeRegistry>;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  scrollOffsetRef: RefObject<number>;
  start: number;
}) {
  const registry = args.registryRef.current;

  if (!args.node) {
    registry.delete(args.itemKey);
    return;
  }

  registry.set(args.itemKey, { node: args.node, start: args.start });
  applyArcTrackItemPosition({
    node: args.node,
    samples: buildArcLookup(resolveArcTrackViewportHeight(args.scrollElementRef.current)),
    scrollOffset: args.scrollOffsetRef.current,
    start: args.start,
  });
}

function syncArcTrackScrollElement(args: {
  controller: ArcTrackPositionController;
  node: HTMLDivElement | null;
  setScrollElement: Dispatch<SetStateAction<HTMLDivElement | null>>;
  cleanupRef: ArcTrackScrollOwnerCleanupRef;
}) {
  args.cleanupRef.current?.();
  args.cleanupRef.current = null;

  const previousElement = args.controller.scrollElementRef.current;
  const pendingFrame = args.controller.positionFrameRef.current;

  if (previousElement && pendingFrame !== null) {
    previousElement.ownerDocument.defaultView?.cancelAnimationFrame(pendingFrame);
    args.controller.positionFrameRef.current = null;
  }

  args.controller.scrollElementRef.current = args.node;
  args.controller.scrollOffsetRef.current = args.node?.scrollTop ?? 0;
  args.setScrollElement(args.node);

  if (!args.node) {
    args.controller.itemRegistryRef.current.clear();
    return;
  }

  const scrollElement = args.node;
  const syncPositions = () => {
    args.controller.scrollOffsetRef.current = scrollElement.scrollTop;
    scheduleArcTrackItemPositionUpdate(args.controller);
  };
  const handleScroll = () => {
    syncPositions();
  };
  const ResizeObserverCtor = scrollElement.ownerDocument.defaultView?.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(() => {
        syncPositions();
      })
    : null;

  scrollElement.addEventListener("scroll", handleScroll, { passive: true });
  resizeObserver?.observe(scrollElement);
  syncPositions();

  // The scroll viewport is the explicit owner of native subscriptions so the
  // sync lifecycle follows the node mount/unmount boundary instead of an
  // unrelated effect pass.
  args.cleanupRef.current = () => {
    scrollElement.removeEventListener("scroll", handleScroll);
    resizeObserver?.disconnect();
  };
}

const ArcTrackItem = memo(function ArcTrackItem({
  item,
  itemKey,
  itemRegistryRef,
  scrollElementRef,
  scrollOffsetRef,
  onPushItem,
  start,
}: ArcTrackItemProps) {
  return (
    <li
      ref={(node) => {
        registerArcTrackItemNode({
          itemKey,
          node,
          registryRef: itemRegistryRef,
          scrollElementRef,
          scrollOffsetRef,
          start,
        });
      }}
      className="pointer-events-auto absolute top-0 left-0 origin-right whitespace-nowrap opacity-0 will-change-transform"
    >
      <div className="flex items-center justify-end gap-3">
        <ToolLabel
          layoutId={createListConfigToolLabelLayoutId({
            kind: item.kind,
            url: item.url,
          })}
          textClassName="text-[12px] text-[#404040] dark:text-[#a3a3a3]"
          toolAnchor="right"
          text={item.name}
          tool={
            <div className="flex w-full items-center justify-between">
              <div />
              <div className="flex h-fit">
                <MaskL />
                <CoverTool
                  text="Push"
                  onClick={() => {
                    startTransition(() => {
                      onPushItem?.(item);
                    });
                  }}
                />
              </div>
            </div>
          }
        />
        <span className="size-1 rounded-full bg-[#4f4f4f]/70 dark:bg-[#bdbdbd]/70" />
      </div>
    </li>
  );
});

function ArcTrackListBody({ items, onPushItem }: Pick<ArcTrackListProps, "items" | "onPushItem">) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const itemRegistryRef = useRef<ArcTrackItemNodeRegistry>(new Map());
  const positionFrameRef = useRef<number | null>(null);
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const scrollOffsetRef = useRef(0);
  const positionControllerRef = useRef<ArcTrackPositionController>({
    itemRegistryRef,
    positionFrameRef,
    scrollElementRef,
    scrollOffsetRef,
  });
  const scrollOwnerCleanupRef = useRef<(() => void) | null>(null);
  const scrollElementCallbackRef = useRef<((node: HTMLDivElement | null) => void) | null>(null);

  if (scrollElementCallbackRef.current === null) {
    scrollElementCallbackRef.current = (node) => {
      syncArcTrackScrollElement({
        controller: positionControllerRef.current,
        node,
        setScrollElement,
        cleanupRef: scrollOwnerCleanupRef,
      });
    };
  }

  const virtualPaddingEnd = resolveArcTrackVirtualPaddingEnd(items.length);
  const arcPathClassName = resolveArcTrackPathClassName(items.length);
  const arcPathStrokeWidth = resolveArcTrackPathStrokeWidth(items.length);
  const estimateSize = useCallback(() => ARC_ITEM_GAP, []);
  const getItemKey = useCallback((index: number) => items[index]?.url ?? index, [items]);

  // Virtualization only controls which nodes are mounted.
  // Per-frame arc projection is driven by the native scroll event instead of
  // virtualizer state so the curve layer stays in lockstep with scrollTop.
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    estimateSize,
    getItemKey,
    getScrollElement: () => scrollElement,
    overscan: 12,
    paddingStart: ARC_LEADING_PADDING,
    paddingEnd: virtualPaddingEnd,
    useAnimationFrameWithResizeObserver: false,
  });

  const arcViewportHeight =
    rowVirtualizer.scrollRect?.height ?? resolveArcTrackViewportHeight(scrollElement);
  const arcPath = getArcPath(arcViewportHeight);
  const arcTrackHeight = rowVirtualizer.getTotalSize();
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="relative h-screen w-72">
      <svg
        className="pointer-events-none absolute inset-0 z-0 overflow-visible"
        viewBox={`0 0 ${ARC_VIEWBOX_WIDTH} ${arcViewportHeight}`}
        fill="none"
        aria-hidden="true"
      >
        <path
          d={arcPath}
          className={arcPathClassName}
          strokeWidth={arcPathStrokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <motion.div
        layoutScroll
        ref={scrollElementCallbackRef.current}
        className="pointer-events-auto absolute inset-y-0 right-0 z-0 w-screen overflow-y-auto overscroll-y-contain hide-scrollbar [overflow-anchor:none]"
      >
        <div className="relative" style={{ height: `${arcTrackHeight}px` }}>
          <div
            className="pointer-events-none sticky top-0 ml-auto h-screen overflow-visible"
            style={{ width: `${ARC_VIEWBOX_WIDTH}px` }}
          >
            <ul className="absolute inset-0 z-10 m-0 list-none p-0">
              {virtualItems.map((virtualItem) => {
                const item = items[virtualItem.index];

                if (!item) {
                  return null;
                }

                return (
                  <ArcTrackItem
                    key={virtualItem.key}
                    item={item}
                    itemKey={virtualItem.key}
                    itemRegistryRef={itemRegistryRef}
                    scrollElementRef={scrollElementRef}
                    scrollOffsetRef={scrollOffsetRef}
                    onPushItem={onPushItem}
                    start={virtualItem.start}
                  />
                );
              })}
            </ul>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export function ArcTrackList({ items, motionProps, onPushItem }: ArcTrackListProps) {
  return (
    <motion.div
      layoutRoot
      {...motionProps}
      className="fixed inset-y-0 right-0 z-0 hidden min-[1180px]:block"
    >
      <ArcTrackListBody items={items} onPushItem={onPushItem} />
    </motion.div>
  );
}
