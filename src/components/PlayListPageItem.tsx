import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { motion, useIsPresent } from "motion/react";
import type { TorphStage } from "@grahlnn/comps";
import { cn } from "@/lib/utils";
import { action as appLogicAction } from "@/src/flow/appLogic";
import {
  collectionTitleClassName,
  collectionTitleLayoutTransition,
  collectionTitleTextHoverClassName,
} from "./collectionTitle";
import { PlayItem } from "./playItem";
import {
  resolvePlayListPageItemFadeProps,
  shouldFallbackPrimaryCommitOnClick,
  shouldCommitPlayListPageItem,
  type PlayListPageItemViewModel,
} from "./PlayListPage.view-model";
import { resolvePlayListPageItemSlotPositionAnimationEnabled } from "./PlayListPageItem.motion";
import { recordPlaybackTrace } from "@/src/debug/playbackTrace";

export function PlayListPageItem({
  viewModel,
  containerRef,
  onPrimaryCommit,
  onPrimaryPointerDown,
  onPointerDown,
  onTorphStageChange,
  onCommit,
}: {
  viewModel: PlayListPageItemViewModel;
  containerRef?: Ref<HTMLDivElement>;
  onPrimaryCommit?: () => void;
  onPrimaryPointerDown?: () => void;
  onPointerDown?: () => void;
  onTorphStageChange?: (stage: TorphStage) => void;
  onCommit: () => void;
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
          layoutId={viewModel.layoutId}
          text={viewModel.text}
          textClassName={viewModel.isCommitted ? collectionTitleTextHoverClassName : undefined}
          onTorphStageChange={(stage) => {
            setTorphStage(stage);
            onTorphStageChange?.(stage);
          }}
          onPointerDown={(event) => {
            recordPlaybackTrace("playlist-item-pointer-down", {
              button: event.button,
              key: viewModel.key,
              text: viewModel.text,
              playlistName: viewModel.playlistName ?? null,
              isHiddenInPlay: viewModel.isHiddenInPlay,
              isPlaybackTarget: viewModel.isPlaybackTarget,
              shouldAnimateSlotPosition: viewModel.shouldAnimateSlotPosition,
              torphStage,
            });

            if (event.button === 0) {
              recordPlaybackTrace("playlist-item-primary-pointer-commit", {
                key: viewModel.key,
                playlistName: viewModel.playlistName ?? null,
                text: viewModel.text,
              });
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
            recordPlaybackTrace("playlist-item-click", {
              detail: event.detail,
              key: viewModel.key,
              text: viewModel.text,
              playlistName: viewModel.playlistName ?? null,
              isHiddenInPlay: viewModel.isHiddenInPlay,
              isPlaybackTarget: viewModel.isPlaybackTarget,
              torphStage,
            });

            if (shouldFallbackPrimaryCommitOnClick({ eventDetail: event.detail })) {
              recordPlaybackTrace("playlist-item-primary-click-fallback", {
                key: viewModel.key,
                playlistName: viewModel.playlistName ?? null,
                text: viewModel.text,
              });
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
