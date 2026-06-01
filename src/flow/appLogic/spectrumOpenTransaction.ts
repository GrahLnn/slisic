import {
  resolveSpectrumEnterPlaybackModeEffects,
  resolveSpectrumExitPlaybackModeEffects,
  type PlaybackModeEffect,
} from "./playbackMode";

export interface SpectrumOpenSourceIdentity {
  state: string;
  playingPlaylistName: string | null;
  nowPlayingTrackUrl: string | null;
  nowPlayingTrackFilePath: string | null;
  nowPlayingTrackStartMs: number | null;
  nowPlayingTrackEndMs: number | null;
}

export type SpectrumOpenTransactionResult =
  | {
      kind: "Committed";
      openedScopeId: number | null;
    }
  | {
      kind: "Rejected";
      openedScopeId: number | null;
      reason: "stale_source";
    };

export interface SpectrumOpenTransactionRuntime<TProjection extends SpectrumOpenSourceIdentity> {
  applyPlaybackModeEffect(effect: PlaybackModeEffect): Promise<void>;
  enterSpectrumPlaybackScope(): Promise<number>;
  getCurrentProjection(): TProjection;
}

export interface SpectrumOpenTransactionSink {
  openSpectrum(): void;
  scopeChanged(scopeId: number): void;
}

export interface SpectrumOpenTransactionTrace<TProjection extends SpectrumOpenSourceIdentity> {
  committed?(input: { current: TProjection; openedScopeId: number | null }): void;
  rejectedStaleSource?(input: {
    current: TProjection;
    openedScopeId: number | null;
    source: TProjection;
  }): void;
  scopeEntered?(input: { current: TProjection; openedScopeId: number }): void;
  scopeEnterStarted?(current: TProjection): void;
  started?(source: TProjection): void;
}

export function isSpectrumOpenSourceStillCurrent<TProjection extends SpectrumOpenSourceIdentity>(
  source: TProjection,
  current: TProjection,
): boolean {
  return (
    source.state === "play" &&
    current.state === "play" &&
    source.playingPlaylistName === current.playingPlaylistName &&
    source.nowPlayingTrackUrl === current.nowPlayingTrackUrl &&
    source.nowPlayingTrackFilePath === current.nowPlayingTrackFilePath &&
    source.nowPlayingTrackStartMs === current.nowPlayingTrackStartMs &&
    source.nowPlayingTrackEndMs === current.nowPlayingTrackEndMs
  );
}

async function applyPlaybackModeEffects<TProjection extends SpectrumOpenSourceIdentity>(
  runtime: SpectrumOpenTransactionRuntime<TProjection>,
  effects: PlaybackModeEffect[],
) {
  for (const effect of effects) {
    await runtime.applyPlaybackModeEffect(effect);
  }
}

export async function runSpectrumOpenTransaction<
  TProjection extends SpectrumOpenSourceIdentity,
>(args: {
  runtime: SpectrumOpenTransactionRuntime<TProjection>;
  sink: SpectrumOpenTransactionSink;
  source: TProjection;
  trace?: SpectrumOpenTransactionTrace<TProjection>;
}): Promise<SpectrumOpenTransactionResult> {
  let openedScopeId: number | null = null;
  const trace = args.trace ?? {};

  trace.started?.(args.source);

  for (const effect of resolveSpectrumEnterPlaybackModeEffects()) {
    if (effect.kind === "enterSpectrumPlaybackScope") {
      trace.scopeEnterStarted?.(args.runtime.getCurrentProjection());
      openedScopeId = await args.runtime.enterSpectrumPlaybackScope();
      args.sink.scopeChanged(openedScopeId);
      trace.scopeEntered?.({
        openedScopeId,
        current: args.runtime.getCurrentProjection(),
      });
      continue;
    }

    await args.runtime.applyPlaybackModeEffect(effect);
  }

  const current = args.runtime.getCurrentProjection();
  if (!isSpectrumOpenSourceStillCurrent(args.source, current)) {
    trace.rejectedStaleSource?.({
      openedScopeId,
      source: args.source,
      current,
    });
    if (openedScopeId !== null) {
      await applyPlaybackModeEffects(
        args.runtime,
        resolveSpectrumExitPlaybackModeEffects(openedScopeId),
      );
    }
    return {
      kind: "Rejected",
      openedScopeId,
      reason: "stale_source",
    };
  }

  args.sink.openSpectrum();
  trace.committed?.({
    openedScopeId,
    current: args.runtime.getCurrentProjection(),
  });

  return {
    kind: "Committed",
    openedScopeId,
  };
}
