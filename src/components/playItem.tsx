import {
  useLayoutEffect,
  useState,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  AnimatePresence,
  motion,
  useAnimate,
  type HTMLMotionProps,
} from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  useCollectionTitleColor,
} from "./collectionTitle";
import { resolvePlayItemFrameProjection } from "./playItem.motion";
import { Torph, type TorphStage } from "@grahlnn/comps";
import { icons } from "@/src/assets/icons";

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

function createContextMenuHandler(
  onContextMenu?: MouseEventHandler<HTMLDivElement>,
) {
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
      const controls = animate(
        node,
        { color: targetColor },
        collectionTitleColorTransition,
      );
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

function measurePlayItemTextWidth(args: { source: HTMLElement; text: string }) {
  if (!document.body) {
    return undefined;
  }

  const measurementNode = args.source.cloneNode(false) as HTMLElement;
  measurementNode.textContent = args.text;
  measurementNode.style.position = "fixed";
  measurementNode.style.top = "0";
  measurementNode.style.left = "-10000px";
  measurementNode.style.width = "max-content";
  measurementNode.style.maxWidth = "none";
  measurementNode.style.visibility = "hidden";
  measurementNode.style.pointerEvents = "none";
  measurementNode.style.contain = "layout style paint";

  document.body.append(measurementNode);
  const measuredWidth = measurementNode.getBoundingClientRect().width;
  measurementNode.remove();

  return (measuredWidth > 0 && measuredWidth) || undefined;
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
  const [playbackIconWidth, setPlaybackIconWidth] = useState<number>();
  const scope = usePlayItemColorHandoff({
    tone,
    handoffTone,
  });

  useLayoutEffect(() => {
    const node = scope.current;
    if (!showPlaybackIcons || !playbackIconWidthText || !node) {
      return;
    }

    const measuredWidth = measurePlayItemTextWidth({
      source: node,
      text: playbackIconWidthText,
    });
    if (measuredWidth) {
      setPlaybackIconWidth(measuredWidth);
    }
  }, [playbackIconWidthText, scope, showPlaybackIcons]);

  return (
    <div
      ref={scope}
      className={cn(
        "relative inline-flex",
        collectionTitleTextClassName,
        textClassName,
      )}
    >
      <Torph text={text} onStageChange={onTorphStageChange} />
      <AnimatePresence>
        {showPlaybackIcons && (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute top-full left-1/2 mt-3 flex max-w-[100vw] -translate-x-1/2 items-center justify-center gap-2"
            style={{
              width: (playbackIconWidth && `${playbackIconWidth}px`) || "100%",
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.7 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <div className="flex items-center justify-between">
              <div>
                <icons.suitHearts size={12} />
              </div>
              <div className="flex items-center gap-2">
                <icons.waveformLines size={12} />
                <icons.brush2 size={12} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
