import { performance } from "node:perf_hooks";
import { companyComputerRequest } from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	CompanyComputerScreenActionGate,
	type CompanyComputerScreenLeaseControl,
	CompanyComputerScreenLeaseHandle,
} from "@qorpera/runtime/cloud-company-computer-leases";
import {
	companyComputerScreenBinding,
	companyComputerScreenLease,
	transitionCompanyComputerScreens,
} from "@qorpera/runtime/cloud-company-computer-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerLease,
	computerOperation,
	computerRegistry,
	computerRun,
	computerScope,
} from "./fixtures/company-computer.ts";

function leaseControl(): CompanyComputerScreenLeaseControl {
	return {
		acquire: vi.fn(async () => computerLease()),
		check: vi.fn(async (lease: ReturnType<typeof computerLease>) => structuredClone(lease)),
		renew: vi.fn(async (lease: ReturnType<typeof computerLease>) => structuredClone(lease)),
		release: vi.fn(async () => undefined),
	};
}

const handles: CompanyComputerScreenLeaseHandle[] = [];
afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.close().catch(() => undefined);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("cloud screen lease handle (test-double authority)", () => {
	it("frequent authority checks do not postpone scheduled lease renewal", async () => {
		vi.useFakeTimers();
		let now = 0,
			expiresAt = 30000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const control = leaseControl();
		control.check = vi.fn(async () => ({ ...computerLease(), validForMs: expiresAt - now }));
		control.renew = vi.fn(async () => {
			expiresAt = now + 30000;
			return computerLease();
		});
		const handle = await CompanyComputerScreenLeaseHandle.acquire(computerRun(), computerScope(), control);
		handles.push(handle);
		for (let i = 0; i < 61; i++) {
			now += 1000;
			await vi.advanceTimersByTimeAsync(1000);
			await handle.assertActive(handle.signal);
		}
		expect(control.renew).toHaveBeenCalledTimes(6);
		expect(handle.signal.aborted).toBe(false);
	});
	it("scheduled renewal waits for an in-flight check and then renews instead of dropping the renewal", async () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const control = leaseControl();
		const handle = await CompanyComputerScreenLeaseHandle.acquire(computerRun(), computerScope(), control);
		handles.push(handle);
		now = 9000;
		await vi.advanceTimersByTimeAsync(9000);
		const pending = computerDeferred<ReturnType<typeof computerLease>>();
		control.check = vi.fn(() => pending.promise);
		const checked = handle.assertActive(handle.signal);
		await vi.advanceTimersByTimeAsync(0);
		now = 10000;
		await vi.advanceTimersByTimeAsync(1000);
		expect(control.renew).not.toHaveBeenCalled();
		pending.resolve({ ...computerLease(), validForMs: 20000 });
		await checked;
		await vi.advanceTimersByTimeAsync(0);
		expect(control.renew).toHaveBeenCalledOnce();
		expect(handle.signal.aborted).toBe(false);
	});
	it.each(["companyId", "environmentId", "companyComputerId", "logicalComputerId", "staffAgentId"] as const)(
		"does not acquire a substituted %s",
		async (key) => {
			const control = leaseControl();
			control.acquire = vi.fn(async () => ({
				...computerLease(),
				binding: { ...computerBinding(), [key]: computerId(99) },
			}));
			await expect(
				CompanyComputerScreenLeaseHandle.acquire(computerRun(), computerScope(), control),
			).rejects.toThrow();
			expect(control.check).not.toHaveBeenCalled();
		},
	);

	it("keeps lease identity immutable and releases exactly once", async () => {
		const control = leaseControl();
		const handle = await CompanyComputerScreenLeaseHandle.acquire(computerRun(), computerScope(), control);
		handles.push(handle);
		(handle.lease.binding as { screenId: string }).screenId = computerId(99);
		expect(handle.lease.binding.screenId).toBe(computerId(6));
		await Promise.all([handle.close(), handle.close()]);
		expect(control.release).toHaveBeenCalledOnce();
		expect(handle.signal.aborted).toBe(true);
		await expect(handle.assertActive(new AbortController().signal)).rejects.toThrow();
	});

	it.each(["leaseId", "epoch", "binding"] as const)(
		"treats changed %s on renewal as terminal, without reacquisition",
		async (field) => {
			vi.useFakeTimers();
			const control = leaseControl();
			const handle = await CompanyComputerScreenLeaseHandle.acquire(computerRun(), computerScope(), control);
			handles.push(handle);
			control.renew = vi.fn(async (lease: ReturnType<typeof computerLease>) => ({
				...lease,
				[field]:
					field === "leaseId" ? computerId(12) : field === "epoch" ? 2 : { ...lease.binding, screenGeneration: 2 },
			}));
			await vi.advanceTimersByTimeAsync(10_000);
			expect(handle.signal.aborted).toBe(true);
			expect(control.acquire).toHaveBeenCalledOnce();
		},
	);

	it("aborts on failed renewal, revoked access and stalled renewal before expiry", async () => {
		vi.useFakeTimers();
		for (const mode of ["failed", "stalled", "revoked"] as const) {
			const control = leaseControl();
			control.renew =
				mode === "stalled"
					? vi.fn(() => new Promise<ReturnType<typeof computerLease>>(() => {}))
					: vi.fn(async () => {
							throw new Error("ACCESS_REVOKED");
						});
			const handle = await CompanyComputerScreenLeaseHandle.acquire(computerRun(), computerScope(), control);
			handles.push(handle);
			if (mode === "revoked") {
				control.check = vi.fn(async () => {
					throw new Error("ACCESS_REVOKED");
				});
				await expect(handle.assertActive(new AbortController().signal)).rejects.toThrow("SCREEN_LEASE_UNAVAILABLE");
			} else await vi.advanceTimersByTimeAsync(30_000);
			expect(handle.signal.aborted).toBe(true);
			await handle.close();
		}
	});

	it("shares an in-flight check safely and observes run cancellation", async () => {
		const stop = new AbortController();
		const control = leaseControl();
		const handle = await CompanyComputerScreenLeaseHandle.acquire(computerRun(stop.signal), computerScope(), control);
		handles.push(handle);
		const checked = computerDeferred<ReturnType<typeof computerLease>>();
		control.check = vi.fn(() => checked.promise);
		const first = handle.assertActive(stop.signal);
		const second = handle.assertActive(stop.signal);
		checked.resolve(computerLease());
		await Promise.all([first, second]);
		expect(control.check).toHaveBeenCalledOnce();
		stop.abort();
		expect(handle.signal.aborted).toBe(true);
	});

	it("bounds uncooperative I/O and rejects invalid timeout budgets", async () => {
		vi.useFakeTimers();
		const pending = companyComputerRequest(() => new Promise(() => {}), new AbortController().signal, 10);
		const result = expect(pending).rejects.toThrow("COMPUTER_REQUEST_STOPPED");
		await vi.advanceTimersByTimeAsync(10);
		await result;
		await expect(companyComputerRequest(async () => 1, new AbortController().signal, 0)).rejects.toThrow(
			"INVALID_COMPUTER_TIMEOUT",
		);
	});
});

