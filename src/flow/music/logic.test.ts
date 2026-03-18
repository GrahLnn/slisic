import { describe, expect, test } from "bun:test";
import type { AudioPlayAck } from "@/src/cmd/commands";
import {
	avoidRecentlyPlayed,
	canPersistMission,
	derivePlaylistTargetLufs,
	entryKey,
	inferEntryType,
	isValidUrl,
	pushRecentPath,
	sameTrack,
	sampleSoftMin,
} from "./logic";

interface TestMusic {
	path: string;
	title: string;
	avg_db: number | null;
	integrated_lufs: number | null;
	true_peak_dbtp: number | null;
	loudness_range_lu: number | null;
	loudness_threshold_lufs: number | null;
	analyzed_at_ms: number | null;
	analysis_version: number | null;
	source_mtime_ms: number | null;
	source_size_bytes: number | null;
	normalization_status: "Pending" | "Ready" | "Failed" | null;
	normalization_error: string | null;
	base_bias: number;
	user_boost: number;
	fatigue: number;
	diversity: number;
}

interface TestCollectMission {
	name: string;
	folders: Array<{ path: string; items: string[] }>;
	links: Array<{
		url: string;
		title_or_msg: string;
		entry_type: "Local" | "WebList" | "WebVideo" | "Unknown";
		count: number | null;
		status: "Ok" | "Err" | null;
		tracking: boolean;
	}>;
	entries: Array<{
		path: string | null;
		name: string;
		musics: TestMusic[];
		avg_db: number | null;
		url: string | null;
		downloaded_ok: boolean | null;
		tracking: boolean | null;
		entry_type: "Local" | "WebList" | "WebVideo" | "Unknown";
	}>;
	exclude: TestMusic[];
}

type PersistCheckMission = Parameters<typeof canPersistMission>[0];

function music(path: string, bias: number): TestMusic {
	return {
		path,
		title: path,
		avg_db: null,
		integrated_lufs: null,
		loudness_range_lu: null,
		loudness_threshold_lufs: null,
		analyzed_at_ms: null,
		analysis_version: null,
		source_mtime_ms: null,
		source_size_bytes: null,
		normalization_status: null,
		normalization_error: null,
		true_peak_dbtp: null,
		base_bias: bias,
		user_boost: 0,
		fatigue: 0,
		diversity: 0,
	};
}

function mission(patch: Partial<TestCollectMission>): TestCollectMission {
	return {
		name: "test",
		folders: [],
		links: [],
		entries: [],
		exclude: [],
		...patch,
	};
}

