import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { measureNaturalWidth, prepareWithSegments, type PrepareOptions } from "@chenglou/pretext";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion, useAnimate, type HTMLMotionProps } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  isRenderPerformanceTraceInstalled,
  recordRenderPerformanceTrace,
} from "@/src/debug/renderPerformanceTrace";
import {
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  useCollectionTitleColor,
} from "./collectionTitle";
import { resolvePlayItemFrameProjection } from "./playItem.motion";
import { Torph, type TorphStage } from "@grahlnn/comps";
import { icons } from "@/src/assets/icons";
import { useWindowPointerPresence } from "./windowPointerPresence";

type PlayItemBaseProps = Omit<HTMLMotionProps<"div">, "children"> & {
  text: string;
  layoutId?: string;
  tone?: CollectionTitleTone;
  handoffTone?: CollectionTitleTone | null;
  textClassName?: string;
  showPlaybackIcons?: boolean;
  playbackIconWidthText?: string;
  isPlaybackPreparing?: boolean;
  onOpenSpectrum?: () => void;
  onOpenSpectrumPointerDown?: () => void;
  onTitleLayoutAnimationComplete?: (layoutId?: string) => void;
  onTorphStageChange?: (stage: TorphStage) => void;
  torphDebugLabel?: string | null;
  torphDebugMeta?: Record<string, unknown> | null;
};

type PlayItemFrameProps = Omit<HTMLMotionProps<"div">, "children"> & {
  layoutId?: string;
  children: ReactNode;
  onTitleLayoutAnimationComplete?: (layoutId?: string) => void;
};

type PlayItemTextProps = Pick<
  PlayItemBaseProps,
  | "handoffTone"
  | "isPlaybackPreparing"
  | "layoutId"
  | "onClick"
  | "onOpenSpectrum"
  | "onOpenSpectrumPointerDown"
  | "onPointerDown"
  | "onTorphStageChange"
  | "playbackIconWidthText"
  | "showPlaybackIcons"
  | "text"
  | "textClassName"
  | "torphDebugLabel"
  | "torphDebugMeta"
> & {
  tone: CollectionTitleTone;
};

export type PlayItemProps = PlayItemBaseProps;

type PlaybackIconLayerBox = {
  left: number;
  top: number;
  width: number;
};

type PlayItemTorphGeometryTraceContext = {
  label: string | null;
  meta: Record<string, unknown> | null;
  text: string;
  textClassName?: string;
  textMetricClassName: string;
  torphStage: TorphStage;
  showPlaybackIcons: boolean;
  playbackIconWidthText?: string;
  shouldRenderPlaybackIconLayer: boolean;
  playbackIconLayerBox?: PlaybackIconLayerBox;
};

const PLAYBACK_ICON_LAYER_VERTICAL_GAP = 4;
const PLAY_ITEM_HEART_ACTIVE_COLOR = "#f91880";
const PLAY_ITEM_TORPH_GEOMETRY_TRACE_FRAME_COUNT = 18;

export function resolvePlayItemColorHandoff(args: {
  targetColor: string;
  handoffColor: string;
  handoffTone: CollectionTitleTone | null;
}) {
  if (!args.handoffTone || args.handoffColor === args.targetColor) {
    return {
      initialColor: args.targetColor,
      shouldAnimate: false,
    } as const;
  }

  return {
    initialColor: args.handoffColor,
    shouldAnimate: true,
  } as const;
}

function createContextMenuHandler(onContextMenu?: MouseEventHandler<HTMLDivElement>) {
  return (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu?.(event);
  };
}

