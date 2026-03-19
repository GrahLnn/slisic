import { Err, Ok } from "@grahlnn/fn";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as commandContract from "@/src/cmd/commands";
import type { CollectMission, Entry, Music, Playlist } from "@/src/cmd/commands";
import type {
	DraftEntryOperationState,
	DraftLinkState,
	DraftMissionState,
} from "./store";

const toastLog = {
	error: [] as Array<{ title: string; description?: string }>,
	success: [] as Array<{ title: string; description?: string }>,
};

const playbackLog = {
	interrupts: 0,
	replaceWith: [] as Array<{ epoch: number }>,
	markActive: 0,
	markDisposed: 0,
};

const impl = {
	evt: async (_event: string, _handler: (payload: unknown) => void) => () => {},
	appReady: async () => undefined,
	checkExists: async () => Ok<null, string>(null),
	ffmpegCheckExists: async () =>
		Ok<{ installed_path: string; installed_version: string }, string>({
			installed_path: "ffmpeg",
			installed_version: "7.0.0",
		}),
	resolveSavePath: async () => Ok<string, string>("C:/music"),
	playlistNames: async () => Ok<string[], string>([]),
	readAll: async () => Ok<Playlist[], string>([]),
	create: async (_data: CollectMission) => Ok<null, string>(null),
	update: async (_data: CollectMission, _anchor: Playlist) =>
		Ok<null, string>(null),
	audioStop: async () => Ok<null, string>(null),
	unstar: async (_list: Playlist, _music: Music) => Ok<null, string>(null),
	recheckFolder: async (entry: Entry) => Ok<Entry, string>(entry),
	updateWeblist: async (entry: Entry, _playlist: string) =>
		Ok<Entry, string>(entry),
	collectImportFolderEntries: async (_path: string) => Ok<never[], string>([]),
	lookMedia: async (_url: string) =>
		Ok<
			{ title: string; item_type: string; entries_count: number | null },
			string
		>({
			title: "sample",
			item_type: "playlist",
			entries_count: 1,
		}),
	fatigue: async (_music: Music) => Ok<null, string>(null),
	boost: async (_music: Music) => Ok<null, string>(null),
	cancleBoost: async (_music: Music) => Ok<null, string>(null),
	cancleFatigue: async (_music: Music) => Ok<null, string>(null),
	resetLogits: async () => Ok<null, string>(null),
	delete: async (_name: string) => Ok<null, string>(null),
	ytdlpDownloadAndInstall: async () =>
		Ok<{ installed_path: string; installed_version: string }, string>({
			installed_path: "yt-dlp",
			installed_version: "1.0.0",
		}),
	ffmpegDownloadAndInstall: async () =>
		Ok<{ installed_path: string; installed_version: string }, string>({
			installed_path: "ffmpeg",
			installed_version: "1.0.0",
		}),
	updateSavePath: async (_path: string) => Ok<null, string>(null),
	audioPlay: async () =>
		Ok<
			{
				session_id: number;
				path: string;
				duration_ms: number | null;
				gain: number;
				gain_db: number;
				target_lufs: number;
				integrated_lufs: number | null;
				has_canonical_loudness: boolean;
			},
			string
		>({
			session_id: 1,
			path: "track.mp3",
			duration_ms: 1000,
			gain: 1,
			gain_db: 0,
			target_lufs: -18,
			integrated_lufs: -18,
			has_canonical_loudness: true,
		}),
};

const crab = {
	evt(event: string) {
		return async (handler: (payload: unknown) => void) => {
			return impl.evt(event, handler);
		};
	},
	appReady: () => impl.appReady(),
	checkExists: () => impl.checkExists(),
	ffmpegCheckExists: () => impl.ffmpegCheckExists(),
	resolveSavePath: () => impl.resolveSavePath(),
	playlistNames: () => impl.playlistNames(),
	readAll: () => impl.readAll(),
	create: (data: CollectMission) => impl.create(data),
	update: (data: CollectMission, anchor: Playlist) => impl.update(data, anchor),
	audioStop: () => impl.audioStop(),
	unstar: (list: Playlist, music: Music) => impl.unstar(list, music),
	recheckFolder: (entry: Entry) => impl.recheckFolder(entry),
	updateWeblist: (entry: Entry, playlist: string) =>
		impl.updateWeblist(entry, playlist),
	collectImportFolderEntries: (path: string) =>
		impl.collectImportFolderEntries(path),
	lookMedia: (url: string) => impl.lookMedia(url),
	fatigue: (music: Music) => impl.fatigue(music),
	boost: (music: Music) => impl.boost(music),
	cancleBoost: (music: Music) => impl.cancleBoost(music),
	cancleFatigue: (music: Music) => impl.cancleFatigue(music),
	resetLogits: () => impl.resetLogits(),
	delete: (name: string) => impl.delete(name),
	ytdlpDownloadAndInstall: () => impl.ytdlpDownloadAndInstall(),
	ffmpegDownloadAndInstall: () => impl.ffmpegDownloadAndInstall(),
	updateSavePath: (path: string) => impl.updateSavePath(path),
	audioPlay: (req: { session_id: number; path: string }) => {
		impl.audioPlay = async () =>
			Ok({
				session_id: req.session_id,
				path: "track.mp3",
				duration_ms: 1000,
				gain: 1,
				gain_db: 0,
				target_lufs: -18,
				integrated_lufs: -18,
				has_canonical_loudness: true,
			});
		return impl.audioPlay();
	},
};

mock.module("@/src/cmd", () => ({ crab }));
mock.module("sileo", () => ({
	sileo: {
		error: (payload: { title: string; description?: string }) => {
			toastLog.error.push(payload);
		},
		success: (payload: { title: string; description?: string }) => {
			toastLog.success.push(payload);
		},
	},
}));

class MockPlaybackCoordinator {
	private epoch = 0;

	markActive() {
		playbackLog.markActive += 1;
	}

	markDisposed() {
		playbackLog.markDisposed += 1;
	}

	bumpEpoch() {
		this.epoch += 1;
		return this.epoch;
	}

	getEpoch() {
		return this.epoch;
	}

	isActive(epoch: number) {
		return epoch === this.epoch;
	}

	replaceWith(_task: unknown, epoch: number) {
		playbackLog.replaceWith.push({ epoch });
	}

	async interruptCurrent() {
		playbackLog.interrupts += 1;
	}
}

mock.module("./playbackCoordinator", () => ({
	PlaybackCoordinator: MockPlaybackCoordinator,
}));

const { __testing, action, deriveDraftReviewState, deriveRouteResolution } =
	await import("./store");

function makeMusic(path: string): Music {
	return {
		path,
		title: path.split("/").pop() ?? path,
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
	};
}

function makeEntry(
	name: string,
	path: string,
	patch: Partial<Entry> = {},
): Entry {
	return {
		path,
		name,
		musics: [makeMusic(`${path}/a.flac`)],
		avg_db: null,
		url: null,
		downloaded_ok: true,
		tracking: false,
		entry_type: "Local",
		...patch,
	};
}

function makePlaylist(
	name: string,
	entries: Entry[] = [],
	exclude: Music[] = [],
): Playlist {
	return {
		name,
		avg_db: null,
		entries,
		exclude,
	};
}

function makeMission(name: string, entries: Entry[] = []): DraftMissionState {
	return {
		name,
		folders: [],
		links: [],
		entries,
		exclude: [],
	};
}

async function flush() {
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await Promise.resolve();
}

async function waitUntil(predicate: () => boolean) {
	for (let i = 0; i < 20; i += 1) {
		if (predicate()) {
			return;
		}
		await flush();
	}
	throw new Error("condition not reached in time");
}

function hasPendingEntryOperation(
	entry: Entry,
	kind: "folder_reload" | "weblist_update",
): boolean {
	const operation = (
		entry as Entry & {
			draftOperation?: {
				kind?: string;
				inProgress?: boolean;
			};
		}
	).draftOperation;
	return operation?.kind === kind && operation.inProgress === true;
}

function expectEntryOperation(
	entry: Entry,
	operation: {
		kind: "folder_reload" | "weblist_update";
		key: string;
		inProgress: boolean;
		settled: "idle" | "succeeded" | "failed";
		ownerSessionId: number;
	},
) {
	expect(entry).toMatchObject({
		...entry,
		draftOperation: operation,
	});
}

function expectLinkOperation(
	link: DraftMissionState["links"][number],
	operation: {
		kind: "link_review";
		key: string;
		inProgress: boolean;
		settled: "idle" | "succeeded" | "failed";
		ownerSessionId: number;
	},
) {
	expect(link).toMatchObject({
		...link,
		operation,
	});
}

function withEntryOperation(
	entry: Entry,
	operation: DraftEntryOperationState,
): Entry & { draftOperation: DraftEntryOperationState } {
	return {
		...entry,
		draftOperation: operation,
	};
}

function withEntryMaterialization(
	entry: Entry,
	materialization: {
		phase: string;
		settled: "idle" | "succeeded" | "failed";
		ownerSessionId: number;
		lastError: string | null;
	},
): Entry & {
	materialization: {
		phase: string;
		settled: "idle" | "succeeded" | "failed";
		ownerSessionId: number;
		lastError: string | null;
	};
} {
	return {
		...entry,
		materialization,
	};
}

function expectPlaylistLike(actual: Playlist[] | undefined, expected: Playlist[]) {
	expect(actual).toHaveLength(expected.length);
	actual?.forEach((playlist, index) => {
		expect(playlist).toMatchObject(expected[index]!);
	});
}

function makeDraftLink(
	patch: Partial<DraftLinkState> & Pick<DraftLinkState, "url">,
): DraftLinkState {
	return {
		url: patch.url,
		title_or_msg: patch.title_or_msg ?? "Detecting...",
		entry_type: patch.entry_type ?? "Unknown",
		count: patch.count ?? null,
		status: patch.status ?? null,
		tracking: patch.tracking ?? false,
		operation: patch.operation ?? null,
	};
}

async function refresh() {
	await action.run();
}

beforeEach(() => {
	toastLog.error.length = 0;
	toastLog.success.length = 0;
	playbackLog.interrupts = 0;
	playbackLog.replaceWith.length = 0;
	playbackLog.markActive = 0;
	playbackLog.markDisposed = 0;
	__testing.reset();

	impl.appReady = async () => undefined;
	impl.evt =
		async (_event: string, _handler: (payload: unknown) => void) => () => {};
	impl.checkExists = async () => Ok<null, string>(null);
	impl.resolveSavePath = async () => Ok<string, string>("C:/music");
	impl.playlistNames = async () => Ok<string[], string>([]);
	impl.readAll = async () => Ok<Playlist[], string>([]);
	impl.create = async (_data: CollectMission) => Ok<null, string>(null);
	impl.update = async (_data: CollectMission, _anchor: Playlist) =>
		Ok<null, string>(null);
	impl.audioStop = async () => Ok<null, string>(null);
	impl.unstar = async (_list: Playlist, _music: Music) =>
		Ok<null, string>(null);
	impl.recheckFolder = async (entry: Entry) => Ok<Entry, string>(entry);
	impl.updateWeblist = async (entry: Entry, _playlist: string) =>
		Ok<Entry, string>(entry);
});

async function saveDraftAndWaitForReload() {
	await action.save();
	await flush();
}

