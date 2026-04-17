import { useState } from "react";
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
  CREATE_COLLECTION_TITLE,
  collectionTitleTextHoverClassName,
} from "./collectionTitle";
import { PlayItem } from "./playItem";

export function resolvePlayListPageTexts(playlists: readonly PlayList[]) {
  return playlists.map((playlist) => playlist.name);
}

function CreateNewItem({
  handoffTone,
}: {
  handoffTone?: CollectionTitleTone | null;
}) {
  const [isCommitted, setIsCommitted] = useState(false);

  return (
    <PlayItem
      className={collectionTitleClassName}
      handoffTone={handoffTone}
      layoutId={CREATE_COLLECTION_LAYOUT_ID}
      text={CREATE_COLLECTION_TITLE}
      textClassName={isCommitted ? collectionTitleTextHoverClassName : undefined}
      onPointerDown={() => {
        setIsCommitted(true);
      }}
      onClick={() => {
        setIsCommitted(true);
        appLogicAction.openCreate();
      }}
    />
  );
}

export function PlayListPage() {
  const { playlists, titleToneHandoff } = appLogicHook.useContext();
  const texts = resolvePlayListPageTexts(playlists);

  const itemComponents = playlists.map((playlist, index) => {
    const text = texts[index] ?? playlist.name;
    const layoutId = playlistTitleLayoutId(playlist.name);
    const handoffTone =
      titleToneHandoff?.layoutId === layoutId ? titleToneHandoff.tone : null;

    return (
      <div key={playlist.name}>
        <PlayItem
          className={collectionTitleClassName}
          handoffTone={handoffTone}
          layoutId={layoutId}
          text={text}
          onClick={() => {
            appLogicAction.openPlaylist(playlist.name);
          }}
        />
      </div>
    );
  });

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
        />,
      ]}
      <div aria-hidden className="mt-[50vh] h-px w-full shrink-0" />
    </div>
  );
}
