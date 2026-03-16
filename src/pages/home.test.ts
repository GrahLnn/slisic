import { describe, expect, test } from "bun:test";
import { deriveBootingCopy } from "./home.booting";

describe("home booting copy", () => {
	test("true_negative_uses_generic_startup_copy_without_background_process_message", () => {
		expect(deriveBootingCopy(null)).toEqual({
			title: "Opening Library",
			description: "Loading playlists and checking tool state.",
		});
	});

	test("true_positive_surfaces_runtime_process_message_without_library_preparation_title", () => {
		expect(
			deriveBootingCopy({
				playlist: "focus",
				str: "Downloading focus mix",
			}),
		).toEqual({
			title: "Opening Library",
			description: "Downloading focus mix",
		});
	});

	test("false_positive_guard_ignores_blank_process_message_text", () => {
		expect(
			deriveBootingCopy({
				playlist: "focus",
				str: "   ",
			}),
		).toEqual({
			title: "Opening Library",
			description: "Loading playlists and checking tool state.",
		});
	});
});