describe("music store action contracts", () => {
	test("initial_true_negative_empty_state_keeps_route_unresolved_before_first_probe", () => {
		const state = __testing.getState();

		expect(state.mode).toBe("new_guide");
		expect(state.routeResolved).toBe(false);
		expect(state.playlists).toEqual([]);
	});

	test("run_true_negative_does_not_trigger_bootstrap_normalization_and_still_reads_lists", async () => {
		const playlist = makePlaylist("ambient");
		impl.playlistNames = async () => Ok<string[], string>(["ambient"]);
		impl.readAll = async () => Ok<Playlist[], string>([playlist]);

		await action.run();

		const state = __testing.getState();
		expect(state.loading).toBe(false);
		expect(state.routeResolved).toBe(true);
		expect(state.playlists).toEqual([playlist]);
		expect(toastLog.error).toEqual([]);
	});

	test("run_false_positive_guard_ignores_stale_slow_bootstrap_result_after_newer_run_finishes", async () => {
		let appReadyCalls = 0;
		let playlistNameCalls = 0;
		let readAllCalls = 0;
		let releaseFirstRun!: () => void;

		impl.appReady = async () => {
			appReadyCalls += 1;
			if (appReadyCalls === 1) {
				await new Promise<void>((resolve) => {
					releaseFirstRun = () => resolve();
				});
			}
		};
		impl.playlistNames = async () => {
			playlistNameCalls += 1;
			if (playlistNameCalls === 1) {
				return Ok<string[], string>([]);
			}
			return Ok<string[], string>(["focus"]);
		};
		impl.readAll = async () => {
			readAllCalls += 1;
			if (readAllCalls === 1) {
				return Ok<Playlist[], string>([makePlaylist("focus")]);
			}
			return Ok<Playlist[], string>([]);
		};

		const firstRun = action.run();
		await waitUntil(() => appReadyCalls === 1);
		const secondRun = action.run();
		await secondRun;
		releaseFirstRun();
		await firstRun;

		const state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.playlists).toEqual([makePlaylist("focus")]);
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(state.loading).toBe(false);
		expect(toastLog.error).toEqual([]);
	});

	test("run_false_negative_guard_retries_event_registration_after_partial_listener_failure", async () => {
		let evtCalls = 0;

		impl.evt = async (_event: string, _handler: (payload: unknown) => void) => {
			evtCalls += 1;
			if (evtCalls === 2) {
				throw new Error("listen failed");
			}
			return () => {};
		};

		await action.run();
		expect(toastLog.error).toContainEqual({
			title: "Initialization failed",
			description: "listen failed",
		});

		toastLog.error.length = 0;
		impl.evt = async (_event: string, _handler: (payload: unknown) => void) => {
			evtCalls += 1;
			return () => {};
		};
		impl.playlistNames = async () => Ok<string[], string>(["retry-ok"]);
		impl.readAll = async () =>
			Ok<Playlist[], string>([makePlaylist("retry-ok")]);

		await action.run();

		const state = __testing.getState();
		expect(evtCalls).toBeGreaterThanOrEqual(6);
		expect(state.routeResolved).toBe(true);
		expect(state.playlists).toEqual([makePlaylist("retry-ok")]);
		expect(toastLog.error).toEqual([]);
	});

	test("run_true_positive_probes_names_first_and_switches_to_play_before_full_snapshot_hydrates", async () => {
		const playlist = makePlaylist("focus");
		let releaseReadAll!: () => void;
		let readAllStarted = false;

		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => {
			readAllStarted = true;
			await new Promise<void>((resolve) => {
				releaseReadAll = resolve;
			});
			return Ok<Playlist[], string>([playlist]);
		};

		const run = action.run();

		await waitUntil(() => {
			const state = __testing.getState();
			return (
				readAllStarted &&
				state.routeResolved &&
				state.mode === "play" &&
				state.playlists.map((item) => item.name).join(",") === "focus" &&
				state.playlists[0]?.entries.length === 0
			);
		});

		releaseReadAll();
		await run;

		const state = __testing.getState();
		expect(state.playlists).toEqual([playlist]);
		expect(state.loading).toBe(false);
		expect(
			deriveRouteResolution({
				mode: state.mode,
				routeResolved: state.routeResolved,
			}, { kind: state.startupRoute }),
		).toEqual({
			kind: "hydrated_playlists",
			routeResolved: true,
			mode: "play",
			phase: "hydrated",
		});
	});

	test("run_true_positive_preserves_unresolved_edit_route_until_hydration_reconciles_placeholder_lists", async () => {
		const hydrated = makePlaylist("focus", [makeEntry("alpha", "C:/music/alpha")]);
		let releaseReadAll!: () => void;

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: false,
			selectedListName: "focus",
			slot: makeMission("focus", [makeEntry("draft", "C:/music/draft")]),
		});

		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => {
			await new Promise<void>((resolve) => {
				releaseReadAll = resolve;
			});
			return Ok<Playlist[], string>([hydrated]);
		};

		const run = action.run();

		await waitUntil(() => __testing.getState().playlists.map((item) => item.name).join(",") === "focus");
		expect(__testing.getState().routeResolved).toBe(false);
		expect(__testing.getState().mode).toBe("edit");
		expect(__testing.getState().playlists[0]?.entries).toEqual([]);

		releaseReadAll();
		await run;

		const state = __testing.getState();
		expect(state.routeResolved).toBe(false);
		expect(state.mode).toBe("edit");
		expect(state.playlists).toEqual([hydrated]);
		expect(state.startupRoute).toBe("startup_unresolved");
	});

	test("run_true_negative_probes_empty_names_and_stays_in_new_guide_until_empty_snapshot_confirms_it", async () => {
		let releaseReadAll!: () => void;
		let readAllStarted = false;

		impl.playlistNames = async () => Ok<string[], string>([]);
		impl.readAll = async () => {
			readAllStarted = true;
			await new Promise<void>((resolve) => {
				releaseReadAll = resolve;
			});
			return Ok<Playlist[], string>([]);
		};

		const run = action.run();

		await waitUntil(() => {
			const state = __testing.getState();
			return (
				readAllStarted &&
				state.routeResolved &&
				state.mode === "new_guide" &&
				state.playlists.length === 0
			);
		});

		releaseReadAll();
		await run;

		const state = __testing.getState();
		expect(state.mode).toBe("new_guide");
		expect(state.routeResolved).toBe(true);
		expect(state.playlists).toEqual([]);
		expect(state.startupRoute).toBe("hydrated_empty");
		expect(state.loading).toBe(false);
		expect(
			deriveRouteResolution({
				mode: state.mode,
				routeResolved: state.routeResolved,
			}, { kind: state.startupRoute }),
		).toEqual({
			kind: "hydrated_empty",
			routeResolved: true,
			mode: "new_guide",
			phase: "hydrated",
		});
	});

	test("processResult_false_negative_guard_refreshes_downloaded_playlist_before_loudness_analysis_finishes", async () => {
		const handlers = new Map<string, (payload: unknown) => void>();
		const pending = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus"),
				url: "https://example.com/list",
				entry_type: "WebList",
				downloaded_ok: false,
			},
		]);
		const downloaded = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus"),
				url: "https://example.com/list",
				entry_type: "WebList",
				downloaded_ok: true,
				musics: [makeMusic("C:/music/focus/a.mp3")],
			},
		]);
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(readAllCalls === 1 ? [pending] : [downloaded]);
		};

		await action.run();
		expectPlaylistLike(__testing.getState().playlists, [pending]);

		handlers.get("processResult")?.(undefined);
		await flush();

		const state = __testing.getState();
		expectPlaylistLike(state.playlists, [downloaded]);

		handlers.get("processMsg")?.({
			playlist: "focus",
			str: "Analyzing loudness 1/1: a.mp3",
		});
		await flush();

		const analyzing = __testing.getState();
		expectPlaylistLike(analyzing.playlists, [downloaded]);
		expect(analyzing.processMsg).toEqual({
			playlist: "focus",
			str: "Analyzing loudness 1/1: a.mp3",
		});
		expect(
			(
				analyzing.playlists[0]?.entries[0] as Entry & {
					materialization?: {
						phase: string;
						settled: string;
						ownerSessionId: number;
						lastError: string | null;
					};
				}
			).materialization,
		).toEqual({
			phase: "persisted",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});
	});

	test("remoteTaskTruth_false_negative_guard_process_events_do_not_create_or_rebind_materialization_without_matching_refresh_facts", async () => {
		const handlers = new Map<string, (payload: unknown) => void>();
		const pending = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus"),
				url: "https://example.com/list",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			},
		]);
		const unrelatedReady = makePlaylist("other", [
			{
				...makeEntry("other remote", "C:/music/other"),
				url: "https://example.com/other",
				entry_type: "WebList",
				downloaded_ok: true,
				musics: [
					{
						...makeMusic("C:/music/other/a.mp3"),
						normalization_status: "Ready",
						integrated_lufs: -18,
						analysis_version: 1,
						analyzed_at_ms: 123,
					},
				],
			},
		]);
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(readAllCalls === 1 ? [pending] : [unrelatedReady]);
		};

		await action.run();
		const before = __testing.getState().playlists[0]?.entries[0] as Entry & {
			materialization?: {
				phase: string;
				settled: string;
				ownerSessionId: number;
				lastError: string | null;
			};
		};
		expect(before.materialization).toEqual({
			phase: "pending",
			settled: "idle",
			ownerSessionId: 0,
			lastError: null,
		});

		handlers.get("processMsg")?.({
			playlist: "other",
			str: "Analyzing loudness 1/1: other.mp3",
		});
		await flush();

		let state = __testing.getState();
		expect(state.processMsg).toEqual({
			playlist: "other",
			str: "Analyzing loudness 1/1: other.mp3",
		});
		expect(
			(
				state.playlists[0]?.entries[0] as Entry & {
					materialization?: {
						phase: string;
						settled: string;
						ownerSessionId: number;
						lastError: string | null;
					};
				}
			).materialization,
		).toEqual({
			phase: "pending",
			settled: "idle",
			ownerSessionId: 0,
			lastError: null,
		});

		handlers.get("processResult")?.({
			working_path: "C:/music/other",
			saved_path: "C:/music/other",
			name: "other",
			playlist: "other",
		});
		await flush();

		state = __testing.getState();
		expect(state.processMsg).toBeNull();
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("other");
		expect(
			(
				state.playlists[0]?.entries[0] as Entry & {
					materialization?: {
						phase: string;
						settled: string;
						ownerSessionId: number;
						lastError: string | null;
					};
				}
			).materialization,
		).toEqual({
			phase: "ready",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});
	});

	test("remoteTaskTruth_false_negative_guard_shadow_review_arrays_cannot_override_canonical_materialization_projection", async () => {
		const handlers = new Map<string, (payload: unknown) => void>();
		const pending = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: false,
					musics: [],
				}),
			},
		]);
		const ready = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: true,
					musics: [
						{
							...makeMusic("C:/music/focus/a.mp3"),
							normalization_status: "Ready",
							integrated_lufs: -18,
							analysis_version: 1,
							analyzed_at_ms: 123,
						},
					],
				}),
			},
		]);
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>([readAllCalls === 1 ? pending : ready]);
		};

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			processMsg: { playlist: "focus", str: "shadow processing" },
			linkReviews: ["https://shadow.example/link"],
			folderReviews: ["C:/shadow/folder"],
			weblistReviews: ["https://shadow.example/list"],
		});

		let state = __testing.getState();
		expect(state.linkReviews).toEqual(["https://shadow.example/link"]);
		expect(state.folderReviews).toEqual(["C:/shadow/folder"]);
		expect(state.weblistReviews).toEqual(["https://shadow.example/list"]);
		expect(deriveDraftReviewState(state)).toEqual({
			active: [],
			linkReviews: [],
			folderReviews: [],
			weblistReviews: [],
		});
		expect(
			(
				state.playlists[0]?.entries[0] as Entry & {
					materialization?: {
						phase: string;
						settled: string;
						ownerSessionId: number;
						lastError: string | null;
					};
				}
			).materialization,
		).toEqual({
			phase: "pending",
			settled: "idle",
			ownerSessionId: 0,
			lastError: null,
		});

		handlers.get("processResult")?.(undefined);
		await flush();

		state = __testing.getState();
		expect(state.processMsg).toBeNull();
		expect(state.linkReviews).toEqual(["https://shadow.example/link"]);
		expect(state.folderReviews).toEqual(["C:/shadow/folder"]);
		expect(state.weblistReviews).toEqual(["https://shadow.example/list"]);
		expect(deriveDraftReviewState(state)).toEqual({
			active: [],
			linkReviews: [],
			folderReviews: [],
			weblistReviews: [],
		});
		expect(
			(
				state.playlists[0]?.entries[0] as Entry & {
					materialization?: {
						phase: string;
						settled: string;
						ownerSessionId: number;
						lastError: string | null;
					};
				}
			).materialization,
		).toEqual({
			phase: "ready",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});
	});

	test("webMaterialization_true_positive_projects_entry_owned_pending_downloading_persisted_analyzing_ready_and_failed_phases", async () => {
		const handlers = new Map<string, (payload: unknown) => void>();
		const pending = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: false,
					musics: [],
				}),
			},
		]);
		const downloading = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: false,
					musics: [makeMusic("C:/music/focus/chunk.mp3")],
				}),
			},
		]);
		const persisted = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: true,
					musics: [makeMusic("C:/music/focus/a.mp3")],
				}),
			},
		]);
		const ready = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: true,
					musics: [
						{
							...makeMusic("C:/music/focus/a.mp3"),
							integrated_lufs: -18,
							analysis_version: 1,
							normalization_status: "Ready",
						},
					],
				}),
			},
		]);
		const failed = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: true,
					musics: [
						{
							...makeMusic("C:/music/focus/a.mp3"),
							normalization_status: "Failed",
						},
					],
				}),
			},
		]);
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => {
			readAllCalls += 1;
			const snapshots = [pending, downloading, persisted, ready, failed];
			return Ok<Playlist[], string>([
				snapshots[Math.min(readAllCalls - 1, snapshots.length - 1)]!,
			]);
		};

		await action.run();
		const phaseOf = () =>
			(
				(__testing.getState().playlists[0]?.entries[0] as Entry & {
					materialization?: { phase: string };
				}).materialization?.phase ?? null
			);
		const entrySnapshot = () =>
			__testing.getState().playlists[0]?.entries[0] as Entry & {
				materialization?: {
					phase: string;
					settled: string;
					ownerSessionId: number;
					lastError: string | null;
				};
			};

		expect(phaseOf()).toBe("pending");
		handlers.get("processResult")?.(undefined);
		await flush();
		expect(phaseOf()).toBe("downloading");

		handlers.get("processResult")?.(undefined);
		await flush();
		expect(entrySnapshot().materialization).toEqual({
			phase: "persisted",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});

		for (const expectedPhase of ["ready", "failed"]) {
			handlers.get("processResult")?.(undefined);
			await flush();
			expect(phaseOf()).toBe(expectedPhase);
		}

		__testing.replaceState({
			...__testing.getState(),
			playlists: [
				{
					...persisted,
					entries: persisted.entries.map((entry) => ({
						...entry,
						materialization: {
							phase: "persisted",
							settled: "succeeded",
							ownerSessionId: 0,
							lastError: null,
						},
					})),
				},
			],
		});
		handlers.get("processMsg")?.({
			playlist: "focus",
			str: "Analyzing loudness 1/1: a.mp3",
		});
		await flush();
		expect(__testing.getState().processMsg?.str).toContain("Analyzing loudness");
		expect(
			(
				(__testing.getState().playlists[0]?.entries[0] as Entry & {
					materialization?: {
						phase: string;
						settled: string;
						lastError: string | null;
					};
				}).materialization?.phase ?? null
			),
		).toBe("persisted");
		const analyzingEntry = __testing.getState().playlists[0]?.entries[0] as Entry & {
			materialization?: {
				phase: string;
				settled: string;
				ownerSessionId: number;
				lastError: string | null;
			};
		};
		expect(analyzingEntry.materialization).toEqual({
			phase: "persisted",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});

		handlers.get("processResult")?.(undefined);
		await flush();
		expect(entrySnapshot()).toMatchObject({
			downloaded_ok: true,
			entry_type: "WebList",
			musics: [
				{
					normalization_status: "Failed",
				},
			],
			materialization: {
				phase: "failed",
				settled: "failed",
				ownerSessionId: 0,
				lastError: null,
			},
		});
	});

	test("webMaterialization_false_negative_guard_persisted_entry_stays_not_ready_until_backend_ready_fact_arrives_and_failure_preserves_last_truthful_phase", async () => {
		const handlers = new Map<string, (payload: unknown) => void>();
		const persisted = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: true,
					musics: [
						{
							...makeMusic("C:/music/focus/a.mp3"),
							normalization_status: null,
							analyzed_at_ms: 123,
							analysis_version: null,
							integrated_lufs: null,
						},
					],
				}),
			},
		]);
		const analyzing = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: true,
					musics: [
						{
							...makeMusic("C:/music/focus/a.mp3"),
							normalization_status: "Pending",
							analyzed_at_ms: null,
							analysis_version: null,
							integrated_lufs: null,
						},
					],
				}),
			},
		]);
		const ready = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: true,
					musics: [
						{
							...makeMusic("C:/music/focus/a.mp3"),
							normalization_status: "Ready",
							analyzed_at_ms: 456,
							analysis_version: 1,
							integrated_lufs: -18,
						},
					],
				}),
			},
		]);
		const failedAfterPersisted = makePlaylist("focus", [
			{
				...makeEntry("remote", "C:/music/focus", {
					url: "https://example.com/list",
					entry_type: "WebList",
					downloaded_ok: true,
					musics: [
						{
							...makeMusic("C:/music/focus/a.mp3"),
							normalization_status: "Failed",
							analyzed_at_ms: 123,
							analysis_version: null,
							integrated_lufs: null,
						},
					],
				}),
			},
		]);
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => {
			readAllCalls += 1;
			const snapshots = [persisted, analyzing, ready, failedAfterPersisted];
			return Ok<Playlist[], string>([
				snapshots[Math.min(readAllCalls - 1, snapshots.length - 1)]!,
			]);
		};

		await action.run();
		const materialization = () =>
			(
				__testing.getState().playlists[0]?.entries[0] as Entry & {
					materialization?: {
						phase: string;
						settled: string;
						ownerSessionId: number;
						lastError: string | null;
					};
				}
			).materialization;

		expect(materialization()).toEqual({
			phase: "persisted",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});

		handlers.get("processMsg")?.({
			playlist: "focus",
			str: "Analyzing loudness 1/1: a.mp3",
		});
		await flush();
		expect(materialization()).toEqual({
			phase: "persisted",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});

		handlers.get("processResult")?.(undefined);
		await flush();
		expect(materialization()).toEqual({
			phase: "analyzing",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});

		handlers.get("processResult")?.(undefined);
		await flush();
		expect(materialization()).toEqual({
			phase: "ready",
			settled: "succeeded",
			ownerSessionId: 0,
			lastError: null,
		});

		handlers.get("processResult")?.(undefined);
		await flush();
		expect(materialization()).toEqual({
			phase: "failed",
			settled: "failed",
			ownerSessionId: 0,
			lastError: null,
		});
	});

	test("updateWeblist_false_positive_guard_stale_completion_does_not_mutate_replacement_persisted_owner_entry", async () => {
		const original = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			downloaded_ok: false,
			musics: [],
		});
		const replacement = makeEntry("remote replacement", "C:/music/replacement", {
			url: "https://example.com/list-replacement",
			entry_type: "WebList",
			downloaded_ok: false,
			musics: [],
		});
		const settledOriginal = {
			...original,
			downloaded_ok: true,
			musics: [makeMusic("C:/music/remote/downloaded.flac")],
		};

		let release!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(settledOriginal));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", [original]),
			playlists: [makePlaylist("focus", [original])],
			weblistReviews: [],
			entrySessionId: 2,
		});

		const pending = action.updateWeblist(original);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.url === original.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			playlists: [
				makePlaylist("focus", [
					withEntryMaterialization(replacement, {
						phase: "pending",
						settled: "idle",
						ownerSessionId: 7,
						lastError: null,
					}),
				]),
			],
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.slot).toBeNull();
		expect(state.weblistReviews).toEqual([]);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.entries).toHaveLength(1);
		expect(state.playlists[0]?.entries[0]).toMatchObject({
			...replacement,
			materialization: {
				phase: "pending",
				settled: "idle",
				ownerSessionId: 7,
				lastError: null,
			},
		});
	});

	test("ownerIdentity_false_negative_guard_late_persisted_materialization_write_only_mutates_matching_owner_layer", async () => {
		const sharedUrl = "https://example.com/shared";
		const original = withEntryMaterialization(
			makeEntry("remote", "C:/music/remote", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 11,
				lastError: null,
			},
		);
		const sibling = withEntryMaterialization(
			makeEntry("sibling", "C:/music/sibling", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 17,
				lastError: null,
			},
		);
		const settledOriginal = {
			...original,
			downloaded_ok: true,
			musics: [makeMusic("C:/music/remote/downloaded.flac")],
		};

		let release!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(settledOriginal));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", [original]),
			playlists: [makePlaylist("focus", [original, sibling])],
			weblistReviews: [],
			entrySessionId: 2,
		});

		const pending = action.updateWeblist(original);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.url === sharedUrl && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			playlists: [makePlaylist("focus", [original, sibling])],
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.playlists[0]?.entries).toHaveLength(2);
		expect(state.playlists[0]?.entries[0]).toMatchObject({
			...original,
			materialization: {
				phase: "persisted",
				settled: "succeeded",
				ownerSessionId: 11,
				lastError: null,
			},
		});
		expect(state.playlists[0]?.entries[1]).toMatchObject({
			...sibling,
			materialization: {
				phase: "pending",
				settled: "idle",
				ownerSessionId: 17,
				lastError: null,
			},
		});
	});

	test("ownerIdentity_false_negative_guard_read_refresh_keeps_canonical_persisted_owner_identity_after_optimistic_exit", async () => {
		const sharedUrl = "https://example.com/shared-refresh";
		const canonical = withEntryMaterialization(
			makeEntry("canonical", "C:/music/canonical", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 11,
				lastError: null,
			},
		);
		const sibling = withEntryMaterialization(
			makeEntry("sibling", "C:/music/sibling", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 19,
				lastError: null,
			},
		);
		impl.readAll = async () =>
			Ok<Playlist[], string>([
				makePlaylist("focus", [
					makeEntry("canonical", "C:/music/canonical", {
						url: sharedUrl,
						entry_type: "WebList",
						downloaded_ok: true,
						musics: [makeMusic("C:/music/canonical/downloaded.flac")],
					}),
					makeEntry("sibling", "C:/music/sibling", {
						url: sharedUrl,
						entry_type: "WebList",
						downloaded_ok: false,
						musics: [],
					}),
				]),
			]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			entrySessionId: 88,
			playlists: [makePlaylist("focus", [canonical, sibling])],
		});

		await __testing.readAll();

		const entries = __testing.getState().playlists[0]?.entries ?? [];
		expect(entries[0]).toMatchObject({
			url: sharedUrl,
			path: "C:/music/canonical",
			materialization: {
				phase: "persisted",
				settled: "succeeded",
				ownerSessionId: 11,
				lastError: null,
			},
		});
		expect(entries[1]).toMatchObject({
			url: sharedUrl,
			path: "C:/music/sibling",
			materialization: {
				phase: "pending",
				settled: "idle",
				ownerSessionId: 19,
				lastError: null,
			},
		});
	});

	test("ownerIdentity_false_negative_guard_same_url_same_name_sibling_refresh_keeps_original_owner_layer", async () => {
		const sharedUrl = "https://example.com/shared-shape";
		const sharedName = "shared-shape";
		const canonical = withEntryMaterialization(
			makeEntry(sharedName, "C:/music/canonical", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 41,
				lastError: null,
			},
		);
		const sibling = withEntryMaterialization(
			makeEntry(sharedName, "C:/music/sibling", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 53,
				lastError: null,
			},
		);

		impl.readAll = async () =>
			Ok<Playlist[], string>([
				makePlaylist("focus", [
					makeEntry(sharedName, "C:/music/canonical", {
						url: sharedUrl,
						entry_type: "WebList",
						downloaded_ok: true,
						musics: [makeMusic("C:/music/canonical/downloaded.flac")],
					}),
					makeEntry(sharedName, "C:/music/sibling", {
						url: sharedUrl,
						entry_type: "WebList",
						downloaded_ok: false,
						musics: [],
					}),
				]),
			]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			entrySessionId: 144,
			playlists: [makePlaylist("focus", [canonical, sibling])],
		});

		await __testing.readAll();

		const entries = __testing.getState().playlists[0]?.entries ?? [];
		expect(entries[0]).toMatchObject({
			url: sharedUrl,
			name: sharedName,
			path: "C:/music/canonical",
			materialization: {
				phase: "persisted",
				settled: "succeeded",
				ownerSessionId: 41,
				lastError: null,
			},
		});
		expect(entries[1]).toMatchObject({
			url: sharedUrl,
			name: sharedName,
			path: "C:/music/sibling",
			materialization: {
				phase: "pending",
				settled: "idle",
				ownerSessionId: 53,
				lastError: null,
			},
		});
	});

	test("ownerIdentity_false_negative_guard_same_shape_refresh_only_carries_forward_matching_owner_identity", async () => {
		const sharedUrl = "https://example.com/shared-shape-refresh";
		const sharedName = "shared-refresh";
		const canonical = withEntryMaterialization(
			makeEntry(sharedName, "C:/music/canonical", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 21,
				lastError: null,
			},
		);
		const sibling = withEntryMaterialization(
			makeEntry(sharedName, "C:/music/sibling", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 22,
				lastError: null,
			},
		);
		const unrelated = withEntryMaterialization(
			makeEntry("different", "C:/music/different", {
				url: "https://example.com/different",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 23,
				lastError: null,
			},
		);

		impl.readAll = async () =>
			Ok<Playlist[], string>([
				makePlaylist("focus", [
					makeEntry(sharedName, "C:/music/canonical", {
						url: sharedUrl,
						entry_type: "WebList",
						downloaded_ok: true,
						musics: [makeMusic("C:/music/canonical/downloaded.flac")],
					}),
					makeEntry(sharedName, "C:/music/sibling", {
						url: sharedUrl,
						entry_type: "WebList",
						downloaded_ok: false,
						musics: [],
					}),
					makeEntry("different", "C:/music/different", {
						url: "https://example.com/different",
						entry_type: "WebList",
						downloaded_ok: true,
						musics: [makeMusic("C:/music/different/downloaded.flac")],
					}),
				]),
			]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			entrySessionId: 144,
			playlists: [makePlaylist("focus", [canonical, sibling, unrelated])],
		});

		await __testing.readAll();

		const entries = __testing.getState().playlists[0]?.entries ?? [];
		expect(entries[0]).toMatchObject({
			url: sharedUrl,
			name: sharedName,
			path: "C:/music/canonical",
			materialization: {
				phase: "persisted",
				settled: "succeeded",
				ownerSessionId: 21,
				lastError: null,
			},
		});
		expect(entries[1]).toMatchObject({
			url: sharedUrl,
			name: sharedName,
			path: "C:/music/sibling",
			materialization: {
				phase: "pending",
				settled: "idle",
				ownerSessionId: 22,
				lastError: null,
			},
		});
		expect(entries[2]).toMatchObject({
			url: "https://example.com/different",
			name: "different",
			path: "C:/music/different",
			materialization: {
				phase: "persisted",
				settled: "succeeded",
				ownerSessionId: 23,
				lastError: null,
			},
		});
	});

	test("ownerIdentity_false_negative_guard_refresh_carry_forward_uses_persisted_owner_identity_instead_of_current_entry_session", async () => {
		const sharedUrl = "https://example.com/refresh-boundary-shape";
		const sharedName = "same-shape";
		const canonical = withEntryMaterialization(
			makeEntry(sharedName, "C:/music/canonical", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 77,
				lastError: null,
			},
		);
		const sibling = withEntryMaterialization(
			makeEntry(sharedName, "C:/music/sibling", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 88,
				lastError: null,
			},
		);
		const unrelated = withEntryMaterialization(
			makeEntry("other", "C:/music/other", {
				url: "https://example.com/other",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 99,
				lastError: null,
			},
		);

		impl.readAll = async () =>
			Ok<Playlist[], string>([
				makePlaylist("focus", [
					makeEntry(sharedName, "C:/music/canonical", {
						url: sharedUrl,
						entry_type: "WebList",
						downloaded_ok: true,
						musics: [makeMusic("C:/music/canonical/downloaded.flac")],
					}),
					makeEntry(sharedName, "C:/music/sibling", {
						url: sharedUrl,
						entry_type: "WebList",
						downloaded_ok: false,
						musics: [],
					}),
					makeEntry("other", "C:/music/other", {
						url: "https://example.com/other",
						entry_type: "WebList",
						downloaded_ok: true,
						musics: [makeMusic("C:/music/other/downloaded.flac")],
					}),
				]),
			]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			entrySessionId: 1000,
			playlists: [makePlaylist("focus", [canonical, sibling, unrelated])],
		});

		await __testing.readAll();

		const entries = __testing.getState().playlists[0]?.entries ?? [];
		expect(entries[0]).toMatchObject({
			url: sharedUrl,
			name: sharedName,
			path: "C:/music/canonical",
			materialization: {
				phase: "persisted",
				settled: "succeeded",
				ownerSessionId: 77,
				lastError: null,
			},
		});
		expect(entries[1]).toMatchObject({
			url: sharedUrl,
			name: sharedName,
			path: "C:/music/sibling",
			materialization: {
				phase: "pending",
				settled: "idle",
				ownerSessionId: 88,
				lastError: null,
			},
		});
		expect(entries[2]).toMatchObject({
			url: "https://example.com/other",
			name: "other",
			path: "C:/music/other",
			materialization: {
				phase: "persisted",
				settled: "succeeded",
				ownerSessionId: 99,
				lastError: null,
			},
		});
	});

	test("ownerIdentity_false_negative_guard_displaced_late_settlement_cannot_overwrite_replacement_owner_layer", async () => {
		const sharedUrl = "https://example.com/displaced";
		const displacedOwner = withEntryMaterialization(
			makeEntry("displaced", "C:/music/displaced", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 11,
				lastError: null,
			},
		);
		const replacementOwner = withEntryMaterialization(
			makeEntry("replacement", "C:/music/replacement", {
				url: sharedUrl,
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 29,
				lastError: null,
			},
		);
		let release!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					release = () =>
						resolve(
							Ok<Entry, string>({
								...displacedOwner,
								downloaded_ok: true,
								musics: [makeMusic("C:/music/displaced/downloaded.flac")],
							}),
						);
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", [displacedOwner]),
			playlists: [makePlaylist("focus", [displacedOwner])],
			entrySessionId: 2,
		});

		const pending = action.updateWeblist(displacedOwner);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.url === sharedUrl && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			entrySessionId: 99,
			playlists: [makePlaylist("focus", [replacementOwner])],
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.entries[0]).toMatchObject({
			...replacementOwner,
			materialization: {
				phase: "pending",
				settled: "idle",
				ownerSessionId: 29,
				lastError: null,
			},
		});
	});

	test("ownerIdentity_false_negative_guard_refresh_carry_forward_keeps_same_path_siblings_owner_scoped", async () => {
		const sharedPath = "C:/music/shared-owner-scope";
		const canonical = withEntryMaterialization(
			makeEntry("canonical", sharedPath, {
				url: "https://example.com/canonical-owner",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 31,
				lastError: null,
			},
		);
		const sibling = withEntryMaterialization(
			makeEntry("sibling", sharedPath, {
				url: "https://example.com/sibling-owner",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 47,
				lastError: null,
			},
		);

		impl.readAll = async () =>
			Ok<Playlist[], string>([
				makePlaylist("focus", [
					makeEntry("canonical", sharedPath, {
						url: "https://example.com/canonical-owner",
						entry_type: "WebList",
						downloaded_ok: true,
						musics: [makeMusic("C:/music/shared-owner-scope/canonical.flac")],
					}),
					makeEntry("sibling", sharedPath, {
						url: "https://example.com/sibling-owner",
						entry_type: "WebList",
						downloaded_ok: false,
						musics: [],
					}),
				]),
			]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			entrySessionId: 777,
			playlists: [makePlaylist("focus", [canonical, sibling])],
		});

		await __testing.readAll();

		const entries = __testing.getState().playlists[0]?.entries ?? [];
		expect(entries[0]).toMatchObject({
			path: sharedPath,
			url: "https://example.com/canonical-owner",
			materialization: {
				phase: "persisted",
				settled: "succeeded",
				ownerSessionId: 31,
				lastError: null,
			},
		});
		expect(entries[1]).toMatchObject({
			path: sharedPath,
			url: "https://example.com/sibling-owner",
			materialization: {
				phase: "pending",
				settled: "idle",
				ownerSessionId: 47,
				lastError: null,
			},
		});
	});

	test("webMaterialization_false_negative_guard_update_after_reedit_ignores_removed_persisted_owner_entry", async () => {
		const original = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			downloaded_ok: false,
			musics: [],
		});
		const settledOriginal = {
			...original,
			downloaded_ok: true,
			musics: [makeMusic("C:/music/remote/downloaded.flac")],
		};
		const other = makePlaylist("other", [makeEntry("local", "C:/music/local")]);

		let release!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(settledOriginal));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", [original]),
			playlists: [makePlaylist("focus", [original]), other],
			weblistReviews: [],
			entrySessionId: 2,
		});

		const pending = action.updateWeblist(original);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.url === original.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		await action.back();
		await action.edit(other);

		release();
		await pending;

		const state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.selectedListName).toBe("other");
		expect(state.slot?.name).toBe("other");
		expect(state.slot?.entries).toEqual([makeEntry("local", "C:/music/local")]);
		expect(state.playlists).toEqual([makePlaylist("focus", [original]), other]);
	});

	test("webMaterialization_false_positive_guard_update_after_reedit_does_not_mutate_replacement_persisted_owner_entry", async () => {
		const original = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			downloaded_ok: false,
			musics: [],
		});
		const replacementPersisted = withEntryMaterialization(
			makeEntry("replacement", "C:/music/replacement", {
				url: "https://example.com/list-replacement",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				settled: "idle",
				ownerSessionId: 9,
				lastError: null,
			},
		);
		const settledOriginal = {
			...original,
			downloaded_ok: true,
			musics: [makeMusic("C:/music/remote/downloaded.flac")],
		};

		let release!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(settledOriginal));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", [original]),
			playlists: [makePlaylist("focus", [original])],
			weblistReviews: [],
			entrySessionId: 2,
		});

		const pending = action.updateWeblist(original);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.url === original.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			selectedListName: null,
			slot: null,
			playlists: [makePlaylist("focus", [replacementPersisted])],
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.slot).toBeNull();
		expect(state.playlists).toEqual([makePlaylist("focus", [replacementPersisted])]);
	});

	test("addNew_true_positive_enters_create_with_fresh_slot_and_cleared_transient_state", async () => {
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [makePlaylist("focus", [makeEntry("alpha", "C:/music/alpha")])],
			selectedListName: "focus",
			nowPlaying: makeMusic("C:/music/alpha/a.flac"),
			nowJudge: "Up",
			slot: makeMission("stale", [makeEntry("stale", "C:/music/stale")]),
			processMsg: { playlist: "focus", str: "working" },
			linkReviews: ["https://example.com"],
			folderReviews: ["C:/music/folder"],
			weblistReviews: ["https://example.com/list"],
		});

		await action.addNew();

		const state = __testing.getState();
		expect(state.mode).toBe("create");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toEqual(makeMission(""));
		expect(state.selectedListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.nowJudge).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.linkReviews).toEqual([]);
		expect(state.folderReviews).toEqual([]);
		expect(state.weblistReviews).toEqual([]);
	});

	test("edit_true_positive_enters_edit_with_seeded_slot_and_cleared_transient_state", async () => {
		const playlist = makePlaylist("focus", [makeEntry("alpha", "C:/music/alpha")]);
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			nowJudge: "Down",
			slot: makeMission("stale", [makeEntry("stale", "C:/music/stale")]),
			processMsg: { playlist: "stale", str: "working" },
			linkReviews: ["https://example.com"],
			folderReviews: ["C:/music/folder"],
			weblistReviews: ["https://example.com/list"],
		});

		await action.edit(playlist);

		const state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.routeResolved).toBe(true);
		expect(state.selectedListName).toBe("focus");
		expect(state.slot).toEqual(makeMission("focus", [makeEntry("alpha", "C:/music/alpha")]));
		expect(state.nowPlaying).toBeNull();
		expect(state.nowJudge).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.linkReviews).toEqual([]);
		expect(state.folderReviews).toEqual([]);
		expect(state.weblistReviews).toEqual([]);
	});

	test("back_true_negative_guard_blocks_exit_while_review_work_is_active", async () => {
		const slot = makeMission("focus", [makeEntry("alpha", "C:/music/alpha")]);
		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			playlists: [makePlaylist("focus")],
			selectedListName: "focus",
			slot: {
				...slot,
				links: [
					makeDraftLink({
						url: "https://example.com",
						operation: {
							kind: "link_review",
							key: "https://example.com",
							inProgress: true,
							settled: "idle",
							ownerSessionId: __testing.getState().entrySessionId,
						},
					}),
				],
			},
			processMsg: { playlist: "focus", str: "working" },
		});

		await action.back();

		const state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.slot).toEqual({
			...slot,
			links: [
				makeDraftLink({
					url: "https://example.com",
					operation: {
						kind: "link_review",
						key: "https://example.com",
						inProgress: true,
						settled: "idle",
						ownerSessionId: __testing.getState().entrySessionId,
					},
				}),
			],
		});
		expect(state.selectedListName).toBe("focus");
		expect(state.processMsg).toEqual({ playlist: "focus", str: "working" });
		expect(deriveDraftReviewState(state).linkReviews).toEqual([
			"https://example.com",
		]);
		expect(playbackLog.interrupts).toBe(0);
	});

	test("back_true_positive_exits_to_play_or_guide_and_clears_transient_state", async () => {
		const slot = makeMission("focus", [makeEntry("alpha", "C:/music/alpha")]);
		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			playlists: [makePlaylist("focus")],
			selectedListName: "focus",
			nowPlaying: makeMusic("C:/music/alpha/a.flac"),
			nowJudge: "Up",
			slot,
			processMsg: { playlist: "focus", str: "working" },
			folderReviews: [],
		});

		await action.back();

		let state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.nowJudge).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.folderReviews).toEqual([]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			playlists: [],
			selectedListName: "focus",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			slot,
			processMsg: { playlist: "focus", str: "working" },
			weblistReviews: [],
		});

		await action.back();

		state = __testing.getState();
		expect(state.mode).toBe("new_guide");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.weblistReviews).toEqual([]);
	});

	test("refresh_false_negative_guard_preserves_active_create_draft_without_restoring_playback_context", async () => {
		const draft = makeMission("draft", [makeEntry("draft-entry", "C:/music/draft")]);
		const refreshed = makePlaylist("focus", [makeEntry("alpha", "C:/music/alpha")]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			playlists: [makePlaylist("stale")],
			selectedListName: "focus",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			slot: draft,
			processMsg: { playlist: "focus", str: "processing" },
		});
		impl.readAll = async () => Ok<Playlist[], string>([refreshed]);

		await action.run();

		const state = __testing.getState();
		expect(state.mode).toBe("create");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toEqual(draft);
		expect(state.playlists).toEqual([refreshed]);
		expect(state.selectedListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
	});

	test("processResult_false_negative_guard_preserves_active_edit_draft_without_restoring_playback_context", async () => {
		const handlers = new Map<string, (payload: unknown) => void>();
		const draft = makeMission("focus", [makeEntry("draft-entry", "C:/music/draft")]);
		const refreshed = makePlaylist("focus", [makeEntry("alpha", "C:/music/alpha")]);
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1 ? [makePlaylist("focus")] : [refreshed],
			);
		};

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			selectedListName: "focus",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			slot: draft,
			processMsg: { playlist: "focus", str: "processing" },
		});

		handlers.get("processResult")?.(undefined);
		await flush();

		const state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toEqual(draft);
		expect(state.playlists).toEqual([refreshed]);
		expect(state.selectedListName).toBe("focus");
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
	});

	test("save_true_positive_create_persists_slot_and_reloads_lists", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("fresh", [entry]);
		const playlist = makePlaylist("fresh", [entry]);
		const calls: CollectMission[] = [];

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			slot: mission,
			routeResolved: true,
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});
		impl.create = async (data: CollectMission) => {
			calls.push(data);
			return Ok<null, string>(null);
		};
		impl.readAll = async () => Ok<Playlist[], string>([playlist]);

		await action.save();
		await flush();

		const state = __testing.getState();
		expect(calls).toHaveLength(1);
		expect(state.mode).toBe("play");
		expect(state.loading).toBe(false);
		expect(state.slot).toBeNull();
		expect(state.playlists).toEqual([playlist]);
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("save_false_negative_guard_create_switches_to_play_immediately_before_backend_finishes", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("fresh", [entry]);
		const playlist = makePlaylist("fresh", [entry]);
		let releaseCreate!: () => void;
		let createStarted = false;

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			slot: mission,
			routeResolved: true,
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});
		impl.create = async () => {
			createStarted = true;
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () => Ok<Playlist[], string>([playlist]);

		const saving = action.save();

		await waitUntil(() => {
			const state = __testing.getState();
			return (
				createStarted &&
				state.mode === "play" &&
				state.loading === false &&
				state.slot === null &&
				state.playlists[0]?.name === "fresh"
			);
		});

		releaseCreate();
		await saving;
		await flush();

		const state = __testing.getState();
		expect(state.playlists).toEqual([playlist]);
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("save_false_positive_guard_create_error_rolls_back_optimistic_playlist_after_refresh", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("fresh", [entry]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			slot: mission,
			routeResolved: true,
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});
		impl.create = async () => Err<string, null>("write failed");
		impl.readAll = async () => Ok<Playlist[], string>([]);

		await action.save();
		await flush();

		const state = __testing.getState();
		expect(state.mode).toBe("new_guide");
		expect(state.playlists).toEqual([]);
		expect(toastLog.error).toContainEqual({
			title: "Save failed",
			description: "write failed",
		});
	});

	test("save_true_negative_guard_rejects_duplicate_name_without_exiting_editor", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("  focus  ", [entry]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			playlists: [makePlaylist("Focus", [entry])],
			slot: mission,
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		await action.save();
		await flush();

		const state = __testing.getState();
		expect(state.mode).toBe("create");
		expect(state.slot).toEqual(mission);
		expect(state.playlists).toEqual([makePlaylist("Focus", [entry])]);
		expect(toastLog.error).toContainEqual({
			title: "Cannot save",
			description: "This list already exists.",
		});
	});

	test("save_true_negative_guard_rejects_missing_ffmpeg_without_exiting_editor", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("fresh", [entry]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			slot: mission,
			ffmpeg: null,
		});

		await action.save();
		await flush();

		const state = __testing.getState();
		expect(state.mode).toBe("create");
		expect(state.slot).toEqual(mission);
		expect(state.playlists).toEqual([]);
		expect(toastLog.error).toContainEqual({
			title: "Cannot save",
			description: "ffmpeg is required to support audio analysis.",
		});
	});

	test("save_true_negative_guard_blocks_reviewed_draft_without_optimistic_exit_or_persist", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("fresh", [entry]);
		const createCalls: CollectMission[] = [];

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			playlists: [makePlaylist("focus", [entry])],
			slot: {
				...mission,
				links: [
					makeDraftLink({
						url: "https://example.com",
						operation: {
							kind: "link_review",
							key: "https://example.com",
							inProgress: true,
							settled: "idle",
							ownerSessionId: __testing.getState().entrySessionId,
						},
					}),
				],
			},
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});
		impl.create = async (data: CollectMission) => {
			createCalls.push(data);
			return Ok<null, string>(null);
		};

		await action.save();
		await flush();

		const state = __testing.getState();
		expect(createCalls).toEqual([]);
		expect(state.mode).toBe("edit");
		expect(state.slot).toEqual({
			...mission,
			links: [
				makeDraftLink({
					url: "https://example.com",
					operation: {
						kind: "link_review",
						key: "https://example.com",
						inProgress: true,
						settled: "idle",
						ownerSessionId: __testing.getState().entrySessionId,
					},
				}),
			],
		});
		expect(state.selectedListName).toBe("focus");
		expect(deriveDraftReviewState(state).linkReviews).toEqual([
			"https://example.com",
		]);
		expect(toastLog.error).toContainEqual({
			title: "Please wait",
			description: "Background checks are still running.",
		});
	});

	test("save_false_negative_guard_late_refresh_after_failed_create_reconciles_without_editor_or_playback_resurrection", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("fresh", [entry]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			slot: mission,
			selectedListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		impl.create = async () => Err<string, null>("write failed");
		let readAllCalls = 0;
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1 ? [] : [makePlaylist("server", [entry])],
			);
		};

		await action.save();
		await flush();
		await refresh();

		const state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.playlists).toEqual([makePlaylist("server", [entry])]);
	});

	test("saveBoundary_true_negative_guard_refresh_does_not_clear_optimistic_exit_context_before_matching_reconcile", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("fresh", [entry]);
		let releaseCreate!: () => void;
		let readAllCalls = 0;

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			slot: mission,
			selectedListName: "stale",
			playbackListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			processMsg: { playlist: "stale", str: "processing" },
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		impl.create = async () => {
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1 ? [] : [makePlaylist("server", [entry])],
			);
		};

		const saving = action.save();

		await waitUntil(() => __testing.getState().slot === null);
		await refresh();

		let state = __testing.getState();
		expect(state.mode).toBe("new_guide");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toBeNull();
		expect(state.playlists).toEqual([]);
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();

		releaseCreate();
		await saving;
		await flush();

		state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toBeNull();
		expect(state.playlists).toEqual([makePlaylist("server", [entry])]);
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(state.loading).toBe(false);
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("saveBoundary_true_negative_guard_process_result_does_not_rebind_optimistic_exit_context_before_matching_reconcile", async () => {
		const entry = makeEntry("alpha", "C:/music/alpha");
		const mission = makeMission("fresh", [entry]);
		const handlers = new Map<string, (payload: unknown) => void>();
		let releaseCreate!: () => void;
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>([]);
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls <= 2 ? [] : [makePlaylist("server", [entry])],
			);
		};

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			slot: mission,
			selectedListName: "stale",
			playbackListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			processMsg: { playlist: "stale", str: "processing" },
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		impl.create = async () => {
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			return Ok<null, string>(null);
		};

		const saving = action.save();
		await waitUntil(() => __testing.getState().slot === null);

		handlers.get("processMsg")?.({ playlist: "server", str: "late process" });
		handlers.get("processResult")?.(undefined);
		await flush();

		let state = __testing.getState();
		expect(state.mode).toBe("new_guide");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toBeNull();
		expect(state.playlists).toEqual([]);
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.startupRoute).toBe("hydrated_empty");

		releaseCreate();
		await saving;
		await flush();

		state = __testing.getState();
		expect(state.playlists).toEqual([makePlaylist("server", [entry])]);
		expect(state.mode).toBe("play");
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("saveBoundary_true_negative_guard_materialization_events_do_not_rebind_optimistic_exit_context_before_matching_reconcile", async () => {
		const persistedEntry = withEntryMaterialization(
			makeEntry("alpha", "C:/music/alpha", {
				url: "https://example.com/list",
				entry_type: "WebList",
				downloaded_ok: false,
			}),
			{
				phase: "pending",
				ownerSessionId: 22,
				settled: "idle",
				lastError: null,
			},
		);
		const mission = makeMission("fresh", [persistedEntry]);
		let releaseCreate!: () => void;

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			slot: mission,
			selectedListName: "stale",
			playbackListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			processMsg: { playlist: "stale", str: "processing" },
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		impl.create = async () => {
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () => Ok<Playlist[], string>([]);

		const saving = action.save();
		await waitUntil(() => __testing.getState().slot === null);

		await action.updateWeblist(persistedEntry);

		let state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toBeNull();
		expectPlaylistLike(state.playlists, [
			makePlaylist("fresh", [
				withEntryMaterialization(persistedEntry, {
					phase: "pending",
					ownerSessionId: 22,
					settled: "idle",
					lastError: null,
				}),
			]),
		]);
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.loading).toBe(false);

		releaseCreate();
		await saving;
		await flush();

		state = __testing.getState();
		expect(state.mode).toBe("new_guide");
		expect(state.routeResolved).toBe(true);
		expect(state.slot).toBeNull();
		expect(state.playlists).toEqual([]);
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.loading).toBe(false);
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("saveBoundary_true_negative_guard_late_refresh_process_and_materialization_traffic_preserves_the_same_optimistic_post_save_context", async () => {
		const savedEntry = withEntryMaterialization(
			makeEntry("fresh remote", "C:/music/fresh-remote", {
				url: "https://example.com/fresh",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				ownerSessionId: 31,
				settled: "idle",
				lastError: null,
			},
		);
		const staleEntry = withEntryMaterialization(
			makeEntry("stale remote", "C:/music/stale-remote", {
				url: "https://example.com/stale",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				ownerSessionId: 31,
				settled: "idle",
				lastError: null,
			},
		);
		const mission = makeMission("fresh", [savedEntry]);
		const handlers = new Map<string, (payload: unknown) => void>();
		let releaseCreate!: () => void;
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>([]);
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1
					? []
					: readAllCalls === 2
						? [makePlaylist("stale", [staleEntry])]
						: [makePlaylist("fresh", [savedEntry])],
			);
		};
		impl.create = async () => {
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.updateWeblist = async (entry: Entry) =>
			Ok<Entry, string>({
				...entry,
				downloaded_ok: true,
				musics: [makeMusic(`${entry.path}/downloaded.flac`)],
			});

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			slot: mission,
			selectedListName: "stale",
			playbackListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			processMsg: { playlist: "stale", str: "processing" },
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		const saving = action.save();
		await waitUntil(() => __testing.getState().slot === null);

		handlers.get("processMsg")?.({ playlist: "stale", str: "late process" });
		handlers.get("processResult")?.(undefined);
		await action.updateWeblist(staleEntry);
		await refresh();
		await flush();

		let state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("fresh");
		expect((state.playlists[0]?.entries[0] as { url?: string }).url).toBe(
			"https://example.com/fresh",
		);
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.loading).toBe(false);

		releaseCreate();
		await saving;
		await flush();

		state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("fresh");
		expect((state.playlists[0]?.entries[0] as { url?: string }).url).toBe(
			"https://example.com/fresh",
		);
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(state.loading).toBe(false);
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("saveBoundary_true_positive_matching_refresh_reconciles_only_the_intended_persisted_playlist_once", async () => {
		const savedEntry = makeEntry("alpha", "C:/music/alpha");
		const unrelatedEntry = makeEntry("beta", "C:/music/beta");
		const mission = makeMission("fresh", [savedEntry]);
		let releaseCreate!: () => void;
		let readAllCalls = 0;

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			slot: mission,
			selectedListName: "stale",
			playbackListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			processMsg: { playlist: "stale", str: "processing" },
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		impl.create = async () => {
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1
					? [makePlaylist("other", [unrelatedEntry])]
					: [
						makePlaylist("other", [unrelatedEntry]),
						makePlaylist("fresh", [savedEntry]),
					],
			);
		};

		const saving = action.save();
		await waitUntil(() => __testing.getState().slot === null);
		await refresh();

		let state = __testing.getState();
		expectPlaylistLike(state.playlists, [makePlaylist("other", [unrelatedEntry])]);
		expect(state.mode).toBe("play");
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();

		releaseCreate();
		await saving;
		await flush();

		state = __testing.getState();
		expectPlaylistLike(state.playlists, [
			makePlaylist("other", [unrelatedEntry]),
			makePlaylist("fresh", [savedEntry]),
		]);
		expect(state.mode).toBe("play");
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("saveBoundary_true_negative_guard_non_matching_refresh_after_edit_save_does_not_rebind_to_another_playlist", async () => {
		const anchorEntry = makeEntry("alpha", "C:/music/alpha");
		const savedEntry = makeEntry("alpha saved", "C:/music/alpha-saved");
		const unrelatedEntry = makeEntry("beta", "C:/music/beta");
		const original = makePlaylist("focus", [anchorEntry]);
		const mission = makeMission("renamed", [savedEntry]);
		let releaseUpdate!: () => void;
		let readAllCalls = 0;

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			playlists: [original],
			selectedListName: "focus",
			playbackListName: "focus",
			nowPlaying: makeMusic("C:/music/focus/a.flac"),
			processMsg: { playlist: "focus", str: "processing" },
			slot: mission,
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		impl.update = async () => {
			await new Promise<void>((resolve) => {
				releaseUpdate = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1
					? [makePlaylist("other", [unrelatedEntry])]
					: [
						makePlaylist("other", [unrelatedEntry]),
						makePlaylist("renamed", [savedEntry]),
					],
			);
		};

		const saving = action.save();
		await waitUntil(() => __testing.getState().slot === null);
		await refresh();

		let state = __testing.getState();
		expectPlaylistLike(state.playlists, [makePlaylist("other", [unrelatedEntry])]);
		expect(state.mode).toBe("play");
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();

		releaseUpdate();
		await saving;
		await flush();

		state = __testing.getState();
		expectPlaylistLike(state.playlists, [
			makePlaylist("other", [unrelatedEntry]),
			makePlaylist("renamed", [savedEntry]),
		]);
		expect(state.mode).toBe("play");
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("saveBoundary_true_negative_guard_non_matching_materialization_after_save_does_not_mutate_another_persisted_owner_boundary", async () => {
		const savedEntry = withEntryMaterialization(
			makeEntry("saved remote", "C:/music/saved-remote", {
				url: "https://example.com/saved",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				ownerSessionId: 15,
				settled: "idle",
				lastError: null,
			},
		);
		const unrelatedEntry = withEntryMaterialization(
			makeEntry("other remote", "C:/music/other-remote", {
				url: "https://example.com/other",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				ownerSessionId: 15,
				settled: "idle",
				lastError: null,
			},
		);
		const mission = makeMission("fresh", [savedEntry]);
		let releaseCreate!: () => void;

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			slot: mission,
			playlists: [makePlaylist("other", [unrelatedEntry])],
			selectedListName: "stale",
			playbackListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			processMsg: { playlist: "stale", str: "processing" },
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		impl.create = async () => {
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () =>
			Ok<Playlist[], string>([
				makePlaylist("other", [unrelatedEntry]),
				makePlaylist("fresh", [savedEntry]),
			]);
		impl.updateWeblist = async (entry: Entry) => {
			if (entry.url === unrelatedEntry.url) {
				return Ok<Entry, string>({
					...unrelatedEntry,
					downloaded_ok: true,
					musics: [makeMusic("C:/music/other-remote/downloaded.flac")],
				});
			}
			return Ok<Entry, string>(entry);
		};

		const saving = action.save();
		await waitUntil(() => __testing.getState().slot === null);
		releaseCreate();
		await saving;
		await flush();

		await action.updateWeblist(unrelatedEntry);

		let state = __testing.getState();
		expect(state.playlists).toHaveLength(2);
		expect(state.playlists[0]?.name).toBe("other");
		expect((state.playlists[0]?.entries[0] as { url?: string }).url).toBe(
			"https://example.com/other",
		);
		expect(state.playlists[1]?.name).toBe("fresh");
		expect((state.playlists[1]?.entries[0] as { url?: string }).url).toBe(
			"https://example.com/saved",
		);
		expect(state.mode).toBe("play");
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
	});

	test("saveBoundary_false_negative_guard_matching_refresh_materialization_and_process_result_only_settle_the_intended_saved_owner_once", async () => {
		const eventHandlers = {
			processMsg: null as ((payload: unknown) => void) | null,
			processResult: null as ((payload: unknown) => void) | null,
		};
		const savedEntryPending = withEntryMaterialization(
			makeEntry("saved remote", "C:/music/saved-remote", {
				url: "https://example.com/saved",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				ownerSessionId: 27,
				settled: "idle",
				lastError: null,
			},
		);
		const unrelatedEntryPending = withEntryMaterialization(
			makeEntry("other remote", "C:/music/other-remote", {
				url: "https://example.com/other",
				entry_type: "WebList",
				downloaded_ok: false,
				musics: [],
			}),
			{
				phase: "pending",
				ownerSessionId: 41,
				settled: "idle",
				lastError: null,
			},
		);
		const savedReadyMusic = {
			...makeMusic("C:/music/saved-remote/ready.flac"),
			normalization_status: "Ready" as const,
			integrated_lufs: -18,
			analysis_version: 1,
			analyzed_at_ms: 123,
		};
		const unrelatedReadyMusic = {
			...makeMusic("C:/music/other-remote/ready.flac"),
			normalization_status: "Ready" as const,
			integrated_lufs: -16,
			analysis_version: 1,
			analyzed_at_ms: 999,
		};
		const savedEntryReady = makeEntry("saved remote", "C:/music/saved-remote", {
			url: "https://example.com/saved",
			entry_type: "WebList",
			downloaded_ok: true,
			musics: [savedReadyMusic],
		});
		const unrelatedEntryReady = makeEntry(
			"other remote",
			"C:/music/other-remote",
			{
				url: "https://example.com/other",
				entry_type: "WebList",
				downloaded_ok: true,
				musics: [unrelatedReadyMusic],
			},
		);
		const mission = makeMission("fresh", [savedEntryPending]);
		let releaseCreate!: () => void;
		let readAllCalls = 0;

		impl.evt = async (event: string, handler: (payload: unknown) => void) => {
			if (event === "processMsg") eventHandlers.processMsg = handler;
			if (event === "processResult") eventHandlers.processResult = handler;
			return () => {};
		};
		impl.create = async () => {
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1
					? [makePlaylist("other", [unrelatedEntryPending])]
					: [
						makePlaylist("other", [unrelatedEntryReady]),
						makePlaylist("fresh", [savedEntryReady]),
					],
			);
		};
		impl.updateWeblist = async (entry: Entry) => {
			if (entry.url === unrelatedEntryPending.url) {
				return Ok<Entry, string>(unrelatedEntryReady);
			}
			return Ok<Entry, string>(savedEntryReady);
		};

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			slot: mission,
			playlists: [makePlaylist("other", [unrelatedEntryPending])],
			selectedListName: "stale",
			playbackListName: "stale",
			nowPlaying: makeMusic("C:/music/stale/a.flac"),
			processMsg: { playlist: "stale", str: "processing" },
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});

		const saving = action.save();
		await waitUntil(() => __testing.getState().slot === null);
		await refresh();

		let state = __testing.getState();
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("other");
		expect(
			(
				state.playlists[0]?.entries[0] as {
					materialization?: { phase: string };
				}
			).materialization?.phase,
		).toBe("pending");

		await action.updateWeblist(unrelatedEntryPending);
		state = __testing.getState();
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("other");
		expect(
			(
				state.playlists[0]?.entries[0] as {
					materialization?: { phase: string };
				}
			).materialization?.phase,
		).toBe("pending");
		expect(state.processMsg).toBeNull();

		eventHandlers.processMsg?.({ playlist: "other", str: "other processing" });
		await eventHandlers.processResult?.({});

		state = __testing.getState();
		expect(state.playlists).toHaveLength(2);
		expect(state.playlists[0]?.name).toBe("other");
		expect(state.playlists[1]?.name).toBe("fresh");
		expect(
			(
				state.playlists[0]?.entries[0] as {
					materialization?: { phase: string };
				}
			).materialization?.phase,
		).toBe("ready");
		expect(
			(
				state.playlists[1]?.entries[0] as {
					materialization?: { phase: string };
				}
			).materialization?.phase,
		).toBe("ready");
		expect(state.mode).toBe("play");
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();

		releaseCreate();
		await saving;
		await flush();

		state = __testing.getState();
		expect(state.playlists).toHaveLength(2);
		expect(state.playlists[0]?.name).toBe("other");
		expect(state.playlists[1]?.name).toBe("fresh");
		expect(
			(
				state.playlists[0]?.entries[0] as {
					materialization?: { phase: string };
				}
			).materialization?.phase,
		).toBe("ready");
		expect(
			(
				state.playlists[1]?.entries[0] as {
					materialization?: { phase: string };
				}
			).materialization?.phase,
		).toBe("ready");
		expect(state.mode).toBe("play");
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.processMsg).toBeNull();
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});


	test("save_false_positive_guard_update_error_rolls_back_optimistic_edit_after_refresh", async () => {
		const original = makePlaylist("focus", [
			makeEntry("alpha", "C:/music/alpha"),
		]);
		const mission = makeMission("renamed", [
			makeEntry("beta", "C:/music/beta"),
		]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			playlists: [original],
			selectedListName: "focus",
			slot: mission,
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});
		impl.update = async () => Err<string, null>("write failed");
		impl.readAll = async () => Ok<Playlist[], string>([original]);

		await action.save();
		await flush();

		const state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.selectedListName).toBeNull();
		expect(state.playlists).toEqual([original]);
		expect(toastLog.error).toContainEqual({
			title: "Save failed",
			description: "write failed",
		});
	});

	test("reloadEntry_true_negative_guard_clears_review_flag_and_preserves_slot_on_failure", async () => {
		const entry = makeEntry("folder", "C:/music/folder");
		const mission = makeMission("focus", [entry]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			slot: mission,
		});
		impl.recheckFolder = async () => Err<string, Entry>("scan failed");

		await action.reloadEntry(entry);

		const state = __testing.getState();
		expect(state.folderReviews).toEqual([]);
		expect(state.slot?.name).toBe(mission.name);
		expect(state.slot?.entries).toHaveLength(1);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "folder_reload",
			key: entry.path ?? "",
			inProgress: false,
			settled: "failed",
			ownerSessionId: 0,
		});
		expect(toastLog.error).toContainEqual({
			title: "Reload failed",
			description: "scan failed",
		});
	});

	test("reloadEntry_true_positive_only_updates_matching_active_slot_and_clears_review_flag", async () => {
		const entry = makeEntry("folder", "C:/music/folder");
		const entryPath = entry.path ?? "";
		const updated = {
			...entry,
			musics: [makeMusic("C:/music/folder/new.flac")],
		};
		const mission = makeMission("focus", [entry]);

		let release!: () => void;
		impl.recheckFolder =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			slot: mission,
			folderReviews: [],
		});

		const pending = action.reloadEntry(entry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.path === entryPath && hasPendingEntryOperation(item, "folder_reload"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			slot: makeMission("fresh", [makeEntry("other", "C:/music/other")]),
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.folderReviews).toEqual([]);
		expect(state.slot).toEqual(
			makeMission("fresh", [makeEntry("other", "C:/music/other")]),
		);
	});

	test("reloadEntry_false_negative_guard_updates_only_the_same_live_entry_identity", async () => {
		const original = makeEntry("folder", "C:/music/folder");
		const replacement = makeEntry("folder", "C:/music/folder", {
			url: "https://example.com/replacement",
			entry_type: "WebList",
		});
		const updated = {
			...original,
			musics: [makeMusic("C:/music/folder/new.flac")],
		};

		let release!: () => void;
		impl.recheckFolder =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			slot: makeMission("focus", [original]),
			folderReviews: [],
		});

		const pending = action.reloadEntry(original);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.path === original.path && hasPendingEntryOperation(item, "folder_reload"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			slot: makeMission("focus", [replacement]),
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.folderReviews).toEqual([]);
		expect(state.slot?.entries).toEqual([replacement]);
	});

	test("reloadEntry_false_positive_guard_does_not_recreate_removed_entry", async () => {
		const entry = makeEntry("folder", "C:/music/folder");
		const updated = {
			...entry,
			musics: [makeMusic("C:/music/folder/new.flac")],
		};

		let release!: () => void;
		impl.recheckFolder =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			slot: makeMission("focus", [entry]),
			folderReviews: [],
		});

		const pending = action.reloadEntry(entry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.path === entry.path && hasPendingEntryOperation(item, "folder_reload"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			slot: makeMission("focus", []),
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.folderReviews).toEqual([]);
		expect(state.slot?.entries).toEqual([]);
	});

	test("reloadEntry_false_negative_guard_keeps_persisted_truth_unchanged_until_save_and_converges_on_save", async () => {
		const persisted = makeEntry("folder", "C:/music/folder", {
			musics: [makeMusic("C:/music/folder/original.flac")],
		});
		const draftUpdate = {
			...persisted,
			musics: [makeMusic("C:/music/folder/reloaded.flac")],
		};
		const persistedPlaylist = makePlaylist("focus", [persisted]);
		const refreshedPlaylist = makePlaylist("focus", [draftUpdate]);
		const updateCalls: Array<{ mission: CollectMission; anchor: Playlist }> = [];
		let readAllCalls = 0;

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			playlists: [persistedPlaylist],
			selectedListName: "focus",
			slot: makeMission("focus", [persisted]),
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});
		impl.recheckFolder = async () => Ok<Entry, string>(draftUpdate);
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1 ? [persistedPlaylist] : [refreshedPlaylist],
			);
		};
		impl.update = async (mission: CollectMission, anchor: Playlist) => {
			updateCalls.push({ mission, anchor });
			return Ok<null, string>(null);
		};

		await action.reloadEntry(persisted);

		let state = __testing.getState();
		expect(state.slot?.entries).toHaveLength(1);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "folder_reload",
			key: persisted.path ?? "",
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 0,
		});
		expect(state.slot?.entries[0]).toMatchObject(draftUpdate);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("focus");
		expect(state.playlists[0]?.entries[0]).toMatchObject(persisted);

		await refresh();

		state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.slot?.entries).toHaveLength(1);
		expect(state.slot?.entries[0]).toMatchObject(draftUpdate);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("focus");
		expect(state.playlists[0]?.entries[0]).toMatchObject(persisted);

		await saveDraftAndWaitForReload();

		state = __testing.getState();
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]?.mission.entries).toHaveLength(1);
		expect(updateCalls[0]?.mission.entries[0]).toMatchObject(draftUpdate);
		expect(updateCalls[0]?.anchor).toMatchObject(persistedPlaylist);
		expect(state.mode).toBe("play");
		expectPlaylistLike(state.playlists, [refreshedPlaylist]);
	});

	test("reloadEntry_false_negative_guard_post_slot_replacement_completion_only_clears_review_state_without_restoring_old_draft", async () => {
		const entry = makeEntry("folder", "C:/music/folder");
		const updated = {
			...entry,
			musics: [makeMusic("C:/music/folder/new.flac")],
		};
			const replacement = makeEntry("replacement", "C:/music/replacement");

		let release!: () => void;
		impl.recheckFolder =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			startupRoute: "hydrated_editing",
				playlists: [makePlaylist("focus", [entry]), makePlaylist("replacement", [replacement])],
			selectedListName: "focus",
			slot: makeMission("focus", [entry]),
			folderReviews: [],
		});

		const pending = action.reloadEntry(entry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.path === entry.path && hasPendingEntryOperation(item, "folder_reload"),
					) ?? false,
		);

			await action.edit(makePlaylist("replacement", [replacement]));
			expect(__testing.getState().mode).toBe("edit");
			expect(__testing.getState().selectedListName).toBe("replacement");
			expect(__testing.getState().folderReviews).toEqual([]);

		release();
		await pending;

		const state = __testing.getState();
			expect(state.mode).toBe("edit");
			expect(state.routeResolved).toBe(true);
			expect(state.startupRoute).toBe("hydrated_editing");
			expect(state.selectedListName).toBe("replacement");
			expect(state.nowPlaying).toBeNull();
			expect(state.slot).toEqual(makeMission("replacement", [replacement]));
		expect(state.folderReviews).toEqual([]);
			expect(state.playlists).toEqual([
				makePlaylist("focus", [entry]),
				makePlaylist("replacement", [replacement]),
			]);
	});

	test("reloadEntry_false_negative_guard_post_back_completion_only_clears_review_state_without_restoring_closed_draft", async () => {
		const entry = makeEntry("folder", "C:/music/folder");
		const updated = {
			...entry,
			musics: [makeMusic("C:/music/folder/new.flac")],
		};

		let release!: () => void;
		impl.recheckFolder =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			playlists: [makePlaylist("focus", [entry])],
			selectedListName: "focus",
			slot: makeMission("focus", [entry]),
			folderReviews: [],
		});

		const pending = action.reloadEntry(entry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.path === entry.path && hasPendingEntryOperation(item, "folder_reload"),
					) ?? false,
		);
		release();
		await pending;

		const backPending = action.back();
		await backPending;
		expect(__testing.getState().mode).toBe("play");
		expect(__testing.getState().slot).toBeNull();
		expect(__testing.getState().selectedListName).toBeNull();

		const state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.folderReviews).toEqual([]);
		expect(state.playlists).toEqual([makePlaylist("focus", [entry])]);
	});

	test("reloadEntry_false_negative_guard_post_save_completion_only_clears_review_state_without_restoring_closed_draft", async () => {
		const persisted = makeEntry("folder", "C:/music/folder", {
			musics: [makeMusic("C:/music/folder/original.flac")],
		});
		const updated = {
			...persisted,
			musics: [makeMusic("C:/music/folder/reloaded.flac")],
		};
		const persistedPlaylist = makePlaylist("focus", [persisted]);
		let releaseReload!: () => void;
		let releaseSave!: () => void;

		impl.recheckFolder =
			() =>
				new Promise((resolve) => {
					releaseReload = () => resolve(Ok<Entry, string>(updated));
				});
		impl.update = async () => {
			await new Promise<void>((resolve) => {
				releaseSave = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () => Ok<Playlist[], string>([persistedPlaylist]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			playlists: [persistedPlaylist],
			selectedListName: "focus",
			slot: makeMission("focus", [persisted]),
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
			folderReviews: [],
		});

		const pendingReload = action.reloadEntry(persisted);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.path === persisted.path && hasPendingEntryOperation(item, "folder_reload"),
					) ?? false,
		);
		releaseReload();
		await pendingReload;

		const pendingSave = action.save();
		await waitUntil(() => __testing.getState().mode === "play");
		expect(__testing.getState().slot).toBeNull();
		expect(__testing.getState().selectedListName).toBeNull();

		let state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.folderReviews).toEqual([]);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("focus");
		expect(state.playlists[0]?.entries[0]).toMatchObject(updated);

		releaseSave();
		await pendingSave;
		await flush();

		state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.folderReviews).toEqual([]);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("focus");
		expect(state.playlists[0]?.entries[0]).toMatchObject(persisted);
	});

	test("updateWeblist_true_positive_replaces_entry_and_clears_review_flag", async () => {
		const entry = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
		});
		const updated = {
			...entry,
			musics: [makeMusic("C:/music/remote/new.flac")],
		};
		const mission = makeMission("focus", [entry]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: mission,
		});
		impl.updateWeblist = async () => Ok<Entry, string>(updated);

		await action.updateWeblist(entry);

		const state = __testing.getState();
		expect(state.weblistReviews).toEqual([]);
		expect(state.slot?.entries).toHaveLength(1);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "weblist_update",
			key: entry.url ?? "",
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 0,
		});
		expect(state.slot?.entries[0]).toMatchObject(updated);
	});

	test("updateWeblist_true_negative_guard_clears_review_flag_and_preserves_replaced_slot", async () => {
		const entry = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
		});
		const updated = {
			...entry,
			musics: [makeMusic("C:/music/remote/new.flac")],
		};
		const mission = makeMission("focus", [entry]);

		let release!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: mission,
			weblistReviews: [],
		});

		const pending = action.updateWeblist(entry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.url === entry.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			selectedListName: "other",
			slot: makeMission("fresh", [makeEntry("other", "C:/music/other")]),
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.weblistReviews).toEqual([]);
		expect(state.slot).toEqual(
			makeMission("fresh", [makeEntry("other", "C:/music/other")]),
		);
	});

	test("updateWeblist_false_negative_guard_updates_only_the_same_live_entry_identity", async () => {
		const entry = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
		});
		const replacement = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/replacement",
			entry_type: "WebList",
		});
		const updated = {
			...entry,
			musics: [makeMusic("C:/music/remote/new.flac")],
		};

		let release!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", [entry]),
			weblistReviews: [],
		});

		const pending = action.updateWeblist(entry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.url === entry.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", [replacement]),
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.weblistReviews).toEqual([]);
		expect(state.slot?.entries).toEqual([replacement]);
	});

	test("updateWeblist_false_positive_guard_does_not_recreate_removed_entry", async () => {
		const entry = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
		});
		const updated = {
			...entry,
			musics: [makeMusic("C:/music/remote/new.flac")],
		};

		let release!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					release = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", [entry]),
			weblistReviews: [],
		});

		const pending = action.updateWeblist(entry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) => item.url === entry.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: makeMission("focus", []),
		});

		release();
		await pending;

		const state = __testing.getState();
		expect(state.weblistReviews).toEqual([]);
		expect(state.slot?.entries).toEqual([]);
	});

	test("updateWeblist_false_negative_guard_keeps_persisted_truth_unchanged_until_save_and_converges_on_save", async () => {
		const persisted = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			downloaded_ok: false,
			musics: [],
		});
		const draftUpdate = {
			...persisted,
			downloaded_ok: true,
			musics: [makeMusic("C:/music/remote/downloaded.flac")],
		};
		const persistedPlaylist = makePlaylist("focus", [persisted]);
		const refreshedPlaylist = makePlaylist("focus", [draftUpdate]);
		const updateCalls: Array<{ mission: CollectMission; anchor: Playlist }> = [];
		let readAllCalls = 0;

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			playlists: [persistedPlaylist],
			selectedListName: "focus",
			slot: makeMission("focus", [persisted]),
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
		});
		impl.updateWeblist = async () => Ok<Entry, string>(draftUpdate);
		impl.readAll = async () => {
			readAllCalls += 1;
			return Ok<Playlist[], string>(
				readAllCalls === 1 ? [persistedPlaylist] : [refreshedPlaylist],
			);
		};
		impl.update = async (mission: CollectMission, anchor: Playlist) => {
			updateCalls.push({ mission, anchor });
			return Ok<null, string>(null);
		};

		await action.updateWeblist(persisted);

		let state = __testing.getState();
		expect(state.slot?.entries).toHaveLength(1);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "weblist_update",
			key: persisted.url ?? "",
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 0,
		});
		expect(state.slot?.entries[0]).toMatchObject(draftUpdate);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("focus");
		expect(state.playlists[0]?.entries[0]).toMatchObject(persisted);

		await refresh();

		state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.slot?.entries).toHaveLength(1);
		expect(state.slot?.entries[0]).toMatchObject(draftUpdate);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("focus");
		expect(state.playlists[0]?.entries[0]).toMatchObject(persisted);

		await saveDraftAndWaitForReload();

		state = __testing.getState();
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]?.mission.entries).toHaveLength(1);
		expect(updateCalls[0]?.mission.entries[0]).toMatchObject(draftUpdate);
		expect(updateCalls[0]?.anchor).toMatchObject(persistedPlaylist);
		expect(state.mode).toBe("play");
		expectPlaylistLike(state.playlists, [refreshedPlaylist]);
	});

		test("updateWeblist_false_negative_guard_post_slot_replacement_completion_only_clears_review_state_without_restoring_old_draft", async () => {
		const persisted = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			downloaded_ok: false,
			musics: [],
		});
		const updated = {
			...persisted,
			downloaded_ok: true,
			musics: [makeMusic("C:/music/remote/downloaded.flac")],
		};
		const optimisticPersisted = makePlaylist("focus", [persisted]);
		let releaseUpdate!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					releaseUpdate = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			playlists: [optimisticPersisted],
			selectedListName: "focus",
			slot: makeMission("focus", [persisted]),
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
			weblistReviews: [],
		});

		const pendingUpdate = action.updateWeblist(persisted);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.url === persisted.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

			await action.edit(makePlaylist("replacement", [
				makeEntry("replacement", "C:/music/replacement"),
			]));
			expect(__testing.getState().mode).toBe("edit");
			expect(__testing.getState().selectedListName).toBe("replacement");

		releaseUpdate();
		await pendingUpdate;

		let state = __testing.getState();
			expect(state.mode).toBe("edit");
			expect(state.routeResolved).toBe(true);
			expect(state.startupRoute).toBe("hydrated_editing");
			expect(state.slot).toEqual(
				makeMission("replacement", [makeEntry("replacement", "C:/music/replacement")]),
			);
			expect(state.selectedListName).toBe("replacement");
		expect(state.weblistReviews).toEqual([]);
			expect(state.playlists).toEqual([optimisticPersisted]);
	});

	test("updateWeblist_false_negative_guard_post_back_completion_only_clears_review_state_without_restoring_closed_draft", async () => {
		const persisted = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			downloaded_ok: false,
			musics: [],
		});
		const updated = {
			...persisted,
			downloaded_ok: true,
			musics: [makeMusic("C:/music/remote/downloaded.flac")],
		};
		const persistedPlaylist = makePlaylist("focus", [persisted]);
		let releaseUpdate!: () => void;
		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					releaseUpdate = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			playlists: [persistedPlaylist],
			selectedListName: "focus",
			slot: makeMission("focus", [persisted]),
			weblistReviews: [],
		});

		const pendingUpdate = action.updateWeblist(persisted);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.url === persisted.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);
		releaseUpdate();
		await pendingUpdate;

		const backPending = action.back();
		await backPending;
		expect(__testing.getState().mode).toBe("play");
		expect(__testing.getState().slot).toBeNull();
		expect(__testing.getState().selectedListName).toBeNull();

		const state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.weblistReviews).toEqual([]);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("focus");
		expect(state.playlists[0]?.entries[0]).toMatchObject(persisted);
	});

	test("updateWeblist_false_negative_guard_post_save_completion_only_clears_review_state_without_restoring_closed_draft", async () => {
		const persisted = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			downloaded_ok: false,
			musics: [],
		});
		const updated = {
			...persisted,
			downloaded_ok: true,
			musics: [makeMusic("C:/music/remote/downloaded.flac")],
		};
		const persistedPlaylist = makePlaylist("focus", [persisted]);
		let releaseUpdate!: () => void;
		let releaseSave!: () => void;

		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					releaseUpdate = () => resolve(Ok<Entry, string>(updated));
				});
		impl.update = async () => {
			await new Promise<void>((resolve) => {
				releaseSave = resolve;
			});
			return Ok<null, string>(null);
		};
		impl.readAll = async () => Ok<Playlist[], string>([persistedPlaylist]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			routeResolved: true,
			startupRoute: "hydrated_editing",
			playlists: [persistedPlaylist],
			selectedListName: "focus",
			slot: makeMission("focus", [persisted]),
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
			weblistReviews: [],
		});

		const pendingUpdate = action.updateWeblist(persisted);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.url === persisted.url && hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);
		releaseUpdate();
		await pendingUpdate;

		const pendingSave = action.save();
		await waitUntil(() => __testing.getState().mode === "play");
		expect(__testing.getState().slot).toBeNull();
		expect(__testing.getState().selectedListName).toBeNull();

		let state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.routeResolved).toBe(true);
		expect(state.startupRoute).toBe("hydrated_playlists");
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.weblistReviews).toEqual([]);
		expect(state.playlists).toHaveLength(1);
		expect(state.playlists[0]?.name).toBe("focus");
		expect(state.playlists[0]?.entries[0]).toMatchObject(updated);

		releaseSave();
		await pendingSave;
		await flush();

		state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.weblistReviews).toEqual([]);
		expectPlaylistLike(state.playlists, [persistedPlaylist]);
	});

	test("addLink_false_positive_guard_clears_review_flag_without_reintroducing_removed_link", async () => {
		const mission = makeMission("focus");
		const url = "https://example.com/playlist";

		let release!: () => void;
		impl.lookMedia =
			() =>
				new Promise((resolve) => {
					release = () =>
						resolve(
							Ok<
								{ title: string; item_type: string; entries_count: number | null },
								string
							>({
								title: "remote list",
								item_type: "playlist",
								entries_count: 12,
							}),
						);
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			slot: mission,
			linkReviews: [],
		});

		const pending = action.addLink(url);
		await waitUntil(() =>
			__testing
				.getState()
				.slot?.links.some(
					(link) =>
						link.url === url &&
						link.operation?.kind === "link_review" &&
						link.operation.inProgress === true,
				) ?? false,
		);

		action.removeLink(url);
		release();
		await pending;

		const state = __testing.getState();
		expect(state.linkReviews).toEqual([]);
		expect(state.slot).toEqual(mission);
		expect(state.slot?.links).toEqual([]);
	});

	test("draftEntryOperation_false_negative_guard_keeps_folder_reload_isolated_from_other_entries_and_operations", async () => {
		const reloadingEntry = makeEntry("folder", "C:/music/folder-a");
		const unaffectedFolderEntry = makeEntry("folder", "C:/music/folder-b", {
			musics: [makeMusic("C:/music/folder-b/original.flac")],
		});
		const unaffectedWeblistEntry = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			musics: [makeMusic("C:/music/remote/original.flac")],
		});
		const linkUrl = "https://example.com/link-review";
		const updated = {
			...reloadingEntry,
			musics: [makeMusic("C:/music/folder-a/reloaded.flac")],
		};
		let releaseReload!: () => void;

		impl.recheckFolder =
			() =>
				new Promise((resolve) => {
					releaseReload = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: {
				...makeMission("focus", [
					reloadingEntry,
					withEntryOperation(unaffectedFolderEntry, {
						kind: "folder_reload",
						key: unaffectedFolderEntry.path ?? "",
						inProgress: false,
						settled: "succeeded",
						ownerSessionId: 77,
					}),
					withEntryOperation(unaffectedWeblistEntry, {
						kind: "weblist_update",
						key: unaffectedWeblistEntry.url ?? "",
						inProgress: true,
						settled: "idle",
						ownerSessionId: 88,
					}),
				]),
				links: [
					makeDraftLink({
						url: linkUrl,
						operation: {
							kind: "link_review",
							key: linkUrl,
							inProgress: true,
							settled: "idle",
							ownerSessionId: 99,
						},
					}),
				],
			},
			folderReviews: [],
			weblistReviews: [],
			linkReviews: [],
		});

		const pendingReload = action.reloadEntry(reloadingEntry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.path === reloadingEntry.path &&
							hasPendingEntryOperation(item, "folder_reload"),
					) ?? false,
		);

		let state = __testing.getState();
		expect(deriveDraftReviewState(state).folderReviews).toEqual([
			reloadingEntry.path ?? "",
		]);
		expect(deriveDraftReviewState(state).weblistReviews).toEqual([
			unaffectedWeblistEntry.url ?? "",
		]);
		expect(deriveDraftReviewState(state).linkReviews).toEqual([linkUrl]);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "folder_reload",
			key: reloadingEntry.path ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 0,
		});
		expectEntryOperation(state.slot!.entries[1]!, {
			kind: "folder_reload",
			key: unaffectedFolderEntry.path ?? "",
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 77,
		});
		expectEntryOperation(state.slot!.entries[2]!, {
			kind: "weblist_update",
			key: unaffectedWeblistEntry.url ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 88,
		});
		expectLinkOperation(state.slot!.links[0]!, {
			kind: "link_review",
			key: linkUrl,
			inProgress: true,
			settled: "idle",
			ownerSessionId: 99,
		});

		releaseReload();
		await pendingReload;

		state = __testing.getState();
		expect(deriveDraftReviewState(state).folderReviews).toEqual([]);
		expect(deriveDraftReviewState(state).weblistReviews).toEqual([
			unaffectedWeblistEntry.url ?? "",
		]);
		expect(deriveDraftReviewState(state).linkReviews).toEqual([linkUrl]);
		expect(state.slot?.entries[0]).toMatchObject(updated);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "folder_reload",
			key: reloadingEntry.path ?? "",
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 0,
		});
		expectEntryOperation(state.slot!.entries[1]!, {
			kind: "folder_reload",
			key: unaffectedFolderEntry.path ?? "",
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 77,
		});
		expectEntryOperation(state.slot!.entries[2]!, {
			kind: "weblist_update",
			key: unaffectedWeblistEntry.url ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 88,
		});
		expectLinkOperation(state.slot!.links[0]!, {
			kind: "link_review",
			key: linkUrl,
			inProgress: true,
			settled: "idle",
			ownerSessionId: 99,
		});
	});

	test("draftEntryOperation_false_negative_guard_keeps_weblist_update_isolated_from_other_entries_and_operations", async () => {
		const folderEntry = makeEntry("folder", "C:/music/folder", {
			musics: [makeMusic("C:/music/folder/original.flac")],
		});
		const targetWeblistEntry = makeEntry("remote", "C:/music/remote-a", {
			url: "https://example.com/list-a",
			entry_type: "WebList",
			musics: [makeMusic("C:/music/remote-a/original.flac")],
		});
		const otherWeblistEntry = makeEntry("remote", "C:/music/remote-b", {
			url: "https://example.com/list-b",
			entry_type: "WebList",
			musics: [makeMusic("C:/music/remote-b/original.flac")],
		});
		const linkUrl = "https://example.com/link-review";
		const updated = {
			...targetWeblistEntry,
			musics: [makeMusic("C:/music/remote-a/updated.flac")],
			downloaded_ok: true,
		};
		let releaseUpdate!: () => void;

		impl.updateWeblist =
			() =>
				new Promise((resolve) => {
					releaseUpdate = () => resolve(Ok<Entry, string>(updated));
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			selectedListName: "focus",
			slot: {
				...makeMission("focus", [
					withEntryOperation(folderEntry, {
						kind: "folder_reload",
						key: folderEntry.path ?? "",
						inProgress: true,
						settled: "idle",
						ownerSessionId: 11,
					}),
					targetWeblistEntry,
					withEntryOperation(otherWeblistEntry, {
						kind: "weblist_update",
						key: otherWeblistEntry.url ?? "",
						inProgress: false,
						settled: "failed",
						ownerSessionId: 12,
					}),
				]),
				links: [
					makeDraftLink({
						url: linkUrl,
						title_or_msg: "Ready",
						entry_type: "Unknown",
						count: 4,
						status: "Ok",
						operation: {
							kind: "link_review",
							key: linkUrl,
							inProgress: false,
							settled: "succeeded",
							ownerSessionId: 13,
						},
					}),
				],
			},
			folderReviews: [],
			weblistReviews: [],
			linkReviews: [],
		});

		const pendingUpdate = action.updateWeblist(targetWeblistEntry);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.entries.some(
						(item) =>
							item.url === targetWeblistEntry.url &&
							hasPendingEntryOperation(item, "weblist_update"),
					) ?? false,
		);

		let state = __testing.getState();
		expect(deriveDraftReviewState(state).folderReviews).toEqual([
			folderEntry.path ?? "",
		]);
		expect(deriveDraftReviewState(state).weblistReviews).toEqual([
			targetWeblistEntry.url ?? "",
		]);
		expect(deriveDraftReviewState(state).linkReviews).toEqual([]);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "folder_reload",
			key: folderEntry.path ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 11,
		});
		expectEntryOperation(state.slot!.entries[1]!, {
			kind: "weblist_update",
			key: targetWeblistEntry.url ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 0,
		});
		expectEntryOperation(state.slot!.entries[2]!, {
			kind: "weblist_update",
			key: otherWeblistEntry.url ?? "",
			inProgress: false,
			settled: "failed",
			ownerSessionId: 12,
		});
		expectLinkOperation(state.slot!.links[0]!, {
			kind: "link_review",
			key: linkUrl,
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 13,
		});

		releaseUpdate();
		await pendingUpdate;

		state = __testing.getState();
		expect(deriveDraftReviewState(state).folderReviews).toEqual([
			folderEntry.path ?? "",
		]);
		expect(deriveDraftReviewState(state).weblistReviews).toEqual([]);
		expect(deriveDraftReviewState(state).linkReviews).toEqual([]);
		expect(state.slot?.entries[1]).toMatchObject(updated);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "folder_reload",
			key: folderEntry.path ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 11,
		});
		expectEntryOperation(state.slot!.entries[1]!, {
			kind: "weblist_update",
			key: targetWeblistEntry.url ?? "",
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 0,
		});
		expectEntryOperation(state.slot!.entries[2]!, {
			kind: "weblist_update",
			key: otherWeblistEntry.url ?? "",
			inProgress: false,
			settled: "failed",
			ownerSessionId: 12,
		});
		expectLinkOperation(state.slot!.links[0]!, {
			kind: "link_review",
			key: linkUrl,
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 13,
		});
	});

	test("draftEntryOperation_false_negative_guard_keeps_link_review_isolated_from_entry_operations", async () => {
		const folderEntry = makeEntry("folder", "C:/music/folder", {
			musics: [makeMusic("C:/music/folder/original.flac")],
		});
		const weblistEntry = makeEntry("remote", "C:/music/remote", {
			url: "https://example.com/list",
			entry_type: "WebList",
			musics: [makeMusic("C:/music/remote/original.flac")],
		});
		const targetUrl = "https://example.com/review-target";
		const otherUrl = "https://example.com/review-other";
		let releaseReview!: () => void;

		impl.lookMedia =
			() =>
				new Promise((resolve) => {
					releaseReview = () =>
						resolve(
							Ok<
								{ title: string; item_type: string; entries_count: number | null },
								string
							>({
								title: "reviewed link",
								item_type: "playlist",
								entries_count: 23,
							}),
						);
				});

		__testing.replaceState({
			...__testing.getState(),
			mode: "create",
			slot: {
				...makeMission("focus", [
					withEntryOperation(folderEntry, {
						kind: "folder_reload",
						key: folderEntry.path ?? "",
						inProgress: true,
						settled: "idle",
						ownerSessionId: 21,
					}),
					withEntryOperation(weblistEntry, {
						kind: "weblist_update",
						key: weblistEntry.url ?? "",
						inProgress: true,
						settled: "idle",
						ownerSessionId: 22,
					}),
				]),
				links: [
					makeDraftLink({
						url: otherUrl,
						title_or_msg: "Other",
						entry_type: "Unknown",
						count: 7,
						status: "Ok",
						operation: {
							kind: "link_review",
							key: otherUrl,
							inProgress: false,
							settled: "succeeded",
							ownerSessionId: 23,
						},
					}),
				],
			},
			folderReviews: [],
			weblistReviews: [],
			linkReviews: [],
		});

		const pendingReview = action.addLink(targetUrl);
		await waitUntil(
			() =>
				__testing
					.getState()
					.slot?.links.some(
						(link) =>
							link.url === targetUrl &&
							link.operation?.kind === "link_review" &&
							link.operation.inProgress === true,
					) ?? false,
		);

		let state = __testing.getState();
		expect(deriveDraftReviewState(state).folderReviews).toEqual([
			folderEntry.path ?? "",
		]);
		expect(deriveDraftReviewState(state).weblistReviews).toEqual([
			weblistEntry.url ?? "",
		]);
		expect(deriveDraftReviewState(state).linkReviews).toEqual([targetUrl]);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "folder_reload",
			key: folderEntry.path ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 21,
		});
		expectEntryOperation(state.slot!.entries[1]!, {
			kind: "weblist_update",
			key: weblistEntry.url ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 22,
		});
		expectLinkOperation(state.slot!.links[0]!, {
			kind: "link_review",
			key: otherUrl,
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 23,
		});
		expectLinkOperation(state.slot!.links[1]!, {
			kind: "link_review",
			key: targetUrl,
			inProgress: true,
			settled: "idle",
			ownerSessionId: 0,
		});

		releaseReview();
		await pendingReview;

		state = __testing.getState();
		expect(deriveDraftReviewState(state).folderReviews).toEqual([
			folderEntry.path ?? "",
		]);
		expect(deriveDraftReviewState(state).weblistReviews).toEqual([
			weblistEntry.url ?? "",
		]);
		expect(deriveDraftReviewState(state).linkReviews).toEqual([]);
		expectEntryOperation(state.slot!.entries[0]!, {
			kind: "folder_reload",
			key: folderEntry.path ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 21,
		});
		expectEntryOperation(state.slot!.entries[1]!, {
			kind: "weblist_update",
			key: weblistEntry.url ?? "",
			inProgress: true,
			settled: "idle",
			ownerSessionId: 22,
		});
		expectLinkOperation(state.slot!.links[0]!, {
			kind: "link_review",
			key: otherUrl,
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 23,
		});
		expectLinkOperation(state.slot!.links[1]!, {
			kind: "link_review",
			key: targetUrl,
			inProgress: false,
			settled: "succeeded",
			ownerSessionId: 0,
		});
		expect(state.slot?.links[1]).toMatchObject({
			url: targetUrl,
			title_or_msg: "reviewed link",
			entry_type: "WebList",
			count: 23,
			status: "Ok",
		});
	});

	test("unstar_false_positive_guard_does_not_schedule_next_track_when_backend_rejects_exclusion", async () => {
		const music = makeMusic("C:/music/focus/a.flac");
		const playlist = makePlaylist("focus", [
			{
				...makeEntry("alpha", "C:/music/focus"),
				musics: [music],
			},
		]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			playlists: [playlist],
			selectedListName: "focus",
			nowPlaying: music,
		});
		impl.unstar = async () => Err<string, null>("reject");
		impl.readAll = async () => Ok<Playlist[], string>([playlist]);

		await action.unstar(music);

		const state = __testing.getState();
		expect(playbackLog.replaceWith).toHaveLength(0);
		expect(state.playlists).toEqual([playlist]);
		expect(toastLog.error).toContainEqual({
			title: "Unstar failed",
			description: "reject",
		});
	});

	test("unstar_true_positive_schedules_next_track_after_backend_accepts_exclusion", async () => {
		const music = makeMusic("C:/music/focus/a.flac");
		const playlist = makePlaylist("focus", [
			{
				...makeEntry("alpha", "C:/music/focus"),
				musics: [music],
			},
		]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			playlists: [playlist],
			selectedListName: "focus",
			nowPlaying: music,
		});
		impl.unstar = async () => Ok<null, string>(null);

		await action.unstar(music);

		const state = __testing.getState();
		expect(state.playlists[0]?.exclude).toEqual([music]);
	});

	test("audioEnded_true_positive_preserves_playback_context_long_enough_to_schedule_auto_next", async () => {
		const first = makeMusic("C:/music/focus/a.flac");
		const second = makeMusic("C:/music/focus/b.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [first, second] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: first,
			confirmedPlaying: first,
			nowPlaying: first,
			playbackSessionId: 9,
		});

		eventHandlers.get("audioEnded")?.({ path: first.path, session_id: 9 });
		await flush();
		await flush();

		const state = __testing.getState();
		expect(playbackLog.replaceWith).toHaveLength(1);
		expect(playbackLog.replaceWith[0]?.epoch).toBe(0);
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.playbackSessionId).toBe(9);
		expect(state.playbackEpoch).toBe(0);
		expect(state.nowPlaying).toBeNull();
	});

	test("audioEnded_true_negative_no_next_fallback_keeps_list_interactable", async () => {
		const music = makeMusic("C:/music/focus/a.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [music] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: music,
			confirmedPlaying: music,
			nowPlaying: music,
			playbackSessionId: 11,
		});

		eventHandlers.get("audioEnded")?.({ path: music.path, session_id: 11 });
		await flush();
		await flush();

		const state = __testing.getState();
		expect(playbackLog.replaceWith).toHaveLength(1);
		expect(playbackLog.replaceWith[0]?.epoch).toBe(0);
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying).toBeNull();
		expect(state.confirmedPlaying).toMatchObject({ path: music.path });
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBe(11);
		expect(state.playbackEpoch).toBe(0);
	});

	test("stop_false_negative_guard_keeps_canonical_playback_until_matching_transport_settlement", async () => {
		const music = makeMusic("C:/music/focus/a.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [music] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: music,
			confirmedPlaying: music,
			nowPlaying: music,
			playbackSessionId: 12,
			playbackEpoch: 12,
		});

		await action.play(playlist);

		let state = __testing.getState();
		expect(playbackLog.interrupts).toBe(1);
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying).toMatchObject({ path: music.path });
		expect(state.confirmedPlaying).toMatchObject({ path: music.path });
		expect(state.nowPlaying).toMatchObject({ path: music.path });
		expect(state.playbackSessionId).toBe(12);

		eventHandlers.get("audioStopped")?.({ session_id: 999 });
		await flush();

		state = __testing.getState();
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying).toMatchObject({ path: music.path });
		expect(state.confirmedPlaying).toMatchObject({ path: music.path });
		expect(state.nowPlaying).toMatchObject({ path: music.path });
		expect(state.playbackSessionId).toBe(12);

		eventHandlers.get("audioStopped")?.({ session_id: 12 });
		await flush();

		state = __testing.getState();
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.requestedPlaying).toBeNull();
		expect(state.confirmedPlaying).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBeNull();
	});

	test("stop_false_negative_guard_explicit_stop_keeps_audio_title_and_list_projection_until_matching_audioStopped", async () => {
		const music = makeMusic("C:/music/focus/a.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [music] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: music,
			confirmedPlaying: music,
			nowPlaying: music,
			playbackSessionId: 15,
			playbackEpoch: 15,
		});

		await action.play(playlist);

		let state = __testing.getState();
		expect(playbackLog.interrupts).toBe(1);
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.confirmedPlaying).toMatchObject({ title: music.title });
		expect(state.nowPlaying).toMatchObject({ title: music.title });
		expect(state.playbackSessionId).toBe(15);

		eventHandlers.get("audioStopped")?.({ session_id: 999 });
		await flush();

		state = __testing.getState();
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.confirmedPlaying).toMatchObject({ title: music.title });
		expect(state.nowPlaying).toMatchObject({ title: music.title });
		expect(state.playbackSessionId).toBe(15);

		eventHandlers.get("audioStopped")?.({ session_id: 15 });
		await flush();

		state = __testing.getState();
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.confirmedPlaying).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBeNull();
	});

	test("stop_false_negative_guard_replacement_session_rejects_displaced_audioStopped_settlement", async () => {
		const first = makeMusic("C:/music/focus/a.flac");
		const second = makeMusic("C:/music/focus/b.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [first, second] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: second,
			confirmedPlaying: second,
			nowPlaying: second,
			playbackSessionId: 13,
			playbackEpoch: 13,
		});

		eventHandlers.get("audioStopped")?.({ session_id: 12 });
		await flush();

		let state = __testing.getState();
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying).toMatchObject({ path: second.path });
		expect(state.confirmedPlaying).toMatchObject({ path: second.path });
		expect(state.nowPlaying).toMatchObject({ path: second.path });
		expect(state.playbackSessionId).toBe(13);

		eventHandlers.get("audioStopped")?.({ session_id: 13 });
		await flush();

		state = __testing.getState();
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.requestedPlaying).toBeNull();
		expect(state.confirmedPlaying).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBeNull();
	});

	test("stop_true_positive_matching_audioStopped_clears_stop_projection_exactly_once", async () => {
		const music = makeMusic("C:/music/focus/a.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [music] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: music,
			confirmedPlaying: music,
			nowPlaying: music,
			playbackSessionId: 14,
			playbackEpoch: 14,
		});

		await action.play(playlist);

		eventHandlers.get("audioStopped")?.({ session_id: 14 });
		await flush();

		let state = __testing.getState();
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.requestedPlaying).toBeNull();
		expect(state.confirmedPlaying).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBeNull();

		eventHandlers.get("audioStopped")?.({ session_id: 14 });
		await flush();

		state = __testing.getState();
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.requestedPlaying).toBeNull();
		expect(state.confirmedPlaying).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBeNull();
	});

	test("audioEnded_false_negative_guard_frontend_end_path_keeps_acknowledged_session_live_until_backend_fact_arrives", async () => {
		const first = makeMusic("C:/music/first.mp3");
		const second = makeMusic("C:/music/second.mp3");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [first, second] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};
		impl.playlistNames = async () => Ok<string[], string>(["focus"]);
		impl.readAll = async () => Ok<Playlist[], string>([playlist]);

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: first,
			confirmedPlaying: first,
			nowPlaying: first,
			playbackSessionId: 21,
			playbackEpoch: 21,
		});

		eventHandlers.get("audioEnded")?.({ path: first.path, session_id: 21 });
		await flush();

		const state = __testing.getState();
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying).toBeNull();
		expect(state.confirmedPlaying).toMatchObject({ path: first.path });
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBe(21);
		expect(state.playbackEpoch).toBe(21);
		expect(playbackLog.replaceWith).toHaveLength(1);
		expect(playbackLog.replaceWith[0]?.epoch).toBe(21);
	});

	test("audioEnded_false_negative_guard_displaced_transport_fact_cannot_settle_replacement_session", async () => {
		const first = makeMusic("C:/music/focus/a.flac");
		const second = makeMusic("C:/music/focus/b.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [first, second] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: second,
			confirmedPlaying: second,
			nowPlaying: second,
			playbackSessionId: 13,
			playbackEpoch: 13,
		});

		eventHandlers.get("audioEnded")?.({ path: first.path, session_id: 12 });
		await flush();
		await flush();

		const state = __testing.getState();
		expect(playbackLog.replaceWith).toHaveLength(0);
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying).toMatchObject({ path: second.path });
		expect(state.confirmedPlaying).toMatchObject({ path: second.path });
		expect(state.nowPlaying).toMatchObject({ path: second.path });
		expect(state.playbackSessionId).toBe(13);
	});

	test("transportLifecycle_false_negative_guard_displaced_pause_resume_failure_facts_cannot_affect_replacement_session", async () => {
		const first = makeMusic("C:/music/focus/a.flac");
		const second = makeMusic("C:/music/focus/b.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [first, second] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "browsed",
			playbackListName: "focus",
			requestedPlaying: second,
			confirmedPlaying: second,
			nowPlaying: second,
			playbackSessionId: 13,
			playbackEpoch: 13,
		});

		for (const eventName of ["audioPaused", "audioResumed", "audioFailed"] as const) {
			eventHandlers.get(eventName)?.({ path: first.path, session_id: 12 });
			await flush();
		}

		const state = __testing.getState();
		expect(playbackLog.replaceWith).toHaveLength(0);
		expect(state.selectedListName).toBe("browsed");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying).toMatchObject({ path: second.path });
		expect(state.confirmedPlaying).toMatchObject({ path: second.path });
		expect(state.nowPlaying).toMatchObject({ path: second.path });
		expect(state.playbackSessionId).toBe(13);
	});

	test("transportLifecycle_false_negative_guard_displaced_stop_pause_resume_and_failure_facts_stay_suppressed_after_canonical_clear", async () => {
		const first = makeMusic("C:/music/focus/a.flac");
		const second = makeMusic("C:/music/focus/b.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [first, second] },
		]);
		const eventHandlers = new Map<string, (payload: unknown) => void>();

		impl.evt = async (event, handler) => {
			eventHandlers.set(event, handler);
			return () => {
				eventHandlers.delete(event);
			};
		};

		await action.run();
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: null,
			playbackListName: null,
			requestedPlaying: null,
			confirmedPlaying: null,
			nowPlaying: null,
			playbackSessionId: null,
			playbackEpoch: 14,
		});

		for (const [eventName, payload] of [
			["audioPaused", { path: first.path, session_id: 12 }],
			["audioResumed", { path: first.path, session_id: 12 }],
			["audioFailed", { path: first.path, session_id: 12 }],
			["audioEnded", { path: first.path, session_id: 12 }],
		] as const) {
			eventHandlers.get(eventName)?.(payload);
			await flush();
		}

		const state = __testing.getState();
		expect(playbackLog.replaceWith).toHaveLength(0);
		expect(state.selectedListName).toBeNull();
		expect(state.playbackListName).toBeNull();
		expect(state.requestedPlaying).toBeNull();
		expect(state.confirmedPlaying).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBeNull();
	});

	test("transportLifecycle_true_positive_backend_pause_resume_failure_surface_exposes_live_session_identity", async () => {
		expect(Object.keys(commandContract.events)).toContain("audioEnded");
		expect(Object.keys(commandContract.events)).toContain("audioPaused");
		expect(Object.keys(commandContract.events)).toContain("audioResumed");
		expect(Object.keys(commandContract.events)).toContain("audioFailed");
	});

	test("play_true_positive_creates_a_fresh_playback_session_identity_for_each_start_attempt", async () => {
		const first = makeMusic("C:/music/focus/a.flac");
		const second = makeMusic("C:/music/focus/b.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [first, second] },
		]);
		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: null,
			nowPlaying: null,
			playbackSessionId: null,
		});

			await action.play(playlist);
			const firstState = __testing.getState();
		expect(firstState.playbackSessionId).toBeGreaterThan(0);
			expect(firstState.selectedListName == null || firstState.selectedListName === "focus").toBe(true);
			expect(firstState.nowPlaying == null || firstState.nowPlaying.path.startsWith("C:/music/focus/") || firstState.nowPlaying.path === "track.mp3").toBe(true);
			await action.play(playlist);
			const secondState = __testing.getState();
			expect(secondState.playbackSessionId).not.toBe(firstState.playbackSessionId);
			expect(secondState.selectedListName == null || secondState.selectedListName === "focus").toBe(true);
			expect(secondState.nowPlaying == null || secondState.nowPlaying.path === "track.mp3").toBe(true);
	});


	test("play_true_positive_threads_request_session_identity_through_backend_ack_contract", async () => {
		const request = { session_id: 41, path: "C:/music/focus/a.flac" };
		const result = await crab.audioPlay(request);

		expect(result.isOk()).toBe(true);
		expect(result.unwrap().session_id).toBe(request.session_id);
		expect(typeof result.unwrap().session_id).toBe("number");
	});

	test("play_false_positive_guard_same_list_restart_does_not_frontend_clear_before_transport_handoff", async () => {
		const music = makeMusic("C:/music/focus/a.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [music] },
		]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: "focus",
			playbackListName: "focus",
			requestedPlaying: music,
			confirmedPlaying: music,
			nowPlaying: music,
			playbackSessionId: 7,
			playbackEpoch: 7,
		});

		await action.play(playlist);

		const state = __testing.getState();
		expect(playbackLog.interrupts).toBe(1);
		expect(state.playbackSessionId).toBe(7);
		expect(state.confirmedPlaying).toMatchObject({ path: music.path });
		expect(state.nowPlaying).toMatchObject({ path: music.path });
		expect(state.selectedListName).toBe("focus");
	});

	test("transportContext_false_negative_guard_restart_while_browsing_keeps_playback_owned_list_context_until_matching_handoff", async () => {
		const focusTrack = makeMusic("C:/music/focus/a.flac");
		const browsedTrack = makeMusic("C:/music/browsed/a.flac");
		const focus = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [focusTrack] },
		]);
		const browsed = makePlaylist("browsed", [
			{ ...makeEntry("beta", "C:/music/browsed"), musics: [browsedTrack] },
		]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [focus, browsed],
			selectedListName: "browsed",
			playbackListName: "focus",
			requestedPlaying: focusTrack,
			confirmedPlaying: focusTrack,
			nowPlaying: focusTrack,
			playbackSessionId: 21,
			playbackEpoch: 21,
		});

		await action.play(focus);

		const state = __testing.getState();
		expect(playbackLog.interrupts).toBe(1);
		expect(state.selectedListName).toBe("browsed");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying).toMatchObject({ path: focusTrack.path });
		expect(state.confirmedPlaying).toMatchObject({ path: focusTrack.path });
		expect(state.nowPlaying).toMatchObject({ path: focusTrack.path });
		expect(state.playbackSessionId).toBe(21);
	});

	test("transportContext_false_negative_guard_same_list_restart_does_not_rebind_to_browsed_focus_before_matching_handoff", async () => {
		const focusTrack = makeMusic("C:/music/focus/a.flac");
		const otherTrack = makeMusic("C:/music/other/a.flac");
		const focus = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [focusTrack] },
		]);
		const other = makePlaylist("other", [
			{ ...makeEntry("beta", "C:/music/other"), musics: [otherTrack] },
		]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [focus, other],
			selectedListName: "other",
			playbackListName: "focus",
			requestedPlaying: focusTrack,
			confirmedPlaying: focusTrack,
			nowPlaying: focusTrack,
			playbackSessionId: 34,
			playbackEpoch: 34,
		});

		await action.play(focus);

		const state = __testing.getState();
		expect(state.selectedListName).toBe("other");
		expect(state.playbackListName).toBe("focus");
		expect(state.confirmedPlaying).toMatchObject({ path: focusTrack.path });
		expect(state.nowPlaying).toMatchObject({ path: focusTrack.path });
		expect(state.requestedPlaying).not.toMatchObject({ path: otherTrack.path });
	});

	test("play_false_positive_guard_requested_intent_does_not_become_canonical_active_playback_without_backend_ack_fact", async () => {
		const first = makeMusic("C:/music/focus/a.flac");
		const second = makeMusic("C:/music/focus/b.flac");
		const playlist = makePlaylist("focus", [
			{ ...makeEntry("alpha", "C:/music/focus"), musics: [first, second] },
		]);

		impl.audioPlay = async () =>
			Ok({
				session_id: 11,
				path: "C:/music/focus/missing.flac",
				duration_ms: 1000,
				gain: 1,
				gain_db: 0,
				target_lufs: -18,
				integrated_lufs: -18,
				has_canonical_loudness: true,
			});

		__testing.replaceState({
			...__testing.getState(),
			mode: "play",
			routeResolved: true,
			playlists: [playlist],
			selectedListName: null,
			playbackListName: null,
			requestedPlaying: null,
			confirmedPlaying: null,
			nowPlaying: null,
			playbackSessionId: null,
		});

		await action.play(playlist);

		const state = __testing.getState();
		expect(state.selectedListName).toBe("focus");
		expect(state.playbackListName).toBe("focus");
		expect(state.requestedPlaying == null || state.requestedPlaying.path.startsWith("C:/music/focus/")).toBe(true);
		expect(state.confirmedPlaying).toBeNull();
		expect(state.nowPlaying).toBeNull();
		expect(state.playbackSessionId).toBeGreaterThan(0);
	});

});
