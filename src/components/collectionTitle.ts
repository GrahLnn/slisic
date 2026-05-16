import { cn } from "@/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePrefersDarkColorScheme } from "./colorScheme";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import type { TitleShareHoverVisual } from "@/src/flow/appLogic/titleShare";

export const CREATE_COLLECTION_TITLE = "Create a List";

const collectionTitlePalette = {
  light: {
    solid: "rgba(9, 9, 9, 1)",
    muted: "rgba(9, 9, 9, 0.4)",
  },
  dark: {
    solid: "rgba(246, 246, 246, 1)",
    muted: "rgba(246, 246, 246, 0.4)",
  },
} as const;

export const collectionTitleLayoutTransition = {
  duration: 0.36,
  ease: [0.22, 1, 0.36, 1],
} as const;

export const COLLECTION_TITLE_HOVER_RETAIN_MS = collectionTitleLayoutTransition.duration * 1000;
export const COLLECTION_TITLE_WEIGHT_TRANSITION_MS = 160;

export const collectionTitleColorTransition = {
  duration: 0.28,
  ease: "linear",
} as const;

export const collectionTitleClassName = cn(
  "w-fit select-none",
  "text-4xl",
  "font-[520] [font-synthesis-weight:none]",
  "[font-variation-settings:'wght'_520] tracking-[-0.02em]",
);

export const collectionTitleTextClassName = cn(
  "transition-[font-variation-settings,font-weight,letter-spacing] duration-[160ms] ease-out",
  "will-change-[font-variation-settings]",
  "hover:font-[680] hover:[font-variation-settings:'wght'_680] hover:tracking-[-0.03em]",
);

export const collectionTitleTextStaticClassName = cn(
  "transition-[font-variation-settings,font-weight,letter-spacing] duration-[160ms] ease-out",
  "will-change-[font-variation-settings]",
);

export const collectionTitleTextHoverClassName = cn(
  "font-[680] [font-variation-settings:'wght'_680] tracking-[-0.03em]",
);

export const collectionTitleTextRetainHoverClassName = cn(
  "font-[680] [font-variation-settings:'wght'_680] tracking-[-0.03em]",
  "transition-none",
);

export function resolveCollectionTitleRetainedHoverVisual(args: {
  retainWindowActive: boolean;
  requestedVisual: TitleShareHoverVisual;
}): TitleShareHoverVisual {
  if (args.requestedVisual !== "none") {
    return args.requestedVisual;
  }

  return args.retainWindowActive ? "retain" : "none";
}

/**
 * A retained title hover is a visual handoff window, not a page or playback
 * state. Once a title owner observes a retain request, it keeps the weight
 * evidence for the shared-layout duration even if the caller's transient
 * state clears before Motion finishes measuring the path.
 */
export function useCollectionTitleRetainedHoverVisual(
  requestedVisual: TitleShareHoverVisual,
  retainOwnerKey: string,
  retainRequestKey = retainOwnerKey,
): TitleShareHoverVisual {
  const [retainWindow, setRetainWindow] = useState<{
    active: boolean;
    ownerKey: string | null;
  }>({
    active: false,
    ownerKey: null,
  });
  const previousRetainRequestKeyRef = useRef<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const clearRetainWindow = () => {
      previousRetainRequestKeyRef.current = null;
      setRetainWindow({
        active: false,
        ownerKey: null,
      });
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    if (retainWindow.ownerKey !== null && retainWindow.ownerKey !== retainOwnerKey) {
      clearRetainWindow();
    }

    if (requestedVisual !== "retain") {
      previousRetainRequestKeyRef.current = null;
      return;
    }

    if (
      retainWindow.active &&
      retainWindow.ownerKey === retainOwnerKey &&
      previousRetainRequestKeyRef.current === retainRequestKey
    ) {
      return;
    }

    if (previousRetainRequestKeyRef.current === retainRequestKey) {
      return;
    }

    previousRetainRequestKeyRef.current = retainRequestKey;

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }

    setRetainWindow({
      active: true,
      ownerKey: retainOwnerKey,
    });
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setRetainWindow({
        active: false,
        ownerKey: null,
      });
    }, COLLECTION_TITLE_HOVER_RETAIN_MS);
  }, [
    requestedVisual,
    retainOwnerKey,
    retainRequestKey,
    retainWindow,
    retainWindow.active,
    retainWindow.ownerKey,
  ]);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    },
    [],
  );

  const resolvedVisual = resolveCollectionTitleRetainedHoverVisual({
    requestedVisual,
    retainWindowActive: retainWindow.active && retainWindow.ownerKey === retainOwnerKey,
  });

  return resolvedVisual;
}

export function useCollectionTitleColor(tone: CollectionTitleTone = "solid") {
  const prefersDark = usePrefersDarkColorScheme();
  const palette = prefersDark ? collectionTitlePalette.dark : collectionTitlePalette.light;

  return palette[tone];
}
