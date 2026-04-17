import { useRef, useState } from "react";
import type { Collection } from "@/src/cmd";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  CREATE_COLLECTION_LAYOUT_ID,
  collectionTitleLayoutId,
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

type PlayListTextOverrides = Record<string, string>;

export function resolvePlayListPageTexts(
  collections: readonly Collection[],
  textOverrides: Readonly<PlayListTextOverrides>,
) {
  return collections.map((collection) => textOverrides[collection.url] ?? collection.name);
}

export function resolveNextPlayListTextOverrides(args: {
  collections: readonly Collection[];
  textOverrides: Readonly<PlayListTextOverrides>;
  clickedCollectionUrl: string;
}) {
  const nextOverrides = Object.fromEntries(
    args.collections.flatMap((collection) => {
      const override = args.textOverrides[collection.url];

      return override && override !== collection.name ? [[collection.url, override]] : [];
    }),
  );

  if (args.collections.length <= 1) {
    return nextOverrides;
  }

  const currentTexts = resolvePlayListPageTexts(args.collections, nextOverrides);
  const clickedIndex = args.collections.findIndex(
    (collection) => collection.url === args.clickedCollectionUrl,
  );
  if (clickedIndex < 0) {
    return nextOverrides;
  }

  const nextIndex = (clickedIndex + 1) % currentTexts.length;
  const nextText = currentTexts[nextIndex];
  const clickedCollection = args.collections[clickedIndex];

  if (nextText === clickedCollection.name) {
    delete nextOverrides[clickedCollection.url];
    return nextOverrides;
  }

  return {
    ...nextOverrides,
    [clickedCollection.url]: nextText,
  };
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
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const { collections, titleToneHandoff } = appLogicHook.useContext();
  const [textOverrides, setTextOverrides] = useState<PlayListTextOverrides>({});
  const texts = resolvePlayListPageTexts(collections, textOverrides);

  function scrollItemToCenter(index: number) {
    const item = itemRefs.current[index];
    if (!item) {
      return;
    }

    const scrollRoot = item.closest("main");
    if (!(scrollRoot instanceof HTMLElement)) {
      return;
    }

    const itemRect = item.getBoundingClientRect();
    const rootRect = scrollRoot.getBoundingClientRect();
    const targetTop =
      scrollRoot.scrollTop +
      (itemRect.top - rootRect.top) -
      (scrollRoot.clientHeight / 2 - itemRect.height / 2);

    scrollRoot.scrollTo({
      top: targetTop,
      behavior: "smooth",
    });
  }

  const itemComponents = collections.map((collection, index) => {
    const text = texts[index] ?? collection.name;
    const layoutId = collectionTitleLayoutId(collection.url);
    const handoffTone =
      titleToneHandoff?.layoutId === layoutId ? titleToneHandoff.tone : null;

    return (
      <div
        key={collection.url}
        ref={(node) => {
          itemRefs.current[index] = node;
        }}
      >
        <PlayItem
          className={collectionTitleClassName}
          handoffTone={handoffTone}
          layoutId={layoutId}
          text={text}
          onClick={() => {
            setTextOverrides((current) =>
              resolveNextPlayListTextOverrides({
                collections,
                textOverrides: current,
                clickedCollectionUrl: collection.url,
              }),
            );

            scrollItemToCenter(index);
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
