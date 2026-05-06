import { forwardRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import type { CollectionTitleTone } from "@/src/flow/appLogic/core";
import { collectionTitleClassName, collectionTitleLayoutTransition } from "../collectionTitle";
import { EditableTitle, type EditableTitleHandle } from "../EditableTitle";
import { TrackSpectrum } from "./SpectrumVisualizer";

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

export interface MusicSpectrumSelection {
  end: number | null;
  start: number | null;
}

export interface MusicSpectrumEditorProps {
  cascade?: boolean;
  handoffTone: CollectionTitleTone | null;
  interactionDisabled: boolean;
  playbackAction: ReactNode;
  playheadEnabled?: boolean;
  selection: MusicSpectrumSelection;
  shouldShowResetAction: boolean;
  titleLayoutId?: string;
  titleValue: string;
  trackFilePath: string | null;
  waveformClassName?: string;
  onReset: () => void;
  onSelectionChange: (selection: MusicSpectrumSelection) => void;
  onTitleChange: (value: string) => void;
}

export function resolveMusicSpectrumTitleFadeProps(args: { hasSharedTitleLayout: boolean }) {
  return args.hasSharedTitleLayout
    ? musicSpectrumSharedTitleFadeProps
    : musicSpectrumContentFadeProps;
}

export function resolveMusicSpectrumContentFadeProps(args: { cascade: boolean }) {
  return args.cascade ? musicSpectrumCascadeContentFadeProps : musicSpectrumContentFadeProps;
}

export const MusicSpectrumEditor = forwardRef<EditableTitleHandle, MusicSpectrumEditorProps>(
  function MusicSpectrumEditor(
    {
      cascade = false,
      handoffTone,
      interactionDisabled,
      playbackAction,
      playheadEnabled = false,
      selection,
      shouldShowResetAction,
      titleLayoutId,
      titleValue,
      trackFilePath,
      waveformClassName,
      onReset,
      onSelectionChange,
      onTitleChange,
    },
    ref,
  ) {
    const contentFade = resolveMusicSpectrumContentFadeProps({ cascade });

    return (
      <>
        <div className="flex items-center justify-between gap-4">
          <motion.div
            {...resolveMusicSpectrumTitleFadeProps({
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
          {playbackAction ? <motion.div {...contentFade}>{playbackAction}</motion.div> : null}
        </div>
        <motion.div {...contentFade} className={cn("relative mt-8", waveformClassName)}>
          <TrackSpectrum
            filePath={trackFilePath}
            playheadEnabled={playheadEnabled}
            selection={selection}
            onSelectionChange={onSelectionChange}
          />
          <AnimatePresence initial={false}>
            {shouldShowResetAction && (
              <motion.button
                type="button"
                aria-label="Reset spectrum edits"
                className={cn(
                  "group absolute top-0 right-12 z-10 isolate inline-flex size-8 items-center justify-center rounded-[25px] p-2",
                  "text-[#737373] transition duration-300 [corner-shape:squircle_squircle_squircle_squircle]",
                  "before:absolute before:inset-0 before:-z-10 before:rounded-[25px] before:bg-transparent",
                  "before:transition before:duration-300 before:[corner-shape:squircle_squircle_squircle_squircle]",
                  "hover:text-[#262626] hover:before:bg-[#e5e5e5]",
                  "dark:text-[#8a8a8a] dark:hover:text-[#d4d4d4] dark:hover:before:bg-[#262626]",
                  "cursor-pointer",
                )}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={collectionTitleLayoutTransition}
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