function usePlayItemColorHandoff(args: {
  tone: CollectionTitleTone;
  handoffTone: CollectionTitleTone | null;
}) {
  const targetColor = useCollectionTitleColor(args.tone);
  const handoffColor = useCollectionTitleColor(args.handoffTone || args.tone);
  const { initialColor, shouldAnimate } = resolvePlayItemColorHandoff({
    targetColor,
    handoffColor,
    handoffTone: args.handoffTone,
  });
  const [scope, animate] = useAnimate<HTMLDivElement>();

  useLayoutEffect(() => {
    const node = scope.current;
    if (!node) {
      return;
    }

    node.style.color = initialColor;
    if (!shouldAnimate) {
      return;
    }

    let stopAnimation: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      const controls = animate(node, { color: targetColor }, collectionTitleColorTransition);
      stopAnimation = () => {
        controls.stop();
      };
    });

    return () => {
      cancelAnimationFrame(frame);
      stopAnimation?.();
    };
  }, [animate, initialColor, scope, shouldAnimate, targetColor]);

  return scope;
}

function readCssPixelValue(value: string) {
  if (value === "" || value === "normal") {
    return 0;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundTraceNumber(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return value;
  }

  return Math.round(value * 1000) / 1000;
}

function summarizeTraceRect(rect: DOMRect | null, anchor?: DOMRect | null) {
  if (rect === null) {
    return null;
  }

  return {
    left: roundTraceNumber(rect.left),
    top: roundTraceNumber(rect.top),
    right: roundTraceNumber(rect.right),
    bottom: roundTraceNumber(rect.bottom),
    width: roundTraceNumber(rect.width),
    height: roundTraceNumber(rect.height),
    centerX: roundTraceNumber(rect.left + rect.width / 2),
    centerY: roundTraceNumber(rect.top + rect.height / 2),
    relativeLeft: anchor ? roundTraceNumber(rect.left - anchor.left) : null,
    relativeTop: anchor ? roundTraceNumber(rect.top - anchor.top) : null,
  };
}

function summarizeTraceElementStyle(node: HTMLElement | null) {
  if (node === null) {
    return null;
  }

  const style = window.getComputedStyle(node);
  return {
    display: style.display,
    position: style.position,
    opacity: style.opacity,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontVariationSettings: style.fontVariationSettings,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    whiteSpace: style.whiteSpace,
    transform: style.transform,
    transitionDuration: style.transitionDuration,
    transitionProperty: style.transitionProperty,
  };
}

function summarizeTraceElement(node: HTMLElement | null, anchor?: DOMRect | null) {
  if (node === null) {
    return null;
  }

  return {
    rect: summarizeTraceRect(node.getBoundingClientRect(), anchor),
    style: summarizeTraceElementStyle(node),
    className: node.getAttribute("class"),
    dataset: {
      torphDebugRole: node.dataset.torphDebugRole ?? null,
      torphDebugStage: node.dataset.torphDebugStage ?? null,
      morphRole: node.dataset.morphRole ?? null,
      morphKey: node.dataset.morphKey ?? null,
      morphGlyph: node.dataset.morphGlyph ?? null,
      morphKind: node.dataset.morphKind ?? null,
    },
  };
}

function summarizeTraceNodeGroup(nodes: readonly HTMLElement[], anchor?: DOMRect | null) {
  if (nodes.length === 0) {
    return {
      count: 0,
      bounds: null,
      nodes: [],
    };
  }

  const rects = nodes.map((node) => node.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const bounds = {
    left: roundTraceNumber(left),
    top: roundTraceNumber(top),
    right: roundTraceNumber(right),
    bottom: roundTraceNumber(bottom),
    width: roundTraceNumber(right - left),
    height: roundTraceNumber(bottom - top),
    centerX: roundTraceNumber(left + (right - left) / 2),
    centerY: roundTraceNumber(top + (bottom - top) / 2),
    relativeLeft: anchor ? roundTraceNumber(left - anchor.left) : null,
    relativeTop: anchor ? roundTraceNumber(top - anchor.top) : null,
  };

  return {
    count: nodes.length,
    bounds,
    nodes: nodes.slice(0, 80).map((node, index) => ({
      index,
      rect: summarizeTraceRect(node.getBoundingClientRect(), anchor),
      style: summarizeTraceElementStyle(node),
      key: node.dataset.morphKey ?? null,
      glyph: node.dataset.morphGlyph ?? node.textContent,
      kind: node.dataset.morphKind ?? null,
      role: node.dataset.morphRole ?? null,
      transform: node.style.transform || null,
    })),
  };
}

function summarizePlayItemTorphGeometry(scopeNode: HTMLElement | null) {
  if (scopeNode === null) {
    return null;
  }

  const scopeRect = scopeNode.getBoundingClientRect();
  const rootNode = scopeNode.querySelector<HTMLElement>("[data-torph-debug-role='root']");
  const rootRect = rootNode?.getBoundingClientRect() ?? null;
  const flowShellNode = scopeNode.querySelector<HTMLElement>(
    "[data-torph-debug-role='flow-shell']",
  );
  const flowNode = scopeNode.querySelector<HTMLElement>("[data-torph-debug-role='flow']");
  const overlayNode = scopeNode.querySelector<HTMLElement>("[data-torph-debug-role='overlay']");
  const measurementNode = scopeNode.querySelector<HTMLElement>(
    "[data-torph-debug-role='measurement']",
  );
  const liveGlyphNodes = Array.from(
    scopeNode.querySelectorAll<HTMLElement>("[data-morph-role='live']"),
  );
  const exitGlyphNodes = Array.from(
    scopeNode.querySelectorAll<HTMLElement>("[data-morph-role='exit']"),
  );
  const anchor = rootRect ?? scopeRect;

  return {
    scope: summarizeTraceElement(scopeNode, scopeRect),
    root: summarizeTraceElement(rootNode, scopeRect),
    flowShell: summarizeTraceElement(flowShellNode, anchor),
    flow: summarizeTraceElement(flowNode, anchor),
    overlay: summarizeTraceElement(overlayNode, anchor),
    measurement: summarizeTraceElement(measurementNode, anchor),
    liveGlyphs: summarizeTraceNodeGroup(liveGlyphNodes, anchor),
    exitGlyphs: summarizeTraceNodeGroup(exitGlyphNodes, anchor),
  };
}

function readPretextFont(style: CSSStyleDeclaration) {
  if (style.font) {
    return style.font;
  }

  return [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    `${style.fontSize}/${style.lineHeight}`,
    style.fontFamily,
  ]
    .filter(Boolean)
    .join(" ");
}

function readPretextWhiteSpace(style: CSSStyleDeclaration): PrepareOptions["whiteSpace"] {
  return style.whiteSpace === "pre-wrap" ? "pre-wrap" : "normal";
}

function transformPretextText(text: string, textTransform: string) {
  switch (textTransform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    default:
      return text;
  }
}

function measurePlayItemTextWidthWithPretext(args: { source: HTMLElement; text: string }) {
  if (args.text.length === 0) {
    return undefined;
  }

  const style = window.getComputedStyle(args.source);
  const font = readPretextFont(style);
  if (!font) {
    return undefined;
  }

  const options: PrepareOptions = {
    whiteSpace: readPretextWhiteSpace(style),
  };
  const letterSpacing = readCssPixelValue(style.letterSpacing);
  if (Math.abs(letterSpacing) > 0.0001) {
    options.letterSpacing = letterSpacing;
  }

  const measuredWidth = measureNaturalWidth(
    prepareWithSegments(transformPretextText(args.text, style.textTransform), font, options),
  );

  return (measuredWidth > 0 && measuredWidth) || undefined;
}

function shouldTracePlayItemTorphGeometry(args: PlayItemTorphGeometryTraceContext) {
  return (
    args.label === "playlist-title" &&
    (args.textClassName !== undefined ||
      args.torphStage !== "idle" ||
      args.showPlaybackIcons ||
      args.shouldRenderPlaybackIconLayer)
  );
}

function recordPlayItemTorphGeometryTrace(args: {
  frame: number;
  reason: string;
  scopeNode: HTMLElement | null;
  context: PlayItemTorphGeometryTraceContext;
}) {
  const geometry = summarizePlayItemTorphGeometry(args.scopeNode);
  if (geometry === null) {
    recordRenderPerformanceTrace("play-item-torph-geometry-frame", {
      frame: args.frame,
      reason: args.reason,
      context: args.context,
      geometry: null,
    });
    return;
  }

  recordRenderPerformanceTrace("play-item-torph-geometry-frame", {
    frame: args.frame,
    reason: args.reason,
    context: args.context,
    geometry,
  });
}

export function resolvePlaybackIconLayerBox(args: {
  anchorBottom: number;
  textWidth: number;
  viewportWidth: number;
}) {
  if (args.textWidth <= 0 || args.viewportWidth <= 0) {
    return undefined;
  }

  const width = Math.min(Math.ceil(args.textWidth), args.viewportWidth);
  return {
    left: Math.max(0, (args.viewportWidth - width) / 2),
    top: args.anchorBottom + PLAYBACK_ICON_LAYER_VERTICAL_GAP,
    width,
  } satisfies PlaybackIconLayerBox;
}

function arePlaybackIconLayerBoxesEqual(
  current: PlaybackIconLayerBox | undefined,
  next: PlaybackIconLayerBox,
) {
  return (
    current !== undefined &&
    Math.abs(current.left - next.left) < 0.01 &&
    Math.abs(current.top - next.top) < 0.01 &&
    Math.abs(current.width - next.width) < 0.01
  );
}

export function shouldShowPlaybackIconLayer(args: {
  hasLayerBox: boolean;
  isDismissed?: boolean;
  isWindowPointerInside: boolean;
  showPlaybackIcons: boolean;
  torphStage: TorphStage;
}) {
  return (
    !args.isDismissed &&
    args.showPlaybackIcons &&
    args.hasLayerBox &&
    args.isWindowPointerInside &&
    args.torphStage !== "prepare"
  );
}

export function resolvePlayItemTextMetricClassName(textClassName?: string) {
  return cn(collectionTitleTextClassName, textClassName);
}

function PlayItemFrame({
  className,
  children,
  layoutId,
  onContextMenu,
  onTitleLayoutAnimationComplete,
  ...domProps
}: PlayItemFrameProps) {
  const frameProjection = resolvePlayItemFrameProjection({ layoutId });

  return (
    <motion.div
      className={cn(className)}
      layout={frameProjection.layout}
      layoutId={frameProjection.layoutId}
      onContextMenu={createContextMenuHandler(onContextMenu)}
      onLayoutAnimationComplete={() => {
        onTitleLayoutAnimationComplete?.(frameProjection.layoutId);
      }}
      {...domProps}
    >
      {children}
    </motion.div>
  );
}

function PlayItemFn({
  activeColor,
  icon,
  label,
  onClick,
  onPointerDown,
}: {
  activeColor?: string;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  onPointerDown?: () => void;
}) {
  const [isActive, setIsActive] = useState(false);
  const inactiveColorRef = useRef<string | undefined>(undefined);
  const isInteractive = Boolean(activeColor || onClick || onPointerDown);
  const animatedColor =
    activeColor && (isActive || inactiveColorRef.current)
      ? isActive
        ? activeColor
        : inactiveColorRef.current
      : undefined;

  return (
    <motion.button
      type="button"
      aria-label={label}
      disabled={!isInteractive}
      className={cn(
        "inline-flex items-center justify-center border-0 bg-transparent p-2 text-current",
        isInteractive ? "cursor-pointer" : "cursor-default",
      )}
      animate={animatedColor ? { color: animatedColor, opacity: 0.7 } : { opacity: 0.7 }}
      whileHover={{
        scale: 1.1,
        opacity: 1,
        transition: { duration: 0.1 },
      }}
      whileTap={{
        scale: 1.3,
        transition: { duration: 0.08, ease: "easeOut" },
      }}
      transition={{
        color: { duration: 0.25, ease: "easeOut" },
        opacity: { duration: 0.5 },
        scale: { duration: 0.18, ease: "easeOut" },
      }}
      initial={{ opacity: 0.7 }}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }

        if (activeColor) {
          inactiveColorRef.current ||= window.getComputedStyle(event.currentTarget).color;
          setIsActive((current) => !current);
        }
        onPointerDown?.();
      }}
      onClick={() => {
        onClick?.();
      }}
    >
      {icon}
    </motion.button>
  );
}

