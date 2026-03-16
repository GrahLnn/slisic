import { describe, expect, test } from "bun:test";
import { Result } from "@grahlnn/fn";
import { normalizeCommandValue } from "@/src/cmd/commandAdapter";

describe("commandAdapter Specta contract", () => {
	test("true positive: ok Specta payload becomes Result ok", () => {
		const result = normalizeCommandValue<number, string>({
			status: "ok",
			data: 7,
		});

		expect(result).toBeInstanceOf(Result);
		expect((result as Result<number, string>).isOk()).toBe(true);
		expect((result as Result<number, string>).raw).toEqual({ ok: true, value: 7 });
	});

	test("true negative: error Specta payload becomes Result err", () => {
		const result = normalizeCommandValue<number, string>({
			status: "error",
			error: "boom",
		});

		expect(result).toBeInstanceOf(Result);
		expect((result as Result<number, string>).isErr()).toBe(true);
		expect((result as Result<number, string>).raw).toEqual({
			ok: false,
			error: "boom",
		});
	});

	test("false positive guard: non Specta status should pass through unchanged", () => {
		const raw = {
			status: "pending",
			data: 7,
		};

		expect(normalizeCommandValue<number, string>(raw)).toBe(raw);
	});

	test("false negative guard: raw primitive should not be wrapped", () => {
		expect(normalizeCommandValue<number, string>(42)).toBe(42);
		expect(normalizeCommandValue<number, string>(null)).toBeNull();
	});
});
