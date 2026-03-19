import { me } from "@grahlnn/fn";
import { Effect } from "effect";
import { useMemo, useSyncExternalStore } from "react";
import { sileo } from "sileo";
import { crab } from "@/src/cmd";
import type {
	AudioPlayAck,
	CollectMission,
	Entry,
	EntryType,
	ImportFolderEntry,
	InstallResult,
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
import { PlaybackCoordinator } from "./playbackCoordinator";

type UiMode = "play" | "create" | "edit" | "new_guide";
type Judge = "Up" | "Down" | null;

export type StartupRouteKind =
	| "startup_unresolved"
	| "startup_probed_empty"
	| "startup_probed_nonempty"
	| "hydrated_empty"
	| "hydrated_playlists"
	| "hydrated_editing"
	| "startup_failed";

export interface StartupRouteResolution {
	kind: StartupRouteKind;
	routeResolved: boolean;
	mode: UiMode;
	phase: "unresolved" | "probed" | "hydrated";
}

export interface StartupRouteSnapshot {
	kind: StartupRouteKind;
}

export type DraftEntryOperationKind =
	| "link_review"
	| "folder_reload"
	| "weblist_update";

export interface DraftEntryOperationState {
	kind: DraftEntryOperationKind;
	key: string;
	inProgress: boolean;
	settled: "idle" | "succeeded" | "failed";
	ownerSessionId: number;
}

export type WebMaterializationPhase =
	| "pending"
	| "downloading"
	| "persisted"
	| "analyzing"
	| "ready"
	| "failed";

export interface WebMaterializationState {
	phase: WebMaterializationPhase;
	ownerSessionId: number;
	settled: "idle" | "succeeded" | "failed";
	lastError: string | null;
}

export interface DraftLinkState {
	url: string;
	title_or_msg: string;
	entry_type: EntryType | "Unknown";
	count: number | null;
	status: "Ok" | "Err" | null;
	tracking: boolean;
	operation: DraftEntryOperationState | null;
}

export interface DraftMissionState extends Omit<CollectMission, "links"> {
	links: DraftLinkState[];
}

type DraftOperationEntry = Entry & {
	draftOperation?: DraftEntryOperationState | null;
	materialization?: WebMaterializationState | null;
};

type DraftReviewProjectionSnapshot = Pick<MusicState, "slot">;

export interface MusicState {
	mode: UiMode;
	routeResolved: boolean;
	startupRoute: StartupRouteKind;
	loading: boolean;
	playlists: Playlist[];
	selectedListName: string | null;
	playbackListName: string | null;
	requestedPlaying: Music | null;
	confirmedPlaying: Music | null;
	nowPlaying: Music | null;
	nowJudge: Judge;
	slot: DraftMissionState | null;
	processMsg: ProcessMsg | null;
	ytdlp: InstallResult | null;
	ffmpeg: InstallResult | null;
	savePath: string | null;
	entrySessionId: number;
	closureOwnerSessionId: number;
	playbackEpoch: number;
	playbackSessionId: number | null;
}

export type ClosureEventPhase =
	| "deleted"
	| "saved"
	| "downloaded"
	| "analyzed"
	| "failed"
	| "notified"
	| "playback";

export interface ClosureEventContract {
	ownerSessionId: number;
	entryIdentity: string;
	phase: ClosureEventPhase;
	eventId: string;
}

export type ClosureProjectionState =
	| "blocked"
	| "pending_download"
	| "pending_analysis"
	| "notification_missing"
	| "ready"
	| "playable";

export interface ClosureProjection {
	state: ClosureProjectionState;
	playable: boolean;
	interactive: boolean;
	notificationVisible: boolean;
	notificationText: string | null;
	reason:
		| "no_live_owner_chain"
		| "notification_only_hint"
		| "awaiting_download"
		| "awaiting_analysis"
		| "awaiting_notification_projection"
		| "ready_without_playback"
		| "playback_confirmed";
}

type ClosureSnapshot = Pick<
	MusicState,
	"closureOwnerSessionId" | "entrySessionId" | "playbackSessionId"
>;

type ClosureSettleOptions = {
	entry: Entry | null | undefined;
	allowedPlaybackSessionId?: number | null;
};

interface PlaybackSessionSnapshot {
	playbackEpoch: number;
	playbackSessionId: number | null;
	selectedListName: string | null;
	playbackListName: string | null;
	requestedPlaying: Music | null;
	confirmedPlaying: Music | null;
	nowPlaying: Music | null;
	nowJudge: Judge;
	playlists: Playlist[];
}

export function derivePlaybackOwnedList(
	snapshot: Pick<
		MusicState,
		| "playlists"
		| "selectedListName"
		| "playbackListName"
		| "requestedPlaying"
		| "confirmedPlaying"
		| "nowPlaying"
	>,
): Playlist | null {
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
		return snapshot.selectedListName
			? (snapshot.playlists.find(
					(playlist) => playlist.name === snapshot.selectedListName,
				) ?? null)
			: null;
	}

	for (const playlist of snapshot.playlists) {
		const containsTrack =
			playlist.entries.some((entry) =>
				entry.musics.some((music) => music.path === activeTrack.path),
			) || playlist.exclude.some((music) => music.path === activeTrack.path);
		if (containsTrack) {
			return playlist;
		}
	}

	return snapshot.selectedListName
		? (snapshot.playlists.find(
				(playlist) => playlist.name === snapshot.selectedListName,
			) ?? null)
		: null;
}

