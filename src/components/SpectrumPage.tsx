import { motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { collectionTitleClassName, collectionTitleLayoutTransition } from "./collectionTitle";
import { EditableTitle } from "./EditableTitle";
import { usePageRenderFreeze } from "./usePageRenderFreeze";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

const sharedTitleFadeProps = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit: { opacity: 1 },
  transition: collectionTitleLayoutTransition,
} as const;

const spectrumBackIconStrokeTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1],
} as const;

const spectrumBackIconToneClassName =
  "text-[#737373] dark:text-[#8a8a8a] group-hover:text-[#262626] dark:group-hover:text-[#d4d4d4]";

type SpectrumRenderData = {
  handoffTone: "solid" | "muted" | null;
  titleLayoutId?: string;
  titleValue: string;
};

function resolveSpectrumTitle(args: {
  nowPlayingTrackName: string | null;
  playingPlaylistName: string | null;
}) {
  const trackName = args.nowPlayingTrackName?.trim();
  if (trackName) {
    return trackName;
  }

  return args.playingPlaylistName ?? "Spectrum";
}

function ignoreSpectrumTitleChange() {}

export function resolveSpectrumTitleFadeProps(args: { hasSharedTitleLayout: boolean }) {
  return args.hasSharedTitleLayout ? sharedTitleFadeProps : contentFadeProps;
}

function SpectrumBackIcon() {
  return (
    <span className="relative block size-4.5">
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 18 18"
        className={cn("absolute inset-0 block rotate-90", spectrumBackIconToneClassName)}
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
            ...spectrumBackIconStrokeTransition,
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
            ...spectrumBackIconStrokeTransition,
            delay: 0.02,
          }}
        />
      </motion.svg>
    </span>
  );
}

export function SpectrumPage() {
  const isPresent = useIsPresent();
  const { activeLayoutId, nowPlayingTrackName, playingPlaylistName, titleToneHandoff } =
    appLogicHook.useContext();
  const liveRenderData = {
    handoffTone:
      activeLayoutId && titleToneHandoff?.layoutId === activeLayoutId
        ? titleToneHandoff.tone
        : null,
    titleLayoutId: activeLayoutId ?? undefined,
    titleValue: resolveSpectrumTitle({
      nowPlayingTrackName,
      playingPlaylistName,
    }),
  } satisfies SpectrumRenderData;
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData, {
    isPresent,
    freezeOnExit: true,
  });
  const renderData = pageRenderFreeze.renderValue;

  function handleBackAction() {
    pageRenderFreeze.freeze();
    appLogicAction.back();
  }

  return (
    <div
      data-page-state="spectrum"
      className={cn(
        "relative mx-auto mt-12 px-12 flex w-7xl flex-col",
        !isPresent && "pointer-events-none",
      )}
    >
      <div className="relative z-20 flex flex-col">
        <motion.div {...contentFadeProps}>
          <button
            type="button"
            onClick={handleBackAction}
            className={cn(
              "group relative isolate inline-flex w-fit cursor-pointer select-none py-2 pr-2",
              "before:absolute before:inset-y-0 before:-left-2 before:right-0 before:-z-10",
              "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
              "before:[corner-shape:squircle_squircle_squircle_squircle]",
              "hover:before:bg-[#e5e5e5] dark:hover:before:bg-[#262626]",
            )}
          >
            <SpectrumBackIcon />
          </button>
        </motion.div>
        <motion.div
          {...resolveSpectrumTitleFadeProps({
            hasSharedTitleLayout: renderData.titleLayoutId !== undefined,
          })}
          className="flex items-center gap-4"
        >
          <EditableTitle
            className={collectionTitleClassName}
            handoffTone={renderData.handoffTone}
            interactionDisabled
            layoutId={renderData.titleLayoutId}
            style={{ fontFamily: "var(--font-noto-sans)" }}
            value={renderData.titleValue}
            onChange={ignoreSpectrumTitleChange}
          />
        </motion.div>
      </div>
    </div>
  );
}
