import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as ReactModule from "react";
import {
	canRenderApp as realCanRenderApp,
	canStartApp as realCanStartApp,
	type BootstrapAppEntryState,
} from "./bootstrap/appEntryMachine";

let bootstrapState: BootstrapAppEntryState = { status: "window_pending" };
const ensureUpdaterStarted = mock(() => undefined);
const updaterRun = mock(() => undefined);
const musicRun = mock(async () => undefined);
const musicDispose = mock(async () => undefined);

mock.module("./topbar", () => ({
	default: () => <div data-testid="topbar">topbar</div>,
}));
mock.module("./pages/pages", () => ({
	default: () => <div data-testid="pages">pages</div>,
}));
mock.module("./bootstrap", () => ({
	useBootstrapAppEntryState: () => bootstrapState,
	canRenderApp: realCanRenderApp,
	canStartApp: realCanStartApp,
}));
mock.module("./flow/music", () => ({
	action: {
		run: musicRun,
		dispose: musicDispose,
	},
}));
mock.module("./flow/updater", () => ({
	action: { run: updaterRun },
	ensureStarted: ensureUpdaterStarted,
}));
mock.module("./components/audio/canvas", () => ({
	default: () => <div data-testid="audio-canvas" />,
}));
mock.module("./components/audio/dev_spectrogram_overlay", () => ({
	default: () => <div data-testid="spectrogram">spectrogram</div>,
}));
mock.module("./components/audio/dev_spectrogram_overlay.logic", () => ({
	ENABLE_DEV_SPECTROGRAM_OVERLAY: false,
}));
mock.module("./components/svg_filter", () => ({
	default: () => <div data-testid="filter" />,
}));
mock.module("./flow/cursorInApp", () => ({
	setCursorInApp: () => undefined,
}));
mock.module("sileo", () => ({
	Toaster: StubToaster,
}));

const StubFilter: React.ComponentType = () => {
	return <div data-testid="filter" />;
};

const StubAudioCanvas: React.ComponentType = () => {
	return <div data-testid="audio-canvas" />;
};

const StubTopBar: React.ComponentType = () => {
	return <div data-testid="topbar">topbar</div>;
};

const StubPages: React.ComponentType = () => {
	return <div data-testid="pages">pages</div>;
};

const StubToaster: React.ComponentType<{
	position?:
		| "top-left"
		| "top-center"
		| "top-right"
		| "bottom-left"
		| "bottom-center"
		| "bottom-right";
}> = () => {
	return <div data-testid="toaster" />;
};

const { AppShell, default: App } = await import("./App");
let useEffectSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	bootstrapState = { status: "window_pending" };
	ensureUpdaterStarted.mockClear();
	updaterRun.mockClear();
	musicRun.mockClear();
	musicDispose.mockClear();
	useEffectSpy?.mockRestore();
	useEffectSpy = spyOn(ReactModule, "useEffect").mockImplementation((effect) => {
		effect();
	});
});

describe("App bootstrap boundary", () => {
	test("pending bootstrap renders App.tsx shell without starting updater or music work", async () => {
		renderToStaticMarkup(<App />);
		const html = renderToStaticMarkup(
			<AppShell
				FilterComponent={StubFilter}
				AudioVisualizerComponent={StubAudioCanvas}
				TopBarComponent={StubTopBar}
				PagesComponent={StubPages}
				ToasterComponent={StubToaster}
				enableDevSpectrogramOverlay={false}
			/>,
		);

		expect(html).toContain("data-testid=\"topbar\"");
		expect(html).toContain("data-testid=\"pages\"");
		expect(ensureUpdaterStarted).not.toHaveBeenCalled();
		expect(updaterRun).not.toHaveBeenCalled();
		expect(musicRun).not.toHaveBeenCalled();
	});

	test("confirmed prewarm returns null from App.tsx and suppresses startup work", async () => {
		bootstrapState = {
			status: "prewarm_blocked",
			info: {
				window: "Main",
				label: "main-prewarm-1",
				is_prewarm: true,
				is_primary_main: false,
			},
		};

		const html = renderToStaticMarkup(<App />);

		expect(html).toBe("");
		expect(ensureUpdaterStarted).not.toHaveBeenCalled();
		expect(updaterRun).not.toHaveBeenCalled();
		expect(musicRun).not.toHaveBeenCalled();
	});

	test("startup allowed starts work and renders through App.tsx", async () => {
		bootstrapState = {
			status: "startup_allowed",
			info: null,
		};

		const html = renderToStaticMarkup(<App />);

		expect(html).toContain("data-testid=\"topbar\"");
		expect(html).toContain("data-testid=\"pages\"");
		expect(ensureUpdaterStarted).toHaveBeenCalledTimes(1);
		expect(updaterRun).toHaveBeenCalledTimes(1);
		expect(musicRun).toHaveBeenCalledTimes(1);
	});

	test("bootstrap failure falls open through App.tsx and resumes startup work", async () => {
		bootstrapState = {
			status: "bootstrap_error_fallback",
			reason: "invoke failed",
		};

		renderToStaticMarkup(<App />);
		const html = renderToStaticMarkup(
			<AppShell
				FilterComponent={StubFilter}
				AudioVisualizerComponent={StubAudioCanvas}
				TopBarComponent={StubTopBar}
				PagesComponent={StubPages}
				ToasterComponent={StubToaster}
				enableDevSpectrogramOverlay={false}
			/>,
		);

		expect(html).toContain("data-testid=\"topbar\"");
		expect(html).toContain("data-testid=\"pages\"");
		expect(ensureUpdaterStarted).toHaveBeenCalledTimes(1);
		expect(updaterRun).toHaveBeenCalledTimes(1);
		expect(musicRun).toHaveBeenCalledTimes(1);
	});

	test("AppShell renders the production shell boundary with injected App.tsx children", () => {
		const html = renderToStaticMarkup(
			<AppShell
				FilterComponent={StubFilter}
				AudioVisualizerComponent={StubAudioCanvas}
				TopBarComponent={StubTopBar}
				PagesComponent={StubPages}
				ToasterComponent={StubToaster}
				enableDevSpectrogramOverlay={false}
			/>,
		);

		expect(html).toContain("data-testid=\"filter\"");
		expect(html).toContain("data-testid=\"audio-canvas\"");
		expect(html).toContain("data-testid=\"topbar\"");
		expect(html).toContain("data-testid=\"pages\"");
		expect(html).toContain("data-testid=\"toaster\"");
	});
});
