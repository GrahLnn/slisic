import { useLayoutEffect, useRef, useState } from "react";
import { motion, useIsPresent } from "motion/react";
import type { PlayList } from "@/src/cmd";
import {
  captureTitleShareFrames,
  recordTitleShareTrace,
} from "@/src/debug/titleShareTrace";
import type { MainStateT } from "@/src/flow/appLogic/events";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  playlistTitleLayoutId,
  resolvePlaylistsWithPreview,
} from "@/src/flow/appLogic/core";
import {
  action as appLogicAction,
  hook as appLogicHook,
} from "@/src/flow/appLogic";
import {
  collectionTitleClassName,
  collectionTitleLayoutTransition,
  CREATE_COLLECTION_TITLE,
  collectionTitleTextHoverClassName,
} from "./collectionTitle";
import {
  resolveTitleSharePageTransition,
  shouldSuppressTitleShareFade,
} from "@/src/flow/appLogic/titleShare";
import { PlayItem } from "./playItem";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

export type PlayListPageCommitGesture = "primary-and-secondary" | "secondary-only";

export function shouldCommitPlayListPageItem(args: {
  button: number;
  gesture: PlayListPageCommitGesture;
}) {
  return args.gesture === "primary-and-secondary"
    ? args.button === 0 || args.button === 2
    : args.button === 2;
}

export function shouldEnablePlayListPageTitleShare(
  pageState: MainStateT,
) {
  return pageState === "ready" || pageState === "play";
}

export function shouldRenderPlayListPageContent(args: {
  hasPlayList: boolean | null;
  visiblePlaylistCount: number;
  hasPendingPreview: boolean;
  hasActiveLayoutId: boolean;
  hasTitleToneHandoff: boolean;
}) {
  return (
    args.hasPlayList !== null ||
    args.visiblePlaylistCount > 0 ||
    args.hasPendingPreview ||
    args.hasActiveLayoutId ||
    args.hasTitleToneHandoff
  );
}

export function resolvePlayListPageItemFadeProps(args: {
  isPresent: boolean;
  suppressFade: boolean;
}) {
  if (args.suppressFade) {
    return {
      initial: contentFadeProps.animate,
      animate: contentFadeProps.animate,
    } as const;
  }

  return {
    initial: contentFadeProps.initial,
    animate: args.isPresent ? contentFadeProps.animate : contentFadeProps.exit,
  } as const;
}

export function resolvePlayListPageTexts(playlists: readonly PlayList[]) {
  return playlists.map((playlist) => playlist.name);
}

