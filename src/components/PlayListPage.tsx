import { useState } from "react";
import { motion, useIsPresent } from "motion/react";
import { CREATE_COLLECTION_LAYOUT_ID } from "@/src/flow/appLogic/core";
import {
  action as appLogicAction,
  hook as appLogicHook,
} from "@/src/flow/appLogic";
import {
  collectionTitleClassName,
  collectionTitleLayoutTransition,
  collectionTitleTextHoverClassName,
} from "./collectionTitle";
import { PlayItem } from "./playItem";
import { usePageRenderFreeze } from "./usePageRenderFreeze";
import {
  resolvePlayListPageItemFadeProps,
  resolvePlayListPageViewModel,
  shouldCommitPlayListPageItem,
  type PlayListPageItemViewModel,
} from "./PlayListPage.view-model";

function PlayListPageItem({
  viewModel,
  onPrimaryCommit,
  onPrimaryPointerDown,
  onPointerDown,
  onCommit,
}: {
  viewModel: PlayListPageItemViewModel;
  onPrimaryCommit?: () => void;
  onPrimaryPointerDown?: () => void;
  onPointerDown?: () => void;
  onCommit: () => void;
}) {
  const isPresent = useIsPresent();
  const fadeProps = resolvePlayListPageItemFadeProps({
    isPresent,
    suppressFade: viewModel.suppressFade,
  });

  const item = (
    <PlayItem
      className={collectionTitleClassName}
      handoffTone={viewModel.handoffTone}
      layoutId={viewModel.layoutId}
      traceRole={
        viewModel.layoutId === CREATE_COLLECTION_LAYOUT_ID
          ? "playlist-create"
          : "playlist-item"
      }
      text={viewModel.text}
      textClassName={viewModel.isCommitted ? collectionTitleTextHoverClassName : undefined}
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
  );

  return (
    <motion.div
      initial={fadeProps.initial}
      animate={fadeProps.animate}
      transition={collectionTitleLayoutTransition}
    >
      {item}
    </motion.div>
  );
}

function CreateNewItem({
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

export function PlayListPage() {
  const isPresent = useIsPresent();
  const {
    activeLayoutId,
    hasPlayList,
    playlists,
    pendingPlaylistPreview,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const pageState = appLogicHook.useState();
  const [pressedLayoutId, setPressedLayoutId] = useState<string | null>(null);
  const pageStateValue = pageState.match({
    idle: () => "idle" as const,
    loading: () => "loading" as const,
    ready: () => "ready" as const,
    play: () => "play" as const,
    configLoading: () => "configLoading" as const,
    config: () => "config" as const,
    configUpdatingCollectionUpdates: () =>
      "configUpdatingCollectionUpdates" as const,
    error: () => "error" as const,
  });
  const liveRenderData = {
    pageState: pageStateValue,
    activeLayoutId,
    hasPlayList,
    playlists,
    pendingPlaylistPreview,
    titleToneHandoff,
    pressedLayoutId,
  } as const;
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData, {
    isPresent,
    freezeOnExit: true,
  });
  const renderData = pageRenderFreeze.renderValue;
  const viewModel = resolvePlayListPageViewModel(renderData);

  return (
    <div
      data-title-trace-root="playlist-page"
      data-page-state="playlist"
      className="flex min-h-[calc(100vh-2rem)] flex-col items-center gap-8 px-6 pt-[40vh]"
      style={{ fontFamily: "var(--font-noto-sans)" }}
    >
      {viewModel.shouldRenderContent
        ? [
            ...viewModel.itemViewModels.map((itemViewModel) => (
              <PlayListPageItem
                key={itemViewModel.key}
                viewModel={itemViewModel}
                onPrimaryCommit={() => {
                  if (!itemViewModel.playlistName) {
                    return;
                  }

                  appLogicAction.playPlaylist(itemViewModel.playlistName);
                }}
                onPointerDown={() => {
                  if (!itemViewModel.layoutId) {
                    return;
                  }

                  setPressedLayoutId(itemViewModel.layoutId);
                }}
                onCommit={() => {
                  if (!itemViewModel.playlistName) {
                    return;
                  }

                  appLogicAction.openPlaylist(itemViewModel.playlistName);
                }}
              />
            )),
            <CreateNewItem
              key={viewModel.createItemViewModel.key}
              viewModel={viewModel.createItemViewModel}
              onPointerDown={() => {
                setPressedLayoutId(CREATE_COLLECTION_LAYOUT_ID);
              }}
            />,
          ]
        : null}
      <div aria-hidden className="mt-[50vh] h-px w-full shrink-0" />
    </div>
  );
}
