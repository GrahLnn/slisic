import { useEffect, useRef, useState } from "react";
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

function CreateNewItem() {
  const [isCommitted, setIsCommitted] = useState(false);

  return (
    <PlayItem
      className={collectionTitleClassName}
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
  const { collections } = appLogicHook.useContext();
  const [texts, setTexts] = useState<string[]>([]);

  useEffect(() => {
    setTexts(collections.map((collection) => collection.name));
  }, [collections]);

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

    return (
      <div
        key={collection.url}
        ref={(node) => {
          itemRefs.current[index] = node;
        }}
      >
        <PlayItem
          className={collectionTitleClassName}
          layoutId={collectionTitleLayoutId(collection.url)}
          text={text}
          onClick={() => {
            setTexts((current) => {
              if (current.length <= 1) {
                return current;
              }

              const nextIndex = (index + 1) % current.length;
              const nextText = current[nextIndex];
              return current.map((itemText, itemIndex) =>
                itemIndex === index ? nextText : itemText,
              );
            });

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
      {[...itemComponents, <CreateNewItem key="create" />]}
      <div aria-hidden className="mt-[50vh] h-px w-full shrink-0" />
    </div>
  );
}
