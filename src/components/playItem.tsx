import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type MouseEventHandler,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { measureNaturalWidth, prepareWithSegments, type PrepareOptions } from "@chenglou/pretext";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion, useAnimate, type HTMLMotionProps } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  useCollectionTitleColor,
} from "./collectionTitle";
import { resolvePlayItemFrameProjection } from "./playItem.motion";
import { Torph, type TorphStage } from "@grahlnn/comps";
import { icons } from "@/src/assets/icons";
import { captureTorphHostFrames, recordTorphHostTrace } from "@/src/debug/torphTrace";

type PlayItemBaseProps = Omit<HTMLMotionProps<"div">, "children"> & {
  text: string;
  layoutId?: string;
  tone?: CollectionTitleTone;
  handoffTone?: CollectionTitleTone | null;
  textClassName?: string;
  showPlaybackIcons?: boolean;
  playbackIconWidthText?: string;
  onTorphStageChange?: (stage: TorphStage) => void;
};

type PlayItemFrameProps = Omit<HTMLMotionProps<"div">, "children"> & {
  layoutId?: string;
  children: ReactNode;
};

type PlayItemTextProps = Pick<
  PlayItemBaseProps,
  | "handoffTone"
  | "onTorphStageChange"
  | "playbackIconWidthText"
  | "showPlaybackIcons"
  | "text"
  | "textClassName"
> & {
  tone: CollectionTitleTone;
};

export type PlayItemProps = PlayItemBaseProps;

type PlaybackIconLayerBox = {
  left: number;
  top: number;
  width: number;
};

const PLAYBACK_ICON_LAYER_VERTICAL_GAP = 12;

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

function snapshotPlayItemTextShell(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);

  return {
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    },
    offsetWidth: node.offsetWidth,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    display: style.display,
    width: style.width,
    font: readPretextFont(style),
    fontWeight: style.fontWeight,
    fontVariationSettings: style.fontVariationSettings,
    letterSpacing: style.letterSpacing,
    transitionProperty: style.transitionProperty,
    transitionDuration: style.transitionDuration,
    transform: style.transform,
    willChange: style.willChange,
  };
}

function recordPlayItemTextShellTrace(
  event: string,
  args: {
    node: HTMLElement;
    playbackIconWidthText?: string;
    showPlaybackIcons: boolean;
    text: string;
    extra?: Record<string, unknown>;
  },
) {
  if (!args.showPlaybackIcons && !args.playbackIconWidthText) {
    return;
  }

  recordTorphHostTrace(event, {
    text: args.text,
    playbackIconWidthText: args.playbackIconWidthText ?? null,
    showPlaybackIcons: args.showPlaybackIcons,
    textShell: snapshotPlayItemTextShell(args.node),
    pretextWidth:
      args.playbackIconWidthText &&
      measurePlayItemTextWidthWithPretext({
        source: args.node,
        text: args.playbackIconWidthText,
      }),
    ...args.extra,
  });
}

function PlayItemFrame({
  className,
  children,
  layoutId,
  onClick,
  onContextMenu,
  onPointerDown,
  ...domProps
}: PlayItemFrameProps) {
  const frameProjection = resolvePlayItemFrameProjection({ layoutId });

  return (
    <motion.div
      className={cn(className)}
      layout={frameProjection.layout}
      layoutId={frameProjection.layoutId}
      onClick={onClick}
      onContextMenu={createContextMenuHandler(onContextMenu)}
      onPointerDown={onPointerDown}
      {...domProps}
    >
      {children}
    </motion.div>
  );
}

