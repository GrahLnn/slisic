import { motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { collectionTitleLayoutTransition } from "./collectionTitle";
import { BackActionIcon } from "./ListConfig.back-action-icon";
import { resolveBackActionVisualState } from "./ListConfig.back-action";
import { EditableTitle } from "./EditableTitle";
import { usePageRenderFreeze } from "./usePageRenderFreeze";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

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
  const backActionVisualState = resolveBackActionVisualState({
    hasDraftChanges: false,
    isParsing: false,
  });

  function handleBackAction() {
    pageRenderFreeze.freeze();
    appLogicAction.back();
  }

  return (
    <div
      data-page-state="spectrum"
      className={cn(
        "relative mx-auto mt-24 flex w-160 flex-col",
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
            <BackActionIcon visualState={backActionVisualState} />
          </button>
        </motion.div>
        <motion.div {...contentFadeProps} className="flex items-center gap-4">
          <EditableTitle
            className={cn("text-4xl font-bold", "w-fit")}
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