function PlayListPageItem({
  commitGesture,
  handoffTone,
  isCommitted = false,
  layoutId,
  onPrimaryCommit,
  onPrimaryPointerDown,
  suppressFade = false,
  text,
  onPointerDown,
  onCommit,
}: {
  commitGesture: PlayListPageCommitGesture;
  handoffTone?: CollectionTitleTone | null;
  isCommitted?: boolean;
  layoutId?: string;
  onPrimaryCommit?: () => void;
  onPrimaryPointerDown?: () => void;
  suppressFade?: boolean;
  text: string;
  onPointerDown?: () => void;
  onCommit: () => void;
}) {
  const isPresent = useIsPresent();
  const fadeProps = resolvePlayListPageItemFadeProps({
    isPresent,
    suppressFade,
  });

  const item = (
    <PlayItem
      className={collectionTitleClassName}
      handoffTone={handoffTone}
      layoutId={layoutId}
      traceRole={layoutId === CREATE_COLLECTION_LAYOUT_ID ? "playlist-create" : "playlist-item"}
      text={text}
      textClassName={isCommitted ? collectionTitleTextHoverClassName : undefined}
      onPointerDown={(event) => {
        if (event.button === 0) {
          onPrimaryPointerDown?.();
        }

        if (
          shouldCommitPlayListPageItem({
            button: event.button,
            gesture: commitGesture,
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
            gesture: commitGesture,
          })
        ) {
          onCommit();
        }
      }}
      onContextMenu={() => {
        if (
          shouldCommitPlayListPageItem({
            button: 2,
            gesture: commitGesture,
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
      transition={contentFadeProps.transition}
    >
      {item}
    </motion.div>
  );
}

function CreateNewItem({
  handoffTone,
  isCommitted,
  layoutId,
  onPointerDown,
  suppressFade,
}: {
  handoffTone?: CollectionTitleTone | null;
  isCommitted?: boolean;
  layoutId?: string;
  onPointerDown?: () => void;
  suppressFade?: boolean;
}) {
  return (
    <PlayListPageItem
      commitGesture="primary-and-secondary"
      handoffTone={handoffTone}
      isCommitted={isCommitted}
      layoutId={layoutId}
      onPointerDown={onPointerDown}
      suppressFade={suppressFade}
      text={CREATE_COLLECTION_TITLE}
      onCommit={() => {
        appLogicAction.openCreate();
      }}
    />
  );
}

export function PlayListPage() {
  const isPresent = useIsPresent();
  const livePageState = appLogicHook.useState();
  const liveContext = appLogicHook.useContext();
  const frozenSnapshotRef = useRef({
    pageState: livePageState,
    context: liveContext,
  });

  if (isPresent) {
    frozenSnapshotRef.current = {
      pageState: livePageState,
      context: liveContext,
    };
  }

  const pageState = isPresent
    ? livePageState
    : frozenSnapshotRef.current.pageState;
  const {
    activeLayoutId,
    hasPlayList,
    playlists,
    pendingPlaylistPreview,
    titleToneHandoff,
  } = isPresent ? liveContext : frozenSnapshotRef.current.context;
  const [pressedLayoutId, setPressedLayoutId] = useState<string | null>(null);
  const visiblePlaylists = resolvePlaylistsWithPreview(
    playlists,
    pendingPlaylistPreview,
  );
  const isTitleShareEnabled = pageState.match({
    ready: () => shouldEnablePlayListPageTitleShare("ready"),
    play: () => shouldEnablePlayListPageTitleShare("play"),
    _: () => false,
  });
  const texts = resolvePlayListPageTexts(visiblePlaylists);
  const transition = resolveTitleSharePageTransition({
    activeLayoutId,
    titleToneHandoff,
    pressedLayoutId,
  });
  const committedLayoutId = transition.committedLayoutId;
  const shouldRenderContent = shouldRenderPlayListPageContent({
    hasPlayList,
    visiblePlaylistCount: visiblePlaylists.length,
    hasPendingPreview: pendingPlaylistPreview !== null,
    hasActiveLayoutId: activeLayoutId !== null,
    hasTitleToneHandoff: titleToneHandoff !== null,
  });

  const itemComponents = visiblePlaylists.map((playlist, index) => {
    const text = texts[index] ?? playlist.name;
    const itemLayoutId = playlistTitleLayoutId(playlist.name);
    const handoffTone =
      transition.returnTargetLayoutId === itemLayoutId ? titleToneHandoff?.tone ?? null : null;
    const suppressFade = shouldSuppressTitleShareFade(itemLayoutId, transition);

    return (
      <PlayListPageItem
        key={playlist.name}
        commitGesture="secondary-only"
        handoffTone={handoffTone}
        isCommitted={committedLayoutId === itemLayoutId}
        layoutId={isTitleShareEnabled ? itemLayoutId : undefined}
        suppressFade={suppressFade}
        text={text}
        onPrimaryCommit={() => {
          appLogicAction.playPlaylist(playlist.name);
        }}
        onPointerDown={() => {
          setPressedLayoutId(itemLayoutId);
        }}
        onCommit={() => {
          appLogicAction.openPlaylist(playlist.name);
        }}
      />
    );
  });

  const shouldSuppressCreateFade = shouldSuppressTitleShareFade(
    CREATE_COLLECTION_LAYOUT_ID,
    transition,
  );

  useLayoutEffect(() => {
    const payload = {
      activeLayoutId,
      pressedLayoutId,
      outgoingSourceLayoutId: transition.outgoingSourceLayoutId,
      returnTargetLayoutId: transition.returnTargetLayoutId,
      committedLayoutId,
      playlists: playlists.map((playlist) => playlist.name),
      pendingPlaylistPreview: pendingPlaylistPreview
        ? {
            name: pendingPlaylistPreview.playlist.name,
            previousName: pendingPlaylistPreview.previousName,
          }
        : null,
      visiblePlaylists: visiblePlaylists.map((playlist) => playlist.name),
      visibleLayoutIds: visiblePlaylists.map((playlist) => playlistTitleLayoutId(playlist.name)),
      titleToneHandoffLayoutId: titleToneHandoff?.layoutId ?? null,
      titleToneHandoffTone: titleToneHandoff?.tone ?? null,
    };

    recordTitleShareTrace("playlist-page:render", payload);

    if (
      transition.returnTargetLayoutId ||
      pendingPlaylistPreview ||
      titleToneHandoff
    ) {
      captureTitleShareFrames("playlist-page:return", {
        frames: 30,
        payload,
      });
    }
  }, [
    activeLayoutId,
    committedLayoutId,
    pendingPlaylistPreview,
    playlists,
    pressedLayoutId,
    titleToneHandoff,
    transition.outgoingSourceLayoutId,
    transition.returnTargetLayoutId,
    visiblePlaylists,
  ]);

  return (
    <div
      data-title-trace-root="playlist-page"
      data-page-state="playlist"
      className="flex min-h-[calc(100vh-2rem)] flex-col items-center gap-8 px-6 pt-[40vh]"
      style={{ fontFamily: "var(--font-noto-sans)" }}
    >
      {shouldRenderContent
        ? [
            ...itemComponents,
            <CreateNewItem
              key="create"
              handoffTone={
                transition.returnTargetLayoutId === CREATE_COLLECTION_LAYOUT_ID
                  ? titleToneHandoff?.tone ?? null
                  : null
              }
              isCommitted={committedLayoutId === CREATE_COLLECTION_LAYOUT_ID}
              layoutId={
                isTitleShareEnabled ? CREATE_COLLECTION_LAYOUT_ID : undefined
              }
              suppressFade={shouldSuppressCreateFade}
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
