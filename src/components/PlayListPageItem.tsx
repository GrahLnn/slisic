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
  return viewModel.titleHoverRetainLease === "stage-only" ? "none" : viewModel.titleHoverVisual;
}

export function resolvePlayListPageItemTitleHoverLock(args: {
  previousLocked: boolean;
  retainedVisual: "hold" | "none" | "retain";
  requestedVisual: "hold" | "none" | "retain";
  torphStage: TorphStage;
}) {
  if (args.retainedVisual !== "none") {
    return {
      locked: true,
      visual: args.retainedVisual,
    } as const;
  }

  if (args.requestedVisual !== "none") {
    return {
      locked: true,
      visual: args.requestedVisual,
    } as const;
  }

  if (args.previousLocked && args.torphStage !== "idle") {
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
  onExcludeCurrentMusic,
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
  onExcludeCurrentMusic?: () => void;
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
  const titleHoverLockedBeforeRender = titleHoverLockedUntilIdleRef.current;
  const retainedTitleHoverVisual = useCollectionTitleRetainedHoverVisual(
    requestedTitleHoverVisual,
    resolvePlayListPageItemTitleRetainKey(viewModel),
    resolvePlayListPageItemTitleRetainRequestKey(viewModel),
  );
  const titleHoverLock = resolvePlayListPageItemTitleHoverLock({
    previousLocked: titleHoverLockedBeforeRender,
    retainedVisual: retainedTitleHoverVisual,
    requestedVisual: viewModel.titleHoverVisual,
    torphStage,
  });
  titleHoverLockedUntilIdleRef.current = titleHoverLock.locked;
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
          torphDebugLabel="playlist-title"
          onExcludeCurrentMusic={onExcludeCurrentMusic}
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
            setTorphStage(stage);
            onTorphStageChange?.(stage);
          }}
          onPointerDown={(event) => {
            const shouldItemCommit = shouldCommitPlayListPageItem({
              button: event.button,
              gesture: viewModel.commitGesture,
            });

            if (event.button === 0) {
              onPrimaryPointerDown?.();
              onPrimaryCommit?.();
            }

            if (shouldItemCommit) {
              onPointerDown?.();
            }
          }}
          onClick={(event) => {
            const shouldFallbackPrimaryCommit = shouldFallbackPrimaryCommitOnClick({
              eventDetail: event.detail,
            });
            const shouldItemCommit = shouldCommitPlayListPageItem({
              button: 0,
              gesture: viewModel.commitGesture,
            });

            if (shouldFallbackPrimaryCommit) {
              onPrimaryCommit?.();
            }

            if (shouldItemCommit) {
              onCommit();
            }
          }}
          onContextMenu={() => {
            const shouldItemCommit = shouldCommitPlayListPageItem({
              button: 2,
              gesture: viewModel.commitGesture,
            });

            if (shouldItemCommit) {
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
  onCommit,
}: {
  viewModel: PlayListPageItemViewModel;
  onPointerDown?: () => void;
  onCommit?: () => void;
}) {
  return (
    <PlayListPageItem
      viewModel={viewModel}
      onPointerDown={onPointerDown}
      onCommit={() => {
        onCommit?.();
        appLogicAction.openCreate();
      }}
    />
  );
}
