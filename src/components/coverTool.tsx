import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { ComponentProps } from "react";
import { GlassSurface } from "./glass/GlassSurface";

export function CoverTool({ text, onClick }: ComponentProps<"div"> & { text: string }) {
  return (
    <motion.div
      className={cn(
        "relative isolate overflow-visible",
        "text-[12px] trim-cap text-[#404040] dark:text-[#a3a3a3]",
        "bg-[rgb(255_255_255_/_0.34)] backdrop-blur-md backdrop-saturate-150",
        "shadow-[inset_0_0_0_1px_rgb(255_255_255_/_0.48),0_4px_18px_rgb(148_163_184_/_0.08)]",
        "dark:bg-[rgb(82_82_82_/_0.24)]",
        "dark:shadow-[inset_0_0_0_1px_rgb(255_255_255_/_0.08),0_4px_18px_rgb(0_0_0_/_0.22)]",
        "[corner-shape:squircle_squircle_squircle_squircle]",
        "rounded-[25px] px-1 py-1.5",
        "pointer-events-auto cursor-pointer whitespace-nowrap",
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClick}
    >
      <GlassSurface variant="button" className="inset-0 z-0" />
      <span className="relative z-10">{text}</span>
    </motion.div>
  );
}