describe("guest action interlock and takeover drain", () => {
	it("admits a reused retired slot only after generation replacement and rejects its old lease", async () => {
		const gate = new CompanyComputerScreenActionGate();
		const signal = new AbortController().signal;
		const previous = computerBinding();
		let registry = computerRegistry();
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "retire", screenId: previous.screenId },
			1,
		).registry;
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "ensure", staffAgentId: computerId(11), newScreenId: computerId(12) },
			2,
		).registry;
		const next = companyComputerScreenBinding(registry, registry.screens[0]);
		const fenceEpoch = registry.screens[0].epoch;
		await gate.fence(previous, fenceEpoch, signal);
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{
				type: "claim",
				screenId: next.screenId,
				leaseId: computerId(13),
				driver: { kind: "agent", runId: computerId(14), staffAgentId: next.staffAgentId },
				validForMs: 1000,
			},
			3,
		).registry;
		const lease = companyComputerScreenLease(registry, registry.screens[0], 4);
		const perform = () =>
			gate.perform({
				lease,
				operation: computerOperation(),
				signal,
				authorize: async () => undefined,
				execute: async () => "new assignment",
			});
		await expect(perform()).rejects.toThrow("SCREEN_BINDING_MISMATCH");
		const ready = computerDeferred<void>();
		const replacement = gate.replaceBinding({
			previous,
			next,
			fenceEpoch,
			signal,
			assertReplacementReady: () => ready.promise,
		});
		await expect(perform()).rejects.toThrow("SCREEN_REPLACEMENT_PENDING");
		ready.resolve();
		await replacement;
		await expect(perform()).resolves.toBe("new assignment");
		await expect(
			gate.perform({
				lease: computerLease(),
				operation: computerOperation(),
				signal,
				authorize: async () => undefined,
				execute: async () => "stale assignment",
			}),
		).rejects.toThrow("SCREEN_BINDING_MISMATCH");
	});

	it("waits for actual stopped work, discards its result, and does not let the next driver overlap", async () => {
		const gate = new CompanyComputerScreenActionGate();
		const started = computerDeferred<AbortSignal>();
		const work = computerDeferred<string>();
		const effect = gate.perform({
			lease: computerLease(),
			operation: computerOperation(),
			signal: new AbortController().signal,
			authorize: async () => undefined,
			execute: (signal) => {
				started.resolve(signal);
				return work.promise;
			},
		});
		const outcome = effect.catch((error: unknown) => error);
		const signal = await started.promise;
		const fence = gate.fence(computerBinding(), 2, new AbortController().signal);
		expect(signal.aborted).toBe(true);
		await expect(
			gate.perform({
				lease: { ...computerLease(), epoch: 2 },
				operation: computerOperation(),
				signal: new AbortController().signal,
				authorize: async () => undefined,
				execute: async () => "overlap",
			}),
		).rejects.toThrow("SCREEN_ACTION_STILL_RUNNING");
		work.resolve("must not escape");
		expect(await outcome).toBeInstanceOf(Error);
		await expect(fence).resolves.toEqual({ computerGeneration: 1, screenGeneration: 1, epoch: 2 });
		await expect(
			gate.perform({
				lease: computerLease(),
				operation: computerOperation(),
				signal: new AbortController().signal,
				authorize: async () => undefined,
				execute: async () => "stale",
			}),
		).rejects.toThrow("SCREEN_DRIVER_FENCED");
	});

	it("times out without acknowledging a stuck predecessor or clearing quarantine", async () => {
		vi.useFakeTimers();
		const gate = new CompanyComputerScreenActionGate();
		const started = computerDeferred<void>();
		const work = computerDeferred<void>();
		const effect = gate
			.perform({
				lease: { ...computerLease(), validForMs: 20 },
				operation: computerOperation(),
				signal: new AbortController().signal,
				authorize: async () => undefined,
				execute: () => {
					started.resolve();
					return work.promise;
				},
			})
			.catch((error: unknown) => error);
		await started.promise;
		await vi.advanceTimersByTimeAsync(20);
		expect(await effect).toBeInstanceOf(Error);
		const fence = gate.fence(computerBinding(), 2, new AbortController().signal).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await fence).toBeInstanceOf(Error);
		await expect(
			gate.perform({
				lease: { ...computerLease(), epoch: 2 },
				operation: computerOperation(),
				signal: new AbortController().signal,
				authorize: async () => undefined,
				execute: async () => undefined,
			}),
		).rejects.toThrow("SCREEN_ACTION_STILL_RUNNING");
		work.resolve();
		await vi.advanceTimersByTimeAsync(0);
	});

	it("authorizes immediately before work and before releasing a result", async () => {
		const gate = new CompanyComputerScreenActionGate();
		const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("REVOKED"));
		await expect(
			gate.perform({
				lease: computerLease(),
				operation: computerOperation(),
				signal: new AbortController().signal,
				authorize,
				execute: async () => "private screen",
			}),
		).rejects.toThrow("REVOKED");
		expect(authorize).toHaveBeenCalledTimes(2);
	});

	it("admits parallel screens without allowing a generation reset to erase fences", async () => {
		const gate = new CompanyComputerScreenActionGate();
		const started = computerDeferred<void>();
		const work = computerDeferred<void>();
		const first = gate.perform({
			lease: computerLease(),
			operation: computerOperation(),
			signal: new AbortController().signal,
			authorize: async () => undefined,
			execute: () => {
				started.resolve();
				return work.promise;
			},
		});
		await started.promise;
		await expect(
			gate.perform({
				lease: {
					...computerLease(),
					binding: { ...computerBinding(), screenId: computerId(12), screenOrdinal: 2 },
				},
				operation: computerOperation(),
				signal: new AbortController().signal,
				authorize: async () => undefined,
				execute: async () => "parallel",
			}),
		).resolves.toBe("parallel");
		work.resolve();
		await first;
		await gate.fence(computerBinding(), 2, new AbortController().signal);
		const next = { ...computerBinding(), screenGeneration: 2 };
		await expect(
			gate.replaceBinding({
				previous: computerBinding(),
				next,
				fenceEpoch: 3,
				signal: new AbortController().signal,
				assertReplacementReady: async () => {
					throw new Error("OLD_PROCESS_STILL_ALIVE");
				},
			}),
		).rejects.toThrow("OLD_PROCESS_STILL_ALIVE");
		await expect(
			gate.perform({
				lease: { ...computerLease(), binding: next, epoch: 3 },
				operation: computerOperation(),
				signal: new AbortController().signal,
				authorize: async () => undefined,
				execute: async () => "unsafe",
			}),
		).rejects.toThrow("SCREEN_BINDING_MISMATCH");
		await gate.replaceBinding({
			previous: computerBinding(),
			next,
			fenceEpoch: 3,
			signal: new AbortController().signal,
			assertReplacementReady: async () => undefined,
		});
		await expect(
			gate.perform({
				lease: { ...computerLease(), binding: next, epoch: 4 },
				operation: computerOperation(),
				signal: new AbortController().signal,
				authorize: async () => undefined,
				execute: async () => "recovered",
			}),
		).resolves.toBe("recovered");
	});
});
