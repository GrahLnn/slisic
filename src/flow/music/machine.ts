import { createMachines, event, collect } from "@grahlnn/fn/flow";
import {
	createActor,
	fromTransition,
	type AnyActorLogic,
	type SnapshotFrom,
} from "xstate";
import type {
	MusicState,
	ProcessHintProjection,
	StartupRouteResolution,
	WorkspaceScreen,
} from "./store.types";
import {
	deriveClosureProjection,
	deriveDraftReviewState,
	derivePlaybackOwnedList,
	deriveProcessHintProjection,
	deriveRouteResolution,
	projectWorkspaceScreen,
} from "./store.projections";

export type MusicActorBoundary =
	| "bootstrap_workspace"
	| "playback_session"
	| "draft_operations"
	| "entry_materialization"
	| "save_boundary"
	| "closure_owner_chain";

export interface BootstrapWorkspaceActorState {
	route: StartupRouteResolution;
	screen: WorkspaceScreen;
	runId: number;
	startupFailure: string | null;
	isLoading: boolean;
}

export interface PlaybackSessionActorState {
	snapshot: MusicState;
	playbackOwnedListName: string | null;
	requestedPath: string | null;
	confirmedPath: string | null;
	nowPlayingPath: string | null;
}

export interface DraftOperationsActorState {
	snapshot: MusicState;
	activeReviewKeys: string[];
	linkReviewKeys: string[];
	folderReviewKeys: string[];
	weblistReviewKeys: string[];
}

export interface EntryMaterializationActorState {
	snapshot: MusicState;
	processHint: ProcessHintProjection | null;
}

export interface SaveBoundaryActorState {
	snapshot: MusicState;
	entrySessionId: number;
	closureOwnerSessionId: number;
}

export interface ClosureOwnerChainActorState {
	snapshot: MusicState;
	projection: ReturnType<typeof deriveClosureProjection>;
}

export interface MusicMachineInput {
	snapshot: MusicState;
	bootstrapRunId?: number;
	bootstrapFailure?: string | null;
}

export interface MusicMachineContextMap {
	bootstrap_workspace: BootstrapWorkspaceActorState;
	playback_session: PlaybackSessionActorState;
	draft_operations: DraftOperationsActorState;
	entry_materialization: EntryMaterializationActorState;
	save_boundary: SaveBoundaryActorState;
	closure_owner_chain: ClosureOwnerChainActorState;
}

export const musicBoundaryEventDefs = collect(
	...event<MusicState>()("boundary.bootstrap_workspace.replace"),
	...event<{ runId: number }>()("boundary.bootstrap_workspace.run_started"),
	...event<{ runId: number; playlistNames: string[] }>()(
		"boundary.bootstrap_workspace.probe_completed",
	),
	...event<{ runId: number; startupFailure: string }>()(
		"boundary.bootstrap_workspace.run_failed",
	),
	...event<{ runId: number }>()("boundary.bootstrap_workspace.run_finished"),
	...event<{ snapshot: MusicState }>()("boundary.bootstrap_workspace.workspace_entered"),
	...event<{ snapshot: MusicState }>()("boundary.bootstrap_workspace.workspace_exited"),
	...event<{ snapshot: MusicState }>()("boundary.bootstrap_workspace.save_settled"),
	...event<MusicState>()("boundary.playback_session.replace"),
	...event<MusicState>()("boundary.draft_operations.replace"),
	...event<MusicState>()("boundary.entry_materialization.replace"),
	...event<MusicState>()("boundary.save_boundary.replace"),
	...event<MusicState>()("boundary.closure_owner_chain.replace"),
);

export type MusicMachineEvent =
	(typeof musicBoundaryEventDefs)["infer"][number];

type BootstrapWorkspaceMachineEvent =
	| Extract<
			MusicMachineEvent,
			{ type: "boundary.bootstrap_workspace.run_started" }
	  >
	| Extract<
			MusicMachineEvent,
			{ type: "boundary.bootstrap_workspace.probe_completed" }
	  >
	| Extract<
			MusicMachineEvent,
			{ type: "boundary.bootstrap_workspace.run_failed" }
	  >
	| Extract<
			MusicMachineEvent,
			{ type: "boundary.bootstrap_workspace.run_finished" }
	  >
	| Extract<
			MusicMachineEvent,
			{ type: "boundary.bootstrap_workspace.workspace_entered" }
	  >
	| Extract<
			MusicMachineEvent,
			{ type: "boundary.bootstrap_workspace.workspace_exited" }
	  >
	| Extract<
			MusicMachineEvent,
			{ type: "boundary.bootstrap_workspace.save_settled" }
	  >;

