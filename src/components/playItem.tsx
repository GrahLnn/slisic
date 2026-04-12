import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Torph } from "@grahlnn/comps";

export function PlayItem({
  className,
  onClick,
  onContextMenu,
  text,
}: ComponentProps<"div"> & { text: string }) {
  return (
    <div
      className={cn(className)}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
    >
      <Torph text={text} />
    </div>
  );
}
