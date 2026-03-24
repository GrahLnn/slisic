import type {
	AudioPlayAck,
	CollectMission,
	Entry,
	ImportFolderEntry,
	Playlist,
	ProcessMsg,
} from "@/src/cmd/commands";
import { canPersistMission } from "./logic";
import {
	cloneMissionWithoutDraftOperations,
	createClosureEventContract,
	deriveClosureOwnerIdentityFromMission,
	deriveEntryIdentity,
	derivePersistedOwnerIdentity,
	deriveProcessMsgIdentityHint,
	getDraftEntryOperation,
	getEntryMaterialization,
} from "./store.identity";
import type {
	ClosureEventContract,
	ClosureEventPhase,
	ClosureProjection,
	DraftEntryOperationState,
	DraftMissionState,
	MusicState,
	ProcessHintProjection,
	SaveAffordance,
	StartupRouteResolution,
	StartupRouteSnapshot,
	UiMode,
	WorkspaceScreen,
} from "./store.types";

type DraftReviewProjectionSnapshot = Pick<MusicState, "slot">;
type ClosureSnapshot = Pick<
	MusicState,
	"closureOwnerSessionId" | "entrySessionId" | "playbackSessionId"
>;
type ClosureSettleOptions = {
	entry: Entry | null | undefined;
	allowedPlaybackSessionId?: number | null;
};
type PlaybackSessionSnapshot = Pick<
	MusicState,
	| "playbackEpoch"
	| "playbackSessionId"
	| "selectedListName"
	| "focusedListName"
	| "playbackListName"
	| "playbackRequestedListName"
	| "requestedPlaying"
	| "confirmedPlaying"
	| "nowPlaying"
	| "nowJudge"
	| "playlists"
>;

export function projectFocusedListName(
	snapshot: Pick<MusicState, "focusedListName" | "selectedListName"> & {
		mode?: MusicState["mode"];
	},
): string | null {
	if (snapshot.focusedListName !== undefined)
		return snapshot.focusedListName ?? null;
	return snapshot.mode === "edit" ? null : snapshot.selectedListName;
}

export function projectEditingListName(
	snapshot: Pick<MusicState, "editingListName" | "selectedListName"> & {
		mode?: MusicState["mode"];
	},
): string | null {
	if (snapshot.editingListName !== undefined)
		return snapshot.editingListName ?? null;
	return snapshot.selectedListName;
}

export function deriveProcessHintProjection(
	processMsg: ProcessMsg | null,
): ProcessHintProjection | null {
	if (!processMsg) return null;

	const normalized = processMsg.str.trim();
	const assetIdentity = deriveProcessMsgIdentityHint(processMsg);
	const assetPath = assetIdentity?.startsWith("path:")
		? assetIdentity.slice("path:".length)
		: null;
	const lower = normalized.toLowerCase();
	const kind = lower.includes("failed")
		? "failure"
		: lower.includes("download")
			? "download"
			: lower.includes("analy")
				? "analysis"
				: "generic";

	return {
		playlistName: processMsg.playlist,
		text: normalized,
		kind,
		assetPath,
		raw: processMsg,
	};
}

export function derivePlaybackOwnedList(
	snapshot: Pick<
		MusicState,
		| "playlists"
		| "selectedListName"
		| "focusedListName"
		| "playbackListName"
		| "requestedPlaying"
		| "confirmedPlaying"
		| "nowPlaying"
	> & { mode?: MusicState["mode"] },
): Playlist | null {
	const focusedListName = projectFocusedListName(snapshot);
	if (snapshot.playbackListName) {
		const playbackOwnedList =
			snapshot.playlists.find(
				(playlist) => playlist.name === snapshot.playbackListName,
			) ?? null;
		if (playbackOwnedList) return playbackOwnedList;
	}
	const activeTrack =
		snapshot.confirmedPlaying ??
		snapshot.nowPlaying ??
		snapshot.requestedPlaying;
	if (!activeTrack) {
		return focusedListName
			? (snapshot.playlists.find(
					(playlist) => playlist.name === focusedListName,
				) ?? null)
			: null;
	}
	for (const playlist of snapshot.playlists) {
		const containsTrack =
			playlist.entries.some((entry) =>
				entry.musics.some((music) => music.path === activeTrack.path),
			) || playlist.exclude.some((music) => music.path === activeTrack.path);
		if (containsTrack) return playlist;
	}
	return focusedListName
		? (snapshot.playlists.find(
				(playlist) => playlist.name === focusedListName,
			) ?? null)
		: null;
}

