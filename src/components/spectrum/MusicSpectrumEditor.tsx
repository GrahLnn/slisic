import { forwardRef, useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import {
  isRenderPerformanceTraceInstalled,
  recordRenderPerformanceTrace,
} from "@/src/debug/renderPerformanceTrace";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import { collectionTitleClassName, collectionTitleLayoutTransition } from "../collectionTitle";
import { EditableTitle, type EditableTitleHandle } from "../EditableTitle";
import {
  TrackSpectrum,
  type TrackSpectrumPlaybackStatusCommit,
  type WaveformRenderDataStore,
} from "./SpectrumVisualizer";

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

const musicSpectrumEditorTraceWindowMs =
  Math.round(collectionTitleLayoutTransition.duration * 1000) + 160;
const musicSpectrumEditorTraceInstallProbeFrames = 8;

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
  titleLayoutId?: string;
  titleValue: string;
  trackFilePath: string | null;
  waveformStartAction?: ReactNode;
  waveformRenderDataStore?: WaveformRenderDataStore;
  waveformClassName?: string;
  onReset: () => void;
  onSelectionCommit?: (
    selection: MusicSpectrumSelection,
    commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
  ) => void;
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

type MusicSpectrumEditorTraceRefs = {
  titleRow: React.RefObject<HTMLDivElement | null>;
  editableTitleHost: React.RefObject<HTMLDivElement | null>;
  waveformRoot: React.RefObject<HTMLDivElement | null>;
  trackSpectrumHost: React.RefObject<HTMLDivElement | null>;
};

type MusicSpectrumEditorTraceInputs = {
  exitPresentation: MusicSpectrumExitPresentation;
  handoffTone: CollectionTitleTone | null;
  playheadEnabled: boolean;
  selection: MusicSpectrumSelection;
  titleLayoutId?: string;
  titleValue: string;
  trackFilePath: string | null;
};

function roundTraceNumber(value: number) {
  return Math.round(value * 100) / 100;
}

function readTraceElementSnapshot(element: HTMLElement | null) {
  if (!element) {
    return {
      present: false,
    } as const;
  }

  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);

  return {
    present: true,
    height: roundTraceNumber(rect.height),
    left: roundTraceNumber(rect.left),
    opacity: style?.opacity ?? null,
    top: roundTraceNumber(rect.top),
    transform: style?.transform && style.transform !== "none" ? style.transform : null,
    visibility: style?.visibility ?? null,
    width: roundTraceNumber(rect.width),
  } as const;
}

function shouldTraceMusicSpectrumEditor(inputs: MusicSpectrumEditorTraceInputs) {
  return inputs.titleLayoutId !== undefined || inputs.playheadEnabled;
}

function createMusicSpectrumEditorTracePayload(args: {
  elapsedMs: number;
  frameIndex: number;
  inputs: MusicSpectrumEditorTraceInputs;
  refs: MusicSpectrumEditorTraceRefs;
  reason: string;
}) {
  return {
    elapsedMs: roundTraceNumber(args.elapsedMs),
    exitPresentation: args.inputs.exitPresentation,
    frameIndex: args.frameIndex,
    handoffTone: args.inputs.handoffTone,
    playheadEnabled: args.inputs.playheadEnabled,
    reason: args.reason,
    selectionEnd: args.inputs.selection.end,
    selectionStart: args.inputs.selection.start,
    titleLayoutId: args.inputs.titleLayoutId ?? null,
    titleLength: args.inputs.titleValue.length,
    titleValue: args.inputs.titleValue.slice(0, 160),
    trackFilePath: args.inputs.trackFilePath,
    elements: {
      editableTitleHost: readTraceElementSnapshot(args.refs.editableTitleHost.current),
      titleRow: readTraceElementSnapshot(args.refs.titleRow.current),
      trackSpectrumHost: readTraceElementSnapshot(args.refs.trackSpectrumHost.current),
      waveformRoot: readTraceElementSnapshot(args.refs.waveformRoot.current),
    },
  } satisfies Record<string, unknown>;
}

