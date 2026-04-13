import { useLayoutEffect, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { motion, useAnimate } from "motion/react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleColorTransition,
  collectionTitleTextClassName,
  useCollectionTitleColor,
} from "./collectionTitle";

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
      layoutId={layoutId}
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
      >
        {/*<Torph text={text} />*/}
        {text}
      </div>
    </motion.div>
  );
}
