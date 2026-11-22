import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { withAbortScope, withAbortScopes, withTimeoutScope } from "../src/abort-scope.ts";
import { CloudCodingExecutor } from "../src/coding-executor.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

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
		const watch = watchAbortSignalAny();
		try {
			await withAbortScope(parent.signal, async (scoped) => {
				AbortSignal.any([scoped, AbortSignal.timeout(60000)]);
				AbortSignal.any([AbortSignal.any([scoped, AbortSignal.timeout(60000)]), AbortSignal.timeout(60000)]);
				expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
			});
			await expect(
				withAbortScope(parent.signal, async () => {
					throw new Error("failed");
				}),
			).rejects.toThrow("failed");
			expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
			expect(watch.made()).toBe(3);
			expect(watch.on(parent.signal)).toBe(0);
			// The watch itself sees what hangs off a signal, a composite's sources included.
			AbortSignal.any([AbortSignal.any([parent.signal, AbortSignal.timeout(60000)]), AbortSignal.timeout(60000)]);
			expect(watch.on(parent.signal)).toBe(2);
		} finally {
			watch.restore();
		}
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
			return null;
		});
		const running = executor({}, call as never);
		const watch = watchAbortSignalAny();
		try {
			for (let claims = 0; claims < 5; claims++)
				expect(await running.claim(lasting.signal)).toEqual({ state: "idle" });
			expect(call).toHaveBeenCalledTimes(5);
			expect(watch.made()).toBe(0);
			expect(watch.on(lasting.signal)).toBe(0);
			expect(getEventListeners(lasting.signal, "abort")).toHaveLength(0);
		} finally {
			watch.restore();
		}
	});
});

describe("withTimeoutScope", () => {
	it("forwards parent abort, fires TimeoutError on expiry, and avoids AbortSignal.any on parent", async () => {
		const parent = new AbortController();
		const watch = watchAbortSignalAny();
		try {
			await withTimeoutScope(parent.signal, 60_000, async (scoped) => {
				expect(scoped.aborted).toBe(false);
				expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
			});
			expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
			expect(watch.on(parent.signal)).toBe(0);

			let timedReason: unknown;
			await withTimeoutScope(parent.signal, 15, async (scoped) => {
				await new Promise<void>((resolve) => {
					scoped.addEventListener(
						"abort",
						() => {
							timedReason = scoped.reason;
							resolve();
						},
						{ once: true },
					);
				});
			});
			expect(timedReason).toBeInstanceOf(DOMException);
			expect((timedReason as DOMException).name).toBe("TimeoutError");
			expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);

			const reason = new Error("PARENT_STOP");
			await withTimeoutScope(parent.signal, 60_000, async (scoped) => {
				parent.abort(reason);
				expect(scoped.aborted).toBe(true);
				expect(scoped.reason).toBe(reason);
			});
			expect(watch.on(parent.signal)).toBe(0);
		} finally {
			watch.restore();
		}
	});
});

describe("withAbortScopes", () => {
	it("forwards abort from any parent, clears listeners on resolve and reject, and never calls AbortSignal.any", async () => {
		const first = new AbortController();
		const second = new AbortController();
		const watch = watchAbortSignalAny();
		try {
			await withAbortScopes([first.signal, undefined, second.signal], async (scoped) => {
				expect(scoped.aborted).toBe(false);
				expect(getEventListeners(first.signal, "abort")).toHaveLength(1);
				expect(getEventListeners(second.signal, "abort")).toHaveLength(1);
			});
			expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
			expect(getEventListeners(second.signal, "abort")).toHaveLength(0);

			await expect(
				withAbortScopes([first.signal, second.signal], async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
			expect(getEventListeners(second.signal, "abort")).toHaveLength(0);

			const reason = new Error("SECOND_PARENT_ABORT");
			await withAbortScopes([first.signal, second.signal], async (scoped) => {
				second.abort(reason);
				expect(scoped.aborted).toBe(true);
				expect(scoped.reason).toBe(reason);
			});
			expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
			expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
			expect(watch.made()).toBe(0);
		} finally {
			watch.restore();
		}
	});

	it("starts aborted without leaking listeners when a parent is pre-aborted", async () => {
		const live = new AbortController();
		const ended = new AbortController();
		const reason = new Error("ALREADY_ENDED");
		ended.abort(reason);
		await withAbortScopes([live.signal, ended.signal], async (scoped) => {
			expect(scoped.aborted).toBe(true);
			expect(scoped.reason).toBe(reason);
		});
		expect(getEventListeners(live.signal, "abort")).toHaveLength(0);
	});
});
