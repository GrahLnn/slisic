import { describe, expect, test } from "bun:test";
import type {
	Entry,
	ImportFolderEntry,
	Music,
	Playlist,
} from "@/src/cmd/commands";
import {
	applyOptimisticEditSave,
	buildOptimisticPlaylistFromSlot,
	buildPostSavePatch,
	deriveRefreshPatch,
	hasPlaybackContext,
	type MusicState,
	mapImportFolderEntryToEntry,
	shouldAdvanceOnUnstar,
	shouldHandleAudioEnded,
} from "./store";

const baseState: MusicState = {
	mode: "play",
	loading: false,
	playlists: [],
	selectedListName: "contemporary",
	nowPlaying: {
		path: "C:/audio/a.flac",
		title: "A",
		avg_db: -18,
		integrated_lufs: -18,
		true_peak_dbtp: -2,
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
	},
	nowJudge: null,
	slot: null,
	processMsg: null,
	ytdlp: null,
	ffmpeg: null,
	savePath: null,
	linkReviews: [],
	folderReviews: [],
	weblistReviews: [],
	playbackEpoch: 3,
};

function makePlaylist(name: string): Playlist {
	return {
		name,
		avg_db: null,
		entries: [],
		exclude: [],
	};
}

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

function makeEntry(name: string, path: string): Entry {
	return {
		path,
		name,
		musics: [makeMusic(`${path}/a.flac`)],
		avg_db: null,
		url: null,
		downloaded_ok: true,
		tracking: false,
		entry_type: "Local",
	};
}

