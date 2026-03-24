import { me } from "@grahlnn/fn";
import { Effect } from "effect";
import { useMemo, useSyncExternalStore } from "react";
import { sileo } from "sileo";
import { createActor } from "xstate";
import { crab } from "@/src/cmd";
import type {
	CollectMission,
	Entry,
	LinkSample,
	Music,
	Playlist,
	ProcessMsg,
} from "@/src/cmd/commands";
import {
	avoidRecentlyPlayed,
	canPersistMission,
	entryKey,
	inferEntryType,
	isValidUrl,
	pushRecentPath,
	sameTrack,
	sampleSoftMin,
} from "./logic";
import {
	MUSIC_MACHINE_BOUNDARIES,
	type MusicActorBoundary,
	type MusicMachineActor,
	type MusicMachineSnapshot,
	musicBoundaryEventDefs,
	musicMachine,
} from "./machine";
import { PlaybackCoordinator } from "./playbackCoordinator";
import {
	carryForwardPersistedMaterializationOwnership,
	createClosureEventContract,
	createDraftOperation,
	deriveEntryIdentity,
	derivePersistedOwnerIdentity,
	deriveProcessMsgIdentityHint,
	getDraftEntryOperation,
	getEntryMaterialization,
	isEditingWorkspace,
	replaceEntryByIdentity,
	setDraftEntryOperation,
	setDraftLinkOperation,
	setPlaylistEntryMaterializationByIdentity,
	settleDraftOperation,
	syncEntryOwnedMaterialization,
} from "./store.identity";
import {
	applyOptimisticEditSave,
	buildOptimisticPlaylistFromSlot,
	buildPostSavePatch,
	canExitWorkspace,
	canMutateSettledEntry,
	canSettleClosureEvent,
	clearEndedPlaybackForFallback,
	clearPlaybackSession,
	clearPlaybackTransportFact,
	deriveBackTransition,
	deriveClosureOwnerIdentityFromMission,
	deriveClosureProjection,
	deriveClosureProjectionEntry,
	deriveDraftReviewState,
	derivePlaybackOwnedList,
	deriveProbePatch,
	deriveProcessHintProjection,
	deriveRefreshPatch,
	deriveSaveAffordance,
	deriveWorkspaceEntryPatch,
	hasPlaybackContext,
	mapImportFolderEntryToEntry,
	projectEditingListName,
	projectFocusedListName,
	settlePlaybackAck,
	shouldAdvanceOnUnstar,
	shouldHandleAudioEnded,
} from "./store.projections";
import type {
	DraftEntryOperationState,
	DraftMissionState,
	MusicState,
	ProcessHintProjection,
	UiMode,
} from "./store.types";

export type {
	MusicActorBoundary,
	MusicMachineActor,
	MusicMachineSnapshot,
} from "./machine";
export {
	MUSIC_MACHINE_BOUNDARIES,
	musicMachine,
} from "./machine";
export { createClosureEventContract } from "./store.identity";
export {
	applyOptimisticEditSave,
	buildOptimisticPlaylistFromSlot,
	buildPlaylistPlaceholders,
	buildPostSavePatch,
	canExitWorkspace,
	canSettleClosureEvent,
	canSettleClosureEvents,
	clearEndedPlaybackForFallback,
	clearPlaybackSession,
	clearPlaybackTransportFact,
	deriveBackTransition,
	deriveClosureProjection,
	deriveDraftReviewState,
	derivePlaybackOwnedList,
	deriveProbePatch,
	deriveProcessHintProjection,
	deriveRefreshPatch,
	deriveRouteResolution,
	deriveSaveAffordance,
	deriveWorkspaceEntryPatch,
	hasPlaybackContext,
	mapImportFolderEntryToEntry,
	projectEditingListName,
	projectFocusedListName,
	projectWorkspaceScreen,
	settlePlaybackAck,
	shouldAdvanceOnUnstar,
	shouldHandleAudioEnded,
} from "./store.projections";
export type {
	ClosureProjection,
	DraftEntryOperationState,
	DraftLinkState,
	DraftMissionState,
	MusicState,
	ProcessHintProjection,
} from "./store.types";

function toPlaybackContractSessionId(sessionId: number): number {
	return sessionId;
}

const initialState: MusicState = {
	mode: "new_guide",
	routeResolved: false,
	startupRoute: "startup_unresolved",
	loading: false,
	playlists: [],
	selectedListName: null,
	focusedListName: null,
	editingListName: null,
	playbackListName: null,
	requestedPlaying: null,
	confirmedPlaying: null,
	nowPlaying: null,
	nowJudge: null,
	slot: null,
	processMsg: null,
	ytdlp: null,
	ffmpeg: null,
	savePath: null,
	entrySessionId: 0,
	closureOwnerSessionId: 0,
	playbackEpoch: 0,
	playbackSessionId: null,
	playbackRequestedListName: null,
};

const listeners = new Set<() => void>();
let state: MusicState = normalizeMusicState({ ...initialState });
let started = false;
const unsubs: Array<() => void> = [];
const recentByList = new Map<string, string[]>();
const playback = new PlaybackCoordinator();
let bootstrapRunId = 0;
let bootstrapStartupFailure: string | null = null;
const machineActors = Object.fromEntries(
	MUSIC_MACHINE_BOUNDARIES.map((boundary) => [
		boundary,
		createActor(musicMachine[boundary].logic, {
			input: {
				snapshot: state,
				bootstrapRunId,
				bootstrapFailure: bootstrapStartupFailure,
			},
		}),
	]),
) as Record<MusicActorBoundary, MusicMachineActor>;

for (const actor of Object.values(machineActors)) {
	actor.start();
}

function recentWindowSize(trackCount: number): number {
	if (trackCount <= 1) return 0;
	return Math.min(3, trackCount - 1);
}

function emit() {
	for (const listener of listeners) {
		listener();
	}
}

function normalizeMusicState(snapshot: MusicState): MusicState {
	const editingListName =
		snapshot.editingListName ??
		(snapshot.mode === "edit" ? snapshot.selectedListName : null);
	const focusedListName =
		snapshot.focusedListName ??
		(snapshot.mode === "play" ? snapshot.selectedListName : null);
	const selectedListName =
		snapshot.mode === "edit"
			? (snapshot.selectedListName ?? editingListName ?? null)
			: snapshot.selectedListName;
	return {
		...snapshot,
		selectedListName,
		focusedListName,
		editingListName,
	};
}

function getMachineSnapshot(): MusicMachineSnapshot {
	return machineActors.bootstrap_workspace.getSnapshot();
}

function replaceBoundaryState(boundary: MusicActorBoundary, next: MusicState) {
	const event =
		musicBoundaryEventDefs[`boundary.${boundary}.replace`].load(next);
	machineActors[boundary].send(event);
}