function PlayItemText({
  handoffTone = null,
  onTorphStageChange,
  playbackIconWidthText,
  showPlaybackIcons = false,
  text,
  textClassName,
  tone,
}: PlayItemTextProps) {
  const [playbackIconLayerBox, setPlaybackIconLayerBox] = useState<
    PlaybackIconLayerBox | undefined
  >();
  const portalHost = typeof document === "undefined" ? null : document.body;
  const latestMeasuredTextWidthRef = useRef<number | undefined>(undefined);
  const scope = usePlayItemColorHandoff({
    tone,
    handoffTone,
  });

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

  const handleTextShellPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    recordPlayItemTextShellTrace("play-item-text-shell-pointer-enter", {
      node: event.currentTarget,
      playbackIconWidthText,
      showPlaybackIcons,
      text,
      extra: {
        pointerType: event.pointerType,
      },
    });
    captureTorphHostFrames("play-item-text-shell-hover-enter", {
      frames: 36,
      payload: {
        text,
        playbackIconWidthText: playbackIconWidthText ?? null,
        showPlaybackIcons,
      },
    });
  };

  const handleTextShellPointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    recordPlayItemTextShellTrace("play-item-text-shell-pointer-leave", {
      node: event.currentTarget,
      playbackIconWidthText,
      showPlaybackIcons,
      text,
      extra: {
        pointerType: event.pointerType,
      },
    });
    captureTorphHostFrames("play-item-text-shell-hover-leave", {
      frames: 36,
      payload: {
        text,
        playbackIconWidthText: playbackIconWidthText ?? null,
        showPlaybackIcons,
      },
    });
  };

  return (
    <>
      <div
        ref={scope}
        data-torph-trace-text-host
        data-torph-trace-text={text}
        data-torph-trace-text-playback-icons={showPlaybackIcons}
        className={cn("relative inline-flex", collectionTitleTextClassName, textClassName)}
        onPointerEnter={handleTextShellPointerEnter}
        onPointerLeave={handleTextShellPointerLeave}
        onTransitionEnd={(event) => {
          recordPlayItemTextShellTrace("play-item-text-shell-transition-end", {
            node: event.currentTarget,
            playbackIconWidthText,
            showPlaybackIcons,
            text,
            extra: {
              propertyName: event.propertyName,
            },
          });
        }}
        onTransitionRun={(event) => {
          recordPlayItemTextShellTrace("play-item-text-shell-transition-run", {
            node: event.currentTarget,
            playbackIconWidthText,
            showPlaybackIcons,
            text,
            extra: {
              propertyName: event.propertyName,
            },
          });
        }}
        onTransitionStart={(event) => {
          recordPlayItemTextShellTrace("play-item-text-shell-transition-start", {
            node: event.currentTarget,
            playbackIconWidthText,
            showPlaybackIcons,
            text,
            extra: {
              propertyName: event.propertyName,
            },
          });
        }}
      >
        <Torph
          className="!w-max"
          debugLabel="play-item-text-shell"
          debugMeta={{
            playbackIconWidthText: playbackIconWidthText ?? null,
            showPlaybackIcons,
            text,
          }}
          text={text}
          onStageChange={(stage) => {
            const node = scope.current;
            if (node) {
              recordPlayItemTextShellTrace("play-item-text-shell-torph-stage", {
                node,
                playbackIconWidthText,
                showPlaybackIcons,
                text,
                extra: {
                  stage,
                },
              });
            }
            onTorphStageChange?.(stage);
          }}
        />
      </div>

      {portalHost
        ? createPortal(
            <AnimatePresence>
              {showPlaybackIcons && playbackIconLayerBox && (
                <motion.div
                  aria-hidden
                  className="pointer-events-none fixed z-10 flex max-w-[100vw] items-center justify-center"
                  style={{
                    left: playbackIconLayerBox.left,
                    top: playbackIconLayerBox.top,
                    width: playbackIconLayerBox.width,
                  }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.7 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                >
                  <div className="flex w-full items-center justify-between">
                    <div>
                      <icons.suitHearts size={12} />
                    </div>
                    <div className="flex items-center gap-4">
                      <icons.waveformLines size={12} />
                      <icons.brush2 size={12} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>,
            portalHost,
          )
        : null}
    </>
  );
}

export function PlayItem({
  className,
  onClick,
  onContextMenu,
  onPointerDown,
  layoutId,
  tone = "solid",
  handoffTone = null,
  text,
  textClassName,
  playbackIconWidthText,
  showPlaybackIcons = false,
  onTorphStageChange,
  ...domProps
}: PlayItemProps) {
  return (
    <PlayItemFrame
      className={className}
      layoutId={layoutId}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      {...domProps}
    >
      <PlayItemText
        handoffTone={handoffTone}
        onTorphStageChange={onTorphStageChange}
        playbackIconWidthText={playbackIconWidthText}
        showPlaybackIcons={showPlaybackIcons}
        text={text}
        textClassName={textClassName}
        tone={tone}
      />
    </PlayItemFrame>
  );
}