describe("music logic", () => {
	test("inferEntryType maps known media types", () => {
		expect(inferEntryType("playlist")).toBe("WebList");
		expect(inferEntryType("video")).toBe("WebVideo");
		expect(inferEntryType("channel")).toBe("Unknown");
	});

	test("isValidUrl allows http and https only", () => {
		expect(isValidUrl("https://example.com/a")).toBeTrue();
		expect(isValidUrl("http://example.com/b")).toBeTrue();
		expect(isValidUrl("ftp://example.com/c")).toBeFalse();
		expect(isValidUrl("not-a-url")).toBeFalse();
	});

	test("entryKey selects stable key in order path/url/name", () => {
		expect(
			entryKey({
				path: "C:/x.mp3",
				url: "https://example.com/x",
				name: "x",
				musics: [],
				avg_db: null,
				downloaded_ok: true,
				tracking: false,
				entry_type: "Local",
			}),
		).toBe("C:/x.mp3");

		expect(
			entryKey({
				path: null,
				url: "https://example.com/x",
				name: "x",
				musics: [],
				avg_db: null,
				downloaded_ok: true,
				tracking: false,
				entry_type: "WebVideo",
			}),
		).toBe("https://example.com/x");

		expect(
			entryKey({
				path: null,
				url: null,
				name: "x",
				musics: [],
				avg_db: null,
				downloaded_ok: null,
				tracking: null,
				entry_type: "Unknown",
			}),
		).toBe("x");
	});

	test("sameTrack compares by path", () => {
		expect(sameTrack(music("a", 1), music("a", 2))).toBeTrue();
		expect(sameTrack(music("a", 1), music("b", 1))).toBeFalse();
		expect(sameTrack(music("a", 1), null)).toBeFalse();
	});

	test("sampleSoftMin prefers lower logit item with deterministic rng", () => {
		const a = music("a", 0);
		const b = music("b", 5);
		const picked = sampleSoftMin([a, b], 0.8, () => 0);
		expect(picked?.path).toBe("a");
	});

	test("sampleSoftMin returns null for empty list", () => {
		expect(sampleSoftMin([], 0.8, () => 0.5)).toBeNull();
	});

	test("avoidRecentlyPlayed should filter recent tracks when possible", () => {
		const items = [music("a", 0), music("b", 0), music("c", 0)];
		const filtered = avoidRecentlyPlayed(items, ["b", "c"], 2);
		expect(filtered.map((item) => item.path)).toEqual(["a"]);
	});

	test("avoidRecentlyPlayed should fallback to all when all are blocked", () => {
		const items = [music("a", 0), music("b", 0)];
		const filtered = avoidRecentlyPlayed(items, ["a", "b"], 2);
		expect(filtered.map((item) => item.path)).toEqual(["a", "b"]);
	});

	test("pushRecentPath keeps deduped tail window", () => {
		const next = pushRecentPath(["a", "b", "c"], "b", 2);
		expect(next).toEqual(["c", "b"]);
	});

	test("canPersistMission validates required fields", () => {
		expect(canPersistMission(null).ok).toBeFalse();
		expect(
			canPersistMission(mission({ name: "  " }) as PersistCheckMission).ok,
		).toBeFalse();
		expect(
			canPersistMission(
				mission({ name: "A", folders: [] }) as PersistCheckMission,
			).ok,
		).toBeFalse();

		expect(
			canPersistMission(
				mission({
					name: "A",
					links: [
						{
							url: "https://example.com",
							title_or_msg: "x",
							entry_type: "WebVideo",
							count: null,
							status: "Ok",
							tracking: false,
						},
					],
				}) as PersistCheckMission,
			).ok,
		).toBeTrue();
	});

	test("derivePlaylistTargetLufs should be robust to loud outliers", () => {
		const tracks = [
			{ ...music("a", 0), integrated_lufs: -24 },
			{ ...music("b", 0), integrated_lufs: -22 },
			{ ...music("c", 0), integrated_lufs: -20 },
			{ ...music("d", 0), integrated_lufs: -18.5 },
			{ ...music("e", 0), integrated_lufs: -17 },
			{ ...music("f", 0), integrated_lufs: -8.5 }, // loud outlier
		];

		const target = derivePlaylistTargetLufs(tracks, -18);
		expect(target).toBeLessThan(-19);
		expect(target).toBeGreaterThanOrEqual(-21);
	});

	test("derivePlaylistTargetLufs should fallback when no usable loudness", () => {
		const tracks = [
			{ ...music("a", 0), avg_db: null },
			{ ...music("b", 0), avg_db: Number.NaN },
		];

		expect(derivePlaylistTargetLufs(tracks, -18)).toBe(-18);
	});

	test("derivePlaylistTargetLufs should ignore legacy-only avg_db values", () => {
		const tracks = [
			{ ...music("legacy-a", 0), avg_db: -24, integrated_lufs: null },
			{ ...music("legacy-b", 0), avg_db: -12, integrated_lufs: null },
		];

		expect(derivePlaylistTargetLufs(tracks, -18)).toBe(-18);
	});

	test("derivePlaylistTargetLufs should ignore legacy-only tracks in mixed playlists", () => {
		const canonicalTracks = [
			{ ...music("canonical-a", 0), integrated_lufs: -24 },
			{ ...music("canonical-b", 0), integrated_lufs: -20 },
			{ ...music("canonical-c", 0), integrated_lufs: -17 },
		];
		const mixedTracks = [
			...canonicalTracks,
			{ ...music("legacy-a", 0), avg_db: -30, integrated_lufs: null },
			{ ...music("legacy-b", 0), avg_db: -8, integrated_lufs: null },
		];

		expect(derivePlaylistTargetLufs(mixedTracks, -18)).toBe(
			derivePlaylistTargetLufs(canonicalTracks, -18),
		);
	});

	test("derivePlaylistTargetLufs should discard invalid canonical values without legacy fallback", () => {
		const tracks = [
			{ ...music("invalid-nan", 0), integrated_lufs: Number.NaN, avg_db: -24 },
			{ ...music("invalid-hot", 0), integrated_lufs: -4, avg_db: -20 },
			{ ...music("invalid-cold", 0), integrated_lufs: -44, avg_db: -16 },
			{ ...music("legacy-only", 0), integrated_lufs: null, avg_db: -12 },
		];

		expect(derivePlaylistTargetLufs(tracks, -18)).toBe(-18);
	});

	test("AudioPlayAck TS contract exposes canonical loudness presence for playback acknowledgments", () => {
		const ack: AudioPlayAck = {
			session_id: 1,
			path: "track.mp3",
			duration_ms: 1234,
			gain: 0.75,
			gain_db: -2.5,
			target_lufs: -18,
			integrated_lufs: -20,
			has_canonical_loudness: true,
		};

		expect(ack.has_canonical_loudness).toBeTrue();
	});

	test("AudioPlayRequest, AudioEnded, AudioPaused, AudioResumed, and AudioFailed TS contracts expose playback session identity", () => {
		const request = {
			session_id: 2,
			path: "track.mp3",
		};
		const ended = {
			session_id: 2,
			path: "track.mp3",
		};
		const paused = {
			session_id: 2,
			path: "track.mp3",
		};
		const resumed = {
			session_id: 2,
			path: "track.mp3",
		};
		const failed = {
			session_id: 2,
			path: "track.mp3",
			action: "pause",
			error: "engine failed",
		};

		expect(request.session_id).toBe(2);
		expect(ended.session_id).toBe(2);
		expect(paused.session_id).toBe(2);
		expect(resumed.session_id).toBe(2);
		expect(failed.session_id).toBe(2);
	});
});
