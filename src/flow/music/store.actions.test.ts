import { Err, Ok } from "@grahlnn/fn";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CollectMission, Entry, Music, Playlist } from "@/src/cmd/commands";

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
	appReady: async () => undefined,
	checkExists: async () => Ok<null, string>(null),
	ffmpegCheckExists: async () => Ok<null, string>(null),
	resolveSavePath: async () => Ok<string, string>("C:/music"),
	bootstrapNormalization: async () => Ok<number, string>(0),
	readAll: async () => Ok<Playlist[], string>([]),
	create: async (_data: CollectMission) => Ok<null, string>(null),
	update: async (_data: CollectMission, _anchor: Playlist) =>
		Ok<null, string>(null),
	audioStop: async () => Ok<null, string>(null),
	unstar: async (_list: Playlist, _music: Music) => Ok<null, string>(null),
	recheckFolder: async (entry: Entry) => Ok<Entry, string>(entry),
	updateWeblist: async (entry: Entry, _playlist: string) =>
		Ok<Entry, string>(entry),
	collectImportFolderEntries: async () => Ok<never[], string>([]),
	lookMedia: async () =>
		Ok<{ title: string; item_type: string; entries_count: number | null }, string>({
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
			void handler;
			return () => {};
		};
	},
	appReady: () => impl.appReady(),
	checkExists: () => impl.checkExists(),
	ffmpegCheckExists: () => impl.ffmpegCheckExists(),
	resolveSavePath: () => impl.resolveSavePath(),
	bootstrapNormalization: () => impl.bootstrapNormalization(),
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
	audioPlay: () => impl.audioPlay(),
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

const { __testing, action } = await import("./store");

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

function makeEntry(name: string, path: string, patch: Partial<Entry> = {}): Entry {
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

function makePlaylist(name: string, entries: Entry[] = [], exclude: Music[] = []): Playlist {
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

beforeEach(() => {
	toastLog.error.length = 0;
	toastLog.success.length = 0;
	playbackLog.interrupts = 0;
	playbackLog.replaceWith.length = 0;
	playbackLog.markActive = 0;
	playbackLog.markDisposed = 0;
	__testing.reset();

	impl.appReady = async () => undefined;
	impl.checkExists = async () => Ok<null, string>(null);
	impl.ffmpegCheckExists = async () => Ok<null, string>(null);
	impl.resolveSavePath = async () => Ok<string, string>("C:/music");
	impl.bootstrapNormalization = async () => Ok<number, string>(0);
	impl.readAll = async () => Ok<Playlist[], string>([]);
	impl.create = async (_data: CollectMission) => Ok<null, string>(null);
	impl.update = async (_data: CollectMission, _anchor: Playlist) =>
		Ok<null, string>(null);
	impl.audioStop = async () => Ok<null, string>(null);
	impl.unstar = async (_list: Playlist, _music: Music) => Ok<null, string>(null);
	impl.recheckFolder = async (entry: Entry) => Ok<Entry, string>(entry);
	impl.updateWeblist = async (entry: Entry, _playlist: string) =>
		Ok<Entry, string>(entry);
});

describe("music store action contracts", () => {
	test("run_false_negative_guard_bootstrap_error_does_not_block_read_all_sync", async () => {
		const playlist = makePlaylist("ambient");
		impl.bootstrapNormalization = async () =>
			Err<string, number>("bootstrap failed");
		impl.readAll = async () => Ok<Playlist[], string>([playlist]);

		await action.run();

		const state = __testing.getState();
		expect(state.initialized).toBe(true);
		expect(state.loading).toBe(false);
		expect(state.playlists).toEqual([playlist]);
		expect(playbackLog.markActive).toBe(1);
		expect(toastLog.error).toContainEqual({
			title: "Normalization update skipped",
			description: "bootstrap failed",
		});
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
		});
		impl.create = async (data: CollectMission) => {
			calls.push(data);
			return Ok<null, string>(null);
		};
		impl.readAll = async () => Ok<Playlist[], string>([playlist]);

		await action.save();

		const state = __testing.getState();
		expect(calls).toHaveLength(1);
		expect(state.mode).toBe("play");
		expect(state.loading).toBe(false);
		expect(state.slot).toBeNull();
		expect(state.playlists).toEqual([playlist]);
		expect(toastLog.success).toContainEqual({ title: "Playlist saved" });
	});

	test("save_false_positive_guard_update_error_rolls_back_optimistic_edit_after_refresh", async () => {
		const original = makePlaylist("focus", [makeEntry("alpha", "C:/music/alpha")]);
		const mission = makeMission("renamed", [makeEntry("beta", "C:/music/beta")]);

		__testing.replaceState({
			...__testing.getState(),
			mode: "edit",
			playlists: [original],
			selectedListName: "focus",
			slot: mission,
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
		expect(playbackLog.interrupts).toBe(1);
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
		expect(playbackLog.interrupts).toBe(1);
		expect(playbackLog.replaceWith).toHaveLength(1);
		expect(state.playlists[0]?.exclude).toEqual([music]);
	});
});
