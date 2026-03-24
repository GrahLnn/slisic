import { describe, expect, test } from "bun:test";
import { PlaybackScheduler } from "./playbackScheduler";

describe("PlaybackScheduler", () => {
	test("replaceWith cancels the previous task and keeps only the latest controller active", async () => {
		const scheduler = new PlaybackScheduler();
		const epoch = scheduler.bumpEpoch();
		const aborts: string[] = [];

		scheduler.replaceWith(async (signal) => {
			signal.addEventListener("abort", () => aborts.push("first"));
			await new Promise(() => {});
		}, epoch);

		scheduler.replaceWith(async (signal) => {
			signal.addEventListener("abort", () => aborts.push("second"));
			await new Promise(() => {});
		}, epoch);

		await Promise.resolve();
		expect(aborts).toEqual(["first"]);
	});

	test("cancelCurrent aborts the active task without advancing the scheduler epoch", async () => {
		const scheduler = new PlaybackScheduler();
		const epoch = scheduler.bumpEpoch();
		let aborted = false;

		scheduler.replaceWith(async (signal) => {
			signal.addEventListener("abort", () => {
				aborted = true;
			});
			await new Promise(() => {});
		}, epoch);

		scheduler.cancelCurrent();
		await Promise.resolve();

		expect(aborted).toBe(true);
		expect(scheduler.getEpoch()).toBe(epoch);
	});

	test("markDisposed blocks future scheduling and invalidates prior epochs", () => {
		const scheduler = new PlaybackScheduler();
		const epoch = scheduler.bumpEpoch();

		scheduler.markDisposed();

		expect(scheduler.replaceWith(async () => {}, epoch)).toBeNull();
		expect(
			scheduler.isActive(epoch, {
				mode: "play",
				selectedListName: "focus",
				playbackListName: "focus",
			}),
		).toBe(false);
	});
});
