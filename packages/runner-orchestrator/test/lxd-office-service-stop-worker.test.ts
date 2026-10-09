import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeStopWorkerFixture } from "./fixtures/office-stop-worker.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const fixture = () => officeStopWorkerFixture(roots);
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("serialized provider stop worker", () => {
	it("retains intent before revocation and dispatch, freshly inspects, acknowledges once and recovers metadata", async () => {
		const f = await fixture();
		const result = await f.worker.reconcile(f.activation.request.intentId, f.request, signal());
		expect(result).toMatchObject({ state: "stopped", transitionId: f.request.transitionId, acknowledgedAtMs: 2000 });
		await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toEqual(result);
		expect(f.state.revocations).toBe(1);
		expect(f.state.acknowledgements).toBe(1);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it("does not depend on mutable workbench copies, former writer handoff or credential secrets", async () => {
		const f = await fixture();
		f.readProtected.mockRejectedValue(new Error("old handoff unavailable"));
		f.readCredential.mockRejectedValue(new Error("credential rotated"));
		f.activation.preparation.exec.mockRejectedValue(new Error("working files changed"));
		f.activation.configuration.exec.mockRejectedValue(new Error("configuration cannot run again"));
		await expect(f.worker.reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
			state: "stopped",
		});
		expect(f.activation.exec).toHaveBeenCalledOnce();
	});
	it.each([true, false])(
		"does not immediately resubmit an uncertain stop (completion present: %s)",
		async (physical) => {
			const f = await fixture(),
				original = f.exec.getMockImplementation()!;
			f.state.physical = physical;
			f.exec.mockImplementationOnce(async (...args) => {
				await original(...args);
				throw new Error("lost submission reply");
			});
			for (let i = 0; i < 2; i++)
				await expect(
					f.create().reconcile(f.activation.request.intentId, f.request, signal()),
				).resolves.toMatchObject({
					state: physical ? "stopped" : "unknown",
				});
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).toHaveBeenCalledTimes(physical ? 1 : 0);
		},
	);
	it.each(["qorpera_begin_runtime_office_lifecycle", "qorpera_ack_runtime_office_stop"] as const)(
		"recovers a lost committed %s reply with the same identity",
		async (method) => {
			const f = await fixture(),
				original = f.registry.getMockImplementation()!;
			let lost = false;
			f.registry.mockImplementation(async (...args) => {
				const result = await original(...args);
				if (args[0] === method && !lost) {
					lost = true;
					throw new Error("committed reply lost");
				}
				return result;
			});
			await expect(f.worker.reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
				"OFFICE_STOP_UNCONFIRMED",
			);
			await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
				state: "stopped",
			});
			expect(f.state.revocations).toBe(1);
			expect(f.state.acknowledgements).toBe(1);
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).toHaveBeenCalledOnce();
		},
	);
	it.each(["seed", "revocation", "stop", "index", "journal"] as const)(
		"refuses a missing %s after dispatch without replay",
		async (key) => {
			const f = await fixture();
			await f.worker.reconcile(f.activation.request.intentId, f.request, signal());
			await rm(f.names[key], { recursive: true });
			await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
				"OFFICE_STOP_UNCONFIRMED",
			);
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).toHaveBeenCalledOnce();
		},
	);
	it.each(["kernel", "host", "boot", "activation", "configuration", "scope"])(
		"refuses changed %s before revocation or dispatch",
		async (fault) => {
			const f = await fixture();
			let request = f.request;
			if (fault === "kernel") f.kernelLock.mockRejectedValue(new Error("missing lock"));
			if (fault === "host")
				f.check.mockResolvedValue({
					signal: signal(),
					validForMs: 5000,
					hostBootId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				});
			if (fault === "boot")
				f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(
					"ffffffff-ffff-4fff-8fff-ffffffffffff\n",
				);
			if (fault === "activation") await rm(f.activation.names.completion);
			if (fault === "configuration") f.guest.get("/etc/qorpera-office/credentials/config.json")!.content.fill(0);
			if (fault === "scope")
				request = {
					...request,
					startup: { ...request.startup, computerGeneration: request.startup.computerGeneration + 1 },
				};
			await expect(f.worker.reconcile(f.activation.request.intentId, request, signal())).rejects.toThrow(
				"OFFICE_STOP_UNCONFIRMED",
			);
			expect(f.registry).not.toHaveBeenCalled();
			expect(f.exec).not.toHaveBeenCalled();
		},
	);
	it.each(["nonce", "custody", "completion", "deadline"])(
		"refuses stale or changed inspection %s before acknowledgement",
		async (fault) => {
			const f = await fixture(),
				original = f.inspect.getMockImplementation()!;
			let elapsed = 0;
			if (fault === "deadline") vi.spyOn(performance, "now").mockImplementation(() => elapsed);
			f.inspect.mockImplementationOnce(async (...args) => {
				const result = await original(...args),
					file = f.guest.get(`/run/qorpera-office-preparation/service-stop-inspection-${args[3]}.json`)!;
				const value = JSON.parse(file.content.toString());
				if (fault === "nonce") value.inspectionId = f.request.transitionId;
				if (fault === "custody") file.uid = 1000;
				if (fault === "completion") value.stop.stoppedInvocationId = "f".repeat(32);
				if (fault === "deadline") elapsed = 5000;
				file.content = Buffer.from(JSON.stringify(value));
				return result;
			});
			await expect(f.worker.reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
				"OFFICE_STOP_UNCONFIRMED",
			);
			expect(f.state.acknowledgements).toBe(0);
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);
	it("bounds nonce attempts across replacement workers", async () => {
		const f = await fixture();
		for (let i = 1; i <= 64; i++)
			await writeFile(
				join(
					f.root,
					`stop-inspection-${f.binding.allocationId}-${f.request.transitionId}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}.json`,
				),
				"{}",
			);
		await expect(f.worker.reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
			"OFFICE_STOP_UNCONFIRMED",
		);
		expect(f.inspect).not.toHaveBeenCalled();
		expect(f.state.acknowledgements).toBe(0);
	});
	it("retains the process slot across worker replacement until cancelled SQL actually settles", async () => {
		const f = await fixture(),
			original = f.registry.getMockImplementation()!;
		let enter!: () => void, release!: () => void;
		const entered = new Promise<void>((resolve) => {
				enter = resolve;
			}),
			stalled = new Promise<void>((resolve) => {
				release = resolve;
			});
		f.registry.mockImplementation(async (...args) => {
			if (args[0] === "qorpera_begin_runtime_office_lifecycle") {
				enter();
				await stalled;
			}
			return original(...args);
		});
		const abort = new AbortController(),
			pending = f.worker.reconcile(f.activation.request.intentId, f.request, abort.signal);
		await entered;
		abort.abort();
		await expect(pending).rejects.toThrow("OFFICE_STOP_RECONCILIATION_ABORTED");
		await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
			"OFFICE_STOP_RECONCILIATION_PENDING",
		);
		release();
		await vi.waitFor(async () => {
			await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
				state: "stopped",
			});
		});
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("recovers a missing local acknowledgement only through SQL status without issuing another inspection", async () => {
		const f = await fixture();
		await f.worker.reconcile(f.activation.request.intentId, f.request, signal());
		await rm(f.names.done);
		await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
			state: "stopped",
		});
		expect(f.inspect).toHaveBeenCalledOnce();
		expect(
			(await readdir(f.root)).filter(
				(name) => name.startsWith("stop-inspection-") && !name.endsWith("-accepted.json"),
			),
		).toHaveLength(1);
	});
});
