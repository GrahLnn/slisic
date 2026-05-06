import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { collectionTitleLayoutTransition } from "../collectionTitle";
import type { EditableTitleHandle } from "../EditableTitle";
import { MusicSpectrumEditor } from "./MusicSpectrumEditor";
import {
  findSpectrumMusicDraftById,
  resolveSpectrumBackActionVisualState,
  resolveSpectrumCommittedMusicName,
  resolveSpectrumMusicRangeChange,
  resolveSpectrumMusicEditorViewModels,
  type SpectrumBackActionVisualState,
  type SpectrumMusicEditorViewModel,
} from "./SpectrumPage.view-model";
import { SpectrumPlaybackAction } from "./SpectrumPlaybackAction";
import { usePageRenderFreeze } from "../usePageRenderFreeze";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

const spectrumBackIconStrokeTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1],
} as const;

const spectrumBackIconToneClassName =
  "text-[#737373] dark:text-[#8a8a8a] group-hover:text-[#262626] dark:group-hover:text-[#d4d4d4]";

type SpectrumRenderData = {
  backActionVisualState: SpectrumBackActionVisualState;
  editorViewModels: SpectrumMusicEditorViewModel[];
  trackFilePath: string | null;
};

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function waitForTitleShareSourceReady() {
  await waitForNextFrame();
  await waitForNextFrame();
}

function SpectrumBackCheckIcon({ replayKey }: { replayKey: string }) {
  return (
    <motion.svg
      key={replayKey}
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className={cn("absolute inset-0 block", spectrumBackIconToneClassName)}
    >
      <motion.path
        d="M2.75 9.25L6.75 14.25L15.25 3.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        exit={{ pathLength: 0 }}
        transition={{
          ...spectrumBackIconStrokeTransition,
          delay: 0.02,
        }}
      />
    </motion.svg>
  );
}

function SpectrumBackArrowIcon({ replayKey }: { replayKey: string }) {
  return (
    <motion.svg
      key={replayKey}
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className={cn("absolute inset-0 block rotate-90", spectrumBackIconToneClassName)}
    >
      <motion.line
        x1="9"
        y1="15.25"
        x2="9"
        y2="2.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        exit={{ pathLength: 0 }}
        transition={{
          ...spectrumBackIconStrokeTransition,
          delay: 0.02,
        }}
      />
      <motion.polyline
        points="13.25 11 9 15.25 4.75 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        exit={{ pathLength: 0 }}
        transition={{
          ...spectrumBackIconStrokeTransition,
          delay: 0.02,
        }}
      />
    </motion.svg>
  );
}

function SpectrumBackSymbolOwner({ visualState }: { visualState: SpectrumBackActionVisualState }) {
  return (
    <span className="absolute inset-0 block">
      {visualState.kind === "check" ? (
        <SpectrumBackCheckIcon replayKey={visualState.key} />
      ) : (
        <SpectrumBackArrowIcon replayKey={visualState.key} />
      )}
    </span>
  );
}

function SpectrumBackIcon({ visualState }: { visualState: SpectrumBackActionVisualState }) {
  return (
    <span className="relative block size-4.5">
      <AnimatePresence initial={false} mode="wait">
        <SpectrumBackSymbolOwner key={visualState.kind} visualState={visualState} />
      </AnimatePresence>
    </span>
  );
}