function PlayItemText({
  handoffTone = null,
  isPlaybackPreparing = false,
  onClick,
  onOpenSpectrum,
  onOpenSpectrumPointerDown,
  onPointerDown,
  onTorphStageChange,
  playbackIconWidthText,
  showPlaybackIcons = false,
  text,
  textClassName,
  tone,
  torphDebugLabel = null,
  torphDebugMeta = null,
}: PlayItemTextProps) {
  const [playbackIconLayerBox, setPlaybackIconLayerBox] = useState<
    PlaybackIconLayerBox | undefined
  >();
  const [isPlaybackIconLayerDismissed, setPlaybackIconLayerDismissed] = useState(false);
  const [torphStage, setTorphStage] = useState<TorphStage>("idle");
  const portalHost = typeof document === "undefined" ? null : document.body;
  const latestMeasuredTextWidthRef = useRef<number | undefined>(undefined);
  const scope = usePlayItemColorHandoff({
    tone,
    handoffTone,
  });
  const isWindowPointerInside = useWindowPointerPresence(
    showPlaybackIcons && playbackIconLayerBox !== undefined && torphStage !== "prepare",
  );
  const shouldRenderPlaybackIconLayer = shouldShowPlaybackIconLayer({
    hasLayerBox: playbackIconLayerBox !== undefined,
    isWindowPointerInside,
    showPlaybackIcons,
    torphStage,
    isDismissed: isPlaybackIconLayerDismissed,
  });
  const textMetricClassName = resolvePlayItemTextMetricClassName(textClassName);

  const dismissPlaybackIconLayer = () => {
    setPlaybackIconLayerDismissed(true);
  };

  const handleOpenSpectrum = () => {
    dismissPlaybackIconLayer();
    onOpenSpectrum?.();
  };

  const handleOpenSpectrumPointerDown = () => {
    dismissPlaybackIconLayer();
    onOpenSpectrumPointerDown?.();
  };

  useLayoutEffect(() => {
    const node = scope.current;
    if (!showPlaybackIcons || !playbackIconWidthText || !node) {
      setPlaybackIconLayerBox(undefined);
      return;
    }

    let cancelled = false;
    let animationFrame: number | null = null;
    const measureTextWidth = () => {
      latestMeasuredTextWidthRef.current = measurePlayItemTextWidthWithPretext({
        source: node,
        text: playbackIconWidthText,
      });
    };
    const updateLayerBox = () => {
      if (cancelled) {
        return;
      }

      const textWidth = latestMeasuredTextWidthRef.current;
      if (textWidth !== undefined) {
        const next = resolvePlaybackIconLayerBox({
          anchorBottom: node.getBoundingClientRect().bottom,
          textWidth,
          viewportWidth: window.innerWidth,
        });
        if (next !== undefined) {
          setPlaybackIconLayerBox((current) =>
            arePlaybackIconLayerBoxesEqual(current, next) ? current : next,
          );
        }
      }

      animationFrame = requestAnimationFrame(updateLayerBox);
    };
    const handleResize = () => {
      measureTextWidth();
    };

    measureTextWidth();
    updateLayerBox();
    document.fonts?.ready.then(() => {
      if (!cancelled) {
        measureTextWidth();
      }
    });
    window.addEventListener("resize", handleResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", handleResize);
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, [playbackIconWidthText, scope, showPlaybackIcons]);

  useLayoutEffect(() => {
    setPlaybackIconLayerDismissed(false);
  }, [playbackIconWidthText, showPlaybackIcons]);

  useLayoutEffect(() => {
    if (!isRenderPerformanceTraceInstalled()) {
      return;
    }

    const context: PlayItemTorphGeometryTraceContext = {
      label: torphDebugLabel,
      meta: torphDebugMeta,
      text,
      textClassName,
      textMetricClassName,
      torphStage,
      showPlaybackIcons,
      playbackIconWidthText,
      shouldRenderPlaybackIconLayer,
      playbackIconLayerBox,
    };

    if (!shouldTracePlayItemTorphGeometry(context)) {
      return;
    }

    let cancelled = false;
    let frameHandle: number | null = null;
    let frame = 0;

    const capture = () => {
      if (cancelled) {
        return;
      }

      recordPlayItemTorphGeometryTrace({
        frame,
        reason: "handoff-window",
        scopeNode: scope.current,
        context,
      });
      frame += 1;

      if (frame >= PLAY_ITEM_TORPH_GEOMETRY_TRACE_FRAME_COUNT) {
        frameHandle = null;
        return;
      }

      frameHandle = requestAnimationFrame(capture);
    };

    frameHandle = requestAnimationFrame(capture);

    return () => {
      cancelled = true;
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
    };
  }, [
    playbackIconLayerBox,
    playbackIconWidthText,
    scope,
    shouldRenderPlaybackIconLayer,
    showPlaybackIcons,
    text,
    textClassName,
    textMetricClassName,
    torphDebugLabel,
    torphDebugMeta,
    torphStage,
  ]);

  return (
    <>
      <div
        ref={scope}
        className={cn("relative inline-flex", textMetricClassName)}
        onClick={onClick}
        onPointerDown={onPointerDown}
      >
        <Torph
          className={textMetricClassName}
          debugLabel={torphDebugLabel}
          debugMeta={torphDebugMeta}
          text={text}
          onStageChange={(stage) => {
            setTorphStage(stage);
            onTorphStageChange?.(stage);
          }}
        />
      </div>

      {portalHost &&
        createPortal(
          <AnimatePresence>
            {shouldRenderPlaybackIconLayer && playbackIconLayerBox && !isPlaybackPreparing && (
              <motion.div
                aria-label="Playback actions"
                role="toolbar"
                className="fixed z-10 flex max-w-[100vw] items-center justify-center"
                style={{
                  left: playbackIconLayerBox.left,
                  top: playbackIconLayerBox.top,
                  width: playbackIconLayerBox.width,
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
              >
                <div className="flex w-full items-center justify-between">
                  <div>
                    <PlayItemFn
                      activeColor={PLAY_ITEM_HEART_ACTIVE_COLOR}
                      icon={<icons.suitHearts size={14} />}
                      label="Toggle favorite"
                    />
                  </div>
                  <div className="flex items-center">
                    <PlayItemFn
                      icon={<icons.waveformLines size={14} />}
                      label="Open spectrum"
                      onClick={handleOpenSpectrum}
                      onPointerDown={handleOpenSpectrumPointerDown}
                    />
                    <PlayItemFn icon={<icons.brush2 size={14} />} label="Open style controls" />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          portalHost,
        )}
    </>
  );
}

export function PlayItem({
  className,
  onClick,
  onContextMenu,
  onOpenSpectrum,
  onOpenSpectrumPointerDown,
  onPointerDown,
  layoutId,
  tone = "solid",
  handoffTone = null,
  isPlaybackPreparing = false,
  text,
  textClassName,
  playbackIconWidthText,
  showPlaybackIcons = false,
  onTorphStageChange,
  onTitleLayoutAnimationComplete,
  torphDebugLabel = null,
  torphDebugMeta = null,
  ...domProps
}: PlayItemProps) {
  return (
    <PlayItemFrame
      className={className}
      layoutId={layoutId}
      onContextMenu={onContextMenu}
      onTitleLayoutAnimationComplete={onTitleLayoutAnimationComplete}
      {...domProps}
    >
      <PlayItemText
        handoffTone={handoffTone}
        isPlaybackPreparing={isPlaybackPreparing}
        onClick={onClick}
        onOpenSpectrum={onOpenSpectrum}
        onOpenSpectrumPointerDown={onOpenSpectrumPointerDown}
        onPointerDown={onPointerDown}
        onTorphStageChange={onTorphStageChange}
        playbackIconWidthText={playbackIconWidthText}
        showPlaybackIcons={showPlaybackIcons}
        text={text}
        textClassName={textClassName}
        tone={tone}
        torphDebugLabel={torphDebugLabel}
        torphDebugMeta={torphDebugMeta}
      />
    </PlayItemFrame>
  );
}
