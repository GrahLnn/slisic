import { useLayoutEffect, useState } from "react";
import { motion, useIsPresent } from "motion/react";
import type { PlayList } from "@/src/cmd";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  playlistTitleLayoutId,
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
  resolvePlayListPageCommittedLayoutId,
  resolvePlayListPageTransitionViewModel,
  shouldSuppressPlayListPageItemFade,
} from "./PlayListPage.view-model";
import {
  captureTitleShareFrames,
  recordTitleShareTrace,
  snapshotTitleShareNodes,
} from "@/src/debug/titleShareTrace";
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
  suppressFade = false,
  text,
  onPointerDown,
  onCommit,
}: {
  commitGesture: PlayListPageCommitGesture;
  handoffTone?: CollectionTitleTone | null;
  isCommitted?: boolean;
  layoutId?: string;
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
      text={text}
      textClassName={isCommitted ? collectionTitleTextHoverClassName : undefined}
      onPointerDown={(event) => {
        if (
          shouldCommitPlayListPageItem({
            button: event.button,
            gesture: commitGesture,
          })
        ) {
          recordTitleShareTrace("playlist-page:item-pointerdown", {
            layoutId: layoutId ?? null,
            text,
            button: event.button,
            gesture: commitGesture,
          });
          onPointerDown?.();
        }
      }}
      onClick={() => {
        if (
          shouldCommitPlayListPageItem({
            button: 0,
            gesture: commitGesture,
          })
        ) {
          recordTitleShareTrace("playlist-page:item-commit", {
            layoutId: layoutId ?? null,
            text,
            trigger: "click",
            gesture: commitGesture,
          });
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
          recordTitleShareTrace("playlist-page:item-commit", {
            layoutId: layoutId ?? null,
            text,
            trigger: "contextmenu",
            gesture: commitGesture,
          });
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
  const { activeLayoutId, playlists, titleToneHandoff } = appLogicHook.useContext();
  const [pressedLayoutId, setPressedLayoutId] = useState<string | null>(null);
  const texts = resolvePlayListPageTexts(playlists);
  const transition = resolvePlayListPageTransitionViewModel({
    activeLayoutId,
    titleToneHandoff,
  });
  const committedLayoutId = resolvePlayListPageCommittedLayoutId({
    pressedLayoutId,
    transition,
  });

  const itemComponents = playlists.map((playlist, index) => {
    const text = texts[index] ?? playlist.name;
    const itemLayoutId = playlistTitleLayoutId(playlist.name);
    const handoffTone =
      transition.returnTargetLayoutId === itemLayoutId ? titleToneHandoff?.tone ?? null : null;
    const suppressFade = shouldSuppressPlayListPageItemFade(itemLayoutId, transition);

    return (
      <PlayListPageItem
        key={playlist.name}
        commitGesture="secondary-only"
        handoffTone={handoffTone}
        isCommitted={committedLayoutId === itemLayoutId}
        layoutId={itemLayoutId}
        suppressFade={suppressFade}
        text={text}
        onPointerDown={() => {
          setPressedLayoutId(itemLayoutId);
        }}
        onCommit={() => {
          appLogicAction.openPlaylist(playlist.name);
        }}
      />
    );
  });

  const shouldSuppressCreateFade = shouldSuppressPlayListPageItemFade(
    CREATE_COLLECTION_LAYOUT_ID,
    transition,
  );

  useLayoutEffect(() => {
    if (
      !transition.outgoingSourceLayoutId &&
      !transition.returnTargetLayoutId
    ) {
      return;
    }

    recordTitleShareTrace("playlist-page:return-layout", {
      activeLayoutId,
      pressedLayoutId,
      committedLayoutId,
      outgoingSourceLayoutId: transition.outgoingSourceLayoutId,
      returnTargetLayoutId: transition.returnTargetLayoutId,
      titleToneHandoffLayoutId: titleToneHandoff?.layoutId ?? null,
      titleToneHandoffTone: titleToneHandoff?.tone ?? null,
      playlistNames: playlists.map((playlist) => ({
        name: playlist.name,
        layoutId: playlistTitleLayoutId(playlist.name),
      })),
      titleNodes: snapshotTitleShareNodes(),
    });
    captureTitleShareFrames("playlist-page:return-layout", {
      frames: 24,
      payload: {
        activeLayoutId,
        committedLayoutId,
        outgoingSourceLayoutId: transition.outgoingSourceLayoutId,
        returnTargetLayoutId: transition.returnTargetLayoutId,
      },
    });
  }, [
    activeLayoutId,
    committedLayoutId,
    playlists,
    pressedLayoutId,
    titleToneHandoff,
    transition.outgoingSourceLayoutId,
    transition.returnTargetLayoutId,
  ]);

  return (
    <div
      data-title-trace-root="playlist-page"
      data-page-state="playlist"
      data-title-trace-active-layout-id={activeLayoutId ?? undefined}
      data-title-trace-pressed-layout-id={pressedLayoutId ?? undefined}
      data-title-trace-committed-layout-id={committedLayoutId ?? undefined}
      data-title-trace-outgoing-layout-id={transition.outgoingSourceLayoutId ?? undefined}
      data-title-trace-return-layout-id={transition.returnTargetLayoutId ?? undefined}
      className="flex min-h-[calc(100vh-2rem)] flex-col items-center gap-8 px-6 pt-[40vh]"
      style={{ fontFamily: "var(--font-noto-sans)" }}
    >
      {[
        ...itemComponents,
        <CreateNewItem
          key="create"
          handoffTone={
            transition.returnTargetLayoutId === CREATE_COLLECTION_LAYOUT_ID
              ? titleToneHandoff?.tone ?? null
              : null
          }
          isCommitted={committedLayoutId === CREATE_COLLECTION_LAYOUT_ID}
          layoutId={CREATE_COLLECTION_LAYOUT_ID}
          suppressFade={shouldSuppressCreateFade}
          onPointerDown={() => {
            setPressedLayoutId(CREATE_COLLECTION_LAYOUT_ID);
          }}
        />,
      ]}
      <div aria-hidden className="mt-[50vh] h-px w-full shrink-0" />
    </div>
  );
}