function sendBootstrapRunStarted(runId: number) {
	machineActors.bootstrap_workspace.send(
		musicBoundaryEventDefs["boundary.bootstrap_workspace.run_started"].load({
			runId,
		}),
	);
}

function sendBootstrapProbeCompleted(runId: number, playlistNames: string[]) {
	machineActors.bootstrap_workspace.send(
		musicBoundaryEventDefs["boundary.bootstrap_workspace.probe_completed"].load(
			{
				runId,
				playlistNames,
			},
		),
	);
}

function sendBootstrapRunFailed(runId: number, startupFailure: string) {
	machineActors.bootstrap_workspace.send(
		musicBoundaryEventDefs["boundary.bootstrap_workspace.run_failed"].load({
			runId,
			startupFailure,
		}),
	);
}

function sendBootstrapRunFinished(runId: number) {
	machineActors.bootstrap_workspace.send(
		musicBoundaryEventDefs["boundary.bootstrap_workspace.run_finished"].load({
			runId,
		}),
	);
}

function sendBootstrapWorkspaceEntered(
	kind: "create" | "edit",
	entrySessionId: number,
	closureOwnerSessionId: number,
	playlist?: Playlist,
) {
	machineActors.bootstrap_workspace.send(
		musicBoundaryEventDefs[
			"boundary.bootstrap_workspace.workspace_entered"
		].load({
			kind,
			entrySessionId,
			closureOwnerSessionId,
			playlist,
		}),
	);
}

function sendBootstrapWorkspaceExited(snapshot: MusicState) {
	machineActors.bootstrap_workspace.send(
		musicBoundaryEventDefs[
			"boundary.bootstrap_workspace.workspace_exited"
		].load({
			playlistsLength: snapshot.playlists.length,
			routeResolved: snapshot.routeResolved,
			entrySessionId: snapshot.entrySessionId,
			closureOwnerSessionId: snapshot.closureOwnerSessionId,
		}),
	);
}

function sendBootstrapSaveSettled(snapshot: MusicState) {
	machineActors.bootstrap_workspace.send(
		musicBoundaryEventDefs["boundary.bootstrap_workspace.save_settled"].load({
			playlistsLength: snapshot.playlists.length,
			entrySessionId: snapshot.entrySessionId,
			closureOwnerSessionId: snapshot.closureOwnerSessionId,
		}),
	);
}

function syncPlaybackTransportHandoff(snapshot: MusicState) {
	machineActors.playback_transport_handoff.send(
		musicBoundaryEventDefs["boundary.playback_transport_handoff.sync"].load({
			snapshot,
			fact: null,
		}),
	);
}

function sendPlaybackTransportFact(
	snapshot: MusicState,
	sessionId: number | null,
	fact: "stopped" | "ended" | "failed" | "paused" | "resumed",
) {
	machineActors.playback_transport_handoff.send(
		musicBoundaryEventDefs[
			"boundary.playback_transport_handoff.transport_fact_received"
		].load({
			snapshot,
			sessionId,
			fact,
		}),
	);
}

function syncCompatibilityShell(nextState: MusicState) {
	for (const boundary of MUSIC_MACHINE_BOUNDARIES) {
		if (
			boundary === "bootstrap_workspace" ||
			boundary === "playback_transport_handoff"
		) {
			continue;
		}
		replaceBoundaryState(boundary, nextState);
	}
	syncPlaybackTransportHandoff(nextState);
}

function setState(next: MusicState | ((prev: MusicState) => MusicState)) {
	state = normalizeMusicState(typeof next === "function" ? next(state) : next);
	syncCompatibilityShell(state);
	emit();
}

function patchState(patch: Partial<MusicState>) {
	setState((prev) => ({ ...prev, ...patch }));
}

function sanitizeProcessMsgHint(
	previousPlaylists: Playlist[],
	snapshot: Pick<MusicState, "playlists" | "processMsg">,
): ProcessMsg | null {
	const hint = snapshot.processMsg;
	if (!hint) return null;
	const previouslyKnown = previousPlaylists.some(
		(playlist) => playlist.name === hint.playlist,
	);
	if (!previouslyKnown) return hint;
	return snapshot.playlists.some((playlist) => playlist.name === hint.playlist)
		? hint
		: null;
}

function sanitizeLiveProcessMsgHint(
	snapshot: Pick<
		MusicState,
		| "playlists"
		| "selectedListName"
		| "playbackListName"
		| "confirmedPlaying"
		| "nowPlaying"
		| "processMsg"
		| "entrySessionId"
		| "closureOwnerSessionId"
	>,
): ProcessMsg | null {
	const hint = snapshot.processMsg;
	if (!hint) return null;

	const hintedPlaylist = snapshot.playlists.find(
		(playlist) => playlist.name === hint.playlist,
	);
	if (!hintedPlaylist) return hint;

	const hintedEntry =
		hintedPlaylist.entries.find(
			(entry) => derivePersistedOwnerIdentity(entry) != null,
		) ?? null;
	if (!hintedEntry) return hint;

	const hintedIdentity = derivePersistedOwnerIdentity(hintedEntry);
	if (!hintedIdentity) return hint;

	if (snapshot.entrySessionId !== snapshot.closureOwnerSessionId) {
		return hint;
	}

	if (snapshot.closureOwnerSessionId <= 0) {
		return hint;
	}

	const closureEntry = deriveClosureProjectionEntry(snapshot);
	if (!closureEntry) {
		const hintedPathIdentity = deriveProcessMsgIdentityHint(hint);
		if (hintedPathIdentity && hintedPathIdentity !== hintedIdentity) {
			return null;
		}
		return hint;
	}

	const liveEntryIdentity = derivePersistedOwnerIdentity(closureEntry);
	if (!liveEntryIdentity) return hint;
	if (hintedIdentity !== liveEntryIdentity) {
		return null;
	}

	const hintedPathIdentity = deriveProcessMsgIdentityHint(hint);
	if (!hintedPathIdentity) {
		return hint;
	}

	if (hintedPathIdentity !== liveEntryIdentity) {
		return null;
	}

	return hint;
}

