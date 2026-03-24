import {
	createMachines,
	event,
	collect,
} from "@grahlnn/fn/flow";
import { createActor, fromTransition, type AnyActorLogic, type SnapshotFrom } from "xstate";
import type { MusicState } from "./store.types";

export type MusicActorBoundary =
	| "bootstrap_workspace"
	| "playback_session"
	| "draft_operations"
	| "entry_materialization"
	| "save_boundary"
	| "closure_owner_chain";

export interface BootstrapWorkspaceActorInput {
	snapshot: MusicState;
}

export interface PlaybackSessionActorInput {
	snapshot: MusicState;
}

export interface DraftOperationsActorInput {
	snapshot: MusicState;
}

export interface EntryMaterializationActorInput {
	snapshot: MusicState;
}

export interface SaveBoundaryActorInput {
	snapshot: MusicState;
}

export interface ClosureOwnerChainActorInput {
	snapshot: MusicState;
}

export interface MusicMachineContext {
	state: MusicState;
}

export interface MusicMachineInput {
	state: MusicState;
}

export const musicBoundaryEventDefs = collect(
	...event<MusicState>()("state.replace"),
	...event<Partial<MusicState>>()("state.patch"),
	...event<MusicState>()("boundary.bootstrap_workspace.replace"),
	...event<Partial<MusicState>>()("boundary.bootstrap_workspace.patch"),
	...event<MusicState>()("boundary.playback_session.replace"),
	...event<Partial<MusicState>>()("boundary.playback_session.patch"),
	...event<MusicState>()("boundary.draft_operations.replace"),
	...event<Partial<MusicState>>()("boundary.draft_operations.patch"),
	...event<MusicState>()("boundary.entry_materialization.replace"),
	...event<Partial<MusicState>>()("boundary.entry_materialization.patch"),
	...event<MusicState>()("boundary.save_boundary.replace"),
	...event<Partial<MusicState>>()("boundary.save_boundary.patch"),
	...event<MusicState>()("boundary.closure_owner_chain.replace"),
	...event<Partial<MusicState>>()("boundary.closure_owner_chain.patch"),
);

export type MusicMachineEvent =
	(typeof musicBoundaryEventDefs)["infer"][number];

function replaceState(context: MusicMachineContext, next: MusicState): MusicMachineContext {
	return { ...context, state: next };
}

function patchState(
	context: MusicMachineContext,
	patch: Partial<MusicState>,
): MusicMachineContext {
	return { ...context, state: { ...context.state, ...patch } };
}

function createBoundaryLogic() {
	return fromTransition<
		MusicMachineContext,
		MusicMachineEvent,
		any,
		MusicMachineInput,
		any
	>(
		(context, event) => {
			switch (event.type) {
				case "state.replace":
				case "boundary.bootstrap_workspace.replace":
				case "boundary.playback_session.replace":
				case "boundary.draft_operations.replace":
				case "boundary.entry_materialization.replace":
				case "boundary.save_boundary.replace":
				case "boundary.closure_owner_chain.replace":
					return replaceState(context, event.output);
				case "state.patch":
				case "boundary.bootstrap_workspace.patch":
				case "boundary.playback_session.patch":
				case "boundary.draft_operations.patch":
				case "boundary.entry_materialization.patch":
				case "boundary.save_boundary.patch":
				case "boundary.closure_owner_chain.patch":
					return patchState(context, event.output);
				default:
					return context;
			}
		},
		({ input }) => input,
	) as AnyActorLogic;
}

const machines = createMachines({
	bootstrap_workspace: createBoundaryLogic(),
	playback_session: createBoundaryLogic(),
	draft_operations: createBoundaryLogic(),
	entry_materialization: createBoundaryLogic(),
	save_boundary: createBoundaryLogic(),
	closure_owner_chain: createBoundaryLogic(),
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
