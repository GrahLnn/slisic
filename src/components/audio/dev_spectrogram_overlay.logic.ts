import type { AudioDebugSpectrogramRequest, Music, Playlist } from "@/src/cmd/commands";
import { derivePlaylistTargetLufs } from "@/src/flow/music/logic";

export const ENABLE_DEV_SPECTROGRAM_OVERLAY =
	import.meta.env.DEV &&
	import.meta.env.VITE_ENABLE_DEV_SPECTROGRAM_OVERLAY === "1";

export function playableTracksFromList(list: Playlist | null | undefined): Music[] {
	if (!list) return [];
	const excluded = new Set(list.exclude.map((item) => item.path));
	return list.entries
		.flatMap((entry) => entry.musics)
		.filter((music) => !excluded.has(music.path));
}

export function deriveOverlayTargetLufs(
	list: Playlist | null | undefined,
	fallback = -18,
): number {
	return derivePlaylistTargetLufs(playableTracksFromList(list), fallback);
}

export function buildSpectrogramRequest(
	track: Music,
	targetLufs: number,
	dimensions: { width: number; height: number },
): AudioDebugSpectrogramRequest {
	return {
		path: track.path,
		target_lufs: targetLufs,
		track_lufs: track.integrated_lufs,
		track_true_peak_dbtp: track.true_peak_dbtp ?? null,
		width: dimensions.width,
		height: dimensions.height,
	};
}
