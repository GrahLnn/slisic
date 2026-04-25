import {
  memo,
  startTransition,
  useCallback,
  useLayoutEffect,
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
const ARC_ITEM_GAP = 78;
const ARC_ITEM_SHIFT_DURATION = 280;
const ARC_VIEWPORT_FALLBACK_HEIGHT = 640;
const ARC_LOOKUP_STEPS = 240;
const ARC_PATH_STEPS = 96;
const arcPathCache = new Map<number, string>();
const arcLookupCache = new Map<number, ArcSample[]>();

export type ArcTrackPushTransitionSource = {
  item: ConfigSidebarItem;
  layoutId: string;
  sourceNode: HTMLDivElement | null;
};

export type ArcTrackPopInsertionRequest = {
  layoutId: string;
  sourceNode: HTMLDivElement | null;
};

export type ArcTrackPopInsertionPlanner = (request: ArcTrackPopInsertionRequest) => void;

type ArcTrackListProps = {
  items: readonly ConfigSidebarItem[];
  onPushItem?: (source: ArcTrackPushTransitionSource) => void;
  onGhostNodeChange?: (layoutId: string, node: HTMLDivElement | null) => void;
  onPopInsertionPlannerChange?: (planner: ArcTrackPopInsertionPlanner | null) => void;
  motionProps?: MotionProps;
  dismissHoverSignal?: number;
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
  layoutId: string;
  node: HTMLLIElement;
  start: number;
  renderedStart: number;
  animationFrame: number | null;
};

type ArcTrackItemNodeRegistry = Map<ArcTrackItemRegistryKey, ArcTrackItemNodeState>;
type ArcTrackDetachedNodeState = Pick<ArcTrackItemNodeState, "start" | "renderedStart">;
type ArcTrackDetachedNodeRegistry = Map<ArcTrackItemRegistryKey, ArcTrackDetachedNodeState>;

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
  snapMountLayoutIdRef: RefObject<string | null>;
  onPushItem?: (source: ArcTrackPushTransitionSource) => void;
  onGhostNodeChange?: (layoutId: string, node: HTMLDivElement | null) => void;
  start: number;
  dismissHoverSignal?: number;
  detachedItemRegistryRef: RefObject<ArcTrackDetachedNodeRegistry>;
};

type ArcTrackPushToolProps = {
  item: ConfigSidebarItem;
  layoutId: string;
  onPushItem?: (source: ArcTrackPushTransitionSource) => void;
  labelNodeRef: RefObject<HTMLDivElement | null>;
};

type ArcTrackLabelHostProps = {
  item: ConfigSidebarItem;
  layoutId: string;
  dismissHoverSignal?: number;
  onPushItem?: (source: ArcTrackPushTransitionSource) => void;
  onGhostNodeChange?: (layoutId: string, node: HTMLDivElement | null) => void;
  labelNodeRef: RefObject<HTMLDivElement | null>;
};

type ArcTrackIndicatorProps = {
  itemKind: ConfigSidebarItem["kind"];
};

type ArcTrackVisibleItemFrame = {
  bottom: number;
  centerY: number;
  layoutId: string;
  top: number;
};

type ArcTrackPendingInsertion = {
  nextLayoutId: string | null;
  previousLayoutId: string | null;
  targetLayoutId: string;
};

