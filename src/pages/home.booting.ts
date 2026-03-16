import type { ProcessMsg } from "@/src/cmd/commands";

export function deriveBootingCopy(processMsg: ProcessMsg | null): {
	title: string;
	description: string;
} {
	const description = processMsg?.str.trim();
	return {
		title: "Opening Library",
		description:
			description && description.length > 0
				? description
				: "Loading playlists and checking tool state.",
	};
}
