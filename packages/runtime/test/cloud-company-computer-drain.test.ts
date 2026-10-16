import { performance } from "node:perf_hooks";
import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { CompanyComputerDrainSupervisor } from "@qorpera/runtime/cloud-company-computer-drain";
import { CompanyComputerScreenActionGate } from "@qorpera/runtime/cloud-company-computer-leases";
import { describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerLease,
	computerOperation,
	computerScope,
} from "./fixtures/company-computer.ts";

function fixture() {
	const gate = new CompanyComputerScreenActionGate();
	const challenge = { state: "draining" as const, drainId: computerId(40), epoch: 2, binding: computerBinding() };
	const stopResources = vi.fn<
		(binding: CompanyComputerScreenBinding, signal: AbortSignal, until: number) => Promise<void>
	>(async () => undefined);
	const call = vi.fn(async () => ({ state: "drained", drainId: challenge.drainId, epoch: challenge.epoch }));
	const supervisor = new CompanyComputerDrainSupervisor({
		scope: computerScope(),
		gate,
		stopResources,
		control: { call },
	});
	return { gate, challenge, stopResources, call, supervisor, signal: new AbortController().signal };
}
describe("physical office drain acknowledgement", () => {
	it("waits for the actual action and idle control channels before acknowledging the exact challenge", async () => {
		const f = fixture();
		const started = computerDeferred<void>();
		const work = computerDeferred<void>();
		const idle = computerDeferred<void>();
		const action = f.gate
			.perform({
				lease: computerLease(),
				operation: computerOperation(),
				signal: f.signal,
				authorize: async () => undefined,
				execute: async () => {
					started.resolve();
					await work.promise;
				},
			})
			.catch(() => undefined);
		await started.promise;
		f.stopResources.mockImplementation(() => idle.promise);
		const drained = f.supervisor.drain(f.challenge, f.signal);
		await vi.waitFor(() => expect(f.call).not.toHaveBeenCalled());
		expect(f.stopResources).not.toHaveBeenCalled();
		work.resolve();
		await vi.waitFor(() => expect(f.stopResources).toHaveBeenCalledTimes(1));
		expect(f.call).not.toHaveBeenCalled();
		idle.resolve();
		await drained;
		await action;
		expect(f.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_ack_runtime_office_drain",
			{
				p_scope: computerScope(),
				p_screen_id: computerBinding().screenId,
				p_computer_generation: 1,
				p_screen_generation: 1,
				p_epoch: 2,
				p_drain_id: computerId(40),
			},
			expect.any(AbortSignal),
		);
	});
	it("retains failed physical drain across same and later challenges", async () => {
		const f = fixture();
		f.stopResources.mockRejectedValue(new Error("process tree still running"));
		await expect(f.supervisor.drain(f.challenge, f.signal)).rejects.toThrow("process tree still running");
		f.stopResources.mockResolvedValue(undefined);
		await expect(f.supervisor.drain(f.challenge, f.signal)).rejects.toThrow();
		await expect(
			f.supervisor.drain({ ...f.challenge, epoch: 3, drainId: computerId(41) }, f.signal),
		).rejects.toThrow();
		expect(f.stopResources).toHaveBeenCalledTimes(1);
		expect(f.call).not.toHaveBeenCalled();
	});
	it("gives the stop, its folder boundary included, until a second before its 20 seconds, and never acknowledges a stop that ran out", async () => {
		const f = fixture();
		const called = computerDeferred<void>();
		f.stopResources.mockImplementation(() => {
			called.resolve();
			return new Promise<void>(() => undefined);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const drained = f.supervisor.drain(f.challenge, f.signal);
			drained.catch(() => undefined);
			await called.promise;
			const [binding, signal, until] = f.stopResources.mock.calls[0];
			expect(binding).toEqual(computerBinding());
			expect(until - performance.now()).toBeGreaterThan(18000);
			expect(until - performance.now()).toBeLessThanOrEqual(19000);
			await vi.advanceTimersByTimeAsync(19999);
			expect(signal.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await expect(drained).rejects.toThrow("COMPUTER_REQUEST_STOPPED");
			expect(signal.aborted).toBe(true);
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("rejects stale acknowledgements and does not replay an uncertain ack", async () => {
		const f = fixture();
		f.call.mockResolvedValue({ state: "drained", drainId: computerId(99), epoch: 2 });
		await expect(f.supervisor.drain(f.challenge, f.signal)).rejects.toThrow("OFFICE_DRAIN_UNCONFIRMED");
		await expect(f.supervisor.drain(f.challenge, f.signal)).rejects.toThrow();
		expect(f.call).toHaveBeenCalledTimes(1);
	});
});