type ArcTrackItemMountState = {
  renderedStart: number;
  shouldAnimateToStart: boolean;
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

export function resolveArcTrackVirtualPaddingEnd(args: {
  itemCount: number;
  viewportHeight: number;
}) {
  const bottomPadding = Math.max(args.viewportHeight / 2, 0);

  return args.itemCount > 0 ? Math.max(bottomPadding - ARC_ITEM_GAP, 0) : bottomPadding;
}

export function resolveArcTrackPathClassName(itemCount: number) {
  return itemCount === 0
    ? "stroke-[#b7b7b7]/52 dark:stroke-[#676767]/58"
    : "stroke-[#b7b7b7]/32 dark:stroke-[#676767]/38";
}

export function resolveArcTrackPathStrokeWidth(itemCount: number) {
  return itemCount === 0 ? 1.7 : 1.25;
}

export function resolveArcTrackItemFrame(args: {
  sample: ArcSample | null;
  itemWidth: number;
  itemHeight: number;
}) {
  if (!args.sample) {
    return null;
  }

  return {
    left: args.sample.x - args.itemWidth + 2,
    top: args.sample.y - args.itemHeight / 2,
  };
}

export function resolveArcTrackAnimatedStart(args: {
  fromStart: number;
  targetStart: number;
  progress: number;
}) {
  const clampedProgress = Math.min(Math.max(args.progress, 0), 1);
  const easedProgress = 1 - Math.pow(1 - clampedProgress, 3);

  return args.fromStart + (args.targetStart - args.fromStart) * easedProgress;
}

export function resolveArcTrackVisibleInsertion(args: {
  itemFrames: readonly ArcTrackVisibleItemFrame[];
  sourceCenterY: number;
  viewportBottom: number;
  viewportTop: number;
}) {
  const visibleFrames = args.itemFrames
    .filter((frame) => frame.bottom >= args.viewportTop && frame.top <= args.viewportBottom)
    .sort((left, right) => left.centerY - right.centerY);

  if (visibleFrames.length === 0) {
    return null;
  }

  const nextIndex = visibleFrames.findIndex((frame) => frame.centerY >= args.sourceCenterY);

  if (nextIndex === -1) {
    return {
      nextLayoutId: null,
      previousLayoutId: visibleFrames[visibleFrames.length - 1]?.layoutId ?? null,
    } satisfies Omit<ArcTrackPendingInsertion, "targetLayoutId">;
  }

  if (nextIndex === 0) {
    return {
      nextLayoutId: visibleFrames[0]?.layoutId ?? null,
      previousLayoutId: null,
    } satisfies Omit<ArcTrackPendingInsertion, "targetLayoutId">;
  }

  return {
    nextLayoutId: visibleFrames[nextIndex]?.layoutId ?? null,
    previousLayoutId: visibleFrames[nextIndex - 1]?.layoutId ?? null,
  } satisfies Omit<ArcTrackPendingInsertion, "targetLayoutId">;
}

export function resolveArcTrackDisplayItems(args: {
  items: readonly ConfigSidebarItem[];
  pendingInsertion: ArcTrackPendingInsertion | null;
  previousLayoutOrder: readonly string[];
}) {
  const layoutEntries = args.items.map((item) => {
    const layoutId = createListConfigToolLabelLayoutId({
      kind: item.kind,
      url: item.url,
    });

    return {
      item,
      layoutId,
    };
  });
  const itemByLayoutId = new Map(layoutEntries.map((entry) => [entry.layoutId, entry.item]));
  const orderedLayoutIds = args.previousLayoutOrder.filter((layoutId) =>
    itemByLayoutId.has(layoutId),
  );
  const knownLayoutIds = new Set(orderedLayoutIds);

  for (const entry of layoutEntries) {
    if (knownLayoutIds.has(entry.layoutId)) {
      continue;
    }

    orderedLayoutIds.push(entry.layoutId);
    knownLayoutIds.add(entry.layoutId);
  }

  let didApplyPendingInsertion = false;

  if (args.pendingInsertion && itemByLayoutId.has(args.pendingInsertion.targetLayoutId)) {
    const layoutIdsWithoutTarget = orderedLayoutIds.filter(
      (layoutId) => layoutId !== args.pendingInsertion?.targetLayoutId,
    );
    const previousIndex =
      args.pendingInsertion.previousLayoutId === null
        ? -1
        : layoutIdsWithoutTarget.indexOf(args.pendingInsertion.previousLayoutId);
    const nextIndex =
      args.pendingInsertion.nextLayoutId === null
        ? -1
        : layoutIdsWithoutTarget.indexOf(args.pendingInsertion.nextLayoutId);
    const insertionIndex =
      previousIndex !== -1 && nextIndex !== -1
        ? nextIndex > previousIndex
          ? nextIndex
          : previousIndex + 1
        : nextIndex !== -1
          ? nextIndex
          : previousIndex !== -1
            ? previousIndex + 1
            : layoutIdsWithoutTarget.length;

    layoutIdsWithoutTarget.splice(insertionIndex, 0, args.pendingInsertion.targetLayoutId);
    orderedLayoutIds.splice(0, orderedLayoutIds.length, ...layoutIdsWithoutTarget);
    didApplyPendingInsertion = true;
  }

  return {
    didApplyPendingInsertion,
    items: orderedLayoutIds
      .map((layoutId) => itemByLayoutId.get(layoutId) ?? null)
      .filter((item): item is ConfigSidebarItem => item !== null),
    layoutOrder: orderedLayoutIds,
  };
}

export function resolveArcTrackItemMountState(args: {
  detachedState: ArcTrackDetachedNodeState | null | undefined;
  nextStart: number;
  shouldIgnoreDetachedState: boolean;
}): ArcTrackItemMountState {
  if (!args.detachedState || args.shouldIgnoreDetachedState) {
    return {
      start: args.nextStart,
      renderedStart: args.nextStart,
      shouldAnimateToStart: false,
    };
  }

  return {
    start: args.detachedState.start,
    renderedStart: args.detachedState.renderedStart,
    shouldAnimateToStart:
      args.detachedState.start !== args.nextStart ||
      args.detachedState.renderedStart !== args.nextStart,
  };
}

function resolveArcTrackIndicatorTransform(itemKind: ConfigSidebarItem["kind"]) {
  return itemKind === "collection"
    ? "rotate(calc(var(--arc-item-angle, 0deg) - 6deg))"
    : "rotate(calc(var(--arc-item-angle, 0deg) + 6deg))";
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

function applyArcTrackItemPosition(args: {
  node: HTMLLIElement;
  samples: ArcSample[];
  scrollOffset: number;
  start: number;
}) {
  const sample = getArcSampleAtY(args.start - args.scrollOffset, args.samples);

  const frame = resolveArcTrackItemFrame({
    sample,
    itemWidth: args.node.offsetWidth,
    itemHeight: args.node.offsetHeight,
  });

  if (!sample || !frame) {
    if (args.node.style.opacity !== "0") {
      args.node.style.opacity = "0";
    }

    if (args.node.style.left !== "") {
      args.node.style.left = "";
    }

    if (args.node.style.top !== "") {
      args.node.style.top = "";
    }

    args.node.style.removeProperty("--arc-item-angle");

    return;
  }

  const nextLeft = `${frame.left}px`;
  const nextTop = `${frame.top}px`;

  if (args.node.style.left !== nextLeft) {
    args.node.style.left = nextLeft;
  }

  if (args.node.style.top !== nextTop) {
    args.node.style.top = nextTop;
  }

  if (args.node.style.transform !== "") {
    args.node.style.transform = "";
  }

  args.node.style.setProperty("--arc-item-angle", `${sample.angle}deg`);

  if (args.node.style.opacity !== "1") {
    args.node.style.opacity = "1";
  }
}

function stopArcTrackItemAnimation(state: ArcTrackItemNodeState) {
  if (state.animationFrame === null) {
    return;
  }

  state.node.ownerDocument.defaultView?.cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;
}

function applyArcTrackItemNodeStatePosition(args: {
  state: ArcTrackItemNodeState;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  scrollOffsetRef: RefObject<number>;
}) {
  applyArcTrackItemPosition({
    node: args.state.node,
    samples: buildArcLookup(resolveArcTrackViewportHeight(args.scrollElementRef.current)),
    scrollOffset: args.scrollOffsetRef.current,
    start: args.state.renderedStart,
  });
}

function animateArcTrackItemToStart(args: {
  state: ArcTrackItemNodeState;
  nextStart: number;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  scrollOffsetRef: RefObject<number>;
}) {
  const { state } = args;
  const ownerWindow = state.node.ownerDocument.defaultView;

  stopArcTrackItemAnimation(state);
  state.start = args.nextStart;

  if (!ownerWindow || state.renderedStart === args.nextStart) {
    state.renderedStart = args.nextStart;
    applyArcTrackItemNodeStatePosition(args);
    return;
  }

  const fromStart = state.renderedStart;
  const startTime = ownerWindow.performance.now();

  const animate = (frameTime: number) => {
    if (!state.node.isConnected) {
      state.animationFrame = null;
      return;
    }

    const progress = Math.min(Math.max((frameTime - startTime) / ARC_ITEM_SHIFT_DURATION, 0), 1);
    state.renderedStart = resolveArcTrackAnimatedStart({
      fromStart,
      targetStart: args.nextStart,
      progress,
    });
    applyArcTrackItemNodeStatePosition(args);

    if (progress < 1) {
      state.animationFrame = ownerWindow.requestAnimationFrame(animate);
      return;
    }

    state.animationFrame = null;
    state.renderedStart = args.nextStart;
    applyArcTrackItemNodeStatePosition(args);
  };

  state.animationFrame = ownerWindow.requestAnimationFrame(animate);
}

function updateArcTrackItemPositions(controller: ArcTrackPositionController) {
  const viewportHeight = resolveArcTrackViewportHeight(controller.scrollElementRef.current);
  const samples = buildArcLookup(viewportHeight);

  for (const { node, renderedStart } of controller.itemRegistryRef.current.values()) {
    applyArcTrackItemPosition({
      node,
      samples,
      scrollOffset: controller.scrollOffsetRef.current,
      start: renderedStart,
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
  layoutId: string;
  node: HTMLLIElement | null;
  registryRef: RefObject<ArcTrackItemNodeRegistry>;
  detachedItemRegistryRef: RefObject<ArcTrackDetachedNodeRegistry>;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  scrollOffsetRef: RefObject<number>;
  shouldIgnoreDetachedState: boolean;
  start: number;
}) {
  const registry = args.registryRef.current;
  const detachedRegistry = args.detachedItemRegistryRef.current;
  const existingState = registry.get(args.itemKey);

  if (!args.node) {
    if (existingState) {
      stopArcTrackItemAnimation(existingState);
      detachedRegistry.set(args.itemKey, {
        start: existingState.start,
        renderedStart: existingState.renderedStart,
      });
      registry.delete(args.itemKey);
    }
    return;
  }

  const detachedState = detachedRegistry.get(args.itemKey);
  const mountState = resolveArcTrackItemMountState({
    detachedState,
    nextStart: args.start,
    shouldIgnoreDetachedState: args.shouldIgnoreDetachedState,
  });
  const state =
    existingState ??
    ({
      layoutId: args.layoutId,
      node: args.node,
      start: mountState.start,
      renderedStart: mountState.renderedStart,
      animationFrame: null,
    } satisfies ArcTrackItemNodeState);

  state.layoutId = args.layoutId;
  state.node = args.node;
  registry.set(args.itemKey, state);
  detachedRegistry.delete(args.itemKey);

  if (args.shouldIgnoreDetachedState) {
    stopArcTrackItemAnimation(state);
    state.start = args.start;
    state.renderedStart = args.start;
    applyArcTrackItemNodeStatePosition({
      state,
      scrollElementRef: args.scrollElementRef,
      scrollOffsetRef: args.scrollOffsetRef,
    });
    return;
  }

  const shouldAnimateToStart =
    existingState !== undefined
      ? state.start !== args.start || state.renderedStart !== args.start
      : mountState.shouldAnimateToStart;

  if (shouldAnimateToStart) {
    animateArcTrackItemToStart({
      state,
      nextStart: args.start,
      scrollElementRef: args.scrollElementRef,
      scrollOffsetRef: args.scrollOffsetRef,
    });
    return;
  }

  state.start = args.start;
  state.renderedStart = args.start;
  applyArcTrackItemNodeStatePosition({
    state,
    scrollElementRef: args.scrollElementRef,
    scrollOffsetRef: args.scrollOffsetRef,
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
    for (const state of args.controller.itemRegistryRef.current.values()) {
      stopArcTrackItemAnimation(state);
    }
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

function ArcTrackPushTool({ item, layoutId, onPushItem, labelNodeRef }: ArcTrackPushToolProps) {
  return (
    <div className="flex w-full items-center justify-between">
      <div />
      <div className="flex h-fit">
        <MaskL />
        <CoverTool
          text="Push"
          onClick={() => {
            startTransition(() => {
              onPushItem?.({
                item,
                layoutId,
                sourceNode: labelNodeRef.current,
              });
            });
          }}
        />
      </div>
    </div>
  );
}

function ArcTrackLabelHost({
  item,
  layoutId,
  dismissHoverSignal,
  onPushItem,
  onGhostNodeChange,
  labelNodeRef,
}: ArcTrackLabelHostProps) {
  const handleLabelNodeChange = useCallback(
    (node: HTMLDivElement | null) => {
      labelNodeRef.current = node;
      onGhostNodeChange?.(layoutId, node);
    },
    [layoutId, onGhostNodeChange, labelNodeRef],
  );

  return (
    <div
      ref={handleLabelNodeChange}
      className="inline-flex w-fit origin-right will-change-transform"
      style={{ transform: "rotate(var(--arc-item-angle, 0deg))" }}
    >
      <ToolLabel
        dismissHoverSignal={dismissHoverSignal}
        textRenderMode="plain"
        textClassName="text-[12px] text-[#404040] dark:text-[#a3a3a3]"
        toolAnchor="right"
        text={item.name}
        tool={
          <ArcTrackPushTool
            item={item}
            layoutId={layoutId}
            onPushItem={onPushItem}
            labelNodeRef={labelNodeRef}
          />
        }
      />
    </div>
  );
}

function ArcTrackIndicator({ itemKind }: ArcTrackIndicatorProps) {
  return (
    <div
      className="flex items-center origin-left will-change-transform"
      style={{ transform: resolveArcTrackIndicatorTransform(itemKind) }}
    >
      <span className="size-1 rounded-full bg-[#4f4f4f]/70 dark:bg-[#bdbdbd]/70" />
    </div>
  );
}

const ArcTrackItem = memo(function ArcTrackItem({
  item,
  itemKey,
  itemRegistryRef,
  scrollElementRef,
  scrollOffsetRef,
  snapMountLayoutIdRef,
  onPushItem,
  onGhostNodeChange,
  start,
  dismissHoverSignal,
  detachedItemRegistryRef,
}: ArcTrackItemProps) {
  const labelNodeRef = useRef<HTMLDivElement | null>(null);
  const layoutId = createListConfigToolLabelLayoutId({
    kind: item.kind,
    url: item.url,
  });

  return (
    <li
      ref={(node) => {
        const shouldIgnoreDetachedState = snapMountLayoutIdRef.current === layoutId;

        registerArcTrackItemNode({
          itemKey,
          layoutId,
          node,
          registryRef: itemRegistryRef,
          detachedItemRegistryRef,
          scrollElementRef,
          scrollOffsetRef,
          shouldIgnoreDetachedState,
          start,
        });

        if (node && shouldIgnoreDetachedState) {
          snapMountLayoutIdRef.current = null;
        }
      }}
      className="pointer-events-auto absolute whitespace-nowrap opacity-0"
    >
      <div className="flex items-center justify-end gap-3">
        <ArcTrackLabelHost
          item={item}
          layoutId={layoutId}
          dismissHoverSignal={dismissHoverSignal}
          onPushItem={onPushItem}
          onGhostNodeChange={onGhostNodeChange}
          labelNodeRef={labelNodeRef}
        />
        <ArcTrackIndicator itemKind={item.kind} />
      </div>
    </li>
  );
});

function ArcTrackListBody({
  items,
  onPushItem,
  onGhostNodeChange,
  onPopInsertionPlannerChange,
  dismissHoverSignal,
}: Pick<
  ArcTrackListProps,
  | "items"
  | "onPushItem"
  | "onGhostNodeChange"
  | "onPopInsertionPlannerChange"
  | "dismissHoverSignal"
>) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const itemRegistryRef = useRef<ArcTrackItemNodeRegistry>(new Map());
  const detachedItemRegistryRef = useRef<ArcTrackDetachedNodeRegistry>(new Map());
  const positionFrameRef = useRef<number | null>(null);
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const scrollOffsetRef = useRef(0);
  const pendingInsertionRef = useRef<ArcTrackPendingInsertion | null>(null);
  const displayOrderRef = useRef<string[]>([]);
  const snapMountLayoutIdRef = useRef<string | null>(null);
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

  const preparePopInsertion = useCallback<ArcTrackPopInsertionPlanner>(
    ({ layoutId, sourceNode }) => {
      snapMountLayoutIdRef.current = layoutId;
      const scrollElement = scrollElementRef.current;
      const sourceRect = sourceNode?.getBoundingClientRect();

      if (!scrollElement || !sourceRect) {
        pendingInsertionRef.current = null;
        return;
      }

      const viewportRect = scrollElement.getBoundingClientRect();
      const insertion = resolveArcTrackVisibleInsertion({
        itemFrames: Array.from(itemRegistryRef.current.values()).map((state) => {
          const rect = state.node.getBoundingClientRect();

          return {
            bottom: rect.bottom,
            centerY: rect.top + rect.height / 2,
            layoutId: state.layoutId,
            top: rect.top,
          } satisfies ArcTrackVisibleItemFrame;
        }),
        sourceCenterY: sourceRect.top + sourceRect.height / 2,
        viewportBottom: viewportRect.bottom,
        viewportTop: viewportRect.top,
      });

      pendingInsertionRef.current = insertion
        ? {
            ...insertion,
            targetLayoutId: layoutId,
          }
        : null;
    },
    [],
  );

  useLayoutEffect(() => {
    onPopInsertionPlannerChange?.(preparePopInsertion);

    return () => {
      onPopInsertionPlannerChange?.(null);
    };
  }, [onPopInsertionPlannerChange, preparePopInsertion]);

  const arcViewportHeight = resolveArcTrackViewportHeight(scrollElement);
  const virtualPaddingEnd = resolveArcTrackVirtualPaddingEnd({
    itemCount: items.length,
    viewportHeight: arcViewportHeight,
  });
  const arcPathClassName = resolveArcTrackPathClassName(items.length);
  const arcPathStrokeWidth = resolveArcTrackPathStrokeWidth(items.length);
  const displayResolution = resolveArcTrackDisplayItems({
    items,
    pendingInsertion: pendingInsertionRef.current,
    previousLayoutOrder: displayOrderRef.current,
  });
  const displayItems = displayResolution.items;

  displayOrderRef.current = displayResolution.layoutOrder;
  if (displayResolution.didApplyPendingInsertion) {
    pendingInsertionRef.current = null;
  }
  const estimateSize = useCallback(() => ARC_ITEM_GAP, []);
  const getItemKey = useCallback(
    (index: number) => displayItems[index]?.url ?? index,
    [displayItems],
  );

  // Virtualization only controls which nodes are mounted.
  // Per-frame arc projection is driven by the native scroll event instead of
  // virtualizer state so the curve layer stays in lockstep with scrollTop.
  const rowVirtualizer = useVirtualizer({
    count: displayItems.length,
    estimateSize,
    getItemKey,
    getScrollElement: () => scrollElement,
    overscan: 12,
    paddingStart: ARC_LEADING_PADDING,
    paddingEnd: virtualPaddingEnd,
    useAnimationFrameWithResizeObserver: false,
  });

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
        className="absolute inset-y-0 right-0 z-0 w-screen overflow-y-auto overscroll-y-contain hide-scrollbar [overflow-anchor:none]"
      >
        <div className="relative" style={{ height: `${arcTrackHeight}px` }}>
          <div
            className="pointer-events-none sticky top-0 ml-auto h-screen overflow-visible"
            style={{ width: `${ARC_VIEWBOX_WIDTH}px` }}
          >
            <ul className="absolute inset-0 z-10 m-0 list-none p-0">
              {virtualItems.map((virtualItem) => {
                const item = displayItems[virtualItem.index];

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
                    snapMountLayoutIdRef={snapMountLayoutIdRef}
                    onPushItem={onPushItem}
                    onGhostNodeChange={onGhostNodeChange}
                    start={virtualItem.start}
                    dismissHoverSignal={dismissHoverSignal}
                    detachedItemRegistryRef={detachedItemRegistryRef}
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

export function ArcTrackList({
  items,
  motionProps,
  onPushItem,
  onGhostNodeChange,
  onPopInsertionPlannerChange,
  dismissHoverSignal,
}: ArcTrackListProps) {
  return (
    <motion.div
      layoutRoot
      {...motionProps}
      className="fixed inset-y-0 right-0 z-0 hidden min-[1180px]:block"
    >
      <ArcTrackListBody
        items={items}
        onPushItem={onPushItem}
        onGhostNodeChange={onGhostNodeChange}
        onPopInsertionPlannerChange={onPopInsertionPlannerChange}
        dismissHoverSignal={dismissHoverSignal}
      />
    </motion.div>
  );
}
