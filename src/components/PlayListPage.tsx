import { useState } from "react";
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
import { PlayItem } from "./playItem";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

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
  handoffTone,
  isCommitted = false,
  layoutId,
  suppressFade = false,
  text,
  onPointerDown,
  onCommit,
}: {
  handoffTone?: CollectionTitleTone | null;
  isCommitted?: boolean;
  layoutId: string;
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
      onPointerDown={() => {
        onPointerDown?.();
      }}
      onClick={() => {
        onCommit();
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
  onPointerDown,
  suppressFade,
}: {
  handoffTone?: CollectionTitleTone | null;
  isCommitted?: boolean;
  onPointerDown?: () => void;
  suppressFade?: boolean;
}) {
  return (
    <PlayListPageItem
      handoffTone={handoffTone}
      isCommitted={isCommitted}
      layoutId={CREATE_COLLECTION_LAYOUT_ID}
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
    const layoutId = playlistTitleLayoutId(playlist.name);
    const handoffTone =
      transition.returnTargetLayoutId === layoutId ? titleToneHandoff?.tone ?? null : null;
    const suppressFade = shouldSuppressPlayListPageItemFade(layoutId, transition);

    return (
      <PlayListPageItem
        key={playlist.name}
        handoffTone={handoffTone}
        isCommitted={committedLayoutId === layoutId}
        layoutId={layoutId}
        suppressFade={suppressFade}
        text={text}
        onPointerDown={() => {
          setPressedLayoutId(layoutId);
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

  return (
    <div
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