function toPlaybackContractSessionId(sessionId: number): number {
	return sessionId;
}

export interface SaveAffordance {
	allowed: boolean;
	visible: boolean;
	reason:
		| "missing_slot"
		| "missing_ffmpeg"
		| "missing_save_path"
		| "duplicate_name"
		| "invalid_mission"
		| "review_in_progress";
}

export type WorkspaceScreen =
	| "unresolved"
	| "guide"
	| "play"
	| "create"
	| "edit";

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
	if (!snapshot.routeResolved) {
		return "unresolved";
	}

	if (snapshot.mode === "create") {
		return "create";
	}

	if (snapshot.mode === "edit") {
		return "edit";
	}

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

export function canExitWorkspace(
	snapshot: DraftReviewProjectionSnapshot,
): boolean {
	return deriveDraftReviewState(snapshot).active.length === 0;
}

export function deriveDraftReviewState(
	snapshot: DraftReviewProjectionSnapshot,
): {
	active: DraftEntryOperationState[];
	linkReviews: string[];
	folderReviews: string[];
	weblistReviews: string[];
} {
	if (!snapshot.slot) {
		return {
			active: [],
			linkReviews: [],
			folderReviews: [],
			weblistReviews: [],
		};
	}

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
		if (operation.kind === "folder_reload") {
			folderReviews.push(operation.key);
		} else if (operation.kind === "weblist_update") {
			weblistReviews.push(operation.key);
		}
	}

	return { active, linkReviews, folderReviews, weblistReviews };
}

export function deriveSaveAffordance(
	snapshot: Pick<
		MusicState,
		"slot" | "ffmpeg" | "savePath" | "playlists" | "selectedListName"
	>,
): SaveAffordance {
	if (!snapshot.slot) {
		return { allowed: false, visible: false, reason: "missing_slot" };
	}

	if (!snapshot.ffmpeg) {
		return { allowed: false, visible: false, reason: "missing_ffmpeg" };
	}

	if (!snapshot.savePath) {
		return { allowed: false, visible: false, reason: "missing_save_path" };
	}

	const normalizedName = snapshot.slot.name.trim().toLowerCase();
	const duplicate = snapshot.playlists
		.filter((playlist) => playlist.name !== snapshot.selectedListName)
		.some((playlist) => playlist.name.trim().toLowerCase() === normalizedName);
	if (duplicate) {
		return { allowed: false, visible: false, reason: "duplicate_name" };
	}

	const persistCheck = canPersistMission(snapshot.slot);
	if (!persistCheck.ok) {
		return { allowed: false, visible: false, reason: "invalid_mission" };
	}

	if (!canExitWorkspace(snapshot)) {
		return { allowed: false, visible: true, reason: "review_in_progress" };
	}

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
	"selectedListName" | "playbackListName" | "confirmedPlaying" | "nowPlaying"
> | null {
	if (snapshot.mode !== "play") return null;
	if (snapshot.playbackSessionId == null) return null;
	if (snapshot.playbackSessionId !== payload.sessionId) return null;
	const playbackOwnedList = derivePlaybackOwnedList(snapshot);
	if (!payload.listName || playbackOwnedList?.name !== payload.listName) {
		return null;
	}
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
		requestedPlaying: null,
		confirmedPlaying: null,
		nowPlaying: null,
		nowJudge: null,
		playbackEpoch: snapshot.playbackEpoch,
		playbackSessionId: null,
	};
}

