import { beforeEach, describe, expect, mock, test } from "bun:test";

function playlistFixture(name: string) {
	return {
		name,
		avg_db: null,
		entries: [],
		exclude: [],
	};
}

const readAllMock = mock(async () => ({
	status: "ok" as const,
	data: [playlistFixture("library")],
}));
const deleteMock = mock(async () => ({
	status: "error" as const,
	error: "delete failed",
}));
const appReadyMock = mock(async () => undefined);
const passthroughStatusMock = mock(async () => ({
	status: "pending",
	phase: "loading",
}));

let processMsgListener:
	| ((event: { payload: { playlist: string; str: string } }) => void)
	| null = null;

mock.module("./commands", () => ({
	commands: {
		readAll: (...args: unknown[]) => readAllMock(...args),
		delete: (...args: unknown[]) => deleteMock(...args),
		appReady: (...args: unknown[]) => appReadyMock(...args),
		passthroughStatus: (...args: unknown[]) => passthroughStatusMock(...args),
	},
	events: {
		processMsg: {
			listen: async (
				handler: (event: { payload: { playlist: string; str: string } }) => void,
			) => {
				processMsgListener = handler;
				return () => {
					processMsgListener = null;
				};
			},
		},
	},
	makeLievt:
		(events: Record<string, { listen: (handler: (event: any) => void) => any }>) =>
		(key: string) =>
		(handler: (payload: unknown) => void) =>
			events[key].listen((event) => handler(event.payload)),
}));

const { crab } = await import("./commandAdapter");

describe("command adapter", () => {
	beforeEach(() => {
		readAllMock.mockReset();
		readAllMock.mockImplementation(async () => ({
			status: "ok" as const,
			data: [playlistFixture("library")],
		}));

		deleteMock.mockReset();
		deleteMock.mockImplementation(async () => ({
			status: "error" as const,
			error: "delete failed",
		}));

		appReadyMock.mockReset();
		appReadyMock.mockImplementation(async () => undefined);

		passthroughStatusMock.mockReset();
		passthroughStatusMock.mockImplementation(async () => ({
			status: "pending",
			phase: "loading",
		}));

		processMsgListener = null;
	});

	test("command_adapter_true_positive_wraps_ok_specta_payload_as_ok_result", async () => {
		const result = await crab.readAll();

		expect(result.isOk()).toBeTrue();
		expect(result.unwrap().map((playlist) => playlist.name)).toEqual(["library"]);
	});

	test("command_adapter_true_positive_wraps_error_specta_payload_as_err_result", async () => {
		const result = await crab.delete("broken");

		expect(result.isErr()).toBeTrue();
		expect(result.unwrap_err()).toBe("delete failed");
	});

	test("command_adapter_true_negative_passthroughs_non_specta_commands_without_result_wrapping", async () => {
		const result = await crab.appReady();

		expect(result).toBeUndefined();
	});

	test("command_adapter_false_positive_guard_does_not_wrap_non_specta_status_objects", async () => {
		const result = await (crab as typeof crab & {
			passthroughStatus: () => Promise<{ status: string; phase: string }>;
		}).passthroughStatus();

		expect(result).toEqual({
			status: "pending",
			phase: "loading",
		});
	});

	test("command_adapter_true_positive_forwards_event_payloads_through_evt_bridge", async () => {
		let observed: { playlist: string; str: string } | null = null;

		const unlisten = await crab.evt("processMsg")((payload) => {
			observed = payload;
		});

		processMsgListener?.({
			payload: {
				playlist: "daily",
				str: "Downloading daily",
			},
		});

		expect(observed).toEqual({
			playlist: "daily",
			str: "Downloading daily",
		});

		unlisten();
		expect(processMsgListener).toBeNull();
	});
});
