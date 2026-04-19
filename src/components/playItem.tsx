import { useLayoutEffect, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { motion, useAnimate } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  useCollectionTitleColor,
} from "./collectionTitle";
import {
  captureTitleShareFrames,
  recordTitleShareNodeTrace,
} from "@/src/debug/titleShareTrace";
import { Torph } from "@grahlnn/comps";

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
}: ComponentProps<"div"> & {
  text: string;
  layoutId?: string;
  tone?: CollectionTitleTone;
  handoffTone?: CollectionTitleTone | null;
  textClassName?: string;
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
      data-title-layout-id={layoutId}
      data-title-role="playlist-page-item"
      layoutId={layoutId}
      onClick={(event) => {
        if (layoutId) {
          recordTitleShareNodeTrace("playlist-title:click", event.currentTarget, {
            layoutId,
            text,
          });
          captureTitleShareFrames(`playlist-title:click:${layoutId}`, {
            frames: 24,
            payload: {
              layoutId,
              text,
            },
          });
        }

        onClick?.(event);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      onPointerDown={(event) => {
        if (layoutId) {
          recordTitleShareNodeTrace("playlist-title:pointerdown", event.currentTarget, {
            layoutId,
            text,
          });
          captureTitleShareFrames(`playlist-title:pointerdown:${layoutId}`, {
            frames: 12,
            payload: {
              layoutId,
              text,
            },
          });
        }

        onPointerDown?.(event);
      }}
    >
      <div
        ref={scope}
        className={cn(collectionTitleTextClassName, textClassName)}
      >
        {/*<Torph text={text} />*/}
        {text}
      </div>
    </motion.div>
  );
}