export function deriveRouteResolution(
	snapshot: Pick<MusicState, "mode" | "routeResolved">,
	routeSnapshot?: StartupRouteSnapshot | null,
): StartupRouteResolution {
	if (routeSnapshot) {
		return {
			kind: routeSnapshot.kind,
			routeResolved: routeSnapshot.kind !== "startup_unresolved",
			mode: snapshot.mode,
			phase:
				routeSnapshot.kind === "startup_unresolved"
					? "unresolved"
					: routeSnapshot.kind === "startup_probed_empty" ||
							routeSnapshot.kind === "startup_probed_nonempty"
						? "probed"
						: "hydrated",
		};
	}
	if (!snapshot.routeResolved) {
		return {
			kind: "startup_unresolved",
			routeResolved: false,
			mode: snapshot.mode,
			phase: "unresolved",
		};
	}
	if (snapshot.mode === "create" || snapshot.mode === "edit") {
		return {
			kind: "hydrated_editing",
			routeResolved: true,
			mode: snapshot.mode,
			phase: "hydrated",
		};
	}
	if (snapshot.mode === "new_guide") {
		return {
			kind: "hydrated_empty",
			routeResolved: true,
			mode: snapshot.mode,
			phase: "hydrated",
		};
	}
	return {
		kind: "hydrated_playlists",
		routeResolved: true,
		mode: snapshot.mode,
		phase: "hydrated",
	};
}

export function projectWorkspaceScreen(
	snapshot: Pick<MusicState, "mode" | "routeResolved">,
): WorkspaceScreen {
	if (!snapshot.routeResolved) return "unresolved";
	if (snapshot.mode === "create") return "create";
	if (snapshot.mode === "edit") return "edit";
	return snapshot.mode === "new_guide" ? "guide" : "play";
}

function resolveHydratedRoute(
	prev: Pick<MusicState, "mode" | "routeResolved">,
	hasPlaylists: boolean,
): StartupRouteResolution {
	if (prev.mode === "create" || prev.mode === "edit") {
		return {
			kind: prev.routeResolved ? "hydrated_editing" : "startup_unresolved",
			routeResolved: prev.routeResolved,
			mode: prev.mode,
			phase: prev.routeResolved ? "hydrated" : "unresolved",
		};
	}
	return hasPlaylists
		? {
				kind: "hydrated_playlists",
				routeResolved: true,
				mode: "play",
				phase: "hydrated",
			}
		: {
				kind: "hydrated_empty",
				routeResolved: true,
				mode: "new_guide",
				phase: "hydrated",
			};
}

function resolveProbeRoute(
	prev: Pick<MusicState, "mode" | "routeResolved">,
	hasPlaylistNames: boolean,
): StartupRouteResolution {
	if (prev.mode === "create" || prev.mode === "edit") {
		return {
			kind: prev.routeResolved ? "hydrated_editing" : "startup_unresolved",
			routeResolved: prev.routeResolved,
			mode: prev.mode,
			phase: prev.routeResolved ? "hydrated" : "unresolved",
		};
	}
	return hasPlaylistNames
		? {
				kind: "startup_probed_nonempty",
				routeResolved: true,
				mode: "play",
				phase: "probed",
			}
		: {
				kind: "startup_probed_empty",
				routeResolved: true,
				mode: "new_guide",
				phase: "probed",
			};
}

export function shouldAdvanceOnUnstar(
	snapshot: Pick<MusicState, "mode" | "selectedListName" | "nowPlaying">,
	listName: string,
	musicPath: string,
): boolean {
	return (
		snapshot.mode === "play" &&
		snapshot.selectedListName === listName &&
		snapshot.nowPlaying?.path === musicPath
	);
}