function createBootstrapWorkspaceState({
	snapshot,
	runId,
	startupFailure,
}: {
	snapshot: Pick<MusicState, "mode" | "routeResolved" | "startupRoute">;
	runId: number;
	startupFailure: string | null;
}): BootstrapWorkspaceActorState {
	return {
		route: deriveRouteResolution(snapshot, { kind: snapshot.startupRoute }),
		screen: projectWorkspaceScreen(snapshot),
		runId,
		startupFailure,
		isLoading: !snapshot.routeResolved && startupFailure == null,
	};
}

function createPlaybackSessionState(
	snapshot: MusicState,
): PlaybackSessionActorState {
	const playbackOwnedList = derivePlaybackOwnedList(snapshot);
	return {
		snapshot,
		playbackOwnedListName: playbackOwnedList?.name ?? null,
		requestedPath: snapshot.requestedPlaying?.path ?? null,
		confirmedPath: snapshot.confirmedPlaying?.path ?? null,
		nowPlayingPath: snapshot.nowPlaying?.path ?? null,
	};
}

function createDraftOperationsState(
	snapshot: MusicState,
): DraftOperationsActorState {
	const reviews = deriveDraftReviewState(snapshot);
	return {
		snapshot,
		activeReviewKeys: reviews.active.map((review) => `${review.kind}:${review.key}`),
		linkReviewKeys: reviews.linkReviews,
		folderReviewKeys: reviews.folderReviews,
		weblistReviewKeys: reviews.weblistReviews,
	};
}

function createEntryMaterializationState(
	snapshot: MusicState,
): EntryMaterializationActorState {
	return {
		snapshot,
		processHint: deriveProcessHintProjection(snapshot.processMsg),
	};
}

function createSaveBoundaryState(snapshot: MusicState): SaveBoundaryActorState {
	return {
		snapshot,
		entrySessionId: snapshot.entrySessionId,
		closureOwnerSessionId: snapshot.closureOwnerSessionId,
	};
}

function createClosureOwnerChainState(
	snapshot: MusicState,
): ClosureOwnerChainActorState {
	return {
		snapshot,
		projection: deriveClosureProjection(snapshot),
	};
}

function createBoundaryState<K extends MusicActorBoundary>(
	boundary: K,
	snapshot: MusicState,
	input?: MusicMachineInput,
): MusicMachineContextMap[K] {
	switch (boundary) {
		case "bootstrap_workspace":
			return createBootstrapWorkspaceState({
				snapshot,
				runId: input?.bootstrapRunId ?? 0,
				startupFailure: input?.bootstrapFailure ?? null,
			}) as MusicMachineContextMap[K];
		case "playback_session":
			return createPlaybackSessionState(snapshot) as MusicMachineContextMap[K];
		case "draft_operations":
			return createDraftOperationsState(snapshot) as MusicMachineContextMap[K];
		case "entry_materialization":
			return createEntryMaterializationState(snapshot) as MusicMachineContextMap[K];
		case "save_boundary":
			return createSaveBoundaryState(snapshot) as MusicMachineContextMap[K];
		case "closure_owner_chain":
			return createClosureOwnerChainState(snapshot) as MusicMachineContextMap[K];
	}
}

