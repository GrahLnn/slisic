import { beforeEach, describe, expect, mock, test } from "bun:test";

const impl = {
	create: async () => ({ status: "ok" as const, data: { saved: true } }),
	readAll: async () => ({ status: "error" as const, error: "db offline" }),
	appReady: async () => undefined,
};

const events = {
	processMsg: {
		listen: async (handler: (event: { payload: { playlist: string; str: string } }) => void) => {
			handler({ payload: { playlist: "focus", str: "working" } });
			return () => {};
		},
	},
};

function makeLievt<T extends Record<string, any>>(ev: T) {
	return function lievt<K extends keyof T>(key: K) {
		return (handler: (payload: any) => void) => {
			const obj = ev[key] as { listen: (cb: (event: { payload: any }) => void) => Promise<() => void> };
			return obj.listen((event) => handler(event.payload));
		};
	};
}

mock.module("./commands", () => ({
	commands: {
		create: () => impl.create(),
		readAll: () => impl.readAll(),
		appReady: () => impl.appReady(),
	},
	events,
	makeLievt,
}));

const { crab } = await import("./commandAdapter");

beforeEach(() => {
	impl.create = async () => ({ status: "ok" as const, data: { saved: true } });
	impl.readAll = async () => ({ status: "error" as const, error: "db offline" });
	impl.appReady = async () => undefined;
});

describe("command adapter", () => {
	test("true_positive_wraps_specta_ok_result_into_ok_variant", async () => {
		const result = await crab.create({} as never);
		expect(result.isOk()).toBe(true);
		expect(result.unwrap()).toEqual({ saved: true });
	});

	test("true_negative_wraps_specta_error_result_into_err_variant", async () => {
		const result = await crab.readAll();
		expect(result.isErr()).toBe(true);
		expect(result.unwrap_err()).toBe("db offline");
	});

	test("false_positive_guard_leaves_non_specta_commands_unwrapped", async () => {
		const result = await crab.appReady();
		expect(result).toBeUndefined();
	});
});
