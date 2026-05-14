import { useRef, useState, type Ref } from "react";
import { motion, useIsPresent } from "motion/react";
import type { TorphStage } from "@grahlnn/comps";
import { cn } from "@/lib/utils";
import { action as appLogicAction } from "@/src/flow/appLogic";
import {
  collectionTitleClassName,
  collectionTitleLayoutTransition,
  collectionTitleTextClassName,
  collectionTitleTextRetainHoverClassName,
  useCollectionTitleRetainedHoverVisual,
} from "./collectionTitle";
import { PlayItem } from "./playItem";
import {
  resolvePlayListPageItemFadeProps,
  shouldFallbackPrimaryCommitOnClick,
  shouldCommitPlayListPageItem,
  type PlayListPageItemViewModel,
} from "./PlayListPage.view-model";
import {
  resolvePlayListPageItemSlotPositionAnimationEnabled,
  resolvePlayListPageItemTitleProjectionLayoutId,
} from "./PlayListPageItem.motion";

export function resolvePlayListPageItemTitleFrameClassName(titleHoverClassName?: string) {
  return cn(collectionTitleClassName, collectionTitleTextClassName, titleHoverClassName);
}

export function resolvePlayListPageItemTitleRetainKey(
  viewModel: Pick<
    PlayListPageItemViewModel,
    "key" | "layoutId" | "playlistName" | "sourceLayoutId"
  >,
) {
  return viewModel.sourceLayoutId ?? viewModel.layoutId ?? viewModel.playlistName ?? viewModel.key;
}

export function resolvePlayListPageItemTitleRetainRequestKey(
  viewModel: Pick<
    PlayListPageItemViewModel,
    "key" | "layoutId" | "playlistName" | "sourceLayoutId" | "text"
  >,
) {
  return `${resolvePlayListPageItemTitleRetainKey(viewModel)}:${viewModel.text}`;
}

export function resolvePlayListPageItemRequestedTitleHoverVisual(
  viewModel: Pick<PlayListPageItemViewModel, "titleHoverRetainLease" | "titleHoverVisual">,
) {
  if (viewModel.titleHoverRetainLease === "stage-only") {
    return "none";
  }

  return viewModel.titleHoverVisual;
}

export function resolvePlayListPageItemDirectTitleHoverVisual(
  viewModel: Pick<PlayListPageItemViewModel, "titleHoverRetainLease" | "titleHoverVisual">,
) {
  if (viewModel.titleHoverRetainLease === "timed") {
    return "none";
  }

  return viewModel.titleHoverVisual;
}

export function resolvePlayListPageItemTitleHoverLock(args: {
  hasStageLock: boolean;
  retainedVisual: "hold" | "none" | "retain";
  directVisual: "hold" | "none" | "retain";
  torphStage: TorphStage;
}) {
  if (args.retainedVisual !== "none") {
    return {
      locked: true,
      visual: args.retainedVisual,
    } as const;
  }

  if (args.directVisual !== "none") {
    return {
      locked: true,
      visual: args.directVisual,
    } as const;
  }

  if (args.hasStageLock && args.torphStage !== "idle") {
    return {
      locked: true,
      visual: "retain",
    } as const;
  }

  return {
    locked: false,
    visual: "none",
  } as const;
}

export function resolvePlayListPageItemNextStageHoverLock(args: {
  currentLocked: boolean;
  directVisual: "hold" | "none" | "retain";
  torphStage: TorphStage;
}) {
  if (args.directVisual !== "none") {
    return true;
  }

  return args.currentLocked && args.torphStage !== "idle";
}

export function resolvePlayListPageItemCommittedText(args: {
  currentCommittedText: string;
  nextText: string;
  torphStage: TorphStage;
}) {
  return args.torphStage === "idle" ? args.nextText : args.currentCommittedText;
}

