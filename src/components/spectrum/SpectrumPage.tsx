import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { collectionTitleLayoutTransition } from "../collectionTitle";
import type { EditableTitleHandle } from "../EditableTitle";
import type { MusicSpectrumSelection } from "./MusicSpectrumEditor";
import { SpectrumMusicVirtualList } from "./SpectrumMusicVirtualList";
import {
  areSpectrumPlaybackActionSnapshotsEqual,
  isSpectrumPlaybackStatusIdentityForAction,
  projectSpectrumPlaybackIdentity,
  resolveSpectrumPlaybackActionSnapshot,
  resolveSpectrumBackActionVisualState,
  resolveSpectrumBackTitleCommitTargets,
  resolveSpectrumMusicRangeChange,
  resolveSpectrumMusicEditorViewModels,
  resolveSpectrumPlaybackRangeSyncEffect,
  resolveSpectrumPlaybackRestoreEffect,
  type SpectrumBackActionVisualState,
  type SpectrumMusicEditorViewModel,
  type SpectrumPlaybackActionSnapshot,
  type SpectrumPlaybackIdentity,
} from "./SpectrumPage.view-model";
import { SPECTRUM_PLAYBACK_STATUS_POLL_MS } from "./SpectrumPlaybackAction";
import { usePageRenderFreeze } from "../usePageRenderFreeze";
import { crab, type PlaybackStatusPayload } from "@/src/cmd";

const contentFadeProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: collectionTitleLayoutTransition,
} as const;

