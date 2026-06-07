import { crab, type PlaybackStatusPayload, type PlaybackTrackPayload } from "@/src/cmd";
import type {
  SpectrumPlaybackActionSnapshot,
  SpectrumPlaybackIdentity,
} from "./SpectrumPage.view-model";
import {
  isSpectrumPlaybackStatusIdentityForAction,
  projectSpectrumPlaybackIdentity,
  resolveSpectrumPlaybackActionSnapshot,
} from "./SpectrumPage.view-model";

export type SpectrumPlaybackSessionStatus = PlaybackStatusPayload | null;

export interface SpectrumPlaybackSessionPorts {
  getPlaybackStatus(): Promise<SpectrumPlaybackSessionStatus>;
  playSpectrumMusic(
    scopeId: number,
    track: PlaybackTrackPayload,
    positionMs: number | null,
  ): Promise<boolean>;
  pauseSpectrumMusic(scopeId: number): Promise<boolean>;
  updateSpectrumPlaybackLoopSignal(
    scopeId: number,
    payload: SpectrumPlaybackLoopSignalCommandPayload,
  ): Promise<SpectrumPlaybackSessionStatus>;
}

export interface SpectrumPlaybackSession {
  pause(): Promise<boolean>;
  play(args: {
    identity: SpectrumPlaybackIdentity;
    musicName: string;
    positionMs: number | null;
  }): Promise<SpectrumPlaybackSessionStatus>;
  readStatus(): Promise<SpectrumPlaybackSessionStatus>;
  updateLoopSignal(args: {
    endMs: number | null;
    identity: SpectrumPlaybackIdentity;
    musicName: string;
    startMs: number | null;
  }): Promise<SpectrumPlaybackSessionStatus>;
}

export interface SpectrumPlaybackResumePoint {
  identity: SpectrumPlaybackIdentity;
  positionMs: number | null;
}

export type SpectrumPlaybackLoopSignalCommandPayload = {
  track: PlaybackTrackPayload;
  start_ms: number;
  end_ms: number;
};

export function createSpectrumPlaybackTrackPayload(
  identity: SpectrumPlaybackIdentity,
  musicName: string,
  liked = false,
): PlaybackTrackPayload {
  return {
    canonical_music_id: `source:${identity.url.trim()}:${identity.startMs}:${identity.endMs}`,
    end_ms: identity.endMs,
    file_path: identity.filePath,
    liked,
    loudness_profile: null,
    music_name: musicName,
    music_url: identity.url,
    playlist_name: identity.playlistName,
    start_ms: identity.startMs,
  };
}

export function createSpectrumPlaybackLoopSignalPayload(args: {
  endMs: number | null;
  identity: SpectrumPlaybackIdentity;
  musicName: string;
  startMs: number | null;
}): SpectrumPlaybackLoopSignalCommandPayload {
  return {
    end_ms: args.endMs ?? args.identity.endMs,
    start_ms: args.startMs ?? args.identity.startMs,
    track: createSpectrumPlaybackTrackPayload(args.identity, args.musicName),
  };
}

export function isPlaybackStatusForSpectrumIdentity(
  status: SpectrumPlaybackSessionStatus,
  identity: SpectrumPlaybackIdentity,
) {
  return isSpectrumPlaybackStatusIdentityForAction(
    resolveSpectrumPlaybackStatusIdentity(status),
    identity,
  );
}

export function resolvePlaybackAbsolutePositionMs(status: PlaybackStatusPayload) {
  const positionMs = (status.playback_start_ms ?? 0) + status.position_ms;
  return Number.isFinite(positionMs) ? Math.max(0, Math.round(positionMs)) : 0;
}

export function resolveSpectrumPlaybackActionSnapshotFromStatus(
  status: SpectrumPlaybackSessionStatus,
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

export function resolveSpectrumPlaybackResumePointFromStatus(
  status: SpectrumPlaybackSessionStatus,
): SpectrumPlaybackResumePoint | null {
  if (status === null) {
    return null;
  }

  const snapshot = resolveSpectrumPlaybackActionSnapshotFromStatus(status);
  return snapshot === null
    ? null
    : {
        identity: snapshot.identity,
        positionMs: resolvePlaybackAbsolutePositionMs(status),
      };
}

export function resolveSpectrumPlaybackStatusIdentity(status: SpectrumPlaybackSessionStatus) {
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

export function createSpectrumPlaybackSession(args: {
  ports: SpectrumPlaybackSessionPorts;
  scopeId: number | null;
}): SpectrumPlaybackSession {
  const scopeId = args.scopeId;

  async function playTrack(args_: {
    identity: SpectrumPlaybackIdentity;
    musicName: string;
    positionMs: number | null;
  }) {
    if (scopeId === null) {
      return false;
    }

    return args.ports.playSpectrumMusic(
      scopeId,
      createSpectrumPlaybackTrackPayload(args_.identity, args_.musicName),
      args_.positionMs,
    );
  }

  return {
    async pause() {
      if (scopeId === null) {
        return false;
      }

      return args.ports.pauseSpectrumMusic(scopeId);
    },
    async play({ identity, musicName, positionMs }) {
      if (scopeId === null) {
        return null;
      }

      await playTrack({
        identity,
        musicName,
        positionMs,
      });
      return args.ports.getPlaybackStatus();
    },
    readStatus() {
      return args.ports.getPlaybackStatus();
    },
    updateLoopSignal({ endMs, identity, musicName, startMs }) {
      if (scopeId === null) {
        return Promise.resolve(null);
      }

      return args.ports.updateSpectrumPlaybackLoopSignal(
        scopeId,
        createSpectrumPlaybackLoopSignalPayload({
          endMs,
          identity,
          musicName,
          startMs,
        }),
      );
    },
  };
}

type CrabResultLike<T> = {
  match<U>(handlers: { Ok: (value: T) => U; Err: (error: string) => U }): U;
};

function unwrapCrabResult<T>(result: T | CrabResultLike<T>): T {
  if (typeof result === "object" && result !== null && "match" in result) {
    return (result as CrabResultLike<T>).match({
      Ok: (value: T) => value,
      Err: (error: string) => {
        throw new Error(error);
      },
    });
  }

  return result as T;
}

export const crabSpectrumPlaybackSessionPorts: SpectrumPlaybackSessionPorts = {
  async getPlaybackStatus() {
    return unwrapCrabResult<SpectrumPlaybackSessionStatus>(await crab.getPlaybackStatus());
  },
  async playSpectrumMusic(scopeId, track, positionMs) {
    return unwrapCrabResult<boolean>(await crab.playSpectrumMusic(scopeId, track, positionMs));
  },
  async pauseSpectrumMusic(scopeId) {
    return unwrapCrabResult<boolean>(await crab.pauseSpectrumMusic(scopeId));
  },
  async updateSpectrumPlaybackLoopSignal(scopeId, payload) {
    return unwrapCrabResult<PlaybackStatusPayload | null>(
      await crab.updateSpectrumPlaybackLoopSignal(scopeId, payload),
    );
  },
};
