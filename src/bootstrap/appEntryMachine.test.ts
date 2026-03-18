import { describe, expect, test } from "bun:test";
import {
	canRenderApp,
	canStartApp,
	deriveBootstrapAppEntryState,
	deriveBootstrapDecision,
	isConfirmedPrewarm,
	type BootstrapWindowState,
} from "./appEntryMachine";

describe("bootstrap app-entry machine", () => {
	test("pending keeps render permission while startup permission stays blocked", () => {
		const entry = deriveBootstrapAppEntryState({ status: "pending" });

		expect(entry.status).toBe("window_pending");
		expect(canRenderApp(entry)).toBe(true);
		expect(canStartApp(entry)).toBe(false);
		expect(isConfirmedPrewarm(entry)).toBe(false);
	});

	test("bootstrap error fails open into startup_allowed behavior", () => {
		const entry = deriveBootstrapAppEntryState({
			status: "error",
			reason: "invoke failed",
		});

		expect(entry.status).toBe("bootstrap_error_fallback");
		expect(canRenderApp(entry)).toBe(true);
		expect(canStartApp(entry)).toBe(true);
		expect(isConfirmedPrewarm(entry)).toBe(false);
	});

	test("resolved prewarm blocks both render and startup", () => {
		const state: BootstrapWindowState = {
			status: "resolved",
			info: {
				descriptor: {
					window: "Main",
					visibility: "Prepared",
					label: "main-prewarm-1",
					is_primary_main: false,
				},
				window: "Main",
				is_prewarm: true,
				label: "main-prewarm-1",
				is_primary_main: false,
			},
		};

		const entry = deriveBootstrapAppEntryState(state);
		expect(entry.status).toBe("prewarm_blocked");
		expect(canRenderApp(entry)).toBe(false);
		expect(canStartApp(entry)).toBe(false);
		expect(isConfirmedPrewarm(entry)).toBe(true);
	});

	test("app-entry selectors independently enforce render and startup permissions", () => {
		const pending = deriveBootstrapAppEntryState({ status: "pending" });
		expect(canRenderApp(pending)).toBe(true);
		expect(canStartApp(pending)).toBe(false);

		const prewarm = deriveBootstrapAppEntryState({
			status: "resolved",
			info: {
				descriptor: {
					window: "Main",
					visibility: "Prepared",
					label: "main-prewarm-1",
					is_primary_main: false,
				},
				window: "Main",
				is_prewarm: true,
				label: "main-prewarm-1",
				is_primary_main: false,
			},
		});
		expect(canRenderApp(prewarm)).toBe(false);
		expect(canStartApp(prewarm)).toBe(false);

		const failedOpen = deriveBootstrapAppEntryState({
			status: "error",
			reason: "invoke failed",
		});
		expect(canRenderApp(failedOpen)).toBe(true);
		expect(canStartApp(failedOpen)).toBe(true);
	});

	test("compatibility decision still projects app entry permissions", () => {
		const decision = deriveBootstrapDecision({
			status: "resolved",
			info: {
				descriptor: {
					window: null,
					visibility: "UserVisible",
					label: "unknown-window",
					is_primary_main: false,
				},
				window: null,
				is_prewarm: false,
				label: "unknown-window",
				is_primary_main: false,
			},
		});

		expect(decision).toEqual({
			shouldRenderApp: true,
			shouldStartApp: true,
			isConfirmedPrewarm: false,
		});
	});
});