function useMusicSpectrumEditorTrace(
  inputs: MusicSpectrumEditorTraceInputs,
  refs: MusicSpectrumEditorTraceRefs,
) {
  const latestInputsRef = useRef(inputs);
  latestInputsRef.current = inputs;

  useLayoutEffect(() => {
    if (!shouldTraceMusicSpectrumEditor(latestInputsRef.current)) {
      return;
    }

    let cancelled = false;
    let frameId: number | null = null;
    let frameIndex = 0;
    let installProbeFrameCount = 0;
    let resizeObserver: ResizeObserver | null = null;

    const getOwnerWindow = () =>
      refs.titleRow.current?.ownerDocument.defaultView ??
      refs.editableTitleHost.current?.ownerDocument.defaultView ??
      refs.waveformRoot.current?.ownerDocument.defaultView ??
      refs.trackSpectrumHost.current?.ownerDocument.defaultView ??
      window;

    const cancelScheduledFrame = (ownerWindow: Window) => {
      if (frameId !== null) {
        ownerWindow.cancelAnimationFrame(frameId);
        frameId = null;
      }
    };

    const startTrace = () => {
      if (cancelled) {
        return;
      }

      if (!isRenderPerformanceTraceInstalled()) {
        if (installProbeFrameCount >= musicSpectrumEditorTraceInstallProbeFrames) {
          return;
        }

        installProbeFrameCount += 1;
        const ownerWindow = getOwnerWindow();
        frameId = ownerWindow.requestAnimationFrame(startTrace);
        return;
      }

      const ownerWindow = getOwnerWindow();
      const startedAt = ownerWindow.performance.now();

      const stopTrace = (reason: string, payload: Record<string, unknown> = {}) => {
        cancelScheduledFrame(ownerWindow);
        resizeObserver?.disconnect();
        resizeObserver = null;
        recordRenderPerformanceTrace("music-spectrum-editor-trace-stop", {
          frameIndex,
          reason,
          ...payload,
        });
      };

      const recordSample = (reason: string, frameTime = ownerWindow.performance.now()) => {
        recordRenderPerformanceTrace(
          "music-spectrum-editor-frame",
          createMusicSpectrumEditorTracePayload({
            elapsedMs: frameTime - startedAt,
            frameIndex,
            inputs: latestInputsRef.current,
            refs,
            reason,
          }),
        );
      };

      recordRenderPerformanceTrace("music-spectrum-editor-trace-start", {
        titleLayoutId: latestInputsRef.current.titleLayoutId ?? null,
        titleLength: latestInputsRef.current.titleValue.length,
        titleValue: latestInputsRef.current.titleValue.slice(0, 160),
        trackFilePath: latestInputsRef.current.trackFilePath,
      });

      const ResizeObserverConstructor = ownerWindow.ResizeObserver;
      if (ResizeObserverConstructor) {
        resizeObserver = new ResizeObserverConstructor(() => {
          if (!cancelled && isRenderPerformanceTraceInstalled()) {
            recordSample("resize");
          }
        });

        for (const element of [
          refs.titleRow.current,
          refs.editableTitleHost.current,
          refs.waveformRoot.current,
          refs.trackSpectrumHost.current,
        ]) {
          if (element) {
            resizeObserver.observe(element);
          }
        }
      }

      const sampleFrame = (frameTime: number) => {
        if (cancelled) {
          return;
        }

        frameIndex += 1;
        recordSample("frame", frameTime);

        if (frameTime - startedAt >= musicSpectrumEditorTraceWindowMs) {
          stopTrace("window-complete", {
            elapsedMs: roundTraceNumber(frameTime - startedAt),
          });
          return;
        }

        frameId = ownerWindow.requestAnimationFrame(sampleFrame);
      };

      recordSample("layout-effect", startedAt);
      frameId = ownerWindow.requestAnimationFrame(sampleFrame);
    };

    startTrace();

    return () => {
      cancelled = true;
      const ownerWindow = getOwnerWindow();
      cancelScheduledFrame(ownerWindow);
      resizeObserver?.disconnect();
      recordRenderPerformanceTrace("music-spectrum-editor-trace-stop", {
        frameIndex,
        reason: "cleanup",
      });
    };
  }, [
    inputs.exitPresentation,
    inputs.handoffTone,
    inputs.playheadEnabled,
    inputs.titleLayoutId,
    inputs.titleValue,
    inputs.trackFilePath,
    refs,
  ]);
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
      waveformClassName,
      onReset,
      onSelectionCommit,
      onTitleChange,
    },
    ref,
  ) {
    const contentFade = resolveMusicSpectrumContentFadeProps({ cascade, exitPresentation });
    const titleRowRef = useRef<HTMLDivElement | null>(null);
    const editableTitleHostRef = useRef<HTMLDivElement | null>(null);
    const waveformRootRef = useRef<HTMLDivElement | null>(null);
    const trackSpectrumHostRef = useRef<HTMLDivElement | null>(null);
    const traceRefs = useRef<MusicSpectrumEditorTraceRefs>({
      editableTitleHost: editableTitleHostRef,
      titleRow: titleRowRef,
      trackSpectrumHost: trackSpectrumHostRef,
      waveformRoot: waveformRootRef,
    });

    useMusicSpectrumEditorTrace(
      {
        exitPresentation,
        handoffTone,
        playheadEnabled,
        selection,
        titleLayoutId,
        titleValue,
        trackFilePath,
      },
      traceRefs.current,
    );

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
                onSelectionCommit={onSelectionCommit}
              />
            </motion.div>
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
