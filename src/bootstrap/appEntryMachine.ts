import type { WindowKindInfo } from "@/src/cmd/commands";

export type BootstrapWindowState =
	| { status: "pending" }
	| { status: "error"; reason: string }
	| { status: "resolved"; info: WindowKindInfo | null };

export type BootstrapAppEntryState =
	| { status: "window_pending" }
	| { status: "prewarm_blocked"; info: WindowKindInfo }
	| { status: "bootstrap_error_fallback"; reason: string }
	| { status: "startup_allowed"; info: WindowKindInfo | null };

export interface BootstrapDecision {
	shouldRenderApp: boolean;
	shouldStartApp: boolean;
	isConfirmedPrewarm: boolean;
}

export function deriveBootstrapAppEntryState(
	state: BootstrapWindowState,
): BootstrapAppEntryState {
	if (state.status === "pending") {
		return { status: "window_pending" };
	}

	if (state.status === "error") {
		return {
			status: "bootstrap_error_fallback",
			reason: state.reason,
		};
	}

	if (state.info?.is_prewarm === true) {
		return {
			status: "prewarm_blocked",
			info: state.info,
		};
	}

	return {
		status: "startup_allowed",
		info: state.info,
	};
}

export function canRenderApp(entry: BootstrapAppEntryState): boolean {
	return entry.status !== "prewarm_blocked";
}

export function canStartApp(entry: BootstrapAppEntryState): boolean {
	return (
		entry.status === "startup_allowed" ||
		entry.status === "bootstrap_error_fallback"
	);
}

export function isConfirmedPrewarm(entry: BootstrapAppEntryState): boolean {
	return entry.status === "prewarm_blocked";
}

export function deriveBootstrapDecision(
	state: BootstrapWindowState,
): BootstrapDecision {
	const entry = deriveBootstrapAppEntryState(state);
	return {
		shouldRenderApp: canRenderApp(entry),
		shouldStartApp: canStartApp(entry),
		isConfirmedPrewarm: isConfirmedPrewarm(entry),
	};
}