export function hasPlaybackContext(
	snapshot: Pick<MusicState, "mode" | "selectedListName" | "nowPlaying">,
): boolean {
	return (
		snapshot.mode === "play" &&
		(!!snapshot.selectedListName || !!snapshot.nowPlaying)
	);
}

export function deriveDraftReviewState(
	snapshot: DraftReviewProjectionSnapshot,
): {
	active: DraftEntryOperationState[];
	linkReviews: string[];
	folderReviews: string[];
	weblistReviews: string[];
} {
	if (!snapshot.slot)
		return {
			active: [],
			linkReviews: [],
			folderReviews: [],
			weblistReviews: [],
		};
	const active: DraftEntryOperationState[] = [];
	const linkReviews: string[] = [];
	const folderReviews: string[] = [];
	const weblistReviews: string[] = [];
	for (const link of snapshot.slot.links) {
		if (link.operation?.inProgress) {
			active.push(link.operation);
			linkReviews.push(link.url);
		}
	}
	for (const entry of snapshot.slot.entries) {
		const operation = getDraftEntryOperation(entry);
		if (!operation?.inProgress) continue;
		active.push(operation);
		if (operation.kind === "folder_reload") folderReviews.push(operation.key);
		else if (operation.kind === "weblist_update")
			weblistReviews.push(operation.key);
	}
	return { active, linkReviews, folderReviews, weblistReviews };
}

export function deriveDraftOperationTargetSnapshots(
	snapshot: DraftReviewProjectionSnapshot,
): import("./store.types").DraftOperationTargetSnapshot[] {
	if (!snapshot.slot) return [];
	const targets: import("./store.types").DraftOperationTargetSnapshot[] = [];
	for (const link of snapshot.slot.links) {
		if (!link.operation) continue;
		targets.push({
			key: link.url,
			kind: link.operation.kind,
			ownerSessionId: link.operation.ownerSessionId,
			inProgress: link.operation.inProgress,
			settled: link.operation.settled,
		});
	}
	for (const entry of snapshot.slot.entries) {
		const operation = getDraftEntryOperation(entry);
		if (!operation) continue;
		targets.push({
			key: operation.key,
			kind: operation.kind,
			ownerSessionId: operation.ownerSessionId,
			inProgress: operation.inProgress,
			settled: operation.settled,
		});
	}
	return targets;
}

export function canExitWorkspace(
	snapshot: DraftReviewProjectionSnapshot,
): boolean {
	return deriveDraftReviewState(snapshot).active.length === 0;
}

export function deriveSaveAffordance(
	snapshot: Pick<
		MusicState,
		| "slot"
		| "ffmpeg"
		| "savePath"
		| "playlists"
		| "selectedListName"
		| "editingListName"
		| "mode"
	>,
): SaveAffordance {
	if (!snapshot.slot)
		return { allowed: false, visible: false, reason: "missing_slot" };
	if (!snapshot.ffmpeg)
		return { allowed: false, visible: false, reason: "missing_ffmpeg" };
	if (!snapshot.savePath)
		return { allowed: false, visible: false, reason: "missing_save_path" };
	const editingListName = projectEditingListName(snapshot);
	const normalizedName = snapshot.slot.name.trim().toLowerCase();
	const duplicate = snapshot.playlists
		.filter((playlist) => playlist.name !== editingListName)
		.some((playlist) => playlist.name.trim().toLowerCase() === normalizedName);
	if (duplicate)
		return { allowed: false, visible: false, reason: "duplicate_name" };
	const persistCheck = canPersistMission(snapshot.slot);
	if (!persistCheck.ok)
		return { allowed: false, visible: false, reason: "invalid_mission" };
	if (!canExitWorkspace(snapshot))
		return { allowed: false, visible: true, reason: "review_in_progress" };
	return { allowed: true, visible: true, reason: "review_in_progress" };
}

export function shouldHandleAudioEnded(
	snapshot: Pick<
		MusicState,
		| "mode"
		| "playbackSessionId"
		| "selectedListName"
		| "confirmedPlaying"
		| "nowPlaying"
	>,
	payload: { sessionId: number | null; path: string },
): boolean {
	return (
		snapshot.mode === "play" &&
		snapshot.playbackSessionId != null &&
		snapshot.playbackSessionId === payload.sessionId &&
		!!snapshot.selectedListName &&
		(snapshot.confirmedPlaying ?? snapshot.nowPlaying)?.path === payload.path
	);
}

