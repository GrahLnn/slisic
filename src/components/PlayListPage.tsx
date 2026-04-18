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
import { PlayItem } from "./playItem";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

export function resolvePlayListPageTexts(playlists: readonly PlayList[]) {
  return playlists.map((playlist) => playlist.name);
}

function PlayListPageItem({
  handoffTone,
  layoutId,
  suppressFade = false,
  text,
  onCommit,
}: {
  handoffTone?: CollectionTitleTone | null;
  layoutId: string;
  suppressFade?: boolean;
  text: string;
  onCommit: () => void;
}) {
  const isPresent = useIsPresent();
  const [isCommitted, setIsCommitted] = useState(false);

  const item = (
    <PlayItem
      className={collectionTitleClassName}
      handoffTone={handoffTone}
      layoutId={layoutId}
      text={text}
      textClassName={isCommitted ? collectionTitleTextHoverClassName : undefined}
      onPointerDown={() => {
        setIsCommitted(true);
      }}
      onClick={() => {
        setIsCommitted(true);
        onCommit();
      }}
    />
  );

  if (suppressFade) {
    return item;
  }

  return (
    <motion.div
      initial={contentFadeProps.initial}
      animate={isPresent ? contentFadeProps.animate : contentFadeProps.exit}
      transition={contentFadeProps.transition}
    >
      {item}
    </motion.div>
  );
}

function CreateNewItem({
  handoffTone,
  suppressFade,
}: {
  handoffTone?: CollectionTitleTone | null;
  suppressFade?: boolean;
}) {
  return (
    <PlayListPageItem
      handoffTone={handoffTone}
      layoutId={CREATE_COLLECTION_LAYOUT_ID}
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
  const texts = resolvePlayListPageTexts(playlists);

  const itemComponents = playlists.map((playlist, index) => {
    const text = texts[index] ?? playlist.name;
    const layoutId = playlistTitleLayoutId(playlist.name);
    const handoffTone =
      titleToneHandoff?.layoutId === layoutId ? titleToneHandoff.tone : null;
    const suppressFade =
      activeLayoutId === layoutId || titleToneHandoff?.layoutId === layoutId;

    return (
      <PlayListPageItem
        key={playlist.name}
        handoffTone={handoffTone}
        layoutId={layoutId}
        suppressFade={suppressFade}
        text={text}
        onCommit={() => {
          appLogicAction.openPlaylist(playlist.name);
        }}
      />
    );
  });

  const shouldSuppressCreateFade =
    activeLayoutId === CREATE_COLLECTION_LAYOUT_ID ||
    titleToneHandoff?.layoutId === CREATE_COLLECTION_LAYOUT_ID;

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
            titleToneHandoff?.layoutId === CREATE_COLLECTION_LAYOUT_ID
              ? titleToneHandoff.tone
              : null
          }
          suppressFade={shouldSuppressCreateFade}
        />,
      ]}
      <div aria-hidden className="mt-[50vh] h-px w-full shrink-0" />
    </div>
  );
}
