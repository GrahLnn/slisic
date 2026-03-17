import { describe, expect, test } from "bun:test";
import type {
	Entry,
	ImportFolderEntry,
	Music,
	Playlist,
} from "@/src/cmd/commands";
import {
	applyOptimisticEditSave,
	buildPlaylistPlaceholders,
	buildOptimisticPlaylistFromSlot,
	buildPostSavePatch,
	canExitWorkspace,
	deriveSaveAffordance,
	deriveBackTransition,
	deriveRouteResolution,
	deriveProbePatch,
	deriveRefreshPatch,
	hasPlaybackContext,
	type MusicState,
	projectWorkspaceScreen,
	mapImportFolderEntryToEntry,
	shouldAdvanceOnUnstar,
	shouldHandleAudioEnded,
} from "./store";

const baseState: MusicState = {
	mode: "play",
	routeResolved: true,
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

const installedFfmpeg = {
	installed_path: "ffmpeg",
	installed_version: "7.0.0",
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
		expect(withData.routeResolved).toBe(true);
		expect(withData.selectedListName).toBeNull();
		expect(withData.nowPlaying).toBeNull();
		expect(withData.playbackEpoch).toBe(9);

		const empty = buildPostSavePatch(false, 12);
		expect(empty.mode).toBe("new_guide");
		expect(empty.routeResolved).toBe(true);
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

	test("projectWorkspaceScreen exposes canonical guide play create and edit projections", () => {
		expect(
			projectWorkspaceScreen({ ...baseState, routeResolved: false, mode: "edit" }),
		).toBe("unresolved");
		expect(
			projectWorkspaceScreen({ ...baseState, routeResolved: true, mode: "new_guide" }),
		).toBe("guide");
		expect(
			projectWorkspaceScreen({ ...baseState, routeResolved: true, mode: "play" }),
		).toBe("play");
		expect(
			projectWorkspaceScreen({ ...baseState, routeResolved: true, mode: "create" }),
		).toBe("create");
		expect(
			projectWorkspaceScreen({ ...baseState, routeResolved: true, mode: "edit" }),
		).toBe("edit");
	});

	test("canExitWorkspace blocks back whenever review work is active", () => {
		expect(canExitWorkspace({ ...baseState, linkReviews: ["https://a"] })).toBe(
			false,
		);
		expect(canExitWorkspace({ ...baseState, folderReviews: ["C:/folder"] })).toBe(
			false,
		);
		expect(canExitWorkspace({ ...baseState, weblistReviews: ["https://b"] })).toBe(
			false,
		);
		expect(canExitWorkspace(baseState)).toBe(true);
	});

	test("deriveSaveAffordance only allows persistable non-duplicate drafts with ffmpeg and no active review", () => {
		expect(
			deriveSaveAffordance({
				...baseState,
				slot: null,
				ffmpeg: installedFfmpeg,
			}),
		).toEqual({ allowed: false, reason: "missing_slot" });

		expect(
			deriveSaveAffordance({
				...baseState,
				slot: {
					name: "Fresh",
					folders: [],
					links: [],
					entries: [makeEntry("a", "C:/a")],
					exclude: [],
				},
				ffmpeg: null,
			}),
		).toEqual({ allowed: false, reason: "missing_ffmpeg" });

		expect(
			deriveSaveAffordance({
				...baseState,
				slot: {
					name: "Fresh",
					folders: [],
					links: [],
					entries: [makeEntry("a", "C:/a")],
					exclude: [],
				},
				ffmpeg: installedFfmpeg,
				savePath: null,
			}),
		).toEqual({ allowed: false, reason: "missing_save_path" });

		expect(
			deriveSaveAffordance({
				...baseState,
				playlists: [makePlaylist("Focus")],
				selectedListName: null,
				slot: {
					name: "  focus  ",
					folders: [],
					links: [],
					entries: [makeEntry("a", "C:/a")],
					exclude: [],
				},
				ffmpeg: installedFfmpeg,
				savePath: "C:/music",
			}),
		).toEqual({ allowed: false, reason: "duplicate_name" });

		expect(
			deriveSaveAffordance({
				...baseState,
				slot: {
					name: "Fresh",
					folders: [],
					links: [],
					entries: [],
					exclude: [],
				},
				ffmpeg: installedFfmpeg,
				savePath: "C:/music",
			}),
		).toEqual({ allowed: false, reason: "invalid_mission" });

		expect(
			deriveSaveAffordance({
				...baseState,
				slot: {
					name: "Fresh",
					folders: [],
					links: [],
					entries: [makeEntry("a", "C:/a")],
					exclude: [],
				},
				ffmpeg: installedFfmpeg,
				savePath: "C:/music",
				linkReviews: ["https://example.com"],
			}),
		).toEqual({ allowed: false, reason: "review_in_progress" });

		expect(
			deriveSaveAffordance({
				...baseState,
				playlists: [makePlaylist("Focus")],
				selectedListName: "Focus",
				slot: {
					name: "  focus  ",
					folders: [],
					links: [],
					entries: [makeEntry("a", "C:/a")],
					exclude: [],
				},
				ffmpeg: installedFfmpeg,
				savePath: "C:/music",
			}),
		).toEqual({ allowed: true, reason: "review_in_progress" });
	});

	test("deriveBackTransition clears transient editor and playback state toward play or guide", () => {
		const toPlay = deriveBackTransition({
			...baseState,
			mode: "edit",
			playlists: [makePlaylist("focus")],
			selectedListName: "focus",
			nowJudge: "Up",
			slot: { name: "draft", folders: [], links: [], entries: [], exclude: [] },
			processMsg: { playlist: "focus", str: "working" },
			linkReviews: ["https://example.com"],
			folderReviews: ["C:/folder"],
			weblistReviews: ["https://example.com/list"],
		});

		expect(toPlay.mode).toBe("play");
		expect(toPlay.routeResolved).toBe(true);
		expect(toPlay.selectedListName).toBeNull();
		expect(toPlay.nowPlaying).toBeNull();
		expect(toPlay.nowJudge).toBeNull();
		expect(toPlay.slot).toBeNull();
		expect(toPlay.processMsg).toBeNull();
		expect(toPlay.linkReviews).toEqual([]);
		expect(toPlay.folderReviews).toEqual([]);
		expect(toPlay.weblistReviews).toEqual([]);

		const toGuide = deriveBackTransition({
			...baseState,
			mode: "create",
			playlists: [],
			selectedListName: "focus",
			nowPlaying: makeMusic("C:/audio/stale.flac"),
			slot: { name: "draft", folders: [], links: [], entries: [], exclude: [] },
			processMsg: { playlist: "focus", str: "working" },
		});

		expect(toGuide.mode).toBe("new_guide");
		expect(toGuide.routeResolved).toBe(true);
		expect(toGuide.selectedListName).toBeNull();
		expect(toGuide.nowPlaying).toBeNull();
		expect(toGuide.slot).toBeNull();
		expect(toGuide.processMsg).toBeNull();
	});

	test("deriveRouteResolution projects unresolved, guide, and play states coherently", () => {
		expect(deriveRouteResolution({ routeResolved: false, mode: "play" })).toEqual({
			kind: "startup_unresolved",
			routeResolved: false,
			mode: "play",
		});

		expect(
			deriveRouteResolution({ routeResolved: true, mode: "new_guide" }),
		).toEqual({
			kind: "startup_probed_empty",
			routeResolved: true,
			mode: "new_guide",
		});

		expect(deriveRouteResolution({ routeResolved: true, mode: "play" })).toEqual({
			kind: "startup_probed_nonempty",
			routeResolved: true,
			mode: "play",
		});
	});

	test("deriveProbePatch true_positive_promotes_non_empty_names_to_play_with_placeholders", () => {
		const patch = deriveProbePatch(
			{ mode: "new_guide", routeResolved: false },
			["focus", "ambient"],
		);

		expect(patch.mode).toBe("play");
		expect(patch.routeResolved).toBe(true);
		expect(patch.playlists).toEqual(buildPlaylistPlaceholders(["focus", "ambient"]));
	});

	test("deriveProbePatch true_negative_keeps_empty_probe_in_new_guide", () => {
		const patch = deriveProbePatch({ mode: "play", routeResolved: false }, []);

		expect(patch.mode).toBe("new_guide");
		expect(patch.routeResolved).toBe(true);
		expect(patch.playlists).toEqual([]);
	});

	test("deriveProbePatch false_positive_guard_does_not_knock_edit_mode_back_to_play", () => {
		const patch = deriveProbePatch({ mode: "edit", routeResolved: true }, ["focus"]);

		expect(patch.mode).toBe("edit");
		expect(patch.playlists).toEqual(buildPlaylistPlaceholders(["focus"]));
	});

	test("deriveProbePatch false_negative_guard_does_not_knock_create_mode_back_to_new_guide", () => {
		const patch = deriveProbePatch(
			{ mode: "create", routeResolved: true },
			[],
		);

		expect(patch.mode).toBe("create");
		expect(patch.playlists).toEqual([]);
	});

	test("deriveProbePatch keeps unresolved editor route projection while hydrating names-first data", () => {
		const patch = deriveProbePatch({ mode: "edit", routeResolved: false }, ["focus"]);

		expect(patch.mode).toBe("edit");
		expect(patch.routeResolved).toBe(false);
		expect(patch.playlists).toEqual(buildPlaylistPlaceholders(["focus"]));
	});

	test("deriveRefreshPatch preserves unresolved editor route projection during hydration", () => {
		const patch = deriveRefreshPatch(
			{ mode: "create", routeResolved: false, selectedListName: "missing", nowPlaying: null },
			[],
		);

		expect(patch.mode).toBe("create");
		expect(patch.routeResolved).toBe(false);
		expect(patch.selectedListName).toBeNull();
		expect(patch.nowPlaying).toBeNull();
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