export function settlePlaybackAck(
	snapshot: Pick<
		MusicState,
		| "mode"
		| "playbackSessionId"
		| "selectedListName"
		| "playbackListName"
		| "playbackRequestedListName"
		| "requestedPlaying"
		| "confirmedPlaying"
		| "nowPlaying"
		| "playlists"
	>,
	payload: {
		sessionId: number | null;
		listName: string | null;
		ack: AudioPlayAck;
	},
): Pick<
	MusicState,
	| "selectedListName"
	| "playbackListName"
	| "playbackRequestedListName"
	| "confirmedPlaying"
	| "nowPlaying"
> | null {
	if (snapshot.mode !== "play") return null;
	if (snapshot.playbackSessionId == null) return null;
	if (snapshot.playbackSessionId !== payload.sessionId) return null;
	const playbackOwnedList = derivePlaybackOwnedList(snapshot);
	if (!payload.listName || playbackOwnedList?.name !== payload.listName)
		return null;
	const playlist = playbackOwnedList;
	const confirmedTrack =
		playlist?.entries
			.flatMap((entry) => entry.musics)
			.find((music) => music.path === payload.ack.path) ??
		playlist?.exclude.find((music) => music.path === payload.ack.path) ??
		null;
	if (!confirmedTrack) return null;
	return {
		selectedListName: snapshot.selectedListName,
		playbackListName: payload.listName,
		playbackRequestedListName: payload.listName,
		confirmedPlaying: confirmedTrack,
		nowPlaying: confirmedTrack,
	};
}

export function clearPlaybackSession(
	snapshot: PlaybackSessionSnapshot,
	sessionId: number | null,
): Pick<
	MusicState,
	| "selectedListName"
	| "playbackListName"
	| "playbackRequestedListName"
	| "requestedPlaying"
	| "confirmedPlaying"
	| "nowPlaying"
	| "nowJudge"
	| "playbackEpoch"
	| "playbackSessionId"
> | null {
	if (snapshot.playbackSessionId == null) return null;
	if (snapshot.playbackSessionId !== sessionId) return null;
	if (!snapshot.confirmedPlaying) return null;
	return {
		selectedListName: null,
		playbackListName: null,
		playbackRequestedListName: null,
		requestedPlaying: null,
		confirmedPlaying: null,
		nowPlaying: null,
		nowJudge: null,
		playbackEpoch: snapshot.playbackEpoch,
		playbackSessionId: null,
	};
}

export function clearEndedPlaybackForFallback(
	snapshot: Pick<
		MusicState,
		| "selectedListName"
		| "playbackListName"
		| "playbackRequestedListName"
		| "requestedPlaying"
		| "confirmedPlaying"
		| "nowPlaying"
		| "nowJudge"
		| "playbackEpoch"
		| "playbackSessionId"
	>,
): Pick<
	MusicState,
	| "selectedListName"
	| "playbackListName"
	| "playbackRequestedListName"
	| "requestedPlaying"
	| "confirmedPlaying"
	| "nowPlaying"
	| "nowJudge"
	| "playbackEpoch"
	| "playbackSessionId"
> {
	return {
		selectedListName: snapshot.selectedListName,
		playbackListName: snapshot.playbackListName,
		playbackRequestedListName: null,
		requestedPlaying: null,
		confirmedPlaying: snapshot.confirmedPlaying,
		nowPlaying: null,
		nowJudge: null,
		playbackEpoch: snapshot.playbackEpoch,
		playbackSessionId: snapshot.playbackSessionId,
	};
}

