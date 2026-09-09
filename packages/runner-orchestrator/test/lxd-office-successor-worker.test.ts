import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLxdOfficeStopEvidence } from "../src/lxd-office-stop-evidence.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";
import { officeSuccessorWorkerFixture } from "./fixtures/office-successor-worker.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = () => officeSuccessorWorkerFixture(roots);
describe("provider same-boot successor worker", () => {
	it("retains prepared identity, dispatches once, inspects before activation and preserves initial history", async () => {
		const f = await fixture(),
			original = await readFile(f.activation.names.completion);
		const result = await f.worker.reconcile(f.activation.request.intentId, f.request, signal());
		expect(result).toMatchObject({ state: "active", serviceInvocationId: "c".repeat(32) });
		await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toEqual(result);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledTimes(2);
		expect(f.state.preparations).toBe(1);
		expect(f.state.activations).toBe(1);
		expect(await readFile(f.activation.names.completion)).toEqual(original);
		const recovery = {
			...f.request,
			activationId: result.activationId,
			transitionId: id(99),
			startup: { ...f.request.startup, serviceInvocationId: result.serviceInvocationId! },
		};
		const evidence = await readLxdOfficeStopEvidence(
			f.root,
			f.activation.request.intentId,
			f.binding,
			recovery,
			f.client,
			signal(),
		);
		expect(evidence.initial).toBe(false);
		expect(evidence.completion.activationId).toBe(result.activationId);
		const seed = JSON.parse(await readFile(f.paths().seed, "utf8"));
		seed.startObservationSha256 = "9".repeat(64);
		await writeFile(f.paths().seed, JSON.stringify(seed));
		await expect(
			readLxdOfficeStopEvidence(f.root, f.activation.request.intentId, f.binding, recovery, f.client, signal()),
		).rejects.toThrow("successor seed differs");
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it.each([true, false])("never repeats a lost dispatch reply (physical completion: %s)", async (physical) => {
		const f = await fixture(),
			original = f.exec.getMockImplementation()!;
		f.state.physical = physical;
		f.exec.mockImplementationOnce(async (...args) => {
			await original(...args);
			throw new Error("lost reply");
		});
		for (let n = 0; n < 2; n++)
			await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
				state: physical ? "active" : "unknown",
			});
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.state.activations).toBe(physical ? 1 : 0);
	});
	it.each(["qorpera_prepare_runtime_office_successor", "qorpera_activate_runtime_office_successor"] as const)(
		"recovers lost committed %s without rebinding",
		async (method) => {
			const f = await fixture(),
				original = f.registry.getMockImplementation()!;
			let lost = false;
			f.registry.mockImplementation(async (...args) => {
				const value = await original(...args);
				if (args[0] === method && !lost) {
					lost = true;
					throw new Error("reply lost");
				}
				return value;
			});
			await expect(f.worker.reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
				"OFFICE_SUCCESSOR_UNCONFIRMED",
			);
			await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
				state: "active",
			});
			expect(f.state.preparations).toBe(1);
			expect(f.state.activations).toBe(1);
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);
	it.each(["seed", "prepared", "packet", "index", "journal"] as const)(
		"refuses missing %s after dispatch",
		async (key) => {
			const f = await fixture();
			await f.worker.reconcile(f.activation.request.intentId, f.request, signal());
			await rm(f.paths()[key], { recursive: true });
			await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
				"OFFICE_SUCCESSOR_UNCONFIRMED",
			);
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).toHaveBeenCalledOnce();
		},
	);
	it.each(["kernel", "host", "boot", "stop", "acknowledgement", "configuration", "action"])(
		"refuses changed %s before preparation",
		async (fault) => {
			const f = await fixture();
			let request = f.request;
			if (fault === "kernel") f.kernelLock.mockRejectedValue(new Error("missing lock"));
			if (fault === "host") f.check.mockResolvedValue({ signal: signal(), validForMs: 5000, hostBootId: id(99) });
			if (fault === "boot") f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(id(99));
			if (fault === "stop") f.guest.delete(f.stop.completionPath);
			if (fault === "acknowledgement") await rm(f.stop.names.done);
			if (fault === "configuration") f.guest.get("/etc/qorpera-office/credentials/config.json")!.content.fill(0);
			if (fault === "action") request = { ...request, action: "reboot" };
			await expect(f.worker.reconcile(f.activation.request.intentId, request, signal())).rejects.toThrow();
			expect(f.registry).not.toHaveBeenCalled();
			expect(f.exec).not.toHaveBeenCalled();
		},
	);
	it("keeps a physically running successor closed until fresh matching readiness", async () => {
		const f = await fixture();
		f.state.ready = false;
		await expect(f.worker.reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
			state: "awaiting_readiness",
		});
		f.state.current = {
			...f.state.current!,
			state: "ready",
			serviceInvocationId: "c".repeat(32),
			readinessFresh: false,
		};
		await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
			state: "awaiting_readiness",
		});
		f.state.current = { ...f.state.current, readinessFresh: true };
		await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
			state: "active",
		});
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.state.activations).toBe(1);
	});
	it("refuses changed current authority after staging without dispatch", async () => {
		const f = await fixture(),
			original = f.readStage.getMockImplementation()!;
		f.readStage.mockImplementationOnce(async (...args) => {
			const result = await original(...args);
			f.state.enabled = false;
			return result;
		});
		await expect(f.worker.reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
			"OFFICE_SUCCESSOR_UNCONFIRMED",
		);
		expect(f.exec).not.toHaveBeenCalled();
		expect(f.state.activations).toBe(0);
	});
	it.each(["nonce", "custody", "invocation", "deadline"])(
		"refuses changed inspection %s before activation",
		async (fault) => {
			const f = await fixture(),
				original = f.inspect.getMockImplementation()!;
			let elapsed = 0;
			if (fault === "deadline") vi.spyOn(performance, "now").mockImplementation(() => elapsed);
			f.inspect.mockImplementationOnce(async (...args) => {
				const result = await original(...args),
					file = f.guest.get(`/run/qorpera-office-preparation/service-restart-inspection-${args[3]}.json`)!;
				const value = JSON.parse(file.content.toString());
				if (fault === "nonce") value.inspectionId = id(99);
				if (fault === "custody") file.uid = 1000;
				if (fault === "invocation") value.start.serviceInvocationId = "d".repeat(32);
				if (fault === "deadline") elapsed = 5000;
				file.content = Buffer.from(JSON.stringify(value));
				return result;
			});
			await expect(f.worker.reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow(
				"OFFICE_SUCCESSOR_UNCONFIRMED",
			);
			expect(f.state.activations).toBe(0);
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);
	it("holds cancellation ownership across worker replacement until SQL IO settles", async () => {
		const f = await fixture(),
			original = f.registry.getMockImplementation()!;
		let enter!: () => void, release!: () => void;
		const entered = new Promise<void>((r) => {
				enter = r;
			}),
			gate = new Promise<void>((r) => {
				release = r;
			});
		f.registry.mockImplementation(async (...args) => {
			if (args[0] === "qorpera_prepare_runtime_office_successor") {
				enter();
				await gate;
			}
			return original(...args);
		});
		const cancel = new AbortController(),
			result = f.worker.reconcile(f.activation.request.intentId, f.request, cancel.signal);
		await entered;
		cancel.abort();
		await expect(result).rejects.toThrow("ABORTED");
		await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).rejects.toThrow("PENDING");
		release();
		await vi.waitFor(async () => {
			await expect(f.create().reconcile(f.activation.request.intentId, f.request, signal())).resolves.toMatchObject({
				state: "active",
			});
		});
		expect(f.exec).toHaveBeenCalledOnce();
	});
});
