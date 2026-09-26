import { setTimeout as delay, setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LxdOfficeLifecycleResult, runLxdOfficeLifecycle } from "../src/lxd-office-lifecycle.ts";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(), setImmediate: vi.fn() }));
afterEach(() => vi.resetAllMocks());
beforeEach(() => {
	vi.mocked(delay).mockResolvedValue(undefined);
	vi.mocked(yieldToEventLoop).mockResolvedValue(undefined);
});

describe("office lifecycle progress scheduling", () => {
	it("advances all settled provisioning phases without poll waits, then polls the active office", async () => {
		const controller = new AbortController();
		const phases = ["creation", "inventory", "review", "adoption", "boot", "preparation", "configuration"] as const;
		const results: LxdOfficeLifecycleResult[] = phases.map((phase) => ({ state: "progressed", phase }));
		results.push({ state: "active", phase: "activation" });
		const reconcile = vi.fn(async () => results.shift()!);
		vi.mocked(delay).mockImplementationOnce(async () => controller.abort());
		await runLxdOfficeLifecycle({ reconcile }, controller.signal, vi.fn(), vi.fn());
		expect(reconcile).toHaveBeenCalledTimes(8);
		expect(yieldToEventLoop).toHaveBeenCalledTimes(7);
		expect(delay).toHaveBeenCalledExactlyOnceWith(2000, undefined, { signal: controller.signal });
	});

	it.each<LxdOfficeLifecycleResult["state"]>([
		"idle",
		"held",
		"awaiting_review",
		"pending",
		"unknown",
		"failed",
		"capacity_refused",
		"awaiting_readiness",
		"powered_off",
		"awaiting_configuration",
		"awaiting_boot_admission",
		"active",
	])("retains backoff for %s", async (state) => {
		const controller = new AbortController();
		vi.mocked(delay).mockImplementationOnce(async () => controller.abort());
		await runLxdOfficeLifecycle({ reconcile: async () => ({ state }) }, controller.signal, vi.fn(), vi.fn(), 3000);
		expect(delay).toHaveBeenCalledExactlyOnceWith(3000, undefined, { signal: controller.signal });
		expect(yieldToEventLoop).not.toHaveBeenCalled();
	});

	it("backs off after an error following progress even when diagnostics fail", async () => {
		const controller = new AbortController();
		const reconcile = vi
			.fn()
			.mockResolvedValueOnce({ state: "progressed" })
			.mockRejectedValueOnce(new Error("authority unavailable"));
		vi.mocked(delay).mockImplementationOnce(async () => controller.abort());
		await runLxdOfficeLifecycle(
			{ reconcile },
			controller.signal,
			() => {
				throw new Error("diagnostic failed");
			},
			() => {
				throw new Error("diagnostic failed");
			},
		);
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(yieldToEventLoop).toHaveBeenCalledTimes(1);
		expect(delay).toHaveBeenCalledTimes(1);
	});

	it("waits for an advancing worker to settle and yields so cancellation can stop the next phase", async () => {
		const controller = new AbortController();
		let settle!: (result: LxdOfficeLifecycleResult) => void;
		const pending = new Promise<LxdOfficeLifecycleResult>((resolve) => {
			settle = resolve;
		});
		const reconcile = vi.fn(() => pending);
		vi.mocked(yieldToEventLoop).mockImplementationOnce(async () => controller.abort());
		const run = runLxdOfficeLifecycle({ reconcile }, controller.signal, vi.fn(), vi.fn());
		await Promise.resolve();
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(yieldToEventLoop).not.toHaveBeenCalled();
		settle({ state: "progressed" });
		await run;
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(yieldToEventLoop).toHaveBeenCalledExactlyOnceWith(undefined, { signal: controller.signal });
		expect(delay).not.toHaveBeenCalled();
	});
});