export function clearPlaybackTransportFact(
	snapshot: PlaybackSessionSnapshot,
	sessionId: number | null,
	fact: "stopped" | "ended" | "failed" | "paused" | "resumed",
) {
	if (snapshot.playbackSessionId == null) return null;
	if (snapshot.playbackSessionId !== sessionId) return null;
	if (fact === "paused" || fact === "resumed") {
		if (!snapshot.confirmedPlaying) return null;
		return {
			selectedListName: snapshot.selectedListName,
			playbackListName: snapshot.playbackListName,
			requestedPlaying: snapshot.requestedPlaying,
			confirmedPlaying: snapshot.confirmedPlaying,
			nowPlaying: snapshot.nowPlaying,
			nowJudge: null,
			playbackEpoch: snapshot.playbackEpoch,
			playbackSessionId: snapshot.playbackSessionId,
		};
	}
	if (fact === "ended") return clearEndedPlaybackForFallback(snapshot);
	return clearPlaybackSession(snapshot, sessionId);
}

export function deriveRefreshPatch(
	prev: Pick<
		MusicState,
		| "mode"
		| "routeResolved"
		| "selectedListName"
		| "editingListName"
		| "playbackListName"
		| "nowPlaying"
	>,
	playlists: Playlist[],
): Pick<
	MusicState,
	| "playlists"
	| "selectedListName"
	| "editingListName"
	| "playbackListName"
	| "nowPlaying"
	| "mode"
	| "routeResolved"
	| "startupRoute"
> {
	const route = resolveHydratedRoute(prev, playlists.length > 0);
	if (route.mode === "create" || route.mode === "edit") {
		const editingListName =
			route.mode === "edit" &&
			projectEditingListName(prev) &&
			playlists.some(
				(playlist) => playlist.name === projectEditingListName(prev),
			)
				? projectEditingListName(prev)
				: null;
		return {
			playlists,
			selectedListName: editingListName,
			editingListName,
			playbackListName: null,
			nowPlaying: null,
			mode: route.mode,
			routeResolved: route.routeResolved,
			startupRoute: route.kind,
		};
	}
	const selectedListName =
		prev.selectedListName &&
		playlists.some((playlist) => playlist.name === prev.selectedListName)
			? prev.selectedListName
			: null;
	const playbackOwnedList = derivePlaybackOwnedList({
		playlists,
		selectedListName,
		playbackListName: prev.playbackListName,
		requestedPlaying: null,
		confirmedPlaying: null,
		nowPlaying: prev.nowPlaying,
		mode: route.mode,
	});
	const refreshedNowPlaying =
		playbackOwnedList && prev.nowPlaying
			? (playlists
					.find((playlist) => playlist.name === playbackOwnedList.name)
					?.entries.flatMap((entry) => entry.musics)
					.find((music) => music.path === prev.nowPlaying?.path) ??
				playlists
					.find((playlist) => playlist.name === playbackOwnedList.name)
					?.exclude.find((music) => music.path === prev.nowPlaying?.path) ??
				prev.nowPlaying)
			: null;
	return {
		playlists,
		selectedListName,
		editingListName: null,
		playbackListName: playbackOwnedList?.name ?? null,
		nowPlaying: refreshedNowPlaying,
		mode: route.mode,
		routeResolved: route.routeResolved,
		startupRoute: route.kind,
	};
}

export function buildPlaylistPlaceholders(names: string[]): Playlist[] {
	return names.map((name) => ({
		name,
		avg_db: null,
		entries: [],
		exclude: [],
	}));
}

export function deriveProbePatch(
	prev: Pick<MusicState, "mode" | "routeResolved">,
	playlistNames: string[],
): Pick<MusicState, "playlists" | "mode" | "routeResolved" | "startupRoute"> {
	const route = resolveProbeRoute(prev, playlistNames.length > 0);
	return {
		playlists: buildPlaylistPlaceholders(playlistNames),
		mode: route.mode,
		routeResolved: route.routeResolved,
		startupRoute: route.kind,
	};
}

export function buildPostSavePatch(
	hasData: boolean,
	idleEpoch: number,
): Pick<
	MusicState,
	| "mode"
	| "routeResolved"
	| "startupRoute"
	| "selectedListName"
	| "editingListName"
	| "playbackListName"
	| "nowPlaying"
	| "nowJudge"
	| "slot"
	| "processMsg"
	| "entrySessionId"
	| "closureOwnerSessionId"
	| "playbackEpoch"
