import { cn } from "@/lib/utils";
import { useSyncExternalStore } from "react";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";

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
  "transition-[font-variation-settings,font-weight,letter-spacing] duration-300 ease-in-out",
  "will-change-[font-variation-settings]",
  "hover:font-[680] hover:[font-variation-settings:'wght'_680] hover:tracking-[-0.03em]",
);

export const collectionTitleTextHoverClassName = cn(
  "font-[680] [font-variation-settings:'wght'_680] tracking-[-0.03em]",
);

/**
 * Shared layout nodes need a concrete animatable color value. Reading the same
 * media query as App.css keeps title motion aligned with the actual theme
 * without introducing a second theme source just for this animation path.
 */
function subscribeToColorScheme(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = () => onStoreChange();
  mediaQuery.addEventListener("change", handleChange);

  return () => {
    mediaQuery.removeEventListener("change", handleChange);
  };
}

function readColorSchemeSnapshot() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function usePrefersDarkColorScheme() {
  return useSyncExternalStore(
    subscribeToColorScheme,
    readColorSchemeSnapshot,
    () => false,
  );
}

export function useCollectionTitleColor(tone: CollectionTitleTone = "solid") {
  const prefersDark = usePrefersDarkColorScheme();
  const palette = prefersDark
    ? collectionTitlePalette.dark
    : collectionTitlePalette.light;

  return palette[tone];
}
