import {
  useLayoutEffect,
  type ComponentProps,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { motion, useAnimate } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  useCollectionTitleColor,
} from "./collectionTitle";
import { Torph, type TorphStage } from "@grahlnn/comps";

type PlayItemBaseProps = Omit<ComponentProps<"div">, "children"> & {
  text: string;
  layoutId?: string;
  tone?: CollectionTitleTone;
  handoffTone?: CollectionTitleTone | null;
  shouldAnimateLayoutPosition?: boolean;
  textClassName?: string;
  onTorphStageChange?: (stage: TorphStage) => void;
};

type PlayItemFrameProps = Pick<
  PlayItemBaseProps,
  | "className"
  | "layoutId"
  | "onClick"
  | "onContextMenu"
  | "onPointerDown"
  | "shouldAnimateLayoutPosition"
> & {
  children: ReactNode;
};

type PlayItemTextProps = Pick<
  PlayItemBaseProps,
  "handoffTone" | "onTorphStageChange" | "text" | "textClassName"
> & {
  tone: CollectionTitleTone;
};

export type PlayItemProps = PlayItemBaseProps;

export function resolvePlayItemLayoutAnimationEnabled(args: {
  requested: boolean;
  torphStage: TorphStage;
  textChanged: boolean;
}) {
  return args.requested && !args.textChanged && args.torphStage === "idle";
}

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
  shouldAnimateLayoutPosition = true,
}: PlayItemFrameProps) {
  return (
    <motion.div
      className={cn(className)}
      layout={shouldAnimateLayoutPosition ? "position" : false}
      layoutId={layoutId}
      onClick={onClick}
      onContextMenu={createContextMenuHandler(onContextMenu)}
      onPointerDown={onPointerDown}
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
  shouldAnimateLayoutPosition = true,
  text,
  textClassName,
  onTorphStageChange,
}: PlayItemProps) {
  return (
    <PlayItemFrame
      className={className}
      layoutId={layoutId}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      shouldAnimateLayoutPosition={shouldAnimateLayoutPosition}
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
