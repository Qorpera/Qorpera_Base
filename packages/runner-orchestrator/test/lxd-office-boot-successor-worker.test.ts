import { readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLxdOfficeStopEvidence } from "../src/lxd-office-stop-evidence.ts";
import { officeBootSuccessorWorkerFixture } from "./fixtures/office-boot-successor-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = () => officeBootSuccessorWorkerFixture(roots);
const errorMessages = (value: unknown) => {
	const messages: string[] = [];
	for (let error = value; error instanceof Error; error = error.cause) messages.push(error.message);
	return messages;
};
describe("provider same-boot successor after retained boot", () => {
	it("keeps restart inspection fresh with bounded guest and SQL read latency", async () => {
		const f = await fixture(),
			read = vi.mocked(f.client.readInstanceFile).getMockImplementation()!,
			call = f.registry.getMockImplementation()!,
			lock = f.kernelLock.getMockImplementation()!,
			beforeWindowReads = new Map<string, number>(),
			windowReads = new Map<string, number>();
		let inspectionStarted = 0,
			guestReads = 0,
			activeGuestReads = 0,
			kernelChecks = 0,
			sqlChecks = 0;
		let refusal: unknown;
		const guestReadMs = 120,
			sqlReadMs = 20;
		vi.mocked(f.client.readInstanceFile).mockImplementation(async (...args) => {
			if (!inspectionStarted) {
				const value = await read(...args);
				if (args[2].startsWith("/run/qorpera-office-preparation/boot-service-restart-completion-"))
					inspectionStarted = performance.now();
				else beforeWindowReads.set(args[2], (beforeWindowReads.get(args[2]) ?? 0) + 1);
				return value;
			}
			guestReads++;
			windowReads.set(args[2], (windowReads.get(args[2]) ?? 0) + 1);
			activeGuestReads++;
			try {
				await delay(guestReadMs, undefined, { signal: args[4] });
				return await read(...args);
			} finally {
				activeGuestReads--;
			}
		});
		f.kernelLock.mockImplementation(async (...args) => {
			if (inspectionStarted) kernelChecks++;
			else beforeWindowReads.clear();
			return lock(...args);
		});
		f.registry.mockImplementation(async (...args) => {
			if (inspectionStarted) {
				sqlChecks++;
				await delay(sqlReadMs, undefined, { signal: args[2] });
			}
			return call(...args);
		});
		try {
			expect(await f.worker.reconcileSettled(f.intentId, f.request, signal())).toMatchObject({ state: "active" });
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).toHaveBeenCalledOnce();
			expect(f.state.activations).toBe(1);
			expect(activeGuestReads).toBe(0);
			expect(kernelChecks).toBe(6);
			expect(sqlChecks).toBe(8);
			expect([...beforeWindowReads.values()].reduce((sum, count) => sum + count, 0)).toBe(10);
			for (const [path, count] of beforeWindowReads) expect(windowReads.get(path), path).toBe(count);
			expect(guestReads).toBe(11);
			expect(performance.now() - inspectionStarted).toBeLessThan(5000);
		} catch (error) {
			refusal = error;
			throw error;
		} finally {
			console.info(
				"RESTART_INSPECTION_LATENCY",
				JSON.stringify({
					guestReadMs,
					sqlReadMs,
					guestReads,
					kernelChecks,
					sqlChecks,
					inspectionElapsedMs: inspectionStarted ? Math.round(performance.now() - inspectionStarted) : null,
					inspectionDispatches: f.inspect.mock.calls.length,
					activations: f.state.activations,
					outstandingGuestReads: activeGuestReads,
					beforeWindowGuestReads: [...beforeWindowReads.values()].reduce((sum, count) => sum + count, 0),
					causes: errorMessages(refusal),
				}),
			);
		}
	}, 60000);
	it.each(["original", "final"] as const)(
		"retains the %s physical lease through inspection and activation",
		async (lease) => {
			const f = await fixture(),
				read = vi.mocked(f.client.readInstanceFile).getMockImplementation()!,
				check = f.check.getMockImplementation()!,
				inspect = f.inspect.getMockImplementation()!,
				call = f.registry.getMockImplementation()!;
			let latestLease: AbortController | undefined, originalLease: AbortController | undefined;
			f.check.mockImplementation(async (...args) => {
				const current = await check(...args);
				latestLease = new AbortController();
				return { ...current, signal: AbortSignal.any([current.signal, latestLease.signal]) };
			});
			vi.mocked(f.client.readInstanceFile).mockImplementation(async (...args) => {
				const value = await read(...args);
				if (args[2].startsWith("/run/qorpera-office-preparation/boot-service-restart-completion-"))
					originalLease = latestLease;
				return value;
			});
			f.inspect.mockImplementation(async (...args) => {
				const reference = await inspect(...args);
				if (lease === "original") {
					expect(originalLease).toBeDefined();
					originalLease!.abort(new Error("original physical lease expired"));
				}
				return reference;
			});
			f.registry.mockImplementation(async (...args) => {
				const value = await call(...args);
				if (lease === "final" && args[0] === "qorpera_runtime_office_successor_status") {
					expect(latestLease).toBeDefined();
					expect(latestLease).not.toBe(originalLease);
					latestLease!.abort(new Error("final physical lease expired"));
				}
				return value;
			});
			const refusal = await f.worker
				.reconcileSettled(f.intentId, f.request, signal())
				.catch((error: unknown) => error);
			expect(refusal).toBeInstanceOf(Error);
			const causes = errorMessages(refusal);
			expect(causes).toContain(
				lease === "original"
					? "OFFICE_INSPECTION_CALLER_ABORTED_DURING_SUBMISSION"
					: "OFFICE_SUCCESSOR_REQUEST_UNCONFIRMED",
			);
			expect(causes.some((cause) => /WINDOW_EXPIRED|REQUEST_EXPIRED|RECONCILIATION_ABORTED/.test(cause))).toBe(
				false,
			);
			if (lease === "final") {
				expect(originalLease?.signal.aborted).toBe(false);
				expect(latestLease?.signal.reason).toMatchObject({ message: "final physical lease expired" });
			} else expect(originalLease?.signal.reason).toMatchObject({ message: "original physical lease expired" });
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).toHaveBeenCalledOnce();
			expect(f.state.activations).toBe(0);
			expect(f.registry.mock.calls.some(([method]) => method === "qorpera_activate_runtime_office_successor")).toBe(
				false,
			);
		},
	);
	it.each([
		"stop request",
		"stop acknowledgement",
		"restart packet",
		"restart index",
		"kernel",
		"SQL",
		"guest configuration",
		"guest boot",
		"guest stop",
	] as const)("refuses changed %s during read-only inspection before activation", async (changed) => {
		const f = await fixture(),
			inspect = f.inspect.getMockImplementation()!;
		f.inspect.mockImplementation(async (...args) => {
			const reference = await inspect(...args);
			if (changed === "kernel") f.kernelLock.mockRejectedValue(new Error("kernel lock lost"));
			else if (changed === "SQL") f.state.enabled = false;
			else if (changed === "guest configuration")
				f.guest.get(`${f.directory}/credentials/config.json`)!.content.fill(0);
			else if (changed === "guest boot")
				f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(id(99));
			else if (changed === "guest stop") f.guest.get(f.stop.completionPath)!.uid = 1000;
			else {
				const path =
					changed === "stop request"
						? f.stop.names.stop
						: changed === "stop acknowledgement"
							? f.stop.names.done
							: changed === "restart packet"
								? f.paths().packet
								: f.paths().index;
				const value = JSON.parse(await readFile(path, "utf8"));
				value.schema = "changed";
				await writeFile(path, JSON.stringify(value));
			}
			return reference;
		});
		const refusal = await f.worker.reconcileSettled(f.intentId, f.request, signal()).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(Error);
		expect(errorMessages(refusal)).toContain(
			{
				"stop request": "inspection stop changed",
				"stop acknowledgement": "inspection stop changed",
				"restart packet": "restart evidence changed",
				"restart index": "restart evidence changed",
				kernel: "kernel lock lost",
				SQL: "authority unavailable",
				"guest configuration": "guest evidence custody",
				"guest boot": "successor boot changed",
				"guest stop": "root stop differs",
			}[changed],
		);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledOnce();
		expect(f.state.activations).toBe(0);
		expect(f.registry.mock.calls.some(([method]) => method === "qorpera_activate_runtime_office_successor")).toBe(
			false,
		);
	});
	it("retains prepared identity, dispatches once, inspects before activation and preserves initial history", async () => {
		const f = await fixture(),
			original = await readFile(f.originCompletion);
		const result = await f.worker.reconcile(f.intentId, f.request, signal());
		expect(result).toMatchObject({ state: "active", serviceInvocationId: "d".repeat(32) });
		await expect(f.create().reconcile(f.intentId, f.request, signal())).resolves.toEqual(result);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledTimes(2);
		expect(f.state.preparations).toBe(1);
		expect(f.state.activations).toBe(1);
		expect(await readFile(f.originCompletion)).toEqual(original);
		const recovery = {
			...f.request,
			activationId: result.activationId,
			transitionId: id(99),
			startup: { ...f.request.startup, serviceInvocationId: result.serviceInvocationId! },
		};
		const evidence = await readLxdOfficeStopEvidence(f.root, f.intentId, f.binding, recovery, f.client, signal());
		expect(evidence.initial).toBe(false);
		expect(evidence.completion.activationId).toBe(result.activationId);
		const seed = JSON.parse(await readFile(f.paths().seed, "utf8"));
		seed.startObservationSha256 = "9".repeat(64);
		await writeFile(f.paths().seed, JSON.stringify(seed));
		await expect(
			readLxdOfficeStopEvidence(f.root, f.intentId, f.binding, recovery, f.client, signal()),
		).rejects.toThrow("boot restart preparation differs");
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it.each([
		"origin",
		"originClaim",
		"restartClaim",
		"completion",
		"incomingCustody",
		"prepared",
		"stopReceipt",
	] as const)("refuses changed %s when selecting a later stop", async (fault) => {
		const f = await fixture();
		const result = await f.worker.reconcile(f.intentId, f.request, signal());
		const recovery = {
			...f.request,
			activationId: result.activationId,
			transitionId: id(99),
			startup: { ...f.request.startup, serviceInvocationId: result.serviceInvocationId! },
		};
		if (fault === "prepared" || fault === "stopReceipt") {
			const path = fault === "prepared" ? f.paths().prepared : f.stop.names.done;
			const value = JSON.parse(await readFile(path, "utf8"));
			if (fault === "prepared") value.stopAcknowledgedAtMs++;
			else value.receipt.acknowledgedAtMs++;
			await writeFile(path, JSON.stringify(value));
		} else {
			const prefix =
				fault === "origin"
					? "boot-service-start-incoming-"
					: fault === "originClaim"
						? "boot-service-start-claim."
						: fault === "restartClaim"
							? "service-successor-"
							: fault === "completion"
								? "boot-service-restart-completion-"
								: "boot-service-restart-incoming-";
			const file = [...f.guest].find(([path]) => path.startsWith(`/run/qorpera-office-preparation/${prefix}`))![1];
			if (fault === "incomingCustody") file.mode = 0o600;
			else {
				const value = JSON.parse(file.content.toString());
				if (fault === "origin") value.successor.request.bootIntentId = id(99);
				if (fault === "originClaim") value.activationId = result.activationId;
				if (fault === "restartClaim") value.predecessorActivationId = id(99);
				if (fault === "completion") value.schema = "qorpera.office-service-start-completion/v1";
				file.content = Buffer.from(JSON.stringify(value));
			}
		}
		await expect(
			readLxdOfficeStopEvidence(f.root, f.intentId, f.binding, recovery, f.client, signal()),
		).rejects.toThrow();
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
			await expect(f.create().reconcile(f.intentId, f.request, signal())).resolves.toMatchObject({
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
			await expect(f.worker.reconcile(f.intentId, f.request, signal())).rejects.toThrow(
				"OFFICE_SUCCESSOR_UNCONFIRMED",
			);
			await expect(f.create().reconcile(f.intentId, f.request, signal())).resolves.toMatchObject({
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
			await f.worker.reconcile(f.intentId, f.request, signal());
			await rm(f.paths()[key], { recursive: true });
			await expect(f.create().reconcile(f.intentId, f.request, signal())).rejects.toThrow(
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
			if (fault === "configuration") f.guest.get(`${f.directory}/credentials/config.json`)!.content.fill(0);
			if (fault === "action") request = { ...request, action: "reboot" };
			await expect(f.worker.reconcile(f.intentId, request, signal())).rejects.toThrow();
			expect(f.registry).not.toHaveBeenCalled();
			expect(f.exec).not.toHaveBeenCalled();
		},
	);
	it("keeps a physically running successor closed until fresh matching readiness", async () => {
		const f = await fixture();
		f.state.ready = false;
		await expect(f.worker.reconcile(f.intentId, f.request, signal())).resolves.toMatchObject({
			state: "awaiting_readiness",
		});
		f.state.current = {
			...f.state.current!,
			state: "ready",
			serviceInvocationId: "d".repeat(32),
			readinessFresh: false,
		};
		await expect(f.create().reconcile(f.intentId, f.request, signal())).resolves.toMatchObject({
			state: "awaiting_readiness",
		});
		f.state.current = { ...f.state.current, readinessFresh: true };
		await expect(f.create().reconcile(f.intentId, f.request, signal())).resolves.toMatchObject({
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
		await expect(f.worker.reconcile(f.intentId, f.request, signal())).rejects.toThrow("OFFICE_SUCCESSOR_UNCONFIRMED");
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
					file = f.guest.get(`/run/qorpera-office-preparation/boot-service-restart-inspection-${args[3]}.json`)!;
				const value = JSON.parse(file.content.toString());
				if (fault === "nonce") value.inspectionId = id(99);
				if (fault === "custody") file.uid = 1000;
				if (fault === "invocation") value.start.serviceInvocationId = "e".repeat(32);
				if (fault === "deadline") elapsed = 5000;
				file.content = Buffer.from(JSON.stringify(value));
				return result;
			});
			await expect(f.worker.reconcile(f.intentId, f.request, signal())).rejects.toThrow(
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
			result = f.worker.reconcileSettled(f.intentId, f.request, cancel.signal);
		let settled = false;
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const rejected = expect(result).rejects.toThrow("ABORTED");
		await entered;
		cancel.abort();
		await expect(f.create().reconcile(f.intentId, f.request, signal())).rejects.toThrow("PENDING");
		expect(settled).toBe(false);
		release();
		await rejected;
		await expect(f.create().reconcile(f.intentId, f.request, signal())).resolves.toMatchObject({
			state: "active",
		});
		expect(f.exec).toHaveBeenCalledOnce();
	});
});
