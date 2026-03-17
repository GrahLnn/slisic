import { Err, Ok } from "@grahlnn/fn";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
	CollectMission,
	Entry,
	Music,
	Playlist,
} from "@/src/cmd/commands";

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
	audioPlay: (req: { path: string }) => {
		void req;
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

const { __testing, action, deriveRouteResolution } = await import("./store");

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

function makeMission(name: string, entries: Entry[] = []): CollectMission {
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
		expect(__testing.getState().playlists).toEqual([pending]);

		handlers.get("processResult")?.(undefined);
		await flush();

		const state = __testing.getState();
		expect(state.playlists).toEqual([downloaded]);

		handlers.get("processMsg")?.({
			playlist: "focus",
			str: "Analyzing loudness 1/1: a.mp3",
		});
		await flush();

		const analyzing = __testing.getState();
		expect(analyzing.playlists).toEqual([downloaded]);
		expect(analyzing.processMsg).toEqual({
			playlist: "focus",
			str: "Analyzing loudness 1/1: a.mp3",
		});
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
			slot,
			linkReviews: ["https://example.com"],
			processMsg: { playlist: "focus", str: "working" },
		});

		await action.back();

		const state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.slot).toEqual(slot);
		expect(state.selectedListName).toBe("focus");
		expect(state.processMsg).toEqual({ playlist: "focus", str: "working" });
		expect(state.linkReviews).toEqual(["https://example.com"]);
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
			slot: mission,
			ffmpeg: { installed_path: "ffmpeg", installed_version: "7.0.0" },
			savePath: "C:/music",
			linkReviews: ["https://example.com"],
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
		expect(state.slot).toEqual(mission);
		expect(state.selectedListName).toBe("focus");
		expect(state.linkReviews).toEqual(["https://example.com"]);
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
		expect(state.slot).toEqual(mission);
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
		await waitUntil(() => __testing.getState().folderReviews.includes(entryPath));

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
		await waitUntil(() => __testing.getState().folderReviews.includes(original.path ?? ""));

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
		await waitUntil(() => __testing.getState().folderReviews.includes(entry.path ?? ""));

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
		expect(state.slot?.entries).toEqual([draftUpdate]);
		expect(state.playlists).toEqual([persistedPlaylist]);

		await refresh();

		state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.slot?.entries).toEqual([draftUpdate]);
		expect(state.playlists).toEqual([refreshedPlaylist]);

		await saveDraftAndWaitForReload();

		state = __testing.getState();
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]?.mission.entries).toEqual([draftUpdate]);
		expect(updateCalls[0]?.anchor).toEqual(persistedPlaylist);
		expect(state.mode).toBe("play");
		expect(state.playlists).toEqual([persistedPlaylist]);
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
		await waitUntil(() => __testing.getState().folderReviews.includes(entry.path ?? ""));

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
		await waitUntil(() => __testing.getState().folderReviews.includes(entry.path ?? ""));

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
		const refreshedPlaylist = makePlaylist("focus", [updated]);
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
		await waitUntil(() => __testing.getState().folderReviews.includes(persisted.path ?? ""));

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
		expect(state.playlists).toEqual([persistedPlaylist]);

		releaseSave();
		await pendingSave;
		await flush();

		state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.folderReviews).toEqual([]);
		expect(state.playlists).toEqual([persistedPlaylist]);
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
		expect(state.slot?.entries).toEqual([updated]);
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
		await waitUntil(() => {
			const url = entry.url;
			return !!url && __testing.getState().weblistReviews.includes(url);
		});

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
		await waitUntil(() => {
			const url = entry.url;
			return !!url && __testing.getState().weblistReviews.includes(url);
		});

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
		await waitUntil(() => {
			const url = entry.url;
			return !!url && __testing.getState().weblistReviews.includes(url);
		});

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
		expect(state.slot?.entries).toEqual([draftUpdate]);
		expect(state.playlists).toEqual([persistedPlaylist]);

		await refresh();

		state = __testing.getState();
		expect(state.mode).toBe("edit");
		expect(state.slot?.entries).toEqual([draftUpdate]);
		expect(state.playlists).toEqual([persistedPlaylist]);

		await saveDraftAndWaitForReload();

		state = __testing.getState();
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]?.mission.entries).toEqual([draftUpdate]);
		expect(updateCalls[0]?.anchor).toEqual(persistedPlaylist);
		expect(state.mode).toBe("play");
		expect(state.playlists).toEqual([persistedPlaylist]);
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
		await waitUntil(() => {
			const url = persisted.url;
			return !!url && __testing.getState().weblistReviews.includes(url);
		});

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
		const refreshedPlaylist = makePlaylist("focus", [updated]);
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
		await waitUntil(() => {
			const url = persisted.url;
			return !!url && __testing.getState().weblistReviews.includes(url);
		});

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
		expect(state.playlists).toEqual([refreshedPlaylist]);
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
		const refreshedPlaylist = makePlaylist("focus", [updated]);
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
		await waitUntil(() => {
			const url = persisted.url;
			return !!url && __testing.getState().weblistReviews.includes(url);
		});

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
		expect(state.playlists).toEqual([refreshedPlaylist]);

		releaseSave();
		await pendingSave;
		await flush();

		state = __testing.getState();
		expect(state.mode).toBe("play");
		expect(state.slot).toBeNull();
		expect(state.selectedListName).toBeNull();
		expect(state.weblistReviews).toEqual([]);
		expect(state.playlists).toEqual([refreshedPlaylist]);
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
		await waitUntil(() => __testing.getState().linkReviews.includes(url));

		action.removeLink(url);
		release();
		await pending;

		const state = __testing.getState();
		expect(state.linkReviews).toEqual([]);
		expect(state.slot).toEqual(mission);
		expect(state.slot?.links).toEqual([]);
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
});