export function SpectrumPage() {
  const isPresent = useIsPresent();
  const editableTitleRefs = useRef(new Map<string, EditableTitleHandle>());
  const [isBackNavigationPending, setIsBackNavigationPending] = useState(false);
  const {
    activeLayoutId,
    nowPlayingTrackEndMs,
    nowPlayingTrackFilePath,
    nowPlayingTrackUrl,
    nowPlayingTrackStartMs,
    playingPlaylistName,
    spectrumMusicDrafts,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const handoffTone =
    activeLayoutId && titleToneHandoff?.layoutId === activeLayoutId ? titleToneHandoff.tone : null;
  const editorViewModels = resolveSpectrumMusicEditorViewModels({
    activeLayoutId,
    handoffTone,
    interactionDisabled: !isPresent || spectrumMusicDrafts.length === 0,
    nowPlayingTrackEndMs,
    nowPlayingTrackStartMs,
    nowPlayingTrackUrl,
    playingPlaylistName,
    spectrumMusicDrafts,
  });
  const liveRenderData = {
    backActionVisualState: resolveSpectrumBackActionVisualState({
      musicDrafts: spectrumMusicDrafts,
    }),
    editorViewModels,
    trackFilePath: nowPlayingTrackFilePath,
  } satisfies SpectrumRenderData;
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData, {
    isPresent,
    freezeOnExit: true,
  });
  const renderData = pageRenderFreeze.renderValue;
  const isBackActionLocked = isBackNavigationPending;

  async function handleBackAction() {
    if (isBackActionLocked) {
      return;
    }

    setIsBackNavigationPending(true);

    try {
      if (renderData.backActionVisualState.kind === "back") {
        pageRenderFreeze.freeze();
        appLogicAction.back();
        return;
      }

      const committedTitles = renderData.editorViewModels.map((editor) => {
        const draft = findSpectrumMusicDraftById(spectrumMusicDrafts, editor.id);
        return {
          editor,
          title: resolveSpectrumCommittedMusicName({
            musicDraft: draft,
            renderedName: editor.titleValue,
          }),
        };
      });

      for (const { editor, title } of committedTitles) {
        await editableTitleRefs.current.get(editor.id)?.commitResolvedValue({
          value: title.alias,
          animateTyping: title.kind !== "keep",
        });
      }

      flushSync(() => {
        for (const { editor, title } of committedTitles) {
          appLogicAction.changeSpectrumMusicName({
            id: editor.id,
            name: title.alias,
          });
        }
        pageRenderFreeze.freeze({
          ...liveRenderData,
          editorViewModels: liveRenderData.editorViewModels.map((editor) => {
            const committed = committedTitles.find(
              (candidate) => candidate.editor.id === editor.id,
            );

            return committed
              ? {
                  ...editor,
                  titleValue: committed.title.alias,
                }
              : editor;
          }),
        });
      });
      await waitForTitleShareSourceReady();
      appLogicAction.back();
    } catch (error) {
      console.error("Failed to complete the spectrum back transition", error);
      setIsBackNavigationPending(false);
    }
  }

  return (
    <div
      data-page-state="spectrum"
      className={cn(
        "relative mx-auto mt-12 flex w-full max-w-7xl flex-col px-12",
        !isPresent && "pointer-events-none",
      )}
    >
      <div className="relative z-20 flex flex-col">
        <motion.div {...contentFadeProps}>
          <button
            type="button"
            aria-disabled={isBackActionLocked}
            onClick={(event) => {
              if (isBackActionLocked) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }

              void handleBackAction();
            }}
            className={cn(
              "group relative isolate inline-flex w-fit select-none py-2 pr-2",
              isBackActionLocked ? "pointer-events-none cursor-default" : "cursor-pointer",
              "before:absolute before:inset-y-0 before:-left-2 before:right-0 before:-z-10",
              "before:rounded-[25px] before:bg-transparent before:transition before:duration-300",
              "before:[corner-shape:squircle_squircle_squircle_squircle]",
              "hover:before:bg-[#e5e5e5] dark:hover:before:bg-[#262626]",
            )}
          >
            <SpectrumBackIcon visualState={renderData.backActionVisualState} />
          </button>
        </motion.div>
        <div className="flex flex-col gap-12 pb-16">
          {renderData.editorViewModels.map((editor) => (
            <MusicSpectrumEditor
              key={editor.id}
              cascade={!editor.isCurrent}
              ref={(handle) => {
                if (handle) {
                  editableTitleRefs.current.set(editor.id, handle);
                  return;
                }

                editableTitleRefs.current.delete(editor.id);
              }}
              handoffTone={editor.handoffTone}
              interactionDisabled={editor.interactionDisabled}
              playbackAction={
                editor.isCurrent ? (
                  <SpectrumPlaybackAction filePath={renderData.trackFilePath} />
                ) : null
              }
              playheadEnabled={editor.isCurrent}
              selection={{
                end: editor.selectionEnd,
                start: editor.selectionStart,
              }}
              shouldShowResetAction={editor.shouldShowResetAction}
              titleLayoutId={editor.titleLayoutId}
              titleValue={editor.titleValue}
              trackFilePath={renderData.trackFilePath}
              waveformClassName="left-1/2 w-screen -translate-x-1/2"
              onReset={() => appLogicAction.resetSpectrumMusicDraft(editor.id)}
              onSelectionChange={(range) => {
                appLogicAction.changeSpectrumMusicRange({
                  id: editor.id,
                  ...resolveSpectrumMusicRangeChange(range),
                });
              }}
              onTitleChange={(name) =>
                appLogicAction.changeSpectrumMusicName({
                  id: editor.id,
                  name,
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
