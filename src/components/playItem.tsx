import { useLayoutEffect, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { motion, useAnimate } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  useCollectionTitleColor,
} from "./collectionTitle";
import { Torph, type TorphStage } from "@grahlnn/comps";

export function PlayItem({
  className,
  onClick,
  onContextMenu,
  onPointerDown,
  layoutId,
  traceKey,
  traceRole,
  tracePlaybackTarget = false,
  traceHiddenInPlay = false,
  tone = "solid",
  handoffTone = null,
  shouldAnimateLayoutPosition = true,
  text,
  textClassName,
  onTorphStageChange,
}: ComponentProps<"div"> & {
  text: string;
  layoutId?: string;
  traceKey?: string;
  traceRole?: string;
  tracePlaybackTarget?: boolean;
  traceHiddenInPlay?: boolean;
  tone?: CollectionTitleTone;
  handoffTone?: CollectionTitleTone | null;
  shouldAnimateLayoutPosition?: boolean;
  textClassName?: string;
  onTorphStageChange?: (stage: TorphStage) => void;
}) {
  const targetColor = useCollectionTitleColor(tone);
  const handoffColor = useCollectionTitleColor(handoffTone ?? tone);
  const [scope, animate] = useAnimate<HTMLDivElement>();

  useLayoutEffect(() => {
    const node = scope.current;
    if (!node) {
      return;
    }

    if (!handoffTone || handoffColor === targetColor) {
      node.style.color = targetColor;
      return;
    }

    node.style.color = handoffColor;

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
  }, [animate, handoffColor, handoffTone, scope, targetColor]);

  return (
    <motion.div
      className={cn(className)}
      layout={shouldAnimateLayoutPosition ? "position" : false}
      layoutId={layoutId}
      data-title-layout-id={layoutId}
      data-title-role={traceRole}
      data-title-text={text}
      data-torph-trace-item-key={traceKey}
      data-torph-trace-role={traceRole}
      data-torph-trace-layout-id={layoutId}
      data-torph-trace-text={text}
      data-torph-trace-playback-target={tracePlaybackTarget ? "true" : "false"}
      data-torph-trace-hidden-in-play={traceHiddenInPlay ? "true" : "false"}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      onPointerDown={onPointerDown}
    >
      <div
        ref={scope}
        className={cn(collectionTitleTextClassName, textClassName)}
        data-torph-trace-text-host={traceKey}
      >
        <Torph
          text={text}
          onStageChange={onTorphStageChange}
          debugLabel={traceKey ?? text}
          debugMeta={{
            itemKey: traceKey ?? null,
            layoutId: layoutId ?? null,
            traceRole: traceRole ?? null,
            playbackTarget: tracePlaybackTarget,
            hiddenInPlay: traceHiddenInPlay,
          }}
        />
        {/*{text}*/}
      </div>
    </motion.div>
  );
}