> {
	return {
		mode: hasData ? "play" : "new_guide",
		routeResolved: true,
		startupRoute: hasData ? "hydrated_playlists" : "hydrated_empty",
		selectedListName: null,
		editingListName: null,
		playbackListName: null,
		nowPlaying: null,
		nowJudge: null,
		slot: null,
		processMsg: null,
		entrySessionId: idleEpoch,
		closureOwnerSessionId: idleEpoch,
		playbackEpoch: idleEpoch,
	};
}

function defaultMission(): DraftMissionState {
	return { name: "", folders: [], links: [], entries: [], exclude: [] };
}

function missionFromPlaylist(playlist: Playlist): DraftMissionState {
	return {
		name: playlist.name,
		folders: [],
		links: [],
		entries: playlist.entries.map((entry) => ({ ...entry })),
		exclude: playlist.exclude,
	};
}

export function deriveWorkspaceEntryPatch(
	kind: "create" | "edit",
	currentEntrySessionId: number = 0,
	currentClosureOwnerSessionId: number = 0,
	playlist?: Playlist,
): Pick<
	MusicState,
	| "mode"
	| "routeResolved"
	| "startupRoute"
	| "slot"
	| "selectedListName"
	| "editingListName"
	| "playbackListName"
	| "nowPlaying"
	| "nowJudge"
	| "processMsg"
	| "entrySessionId"
	| "closureOwnerSessionId"
> {
	const editPlaylist = playlist as Playlist;
	const editingListName = kind === "edit" ? editPlaylist.name : null;
	return {
		mode: kind,
		routeResolved: true,
		startupRoute: "hydrated_editing",
		slot:
			kind === "create"
				? defaultMission()
				: cloneMissionWithoutDraftOperations(missionFromPlaylist(editPlaylist)),
		selectedListName: editingListName,
		editingListName,
		playbackListName: null,
		nowPlaying: null,
		nowJudge: null,
		processMsg: null,
		entrySessionId: currentEntrySessionId + 1,
		closureOwnerSessionId: currentClosureOwnerSessionId,
	};
}

export function deriveBackTransition(
	snapshot: Pick<
		MusicState,
		| "mode"
		| "playlists"
		| "routeResolved"
		| "selectedListName"
		| "editingListName"
		| "playbackListName"
		| "nowPlaying"
		| "nowJudge"
		| "slot"
		| "processMsg"
		| "entrySessionId"
		| "closureOwnerSessionId"
	>,
): Pick<
	MusicState,
	| "mode"
	| "routeResolved"
	| "startupRoute"
	| "selectedListName"
	| "editingListName"
	| "playbackListName"
	| "nowPlaying"
	| "nowJudge"
	| "slot"
	| "processMsg"
	| "entrySessionId"
	| "closureOwnerSessionId"
> {
	return {
		mode: snapshot.playlists.length > 0 ? "play" : "new_guide",
		routeResolved: snapshot.routeResolved,
		startupRoute:
			snapshot.playlists.length > 0 ? "hydrated_playlists" : "hydrated_empty",
		selectedListName: null,
		editingListName: null,
		playbackListName: null,
		nowPlaying: null,
		nowJudge: null,
		slot: null,
		processMsg: null,
		entrySessionId: snapshot.entrySessionId + 1,
		closureOwnerSessionId: snapshot.closureOwnerSessionId,
	};
}

export function deriveClosureProjectionEntry(
	snapshot: Pick<
		MusicState,
		| "playlists"
		| "playbackListName"
		| "confirmedPlaying"
		| "nowPlaying"
		| "selectedListName"
		| "processMsg"
	>,
): Entry | null {
	const playbackOwnedList = derivePlaybackOwnedList({
		playlists: snapshot.playlists,
		selectedListName: snapshot.selectedListName,
		playbackListName: snapshot.playbackListName,
		requestedPlaying: null,
		confirmedPlaying: snapshot.confirmedPlaying,
		nowPlaying: snapshot.nowPlaying,
	});
	if (!playbackOwnedList) return null;
	const activeTrack = snapshot.confirmedPlaying ?? snapshot.nowPlaying;
	if (activeTrack) {
		const playbackEntry = playbackOwnedList.entries.find((entry) =>
			entry.musics.some((music) => music.path === activeTrack.path),
		);
		if (playbackEntry) return playbackEntry;
	}
	return (
		playbackOwnedList.entries.find(
			(entry) => derivePersistedOwnerIdentity(entry) != null,
		) ?? null
	);
}

