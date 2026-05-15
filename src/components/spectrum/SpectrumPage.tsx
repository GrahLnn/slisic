import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { action as appLogicAction, hook as appLogicHook } from "@/src/flow/appLogic";
import { collectionTitleLayoutTransition } from "../collectionTitle";
import type { EditableTitleHandle } from "../EditableTitle";
import type { MusicSpectrumSelection } from "./MusicSpectrumEditor";
import { SpectrumMusicVirtualList } from "./SpectrumMusicVirtualList";
import type {
  TrackSpectrumPlaybackControl,
  TrackSpectrumPlaybackStatusCommit,
} from "./SpectrumVisualizer";
import {
  areSpectrumPlaybackActionSnapshotsEqual,
  areSpectrumPlaybackIdentitiesEqual,
  resolveSpectrumBackActionVisualState,
  resolveSpectrumBackTitleCommitTargets,
  resolveSpectrumMusicRangeChange,
  resolveSpectrumMusicEditorViewModels,
  type SpectrumBackActionVisualState,
  type SpectrumMusicEditorViewModel,
  type SpectrumPlaybackActionKind,
  type SpectrumPlaybackActionSnapshot,
  type SpectrumPlaybackIdentity,
  shouldCommitSpectrumPlaybackActionSnapshot,
} from "./SpectrumPage.view-model";
import {
  crabSpectrumPlaybackSessionPorts,
  createSpectrumPlaybackSession,
  resolvePlaybackAbsolutePositionMs,
  resolveSpectrumPlaybackActionSnapshotFromStatus,
  resolveSpectrumPlaybackResumePointFromStatus,
  type SpectrumPlaybackResumePoint,
  type SpectrumPlaybackSessionStatus,
} from "./SpectrumPlaybackSession";
import { SPECTRUM_PLAYBACK_STATUS_POLL_MS } from "./SpectrumPlaybackAction";
import { usePageRenderFreeze } from "../usePageRenderFreeze";

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

type SpectrumPrimaryPlaybackAnchor = {
  filePath: string | null;
  playlistName: string | null;
  trackEndMs: number | null;
  trackStartMs: number | null;
  url: string | null;
};

function resolvePrimarySpectrumEditor(editors: readonly SpectrumMusicEditorViewModel[]) {
  return editors.find((editor) => editor.isCurrent) ?? editors[0] ?? null;
}