describe("music interaction guards", () => {
	test("shouldAdvanceOnUnstar only true for current playing item in current play list", () => {
		expect(
			shouldAdvanceOnUnstar(baseState, "contemporary", "C:/audio/a.flac"),
		).toBe(true);
		expect(
			shouldAdvanceOnUnstar(baseState, "contemporary", "C:/audio/b.flac"),
		).toBe(false);
		expect(
			shouldAdvanceOnUnstar(
				{ ...baseState, selectedListName: "other" },
				"contemporary",
				"C:/audio/a.flac",
			),
		).toBe(false);
		expect(
			shouldAdvanceOnUnstar(
				{ ...baseState, mode: "edit" },
				"contemporary",
				"C:/audio/a.flac",
			),
		).toBe(false);
	});

	test("buildPostSavePatch should clear playback context and keep mode by data presence", () => {
		const withData = buildPostSavePatch(true, 9);
		expect(withData.mode).toBe("play");
		expect(withData.selectedListName).toBeNull();
		expect(withData.nowPlaying).toBeNull();
		expect(withData.playbackEpoch).toBe(9);

		const empty = buildPostSavePatch(false, 12);
		expect(empty.mode).toBe("new_guide");
		expect(empty.selectedListName).toBeNull();
		expect(empty.nowPlaying).toBeNull();
		expect(empty.playbackEpoch).toBe(12);
	});

	test("hasPlaybackContext should reject stale playback fields outside play mode", () => {
		expect(hasPlaybackContext(baseState)).toBe(true);
		expect(hasPlaybackContext({ ...baseState, mode: "edit" })).toBe(false);
		expect(hasPlaybackContext({ ...baseState, mode: "create" })).toBe(false);
		expect(
			hasPlaybackContext({
				...baseState,
				selectedListName: null,
				nowPlaying: null,
			}),
		).toBe(false);
	});

	test("shouldHandleAudioEnded should reject cross-mode or cross-track event bridging", () => {
		expect(shouldHandleAudioEnded(baseState, "C:/audio/a.flac")).toBe(true);
		expect(shouldHandleAudioEnded(baseState, "C:/audio/b.flac")).toBe(false);
		expect(
			shouldHandleAudioEnded(
				{ ...baseState, selectedListName: null },
				"C:/audio/a.flac",
			),
		).toBe(false);
		expect(
			shouldHandleAudioEnded(
				{ ...baseState, nowPlaying: null },
				"C:/audio/a.flac",
			),
		).toBe(false);
		expect(
			shouldHandleAudioEnded({ ...baseState, mode: "edit" }, "C:/audio/a.flac"),
		).toBe(false);
	});

	test("deriveRefreshPatch should preserve edit/create mode and clear impossible playback context", () => {
		const playlists = [makePlaylist("contemporary"), makePlaylist("ambient")];

		const keepPlay = deriveRefreshPatch(baseState, playlists);
		expect(keepPlay.mode).toBe("play");
		expect(keepPlay.selectedListName).toBe("contemporary");
		expect(keepPlay.nowPlaying?.path).toBe("C:/audio/a.flac");

		const lostSelection = deriveRefreshPatch(
			{ ...baseState, selectedListName: "missing" },
			playlists,
		);
		expect(lostSelection.mode).toBe("play");
		expect(lostSelection.selectedListName).toBeNull();
		expect(lostSelection.nowPlaying).toBeNull();

		const editMode = deriveRefreshPatch(
			{ ...baseState, mode: "edit", selectedListName: "missing" },
			[],
		);
		expect(editMode.mode).toBe("edit");
		expect(editMode.selectedListName).toBeNull();
		expect(editMode.nowPlaying).toBeNull();

		const createMode = deriveRefreshPatch(
			{ ...baseState, mode: "create", selectedListName: "missing" },
			[],
		);
		expect(createMode.mode).toBe("create");
		expect(createMode.selectedListName).toBeNull();
		expect(createMode.nowPlaying).toBeNull();

		const emptyPlay = deriveRefreshPatch(
			{ ...baseState, mode: "play", selectedListName: "missing" },
			[],
		);
		expect(emptyPlay.mode).toBe("new_guide");
	});

	test("buildOptimisticPlaylistFromSlot should project slot to playlist shape", () => {
		const playlist = buildOptimisticPlaylistFromSlot(
			{
				name: "  modern  ",
				folders: [],
				links: [],
				entries: [makeEntry("alpha", "C:/music/alpha")],
				exclude: [],
			},
			makePlaylist("anchor"),
		);
		expect(playlist.name).toBe("modern");
		expect(playlist.avg_db).toBeNull();
		expect(Array.isArray(playlist.entries)).toBe(true);
		expect(Array.isArray(playlist.exclude)).toBe(true);
	});

	test("applyOptimisticEditSave should replace anchor playlist in place", () => {
		const first = makePlaylist("a");
		const second = makePlaylist("b");
		const next = applyOptimisticEditSave([first, second], first, {
			name: "renamed",
			folders: [],
			links: [],
			entries: [],
			exclude: [],
		});
		expect(next).toHaveLength(2);
		expect(next[0].name).toBe("renamed");
		expect(next[1].name).toBe("b");
	});

	test("mapImportFolderEntryToEntry should preserve metadata-backed web origin", () => {
		const imported: ImportFolderEntry = {
			path: "C:/music/archive/lofi-set",
			items: [
				"C:/music/archive/lofi-set/a.mp3",
				"C:/music/archive/lofi-set/b.mp3",
			],
			url: "https://example.com/playlist/123",
			entry_type: "WebList",
		};

		const entry = mapImportFolderEntryToEntry(imported);
		expect(entry.path).toBe(imported.path);
		expect(entry.name).toBe("lofi-set");
		expect(entry.url).toBe(imported.url);
		expect(entry.entry_type).toBe("WebList");
		expect(entry.downloaded_ok).toBe(true);
		expect(entry.musics.map((music) => music.path)).toEqual(imported.items);
	});

	test("deriveRefreshPatch keeps legacy-only playback stale until re-scan and preserves canonical reload state", () => {
		const legacyOnly: Music = {
			...makeMusic("C:/audio/legacy.flac"),
			avg_db: -14,
		};
		const canonicalReady: Music = {
			...makeMusic("C:/audio/canonical.flac"),
			integrated_lufs: -18.4,
			true_peak_dbtp: -1.1,
			loudness_range_lu: 4.7,
			analyzed_at_ms: 111,
			analysis_version: 1,
			source_mtime_ms: 222,
			source_size_bytes: 333,
			normalization_status: "Ready",
		};

		const staleReload = deriveRefreshPatch(
			{
				...baseState,
				selectedListName: "legacy",
				nowPlaying: legacyOnly,
			},
			[
				{
					name: "legacy",
					avg_db: null,
					entries: [
						{
							path: "C:/audio",
							name: "legacy-entry",
							musics: [legacyOnly],
							avg_db: null,
							url: null,
							downloaded_ok: true,
							tracking: false,
							entry_type: "Local",
						},
					],
					exclude: [],
				},
			],
		);

		expect(staleReload.mode).toBe("play");
		expect(staleReload.nowPlaying?.avg_db).toBe(-14);
		expect(staleReload.nowPlaying?.integrated_lufs).toBeNull();
		expect(staleReload.nowPlaying?.normalization_status).toBeNull();

		const canonicalReload = deriveRefreshPatch(
			{
				...baseState,
				selectedListName: "canonical",
				nowPlaying: canonicalReady,
			},
			[
				{
					name: "canonical",
					avg_db: -18.4,
					entries: [
						{
							path: "C:/audio",
							name: "canonical-entry",
							musics: [canonicalReady],
							avg_db: -18.4,
							url: null,
							downloaded_ok: true,
							tracking: false,
							entry_type: "Local",
						},
					],
					exclude: [],
				},
			],
		);

		expect(canonicalReload.nowPlaying?.integrated_lufs).toBe(-18.4);
		expect(canonicalReload.nowPlaying?.true_peak_dbtp).toBe(-1.1);
		expect(canonicalReload.nowPlaying?.normalization_status).toBe("Ready");
	});

	test("deriveRefreshPatch refreshes nowPlaying from playlist data after canonical re-scan", () => {
		const staleNowPlaying: Music = {
			...makeMusic("C:/audio/propagation.flac"),
			avg_db: -14,
			integrated_lufs: null,
			true_peak_dbtp: null,
			loudness_range_lu: null,
			normalization_status: null,
		};

		const refreshedCanonical: Music = {
			...staleNowPlaying,
			avg_db: -17.4,
			integrated_lufs: -17.4,
			true_peak_dbtp: -0.9,
			loudness_range_lu: 5.6,
			analyzed_at_ms: 777,
			analysis_version: 1,
			source_mtime_ms: 888,
			source_size_bytes: 999,
			normalization_status: "Ready",
			normalization_error: null,
		};

		const refreshed = deriveRefreshPatch(
			{
				...baseState,
				selectedListName: "rescanned",
				nowPlaying: staleNowPlaying,
			},
			[
				{
					name: "rescanned",
					avg_db: -17.4,
					entries: [
						{
							path: "C:/audio",
							name: "rescanned-entry",
							musics: [refreshedCanonical],
							avg_db: -17.4,
							url: null,
							downloaded_ok: true,
							tracking: false,
							entry_type: "Local",
						},
					],
					exclude: [],
				},
			],
		);

		expect(refreshed.nowPlaying).toEqual(refreshedCanonical);
		expect(refreshed.nowPlaying).not.toBe(staleNowPlaying);
		expect(refreshed.nowPlaying?.avg_db).toBe(-17.4);
		expect(refreshed.nowPlaying?.integrated_lufs).toBe(-17.4);
		expect(refreshed.nowPlaying?.true_peak_dbtp).toBe(-0.9);
		expect(refreshed.nowPlaying?.normalization_status).toBe("Ready");
	});
});