function deriveLiveClosureNotificationHint(
	snapshot: Pick<
		MusicState,
		| "playlists"
		| "selectedListName"
		| "playbackListName"
		| "confirmedPlaying"
		| "nowPlaying"
		| "processMsg"
	>,
	entry: Entry,
): { visible: boolean; text: string | null } {
	const hint = snapshot.processMsg;
	if (!hint || hint.playlist == null) return { visible: false, text: null };
	const liveEntryIdentity = derivePersistedOwnerIdentity(entry);
	if (!liveEntryIdentity) return { visible: false, text: null };
	const hintedPlaylist = snapshot.playlists.find(
		(playlist) => playlist.name === hint.playlist,
	);
	if (!hintedPlaylist) return { visible: false, text: null };
	const hintedEntry = hintedPlaylist.entries.find(
		(candidate) =>
			derivePersistedOwnerIdentity(candidate) === liveEntryIdentity,
	);
	if (!hintedEntry) return { visible: false, text: null };
	const hintedPathIdentity = deriveProcessMsgIdentityHint(hint as ProcessMsg);
	if (hintedPathIdentity && hintedPathIdentity !== liveEntryIdentity)
		return { visible: false, text: null };
	return { visible: true, text: hint.str };
}

export function canSettleClosureEvent(
	snapshot: ClosureSnapshot,
	event: ClosureEventContract,
	options: ClosureSettleOptions,
): boolean {
	const liveEntryIdentity = options.entry
		? derivePersistedOwnerIdentity(options.entry)
		: null;
	if (!liveEntryIdentity) return false;
	if (snapshot.entrySessionId !== snapshot.closureOwnerSessionId) return false;
	if (snapshot.closureOwnerSessionId !== event.ownerSessionId) return false;
	if (liveEntryIdentity !== event.entryIdentity) return false;
	if (
		event.phase === "playback" &&
		options.allowedPlaybackSessionId != null &&
		snapshot.playbackSessionId !== options.allowedPlaybackSessionId
	) {
		return false;
	}
	return true;
}

export function canSettleClosureEvents(
	snapshot: ClosureSnapshot,
	events: ClosureEventContract[],
	options: ClosureSettleOptions,
): boolean {
	if (events.length === 0) return false;
	const expectedPhases: ClosureEventPhase[] = [
		"saved",
		"downloaded",
		"analyzed",
		"notified",
		"playback",
	];
	if (events.length !== expectedPhases.length) return false;
	for (const [index, event] of events.entries()) {
		if (!canSettleClosureEvent(snapshot, event, options)) return false;
		if (event.phase !== expectedPhases[index]) return false;
	}
	return true;
}

