import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { motion, useIsPresent } from "motion/react";
import type { TorphStage } from "@grahlnn/comps";
import { cn } from "@/lib/utils";
import { action as appLogicAction } from "@/src/flow/appLogic";
import {
  collectionTitleClassName,
  collectionTitleLayoutTransition,
  collectionTitleTextHoverClassName,
  collectionTitleTextRetainHoverClassName,
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
}) {
  const isPresent = useIsPresent();
  const [torphStage, setTorphStage] = useState<TorphStage>("idle");
  const previousTextRef = useRef(viewModel.text);
  const textChanged = previousTextRef.current !== viewModel.text;
  const fadeProps = resolvePlayListPageItemFadeProps({
    isPresent,
    suppressFade: viewModel.suppressFade,
  });

  useLayoutEffect(() => {
    previousTextRef.current = viewModel.text;
  }, [viewModel.text]);

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
  const titleHoverClassName =
    viewModel.titleHoverVisual === "hold"
      ? collectionTitleTextHoverClassName
      : viewModel.titleHoverVisual === "retain"
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
          className={collectionTitleClassName}
          handoffTone={viewModel.handoffTone}
          isPlaybackPreparing={viewModel.isPlaybackPreparing}
          layoutId={titleProjectionLayoutId}
          playbackIconWidthText={viewModel.playbackIconWidthText}
          showPlaybackIcons={viewModel.shouldShowPlaybackIcons}
          text={viewModel.text}
          textClassName={titleHoverClassName}
          titleHoverTraceOwner="playlist-page"
          titleHoverVisual={viewModel.titleHoverVisual}
          onOpenSpectrum={onOpenSpectrum}
          onOpenSpectrumPointerDown={onOpenSpectrumPointerDown}
          onTorphStageChange={(stage) => {
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
