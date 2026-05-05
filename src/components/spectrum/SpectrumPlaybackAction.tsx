import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";
import { crab, type PlaybackStatusPayload } from "@/src/cmd";
import { normalizeMediaPathKey } from "@/src/mediaPath";
import {
  resolveSpectrumPlaybackActionVisualState,
  type SpectrumPlaybackActionVisualState,
} from "./SpectrumPage.view-model";

const SPECTRUM_PLAYBACK_STATUS_POLL_MS = 250;

const spectrumPlaybackIconTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1],
} as const;

type SpectrumPlaybackSnapshot = Pick<PlaybackStatusPayload, "paused">;

type SpectrumPlaybackSnapshotCommit = (snapshot: SpectrumPlaybackSnapshot | null) => void;

export function areSpectrumPlaybackSnapshotsEqual(
  left: SpectrumPlaybackSnapshot | null,
  right: SpectrumPlaybackSnapshot | null,
) {
  return left?.paused === right?.paused;
}

function useSpectrumPlaybackStatus(filePath: string | null) {
  const [snapshot, setSnapshot] = useState<SpectrumPlaybackSnapshot | null>(null);
  const commitSnapshot = useCallback<SpectrumPlaybackSnapshotCommit>((nextSnapshot) => {
    setSnapshot((current) =>
      areSpectrumPlaybackSnapshotsEqual(current, nextSnapshot) ? current : nextSnapshot,
    );
  }, []);

  const read = useCallback(async () => {
    if (!filePath) {
      return null;
    }

    const result = await crab.getPlaybackStatus();
    const status = result.match({
      Ok: (value) => value,
      Err: (error) => {
        throw new Error(error);
      },
    });

    return status && isSpectrumPlaybackStatusForTrack(status, filePath)
      ? {
          paused: status.paused,
        }
      : null;
  }, [filePath]);

  const refresh = useCallback(async () => {
    const nextSnapshot = await read();
    commitSnapshot(nextSnapshot);
    return nextSnapshot;
  }, [commitSnapshot, read]);

  useSpectrumPlaybackStatusPolling({
    commitSnapshot,
    read,
  });

  return { refresh, snapshot };
}

function useSpectrumPlaybackStatusPolling(args: {
  commitSnapshot: SpectrumPlaybackSnapshotCommit;
  read: () => Promise<SpectrumPlaybackSnapshot | null>;
}) {
  const { commitSnapshot, read } = args;

  useEffect(() => {
    let disposed = false;

    async function refreshCurrentPlayback() {
      try {
        const result = await read();
        if (disposed) {
          return;
        }
        commitSnapshot(result);
      } catch (error) {
        if (!disposed) {
          console.error("Failed to refresh spectrum playback status", error);
          commitSnapshot(null);
        }
      }
    }

    void refreshCurrentPlayback();
    const intervalId = window.setInterval(refreshCurrentPlayback, SPECTRUM_PLAYBACK_STATUS_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [commitSnapshot, read]);
}

function isSpectrumPlaybackStatusForTrack(status: PlaybackStatusPayload, filePath: string) {
  return (
    status.path !== null && normalizeMediaPathKey(status.path) === normalizeMediaPathKey(filePath)
  );
}

function SpectrumPlaybackPauseIcon({ replayKey }: { replayKey: string }) {
  return (
    <motion.svg
      key={replayKey}
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className="absolute inset-0 block"
    >
      <g fill="currentColor">
        <motion.path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M2 3.75C2 2.78334 2.78393 2 3.75 2H5.25C6.21607 2 7 2.78334 7 3.75V14.25C7 15.2167 6.21607 16 5.25 16H3.75C2.78393 16 2 15.2167 2 14.25V3.75Z"
          stroke="currentColor"
          strokeWidth="0.45"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ fillOpacity: 0, pathLength: 0 }}
          animate={{ fillOpacity: 0.4, pathLength: 1 }}
          exit={{ fillOpacity: 0, pathLength: 0 }}
          transition={spectrumPlaybackIconTransition}
        />
        <motion.path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M11 3.75C11 2.78334 11.7839 2 12.75 2H14.25C15.2161 2 16 2.78334 16 3.75V14.25C16 15.2167 15.2161 16 14.25 16H12.75C11.7839 16 11 15.2167 11 14.25V3.75Z"
          stroke="currentColor"
          strokeWidth="0.45"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ fillOpacity: 0, pathLength: 0 }}
          animate={{ fillOpacity: 1, pathLength: 1 }}
          exit={{ fillOpacity: 0, pathLength: 0 }}
          transition={{
            ...spectrumPlaybackIconTransition,
            delay: 0.02,
          }}
        />
      </g>
    </motion.svg>
  );
}

