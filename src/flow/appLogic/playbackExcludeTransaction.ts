import type { ExcludeCurrentMusicAndSkipResult } from "@/src/cmd";
import type { ExcludeAddedChange } from "./core";

export interface PlaybackExcludeProjection {
  playingPlaylistName: string | null;
  state: string;
}

export type PlaybackExcludeTransactionResult =
  | {
      kind: "Excluded";
      exclude: ExcludeAddedChange;
      playlistDeleted: null;
      shouldBackOutOfPlay: false;
      status: "skipped";
    }
  | {
      kind: "Excluded";
      exclude: ExcludeAddedChange;
      playlistDeleted: string;
      shouldBackOutOfPlay: boolean;
      status: "deleted_playlist";
    }
  | {
      kind: "Rejected";
      reason: "missing_music" | "no_active_track";
    };

export interface PlaybackExcludeRuntime<TProjection extends PlaybackExcludeProjection> {
  excludeCurrentMusicAndSkip(): Promise<ExcludeCurrentMusicAndSkipResult>;
  getCurrentProjection(): TProjection;
}

export interface PlaybackExcludeSink {
  backOutOfPlay(): void;
  excludeAdded(change: ExcludeAddedChange): void;
  playlistDeleted(playlistName: string): void;
}

export interface PlaybackExcludeTrace<TProjection extends PlaybackExcludeProjection> {
  committed?(input: {
    current: TProjection;
    result: PlaybackExcludeTransactionResult;
    source: TProjection;
  }): void;
  rejected?(input: {
    reason: PlaybackExcludeTransactionResult extends infer TResult
      ? TResult extends { kind: "Rejected"; reason: infer TReason }
        ? TReason
        : never
      : never;
    source: TProjection;
  }): void;
  started?(source: TProjection): void;
}

function shouldBackOutOfDeletedPlaylist(args: {
  current: PlaybackExcludeProjection;
  playlistName: string;
  source: PlaybackExcludeProjection;
}) {
  return (
    args.source.state === "play" &&
    args.current.state === "play" &&
    args.source.playingPlaylistName === args.playlistName &&
    args.current.playingPlaylistName === args.playlistName
  );
}

export function projectPlaybackExcludeResult<TProjection extends PlaybackExcludeProjection>(args: {
  current: TProjection;
  result: ExcludeCurrentMusicAndSkipResult;
  source: TProjection;
}): PlaybackExcludeTransactionResult {
  if (args.result.status === "no_active_track" || args.result.status === "missing_music") {
    return {
      kind: "Rejected",
      reason: args.result.status,
    };
  }

  const exclude = {
    exclude: args.result.exclude,
    excludeAvailability: args.result.exclude_availability,
  };

  if (args.result.status === "skipped") {
    return {
      kind: "Excluded",
      exclude,
      playlistDeleted: null,
      shouldBackOutOfPlay: false,
      status: "skipped",
    };
  }

  return {
    kind: "Excluded",
    exclude,
    playlistDeleted: args.result.playlist_name,
    shouldBackOutOfPlay: shouldBackOutOfDeletedPlaylist({
      current: args.current,
      playlistName: args.result.playlist_name,
      source: args.source,
    }),
    status: "deleted_playlist",
  };
}

export async function runPlaybackExcludeTransaction<
  TProjection extends PlaybackExcludeProjection,
>(args: {
  runtime: PlaybackExcludeRuntime<TProjection>;
  sink: PlaybackExcludeSink;
  source: TProjection;
  trace?: PlaybackExcludeTrace<TProjection>;
}): Promise<PlaybackExcludeTransactionResult> {
  const trace = args.trace ?? {};
  trace.started?.(args.source);

  const backendResult = await args.runtime.excludeCurrentMusicAndSkip();
  const result = projectPlaybackExcludeResult({
    current: args.runtime.getCurrentProjection(),
    result: backendResult,
    source: args.source,
  });

  if (result.kind === "Rejected") {
    trace.rejected?.({
      reason: result.reason,
      source: args.source,
    });
    return result;
  }

  args.sink.excludeAdded(result.exclude);
  if (result.playlistDeleted !== null) {
    args.sink.playlistDeleted(result.playlistDeleted);
  }
  if (result.shouldBackOutOfPlay) {
    args.sink.backOutOfPlay();
  }

  trace.committed?.({
    current: args.runtime.getCurrentProjection(),
    result,
    source: args.source,
  });
  return result;
}
