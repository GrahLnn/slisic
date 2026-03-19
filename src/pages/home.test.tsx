import { beforeEach, describe, expect, mock, test } from "bun:test";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MusicState } from "@/src/flow/music/store";

function realProjectWorkspaceScreen(snapshot: {
	routeResolved: boolean;
	mode: MusicState["mode"];
}) {
	if (!snapshot.routeResolved) {
		return "unresolved";
	}

	if (snapshot.mode === "create") {
		return "create";
	}

	if (snapshot.mode === "edit") {
		return "edit";
	}

	return snapshot.mode === "new_guide" ? "guide" : "play";
}

let routeResolved = false;
let mode: MusicState["mode"] = "play";
let requestedTitle: string | null = null;
let confirmedTitle: string | null = null;
let currentListName: string | null = null;
let selectedListName: string | null = null;
let playlistNames: string[] = [];
let isPlaying = false;

mock.module("motion/react", () => ({
	AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
	motion: new Proxy(
		{},
		{
			get: (_target, tag: string) =>
				({ children, ...props }: React.ComponentPropsWithoutRef<"div">) =>
					React.createElement(tag, props, children),
		},
	),
}));
mock.module("@/src/components/labels", () => ({
	labels: { musicPlus: () => <div>music-plus</div> },
}));
mock.module("@/lib/utils", () => ({
	cn: (...values: unknown[]) =>
		values
			.flatMap((value) => (Array.isArray(value) ? value : [value]))
			.filter(Boolean)
			.join(" "),
	os: { is: () => false },
}));
mock.module("@/src/assets/icons", () => ({
	motionIcons: new Proxy(
		{},
		{
			get: () =>
				({ children, ...props }: React.ComponentPropsWithoutRef<"div">) => (
					<div {...props}>{children}</div>
				),
		},
	),
}));
mock.module("@/src/components/empty", () => ({
	EmptyPage: ({ explain }: { explain: string }) => <div>{explain}</div>,
}));
mock.module("@/src/components/music/new", () => ({ New: () => <div>new-form</div> }));
mock.module("@/src/components/uni", () => ({
	BackButton: ({ onClick }: { onClick: () => void }) => (
		<button type="button" onClick={onClick}>
			back
		</button>
	),
}));
mock.module("@/src/flow/cursorInApp", () => ({
	useCursorInApp: () => false,
	setCursorInApp: () => undefined,
}));
mock.module("@/components/ui/context-menu", () => ({
	ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
	ContextMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	ContextMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
	ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
	LongPressContextMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
mock.module("@/src/flow/music", () => ({
	action: {
		addNew: () => undefined,
		back: () => undefined,
		play: async () => undefined,
		edit: () => undefined,
		delete: async () => undefined,
		cancleUp: async () => undefined,
		up: async () => undefined,
		cancleDown: async () => undefined,
		down: async () => undefined,
		unstar: async () => undefined,
	},
	hook: {
		useContext: () => ({
			routeResolved,
			mode,
			loading: false,
			playlists: playlistNames.map((name) => ({
				name,
				avg_db: null,
				entries: [],
				exclude: [],
			})),
			nowJudge: null,
			processMsg: null,
		}),
		useState: () => ({
			match: (_handlers: Record<string, () => ReactNode>) => null,
		}),
		useList: () =>
			playlistNames.map((name) => ({
				name,
				avg_db: null,
				entries: [],
				exclude: [],
			})),
		useIsPlaying: () => isPlaying,
		useCurPlay: () =>
			requestedTitle
				? { path: `C:/music/${requestedTitle}.flac`, title: requestedTitle }
				: null,
		useRequestedPlay: () =>
			requestedTitle
				? { path: `C:/music/${requestedTitle}.flac`, title: requestedTitle }
				: null,
		useConfirmedPlay: () =>
			confirmedTitle
				? { path: `C:/music/${confirmedTitle}.flac`, title: confirmedTitle }
				: null,
		useCurList: () =>
			currentListName
				? {
					name: currentListName,
					avg_db: null,
					entries: [],
					exclude: [],
				}
				: null,
			useSelectedList: () =>
				selectedListName
					? {
						name: selectedListName,
						avg_db: null,
						entries: [],
						exclude: [],
					}
					: null,
		useMsg: () => null,
		useIsReview: () => false,
	},
}));
mock.module("sileo", () => ({
	sileo: {
		alert: () => undefined,
		error: () => undefined,
		success: () => undefined,
		warning: () => undefined,
		promise: () => undefined,
	},
	Toaster: () => <div />,
}));
mock.module("@/src/flow/music/store", () => ({
	projectWorkspaceScreen: realProjectWorkspaceScreen,
}));

const { default: Home, projectPlaylistHint, shouldRenderHomeRoute } = await import("./home");

beforeEach(() => {
	routeResolved = false;
	mode = "play";
	requestedTitle = null;
	confirmedTitle = null;
	currentListName = null;
	selectedListName = null;
	playlistNames = [];
	isPlaying = false;
});

describe("Home route gating", () => {
	test("selector rejects unresolved route projection", () => {
		expect(shouldRenderHomeRoute({ routeResolved: false })).toBe(false);
		expect(shouldRenderHomeRoute({ routeResolved: true })).toBe(true);
	});

	test("playlist hint projection only returns transient text for the matching playlist", () => {
		expect(projectPlaylistHint(null, "focus")).toBeNull();
		expect(
			projectPlaylistHint(
				{ playlist: "focus", str: "Analyzing loudness 1/1: a.mp3" },
				"focus",
			),
		).toBe("Analyzing loudness 1/1: a.mp3");
		expect(
			projectPlaylistHint(
				{ playlist: "other", str: "Analyzing loudness 1/1: a.mp3" },
				"focus",
			),
		).toBeNull();
	});

	test("unresolved route renders null even if the real workspace projection resolves to edit", async () => {
		mode = "edit";
		const html = renderToStaticMarkup(<Home />);

		expect(html).toBe("");
	});

	test("resolved guide route renders guide content through the production workspace projection", async () => {
		routeResolved = true;
		mode = "new_guide";
		const html = renderToStaticMarkup(<Home />);

		expect(html).toContain(
			"You don’t have any play list yet. Let’s add your first one!",
		);
	});

	test("resolved create route renders create workspace through the production projection", async () => {
		routeResolved = true;
		mode = "create";
		const html = renderToStaticMarkup(<Home />);

		expect(html).toContain("new-form");
		expect(html).toContain("back");
	});

	test("play route consumer uses the requested title before confirmation exists", async () => {
		routeResolved = true;
		mode = "play";
		requestedTitle = "requested-track";
		confirmedTitle = null;
		currentListName = "focus";
		playlistNames = ["focus"];

		const html = renderToStaticMarkup(<Home />);

		expect(html).toContain("requested-track");
		expect(html).toContain("focus");
		expect(html).not.toContain("confirmed-track");
	});

	test("play route consumer prefers confirmed playback title once confirmation exists even if requested intent diverges", async () => {
		routeResolved = true;
		mode = "play";
		requestedTitle = "requested-track";
		confirmedTitle = "confirmed-track";
		currentListName = "focus";
		playlistNames = ["focus"];

		const html = renderToStaticMarkup(<Home />);

		expect(html).toContain("focus");
		expect(html).toContain("confirmed-track");
		expect(html).not.toContain("requested-track");
	});

	test("play route consumer enters immediate playback list context before confirmation", async () => {
		routeResolved = true;
		mode = "play";
		requestedTitle = "requested-track";
		confirmedTitle = null;
		currentListName = "focus";
		isPlaying = true;
		playlistNames = ["focus", "ambient"];

		const html = renderToStaticMarkup(<Home />);

		expect(html).toContain("requested-track");
		expect(html).toContain(">ambient<");
		expect(html).toContain("aria-disabled=\"true\"");
		expect(html).not.toContain("confirmed-track");
	});

	test("play route consumer keeps the active playback title while focused browsing lists stay non-interactive", async () => {
		routeResolved = true;
		mode = "play";
		requestedTitle = "requested-track";
		confirmedTitle = "confirmed-track";
		currentListName = "focus";
		selectedListName = "browsed";
		isPlaying = true;
		playlistNames = ["focus", "browsed", "ambient"];

		const html = renderToStaticMarkup(<Home />);

		expect(html).toContain("focus");
		expect(html).toContain(">browsed<");
		expect(html).toContain("confirmed-track");
		expect(html).not.toContain("- requested-track");
		expect(html).toContain("aria-disabled=\"true\"");
	});

	test("play route consumer surfaces confirmed playback title once confirmation exists", async () => {
		routeResolved = true;
		mode = "play";
		requestedTitle = "requested-track";
		confirmedTitle = "confirmed-track";
		currentListName = "focus";
		playlistNames = ["focus"];

		const html = renderToStaticMarkup(<Home />);

		expect(html).toContain("focus");
		expect(html).toContain("confirmed-track");
		expect(html).not.toContain("- requested-track");
	});
});