export function clearPlaybackTransportFact(
	snapshot: PlaybackSessionSnapshot,
	sessionId: number | null,
	fact: "stopped" | "ended" | "failed" | "paused" | "resumed",
): Pick<
	MusicState,
	| "selectedListName"
	| "playbackListName"
	| "requestedPlaying"
	| "confirmedPlaying"
	| "nowPlaying"
	| "nowJudge"
	| "playbackEpoch"
	| "playbackSessionId"
> | null {
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

	if (fact === "ended") {
		return clearEndedPlaybackForFallback(snapshot);
	}

	return clearPlaybackSession(snapshot, sessionId);
}

export function clearEndedPlaybackForFallback(
	snapshot: Pick<
		MusicState,
		| "selectedListName"
		| "playbackListName"
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
		requestedPlaying: null,
		confirmedPlaying: snapshot.confirmedPlaying,
		nowPlaying: null,
		nowJudge: null,
		playbackEpoch: snapshot.playbackEpoch,
		playbackSessionId: snapshot.playbackSessionId,
	};
}

export function deriveRefreshPatch(
	prev: Pick<
		MusicState,
		| "mode"
		| "routeResolved"
		| "selectedListName"
		| "playbackListName"
		| "nowPlaying"
	>,
	playlists: Playlist[],
): Pick<
	MusicState,
	| "playlists"
	| "selectedListName"
	| "playbackListName"
	| "nowPlaying"
	| "mode"
	| "routeResolved"
	| "startupRoute"
