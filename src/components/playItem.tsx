import {
  useLayoutEffect,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { motion, useAnimate, type HTMLMotionProps } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  useCollectionTitleColor,
} from "./collectionTitle";
import { resolvePlayItemFrameProjection } from "./playItem.motion";
import { Torph, type TorphStage } from "@grahlnn/comps";

type PlayItemBaseProps = Omit<HTMLMotionProps<"div">, "children"> & {
  text: string;
  layoutId?: string;
  tone?: CollectionTitleTone;
  handoffTone?: CollectionTitleTone | null;
  textClassName?: string;
  onTorphStageChange?: (stage: TorphStage) => void;
};

type PlayItemFrameProps = Omit<HTMLMotionProps<"div">, "children"> & {
  layoutId?: string;
  children: ReactNode;
};

type PlayItemTextProps = Pick<
  PlayItemBaseProps,
  "handoffTone" | "onTorphStageChange" | "text" | "textClassName"
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
  const handoffColor = useCollectionTitleColor(args.handoffTone ?? args.tone);
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
  text,
  textClassName,
  tone,
}: PlayItemTextProps) {
  const scope = usePlayItemColorHandoff({
    tone,
    handoffTone,
  });

  return (
    <div
      ref={scope}
      className={cn(collectionTitleTextClassName, textClassName)}
    >
      <Torph text={text} onStageChange={onTorphStageChange} />
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
        text={text}
        textClassName={textClassName}
        tone={tone}
      />
    </PlayItemFrame>
  );
}
