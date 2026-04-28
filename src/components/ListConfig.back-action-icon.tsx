import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { installBackActionTrace, recordBackActionTrace } from "@/src/debug/backActionTrace";
import type { ConfigCandidateItem } from "@/src/flow/pasteDownload/core";
import type { BackActionVisualState } from "./ListConfig.back-action";

const iconStrokeTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1],
} as const;

const backActionProcessingTransition = {
  duration: 0.18,
  ease: [0.22, 1, 0.36, 1],
} as const;

const BACK_ACTION_PROCESSING_CYCLE_MS = 150;

const BACK_ACTION_ICON_TONE_CLASS_NAME =
  "text-[#737373] dark:text-[#8a8a8a] group-hover:text-[#262626] dark:group-hover:text-[#d4d4d4]";

const BACK_ACTION_PROCESSING_GRID_CELLS = Array.from({ length: 16 }, (_, index) => {
  const seed = (index * 17 + 11) % 29;

  return {
    key: `processing-cell-${index}`,
    delay: (seed % 7) * 0.012,
  };
});

function BackActionCheckIcon({ replayKey }: { replayKey: string }) {
  return (
    <motion.svg
      key={replayKey}
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className={cn("absolute inset-0 block", BACK_ACTION_ICON_TONE_CLASS_NAME)}
    >
      <motion.path
        d="M2.75 9.25L6.75 14.25L15.25 3.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        exit={{ pathLength: 0 }}
        transition={{
          ...iconStrokeTransition,
          delay: 0.02,
        }}
      />
    </motion.svg>
  );
}

function BackActionArrowIcon({ replayKey }: { replayKey: string }) {
  return (
    <motion.svg
      key={replayKey}
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className={cn("absolute inset-0 block rotate-90", BACK_ACTION_ICON_TONE_CLASS_NAME)}
    >
      <motion.line
        x1="9"
        y1="15.25"
        x2="9"
        y2="2.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        exit={{ pathLength: 0 }}
        transition={{
          ...iconStrokeTransition,
          delay: 0.02,
        }}
      />
      <motion.polyline
        points="13.25 11 9 15.25 4.75 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        exit={{ pathLength: 0 }}
        transition={{
          ...iconStrokeTransition,
          delay: 0.02,
        }}
      />
    </motion.svg>
  );
}

function resolveBackActionProcessingCellOpacity(cellIndex: number, cycle: number) {
  const seed = (cellIndex + 1) * 97 + cycle * 173;
  const sample = Math.sin(seed * 12.9898) * 43758.5453;
  const normalized = sample - Math.floor(sample);

  return 0.08 + normalized * 0.88;
}

function BackActionProcessingGrid({ flickerCycle }: { flickerCycle: number }) {
  return (
    <div className="absolute inset-0 grid grid-cols-4 grid-rows-4 place-items-center p-[1px]">
      {BACK_ACTION_PROCESSING_GRID_CELLS.map((cell, index) => (
        <motion.span
          key={cell.key}
          className="block size-[2px] rounded-full bg-black dark:bg-white"
          initial={{ opacity: 0 }}
          animate={{ opacity: resolveBackActionProcessingCellOpacity(index, flickerCycle) }}
          transition={{
            duration: BACK_ACTION_PROCESSING_CYCLE_MS / 1000,
            delay: cell.delay,
            ease: "linear",
          }}
        />
      ))}
    </div>
  );
}

function BackActionProcessingOwner() {
  const [flickerCycle, setFlickerCycle] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setFlickerCycle((value) => value + 1);
    }, BACK_ACTION_PROCESSING_CYCLE_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={backActionProcessingTransition}
      className="absolute inset-0 block"
    >
      <BackActionProcessingGrid flickerCycle={flickerCycle} />
    </motion.span>
  );
}

function BackActionSymbolOwner({ visualState }: { visualState: BackActionVisualState }) {
  return (
    <span className="absolute inset-0 block">
      {visualState.kind === "check" ? (
        <BackActionCheckIcon replayKey={visualState.key} />
      ) : (
        <BackActionArrowIcon replayKey={visualState.key} />
      )}
    </span>
  );
}

export function BackActionIcon({ visualState }: { visualState: BackActionVisualState }) {
  return (
    <span className="relative block size-4.5">
      <AnimatePresence initial={false} mode="wait">
        {visualState.kind === "processing" ? (
          <BackActionProcessingOwner key="processing" />
        ) : (
          <BackActionSymbolOwner key={visualState.kind} visualState={visualState} />
        )}
      </AnimatePresence>
    </span>
  );
}

export function BackActionTraceOwner(args: {
  candidateItems: readonly ConfigCandidateItem[];
  isBackActionParsing: boolean;
}) {
  useEffect(() => {
    installBackActionTrace();
  }, []);

  useEffect(() => {
    recordBackActionTrace("list-config-back-action-state", {
      isBackActionParsing: args.isBackActionParsing,
      candidateItems: args.candidateItems.map((item) => ({
        id: item.id,
        status: item.status,
        displayText: item.displayText,
        sourceUrl: item.sourceUrl,
      })),
    });
  }, [args.candidateItems, args.isBackActionParsing]);

  return null;
}
