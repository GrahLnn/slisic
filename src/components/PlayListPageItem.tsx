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
import {
  PlayItem,
  resolvePlayItemLayoutAnimationEnabled,
} from "./playItem";
import {
  resolvePlayListPageItemFadeProps,
  shouldCommitPlayListPageItem,
  type PlayListPageItemViewModel,
} from "./PlayListPage.view-model";

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

  const shouldEnableLayoutAnimation = resolvePlayItemLayoutAnimationEnabled({
    requested: viewModel.shouldAnimateLayoutPosition,
    torphStage,
    textChanged,
  });

  return (
    <motion.div
      ref={containerRef}
      layout={shouldEnableLayoutAnimation ? "position" : false}
      className="shrink-0 snap-center"
      initial={fadeProps.initial}
      animate={fadeProps.animate}
      transition={collectionTitleLayoutTransition}
    >
      <motion.div
        className={cn(
          viewModel.isHiddenInPlay && "pointer-events-none select-none",
        )}
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
          shouldAnimateLayoutPosition={shouldEnableLayoutAnimation}
          text={viewModel.text}
          textClassName={
            viewModel.isCommitted ? collectionTitleTextHoverClassName : undefined
          }
          onTorphStageChange={(stage) => {
            setTorphStage(stage);
            onTorphStageChange?.(stage);
          }}
          onPointerDown={(event) => {
            if (event.button === 0) {
              onPrimaryPointerDown?.();
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
          onClick={() => {
            onPrimaryCommit?.();

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
