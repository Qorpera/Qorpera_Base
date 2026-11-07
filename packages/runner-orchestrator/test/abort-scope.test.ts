import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { withAbortScope } from "../src/abort-scope.ts";
import { CloudCodingExecutor } from "../src/coding-executor.ts";

/** What Node keeps on a plain signal for each `AbortSignal.any` over it. Node 22 does for every one; Node 24, which the
 * tests run on, only once the result has a listener, as a request's signal does. */
const dependants = (signal: AbortSignal): number => {
	const key = Object.getOwnPropertySymbols(signal).find((symbol) => String(symbol).includes("kDependantSignals"));
	return key ? ((signal as unknown as Record<symbol, Set<unknown> | undefined>)[key]?.size ?? 0) : 0;
};

describe("withAbortScope", () => {
	it("ends the scope when its parent ends, with the parent's reason", async () => {
		const parent = new AbortController();
		const reason = new Error("CODING_EXECUTOR_SHUTDOWN");
		await withAbortScope(parent.signal, async (scoped) => {
			expect(scoped.aborted).toBe(false);
			parent.abort(reason);
			expect(scoped.aborted).toBe(true);
			expect(scoped.reason).toBe(reason);
		});
	});

	it("starts ended under a parent that has ended", async () => {
		const parent = new AbortController();
		parent.abort(new Error("over"));
		await withAbortScope(parent.signal, async (scoped) => {
			expect(scoped.aborted).toBe(true);
		});
	});

	it("leaves nothing on its parent once the work ended, however it ended", async () => {
		const parent = new AbortController();
		await withAbortScope(parent.signal, async (scoped) => {
			AbortSignal.any([scoped, AbortSignal.timeout(60000)]).addEventListener("abort", () => undefined);
			AbortSignal.any([AbortSignal.any([scoped, AbortSignal.timeout(60000)]), AbortSignal.timeout(60000)]).addEventListener(
				"abort",
				() => undefined,
			);
			expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
		});
		await expect(
			withAbortScope(parent.signal, async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow("failed");
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
		expect(dependants(parent.signal)).toBe(0);
	});
});

describe("the coding executor over the signal that lasts as long as its process", () => {
	const executor = (host: Record<string, unknown>, call = vi.fn(async () => null)) =>
		new CloudCodingExecutor({
			control: { call },
			host: host as never,
			owner: "mx-a",
			report: () => undefined,
		});

	it("leaves nothing on it for a claim that finds no turn", async () => {
		const lasting = new AbortController();
		const call = vi.fn(async (_method: string, _args: Record<string, unknown>, signal: AbortSignal) => {
			expect(signal.aborted).toBe(false);
			signal.addEventListener("abort", () => undefined);
			return null;
		});
		const running = executor({}, call as never);
		for (let claims = 0; claims < 5; claims++) expect(await running.claim(lasting.signal)).toEqual({ state: "idle" });
		expect(call).toHaveBeenCalledTimes(5);
		expect(dependants(lasting.signal)).toBe(0);
		expect(getEventListeners(lasting.signal, "abort")).toHaveLength(0);
	});
});