export function deriveClosureProjection(
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
		| "playbackSessionId"
	>,
	typedFacts: readonly ClosureEventContract[] = [],
): ClosureProjection {
	const entry = deriveClosureProjectionEntry(snapshot);
	if (!entry) {
		return {
			state: "blocked",
			playable: false,
			interactive: false,
			notificationVisible: false,
			notificationText: null,
			reason: "no_live_owner_chain",
		};
	}
	const entryIdentity = derivePersistedOwnerIdentity(entry);
	if (!entryIdentity) {
		return {
			state: "blocked",
			playable: false,
			interactive: false,
			notificationVisible: false,
			notificationText: null,
			reason: "no_live_owner_chain",
		};
	}
	const liveOwnerChain =
		snapshot.entrySessionId === snapshot.closureOwnerSessionId &&
		snapshot.closureOwnerSessionId > 0;
	const notificationFact = typedFacts.find(
		(fact) =>
			fact.phase === "notified" &&
			fact.ownerSessionId === snapshot.closureOwnerSessionId &&
			fact.entryIdentity === entryIdentity,
	);
	const notificationHint = deriveLiveClosureNotificationHint(snapshot, entry);
	const notificationText = notificationFact ? notificationHint.text : null;
	const notificationVisible = notificationFact
		? notificationHint.visible
		: false;
	const playbackGate = canSettleClosureEvent(
		{
			entrySessionId: snapshot.entrySessionId,
			closureOwnerSessionId: snapshot.closureOwnerSessionId,
			playbackSessionId: snapshot.playbackSessionId,
		},
		createClosureEventContract(
			snapshot.closureOwnerSessionId,
			entryIdentity,
			"playback",
		),
		{ entry, allowedPlaybackSessionId: snapshot.playbackSessionId },
	);
	if (!liveOwnerChain) {
		return {
			state: "blocked",
			playable: false,
			interactive: false,
			notificationVisible,
			notificationText,
			reason: notificationVisible
				? "notification_only_hint"
				: "no_live_owner_chain",
		};
	}
	const materialization = getEntryMaterialization(entry);
	if (
		!materialization ||
		materialization.phase === "pending" ||
		materialization.phase === "downloading"
	) {
		return {
			state: "pending_download",
			playable: false,
			interactive: false,
			notificationVisible,
			notificationText,
			reason: "awaiting_download",
		};
	}
	if (
		materialization.phase === "persisted" ||
		materialization.phase === "analyzing"
	) {
		return {
			state: "pending_analysis",
			playable: false,
			interactive: false,
			notificationVisible,
			notificationText,
			reason: "awaiting_analysis",
		};
	}
	if (materialization.phase === "failed") {
		return {
			state: "blocked",
			playable: false,
			interactive: true,
			notificationVisible,
			notificationText,
			reason: "awaiting_analysis",
		};
	}
	if (!notificationVisible) {
		return {
			state: "notification_missing",
			playable: false,
			interactive: true,
			notificationVisible: false,
			notificationText: null,
			reason: "awaiting_notification_projection",
		};
	}
	if (!playbackGate || !snapshot.confirmedPlaying) {
		return {
			state: "ready",
			playable: false,
			interactive: true,
			notificationVisible,
			notificationText,
			reason: "ready_without_playback",
		};
	}
	return {
		state: "playable",
		playable: true,
		interactive: true,
		notificationVisible,
		notificationText,
		reason: "playback_confirmed",
	};
}

export function mapImportFolderEntryToEntry(item: ImportFolderEntry): Entry {
	const name = item.path.split(/[\\/]/).filter(Boolean).pop() ?? item.path;
	return {
		path: item.path,
		name,
		musics: item.items.map((path) => ({
			path,
			title: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
			avg_db: null,
			integrated_lufs: null,
			true_peak_dbtp: null,
			loudness_range_lu: null,
			loudness_threshold_lufs: null,
			analyzed_at_ms: null,
			analysis_version: null,
			source_mtime_ms: null,
			source_size_bytes: null,
			normalization_status: null,
			normalization_error: null,
			base_bias: 0,
			user_boost: 0,
			fatigue: 0,
			diversity: 0,
		})),
		avg_db: null,
		url: item.url,
		downloaded_ok: true,
		tracking: false,
		entry_type: item.entry_type,
	};
}

function trimmedName(name: string): string {
	const v = name.trim();
	return v.length > 0 ? v : name;
}

export function buildOptimisticPlaylistFromSlot(
	slot: CollectMission,
	anchor?: Playlist | null,
): Playlist {
	return {
		name: trimmedName(slot.name),
		avg_db: anchor?.avg_db ?? null,
		entries: slot.entries,
		exclude: slot.exclude,
	};
}

export function applyOptimisticEditSave(
	playlists: Playlist[],
	anchor: Playlist,
	slot: CollectMission,
): Playlist[] {
	const next = buildOptimisticPlaylistFromSlot(slot, anchor);
	return playlists.map((playlist) =>
		playlist.name === anchor.name ? next : playlist,
	);
}

export function canMutateSettledEntry(
	current: MusicState,
	expectedMode: UiMode,
	expectedSessionId: number,
	entryIdentity: string | null,
): boolean {
	return (
		entryIdentity != null &&
		(current.mode === "create" || current.mode === "edit") &&
		current.mode === expectedMode &&
		current.entrySessionId === expectedSessionId &&
		current.slot?.entries.some(
			(item) => deriveEntryIdentity(item) === entryIdentity,
		) === true
	);
}

export { deriveClosureOwnerIdentityFromMission };
