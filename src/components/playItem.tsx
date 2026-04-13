import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { collectionTitleTextClassName } from "./collectionTitle";

export function PlayItem({
  className,
  onClick,
  onContextMenu,
  onPointerDown,
  layoutId,
  text,
  textClassName,
}: ComponentProps<"div"> & {
  text: string;
  layoutId?: string;
  textClassName?: string;
}) {
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
      <div className={cn(collectionTitleTextClassName, textClassName)}>
        {/*<Torph text={text} />*/}
        {text}
      </div>
    </motion.div>
  );
}