> {
	const route = resolveHydratedRoute(prev, playlists.length > 0);

	if (route.mode === "create" || route.mode === "edit") {
		const selectedListName =
			route.mode === "edit" &&
			prev.selectedListName &&
			playlists.some((playlist) => playlist.name === prev.selectedListName)
				? prev.selectedListName
				: null;

		return {
			playlists,
			selectedListName,
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

export function deriveWorkspaceEntryPatch(
	kind: "create",
): Pick<
	MusicState,
	| "mode"
	| "routeResolved"
	| "startupRoute"
	| "slot"
	| "selectedListName"
	| "playbackListName"
	| "nowPlaying"
	| "nowJudge"
	| "processMsg"
	| "entrySessionId"
	| "closureOwnerSessionId"
>;
export function deriveWorkspaceEntryPatch(
	kind: "edit",
	playlist: Playlist,
): Pick<
	MusicState,
	| "mode"
	| "routeResolved"
	| "startupRoute"
	| "slot"
	| "selectedListName"
	| "playbackListName"
	| "nowPlaying"
	| "nowJudge"
	| "processMsg"
	| "entrySessionId"
	| "closureOwnerSessionId"
>;
export function deriveWorkspaceEntryPatch(
	kind: "create" | "edit",
	playlist?: Playlist,
): Pick<
	MusicState,
	| "mode"
	| "routeResolved"
	| "startupRoute"
	| "slot"
	| "selectedListName"
	| "playbackListName"
	| "nowPlaying"
	| "nowJudge"
	| "processMsg"
	| "entrySessionId"
	| "closureOwnerSessionId"
> {
	const editPlaylist = playlist as Playlist;

	return {
		mode: kind,
		routeResolved: true,
		startupRoute: "hydrated_editing",
		slot:
			kind === "create"
				? defaultMission()
				: cloneMissionWithoutDraftOperations(missionFromPlaylist(editPlaylist)),
		selectedListName: kind === "edit" ? editPlaylist.name : null,
		playbackListName: null,
		nowPlaying: null,
		nowJudge: null,
		processMsg: null,
		entrySessionId: state.entrySessionId + 1,
		closureOwnerSessionId: state.closureOwnerSessionId,
	};
}

export function deriveBackTransition(
	snapshot: Pick<
		MusicState,
		| "mode"
		| "playlists"
		| "routeResolved"
		| "selectedListName"
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
		playbackListName: null,
		nowPlaying: null,
		nowJudge: null,
		slot: null,
		processMsg: null,
		entrySessionId: snapshot.entrySessionId + 1,
		closureOwnerSessionId: snapshot.closureOwnerSessionId,
	};
}

function canMutateSettledEntry(
	current: MusicState,
	expectedMode: UiMode,
	expectedSessionId: number,
	entryIdentity: string | null,
): boolean {
	return (
		entryIdentity != null &&
		isEditingWorkspace(current.mode) &&
		current.mode === expectedMode &&
		current.entrySessionId === expectedSessionId &&
		current.slot?.entries.some(
			(item) => deriveEntryIdentity(item) === entryIdentity,
		) === true
	);
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

const initialState: MusicState = {
	mode: "new_guide",
	routeResolved: false,
	startupRoute: "startup_unresolved",
	loading: false,
	playlists: [],
	selectedListName: null,
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
};

const listeners = new Set<() => void>();
let state: MusicState = { ...initialState };
let started = false;
const unsubs: Array<() => void> = [];
const recentByList = new Map<string, string[]>();
const playback = new PlaybackCoordinator();
let runVersion = 0;

function recentWindowSize(trackCount: number): number {
	if (trackCount <= 1) return 0;
	return Math.min(3, trackCount - 1);
}

function emit() {
	for (const listener of listeners) {
		listener();
	}
}

function setState(next: MusicState | ((prev: MusicState) => MusicState)) {
	state = typeof next === "function" ? next(state) : next;
	emit();
}

function patchState(patch: Partial<MusicState>) {
	setState((prev) => ({ ...prev, ...patch }));
}

function buildClosureEventId(
	ownerSessionId: number,
	entryIdentity: string,
	phase: ClosureEventPhase,
): string {
	return `${ownerSessionId}:${entryIdentity}:${phase}`;
}

export function createClosureEventContract(
	ownerSessionId: number,
	entryIdentity: string,
	phase: ClosureEventPhase,
): ClosureEventContract {
	return {
		ownerSessionId,
		entryIdentity,
		phase,
		eventId: buildClosureEventId(ownerSessionId, entryIdentity, phase),
	};
}

export function canSettleClosureEvent(
	snapshot: ClosureSnapshot,
	event: ClosureEventContract,
	options: ClosureSettleOptions,
): boolean {
	const liveEntryIdentity = options.entry ? derivePersistedOwnerIdentity(options.entry) : null;
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
	const seenPhases = new Set<ClosureEventPhase>();
	for (const event of events) {
		if (!canSettleClosureEvent(snapshot, event, options)) {
			return false;
		}
		seenPhases.add(event.phase);
	}
	return expectedPhases.every((phase) => seenPhases.has(phase));
}

function deriveClosureProjectionEntry(
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
	const notificationText =
		snapshot.processMsg?.playlist != null ? snapshot.processMsg.str : null;
	const notificationVisible =
		snapshot.processMsg?.playlist != null && notificationText != null;
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
	if (!materialization || materialization.phase === "pending" || materialization.phase === "downloading") {
		return {
			state: "pending_download",
			playable: false,
			interactive: false,
			notificationVisible,
			notificationText,
			reason: "awaiting_download",
		};
	}

	if (materialization.phase === "persisted" || materialization.phase === "analyzing") {
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
	patchState({ processMsg: processMsg });
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getState() {
	return state;
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
	return version === runVersion;
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
		entry_type: item.entry_type as EntryType,
	};
}

function createDraftOperation(
	kind: DraftEntryOperationKind,
	key: string,
	ownerSessionId: number,
): DraftEntryOperationState {
	return { kind, key, ownerSessionId, inProgress: true, settled: "idle" };
}

function settleDraftOperation(
	operation: DraftEntryOperationState,
	settled: "succeeded" | "failed",
): DraftEntryOperationState {
	return { ...operation, inProgress: false, settled };
}

function getDraftEntryOperation(entry: Entry): DraftEntryOperationState | null {
	return (entry as DraftOperationEntry).draftOperation ?? null;
}

function getEntryMaterialization(entry: Entry): WebMaterializationState | null {
	return (entry as DraftOperationEntry).materialization ?? null;
}

function setDraftEntryOperation(
	entry: Entry,
	operation: DraftEntryOperationState | null,
): Entry {
	const next: DraftOperationEntry = {
		...(entry as DraftOperationEntry),
	};

	if (operation) {
		next.draftOperation = operation;
	} else {
		delete next.draftOperation;
	}

	return next;
}

function setPlaylistEntryMaterializationByIdentity(
	playlists: Playlist[],
	playlistName: string,
	entryIdentity: string,
	ownerSessionId: number,
	materialization: WebMaterializationState | null,
): Playlist[] {
	return playlists.map((playlist) => {
		if (playlist.name !== playlistName) {
			return playlist;
		}

		let entryMatched = false;
		const entries = playlist.entries.map((entry) => {
			if (deriveEntryIdentity(entry) !== entryIdentity) {
				return entry;
			}

			const currentMaterialization = getEntryMaterialization(entry);
			if (currentMaterialization?.ownerSessionId !== ownerSessionId) {
				return entry;
			}

			entryMatched = true;
			return setEntryMaterialization(entry, materialization);
		});

		if (!entryMatched) {
			return playlist;
		}

		return {
			...playlist,
			entries,
		};
	});
}

function carryForwardPersistedMaterializationOwnership(
	playlists: Playlist[],
	previousPlaylists: Playlist[],
	defaultOwnerSessionId: number,
): Playlist[] {
	return playlists.map((playlist) => {
		const previousPlaylist = previousPlaylists.find(
			(item) => item.name === playlist.name,
		);
		const previousMaterializationByOwnerIdentity = new Map<
			string,
			WebMaterializationState
		>();
		for (const entry of previousPlaylist?.entries ?? []) {
			const entryIdentity = derivePersistedOwnerIdentity(entry);
			const materialization = getEntryMaterialization(entry);
			if (!entryIdentity || !materialization) {
				continue;
			}
			previousMaterializationByOwnerIdentity.set(
				entryIdentity,
				materialization,
			);
		}

		let changed = false;
		const entries = playlist.entries.map((entry) => {
			const entryIdentity = derivePersistedOwnerIdentity(entry);
			if (!entryIdentity) {
				return entry;
			}

			const previousMaterialization =
				previousMaterializationByOwnerIdentity.get(entryIdentity);
			const nextMaterialization = deriveEntryOwnedMaterialization(
				entry,
				previousMaterialization?.ownerSessionId ?? defaultOwnerSessionId,
				previousMaterialization?.lastError ?? null,
			);
			if (!nextMaterialization) {
				return entry;
			}

			if (!previousMaterialization) {
				changed = true;
				return setEntryMaterialization(entry, nextMaterialization);
			}

			if (
				nextMaterialization.ownerSessionId ===
					previousMaterialization.ownerSessionId &&
				nextMaterialization.phase === previousMaterialization.phase &&
				nextMaterialization.settled === previousMaterialization.settled &&
				nextMaterialization.lastError === previousMaterialization.lastError
			) {
				return setEntryMaterialization(entry, previousMaterialization);
			}

			changed = true;
			return setEntryMaterialization(entry, nextMaterialization);
		});

		if (!changed) {
			return previousPlaylist === playlist
				? playlist
				: { ...playlist, entries };
		}

		return { ...playlist, entries };
	});
}

function setEntryMaterialization(
	entry: Entry,
	materialization: WebMaterializationState | null,
): Entry {
	const next: DraftOperationEntry = {
		...(entry as DraftOperationEntry),
	};

	if (materialization) {
		next.materialization = materialization;
	} else {
		delete next.materialization;
	}

	return next;
}

function cloneEntryWithoutDraftOperation(entry: Entry): Entry {
	return setEntryMaterialization(setDraftEntryOperation(entry, null), null);
}

function cloneLinkWithoutDraftOperation(link: DraftLinkState): DraftLinkState {
	return setDraftLinkOperation(link, null);
}

function cloneMissionWithoutDraftOperations(
	mission: DraftMissionState,
): DraftMissionState {
	return {
		...mission,
		entries: mission.entries.map(cloneEntryWithoutDraftOperation),
		links: mission.links.map(cloneLinkWithoutDraftOperation),
	};
}

function setDraftLinkOperation(
	link: DraftLinkState,
	operation: DraftEntryOperationState | null,
): DraftLinkState {
	return {
		...link,
		operation,
	};
}

function deriveEntryIdentity(entry: Entry): string | null {
	return entry.url ?? entry.path ?? null;
}

function derivePersistedOwnerMaterializationKey(entry: Entry): string | null {
	if (entry.url && entry.path) {
		return `url-path:${entry.url}::${entry.path}`;
	}
	if (entry.path) {
		return `path:${entry.path}`;
	}
	if (entry.url && entry.name) {
		return `url-name:${entry.url}::${entry.name}`;
	}
	if (entry.url) {
		return `url:${entry.url}`;
	}
	return null;
}

function derivePersistedOwnerIdentity(entry: Entry): string | null {
	return derivePersistedOwnerMaterializationKey(entry);
}

function deriveClosureOwnerIdentityFromMission(
	slot: CollectMission | null | undefined,
): string | null {
	if (!slot) return null;
	for (const entry of slot.entries) {
		const identity = derivePersistedOwnerIdentity(entry);
		if (identity) return identity;
	}
	return null;
}

function deriveWebMaterializationPhase(
	entry: Entry,
): WebMaterializationPhase | null {
	if (entry.entry_type !== "WebList" && entry.entry_type !== "WebVideo") {
		return null;
	}

	if (entry.downloaded_ok !== true) {
		return entry.musics.length > 0 ? "downloading" : "pending";
	}

	const hasCanonicalReadyMusic = entry.musics.some(
		(music) =>
			music.normalization_status === "Ready" &&
			music.integrated_lufs != null &&
			music.analysis_version != null,
	);
	if (hasCanonicalReadyMusic) {
		return "ready";
	}

	const hasPersistedAnalysisIdentity = entry.musics.some(
		(music) =>
			music.analyzed_at_ms != null ||
			music.analysis_version != null ||
			music.integrated_lufs != null ||
			music.normalization_status === "Pending" ||
			music.normalization_status === "Ready" ||
			music.normalization_status === "Failed",
	);

	if (!hasPersistedAnalysisIdentity) {
		return entry.musics.length > 0 ? "persisted" : "downloading";
	}

	const hasFailedMusic = entry.musics.some(
		(music) => music.normalization_status === "Failed",
	);
	if (hasFailedMusic) {
		return "failed";
	}

	const hasPersistedMusic = entry.musics.length > 0;
	if (!hasPersistedMusic) {
		return "downloading";
	}

	const hasAnalyzingMusic = entry.musics.some(
		(music) =>
			music.normalization_status !== "Failed" &&
			(music.normalization_status === "Pending" ||
				music.integrated_lufs == null ||
				music.analysis_version == null),
	);
	return hasAnalyzingMusic ? "analyzing" : "persisted";
}

function deriveEntryOwnedMaterialization(
	entry: Entry,
	ownerSessionId: number,
	lastError: string | null = null,
): WebMaterializationState | null {
	const phase = deriveWebMaterializationPhase(entry);
	if (!phase) return null;
	return {
		phase,
		ownerSessionId,
		settled:
			phase === "ready" || phase === "persisted" || phase === "analyzing"
				? "succeeded"
				: phase === "failed"
					? "failed"
					: "idle",
		lastError,
	};
}

function syncEntryOwnedMaterialization(
	entry: Entry,
	ownerSessionId: number,
	lastError: string | null = null,
): Entry {
	return setEntryMaterialization(
		entry,
		deriveEntryOwnedMaterialization(entry, ownerSessionId, lastError),
	);
}

function isEditingWorkspace(mode: UiMode): boolean {
	return mode === "create" || mode === "edit";
}

function replaceEntryByIdentity(
	entries: Entry[],
	identity: string,
	next: Entry,
): Entry[] {
	let matched = false;
	const updatedEntries = entries.map((item) => {
		if (deriveEntryIdentity(item) !== identity) {
			return item;
		}

		matched = true;
		return next;
	});

	return matched ? updatedEntries : entries;
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

function defaultMission(): DraftMissionState {
	return {
		name: "",
		folders: [],
		links: [],
		entries: [],
		exclude: [],
	};
}

function missionFromPlaylist(playlist: Playlist): DraftMissionState {
	return {
		name: playlist.name,
		folders: [],
		links: [],
		entries: playlist.entries.map(cloneEntryWithoutDraftOperation),
		exclude: playlist.exclude,
	};
}

function currentList(input = state): Playlist | null {
	if (!input.selectedListName) return null;
	return (
		input.playlists.find(
			(playlist) => playlist.name === input.selectedListName,
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
			return {
				...next,
				processMsg: sanitizeProcessMsgHint(previousPlaylists, {
					playlists: next.playlists,
					processMsg: next.processMsg,
				}),
			};
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

	setState((prev) => ({
		...prev,
		...deriveProbePatch(prev, result.unwrap()),
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
			patchState(clearEndedPlaybackForFallback(snapshot));
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
			patchState(patch);
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
			const patch = clearPlaybackTransportFact(getState(), sessionId, fact);
			if (!patch) return;
			patchState(patch);
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
	if (
		snapshot.playbackListName === name &&
		(snapshot.confirmedPlaying ?? snapshot.nowPlaying)
	) {
		await safeStop();
		return;
	}

	const list = snapshot.playlists.find((playlist) => playlist.name === name) ?? null;
	const liveEntry = list?.entries.find((entry) => !!derivePersistedOwnerIdentity(entry)) ?? null;
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
		const anchor = snapshot.playlists.find(
			(playlist) => playlist.name === snapshot.selectedListName,
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
			sileo.success({ title: "Playlist saved" });
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
		sileo.success({ title: "Playlist saved" });
	})();
}

export const action = {
	async run() {
		const version = ++runVersion;
		playback.markActive();
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
			patchState({ routeResolved: true, startupRoute: "startup_failed" });
		} finally {
			if (isCurrentRun(version)) {
				patchState({ loading: false });
			}
		}
	},
	async next() {
		const snapshot = getState();
		if (snapshot.mode !== "play" || !snapshot.selectedListName) return;
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
		sileo.success({ title: "Logits reset" });
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

		if (getState().selectedListName === playlist.name) {
			await safeStop();
		}
		await refreshLists();
	},
	async addNew() {
		await safeStop();
		patchState(deriveWorkspaceEntryPatch("create"));
	},
	async edit(playlist: Playlist) {
		await safeStop();
		patchState(deriveWorkspaceEntryPatch("edit", playlist));
	},
	async back() {
		const snapshot = getState();
		if (!canExitWorkspace(snapshot)) {
			return;
		}

		await safeStop();
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
		await persistSlot();
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
		const playlist = snapshot.selectedListName;
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
		sileo.success({ title: "yt-dlp installed" });
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
		sileo.success({ title: "ffmpeg installed" });
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
		runVersion += 1;
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
	readAll() {
		return refreshLists();
	},
	replaceState(next: MusicState) {
		state = next;
	},
	reset() {
		listeners.clear();
		recentByList.clear();
		for (const unsub of unsubs.splice(0)) {
			unsub();
		}
		state = { ...initialState };
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
	useSelectedList: () =>
		useMusicSelector((snapshot) =>
			snapshot.selectedListName
				? (snapshot.playlists.find(
						(playlist) => playlist.name === snapshot.selectedListName,
					) ?? null)
				: null,
		),
	useSlot: () => useMusicSelector((snapshot) => snapshot.slot),
	useMsg: () => useMusicSelector((snapshot) => snapshot.processMsg),
	useClosureProjection: () =>
		useMusicSelector((snapshot) => deriveClosureProjection(snapshot)),
	useJudge: () => useMusicSelector((snapshot) => snapshot.nowJudge),
	useIsPlaying: () =>
		useMusicSelector(
			(snapshot) => !!snapshot.selectedListName && !!snapshot.confirmedPlaying,
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