const spectrumListExitFadeProps = {
  initial: false,
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

function createSpectrumPlaybackTrackPayload(identity: SpectrumPlaybackIdentity, musicName: string) {
  return {
    end_ms: identity.endMs,
    file_path: identity.filePath,
    music_name: musicName,
    music_url: identity.url,
    playlist_name: identity.playlistName,
    start_ms: identity.startMs,
  };
}

function createSpectrumPlaybackRangeSyncPayload(args: {
  endMs: number;
  identity: SpectrumPlaybackIdentity;
  musicName: string;
  startMs: number;
}) {
  return {
    next_end_ms: args.endMs,
    next_start_ms: args.startMs,
    track: {
      end_ms: args.identity.endMs,
      file_path: args.identity.filePath,
      music_name: args.musicName,
      music_url: args.identity.url,
      playlist_name: args.identity.playlistName,
      start_ms: args.identity.startMs,
    },
  };
}

function isPlaybackStatusForSpectrumIdentity(
  status: PlaybackStatusPayload | null,
  identity: SpectrumPlaybackIdentity,
) {
  if (!status?.path) {
    return false;
  }

  return isSpectrumPlaybackStatusIdentityForAction(
    projectSpectrumPlaybackIdentity({
      endMs: status.track_end_ms,
      filePath: status.path,
      playlistName: status.playlist_name,
      startMs: status.track_start_ms,
      url: status.music_url,
    }),
    identity,
  );
}

function resolveSpectrumPlaybackStatusIdentity(status: PlaybackStatusPayload | null) {
  if (!status?.path) {
    return null;
  }

  return projectSpectrumPlaybackIdentity({
    endMs: status.track_end_ms,
    filePath: status.path,
    playlistName: status.playlist_name,
    startMs: status.track_start_ms,
    url: status.music_url,
  });
}

function resolvePlaybackAbsolutePositionMs(status: PlaybackStatusPayload) {
  return Math.max(0, (status.playback_start_ms ?? 0) + status.position_ms);
}

function resolveSpectrumPlaybackActionSnapshotFromStatus(
  status: PlaybackStatusPayload | null,
): SpectrumPlaybackActionSnapshot | null {
  if (!status?.path) {
    return null;
  }

  return resolveSpectrumPlaybackActionSnapshot({
    endMs: status.track_end_ms,
    filePath: status.path,
    paused: status.paused,
    playlistName: status.playlist_name,
    startMs: status.track_start_ms,
    url: status.music_url,
  });
}

function resolveSpectrumEditorByPlaybackIdentity(
  editors: readonly SpectrumMusicEditorViewModel[],
  identity: SpectrumPlaybackIdentity,
) {
  return editors.find((editor) => editor.playbackIdentity?.key === identity.key) ?? null;
}

async function readPlaybackStatus() {
  const result = await crab.getPlaybackStatus();

  return result.match({
    Ok: (value) => value,
    Err: (error) => {
      throw new Error(error);
    },
  });
}

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
  const primaryPlaybackResumeRef = useRef<{
    identity: SpectrumPlaybackIdentity;
    positionMs: number | null;
  } | null>(null);
  const [isBackNavigationPending, setIsBackNavigationPending] = useState(false);
  const playbackActionSnapshotRef = useRef<SpectrumPlaybackActionSnapshot | null>(null);
  const [playbackActionSnapshot, setPlaybackActionSnapshot] =
    useState<SpectrumPlaybackActionSnapshot | null>(null);
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
    nowPlayingTrackFilePath,
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
  const primaryEditor = renderData.editorViewModels[0] ?? null;
  const primaryPlaybackIdentity = primaryEditor?.playbackIdentity ?? null;

  useLayoutEffect(() => {
    if (primaryPlaybackIdentity === null) {
      primaryPlaybackResumeRef.current = null;
      return;
    }

    if (primaryPlaybackResumeRef.current?.identity.key === primaryPlaybackIdentity.key) {
      return;
    }

    primaryPlaybackResumeRef.current = {
      identity: primaryPlaybackIdentity,
      positionMs: null,
    };
  }, [primaryPlaybackIdentity]);

  async function syncSpectrumPlaybackRangeForSelection(
    editor: SpectrumMusicEditorViewModel,
    range: { endMs: number | null; startMs: number | null },
  ) {
    if (!editor.playbackIdentity) {
      return;
    }

    const status = await refreshSpectrumPlaybackStatus();
    const effect = resolveSpectrumPlaybackRangeSyncEffect({
      identity: editor.playbackIdentity,
      range,
      statusIdentity: resolveSpectrumPlaybackStatusIdentity(status),
    });

    if (effect.kind === "none") {
      return;
    }

    const result = await crab.syncSpectrumPlaybackRange(
      createSpectrumPlaybackRangeSyncPayload({
        endMs: effect.endMs,
        identity: editor.playbackIdentity,
        musicName: editor.titleValue,
        startMs: effect.startMs,
      }),
    );

    result.match({
      Ok: (status) => {
        commitPlaybackActionSnapshot(status);
      },
      Err: (error) => {
        throw new Error(error);
      },
    });
  }

  function handleSpectrumSelectionCommit(id: string, range: MusicSpectrumSelection) {
    const editor = renderData.editorViewModels.find((candidate) => candidate.id === id) ?? null;
    if (!editor) {
      return;
    }

    const nextRange = resolveSpectrumMusicRangeChange(range);
    appLogicAction.changeSpectrumMusicRange({
      id,
      ...nextRange,
    });

    void syncSpectrumPlaybackRangeForSelection(editor, nextRange).catch((error) => {
      console.error("Failed to sync spectrum playback range", error);
    });
  }

  function isNowPlayingSpectrumMusicDeleteRequested() {
    return spectrumMusicDrafts.some(
      (draft) =>
        draft.deleteRequested === true &&
        draft.url === nowPlayingTrackUrl &&
        draft.baselineStartMs === nowPlayingTrackStartMs &&
        draft.baselineEndMs === nowPlayingTrackEndMs,
    );
  }

  async function handleBackAction() {
    if (isBackActionLocked) {
      return;
    }

    setIsBackNavigationPending(true);

    try {
      if (renderData.backActionVisualState.kind === "back") {
        pageRenderFreeze.freeze();
        await handleRestorePrimarySpectrumMusicPlayback();
        appLogicAction.back();
        return;
      }

      const committedTitles = resolveSpectrumBackTitleCommitTargets({
        editorViewModels: renderData.editorViewModels,
        musicDrafts: spectrumMusicDrafts,
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
      await handleRestorePrimarySpectrumMusicPlayback();
      appLogicAction.back();
    } catch (error) {
      console.error("Failed to complete the spectrum back transition", error);
      setIsBackNavigationPending(false);
    }
  }

  async function handlePlaySpectrumMusic(identity: SpectrumPlaybackIdentity) {
    await capturePrimarySpectrumPlaybackPosition();

    const editor = resolveSpectrumEditorByPlaybackIdentity(renderData.editorViewModels, identity);
    if (editor === null) {
      return;
    }

    const result = await crab.playSpectrumMusic(
      createSpectrumPlaybackTrackPayload(identity, editor.titleValue),
      null,
    );

    result.match({
      Ok: () => undefined,
      Err: (error) => {
        throw new Error(error);
      },
    });
    await refreshSpectrumPlaybackStatus();
  }

  async function handleRestorePrimarySpectrumMusicPlayback() {
    if (isNowPlayingSpectrumMusicDeleteRequested()) {
      return;
    }

    const primaryResume = primaryPlaybackResumeRef.current;
    const primaryEditor = renderData.editorViewModels[0];
    if (!primaryResume || !primaryEditor || primaryEditor.playbackIdentity === null) {
      return;
    }

    const identity = primaryEditor.playbackIdentity;
    const status = await refreshSpectrumPlaybackStatus();
    const restoreEffect = resolveSpectrumPlaybackRestoreEffect({
      identity,
      statusIdentity: resolveSpectrumPlaybackStatusIdentity(status),
      statusPaused: status?.paused === true,
      statusPositionMs:
        status !== null && isPlaybackStatusForSpectrumIdentity(status, identity)
          ? resolvePlaybackAbsolutePositionMs(status)
          : null,
      storedPositionMs: primaryResume.positionMs,
    });
    if (restoreEffect.kind === "none") {
      return;
    }

    const result = await crab.restoreSpectrumMusic(
      createSpectrumPlaybackTrackPayload(identity, primaryEditor.titleValue),
      restoreEffect.positionMs,
    );

    result.match({
      Ok: () => undefined,
      Err: (error) => {
        throw new Error(error);
      },
    });
    await refreshSpectrumPlaybackStatus();
  }

  async function handleSpectrumPlaybackAction(identity: SpectrumPlaybackIdentity) {
    const editor = resolveSpectrumEditorByPlaybackIdentity(renderData.editorViewModels, identity);
    if (editor === null) {
      return;
    }

    const status = await refreshSpectrumPlaybackStatus();

    if (
      !isSpectrumPlaybackStatusIdentityForAction(
        resolveSpectrumPlaybackStatusIdentity(status),
        identity,
      )
    ) {
      await handlePlaySpectrumMusic(identity);
      return;
    }

    const track = createSpectrumPlaybackTrackPayload(identity, editor.titleValue);
    const result = status?.paused
      ? await crab.resumeSpectrumMusic(track)
      : await crab.pauseSpectrumMusic(track);
    result.match({
      Ok: () => undefined,
      Err: (error) => {
        throw new Error(error);
      },
    });
    await refreshSpectrumPlaybackStatus();
  }

  async function capturePrimarySpectrumPlaybackPosition() {
    const primaryResume = primaryPlaybackResumeRef.current;
    if (!primaryResume) {
      return;
    }

    const status = await refreshSpectrumPlaybackStatus();
    const currentPrimaryStatus = isPlaybackStatusForSpectrumIdentity(status, primaryResume.identity)
      ? status
      : null;
    if (!currentPrimaryStatus) {
      return;
    }

    primaryPlaybackResumeRef.current = {
      identity: primaryResume.identity,
      positionMs: resolvePlaybackAbsolutePositionMs(currentPrimaryStatus),
    };
  }

  async function refreshSpectrumPlaybackStatus() {
    const status = await readPlaybackStatus();
    commitPlaybackActionSnapshot(status);
    return status;
  }

  function commitPlaybackActionSnapshot(status: PlaybackStatusPayload | null) {
    const snapshot = resolveSpectrumPlaybackActionSnapshotFromStatus(status);
    if (areSpectrumPlaybackActionSnapshotsEqual(playbackActionSnapshotRef.current, snapshot)) {
      return;
    }

    playbackActionSnapshotRef.current = snapshot;
    setPlaybackActionSnapshot(snapshot);
  }

  useLayoutEffect(() => {
    let disposed = false;

    async function refresh() {
      try {
        const result = await crab.getPlaybackStatus();
        const status = result.match({
          Ok: (value) => value,
          Err: (error) => {
            throw new Error(error);
          },
        });
        if (!disposed) {
          commitPlaybackActionSnapshot(status);
        }
      } catch (error) {
        if (!disposed) {
          console.error("Failed to refresh spectrum playback status", error);
          commitPlaybackActionSnapshot(null);
        }
      }
    }

    void refresh();
    const intervalId = window.setInterval(refresh, SPECTRUM_PLAYBACK_STATUS_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, []);

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
        <motion.div {...spectrumListExitFadeProps}>
          <SpectrumMusicVirtualList
            editableTitleRefs={editableTitleRefs}
            editorViewModels={renderData.editorViewModels}
            exitPresentation={isPresent ? "local" : "page"}
            playbackActionSnapshot={playbackActionSnapshot}
            trackFilePath={renderData.trackFilePath}
            onDelete={(id) => appLogicAction.deleteSpectrumMusic(id)}
            onPlaybackAction={handleSpectrumPlaybackAction}
            onReset={(id) => appLogicAction.resetSpectrumMusicDraft(id)}
            onSelectionCommit={handleSpectrumSelectionCommit}
            onTitleChange={(id, name) =>
              appLogicAction.changeSpectrumMusicName({
                id,
                name,
              })
            }
          />
        </motion.div>
      </div>
    </div>
  );
}
