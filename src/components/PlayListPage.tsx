import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { PlayItem } from "./playItem";

const PLAY_ITEM_TEXTS = [
  "Quiet Morning",
  "Open Window",
  "Small Talk",
  "Golden Hour",
  "Field Notes",
  "Slow Bloom",
  "Night Drive",
  "Silver Thread",
  "Clear Signal",
  "Afterglow",
  "Soft Echo",
  "Second Nature",
  "Paper Lantern",
  "Blue Horizon",
  "Hidden Path",
  "Daily Motion",
  "Northern Light",
  "Open Secret",
] as const;

export function PlayListPage() {
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [texts, setTexts] = useState<Array<(typeof PLAY_ITEM_TEXTS)[number]>>([
    ...PLAY_ITEM_TEXTS,
  ]);

  function nextText(
    current: (typeof PLAY_ITEM_TEXTS)[number],
  ): (typeof PLAY_ITEM_TEXTS)[number] {
    const nextIndex =
      (PLAY_ITEM_TEXTS.indexOf(current) + 1) % PLAY_ITEM_TEXTS.length;

    return PLAY_ITEM_TEXTS[nextIndex];
  }

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

  return (
    <div
      className="flex min-h-[calc(100vh-2rem)] flex-col items-center gap-8 px-6 pt-[40vh]"
      style={{ fontFamily: "var(--font-noto-sans)" }}
    >
      {texts.map((text, index) => (
        <div
          key={index}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
        >
          <PlayItem
            className={cn(
              "text-4xl select-none",
              "font-[520] [font-synthesis-weight:none]",
              "[font-variation-settings:'wght'_520] tracking-[-0.02em]",
              "transition-[font-variation-settings,font-weight,letter-spacing,transform,opacity] duration-300 ease-in-out",
              "will-change-[font-variation-settings]",
              "hover:font-[680] hover:[font-variation-settings:'wght'_680] hover:tracking-[-0.03em]",
            )}
            text={text}
            onClick={() => {
              setTexts((current) =>
                current.map((itemText, itemIndex) =>
                  itemIndex === index ? nextText(itemText) : itemText,
                ),
              );

              scrollItemToCenter(index);
            }}
          />
        </div>
      ))}
      <div aria-hidden className="mt-[50vh] h-px w-full shrink-0" />
    </div>
  );
}