function resolveSpectrumEditorByPlaybackIdentity(
  editors: readonly SpectrumMusicEditorViewModel[],
  identity: SpectrumPlaybackIdentity,
) {
  return editors.find((editor) => editor.playbackIdentity?.key === identity.key) ?? null;
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function createSpectrumPrimaryPlaybackAnchor(args: {
  filePath: string | null;
  playlistName: string | null;
  trackEndMs: number | null;
  trackStartMs: number | null;
  url: string | null;
}): SpectrumPrimaryPlaybackAnchor {
  return {
    filePath: args.filePath,
    playlistName: args.playlistName,
    trackEndMs: args.trackEndMs,
    trackStartMs: args.trackStartMs,
    url: args.url,
  };
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
  const playbackResumeByIdentityRef = useRef(new Map<string, SpectrumPlaybackResumePoint>());
  const playbackControlByIdentityRef = useRef(new Map<string, TrackSpectrumPlaybackControl>());
  const pageExitStartedRef = useRef(false);
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
    spectrumPlaybackScopeId,
    spectrumMusicDrafts,
    titleToneHandoff,
  } = appLogicHook.useContext();
  const primaryPlaybackAnchorRef = useRef<SpectrumPrimaryPlaybackAnchor | null>(null);
  if (primaryPlaybackAnchorRef.current === null) {
    primaryPlaybackAnchorRef.current = createSpectrumPrimaryPlaybackAnchor({
      filePath: nowPlayingTrackFilePath,
      playlistName: playingPlaylistName,
      trackEndMs: nowPlayingTrackEndMs,
      trackStartMs: nowPlayingTrackStartMs,
      url: nowPlayingTrackUrl,
    });
  }
  const primaryPlaybackAnchor = primaryPlaybackAnchorRef.current;
  const handoffTone =
    activeLayoutId && titleToneHandoff?.layoutId === activeLayoutId ? titleToneHandoff.tone : null;
  const editorViewModels = resolveSpectrumMusicEditorViewModels({
    activeLayoutId,
    handoffTone,
    interactionDisabled: !isPresent || spectrumMusicDrafts.length === 0,
    nowPlayingTrackFilePath: primaryPlaybackAnchor.filePath,
    nowPlayingTrackEndMs: primaryPlaybackAnchor.trackEndMs,
    nowPlayingTrackStartMs: primaryPlaybackAnchor.trackStartMs,
    nowPlayingTrackUrl: primaryPlaybackAnchor.url,
    playingPlaylistName: primaryPlaybackAnchor.playlistName,
    spectrumMusicDrafts,
  });
  const liveRenderData = {
    backActionVisualState: resolveSpectrumBackActionVisualState({
      musicDrafts: spectrumMusicDrafts,
    }),
    editorViewModels,
    trackFilePath: primaryPlaybackAnchor.filePath,
  } satisfies SpectrumRenderData;
  const pageRenderFreeze = usePageRenderFreeze(liveRenderData, {
    isPresent,
    freezeOnExit: true,
  });
  const renderData = pageRenderFreeze.renderValue;
  const isPageExiting = !isPresent || pageRenderFreeze.isFrozen;
  const isBackActionLocked = isBackNavigationPending;
  const primaryEditor = resolvePrimarySpectrumEditor(renderData.editorViewModels);
  const primaryPlaybackIdentity = primaryEditor?.playbackIdentity ?? null;
  const playbackSession = useMemo(
    () =>
      createSpectrumPlaybackSession({
        ports: crabSpectrumPlaybackSessionPorts,
        scopeId: spectrumPlaybackScopeId,
      }),
    [spectrumPlaybackScopeId],
  );

  function rememberPlaybackResumePoint(
    identity: SpectrumPlaybackIdentity,
    status: SpectrumPlaybackSessionStatus,
  ) {
    if (status === null) {
      return;
    }

    const snapshot = resolveSpectrumPlaybackActionSnapshotFromStatus(status);
    if (!snapshot || !areSpectrumPlaybackIdentitiesEqual(snapshot.identity, identity)) {
      return;
    }

    playbackResumeByIdentityRef.current.set(identity.key, {
      identity,
      positionMs: resolvePlaybackAbsolutePositionMs(status),
    });
  }

  async function captureCurrentPlaybackResumePoint() {
    let currentStatus: SpectrumPlaybackSessionStatus = null;
    try {
      currentStatus = await playbackSession.readStatus();
    } catch (error) {
      console.error("Failed to capture current spectrum playback resume point", error);
      return null;
    }

    const currentResume = resolveSpectrumPlaybackResumePointFromStatus(currentStatus);
    if (currentResume !== null) {
      playbackResumeByIdentityRef.current.set(currentResume.identity.key, currentResume);
    }
    return currentResume;
  }

  useLayoutEffect(() => {
    if (primaryPlaybackIdentity === null) {
      return;
    }

    if (playbackResumeByIdentityRef.current.has(primaryPlaybackIdentity.key)) {
      return;
    }

    playbackResumeByIdentityRef.current.set(primaryPlaybackIdentity.key, {
      identity: primaryPlaybackIdentity,
      positionMs: null,
    });
  }, [primaryPlaybackIdentity]);

  function handleSpectrumSelectionCommit(
    id: string,
    range: MusicSpectrumSelection,
    commitPlaybackStatus?: TrackSpectrumPlaybackStatusCommit,
  ) {
    const editor = renderData.editorViewModels.find((candidate) => candidate.id === id) ?? null;
    if (!editor) {
      return;
    }

    const nextRange = resolveSpectrumMusicRangeChange(range);
    appLogicAction.changeSpectrumMusicRange({
      id,
      ...nextRange,
    });

    if (!editor.playbackIdentity) {
      return;
    }

    void playbackSession
      .updateLoopSignal({
        endMs: nextRange.endMs,
        identity: editor.playbackIdentity,
        musicName: editor.titleValue,
        startMs: nextRange.startMs,
      })
      .then((status) => {
        commitPlaybackActionSnapshot(status);
        commitPlaybackStatus?.(status);
      })
      .catch((error) => {
        console.error("Failed to update spectrum playback loop signal", error);
      });
  }

  function isNowPlayingSpectrumMusicDeleteRequested() {
    return spectrumMusicDrafts.some(
      (draft) =>
        draft.deleteRequested === true &&
        draft.url === primaryPlaybackAnchor.url &&
        draft.baselineStartMs === primaryPlaybackAnchor.trackStartMs &&
        draft.baselineEndMs === primaryPlaybackAnchor.trackEndMs,
    );
  }

  async function handleBackAction() {
    if (isBackActionLocked) {
      return;
    }

    setIsBackNavigationPending(true);

    try {
      if (renderData.backActionVisualState.kind === "back") {
        pageExitStartedRef.current = true;
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
      pageExitStartedRef.current = true;
      await waitForTitleShareSourceReady();
      await handleRestorePrimarySpectrumMusicPlayback();
      appLogicAction.back();
    } catch (error) {
      console.error("Failed to complete the spectrum back transition", error);
      pageExitStartedRef.current = false;
      setIsBackNavigationPending(false);
    }
  }

  async function handleRestorePrimarySpectrumMusicPlayback() {
    if (isNowPlayingSpectrumMusicDeleteRequested()) {
      return;
    }

    const primaryEditor = resolvePrimarySpectrumEditor(renderData.editorViewModels);
    if (!primaryEditor || primaryEditor.playbackIdentity === null) {
      return;
    }

    const identity = primaryEditor.playbackIdentity;
    const primaryResume = playbackResumeByIdentityRef.current.get(identity.key) ?? null;
    if (primaryResume?.positionMs === null || primaryResume?.positionMs === undefined) {
      return;
    }

    await playbackSession.play({
      identity,
      musicName: primaryEditor.titleValue,
      positionMs: primaryResume.positionMs,
    });
  }

  async function handleSpectrumPlaybackAction(
    identity: SpectrumPlaybackIdentity,
    action: SpectrumPlaybackActionKind,
  ) {
    const editor = resolveSpectrumEditorByPlaybackIdentity(renderData.editorViewModels, identity);
    if (editor === null) {
      return;
    }

    if (action === "pause") {
      const status = playbackControlByIdentityRef.current.get(identity.key)?.commitImmediatePause();
      if (status) {
        rememberPlaybackResumePoint(identity, status);
        commitPlaybackActionSnapshot(status);
      }
      await playbackSession.pause({
        identity,
        musicName: editor.titleValue,
      });
      return;
    } else {
      const currentResume = await captureCurrentPlaybackResumePoint();
      const currentIdentity =
        currentResume?.identity ?? playbackActionSnapshotRef.current?.identity;
      if (
        currentIdentity !== undefined &&
        !areSpectrumPlaybackIdentitiesEqual(currentIdentity, identity)
      ) {
        const control = playbackControlByIdentityRef.current.get(currentIdentity.key);
        const status = control?.commitImmediatePause();
        if (status) {
          rememberPlaybackResumePoint(currentIdentity, status);
        }
      }

      const resume = playbackResumeByIdentityRef.current.get(identity.key) ?? null;
      const status = await playbackSession.play({
        identity,
        musicName: editor.titleValue,
        positionMs: resume?.positionMs ?? identity.startMs,
      });
      commitPlaybackActionSnapshot(status);
    }
  }

  function handlePlaybackControlReady(
    identity: SpectrumPlaybackIdentity | null,
    control: TrackSpectrumPlaybackControl | null,
  ) {
    if (identity === null || control === null) {
      if (identity !== null) {
        playbackControlByIdentityRef.current.delete(identity.key);
      }
      return;
    }

    playbackControlByIdentityRef.current.set(identity.key, control);
  }

  const commitPlaybackActionSnapshotValue = useCallback(
    (snapshot: SpectrumPlaybackActionSnapshot | null) => {
      if (
        !shouldCommitSpectrumPlaybackActionSnapshot({
          isPresent,
          pageExitStarted: pageExitStartedRef.current,
          pageRenderFrozen: pageRenderFreeze.isFrozen,
        })
      ) {
        return;
      }

      if (areSpectrumPlaybackActionSnapshotsEqual(playbackActionSnapshotRef.current, snapshot)) {
        return;
      }

      playbackActionSnapshotRef.current = snapshot;
      setPlaybackActionSnapshot(snapshot);
    },
    [isPresent, pageRenderFreeze.isFrozen],
  );
  const commitPlaybackActionSnapshot = useCallback(
    (status: SpectrumPlaybackSessionStatus) => {
      commitPlaybackActionSnapshotValue(resolveSpectrumPlaybackActionSnapshotFromStatus(status));
    },
    [commitPlaybackActionSnapshotValue],
  );

  useLayoutEffect(() => {
    let disposed = false;

    async function refresh() {
      try {
        const status = await playbackSession.readStatus();
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

    if (isPageExiting) {
      return () => {
        disposed = true;
      };
    }

    void refresh();
    const intervalId = window.setInterval(refresh, SPECTRUM_PLAYBACK_STATUS_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [commitPlaybackActionSnapshot, isPageExiting, playbackSession]);

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
            exitPresentation="local"
            playbackActionSnapshot={playbackActionSnapshot}
            trackFilePath={renderData.trackFilePath}
            onActivateNewTitle={(id) => appLogicAction.startSpectrumMusicCreate(id)}
            onDelete={(id) => appLogicAction.deleteSpectrumMusic(id)}
            onPlaybackAction={handleSpectrumPlaybackAction}
            onPlaybackControlReady={handlePlaybackControlReady}
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
