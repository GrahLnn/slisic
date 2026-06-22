import { forwardRef, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import {
  collectionTitleClassName,
  collectionTitleLayoutTransition,
  collectionTitleTextHoverClassName,
} from "../collectionTitle";
import { EditableTitle, type EditableTitleHandle } from "../EditableTitle";
import {
  TrackSpectrum,
  type TrackSpectrumPlaybackControl,
  type TrackSpectrumPlaybackStatusCommit,
  type WaveformRenderDataStore,
} from "./SpectrumVisualizer";
import { GlassSurface } from "../glass/GlassSurface";

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

const musicSpectrumWaveformFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

export interface MusicSpectrumSelection {
  end: number | null;
  start: number | null;
}

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
  titleIsNew?: boolean;
  titleLayoutId?: string;
  titleValue: string;
  trackFilePath: string | null;
  waveformStartAction?: ReactNode;
  waveformVisible?: boolean;
  waveformRenderDataStore?: WaveformRenderDataStore;
  waveformClassName?: string;
  onReset: () => void;
  onSelectionCommit?: (
    selection: MusicSpectrumSelection,
    commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
  ) => void;
  onPlaybackControlReady?: (control: TrackSpectrumPlaybackControl | null) => void;
  onNewTitleActivate?: () => void;
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

export function resolveMusicSpectrumWaveformFadeProps(args: {
  exitPresentation?: MusicSpectrumExitPresentation;
}) {
  return args.exitPresentation === "page"
    ? musicSpectrumPageExitChildFadeProps
    : musicSpectrumWaveformFadeProps;
}

export type MusicSpectrumFloatingActionPlacement = "end" | "start";

export function resolveMusicSpectrumFloatingActionPlacementClassName(
  placement: MusicSpectrumFloatingActionPlacement,
) {
  return placement === "start" ? "left-12" : "right-12";
}

export function resolveMusicSpectrumRowHoverActionClassName() {
  return "opacity-0 transition-opacity duration-300 group-hover/spectrum-music-row:opacity-100";
}

export function resolveMusicSpectrumTitleTextClassName() {
  return collectionTitleTextHoverClassName;
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
      titleIsNew = false,
      titleLayoutId,
      titleValue,
      trackFilePath,
      waveformStartAction,
      waveformVisible = true,
      waveformRenderDataStore,
      waveformClassName,
      onReset,
      onSelectionCommit,
      onPlaybackControlReady,
      onNewTitleActivate,
      onTitleChange,
    },
    ref,
  ) {
    const contentFade = resolveMusicSpectrumContentFadeProps({ cascade, exitPresentation });
    const titleRowRef = useRef<HTMLDivElement | null>(null);
    const editableTitleHostRef = useRef<HTMLDivElement | null>(null);
    const waveformRootRef = useRef<HTMLDivElement | null>(null);
    const trackSpectrumHostRef = useRef<HTMLDivElement | null>(null);

    return (
      <>
        <div ref={titleRowRef} className="flex items-center justify-between gap-4">
          <motion.div
            ref={editableTitleHostRef}
            {...resolveMusicSpectrumTitleFadeProps({
              exitPresentation,
              hasSharedTitleLayout: titleLayoutId !== undefined,
            })}
            className="min-w-0"
          >
            <EditableTitle
              ref={ref}
              className={collectionTitleClassName}
              customCursorEnabled
              focusHitSlopWidthClassName="w-4"
              handoffTone={handoffTone}
              interactionDisabled={interactionDisabled}
              layoutId={titleLayoutId}
              style={{ fontFamily: "var(--font-noto-sans)" }}
              textClassName={resolveMusicSpectrumTitleTextClassName()}
              isNewTitle={titleIsNew}
              titleNativeHoverEnabled={false}
              value={titleValue}
              onNewTitleActivate={onNewTitleActivate}
              onChange={onTitleChange}
            />
          </motion.div>
          {titleAction ? (
            <div className={resolveMusicSpectrumRowHoverActionClassName()}>
              <motion.div {...contentFade}>{titleAction}</motion.div>
            </div>
          ) : null}
        </div>
        <motion.div
          ref={waveformRootRef}
          {...contentFade}
          className={cn("relative mt-8", waveformClassName)}
        >
          {waveformVisible ? (
            <div className="grid">
              <div aria-hidden className="col-start-1 row-start-1 h-[13rem] w-full" />
              <motion.div
                ref={trackSpectrumHostRef}
                key="waveform"
                {...resolveMusicSpectrumWaveformFadeProps({ exitPresentation })}
                className="col-start-1 row-start-1"
              >
                <TrackSpectrum
                  filePath={trackFilePath}
                  playheadEnabled={playheadEnabled}
                  renderDataStore={waveformRenderDataStore}
                  selection={selection}
                  onPlaybackControlReady={onPlaybackControlReady}
                  onSelectionCommit={onSelectionCommit}
                />
              </motion.div>
            </div>
          ) : (
            <div aria-hidden className="h-[13rem] w-full" />
          )}
          <AnimatePresence initial={false}>
            {waveformStartAction ? (
              <motion.div
                className={cn(
                  "absolute top-0 z-10",
                  resolveMusicSpectrumFloatingActionPlacementClassName("start"),
                )}
                {...resolveMusicSpectrumResetActionFadeProps({ exitPresentation })}
              >
                <div className={resolveMusicSpectrumRowHoverActionClassName()}>
                  {waveformStartAction}
                </div>
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
                  "hover:text-[#262626]",
                  "dark:text-[#8a8a8a] dark:hover:text-[#d4d4d4]",
                  "cursor-pointer",
                )}
                {...resolveMusicSpectrumResetActionFadeProps({ exitPresentation })}
                onClick={onReset}
              >
                <GlassSurface variant="button" className="inset-0 z-0" />
                <icons.arrowRotateAnticlockwise className="relative z-10" size={18} />
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>
      </>
    );
  },
);
