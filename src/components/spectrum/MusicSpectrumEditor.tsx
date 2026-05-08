import { forwardRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import { collectionTitleClassName, collectionTitleLayoutTransition } from "../collectionTitle";
import { EditableTitle, type EditableTitleHandle } from "../EditableTitle";
import { TrackSpectrum, type WaveformRenderDataStore } from "./SpectrumVisualizer";

const musicSpectrumContentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

const musicSpectrumCascadeContentFadeProps = {
  ...musicSpectrumContentFadeProps,
  transition: {
    ...collectionTitleLayoutTransition,
    delay: 0.04,
  },
} as const;

const musicSpectrumSharedTitleFadeProps = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit: { opacity: 1 },
  transition: collectionTitleLayoutTransition,
} as const;

const musicSpectrumPageExitChildFadeProps = {
  initial: false,
  animate: { opacity: 1 },
  exit: { opacity: 1 },
  transition: { duration: 0 },
} as const;

export interface MusicSpectrumSelection {
  end: number | null;
  start: number | null;
}

export type MusicSpectrumWaveformPresentation = "interactive" | "placeholder";
export type MusicSpectrumExitPresentation = "local" | "page";

export interface MusicSpectrumEditorProps {
  cascade?: boolean;
  handoffTone: CollectionTitleTone | null;
  interactionDisabled: boolean;
  playheadEnabled?: boolean;
  selection: MusicSpectrumSelection;
  exitPresentation?: MusicSpectrumExitPresentation;
  shouldShowResetAction: boolean;
  titleAction?: ReactNode;
  titleLayoutId?: string;
  titleValue: string;
  trackFilePath: string | null;
  waveformStartAction?: ReactNode;
  waveformRenderDataStore?: WaveformRenderDataStore;
  waveformPresentation?: MusicSpectrumWaveformPresentation;
  waveformClassName?: string;
  onReset: () => void;
  onSelectionCommit?: (selection: MusicSpectrumSelection) => void;
  onTitleChange: (value: string) => void;
}

export function resolveMusicSpectrumTitleFadeProps(args: {
  exitPresentation?: MusicSpectrumExitPresentation;
  hasSharedTitleLayout: boolean;
}) {
  if (args.exitPresentation === "page") {
    return musicSpectrumPageExitChildFadeProps;
  }

  return args.hasSharedTitleLayout
    ? musicSpectrumSharedTitleFadeProps
    : musicSpectrumContentFadeProps;
}

export function resolveMusicSpectrumContentFadeProps(args: {
  cascade: boolean;
  exitPresentation?: MusicSpectrumExitPresentation;
}) {
  if (args.exitPresentation === "page") {
    return musicSpectrumPageExitChildFadeProps;
  }

  return args.cascade ? musicSpectrumCascadeContentFadeProps : musicSpectrumContentFadeProps;
}

export function resolveMusicSpectrumWaveformFadeProps(args: {
  presentation: MusicSpectrumWaveformPresentation;
}) {
  return {
    animate: {
      opacity: args.presentation === "interactive" ? 1 : 0,
    },
    initial: {
      opacity: 0,
    },
    transition: collectionTitleLayoutTransition,
  } as const;
}

export function resolveMusicSpectrumResetActionFadeProps(args: {
  exitPresentation?: MusicSpectrumExitPresentation;
}) {
  return args.exitPresentation === "page"
    ? musicSpectrumPageExitChildFadeProps
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: collectionTitleLayoutTransition,
      };
}

export type MusicSpectrumFloatingActionPlacement = "end" | "start";

export function resolveMusicSpectrumFloatingActionPlacementClassName(
  placement: MusicSpectrumFloatingActionPlacement,
) {
  return placement === "start" ? "left-12" : "right-12";
}

export const MusicSpectrumEditor = forwardRef<EditableTitleHandle, MusicSpectrumEditorProps>(
  function MusicSpectrumEditor(
    {
      cascade = false,
      handoffTone,
      interactionDisabled,
      exitPresentation = "local",
      playheadEnabled = false,
      selection,
      shouldShowResetAction,
      titleAction,
      titleLayoutId,
      titleValue,
      trackFilePath,
      waveformStartAction,
      waveformRenderDataStore,
      waveformPresentation = "interactive",
      waveformClassName,
      onReset,
      onSelectionCommit,
      onTitleChange,
    },
    ref,
  ) {
    const contentFade = resolveMusicSpectrumContentFadeProps({ cascade, exitPresentation });

    return (
      <>
        <div className="flex items-center justify-between gap-4">
          <motion.div
            {...resolveMusicSpectrumTitleFadeProps({
              exitPresentation,
              hasSharedTitleLayout: titleLayoutId !== undefined,
            })}
            className="min-w-0"
          >
            <EditableTitle
              ref={ref}
              className={collectionTitleClassName}
              focusHitSlopWidthClassName="w-4"
              handoffTone={handoffTone}
              interactionDisabled={interactionDisabled}
              layoutId={titleLayoutId}
              style={{ fontFamily: "var(--font-noto-sans)" }}
              value={titleValue}
              onChange={onTitleChange}
            />
          </motion.div>
          {titleAction ? (
            <div className="opacity-0 transition-opacity duration-300 group-hover/spectrum-music-row:opacity-100">
              <motion.div {...contentFade}>{titleAction}</motion.div>
            </div>
          ) : null}
        </div>
        <motion.div {...contentFade} className={cn("relative mt-8", waveformClassName)}>
          <div className="grid">
            <div aria-hidden className="col-start-1 row-start-1 h-[13rem] w-full" />
            <AnimatePresence initial={false}>
              {waveformPresentation === "interactive" ? (
                <motion.div
                  key="waveform"
                  {...resolveMusicSpectrumWaveformFadeProps({
                    presentation: waveformPresentation,
                  })}
                  className="col-start-1 row-start-1"
                >
                  <TrackSpectrum
                    filePath={trackFilePath}
                    playheadEnabled={playheadEnabled}
                    renderDataStore={waveformRenderDataStore}
                    selection={selection}
                    onSelectionCommit={onSelectionCommit}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          <AnimatePresence initial={false}>
            {waveformStartAction ? (
              <motion.div
                className={cn(
                  "absolute top-0 z-10",
                  resolveMusicSpectrumFloatingActionPlacementClassName("start"),
                )}
                {...resolveMusicSpectrumResetActionFadeProps({ exitPresentation })}
              >
                {waveformStartAction}
              </motion.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {shouldShowResetAction && (
              <motion.button
                type="button"
                aria-label="Reset spectrum edits"
                className={cn(
                  "group absolute top-0 z-10 isolate inline-flex size-8 items-center justify-center rounded-[25px] p-2",
                  resolveMusicSpectrumFloatingActionPlacementClassName("end"),
                  "text-[#737373] transition duration-300 [corner-shape:squircle_squircle_squircle_squircle]",
                  "before:absolute before:inset-0 before:-z-10 before:rounded-[25px] before:bg-transparent",
                  "before:transition before:duration-300 before:[corner-shape:squircle_squircle_squircle_squircle]",
                  "hover:text-[#262626] hover:before:bg-[#e5e5e5]",
                  "dark:text-[#8a8a8a] dark:hover:text-[#d4d4d4] dark:hover:before:bg-[#262626]",
                  "cursor-pointer",
                )}
                {...resolveMusicSpectrumResetActionFadeProps({ exitPresentation })}
                onClick={onReset}
              >
                <icons.arrowRotateAnticlockwise size={18} />
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>
      </>
    );
  },
);
