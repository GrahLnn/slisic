import { describe, expect, test } from "bun:test";
import {
	events,
	makeLiveEvent,
	type AudioStopped,
} from "@/src/cmd/commands";

describe("audioStopped live contract boundary", () => {
	test("true positive: regenerated command contract exports audioStopped on the live event surface", () => {
		expect(events).toHaveProperty("audioStopped");
		expect(typeof events.audioStopped).toBe("function");
		expect(typeof events.audioStopped.listen).toBe("function");
		expect(typeof events.audioStopped.once).toBe("function");
		expect(typeof events.audioStopped.emit).toBe("function");
	});

	test("true positive: makeLiveEvent forwards regenerated audioStopped payloads to the frontend handler", async () => {
		const received: AudioStopped[] = [];
		const liveEventHandlers = new Map<string, (payload: unknown) => void>();
		const liveAudioStopped = {
			listen: async (handler: (event: { payload: AudioStopped }) => void) => {
				liveEventHandlers.set("audioStopped", (payload) => {
					handler({ payload: payload as AudioStopped });
				});
				return () => {
					liveEventHandlers.delete("audioStopped");
				};
			},
			once: async (handler: (event: { payload: AudioStopped }) => void) => {
				liveEventHandlers.set("audioStopped:once", (payload) => {
					handler({ payload: payload as AudioStopped });
				});
				return () => {
					liveEventHandlers.delete("audioStopped:once");
				};
			},
			emit: async (_payload: AudioStopped) => {},
		};
		const evt = makeLiveEvent({
			audioStopped: Object.assign(() => liveAudioStopped, liveAudioStopped),
		});
		const unsubscribe = await evt("audioStopped")((payload) => {
			received.push(payload);
		});

		liveEventHandlers.get("audioStopped")?.({
			session_id: 33,
			path: "C:/music/focus/a.flac",
		});

		expect(received).toEqual([
			{
				session_id: 33,
				path: "C:/music/focus/a.flac",
			},
		]);

		await unsubscribe();
	});

	test("false negative guard: mismatched audioStopped session id stays distinguishable at the boundary", async () => {
		const received: AudioStopped[] = [];
		const liveEventHandlers = new Map<string, (payload: unknown) => void>();
		const liveAudioStopped = {
			listen: async (handler: (event: { payload: AudioStopped }) => void) => {
				liveEventHandlers.set("audioStopped", (payload) => {
					handler({ payload: payload as AudioStopped });
				});
				return () => {
					liveEventHandlers.delete("audioStopped");
				};
			},
			once: async (handler: (event: { payload: AudioStopped }) => void) => {
				liveEventHandlers.set("audioStopped:once", (payload) => {
					handler({ payload: payload as AudioStopped });
				});
				return () => {
					liveEventHandlers.delete("audioStopped:once");
				};
			},
			emit: async (_payload: AudioStopped) => {},
		};
		const evt = makeLiveEvent({
			audioStopped: Object.assign(() => liveAudioStopped, liveAudioStopped),
		});
		const unsubscribe = await evt("audioStopped")((payload) => {
			received.push(payload);
		});

		liveEventHandlers.get("audioStopped")?.({
			session_id: 999,
			path: "C:/music/focus/a.flac",
		});

		expect(received[0]).toMatchObject({
			session_id: 999,
			path: "C:/music/focus/a.flac",
		});
		expect(received[0]?.session_id).not.toBe(33);

		await unsubscribe();
	});
});
