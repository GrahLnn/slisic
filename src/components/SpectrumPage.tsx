import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { collectionTitleClassName, collectionTitleLayoutTransition } from "./collectionTitle";
import { EditableTitle, type EditableTitleHandle } from "./EditableTitle";
import {
  resolveSpectrumBackActionVisualState,
  resolveSpectrumCommittedTitle,
  resolveSpectrumTitle,
  type SpectrumBackActionVisualState,
} from "./SpectrumPage.view-model";
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
  backActionVisualState: SpectrumBackActionVisualState;
  handoffTone: "solid" | "muted" | null;
  interactionDisabled: boolean;
  titleLayoutId?: string;
  titleValue: string;
};

export function resolveSpectrumTitleFadeProps(args: { hasSharedTitleLayout: boolean }) {
  return args.hasSharedTitleLayout ? sharedTitleFadeProps : contentFadeProps;
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function waitForTitleShareSourceReady() {
  await waitForNextFrame();
  await waitForNextFrame();
}

function SpectrumBackCheckIcon({ replayKey }: { replayKey: string }) {
  return (
    <motion.svg
      key={replayKey}
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className={cn("absolute inset-0 block", spectrumBackIconToneClassName)}
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
          ...spectrumBackIconStrokeTransition,
          delay: 0.02,
        }}
      />
    </motion.svg>
  );
}

function SpectrumBackArrowIcon({ replayKey }: { replayKey: string }) {
  return (
    <motion.svg
      key={replayKey}
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
  );
}

function SpectrumBackSymbolOwner({ visualState }: { visualState: SpectrumBackActionVisualState }) {
  return (
    <span className="absolute inset-0 block">
      {visualState.kind === "check" ? (
        <SpectrumBackCheckIcon replayKey={visualState.key} />
      ) : (
        <SpectrumBackArrowIcon replayKey={visualState.key} />
      )}
    </span>
  );
}

function SpectrumBackIcon({ visualState }: { visualState: SpectrumBackActionVisualState }) {
  return (
    <span className="relative block size-4.5">
      <AnimatePresence initial={false} mode="wait">
        <SpectrumBackSymbolOwner key={visualState.kind} visualState={visualState} />
      </AnimatePresence>
    </span>
  );
}

export function SpectrumPage() {
  const isPresent = useIsPresent();
  const editableTitleRef = useRef<EditableTitleHandle | null>(null);
  const [isBackNavigationPending, setIsBackNavigationPending] = useState(false);
  const {
    activeLayoutId,
    nowPlayingTrackName,
    playingPlaylistName,
    spectrumMusicTitleDraft,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const liveRenderData = {
    backActionVisualState: resolveSpectrumBackActionVisualState({
      musicTitleDraft: spectrumMusicTitleDraft,
    }),
    handoffTone:
      activeLayoutId && titleToneHandoff?.layoutId === activeLayoutId
        ? titleToneHandoff.tone
        : null,
    interactionDisabled: !isPresent || spectrumMusicTitleDraft === null,
    titleLayoutId: activeLayoutId ?? undefined,
    titleValue: resolveSpectrumTitle({
      musicTitleDraft: spectrumMusicTitleDraft,
      nowPlayingTrackName,
      playingPlaylistName,
    }),
  } satisfies SpectrumRenderData;
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData, {
    isPresent,
    freezeOnExit: true,
  });
  const renderData = pageRenderFreeze.renderValue;
  const isBackActionLocked = isBackNavigationPending;

  async function handleBackAction() {
    if (isBackActionLocked) {
      return;
    }

    setIsBackNavigationPending(true);

    try {
      const committedTitle = resolveSpectrumCommittedTitle({
        musicTitleDraft: spectrumMusicTitleDraft,
        renderedTitle: renderData.titleValue,
      });

      if (renderData.backActionVisualState.kind === "back") {
        pageRenderFreeze.freeze();
        appLogicAction.back();
        return;
      }

      await editableTitleRef.current?.commitResolvedValue({
        value: committedTitle.alias,
        animateTyping: committedTitle.kind !== "keep",
      });

      flushSync(() => {
        appLogicAction.changeSpectrumMusicTitle(committedTitle.alias);
        pageRenderFreeze.freeze({
          ...liveRenderData,
          titleValue: committedTitle.alias,
        });
      });
      await waitForTitleShareSourceReady();
      appLogicAction.back();
    } catch (error) {
      console.error("Failed to complete the spectrum back transition", error);
      setIsBackNavigationPending(false);
    }
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
            aria-disabled={isBackActionLocked}
            onClick={(event) => {
              if (isBackActionLocked) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }

              void handleBackAction();
            }}
            className={cn(
              "group relative isolate inline-flex w-fit select-none py-2 pr-2",
              isBackActionLocked ? "pointer-events-none cursor-default" : "cursor-pointer",
              "before:absolute before:inset-y-0 before:-left-2 before:right-0 before:-z-10",
              "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
              "before:[corner-shape:squircle_squircle_squircle_squircle]",
              "hover:before:bg-[#e5e5e5] dark:hover:before:bg-[#262626]",
            )}
          >
            <SpectrumBackIcon visualState={renderData.backActionVisualState} />
          </button>
        </motion.div>
        <motion.div
          {...resolveSpectrumTitleFadeProps({
            hasSharedTitleLayout: renderData.titleLayoutId !== undefined,
          })}
          className="flex items-center gap-4"
        >
          <EditableTitle
            ref={editableTitleRef}
            className={collectionTitleClassName}
            handoffTone={renderData.handoffTone}
            interactionDisabled={renderData.interactionDisabled}
            layoutId={renderData.titleLayoutId}
            style={{ fontFamily: "var(--font-noto-sans)" }}
            value={renderData.titleValue}
            onChange={appLogicAction.changeSpectrumMusicTitle}
          />
        </motion.div>
      </div>
    </div>
  );
}