function patchHintOnlyProcessMsg(payload: unknown) {
	if (
		!payload ||
		typeof payload !== "object" ||
		!("playlist" in payload) ||
		typeof (payload as { playlist?: unknown }).playlist !== "string" ||
		!("str" in payload) ||
		typeof (payload as { str?: unknown }).str !== "string"
	) {
		return;
	}

	const processMsg = payload as ProcessMsg;
	setState((prev) => ({
		...prev,
		processMsg: sanitizeLiveProcessMsgHint({
			playlists: prev.playlists,
			selectedListName: prev.selectedListName,
			playbackListName: prev.playbackListName,
			confirmedPlaying: prev.confirmedPlaying,
			nowPlaying: prev.nowPlaying,
			processMsg,
			entrySessionId: prev.entrySessionId,
			closureOwnerSessionId: prev.closureOwnerSessionId,
		}),
	}));
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getState() {
	return state;
}

function getCompatibilityShellState() {
	return getMachineSnapshot().context;
}

type SelectorCache<T> = {
	version: MusicState;
	value: T;
};

function createStableSnapshotSelector<T>(selector: (state: MusicState) => T) {
	let cache: SelectorCache<T> | null = null;
	return () => {
		const snapshot = getState();
		if (cache && cache.version === snapshot) {
			return cache.value;
		}

		const value = selector(snapshot);
		cache = { version: snapshot, value };
		return value;
	};
}

function isCurrentRun(version: number) {
	return version === bootstrapRunId;
}

function bumpPlaybackEpoch(): number {
	const epoch = playback.bumpEpoch();
	patchState({ playbackEpoch: epoch });
	return epoch;
}

function nextPlaybackSessionId(): number {
	return playback.getEpoch() + 1;
}

function isPlaybackContextActive(epoch: number, expectedListName?: string) {
	return playback.isActive(epoch, getState(), expectedListName);
}

function settleReviewMutation(
	mutateSlot: (slot: DraftMissionState) => DraftMissionState,
	shouldMutate?: (prev: MusicState) => boolean,
) {
	setState((prev) => {
		if (!prev.slot || (shouldMutate && !shouldMutate(prev))) {
			return prev;
		}

		return {
			...prev,
			slot: mutateSlot(prev.slot),
		};
	});
}

function patchSlot(mutator: (slot: DraftMissionState) => DraftMissionState) {
	setState((prev) => {
		if (!prev.slot) return prev;
		return {
			...prev,
			slot: mutator(prev.slot),
		};
	});
}

function currentList(input = state): Playlist | null {
	if (!input.playbackListName) return null;
	return (
		input.playlists.find(
			(playlist) => playlist.name === input.playbackListName,
		) ?? null
	);
}

function playbackOwnedCurrentList(input = state): Playlist | null {
	return derivePlaybackOwnedList(input);
}

function resolvePersistedPlaylistForMusic(
	input: Pick<
		MusicState,
		| "playlists"
		| "selectedListName"
		| "playbackListName"
		| "confirmedPlaying"
		| "nowPlaying"
	>,
	music: Music,
): Playlist | null {
	const matchesMusic = (playlist: Playlist) =>
		playlist.exclude.some((item) => item.path === music.path) ||
		playlist.entries.some((entry) =>
			entry.musics.some((item) => item.path === music.path),
		);

	const candidateNames = [
		input.playbackListName,
		input.confirmedPlaying?.path === music.path ? input.playbackListName : null,
		input.nowPlaying?.path === music.path ? input.playbackListName : null,
	]
		.filter((name): name is string => !!name)
		.filter((name, index, all) => all.indexOf(name) === index);

	for (const name of candidateNames) {
		const playlist = input.playlists.find((item) => item.name === name);
		if (playlist && matchesMusic(playlist)) return playlist;
	}

	return input.playlists.find(matchesMusic) ?? null;
}

function playableTracks(list: Playlist): Music[] {
	const excluded = new Set(list.exclude.map((item) => item.path));
	return list.entries
		.flatMap((entry) => entry.musics)
		.filter((music) => !excluded.has(music.path));
}

function updateMusicEverywhere(path: string, updater: (music: Music) => Music) {
	setState((prev) => {
		const playlists = prev.playlists.map((playlist) => ({
			...playlist,
			exclude: playlist.exclude.map((music) =>
				music.path === path ? updater(music) : music,
			),
			entries: playlist.entries.map((entry) => ({
				...entry,
				musics: entry.musics.map((music) =>
					music.path === path ? updater(music) : music,
				),
			})),
		}));

		const nowPlaying =
			prev.nowPlaying?.path === path
				? updater(prev.nowPlaying)
				: prev.nowPlaying;
		const requestedPlaying =
			prev.requestedPlaying?.path === path
				? updater(prev.requestedPlaying)
				: prev.requestedPlaying;
		const confirmedPlaying =
			prev.confirmedPlaying?.path === path
				? updater(prev.confirmedPlaying)
				: prev.confirmedPlaying;

		return {
			...prev,
			playlists,
			requestedPlaying,
			confirmedPlaying,
			nowPlaying,
		};
	});
}

function patchCurrentPlaylistByName(
	playlistName: string,
	mutator: (playlist: Playlist) => Playlist,
) {
	setState((prev) => ({
		...prev,
		playlists: prev.playlists.map((playlist) =>
			playlist.name === playlistName ? mutator(playlist) : playlist,
		),
	}));
}

async function applyNextFatigue(music: Music | null | undefined) {
	if (!music) return;
	const result = await crab.fatigue(music);
	if (result.isErr()) return;
	updateMusicEverywhere(music.path, (item) => ({
		...item,
		fatigue: item.fatigue + 0.1,
	}));
}

async function refreshLists(version?: number) {
	const result = await crab.readAll();
	if (result.isErr()) {
		throw new Error(result.unwrap_err());
	}

	const previousPlaylists = getState().playlists;
	const ownerSessionId = getState().entrySessionId;
	const playlists = carryForwardPersistedMaterializationOwnership(
		result.unwrap(),
		previousPlaylists,
		ownerSessionId,
	);
	if (version != null && !isCurrentRun(version)) {
		return;
	}
	const validNames = new Set(playlists.map((playlist) => playlist.name));
	for (const name of recentByList.keys()) {
		if (!validNames.has(name)) {
			recentByList.delete(name);
		}
	}

	setState((prev) => ({
		...(() => {
			const next = {
				...prev,
				...deriveRefreshPatch(prev, playlists),
			};
			const sanitized = {
				...next,
				processMsg: sanitizeProcessMsgHint(previousPlaylists, {
					playlists: next.playlists,
					processMsg: next.processMsg,
				}),
			};
			return sanitized;
		})(),
	}));
}

async function probePlaylistNames(version?: number) {
	const result = await crab.playlistNames();
	if (result.isErr()) {
		throw new Error(result.unwrap_err());
	}

	if (version != null && !isCurrentRun(version)) {
		return;
	}

	sendBootstrapProbeCompleted(version ?? bootstrapRunId, result.unwrap());

	setState((prev) => ({
		...(() => {
			const next = {
				...prev,
				...deriveProbePatch(prev, result.unwrap()),
			};
			return next;
		})(),
	}));
}

async function refreshTools(version?: number) {
	const [ytdlp, ffmpeg, savePath] = await Promise.all([
		crab.checkExists(),
		crab.ffmpegCheckExists(),
		crab.resolveSavePath(),
	]);
	if (version != null && !isCurrentRun(version)) {
		return;
	}

	patchState({
		ytdlp: ytdlp.isErr() ? null : (ytdlp.unwrap() ?? null),
		ffmpeg: ffmpeg.isErr() ? null : (ffmpeg.unwrap() ?? null),
		savePath: savePath.isErr() ? null : savePath.unwrap(),
	});
}

function chooseAndPlayNextTask(epoch: number): Effect.Effect<void> {
	return Effect.gen(function* () {
		const snapshot = getState();
		const list = currentList(snapshot);
		if (!list) return;
		if (!isPlaybackContextActive(epoch, list.name)) return;

		const all = playableTracks(list);
		if (all.length === 0) {
			yield* Effect.sync(() =>
				patchState({
					requestedPlaying: null,
					confirmedPlaying: null,
					nowPlaying: null,
					nowJudge: null,
				}),
			);
			return;
		}

		const pool = snapshot.nowPlaying
			? all.filter((music) => !sameTrack(music, snapshot.nowPlaying))
			: all;
		const base = pool.length > 0 ? pool : all;
		const recent = recentByList.get(list.name) ?? [];
		const filtered = avoidRecentlyPlayed(
			base,
			recent,
			recentWindowSize(all.length),
		);
		const candidates = filtered.length > 0 ? filtered : base;
		const chosen = sampleSoftMin(candidates, 0.8);
		if (!chosen) return;
		if (!isPlaybackContextActive(epoch, list.name)) return;
		const previousNowPlaying = snapshot.nowPlaying;

		yield* Effect.sync(() => {
			if (!isPlaybackContextActive(epoch, list.name)) return;
			const sessionId = nextPlaybackSessionId();
			patchState({
				selectedListName: list.name,
				playbackListName: list.name,
				playbackRequestedListName: list.name,
				requestedPlaying: chosen,
				confirmedPlaying: null,
				nowPlaying: snapshot.confirmedPlaying,
				nowJudge: null,
				playbackSessionId: sessionId,
			});
		});

		const requestedSessionId = nextPlaybackSessionId();

		const playResult = yield* Effect.promise(() =>
			crab.audioPlay({
				session_id: toPlaybackContractSessionId(requestedSessionId),
				path: chosen.path,
			}),
		);

		if (!isPlaybackContextActive(epoch, list.name)) return;

		if (playResult.isErr()) {
			yield* Effect.sync(() => {
				if (!isPlaybackContextActive(epoch, list.name)) return;
				const clearPatch = clearPlaybackSession(getState(), requestedSessionId);
				patchState({
					...(clearPatch ?? {
						selectedListName: null,
						playbackListName: null,
						playbackRequestedListName: null,
						requestedPlaying: null,
						confirmedPlaying: null,
						nowPlaying: null,
						nowJudge: null,
						playbackSessionId: null,
					}),
					requestedPlaying: previousNowPlaying,
					confirmedPlaying: previousNowPlaying,
					nowPlaying: previousNowPlaying,
				});
				sileo.error({
					title: "Play failed",
					description: playResult.unwrap_err(),
				});
			});
			return;
		}

		yield* Effect.sync(() => {
			if (!isPlaybackContextActive(epoch, list.name)) return;
			const sessionId = playResult.unwrap().session_id;
			const ackPatch = settlePlaybackAck(getState(), {
				sessionId,
				listName: list.name,
				ack: playResult.unwrap(),
			});
			if (!ackPatch) return;
			patchState({
				...ackPatch,
				nowJudge: null,
			});
			recentByList.set(
				list.name,
				pushRecentPath(recent, chosen.path, recentWindowSize(all.length)),
			);
		});
	});
}

function scheduleNextPlayback(epoch: number) {
	playback.replaceWith(chooseAndPlayNextTask(epoch), epoch);
}

async function ensureEvents() {
	if (started) return;
	started = true;
	try {
		const audioEnded = await crab.evt("audioEnded")((payload) => {
			const path =
				payload &&
				typeof payload === "object" &&
				"path" in payload &&
				typeof (payload as { path?: unknown }).path === "string"
					? (payload as { path: string }).path
					: null;
			const sessionId =
				payload &&
				typeof payload === "object" &&
				"session_id" in payload &&
				typeof (payload as { session_id?: unknown }).session_id === "number"
					? (payload as { session_id: number }).session_id
					: null;
			if (!path) return;
			const snapshot = getState();
			if (!shouldHandleAudioEnded(snapshot, { path, sessionId })) return;
			void applyNextFatigue(snapshot.nowPlaying);
			const patch = clearEndedPlaybackForFallback(snapshot);
			const nextSnapshot = normalizeMusicState({ ...snapshot, ...patch });
			sendPlaybackTransportFact(nextSnapshot, sessionId, "ended");
			setState(nextSnapshot);
			const epoch = snapshot.playbackEpoch;
			scheduleNextPlayback(epoch);
		});
		unsubs.push(audioEnded);

		const audioStopped = await crab.evt("audioStopped")((payload) => {
			const sessionId =
				payload &&
				typeof payload === "object" &&
				"session_id" in payload &&
				typeof (payload as { session_id?: unknown }).session_id === "number"
					? (payload as { session_id: number }).session_id
					: null;
			const patch = clearPlaybackTransportFact(
				getState(),
				sessionId,
				"stopped",
			);
			if (!patch) return;
			const snapshot = getState();
			const nextSnapshot = normalizeMusicState({ ...snapshot, ...patch });
			sendPlaybackTransportFact(nextSnapshot, sessionId, "stopped");
			setState(nextSnapshot);
		});
		unsubs.push(audioStopped);

		const handleTransportFact = (
			payload: unknown,
			fact: "paused" | "resumed" | "failed",
		) => {
			const path =
				payload &&
				typeof payload === "object" &&
				"path" in payload &&
				typeof (payload as { path?: unknown }).path === "string"
					? (payload as { path: string }).path
					: null;
			const sessionId =
				payload &&
				typeof payload === "object" &&
				"session_id" in payload &&
				typeof (payload as { session_id?: unknown }).session_id === "number"
					? (payload as { session_id: number }).session_id
					: null;
			if (!path) return;
			const snapshot = getState();
			const patch = clearPlaybackTransportFact(snapshot, sessionId, fact);
			if (!patch) return;
			const nextSnapshot = normalizeMusicState({ ...snapshot, ...patch });
			sendPlaybackTransportFact(nextSnapshot, sessionId, fact);
			setState(nextSnapshot);
		};

		const audioPaused = await crab.evt("audioPaused")((payload) => {
			handleTransportFact(payload, "paused");
		});
		unsubs.push(audioPaused);

		const audioResumed = await crab.evt("audioResumed")((payload) => {
			handleTransportFact(payload, "resumed");
		});
		unsubs.push(audioResumed);

		const audioFailed = await crab.evt("audioFailed")((payload) => {
			handleTransportFact(payload, "failed");
		});
		unsubs.push(audioFailed);

		const processMsg = await crab.evt("processMsg")((payload) => {
			patchHintOnlyProcessMsg(payload);
		});
		unsubs.push(processMsg);

		const processResult = await crab.evt("processResult")(() => {
			patchState({ processMsg: null });
		});
		unsubs.push(processResult);

		const ytdlpChanged = await crab.evt("ytdlpVersionChanged")(async () => {
			await refreshTools();
		});
		unsubs.push(ytdlpChanged);
	} catch (error) {
		for (const unsub of unsubs.splice(0)) {
			unsub();
		}
		started = false;
		throw error;
	}
}

async function safeStop() {
	const snapshot = getState();
	const hadPlayback = hasPlaybackContext(snapshot);
	bumpPlaybackEpoch();
	await playback.interruptCurrent();
	const stopped = await crab.audioStop();
	if (hadPlayback && stopped.isErr()) {
		sileo.error({
			title: "Stop failed",
			description: stopped.unwrap_err(),
		});
	}
}

async function startPlayByList(name: string) {
	const snapshot = getState();

	const list =
		snapshot.playlists.find((playlist) => playlist.name === name) ?? null;
	const liveEntry =
		list?.entries.find((entry) => !!derivePersistedOwnerIdentity(entry)) ??
		null;
	const nextSessionId = nextPlaybackSessionId();
	if (
		liveEntry &&
		snapshot.playbackSessionId != null &&
		!canSettleClosureEvent(
			snapshot,
			createClosureEventContract(
				snapshot.closureOwnerSessionId,
				derivePersistedOwnerIdentity(liveEntry) as string,
				"playback",
			),
			{ entry: liveEntry, allowedPlaybackSessionId: nextSessionId },
		)
	) {
		return;
	}

	patchState({
		selectedListName: name,
		playbackListName: name,
		mode: "play",
		requestedPlaying: null,
		confirmedPlaying: null,
		nowPlaying: null,
		nowJudge: null,
		playbackSessionId: nextSessionId,
		playbackRequestedListName: name,
	});
	const epoch = bumpPlaybackEpoch();
	scheduleNextPlayback(epoch);
}

async function persistSlot() {
	const snapshot = getState();
	const affordance = deriveSaveAffordance(snapshot);
	if (!affordance.allowed && affordance.reason === "review_in_progress") {
		sileo.error({
			title: "Please wait",
			description: "Background checks are still running.",
		});
		return;
	}

	if (!affordance.allowed) {
		if (affordance.reason === "missing_ffmpeg") {
			sileo.error({
				title: "Cannot save",
				description: "ffmpeg is required to support audio analysis.",
			});
			return;
		}

		if (affordance.reason === "duplicate_name") {
			sileo.error({
				title: "Cannot save",
				description: "This list already exists.",
			});
			return;
		}

		if (affordance.reason === "missing_save_path") {
			sileo.error({
				title: "Cannot save",
				description:
					"Choose where downloaded web music should be saved before saving.",
			});
			return;
		}
	}

	const check = canPersistMission(snapshot.slot);
	if (!check.ok) {
		sileo.error({
			title: "Cannot save",
			description: check.reason,
		});
		return;
	}

	const slot = snapshot.slot;
	if (!slot) return;

	if (snapshot.mode === "edit") {
		const anchorListName =
			snapshot.editingListName ?? snapshot.selectedListName;
		const anchor = snapshot.playlists.find(
			(playlist) => playlist.name === anchorListName,
		);
		if (!anchor) {
			throw new Error("selected playlist missing");
		}

		const optimisticPlaylists = applyOptimisticEditSave(
			snapshot.playlists,
			anchor,
			slot,
		);
		const idleEpoch = bumpPlaybackEpoch();
		void playback.interruptCurrent();
		patchState({
			...buildPostSavePatch(optimisticPlaylists.length > 0, idleEpoch),
			playlists: optimisticPlaylists,
			loading: false,
			requestedPlaying: null,
			closureOwnerSessionId:
				deriveClosureOwnerIdentityFromMission(slot) == null
					? snapshot.closureOwnerSessionId
					: idleEpoch,
			playbackSessionId: null,
			playbackRequestedListName: null,
			confirmedPlaying: null,
		});

		void (async () => {
			const result = await crab.update(slot, anchor);
			if (result.isErr()) {
				sileo.error({
					title: "Save failed",
					description: result.unwrap_err(),
				});
				await refreshLists();
				return;
			}
			await refreshLists();
		})();
		return;
	}

	patchState({ loading: true });
	const optimisticPlaylist = buildOptimisticPlaylistFromSlot(slot);
	const optimisticPlaylists = [...snapshot.playlists, optimisticPlaylist];
	const idleEpoch = bumpPlaybackEpoch();
	void playback.interruptCurrent();
	const closureEntryIdentity = deriveClosureOwnerIdentityFromMission(slot);
	patchState({
		...buildPostSavePatch(optimisticPlaylists.length > 0, idleEpoch),
		playlists: optimisticPlaylists,
		loading: false,
		requestedPlaying: null,
		closureOwnerSessionId:
			closureEntryIdentity != null ? idleEpoch : snapshot.closureOwnerSessionId,
		playbackSessionId: null,
		playbackRequestedListName: null,
		confirmedPlaying: null,
	});

	void (async () => {
		const result = await crab.create(slot);
		if (result.isErr()) {
			sileo.error({
				title: "Save failed",
				description: result.unwrap_err(),
			});
			await refreshLists();
			return;
		}

		await refreshLists();
	})();
}

export const action = {
	async run() {
		const version = ++bootstrapRunId;
		bootstrapStartupFailure = null;
		playback.markActive();
		sendBootstrapRunStarted(version);
		patchState({ loading: true });
		try {
			await ensureEvents();
			const ready = crab.appReady();
			const tools = refreshTools(version);
			await probePlaylistNames(version);
			await ready;
			await refreshLists(version);
			await tools;
			if (!isCurrentRun(version)) {
				return;
			}
			patchState({ processMsg: null });
		} catch (error) {
			if (!isCurrentRun(version)) {
				return;
			}
			sileo.error({
				title: "Initialization failed",
				description: error instanceof Error ? error.message : String(error),
			});
			bootstrapStartupFailure =
				error instanceof Error ? error.message : String(error);
			sendBootstrapRunFailed(version, bootstrapStartupFailure);
			patchState({ routeResolved: true, startupRoute: "startup_failed" });
		} finally {
			if (isCurrentRun(version)) {
				sendBootstrapRunFinished(version);
				patchState({ loading: false });
			}
		}
	},
	async next() {
		const snapshot = getState();
		if (snapshot.mode !== "play" || !snapshot.playbackListName) return;
		await applyNextFatigue(snapshot.nowPlaying);
		const epoch = bumpPlaybackEpoch();
		scheduleNextPlayback(epoch);
	},
	async resetLogits() {
		const result = await crab.resetLogits();
		if (result.isErr()) {
			sileo.error({
				title: "Reset failed",
				description: result.unwrap_err(),
			});
			return;
		}

		await refreshLists();
	},
	async play(playlist: Playlist) {
		await startPlayByList(playlist.name);
	},
	async delete(playlist: Playlist) {
		const result = await crab.delete(playlist.name);
		if (result.isErr()) {
			sileo.error({
				title: "Delete failed",
				description: result.unwrap_err(),
			});
			return;
		}

		if (getState().playbackListName === playlist.name) {
			await safeStop();
		}
		await refreshLists();
	},
	async addNew() {
		await safeStop();
		sendBootstrapWorkspaceEntered(
			"create",
			getState().entrySessionId,
			getState().closureOwnerSessionId,
		);
		patchState(
			deriveWorkspaceEntryPatch(
				"create",
				getState().entrySessionId,
				getState().closureOwnerSessionId,
			),
		);
	},
	async edit(playlist: Playlist) {
		await safeStop();
		sendBootstrapWorkspaceEntered(
			"edit",
			getState().entrySessionId,
			getState().closureOwnerSessionId,
			playlist,
		);
		patchState(
			deriveWorkspaceEntryPatch(
				"edit",
				getState().entrySessionId,
				getState().closureOwnerSessionId,
				playlist,
			),
		);
	},
	async back() {
		const snapshot = getState();
		if (!canExitWorkspace(snapshot)) {
			return;
		}

		await safeStop();
		const next = {
			...snapshot,
			...deriveBackTransition(snapshot),
		};
		sendBootstrapWorkspaceExited(next);
		patchState(deriveBackTransition(snapshot));
	},
	setSlot(slot: CollectMission) {
		patchState({
			slot: {
				...slot,
				links: slot.links.map((link) => ({ ...link, operation: null })),
			},
		});
	},
	async save() {
		const before = getState();
		await persistSlot();
		const after = getState();
		if (
			before.mode !== after.mode ||
			before.routeResolved !== after.routeResolved
		) {
			sendBootstrapSaveSettled(after);
		}
	},
	async addFolder(path: string) {
		const snapshot = getState();
		if (!snapshot.slot) return;
		if (!path || snapshot.slot.folders.some((folder) => folder.path === path)) {
			return;
		}

		const result = await crab.collectImportFolderEntries(path);
		if (result.isErr()) {
			sileo.error({
				title: "Folder scan failed",
				description: result.unwrap_err(),
			});
			return;
		}

		const items = result.unwrap();
		if (items.length === 0) {
			return;
		}

		patchSlot((slot) => {
			const folders = [...slot.folders];
			const entries = [...slot.entries];

			for (const item of items) {
				if (item.url) {
					const entry = mapImportFolderEntryToEntry(item);
					const key = entryKey(entry);
					if (!entries.some((candidate) => entryKey(candidate) === key)) {
						entries.push(entry);
					}
					continue;
				}

				if (!folders.some((folder) => folder.path === item.path)) {
					folders.push({ path: item.path, items: item.items });
				}
			}

			return {
				...slot,
				folders,
				entries,
			};
		});
	},
	removeFolder(path: string) {
		patchSlot((slot) => ({
			...slot,
			folders: slot.folders.filter((folder) => folder.path !== path),
		}));
	},
	async addLink(url: string) {
		const snapshot = getState();
		if (!snapshot.slot) return;

		const value = url.trim();
		if (!isValidUrl(value)) {
			sileo.error({ title: "Invalid URL" });
			return;
		}

		if (snapshot.slot.links.some((link) => link.url === value)) {
			return;
		}

		const pendingLink: LinkSample = {
			url: value,
			title_or_msg: "Detecting...",
			entry_type: "Unknown",
			count: null,
			status: null,
			tracking: false,
		};

		setState((prev) => {
			if (!prev.slot) return prev;
			const operation = createDraftOperation(
				"link_review",
				value,
				prev.entrySessionId,
			);
			return {
				...prev,
				slot: {
					...prev.slot,
					links: [...prev.slot.links, { ...pendingLink, operation }],
				},
			};
		});

		const media = await crab.lookMedia(value);
		settleReviewMutation((slot) => {
			const links = slot.links.map((link) => {
				if (link.url !== value) return link;
				const operation = link.operation
					? settleDraftOperation(
							link.operation,
							media.isErr() ? "failed" : "succeeded",
						)
					: null;
				if (media.isErr()) {
					return {
						...setDraftLinkOperation(link, operation),
						title_or_msg: media.unwrap_err(),
						status: "Err" as const,
					};
				}

				const info = media.unwrap();
				return {
					...setDraftLinkOperation(link, operation),
					title_or_msg: info.title,
					entry_type: inferEntryType(info.item_type),
					count: info.entries_count,
					status: "Ok" as const,
				};
			});

			return {
				...slot,
				links,
			};
		});
	},
	removeLink(url: string) {
		setState((prev) => {
			if (!prev.slot) return prev;
			return {
				...prev,
				slot: {
					...prev.slot,
					links: prev.slot.links.filter((link) => link.url !== url),
				},
			};
		});
	},
	toggleLinkTracking(url: string) {
		patchSlot((slot) => ({
			...slot,
			links: slot.links.map((link) =>
				link.url === url ? { ...link, tracking: !link.tracking } : link,
			),
		}));
	},
	addExistingEntry(entry: Entry) {
		patchSlot((slot) => {
			const key = entryKey(entry);
			const exists = slot.entries.some((item) => entryKey(item) === key);
			if (exists) return slot;
			return {
				...slot,
				entries: [entry, ...slot.entries],
			};
		});
	},
	removeEntry(entry: Entry) {
		const key = entryKey(entry);
		patchSlot((slot) => ({
			...slot,
			entries: slot.entries.filter((item) => entryKey(item) !== key),
		}));
	},
	removeExclude(path: string) {
		patchSlot((slot) => ({
			...slot,
			exclude: slot.exclude.filter((item) => item.path !== path),
		}));
	},
	async reloadEntry(entry: Entry) {
		if (!entry.path) return;

		const key = entry.path;
		const { entrySessionId } = getState();
		const entryIdentity = deriveEntryIdentity(entry);
		const workspaceMode = getState().mode;
		patchSlot((slot) => ({
			...slot,
			entries: slot.entries.map((item) =>
				deriveEntryIdentity(item) === entryIdentity
					? setDraftEntryOperation(
							item,
							createDraftOperation("folder_reload", key, entrySessionId),
						)
					: item,
			),
		}));

		const result = await crab.recheckFolder(entry);
		if (result.isErr()) {
			settleReviewMutation((slot) => ({
				...slot,
				entries: slot.entries.map((item) =>
					deriveEntryIdentity(item) === entryIdentity &&
					getDraftEntryOperation(item)
						? setDraftEntryOperation(
								item,
								settleDraftOperation(
									getDraftEntryOperation(item) as DraftEntryOperationState,
									"failed",
								),
							)
						: item,
				),
			}));
			sileo.error({
				title: "Reload failed",
				description: result.unwrap_err(),
			});
			return;
		}

		const next = result.unwrap();
		settleReviewMutation(
			(slot) => ({
				...slot,
				entries:
					entryIdentity == null
						? slot.entries
						: replaceEntryByIdentity(
								slot.entries,
								entryIdentity,
								syncEntryOwnedMaterialization(
									setDraftEntryOperation(
										next,
										settleDraftOperation(
											createDraftOperation(
												"folder_reload",
												key,
												entrySessionId,
											),
											"succeeded",
										),
									),
									entrySessionId,
								),
							),
			}),
			(current) =>
				canMutateSettledEntry(
					current,
					workspaceMode,
					entrySessionId,
					entryIdentity,
				),
		);
	},
	async updateWeblist(entry: Entry) {
		const snapshot = getState();
		const playlist = snapshot.editingListName ?? snapshot.selectedListName;
		if (!playlist || !entry.url) return;

		const key = entry.url;
		const entryIdentity = deriveEntryIdentity(entry);
		const workspaceMode = snapshot.mode;
		const persistedMaterialization = getEntryMaterialization(entry);
		patchSlot((slot) => ({
			...slot,
			entries: slot.entries.map((item) =>
				deriveEntryIdentity(item) === entryIdentity
					? setDraftEntryOperation(
							item,
							createDraftOperation(
								"weblist_update",
								key,
								snapshot.entrySessionId,
							),
						)
					: item,
			),
		}));

		const result = await crab.updateWeblist(entry, playlist);
		if (result.isErr()) {
			if (
				entryIdentity != null &&
				persistedMaterialization &&
				!isEditingWorkspace(getState().mode)
			) {
				setState((prev) => ({
					...prev,
					playlists: setPlaylistEntryMaterializationByIdentity(
						prev.playlists,
						playlist,
						entryIdentity,
						persistedMaterialization.ownerSessionId,
						persistedMaterialization,
					),
				}));
			}
			settleReviewMutation((slot) => ({
				...slot,
				entries: slot.entries.map((item) =>
					deriveEntryIdentity(item) === entryIdentity &&
					getDraftEntryOperation(item)
						? setDraftEntryOperation(
								item,
								settleDraftOperation(
									getDraftEntryOperation(item) as DraftEntryOperationState,
									"failed",
								),
							)
						: item,
				),
			}));
			sileo.error({
				title: "Update failed",
				description: result.unwrap_err(),
			});
			return;
		}

		const next = result.unwrap();
		if (
			entryIdentity != null &&
			persistedMaterialization &&
			!isEditingWorkspace(getState().mode)
		) {
			const settledMaterialization = getEntryMaterialization(
				syncEntryOwnedMaterialization(
					next,
					persistedMaterialization.ownerSessionId,
				),
			);
			setState((prev) => ({
				...prev,
				playlists: setPlaylistEntryMaterializationByIdentity(
					prev.playlists,
					playlist,
					entryIdentity,
					persistedMaterialization.ownerSessionId,
					settledMaterialization,
				),
			}));
		}
		settleReviewMutation(
			(slot) => ({
				...slot,
				entries:
					entryIdentity == null
						? slot.entries
						: replaceEntryByIdentity(
								slot.entries,
								entryIdentity,
								syncEntryOwnedMaterialization(
									setDraftEntryOperation(
										next,
										settleDraftOperation(
											createDraftOperation(
												"weblist_update",
												key,
												snapshot.entrySessionId,
											),
											"succeeded",
										),
									),
									snapshot.entrySessionId,
								),
							),
			}),
			(current) =>
				canMutateSettledEntry(
					current,
					workspaceMode,
					snapshot.entrySessionId,
					entryIdentity,
				),
		);
	},
	async up(music: Music) {
		const result = await crab.boost(music);
		if (result.isErr()) return;

		updateMusicEverywhere(music.path, (item) => ({
			...item,
			user_boost: Math.min(0.9, Math.round((item.user_boost + 0.1) * 10) / 10),
		}));
		patchState({ nowJudge: "Up" });
	},
	async down(music: Music) {
		const result = await crab.fatigue(music);
		if (result.isErr()) return;

		updateMusicEverywhere(music.path, (item) => ({
			...item,
			fatigue: item.fatigue + 0.1,
			user_boost: Math.max(0, Math.round((item.user_boost - 0.1) * 10) / 10),
		}));
		patchState({ nowJudge: "Down" });
	},
	async cancleUp(music: Music) {
		const result = await crab.cancleBoost(music);
		if (result.isErr()) return;

		updateMusicEverywhere(music.path, (item) => ({
			...item,
			user_boost: Math.max(0, Math.round((item.user_boost - 0.1) * 10) / 10),
		}));
		patchState({ nowJudge: null });
	},
	async cancleDown(music: Music) {
		const result = await crab.cancleFatigue(music);
		if (result.isErr()) return;

		updateMusicEverywhere(music.path, (item) => ({
			...item,
			fatigue: Math.max(0, item.fatigue - 0.1),
		}));
		patchState({ nowJudge: null });
	},
	async unstar(music: Music) {
		const snapshot = getState();
		const list = resolvePersistedPlaylistForMusic(snapshot, music);
		if (!list) return;

		const shouldSwitch = shouldAdvanceOnUnstar(snapshot, list.name, music.path);
		const epoch = bumpPlaybackEpoch();
		const canonicalExcludedMusic =
			list.exclude.find((item) => item.path === music.path) ?? music;

		setState((prev) => ({
			...prev,
			playlists: prev.playlists.map((playlist) =>
				playlist.name === list.name
					? {
							...playlist,
							exclude: playlist.exclude.some((item) => item.path === music.path)
								? playlist.exclude
								: [...playlist.exclude, canonicalExcludedMusic],
						}
					: playlist,
			),
			requestedPlaying:
				prev.requestedPlaying && prev.requestedPlaying.path === music.path
					? null
					: prev.requestedPlaying,
			nowPlaying:
				prev.nowPlaying && prev.nowPlaying.path === music.path
					? null
					: prev.nowPlaying,
			confirmedPlaying:
				prev.confirmedPlaying && prev.confirmedPlaying.path === music.path
					? null
					: prev.confirmedPlaying,
			nowJudge: null,
			playbackEpoch: epoch,
			playbackSessionId: null,
			playbackRequestedListName: null,
		}));

		await playback.interruptCurrent();
		const stopped = await crab.audioStop();
		if (stopped.isErr()) {
			sileo.error({
				title: "Stop failed",
				description: stopped.unwrap_err(),
			});
		}

		const result = await crab.unstar(list, music);
		if (result.isErr()) {
			sileo.error({
				title: "Unstar failed",
				description: result.unwrap_err(),
			});
			await refreshLists();
			return;
		}

		patchCurrentPlaylistByName(list.name, (playlist) => ({
			...playlist,
			exclude: playlist.exclude.map((item) =>
				item.path === music.path ? canonicalExcludedMusic : item,
			),
		}));

		if (shouldSwitch && isPlaybackContextActive(epoch, list.name)) {
			scheduleNextPlayback(epoch);
		}
	},
	async installYtdlp() {
		const result = await crab.ytdlpDownloadAndInstall();
		if (result.isErr()) {
			sileo.error({
				title: "Install yt-dlp failed",
				description: result.unwrap_err(),
			});
			return;
		}

		patchState({ ytdlp: result.unwrap() });
	},
	async installFfmpeg() {
		const result = await crab.ffmpegDownloadAndInstall();
		if (result.isErr()) {
			sileo.error({
				title: "Install ffmpeg failed",
				description: result.unwrap_err(),
			});
			return;
		}

		patchState({ ffmpeg: result.unwrap() });
	},
	async updateSavePath(path: string) {
		const result = await crab.updateSavePath(path);
		if (result.isErr()) {
			sileo.error({
				title: "Save path update failed",
				description: result.unwrap_err(),
			});
			return;
		}

		patchState({ savePath: path });
	},
	async dispose() {
		bootstrapRunId += 1;
		bootstrapStartupFailure = null;
		playback.markDisposed();
		patchState({ playbackEpoch: playback.getEpoch() });
		await playback.interruptCurrent();
		for (const unsub of unsubs.splice(0)) {
			unsub();
		}
		started = false;
	},
};

function useMusicSelector<T>(selector: (state: MusicState) => T): T {
	const getSnapshot = useMemo(
		() => createStableSnapshotSelector(selector),
		[selector],
	);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const MODE = {
	play: me<UiMode>("play"),
	create: me<UiMode>("create"),
	edit: me<UiMode>("edit"),
	new_guide: me<UiMode>("new_guide"),
} as const;

export const __testing = {
	getState,
	getCompatibilityShellState,
	getMachineSnapshot,
	replaceCompatibilityBoundary(boundary: MusicActorBoundary, next: MusicState) {
		replaceBoundaryState(boundary, next);
	},
	getMachineActors() {
		return Object.fromEntries(
			Object.entries(machineActors).map(([boundary, actor]) => [
				boundary,
				actor.getSnapshot(),
			]),
		) as Record<MusicActorBoundary, MusicMachineSnapshot>;
	},
	readAll() {
		return refreshLists();
	},
	replaceState(next: MusicState) {
		state = normalizeMusicState(next);
		machineActors.bootstrap_workspace.send(
			musicBoundaryEventDefs["boundary.bootstrap_workspace.run_started"].load({
				runId: bootstrapRunId,
			}),
		);
		replaceBoundaryState("bootstrap_workspace", state);
		syncCompatibilityShell(state);
	},
	reset() {
		listeners.clear();
		recentByList.clear();
		for (const unsub of unsubs.splice(0)) {
			unsub();
		}
		state = normalizeMusicState({ ...initialState });
		bootstrapRunId = 0;
		bootstrapStartupFailure = null;
		replaceBoundaryState("bootstrap_workspace", state);
		syncCompatibilityShell(state);
		started = false;
	},
};

export const hook = {
	useState: () =>
		useMusicSelector((snapshot) =>
			snapshot.mode === "play"
				? MODE.play
				: snapshot.mode === "create"
					? MODE.create
					: snapshot.mode === "edit"
						? MODE.edit
						: MODE.new_guide,
		),
	useContext: () => useMusicSelector((snapshot) => snapshot),
	useList: () => useMusicSelector((snapshot) => snapshot.playlists),
	useCurPlay: () => useMusicSelector((snapshot) => snapshot.nowPlaying),
	useRequestedPlay: () =>
		useMusicSelector((snapshot) => snapshot.requestedPlaying),
	useConfirmedPlay: () =>
		useMusicSelector((snapshot) => snapshot.confirmedPlaying),
	useCurList: () =>
		useMusicSelector((snapshot) => playbackOwnedCurrentList(snapshot)),
	useFocusedList: () =>
		useMusicSelector((snapshot) => {
			const listName = projectFocusedListName(snapshot);
			return listName
				? (snapshot.playlists.find((playlist) => playlist.name === listName) ??
						null)
				: null;
		}),
	useEditingList: () =>
		useMusicSelector((snapshot) => {
			const listName = projectEditingListName(snapshot);
			return listName
				? (snapshot.playlists.find((playlist) => playlist.name === listName) ??
						null)
				: null;
		}),
	useSelectedList: () =>
		useMusicSelector((snapshot) => {
			const listName =
				snapshot.mode === "edit"
					? (snapshot.editingListName ?? snapshot.selectedListName)
					: snapshot.selectedListName;
			return listName
				? (snapshot.playlists.find((playlist) => playlist.name === listName) ??
						null)
				: null;
		}),
	useSlot: () => useMusicSelector((snapshot) => snapshot.slot),
	useMsg: () => useMusicSelector((snapshot) => snapshot.processMsg),
	useProcessHint: () =>
		useMusicSelector<ProcessHintProjection | null>((snapshot) =>
			deriveProcessHintProjection(snapshot.processMsg),
		),
	useClosureProjection: () =>
		useMusicSelector((snapshot) => deriveClosureProjection(snapshot)),
	useJudge: () => useMusicSelector((snapshot) => snapshot.nowJudge),
	useIsPlaying: () =>
		useMusicSelector(
			(snapshot) => !!snapshot.playbackListName && !!snapshot.confirmedPlaying,
		),
	useIsReview: () =>
		useMusicSelector(
			(snapshot) => deriveDraftReviewState(snapshot).active.length > 0,
		),
	useAllReview: () =>
		useMusicSelector(
			(snapshot) => deriveDraftReviewState(snapshot).linkReviews,
		),
	useAllFolderReview: () =>
		useMusicSelector(
			(snapshot) => deriveDraftReviewState(snapshot).folderReviews,
		),
	useAllWeblistReview: () =>
		useMusicSelector(
			(snapshot) => deriveDraftReviewState(snapshot).weblistReviews,
		),
};
