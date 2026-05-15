import { useRef, useState, type Ref } from "react";
import { motion, useIsPresent } from "motion/react";
import type { TorphStage } from "@grahlnn/comps";
import { cn } from "@/lib/utils";
import { recordRenderPerformanceTrace } from "@/src/debug/renderPerformanceTrace";
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

type PlayListPageItemTraceViewModel = Pick<
  PlayListPageItemViewModel,
  | "key"
  | "text"
  | "layoutId"
  | "sourceLayoutId"
  | "playlistName"
  | "handoffTone"
  | "suppressFade"
  | "isPlaybackTarget"
  | "shouldShowPlaybackIcons"
  | "playbackIconWidthText"
  | "isPlaybackPreparing"
  | "isHiddenInPlay"
  | "shouldStartHiddenInPlay"
  | "shouldAnimateSlotPosition"
  | "titleHoverVisual"
  | "titleHoverRetainLease"
  | "commitGesture"
>;

function createPlayListPageItemTraceIdentity(viewModel: PlayListPageItemTraceViewModel) {
  return {
    key: viewModel.key,
    playlistName: viewModel.playlistName ?? null,
    layoutId: viewModel.layoutId ?? null,
    sourceLayoutId: viewModel.sourceLayoutId ?? null,
    retainKey: resolvePlayListPageItemTitleRetainKey(viewModel),
    retainRequestKey: resolvePlayListPageItemTitleRetainRequestKey(viewModel),
  };
}

function createPlayListPageItemTraceViewModel(viewModel: PlayListPageItemTraceViewModel) {
  return {
    text: viewModel.text,
    handoffTone: viewModel.handoffTone,
    suppressFade: viewModel.suppressFade,
    isPlaybackTarget: viewModel.isPlaybackTarget,
    shouldShowPlaybackIcons: viewModel.shouldShowPlaybackIcons,
    playbackIconWidthText: viewModel.playbackIconWidthText ?? null,
    isPlaybackPreparing: viewModel.isPlaybackPreparing,
    isHiddenInPlay: viewModel.isHiddenInPlay,
    shouldStartHiddenInPlay: viewModel.shouldStartHiddenInPlay,
    shouldAnimateSlotPosition: viewModel.shouldAnimateSlotPosition,
    titleHoverVisual: viewModel.titleHoverVisual,
    titleHoverRetainLease: viewModel.titleHoverRetainLease,
    commitGesture: viewModel.commitGesture,
  };
}

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
  const traceIdentity = createPlayListPageItemTraceIdentity(viewModel);

  recordRenderPerformanceTrace("playlist-title-item-render", {
    identity: traceIdentity,
    viewModel: createPlayListPageItemTraceViewModel(viewModel),
    torph: {
      stage: torphStage,
      committedText,
      textChanged,
      titleProjectionLayoutId: titleProjectionLayoutId ?? null,
      shouldEnableSlotPositionAnimation,
    },
    hover: {
      requestedTitleHoverVisual,
      retainedTitleHoverVisual,
      lockInput: {
        previousLocked: titleHoverLockedBeforeRender,
        requestedVisual: viewModel.titleHoverVisual,
        torphStage,
      },
      lockOutput: titleHoverLock,
      lockedAfterRender: titleHoverLockedUntilIdleRef.current,
      visual: titleHoverVisual,
      hasClassName: titleHoverClassName !== undefined,
    },
  });

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
          torphDebugMeta={{
            identity: traceIdentity,
            text: viewModel.text,
            committedText,
            torphStage,
            titleHoverVisual,
            titleHoverRetainLease: viewModel.titleHoverRetainLease,
            titleProjectionLayoutId: titleProjectionLayoutId ?? null,
            shouldEnableSlotPositionAnimation,
          }}
          onOpenSpectrum={onOpenSpectrum}
          onOpenSpectrumPointerDown={onOpenSpectrumPointerDown}
          onTitleLayoutAnimationComplete={onLayoutAnimationComplete}
          onTorphStageChange={(stage) => {
            const nextCommittedText = resolvePlayListPageItemCommittedText({
              currentCommittedText: committedTextRef.current,
              nextText: viewModel.text,
              torphStage: stage,
            });
            recordRenderPerformanceTrace("playlist-title-item-torph-stage", {
              identity: traceIdentity,
              stage,
              previousStage: torphStage,
              text: viewModel.text,
              committedTextBefore: committedTextRef.current,
              committedTextAfter: nextCommittedText,
              textChangedBefore: committedTextRef.current !== viewModel.text,
              titleHoverLockedBefore: titleHoverLockedUntilIdleRef.current,
              titleHoverVisual,
              titleHoverRetainLease: viewModel.titleHoverRetainLease,
            });
            committedTextRef.current = nextCommittedText;
            setTorphStage(stage);
            onTorphStageChange?.(stage);
          }}
          onPointerDown={(event) => {
            const shouldPrimaryCommit = event.button === 0;
            const shouldItemCommit = shouldCommitPlayListPageItem({
              button: event.button,
              gesture: viewModel.commitGesture,
            });

            recordRenderPerformanceTrace("playlist-title-item-pointerdown", {
              identity: traceIdentity,
              button: event.button,
              detail: event.detail,
              shouldPrimaryCommit,
              shouldItemCommit,
              viewModel: createPlayListPageItemTraceViewModel(viewModel),
              torphStage,
              titleHoverVisual,
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

            recordRenderPerformanceTrace("playlist-title-item-click", {
              identity: traceIdentity,
              button: 0,
              detail: event.detail,
              shouldFallbackPrimaryCommit,
              shouldItemCommit,
              viewModel: createPlayListPageItemTraceViewModel(viewModel),
              torphStage,
              titleHoverVisual,
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

            recordRenderPerformanceTrace("playlist-title-item-contextmenu", {
              identity: traceIdentity,
              button: 2,
              shouldItemCommit,
              viewModel: createPlayListPageItemTraceViewModel(viewModel),
              torphStage,
              titleHoverVisual,
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
