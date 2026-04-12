import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

export function CoverTool({ text }: { text: string }) {
  return (
    <motion.div
      className={cn(
        "text-[12px] trim-cap text-[#404040] dark:text-[#a3a3a3]",
        "bg-[#f9f9f9] dark:bg-[#383838]",
        "[corner-shape:squircle_squircle_squircle_squircle]",
        "rounded-[25px] border border-[#d4d4d4] px-1 py-1.5 shadow",
        "dark:border-[#4a4a4a] cursor-pointer whitespace-nowrap",
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {text}
    </motion.div>
  );
}