export function PlayListPageItem({
  viewModel,
  containerRef,
  onPrimaryCommit,
  onPrimaryPointerDown,
  onPointerDown,
  onTorphStageChange,
  onCommit,
  onOpenSpectrum,
  onOpenSpectrumPointerDown,
  onLayoutAnimationComplete,
}: {
  viewModel: PlayListPageItemViewModel;
  containerRef?: Ref<HTMLDivElement>;
  onPrimaryCommit?: () => void;
  onPrimaryPointerDown?: () => void;
  onPointerDown?: () => void;
  onTorphStageChange?: (stage: TorphStage) => void;
  onCommit: () => void;
  onOpenSpectrum?: () => void;
  onOpenSpectrumPointerDown?: () => void;
  onLayoutAnimationComplete?: (layoutId?: string) => void;
}) {
  const isPresent = useIsPresent();
  const [torphStage, setTorphStage] = useState<TorphStage>("idle");
  const committedTextRef = useRef(viewModel.text);
  const committedText = committedTextRef.current;
  const titleHoverLockedUntilIdleRef = useRef(false);
  const textChanged = committedText !== viewModel.text;
  const fadeProps = resolvePlayListPageItemFadeProps({
    isPresent,
    suppressFade: viewModel.suppressFade,
  });

  const shouldEnableSlotPositionAnimation = resolvePlayListPageItemSlotPositionAnimationEnabled({
    requested: viewModel.shouldAnimateSlotPosition,
    torphStage,
    textChanged,
  });
  const titleProjectionLayoutId = resolvePlayListPageItemTitleProjectionLayoutId({
    layoutId: viewModel.layoutId,
    torphStage,
    textChanged,
  });
  const requestedTitleHoverVisual = resolvePlayListPageItemRequestedTitleHoverVisual(viewModel);
  const retainedTitleHoverVisual = useCollectionTitleRetainedHoverVisual(
    requestedTitleHoverVisual,
    resolvePlayListPageItemTitleRetainKey(viewModel),
    resolvePlayListPageItemTitleRetainRequestKey(viewModel),
  );
  const directTitleHoverVisual = resolvePlayListPageItemDirectTitleHoverVisual(viewModel);
  const titleHoverLock = resolvePlayListPageItemTitleHoverLock({
    hasStageLock: titleHoverLockedUntilIdleRef.current,
    retainedVisual: retainedTitleHoverVisual,
    directVisual: directTitleHoverVisual,
    torphStage,
  });
  const titleHoverVisual = titleHoverLock.visual;
  const titleHoverClassName =
    titleHoverVisual === "hold" || titleHoverVisual === "retain"
      ? collectionTitleTextRetainHoverClassName
      : undefined;

  return (
    <motion.div
      ref={containerRef}
      layout={shouldEnableSlotPositionAnimation ? "position" : false}
      className="shrink-0 snap-center"
      initial={fadeProps.initial}
      animate={fadeProps.animate}
      transition={collectionTitleLayoutTransition}
    >
      <motion.div
        className={cn(viewModel.isHiddenInPlay && "pointer-events-none select-none")}
        initial={
          viewModel.shouldStartHiddenInPlay ? { filter: "blur(6px)", opacity: 0 } : undefined
        }
        animate={
          viewModel.isHiddenInPlay
            ? { filter: "blur(6px)", opacity: 0 }
            : { filter: "blur(0px)", opacity: 1 }
        }
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        <PlayItem
          className={resolvePlayListPageItemTitleFrameClassName(titleHoverClassName)}
          handoffTone={viewModel.handoffTone}
          isPlaybackPreparing={viewModel.isPlaybackPreparing}
          layoutId={titleProjectionLayoutId}
          playbackIconWidthText={viewModel.playbackIconWidthText}
          showPlaybackIcons={viewModel.shouldShowPlaybackIcons}
          text={viewModel.text}
          textClassName={titleHoverClassName}
          onOpenSpectrum={onOpenSpectrum}
          onOpenSpectrumPointerDown={onOpenSpectrumPointerDown}
          onTitleLayoutAnimationComplete={onLayoutAnimationComplete}
          onTorphStageChange={(stage) => {
            const nextCommittedText = resolvePlayListPageItemCommittedText({
              currentCommittedText: committedTextRef.current,
              nextText: viewModel.text,
              torphStage: stage,
            });
            committedTextRef.current = nextCommittedText;
            titleHoverLockedUntilIdleRef.current = resolvePlayListPageItemNextStageHoverLock({
              currentLocked: titleHoverLockedUntilIdleRef.current,
              directVisual: resolvePlayListPageItemDirectTitleHoverVisual(viewModel),
              torphStage: stage,
            });
            setTorphStage(stage);
            onTorphStageChange?.(stage);
          }}
          onPointerDown={(event) => {
            if (event.button === 0) {
              onPrimaryPointerDown?.();
              onPrimaryCommit?.();
            }

            if (
              shouldCommitPlayListPageItem({
                button: event.button,
                gesture: viewModel.commitGesture,
              })
            ) {
              onPointerDown?.();
            }
          }}
          onClick={(event) => {
            if (shouldFallbackPrimaryCommitOnClick({ eventDetail: event.detail })) {
              onPrimaryCommit?.();
            }

            if (
              shouldCommitPlayListPageItem({
                button: 0,
                gesture: viewModel.commitGesture,
              })
            ) {
              onCommit();
            }
          }}
          onContextMenu={() => {
            if (
              shouldCommitPlayListPageItem({
                button: 2,
                gesture: viewModel.commitGesture,
              })
            ) {
              onCommit();
            }
          }}
        />
      </motion.div>
    </motion.div>
  );
}

export function CreateNewPlayListItem({
  viewModel,
  onPointerDown,
}: {
  viewModel: PlayListPageItemViewModel;
  onPointerDown?: () => void;
}) {
  return (
    <PlayListPageItem
      viewModel={viewModel}
      onPointerDown={onPointerDown}
      onCommit={() => {
        appLogicAction.openCreate();
      }}
    />
  );
}
