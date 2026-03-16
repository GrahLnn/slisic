import { describe, expect, test } from "bun:test";
import type { Music, Playlist } from "@/src/cmd/commands";
import {
	buildSpectrogramRequest,
	deriveOverlayTargetLufs,
	ENABLE_DEV_SPECTROGRAM_OVERLAY,
} from "./dev_spectrogram_overlay.logic";

function music(path: string, patch: Partial<Music> = {}): Music {
	return {
		path,
		title: path,
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
		...patch,
	};
	}

function playlist(tracks: Music[], exclude: Music[] = []): Playlist {
	return {
		name: "debug",
		avg_db: null,
		entries: [
			{
				path: "folder",
				name: "entry",
				musics: tracks,
				avg_db: null,
				url: null,
				downloaded_ok: true,
				tracking: false,
				entry_type: "Local",
			},
		],
		exclude,
	};
	}

describe("dev spectrogram overlay logic", () => {
	test("buildSpectrogramRequest uses canonical integrated loudness only", () => {
		const request = buildSpectrogramRequest(
			music("track.mp3", {
				avg_db: -11,
				integrated_lufs: null,
				true_peak_dbtp: -0.5,
			}),
			-18,
			{ width: 1280, height: 720 },
		);

		expect(request.target_lufs).toBe(-18);
		expect(request.track_lufs).toBeNull();
		expect(request.track_true_peak_dbtp).toBe(-0.5);
	});

	test("deriveOverlayTargetLufs uses canonical playlist derivation only", () => {
		const canonicalTracks = [
			music("a.mp3", { integrated_lufs: -24 }),
			music("b.mp3", { integrated_lufs: -20 }),
			music("c.mp3", { integrated_lufs: -17 }),
		];
		const mixedPlaylist = playlist([
			...canonicalTracks,
			music("legacy-a.mp3", { avg_db: -30, integrated_lufs: null }),
			music("legacy-b.mp3", { avg_db: -8, integrated_lufs: null }),
		]);

		expect(deriveOverlayTargetLufs(mixedPlaylist, -18)).toBe(
			deriveOverlayTargetLufs(playlist(canonicalTracks), -18),
		);
	});

	test("cross-stack fixtures stay degraded or canonical across debug payload preparation", () => {
		const legacyRequest = buildSpectrogramRequest(
			music("legacy.mp3", {
				avg_db: -11,
				integrated_lufs: null,
				true_peak_dbtp: null,
				normalization_status: null,
			}),
			-18,
			{ width: 900, height: 400 },
		);
		expect(legacyRequest.track_lufs).toBeNull();
		expect(legacyRequest.track_true_peak_dbtp).toBeNull();

		const canonicalTrack = music("canonical.mp3", {
			integrated_lufs: -19.2,
			true_peak_dbtp: -0.8,
			loudness_range_lu: 5.1,
			normalization_status: "Ready",
			analysis_version: 1,
			source_mtime_ms: 100,
			source_size_bytes: 200,
		});
		const canonicalRequest = buildSpectrogramRequest(canonicalTrack, -18.5, {
			width: 900,
			height: 400,
		});
		expect(canonicalRequest.track_lufs).toBe(-19.2);
		expect(canonicalRequest.track_true_peak_dbtp).toBe(-0.8);

		const failedRequest = buildSpectrogramRequest(
			music("failed.mp3", {
				avg_db: -13,
				integrated_lufs: null,
				true_peak_dbtp: null,
				normalization_status: "Failed",
				normalization_error: "ffmpeg failed",
			}),
			-18,
			{ width: 900, height: 400 },
		);
		expect(failedRequest.track_lufs).toBeNull();
		expect(failedRequest.track_true_peak_dbtp).toBeNull();
	});

	test("ENABLE_DEV_SPECTROGRAM_OVERLAY stays behind an explicit DEV gate", () => {
		expect(ENABLE_DEV_SPECTROGRAM_OVERLAY).toBe(
			import.meta.env.DEV &&
				import.meta.env.VITE_ENABLE_DEV_SPECTROGRAM_OVERLAY === "1",
		);
	});
});
