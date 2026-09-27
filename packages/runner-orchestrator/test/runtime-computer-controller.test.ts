import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PaidComputerGuard,
	PaidComputerGuardJournal,
	type PaidComputerHostClock,
	type PaidComputerPermit,
} from "../src/computer-paid-guard.ts";
import { LxdPaidComputerGuardPhysical } from "../src/computer-paid-guard-lxd.ts";
import {
	type PaidComputerUsageFrame,
	paidComputerUsageCursor,
	parsePaidComputerUsageEntry,
} from "../src/computer-paid-usage.ts";
import { computerPrestartDigest } from "../src/computer-prestart-control.ts";
import type {
	LxdInstanceClock,
	LxdInstanceRecord,
	LxdOperationReference,
	LxdTrackedClient,
} from "../src/lxd-client.ts";
import { type RuntimeComputerContext, RuntimeComputerController } from "../src/runtime-computer-controller.ts";
import type { RuntimePaidComputerMachine } from "../src/runtime-paid-machine.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(providerKind: "native" | "office" = "native", usage = false) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-permit-")));
	roots.push(root);
	await chmod(root, 0o700);
	const clock: PaidComputerHostClock = {
		hostMachineIdSha256: "a".repeat(64),
		hostBootId: randomUUID(),
		uptimeMs: 100000,
	};
	const context: RuntimeComputerContext = {
		allocationId: randomUUID(),
		providerKind,
		providerId: providerKind,
		policySha256: "b".repeat(64),
		instanceSha256: "c".repeat(64),
		bootstrapSha256: "d".repeat(64),
		runId: providerKind === "native" ? randomUUID() : null,
		runnerId: providerKind === "native" ? randomUUID() : null,
		officeId: providerKind === "office" ? randomUUID() : null,
		computerGeneration: providerKind === "office" ? 1 : null,
	};
	const target: RuntimePaidComputerMachine["physicalTarget"] = {
		kind: "lxd",
		project: "native",
		instanceName: `qorpera-${context.allocationId.replaceAll("-", "")}`,
		profiles: ["native-v1"],
		config: { "limits.cpu": "4", "limits.memory": "8GiB", "user.qorpera.instance_sha256": context.instanceSha256 },
		devices: { root: { type: "disk", path: "/", pool: "native", size: "64GiB" } },
	};
	let instance: LxdInstanceRecord | undefined = {
		name: target.instanceName,
		type: "virtual-machine",
		profiles: [...target.profiles],
		status: "Stopped",
		statusCode: 102,
		config: { ...target.config, "volatile.uuid": randomUUID() },
		expandedConfig: {},
		devices: structuredClone(target.devices),
		expandedDevices: structuredClone(target.devices),
	};
	instance.expandedConfig = { ...instance.config };
	const guestBootId = randomUUID();
	let guestUptime = 1;
	const operation = (): LxdOperationReference => ({
		project: target.project,
		instanceName: target.instanceName,
		operationId: randomUUID(),
	});
	const client = {
		getInstance: vi.fn(async () => (instance ? structuredClone(instance) : undefined)),
		submitInstanceOperation: vi.fn(
			async (_project: string, request: Parameters<LxdTrackedClient["submitInstanceOperation"]>[1]) => {
				if (!instance || (request.action !== "start" && request.action !== "stop"))
					throw new Error("unexpected physical effect");
				instance.status = request.action === "start" ? "Running" : "Stopped";
				instance.statusCode = request.action === "start" ? 103 : 102;
				return operation();
			},
		),
		inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
		readInstanceClock: vi.fn(
			async (): Promise<LxdInstanceClock> => ({ bootId: guestBootId, uptimeMs: guestUptime * 1000 }),
		),
		readInstanceFile: vi.fn(async (_project: string, _name: string, path: string) => ({
			content: Buffer.from(path === "/proc/uptime" ? `${guestUptime}.00 0.00\n` : `${guestBootId}\n`),
			uid: 0,
			gid: 0,
			mode: 0o444,
		})),
	};
	const journal = new PaidComputerGuardJournal(root),
		hostClock = async () => ({ ...clock });
	const usageOptions = usage
		? {
				usageCapture: {
					capture: async () => ({
						host: await hostClock(),
						guestBootId,
						guestUptimeMs: guestUptime * 1000,
						evidenceSha256: "e".repeat(64),
						observedAt: new Date().toISOString(),
					}),
				},
			}
		: {};
	let guard = new PaidComputerGuard(
		journal,
		new LxdPaidComputerGuardPhysical(client, hostClock),
		hostClock,
		usageOptions,
	);
	await guard.initialize();
	let permit: PaidComputerPermit | null = null,
		abandonmentClosure: Record<string, unknown> | null = null,
		lastSample: Record<string, unknown> | null = null,
		mode: "paid" | "shadow" = "paid";
	let losePrepare = false,
		loseRenew = false,
		loseFinish = false,
		sourceUnavailable = false;
	const samples: Record<string, unknown>[] = [];
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
			const request = args.p_request as Record<string, unknown>;
			if (method === "qorpera_describe_runtime_computer_prestart")
				return {
					state: abandonmentClosure ? "abandoned" : (permit?.state ?? "absent"),
					permit,
					lastSample,
					closure: abandonmentClosure,
				};
			if (method.includes("describe")) {
				if (sourceUnavailable) throw new Error("native run no longer exists");
				return {
					mode,
					permit: permit?.state === "closed" ? null : permit,
					lastSample,
					workReady: lastSample?.state === "running",
				};
			}
			if (method.includes("prepare")) {
				if (permit) throw new Error("duplicate reservation");
				permit = {
					schema: "qorpera.computer-usage-permit/v2",
					prestart: request.prestart as PaidComputerPermit["prestart"],
					mode: "paid",
					permitId: String(request.requestId),
					allocationId: context.allocationId,
					instanceSha256: context.instanceSha256,
					nodeId: randomUUID(),
					epoch: randomUUID(),
					generation: 1,
					reservationId: randomUUID(),
					hostBootId: clock.hostBootId,
					guestBootId: null,
					physicalId: null,
					issuedAt: "2026-09-25T12:00:00.000Z",
					deadline: "2026-09-25T12:05:30.000Z",
					validForMs: 330000,
					windowMs: 300000,
					stopReserveMs: 30000,
					tariffVersion: 1,
					cpuMillis: 4000,
					memoryBytes: 8 * 1024 ** 3,
					state: "prepared",
				};
				if (losePrepare) {
					losePrepare = false;
					throw new Error("prepare reply lost");
				}
				return permit;
			}
			if (method.includes("abandon")) {
				if (abandonmentClosure) return abandonmentClosure;
				const reservationReleased = permit !== null;
				if (permit) permit = { ...permit, state: "closed" };
				abandonmentClosure = {
					schema: "qorpera.computer-abandonment-receipt/v1",
					permitId: request.permitId,
					state: "abandoned_before_dispatch",
					abandonment: request.abandonment,
					reservationReleased,
					debitedUs: "0",
					releasedUs: reservationReleased ? "330000000" : "0",
				};
				return abandonmentClosure;
			}
			if (!permit) throw new Error("permit missing");
			if (method === "qorpera_record_computer_guard_samples") {
				const frames = request.entries as PaidComputerUsageFrame[];
				for (const frame of frames) {
					const recorded = parsePaidComputerUsageEntry(JSON.parse(frame.entryText)).sample;
					if (recorded.observationId === lastSample?.observationId) continue;
					if (recorded.previousObservationId !== (lastSample?.observationId ?? null))
						throw new Error("SQL predecessor differs");
					lastSample = structuredClone(recorded) as unknown as Record<string, unknown>;
					samples.push(structuredClone(lastSample));
					if (recorded.state === "running")
						permit = {
							...permit,
							state: "bound",
							physicalId: recorded.physicalId,
							guestBootId: recorded.guestBootId,
						};
				}
				return {
					schema: "qorpera.computer-guard-usage-receipt/v1",
					permit,
					cursor: paidComputerUsageCursor(frames.at(-1)!),
					sealed: lastSample?.state === "stopped" || lastSample?.state === "absent",
					lastSample,
				};
			}

			const sample = request.sample as Record<string, unknown>;
			if (request.generation !== permit.generation) throw new Error("SQL generation differs");
			if (
				!(usage && sample.observationId === lastSample?.observationId) &&
				sample.previousObservationId !== (lastSample?.observationId ?? null)
			)
				throw new Error("SQL predecessor differs");
			if (!usage || sample.observationId !== lastSample?.observationId) samples.push(structuredClone(sample));
			lastSample = structuredClone(sample);
			if (method.includes("bind"))
				permit = {
					...permit,
					state: "bound",
					physicalId: String(sample.physicalId),
					guestBootId: String(sample.guestBootId),
				};
			if (method.includes("renew")) {
				permit = {
					...permit,
					generation: permit.generation + 1,
					reservationId: randomUUID(),
					issuedAt: "2026-09-25T12:04:10.000Z",
					deadline: "2026-09-25T12:09:40.000Z",
					validForMs: 330000,
				};
				if (loseRenew) {
					loseRenew = false;
					throw new Error("renew reply lost");
				}
			}
			if (method.includes("finish")) {
				permit = { ...permit, state: "closed" };
				if (loseFinish) {
					loseFinish = false;
					throw new Error("finish reply lost");
				}
			}
			return permit;
		}),
	};
	const options = () => ({
		control,
		guard,
		client,
		clock: hostClock,
		now: () => Date.parse("2026-09-25T12:00:00Z") + clock.uptimeMs,
	});
	// Historical unmarked custody remains recoverable. Seed its exact retained
	// v2 intent before the controller runs; fresh producer tests skip this fixture.
	if (!usage) {
		const prepareRequestText = JSON.stringify({
			...context,
			schema: "qorpera.runtime-computer-prepare/v2",
			requestId: context.allocationId,
			machineIdSha256: clock.hostMachineIdSha256,
			hostBootId: clock.hostBootId,
			windowMs: 300000,
			stopReserveMs: 30000,
		});
		await guard.registerPrestart({
			schema: "qorpera.computer-prestart-intent/v1",
			permitId: context.allocationId,
			allocationId: context.allocationId,
			instanceSha256: context.instanceSha256,
			hostMachineIdSha256: clock.hostMachineIdSha256,
			hostBootId: clock.hostBootId,
			prepareRequestText,
			prepareSha256: computerPrestartDigest(prepareRequestText),
		});
	}
	let controller = new RuntimeComputerController(options());
	return {
		context,
		target,
		clock,
		client,
		control,
		samples,
		get controller() {
			return controller;
		},
		get guard() {
			return guard;
		},
		get permit() {
			return permit;
		},
		get instance() {
			return instance;
		},
		setMode(value: typeof mode) {
			mode = value;
		},
		setGuestUptime(value: number) {
			guestUptime = value;
		},
		losePrepare() {
			losePrepare = true;
		},
		loseRenew() {
			loseRenew = true;
		},
		loseFinish() {
			loseFinish = true;
		},
		moveSource() {
			sourceUnavailable = true;
		},
		async restart() {
			guard = new PaidComputerGuard(
				journal,
				new LxdPaidComputerGuardPhysical(client, hostClock),
				hostClock,
				usageOptions,
			);
			await guard.initialize();
			controller = new RuntimeComputerController(options());
		},
		removeInstance() {
			instance = undefined;
		},
		async start() {
			await controller.ensure(context, context.allocationId, new AbortController().signal);
			await controller.start(context.allocationId, target, new AbortController().signal);
			await guard.sweep();
			await controller.observe(context.allocationId, new AbortController().signal);
		},
	};
}
const signal = () => new AbortController().signal;
describe("funded runtime physical custody", () => {
	it.each(["native", "office"] as const)(
		"requires current SQL coverage and acknowledged guard tip for %s work",
		async (kind) => {
			const f = await fixture(kind, true);
			await f.start();
			await expect(f.controller.assertRunning(f.context.allocationId, signal())).rejects.toThrow(
				"RUNNING_PERMIT_REQUIRED",
			);
			f.guard.tickUsage();
			await f.guard.settleUsage(f.permit!.permitId);
			await f.controller.observe(f.context.allocationId, signal());
			const original = f.control.call.getMockImplementation()!;
			let verdict = false;
			f.control.call.mockImplementation(async (method, args) => {
				const result = await original(method, args);
				return method === "qorpera_describe_runtime_computer_permit"
					? { ...(result as object), workReady: verdict }
					: result;
			});
			await expect(f.controller.assertRunning(f.context.allocationId, signal())).rejects.toThrow(
				"RUNNING_PERMIT_REQUIRED",
			);
			verdict = true;
			await expect(f.controller.assertRunning(f.context.allocationId, signal())).resolves.toBeUndefined();
			f.clock.uptimeMs += 5000;
			f.setGuestUptime(6);
			const tick = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
			try {
				f.guard.tickUsage();
				await f.guard.settleUsage(f.permit!.permitId);
			} finally {
				tick.mockRestore();
			}
			await expect(f.controller.assertRunning(f.context.allocationId, signal())).rejects.toThrow(
				"RUNNING_PERMIT_REQUIRED",
			);
			await f.controller.observe(f.context.allocationId, signal());
			await expect(f.controller.assertRunning(f.context.allocationId, signal())).resolves.toBeUndefined();
			f.clock.uptimeMs += 10001;
			await expect(f.controller.assertRunning(f.context.allocationId, signal())).rejects.toThrow(
				"RUNNING_PERMIT_REQUIRED",
			);
		},
	);
	it("drains and archives a historical stream without replacing newer managed custody", async () => {
		const f = await fixture("native", true);
		await f.start();
		const oldId = f.permit!.permitId;
		f.guard.tickUsage();
		await f.guard.settleUsage(oldId);
		await f.controller.observe(f.context.allocationId, signal());
		await f.controller.stop(f.context.allocationId, signal());
		f.guard.tickUsage();
		await f.guard.settleUsage(oldId);
		const newer = { ...f.permit!, permitId: randomUUID(), epoch: randomUUID(), reservationId: randomUUID() };
		const original = f.control.call.getMockImplementation()!;
		f.control.call.mockImplementation(async (method, args) => {
			if (method === "qorpera_describe_runtime_computer_permit")
				return { mode: "paid", permit: newer, lastSample: null };
			return original(method, args);
		});
		await f.controller.recover(f.context, signal());
		const archive = vi.spyOn(f.guard, "archive");
		f.control.call.mockClear();
		await f.controller.maintain(signal());
		expect(f.controller.manages(f.context.allocationId)).toBe(true);
		expect(archive).toHaveBeenCalledTimes(1);
		expect(archive.mock.calls[0]?.[0]).toBe(oldId);
		expect(f.permit?.state).toBe("closed");
		expect(f.control.call.mock.calls.some(([method]) => method === "qorpera_describe_runtime_computer_permit")).toBe(
			true,
		);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["start", "stop"]);
	});
	it.each([false, true])(
		"uploads the guard-owned stream and waits for sealed ACK before finish (lost upload reply: %s)",
		async (lost) => {
			const f = await fixture("native", true);
			await f.controller.ensure(f.context, f.context.allocationId, signal());
			await f.controller.start(f.context.allocationId, f.target, signal());
			const permitId = f.permit!.permitId;
			expect((await f.guard.latest(f.context.allocationId))?.usageRequired).toBe(true);
			const prepare = f.control.call.mock.calls.find(
				([method]) => method === "qorpera_prepare_runtime_computer_permit",
			)?.[1].p_request as Record<string, unknown>;
			expect(prepare).toMatchObject({ schema: "qorpera.runtime-computer-prepare/v3", usageProducer: "guard-v1" });
			expect(JSON.parse(String(prepare.prepareRequestText))).toMatchObject({
				schema: prepare.schema,
				usageProducer: "guard-v1",
			});
			expect(prepare.prestart).toMatchObject({
				prepareSha256: computerPrestartDigest(String(prepare.prepareRequestText)),
			});
			await f.controller.observe(f.context.allocationId, signal());
			expect(f.permit?.state).toBe("prepared");
			expect(
				f.control.call.mock.calls.filter(([method]) => method.includes("bind") || method.includes("checkpoint")),
			).toHaveLength(0);
			f.guard.tickUsage();
			await f.guard.settleUsage(permitId);
			const page = await f.guard.readUsage(permitId);
			expect(page.head.sequence).toBe(1);
			if (lost) {
				const call = f.control.call.getMockImplementation()!;
				let lose = true;
				f.control.call.mockImplementation(async (method, request) => {
					const result = await call(method, request);
					if (method === "qorpera_record_computer_guard_samples" && lose) {
						lose = false;
						throw new Error("guard upload reply lost");
					}
					return result;
				});
				await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("upload reply lost");
				expect((await f.guard.readUsage(permitId)).acknowledgedThrough.sequence).toBe(0);
			}
			await f.controller.observe(f.context.allocationId, signal());
			expect(f.permit?.state).toBe("bound");
			expect((await f.guard.readUsage(permitId)).acknowledgedThrough).toEqual(page.head);
			expect(f.client.readInstanceClock).not.toHaveBeenCalled();
			await f.controller.stop(f.context.allocationId, signal());
			await f.controller.observe(f.context.allocationId, signal());
			expect(
				f.control.call.mock.calls.filter(([method]) => method === "qorpera_finish_runtime_computer_permit"),
			).toHaveLength(0);
			f.guard.tickUsage();
			await f.guard.settleUsage(permitId);
			await f.controller.observe(f.context.allocationId, signal());
			expect(f.permit?.state).toBe("closed");
			expect(await f.guard.list()).toHaveLength(0);
			expect(
				f.control.call.mock.calls.filter(([method]) => method.includes("bind") || method.includes("checkpoint")),
			).toHaveLength(0);
			expect(
				f.control.call.mock.calls.filter(([method]) => method === "qorpera_finish_runtime_computer_permit"),
			).toHaveLength(1);
		},
	);

	it.each(["native", "office"] as const)(
		"recovers %s SQL closure after lost renewal and finish replies without another settlement",
		async (kind) => {
			const f = await fixture(kind);
			await f.start();
			f.clock.uptimeMs = 350000;
			f.setGuestUptime(251);
			f.loseRenew();
			await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("renew reply lost");
			await f.controller.stop(f.context.allocationId, signal());
			const stopped = await f.guard.latest(f.context.allocationId);
			f.moveSource();
			f.loseFinish();
			await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("finish reply lost");
			expect(f.permit).toMatchObject({ generation: 2, state: "closed" });
			await f.restart();
			f.control.call.mockClear();
			await f.controller.maintain(signal());
			expect(await f.guard.list()).toEqual([]);
			expect(await f.guard.latest(f.context.allocationId)).toEqual(stopped);
			expect(
				f.control.call.mock.calls.filter(([method]) => method.includes("finish") || method.includes("renew")),
			).toHaveLength(0);
			expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["start", "stop"]);
		},
	);
	it.each(["epoch", "nodeId", "physicalId", "generation"])(
		"refuses stopped recovery before settlement when historical %s differs",
		async (field) => {
			const f = await fixture();
			await f.start();
			await f.controller.stop(f.context.allocationId, signal());
			const original = f.control.call.getMockImplementation()!;
			f.control.call.mockImplementation(async (method, args) => {
				const result = await original(method, args);
				if (method !== "qorpera_describe_runtime_computer_prestart") return result;
				return {
					...(result as Record<string, unknown>),
					permit: { ...f.permit, [field]: field === "generation" ? 3 : randomUUID() },
				};
			});
			await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow();
			expect(f.control.call.mock.calls.filter(([method]) => method.includes("finish"))).toHaveLength(0);
			expect(f.controller.manages(f.context.allocationId)).toBe(true);
			expect(await f.guard.list()).toHaveLength(1);
		},
	);
	it.each([1000, 1001, -1])("keeps the one-second, nondecreasing host clock bracket (%s ms)", async (elapsed) => {
		const f = await fixture();
		await f.start();
		const initial = f.samples.length;
		const read = f.client.readInstanceClock.getMockImplementation()!;
		f.client.readInstanceClock.mockImplementationOnce(async () => {
			const guest = await read();
			f.clock.uptimeMs += elapsed;
			return guest;
		});
		if (elapsed === 1000) {
			await f.controller.observe(f.context.allocationId, signal());
			expect(f.samples.length).toBe(initial + 1);
		} else {
			await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow(
				"OBSERVATION_UNCONFIRMED",
			);
			expect(f.samples.length).toBe(initial);
		}
	});
	it.each(["boot", "uptime", "fraction"])("refuses an invalid clock-port %s before SQL", async (failure) => {
		const f = await fixture();
		await f.start();
		const initial = f.samples.length;
		const guest = await f.client.readInstanceClock();
		f.client.readInstanceClock.mockResolvedValueOnce({
			bootId: failure === "boot" ? "invalid" : guest.bootId,
			uptimeMs: failure === "uptime" ? -1 : failure === "fraction" ? 0.5 : guest.uptimeMs,
		});
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("OBSERVATION_UNCONFIRMED");
		expect(f.samples.length).toBe(initial);
	});

	it("does not charge or renew while stopping, or advance SQL again before the recovered generation reaches the guard", async () => {
		const f = await fixture();
		await f.start();
		f.clock.uptimeMs = 350000;
		f.setGuestUptime(251);
		vi.spyOn(f.guard, "arm").mockRejectedValueOnce(new Error("guard renewal unavailable"));
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("guard renewal unavailable");
		expect(f.permit?.generation).toBe(2);
		const calls = f.control.call.mock.calls.length;
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("GUARD_GENERATION_DIFFERS");
		expect(f.control.call).toHaveBeenCalledTimes(calls);
		f.client.submitInstanceOperation.mockRejectedValueOnce(new Error("stop unavailable"));
		await expect(f.controller.stop(f.context.allocationId, signal())).rejects.toThrow("stop unavailable");
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("STOP_UNCONFIRMED");
		expect(f.control.call).toHaveBeenCalledTimes(calls);
		expect(f.permit?.generation).toBe(2);
	});
	it("retains an armed cancellation until exact physical stop proof can be archived", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		vi.spyOn(f.guard, "start").mockRejectedValueOnce(new Error("dispatch unavailable"));
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow(
			"dispatch unavailable",
		);
		expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("armed");
		vi.spyOn(f.guard, "stop").mockRejectedValueOnce(new Error("stop proof unavailable"));
		await expect(f.controller.abandonUndispatched(f.context, f.context.allocationId, signal())).rejects.toThrow(
			"stop proof unavailable",
		);
		expect(await f.guard.list()).toHaveLength(1);
		expect(f.controller.manages(f.context.allocationId)).toBe(true);
		await f.controller.maintain(signal());
		expect(await f.guard.list()).toEqual([]);
		expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("stopped");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("retries archival before forgetting a closed computer and recovers archived proof without SQL", async () => {
		const f = await fixture();
		await f.start();
		await f.controller.stop(f.context.allocationId, signal());
		const archive = vi.spyOn(f.guard, "archive").mockRejectedValueOnce(new Error("archive fsync unavailable"));
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("archive fsync");
		expect(f.controller.manages(f.context.allocationId)).toBe(true);
		expect(await f.guard.listPrestarts()).toHaveLength(1);
		f.moveSource();
		await f.controller.maintain(signal());
		expect(archive).toHaveBeenCalledTimes(2);
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
		expect(await f.guard.list()).toEqual([]);
		expect(await f.guard.listPrestarts()).toEqual([]);
		const stopped = await f.guard.latest(f.context.allocationId);
		f.control.call.mockClear();
		await f.restart();
		await f.controller.maintain(signal());
		expect(f.control.call).not.toHaveBeenCalled();
		expect(await f.guard.latest(f.context.allocationId)).toEqual(stopped);
	});
	it("recovers a committed archive with a lost reply after restart without refunding or repeating finish", async () => {
		const f = await fixture();
		await f.start();
		await f.controller.stop(f.context.allocationId, signal());
		const archive = f.guard.archive.bind(f.guard);
		vi.spyOn(f.guard, "archive").mockImplementationOnce(async (permitId, closure) => {
			await archive(permitId, closure);
			throw new Error("archive reply lost");
		});
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("archive reply lost");
		expect(f.controller.manages(f.context.allocationId)).toBe(true);
		f.control.call.mockClear();
		f.moveSource();
		await f.controller.maintain(signal());
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
		expect(f.control.call).not.toHaveBeenCalled();
		await f.restart();
		await f.controller.maintain(signal());
		expect(f.control.call).not.toHaveBeenCalled();
		expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("stopped");
		expect(await f.guard.hasHistory(f.context.allocationId)).toBe(true);
	});
	it("does not archive or forget a finish acknowledgement for a different reservation", async () => {
		const f = await fixture();
		await f.start();
		await f.controller.stop(f.context.allocationId, signal());
		const original = f.control.call.getMockImplementation()!;
		f.control.call.mockImplementation(async (method, args) => {
			const response = await original(method, args);
			return method.includes("finish")
				? { ...(response as PaidComputerPermit), reservationId: randomUUID() }
				: response;
		});
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("CLOSURE_DIFFERS");
		expect(f.controller.manages(f.context.allocationId)).toBe(true);
		expect(await f.guard.list()).toHaveLength(1);
		await f.controller.maintain(signal());
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
	});
	it.each([false, true])(
		"settles a lost renewal after expiry using immutable history (restart: %s)",
		async (restart) => {
			const f = await fixture();
			await f.start();
			f.clock.uptimeMs = 350000;
			f.setGuestUptime(251);
			f.loseRenew();
			await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("renew reply lost");
			f.clock.uptimeMs = 400001;
			await f.guard.sweep();
			const stopped = await f.guard.latest(f.context.allocationId);
			f.moveSource();
			if (restart) await f.restart();
			f.control.call.mockClear();
			if (restart) await f.controller.maintain(signal());
			else await f.controller.observe(f.context.allocationId, signal());
			expect(f.controller.manages(f.context.allocationId)).toBe(false);
			expect(await f.guard.list()).toEqual([]);
			expect(await f.guard.latest(f.context.allocationId)).toEqual(stopped);
			expect(f.permit).toMatchObject({ state: "closed", generation: 2 });
			expect(f.control.call.mock.calls.filter(([method]) => method.includes("finish"))).toHaveLength(1);
			expect(
				f.control.call.mock.calls.filter(([method]) => method === "qorpera_describe_runtime_computer_permit"),
			).toHaveLength(0);
			expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["start", "stop"]);
		},
	);
	it.each([false, true])(
		"checks the exact durable abandonment closure after a lost reply (altered: %s)",
		async (altered) => {
			const f = await fixture();
			await f.controller.ensure(f.context, f.context.allocationId, signal());
			const original = f.control.call.getMockImplementation()!;
			let closure: Record<string, unknown> | null = null;
			f.control.call.mockImplementation(async (method, args) => {
				if (method === "qorpera_abandon_runtime_computer_permit") {
					closure = (await original(method, args)) as Record<string, unknown>;
					throw new Error("abandonment reply lost");
				}
				if (method === "qorpera_describe_runtime_computer_prestart")
					return {
						state: "abandoned",
						permit: f.permit,
						closure: altered ? { ...closure, permitId: randomUUID() } : closure,
					};
				return original(method, args);
			});
			await expect(f.controller.abandonUndispatched(f.context, f.context.allocationId, signal())).rejects.toThrow(
				"reply lost",
			);
			f.moveSource();
			if (altered) {
				await expect(f.controller.maintain(signal())).rejects.toThrow("RECOVERY_UNCONFIRMED");
				expect(f.controller.manages(f.context.allocationId)).toBe(true);
			} else {
				await f.controller.maintain(signal());
				expect(f.controller.manages(f.context.allocationId)).toBe(false);
			}
			expect((await f.guard.prestartStatus(f.context.allocationId))?.state).toBe("abandoned");
			expect(await f.guard.listPrestarts()).toHaveLength(altered ? 1 : 0);
			expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		},
	);
	it("clears a lost finish reply from exact history after source removal without queued live-source reads", async () => {
		const f = await fixture();
		await f.start();
		await f.controller.stop(f.context.allocationId, signal());
		f.loseFinish();
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("finish reply lost");
		expect(f.controller.manages(f.context.allocationId)).toBe(true);
		const stopped = await f.guard.latest(f.context.allocationId);
		f.moveSource();
		f.control.call.mockClear();
		await Promise.all([
			f.controller.maintain(signal()),
			f.controller.maintain(signal()),
			f.controller.stop(f.context.allocationId, signal()),
		]);
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
		expect(
			f.control.call.mock.calls.filter(([method]) => method === "qorpera_describe_runtime_computer_permit"),
		).toHaveLength(0);
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("finish"))).toHaveLength(0);
		expect(await f.guard.latest(f.context.allocationId)).toEqual(stopped);
		await f.restart();
		await f.controller.maintain(signal());
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
	});
	it.each(["permitId", "hostBootId", "prestart"])(
		"retains managed custody when terminal history has different %s",
		async (field) => {
			const f = await fixture();
			await f.start();
			const original = f.control.call.getMockImplementation()!;
			f.control.call.mockImplementation(async (method, args) => {
				if (method !== "qorpera_describe_runtime_computer_prestart") return original(method, args);
				return {
					state: "closed",
					permit: {
						...f.permit,
						state: "closed",
						[field]:
							field === "prestart"
								? { guardIncarnationId: randomUUID(), prepareSha256: "a".repeat(64) }
								: randomUUID(),
					},
				};
			});
			await expect(f.controller.maintain(signal())).rejects.toThrow("RECOVERY_UNCONFIRMED");
			expect(f.controller.manages(f.context.allocationId)).toBe(true);
			expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("running");
		},
	);
	it("recovers an expired prepare-only hold after restart without looking for a VM or renewing its clock", async () => {
		const f = await fixture();
		f.losePrepare();
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow("reply lost");
		f.removeInstance();
		f.clock.uptimeMs += 300001;
		await f.restart();
		await f.controller.maintain(signal());
		expect(f.permit?.state).toBe("closed");
		expect((await f.guard.prestartStatus(f.context.allocationId))?.state).toBe("abandoned");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow("START_ABANDONED");
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("prepare"))).toHaveLength(1);
	});
	it("persists cancellation before SQL and recovers a lost closure reply after another restart", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		const original = f.control.call.getMockImplementation()!;
		f.control.call.mockImplementationOnce(async (method, args) => {
			await original(method, args);
			throw new Error("closure reply lost");
		});
		await expect(f.controller.abandonUndispatched(f.context, f.context.allocationId, signal())).rejects.toThrow(
			"closure reply lost",
		);
		expect((await f.guard.prestartStatus(f.context.allocationId))?.state).toBe("abandoned");
		await f.restart();
		await f.controller.maintain(signal());
		expect(f.permit?.state).toBe("closed");
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow("START_ABANDONED");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("never refunds an uncertain dispatched start even after reboot and physical disappearance", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		f.client.submitInstanceOperation.mockRejectedValueOnce(new Error("lost start"));
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow("lost start");
		f.removeInstance();
		await expect(f.controller.abandonUndispatched(f.context, f.context.allocationId, signal())).rejects.toThrow();
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("abandon"))).toHaveLength(0);
		expect(f.permit?.state).toBe("prepared");
	});
	it("keeps cancellation final even if company mode later reports shadow", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		await f.controller.abandonUndispatched(f.context, f.context.allocationId, signal());
		f.setMode("shadow");
		await f.restart();
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow("START_ABANDONED");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("keeps known in-process sample continuity across active-state reads and refuses settlement of a running VM", async () => {
		const f = await fixture();
		await f.start();
		const calls = f.client.submitInstanceOperation.mock.calls.length;
		await expect(f.controller.settleStopped(f.context.allocationId, signal())).rejects.toThrow("STOPPED_REQUIRED");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(calls);
		expect(await f.controller.recover(f.context, signal())).toBe("paid");
		f.clock.uptimeMs += 5000;
		f.setGuestUptime(6);
		await f.controller.observe(f.context.allocationId, signal());
		expect(f.samples.at(-1)?.state).toBe("running");
		f.instance!.status = "Stopped";
		f.instance!.statusCode = 102;
		await f.controller.settleStopped(f.context.allocationId, signal());
		expect(f.permit?.state).toBe("closed");
		expect(await f.controller.recover(f.context, signal())).toBe("paid");
		await expect(f.controller.assertRunning(f.context.allocationId, signal())).rejects.toThrow("PERMIT_REQUIRED");
	});
	it("reserves before physical start, binds protected boot observation, and settles only confirmed physical stop", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		await f.controller.start(f.context.allocationId, f.target, signal());
		await f.guard.sweep();
		await expect(f.controller.assertRunning(f.context.allocationId, signal())).rejects.toThrow("RUNNING_PERMIT");
		await f.controller.observe(f.context.allocationId, signal());
		await f.controller.assertRunning(f.context.allocationId, signal());
		expect(f.samples[0]).toMatchObject({ state: "running", previousObservationId: null, guestUptimeMs: 1000 });
		const stopped = await f.controller.stop(f.context.allocationId, signal());
		expect(stopped.phase).toBe("stopped");
		await f.controller.observe(f.context.allocationId, signal());
		expect(f.permit?.state).toBe("closed");
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["start", "stop"]);
	});
	it("recovers a lost prepare reply without another reservation or a physical start", async () => {
		const f = await fixture();
		f.losePrepare();
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow(
			"prepare reply lost",
		);
		await f.restart();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		expect(f.control.call.mock.calls.filter((call) => call[0].includes("prepare"))).toHaveLength(1);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("restarts with a gap and preserves expiry when the database disappears", async () => {
		const f = await fixture();
		await f.start();
		f.clock.uptimeMs += 10000;
		await f.restart();
		await f.controller.recover(f.context, signal());
		await f.controller.maintain(signal());
		expect(f.samples.at(-1)?.state).toBe("gap");
		f.control.call.mockRejectedValue(new Error("database down"));
		f.clock.uptimeMs = 400000;
		await f.guard.sweep();
		expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("stopped");
		expect(f.instance?.status).toBe("Stopped");
	});
	it("does not extend local custody until a lost renewal is recovered from committed server state", async () => {
		const f = await fixture();
		await f.start();
		f.clock.uptimeMs = 350000;
		f.setGuestUptime(251);
		f.loseRenew();
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("renew reply lost");
		expect((await f.guard.latest(f.context.allocationId))?.stopAtUptimeMs).toBe(400000);
		await f.controller.maintain(signal());
		expect((await f.guard.latest(f.context.allocationId))?.permit.generation).toBe(2);
		expect(f.control.call.mock.calls.filter((call) => call[0].includes("renew"))).toHaveLength(1);
		expect(f.samples.at(-1)?.state).toBe("gap");
	});
	it("never revives a paid VM after expiry and observes a normal poweroff as terminal", async () => {
		const f = await fixture();
		await f.start();
		f.instance!.status = "Stopped";
		f.instance!.statusCode = 102;
		await f.controller.observe(f.context.allocationId, signal());
		expect(f.permit?.state).toBe("closed");
		expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("stopped");
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow("PERMIT_REQUIRED");
	});
	it("refuses replacement physical UUID and expanded mount drift before dispatch", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		f.instance!.expandedDevices = {
			...f.instance!.expandedDevices,
			surprise: { type: "disk", source: "/", path: "/host" },
		};
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow(
			"PHYSICAL_INSTANCE_DIFFERS",
		);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		f.instance!.expandedDevices = structuredClone(f.target.devices);
		await f.controller.start(f.context.allocationId, f.target, signal());
		f.instance!.config = { ...f.instance!.config, "volatile.uuid": randomUUID() };
		await expect(f.controller.stop(f.context.allocationId, signal())).rejects.toThrow("PHYSICAL_INSTANCE_DIFFERS");
	});
	it("cannot mistake an unknown billing mode for a free computer", async () => {
		const f = await fixture("native", true);
		f.control.call.mockResolvedValueOnce({ permit: null, lastSample: null } as never);
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow(
			"MODE_UNCONFIRMED",
		);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		f.setMode("shadow");
		expect(await f.controller.ensure(f.context, f.context.allocationId, signal())).toEqual({ mode: "shadow" });
		expect(f.control.call.mock.calls.filter((call) => call[0].includes("prepare"))).toHaveLength(0);
	});
	it("retains unknown start custody after a lost LXD dispatch reply, including late physical appearance", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		f.client.submitInstanceOperation.mockRejectedValueOnce(new Error("LXD reply lost"));
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow("LXD reply lost");
		await f.restart();
		f.instance!.status = "Running";
		f.instance!.statusCode = 103;
		await f.guard.sweep();
		expect(f.instance?.status).toBe("Stopped");
		expect((await f.guard.latest(f.context.allocationId))?.stopReceipt).toBeNull();
	});
});