function SpectrumPlaybackPlayIcon({ replayKey }: { replayKey: string }) {
  return (
    <motion.svg
      key={replayKey}
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className="absolute inset-0 block"
    >
      <g fill="currentColor">
        <motion.path
          d="M15.1 7.478L5.608 2.222C5.055 1.916 4.402 1.925 3.859 2.245C3.321 2.562 3 3.122 3 3.744V14.256C3 14.878 3.321 15.438 3.859 15.755C4.138 15.919 4.445 16.002 4.754 16.002C5.047 16.002 5.34 15.927 5.608 15.779L15.099 10.523C15.655 10.216 16 9.632 16 9.001C16 8.37 15.655 7.785 15.1 7.478Z"
          stroke="currentColor"
          strokeWidth="0.45"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ fillOpacity: 0, pathLength: 0 }}
          animate={{ fillOpacity: 0.4, pathLength: 1 }}
          exit={{ fillOpacity: 0, pathLength: 0 }}
          transition={spectrumPlaybackIconTransition}
        />
      </g>
    </motion.svg>
  );
}

function SpectrumPlaybackIconOwner({
  visualState,
}: {
  visualState: SpectrumPlaybackActionVisualState;
}) {
  return (
    <span className="absolute inset-0 block">
      {visualState.kind === "play" ? (
        <SpectrumPlaybackPlayIcon replayKey={visualState.key} />
      ) : (
        <SpectrumPlaybackPauseIcon replayKey={visualState.key} />
      )}
    </span>
  );
}

function SpectrumPlaybackIcon({ visualState }: { visualState: SpectrumPlaybackActionVisualState }) {
  return (
    <span className="relative block size-4.5">
      <AnimatePresence initial={false} mode="wait">
        <SpectrumPlaybackIconOwner key={visualState.kind} visualState={visualState} />
      </AnimatePresence>
    </span>
  );
}

export function SpectrumPlaybackAction({ filePath }: { filePath: string | null }) {
  const isPresent = useIsPresent();
  const [isPlaybackActionPending, setIsPlaybackActionPending] = useState(false);
  const playbackStatus = useSpectrumPlaybackStatus(filePath);
  const visualState = resolveSpectrumPlaybackActionVisualState({
    hasCurrentTrack: playbackStatus.snapshot !== null,
    isPending: isPlaybackActionPending,
    isPresent,
    paused: playbackStatus.snapshot?.paused === true,
  });

  async function handlePlaybackAction() {
    if (visualState.disabled) {
      return;
    }

    setIsPlaybackActionPending(true);

    try {
      const result =
        visualState.kind === "play" ? await crab.resumePlayback() : await crab.pausePlayback();

      result.match({
        Ok: () => undefined,
        Err: (error) => {
          throw new Error(error);
        },
      });

      await playbackStatus.refresh();
    } catch (error) {
      console.error("Failed to toggle spectrum playback", error);
    } finally {
      setIsPlaybackActionPending(false);
    }
  }

  return (
    <button
      type="button"
      aria-label={visualState.ariaLabel}
      disabled={visualState.disabled}
      onClick={() => {
        void handlePlaybackAction();
      }}
      className={cn(
        "group relative isolate inline-flex size-8 items-center justify-center rounded-[25px] p-2",
        "text-[#737373] transition duration-300 [corner-shape:squircle_squircle_squircle_squircle]",
        "before:absolute before:inset-0 before:-z-10 before:rounded-[25px] before:bg-transparent",
        "before:transition before:duration-300 before:[corner-shape:squircle_squircle_squircle_squircle]",
        "hover:text-[#262626] hover:before:bg-[#e5e5e5]",
        "dark:text-[#8a8a8a] dark:hover:text-[#d4d4d4] dark:hover:before:bg-[#262626]",
        visualState.disabled && "pointer-events-none",
        visualState.dimmed && "opacity-35",
      )}
    >
      <SpectrumPlaybackIcon visualState={visualState} />
    </button>
  );
}