function createBoundaryLogic<K extends MusicActorBoundary>(boundary: K) {
	const applyBootstrapWorkspaceEvent = (
		context: BootstrapWorkspaceActorState,
		event: BootstrapWorkspaceMachineEvent,
	): BootstrapWorkspaceActorState => {
		switch (event.type) {
			case "boundary.bootstrap_workspace.run_started":
				return {
					...context,
					runId: event.output.runId,
					startupFailure: null,
					isLoading: true,
				};
			case "boundary.bootstrap_workspace.probe_completed":
				return {
					...context,
					runId: event.output.runId,
					startupFailure: null,
					isLoading: true,
				};
			case "boundary.bootstrap_workspace.run_failed":
				return {
					...context,
					runId: event.output.runId,
					route: {
						kind: "startup_failed",
						routeResolved: true,
						mode: "new_guide",
						phase: "hydrated",
					},
					screen: "guide",
					startupFailure: event.output.startupFailure,
					isLoading: false,
				};
			case "boundary.bootstrap_workspace.run_finished":
				return context.runId !== event.output.runId
					? context
					: {
							...context,
							isLoading: false,
						};
			case "boundary.bootstrap_workspace.workspace_entered":
			case "boundary.bootstrap_workspace.workspace_exited":
			case "boundary.bootstrap_workspace.save_settled":
				return createBoundaryState("bootstrap_workspace", event.output.snapshot, {
					snapshot: event.output.snapshot,
					bootstrapRunId: context.runId,
					bootstrapFailure: context.startupFailure,
				});
		}
	};

	return fromTransition<
		MusicMachineContextMap[K],
		MusicMachineEvent,
		any,
		MusicMachineInput,
		any
	>(
		(context, event) => {
			switch (event.type) {
				case "boundary.bootstrap_workspace.replace":
					return boundary === "bootstrap_workspace"
						? createBoundaryState(boundary, event.output, {
								snapshot: event.output,
								bootstrapRunId: (
									context as BootstrapWorkspaceActorState
								).runId,
								bootstrapFailure: (
									context as BootstrapWorkspaceActorState
								).startupFailure,
							})
						: context;
				case "boundary.bootstrap_workspace.run_started":
					return boundary === "bootstrap_workspace"
						? (applyBootstrapWorkspaceEvent(
								context as BootstrapWorkspaceActorState,
								event,
							) as MusicMachineContextMap[K])
						: context;
				case "boundary.bootstrap_workspace.probe_completed":
					return boundary === "bootstrap_workspace"
						? (applyBootstrapWorkspaceEvent(
								context as BootstrapWorkspaceActorState,
								event,
							) as MusicMachineContextMap[K])
						: context;
				case "boundary.bootstrap_workspace.run_failed":
					return boundary === "bootstrap_workspace"
						? (applyBootstrapWorkspaceEvent(
								context as BootstrapWorkspaceActorState,
								event,
							) as MusicMachineContextMap[K])
						: context;
				case "boundary.bootstrap_workspace.run_finished":
					return boundary === "bootstrap_workspace"
						? (applyBootstrapWorkspaceEvent(
								context as BootstrapWorkspaceActorState,
								event,
							) as MusicMachineContextMap[K])
						: context;
				case "boundary.bootstrap_workspace.workspace_entered":
				case "boundary.bootstrap_workspace.workspace_exited":
				case "boundary.bootstrap_workspace.save_settled":
					return boundary === "bootstrap_workspace"
						? (applyBootstrapWorkspaceEvent(
								context as BootstrapWorkspaceActorState,
								event,
							) as MusicMachineContextMap[K])
						: context;
				case "boundary.playback_session.replace":
					return boundary === "playback_session"
						? createBoundaryState(boundary, event.output)
						: context;
				case "boundary.draft_operations.replace":
					return boundary === "draft_operations"
						? createBoundaryState(boundary, event.output)
						: context;
				case "boundary.entry_materialization.replace":
					return boundary === "entry_materialization"
						? createBoundaryState(boundary, event.output)
						: context;
				case "boundary.save_boundary.replace":
					return boundary === "save_boundary"
						? createBoundaryState(boundary, event.output)
						: context;
				case "boundary.closure_owner_chain.replace":
					return boundary === "closure_owner_chain"
						? createBoundaryState(boundary, event.output)
						: context;
				default:
					return context;
			}
		},
		({ input }) => createBoundaryState(boundary, input.snapshot),
	) as AnyActorLogic;
}

const machines = createMachines({
	bootstrap_workspace: createBoundaryLogic("bootstrap_workspace"),
	playback_session: createBoundaryLogic("playback_session"),
	draft_operations: createBoundaryLogic("draft_operations"),
	entry_materialization: createBoundaryLogic("entry_materialization"),
	save_boundary: createBoundaryLogic("save_boundary"),
	closure_owner_chain: createBoundaryLogic("closure_owner_chain"),
});

export const musicMachine = machines;
export type MusicBoundaryLogic = ReturnType<typeof createBoundaryLogic>;
export type MusicMachineSnapshot = SnapshotFrom<MusicBoundaryLogic>;
export type MusicMachineActor = ReturnType<typeof createActor<MusicBoundaryLogic>>;

export const MUSIC_MACHINE_BOUNDARIES: MusicActorBoundary[] = [
	"bootstrap_workspace",
	"playback_session",
	"draft_operations",
	"entry_materialization",
	"save_boundary",
	"closure_owner_chain",
];
