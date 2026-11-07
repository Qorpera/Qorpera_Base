import { describe, expect, it } from "vitest";
import { runRuntimeNodeObserverLoops } from "../src/runtime-node-observer-service.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

describe("the node observer's loops", () => {
	it("look again and again, each look under a scope of its own, and end with the signal that lasts as long as the process", async () => {
		const lasting = new AbortController();
		const looks = { inventory: 0, health: 0, exit: 0 };
		const seen: AbortSignal[] = [];
		const look =
			<T>(kind: keyof typeof looks, answer: T) =>
			async (signal: AbortSignal) => {
				looks[kind]++;
				seen.push(signal);
				// What a real look does with its signal: a request bounded by its own timeout.
				AbortSignal.any([signal, AbortSignal.timeout(60000)]);
				if (Object.values(looks).every((count) => count >= 4)) lasting.abort();
				return answer;
			};
		const reported: string[] = [];
		const watch = watchAbortSignalAny();
		try {
			await runRuntimeNodeObserverLoops(
				lasting.signal,
				{
					inventory: look("inventory", { state: "ready" as const }),
					health: look("health", undefined),
					exit: look("exit", { healthy: true }),
				},
				{
					report: (state) => reported.push(`inventory:${state}`),
					reportHealth: (state) => reported.push(`health:${state}`),
					reportExit: (state) => reported.push(`exit:${state}`),
				},
				1,
			);
			expect(Object.values(looks).every((count) => count >= 4)).toBe(true);
			expect(reported).toContain("inventory:ready");
			expect(reported).toContain("health:reported");
			expect(reported).toContain("exit:healthy");
			expect(seen.every((signal) => signal !== lasting.signal)).toBe(true);
			expect(watch.on(lasting.signal)).toBe(0);
			// Each look's own signal ends with the process's.
			expect(seen.every((signal) => signal.aborted)).toBe(false);
			expect(seen.at(-1)?.aborted).toBe(true);
		} finally {
			watch.restore();
		}
	});
});
