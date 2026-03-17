import { beforeEach, describe, expect, mock, test } from "bun:test";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let routeResolved = false;
let mode: "play" | "create" | "edit" | "new_guide" = "play";

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
	cn: (value: unknown) =>
		Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value ?? ""),
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
mock.module("@/src/flow/cursorInApp", () => ({ useCursorInApp: () => false }));
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
			loading: false,
			playlists: [],
			nowJudge: null,
			processMsg: null,
		}),
		useState: () => ({
			match: (handlers: Record<string, () => ReactNode>) => {
				const key = mode;
				return (handlers[key] ?? handlers._)();
			},
		}),
		useList: () => [],
		useIsPlaying: () => false,
		useCurPlay: () => null,
		useCurList: () => null,
		useMsg: () => null,
		useIsReview: () => false,
	},
}));

const { default: Home, shouldRenderHomeRoute } = await import("./home");

beforeEach(() => {
	routeResolved = false;
	mode = "play";
});

describe("Home route gating", () => {
	test("selector rejects unresolved route projection", () => {
		expect(shouldRenderHomeRoute({ routeResolved: false })).toBe(false);
		expect(shouldRenderHomeRoute({ routeResolved: true })).toBe(true);
	});

	test("unresolved route renders null even if stale mode is play", async () => {
		mode = "play";
		const html = renderToStaticMarkup(<Home />);

		expect(html).toBe("");
	});

	test("resolved guide route renders guide content", async () => {
		routeResolved = true;
		mode = "new_guide";
		const html = renderToStaticMarkup(<Home />);

		expect(html).toContain(
			"You don’t have any play list yet. Let’s add your first one!",
		);
	});
});
