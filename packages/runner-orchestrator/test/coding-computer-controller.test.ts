import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCloudCodingNasPolicy } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingComputerController } from "../src/coding-computer-controller.ts";
import type { CodingSessionClaim } from "../src/coding-executor.ts";
import {
	type LxdCodingMachineBinding,
	lxdCodingMachineJournalPlan,
	lxdCodingMachinePlan,
} from "../src/coding-machine.ts";
import { PaidComputerGuard, PaidComputerGuardJournal, type PaidComputerPermit } from "../src/computer-paid-guard.ts";
import { LxdPaidComputerGuardPhysical } from "../src/computer-paid-guard-lxd.ts";
import {
	type PaidComputerUsageFrame,
	paidComputerUsageCursor,
	parsePaidComputerUsageEntry,
} from "../src/computer-paid-usage.ts";
import type {
	LxdInstanceClock,
	LxdInstanceFile,
	LxdInstanceRecord,
	LxdTrackedInstanceAction,
} from "../src/lxd-client.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
async function fixture(usage = false) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "paid-controller-")));
	roots.push(root);
	await chmod(root, 0o700);
	const machine: LxdCodingMachineBinding = {
		schema: "qorpera.lxd-coding-machine/v1",
		machineId: randomUUID(),
		companyId: randomUUID(),
		environmentId: randomUUID(),
		memberUserId: randomUUID(),
		providerId: "coding",
		providerPolicySha256: "a".repeat(64),
		project: "coding",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "coding",
		network: "coding",
		cpus: 4,
		memoryBytes: 8589934592,
		rootDiskBytes: 34359738368,
	};
	const plan = lxdCodingMachinePlan(machine),
		physicalId = randomUUID(),
		guestBootId = randomUUID();
	const host = { hostMachineIdSha256: "f".repeat(64), hostBootId: randomUUID(), uptimeMs: 100000 };
	const storage = {
		policy: parseCloudCodingNasPolicy({
			schema: "qorpera.coding-nas-policy/v1",
			mountPoint: "/srv/coding",
			rootPath: "/srv/coding",
			source: "192.168.1.40:/coding",
			serverAddress: "192.168.1.40",
		}),
		machineIdSha256: host.hostMachineIdSha256,
	};
	const config = {
		...plan.request.config,
		"volatile.uuid": physicalId,
		"volatile.base_image": machine.imageFingerprint,
	};
	const instance: LxdInstanceRecord = {
		name: plan.request.name,
		type: "virtual-machine",
		status: "Stopped",
		statusCode: 102,
		config,
		expandedConfig: config,
		devices: plan.request.devices,
		expandedDevices: plan.request.devices,
		profiles: [],
	};
	const client = {
		getInstance: vi.fn(async () => instance),
		submitInstanceOperation: vi.fn(async (project: string, action: LxdTrackedInstanceAction) => {
			if (action.action === "start") {
				instance.status = "Running";
				instance.statusCode = 103;
			}
			if (action.action === "stop") {
				instance.status = "Stopped";
				instance.statusCode = 102;
			}
			return { project, instanceName: instance.name, operationId: randomUUID() };
		}),
		inspectInstanceOperation: vi.fn(async (): Promise<"pending" | "succeeded" | "failed"> => "succeeded"),
		readInstanceClock: vi.fn(
			async (): Promise<LxdInstanceClock> => ({ bootId: guestBootId, uptimeMs: host.uptimeMs - 50000 }),
		),
		readInstanceFile: vi.fn(
			async (_project: string, _name: string, path: string): Promise<LxdInstanceFile> => ({
				uid: 0,
				gid: 0,
				mode: 0o444,
				content: Buffer.from(
					path === "/proc/uptime" ? `${((host.uptimeMs - 50000) / 1000).toFixed(2)} 0.00\n` : `${guestBootId}\n`,
				),
			}),
		),
	};
	let wall = Date.parse("2026-09-25T12:00:00Z");
	const now = () => {
		wall = Math.max(wall, Date.parse("2026-09-25T12:00:00Z") + host.uptimeMs - 100000);
		return wall;
	};
	let permit: PaidComputerPermit | null = null,
		abandonmentClosure: Record<string, unknown> | null = null,
		lastSample: Record<string, unknown> | null = null;
	let losePrepare = false,
		loseRenew = false,
		loseFinish = false,
		sourceUnavailable = false;
	const receipt = () => (permit ? { ...permit, validForMs: Math.max(0, Date.parse(permit.deadline) - now()) } : null);
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
			const request = args.p_request as Record<string, unknown>;
			if (method === "qorpera_describe_coding_computer_prestart")
				return {
					state: abandonmentClosure ? "abandoned" : (permit?.state ?? "absent"),
					permit: receipt(),
					lastSample,
					closure: abandonmentClosure,
				};
			if (method === "qorpera_describe_coding_computer_permit") {
				if (sourceUnavailable) throw new Error("machine owner moved");
				return permit?.state === "closed" || !permit
					? null
					: { permit: receipt(), lastSample: structuredClone(lastSample) };
			}
			if (method === "qorpera_prepare_coding_computer_permit") {
				permit = {
					schema: "qorpera.computer-usage-permit/v2",
					prestart: request.prestart as PaidComputerPermit["prestart"],
					mode: "paid",
					permitId: String(request.requestId),
					allocationId: machine.machineId,
					instanceSha256: plan.instanceSha256,
					nodeId: randomUUID(),
					epoch: randomUUID(),
					generation: 1,
					reservationId: randomUUID(),
					hostBootId: host.hostBootId,
					guestBootId: null,
					physicalId: null,
					issuedAt: new Date(now()).toISOString(),
					deadline: new Date(now() + 330000).toISOString(),
					validForMs: 330000,
					windowMs: 300000,
					stopReserveMs: 30000,
					tariffVersion: 1,
					cpuMillis: 4000,
					memoryBytes: 8589934592,
					state: "prepared",
				};
				if (losePrepare) {
					losePrepare = false;
					throw new Error("prepare reply lost");
				}
				return receipt();
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
			if (!permit) throw new Error("No permit");
			if (method === "qorpera_record_computer_guard_samples") {
				const frames = request.entries as PaidComputerUsageFrame[];
				for (const frame of frames) {
					const recorded = parsePaidComputerUsageEntry(JSON.parse(frame.entryText)).sample;
					if (recorded.observationId === lastSample?.observationId) continue;
					if (recorded.previousObservationId !== (lastSample?.observationId ?? null))
						throw new Error("SQL predecessor differs");
					lastSample = structuredClone(recorded) as unknown as Record<string, unknown>;
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

			if (request.generation !== permit.generation) throw new Error("SQL generation differs");
			if (
				!(usage && (request.sample as Record<string, unknown>).observationId === lastSample?.observationId) &&
				(request.sample as Record<string, unknown>).previousObservationId !== (lastSample?.observationId ?? null)
			)
				throw new Error("SQL predecessor differs");
			lastSample = structuredClone(request.sample as Record<string, unknown>);
			if (lastSample.state === "running")
				permit = {
					...permit,
					state: "bound",
					guestBootId: String(lastSample.guestBootId),
					physicalId: String(lastSample.physicalId),
				};
			if (method === "qorpera_renew_coding_computer_permit") {
				permit = {
					...permit,
					generation: permit.generation + 1,
					reservationId: String(request.requestId),
					issuedAt: new Date(now()).toISOString(),
					deadline: new Date(now() + 330000).toISOString(),
				};
				if (loseRenew) {
					loseRenew = false;
					throw new Error("renew reply lost");
				}
			}
			if (method === "qorpera_finish_coding_computer_permit") {
				permit = { ...permit, state: "closed" };
				if (loseFinish) {
					loseFinish = false;
					throw new Error("finish reply lost");
				}
			}
			return receipt();
		}),
	};
	const clock = async () => ({ ...host });
	const usageOptions = usage
		? {
				usageCapture: {
					capture: async () => ({
						host: await clock(),
						guestBootId,
						guestUptimeMs: host.uptimeMs - 50000,
						evidenceSha256: "e".repeat(64),
						observedAt: new Date().toISOString(),
					}),
				},
			}
		: {};
	const guard = new PaidComputerGuard(
		new PaidComputerGuardJournal(root),
		new LxdPaidComputerGuardPhysical(client, clock),
		clock,
		usageOptions,
	);
	await guard.initialize();
	const options = { control, guard, client, clock, owner: "executor", storage, now };
	const controller = new CodingComputerController(options);
	const claim: CodingSessionClaim = {
		workerId: randomUUID(),
		leaseToken: randomUUID(),
		leaseUntil: new Date(now() + 60000).toISOString(),
		sequence: 1,
		profileId: machine.companyId,
		environmentId: machine.environmentId,
		agentId: randomUUID(),
		ownerUserId: machine.memberUserId,
		harness: "codex",
		model: null,
		repository: { host: "github.com", owner: "example", name: "repo", baseBranch: "main" },
		branch: "qorpera/test",
		baseSha: null,
		harnessSessionRef: null,
		pullRequest: null,
		title: "Task",
		goal: "Goal",
		definitionOfDone: "Done",
		context: "",
		followUp: null,
	};
	const calls = (method: string) => control.call.mock.calls.filter(([name]) => name === method);
	return {
		machine,
		host,
		instance,
		client,
		control,
		guard,
		options,
		controller,
		claim,
		calls,
		journal: lxdCodingMachineJournalPlan(machine, storage),
		getPermit: () => permit,
		loseNextPrepare() {
			losePrepare = true;
		},
		loseNextRenew() {
			loseRenew = true;
		},
		loseNextFinish() {
			loseFinish = true;
		},
		moveSource() {
			sourceUnavailable = true;
		},
		async restartGuard() {
			const restarted = new PaidComputerGuard(
				new PaidComputerGuardJournal(root),
				new LxdPaidComputerGuardPhysical(client, clock),
				clock,
				usageOptions,
			);
			await restarted.initialize();
			return restarted;
		},
		async start() {
			await controller.ensure(claim, machine, signal());
			return controller.start(machine.machineId, signal());
		},
		async bind() {
			await controller.observe(machine.machineId, signal());
		},
	};
}

describe("paid coding computer controller", () => {
	it("drains and archives a historical stream without replacing newer managed custody", async () => {
		const f = await fixture(true);
		await f.start();
		const oldId = f.getPermit()!.permitId;
		f.guard.tickUsage();
		await f.guard.settleUsage(oldId);
		await f.bind();
		await f.controller.stop(f.machine.machineId, signal());
		f.guard.tickUsage();
		await f.guard.settleUsage(oldId);
		const newer = { ...f.getPermit()!, permitId: randomUUID(), epoch: randomUUID(), reservationId: randomUUID() };
		const original = f.control.call.getMockImplementation()!;
		f.control.call.mockImplementation(async (method, args) => {
			if (method === "qorpera_describe_coding_computer_permit") return { permit: newer, lastSample: null };
			return original(method, args);
		});
		const controller = new CodingComputerController(f.options);
		await controller.ensure(f.claim, f.machine, signal());
		const archive = vi.spyOn(f.guard, "archive");
		f.control.call.mockClear();
		await controller.maintain(signal());
		expect(controller.manages(f.machine.machineId)).toBe(true);
		expect(archive).toHaveBeenCalledTimes(1);
		expect(archive.mock.calls[0]?.[0]).toBe(oldId);
		expect(f.getPermit()?.state).toBe("closed");
		expect(f.calls("qorpera_describe_coding_computer_permit")).toHaveLength(1);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["start", "stop"]);
	});
	it.each([false, true])(
		"uploads the guard-owned stream and waits for sealed ACK before finish (lost upload reply: %s)",
		async (lost) => {
			const f = await fixture(true);
			await f.start();
			const permitId = f.getPermit()!.permitId;
			expect((await f.guard.latest(f.machine.machineId))?.usageRequired).toBe(true);
			await f.controller.observe(f.machine.machineId, signal());
			expect(f.getPermit()?.state).toBe("prepared");
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
				await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("upload reply lost");
				expect((await f.guard.readUsage(permitId)).acknowledgedThrough.sequence).toBe(0);
			}
			await f.controller.observe(f.machine.machineId, signal());
			expect(f.getPermit()?.state).toBe("bound");
			expect((await f.guard.readUsage(permitId)).acknowledgedThrough).toEqual(page.head);
			expect(f.client.readInstanceClock).not.toHaveBeenCalled();
			await f.controller.stop(f.machine.machineId, signal());
			await f.controller.observe(f.machine.machineId, signal());
			expect(
				f.control.call.mock.calls.filter(([method]) => method === "qorpera_finish_coding_computer_permit"),
			).toHaveLength(0);
			f.guard.tickUsage();
			await f.guard.settleUsage(permitId);
			await f.controller.observe(f.machine.machineId, signal());
			expect(f.getPermit()?.state).toBe("closed");
			expect(await f.guard.list()).toHaveLength(0);
			expect(
				f.control.call.mock.calls.filter(([method]) => method.includes("bind") || method.includes("checkpoint")),
			).toHaveLength(0);
			expect(
				f.control.call.mock.calls.filter(([method]) => method === "qorpera_finish_coding_computer_permit"),
			).toHaveLength(1);
		},
	);

	it.each([false, true])(
		"settles the canonical successor after lost renewal and ownership change (lost finish: %s)",
		async (lostFinish) => {
			const f = await fixture();
			await f.start();
			await f.bind();
			f.host.uptimeMs += 250000;
			f.loseNextRenew();
			await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("renew reply lost");
			f.host.uptimeMs += 50001;
			await f.guard.sweep();
			const stopped = await f.guard.latest(f.machine.machineId);
			f.moveSource();
			if (lostFinish) {
				f.loseNextFinish();
				await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("finish reply lost");
			}
			const guard = await f.restartGuard();
			const restarted = new CodingComputerController({ ...f.options, guard });
			f.control.call.mockClear();
			await restarted.initialize(signal());
			await restarted.maintain(signal());
			expect(f.getPermit()).toMatchObject({ generation: 2, state: "closed" });
			expect(await guard.list()).toEqual([]);
			expect(await guard.latest(f.machine.machineId)).toEqual(stopped);
			expect(restarted.manages(f.machine.machineId)).toBe(false);
			expect(f.calls("qorpera_finish_coding_computer_permit")).toHaveLength(lostFinish ? 0 : 1);
			expect(f.calls("qorpera_describe_coding_computer_permit")).toHaveLength(0);
			expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["start", "stop"]);
		},
	);
	it.each([1000, 1001, -1])("keeps the one-second, nondecreasing host clock bracket (%s ms)", async (elapsed) => {
		const f = await fixture();
		await f.start();
		await f.bind();
		const initial = f.calls("qorpera_checkpoint_coding_computer_permit").length;
		const read = f.client.readInstanceClock.getMockImplementation()!;
		f.client.readInstanceClock.mockImplementationOnce(async () => {
			const guest = await read();
			f.host.uptimeMs += elapsed;
			return guest;
		});
		if (elapsed === 1000) {
			await f.controller.observe(f.machine.machineId, signal());
			expect(f.calls("qorpera_checkpoint_coding_computer_permit").length).toBe(initial + 1);
		} else {
			await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("OBSERVATION_UNCONFIRMED");
			expect(f.calls("qorpera_checkpoint_coding_computer_permit").length).toBe(initial);
		}
	});
	it.each(["boot", "uptime", "fraction"])("refuses an invalid clock-port %s before SQL", async (failure) => {
		const f = await fixture();
		await f.start();
		await f.bind();
		const initial = f.calls("qorpera_checkpoint_coding_computer_permit").length;
		const guest = await f.client.readInstanceClock();
		f.client.readInstanceClock.mockResolvedValueOnce({
			bootId: failure === "boot" ? "invalid" : guest.bootId,
			uptimeMs: failure === "uptime" ? -1 : failure === "fraction" ? 0.5 : guest.uptimeMs,
		});
		await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("OBSERVATION_UNCONFIRMED");
		expect(f.calls("qorpera_checkpoint_coding_computer_permit").length).toBe(initial);
	});

	it("refuses a changed successor reservation before terminal settlement", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		f.host.uptimeMs += 250000;
		f.loseNextRenew();
		await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("renew reply lost");
		await f.controller.stop(f.machine.machineId, signal());
		const original = f.control.call.getMockImplementation()!;
		const old = await f.guard.latest(f.machine.machineId);
		f.control.call.mockImplementation(async (method, args) => {
			const result = await original(method, args);
			if (method !== "qorpera_describe_coding_computer_prestart") return result;
			return {
				...(result as Record<string, unknown>),
				permit: { ...f.getPermit(), reservationId: old!.permit.reservationId },
			};
		});
		await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow();
		expect(f.calls("qorpera_finish_coding_computer_permit")).toHaveLength(0);
		expect(await f.guard.list()).toHaveLength(1);
	});
	it("does not extend SQL while stopping or after a guard renewal installation failure", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		f.host.uptimeMs += 250000;
		vi.spyOn(f.guard, "arm").mockRejectedValueOnce(new Error("guard renewal unavailable"));
		await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("guard renewal unavailable");
		const calls = f.control.call.mock.calls.length;
		await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("GUARD_GENERATION_DIFFERS");
		f.client.submitInstanceOperation.mockRejectedValueOnce(new Error("stop unavailable"));
		await expect(f.controller.stop(f.machine.machineId, signal())).rejects.toThrow("stop unavailable");
		await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("STOP_UNCONFIRMED");
		expect(f.control.call).toHaveBeenCalledTimes(calls);
		expect(f.getPermit()?.generation).toBe(2);
	});
	it("closes an armed but undispatched physical guard before archiving cancellation", async () => {
		const f = await fixture();
		await f.controller.ensure(f.claim, f.machine, signal());
		vi.spyOn(f.guard, "start").mockRejectedValueOnce(new Error("dispatch unavailable"));
		await expect(f.controller.start(f.machine.machineId, signal())).rejects.toThrow("dispatch unavailable");
		await f.controller.abandonClaim(f.claim, f.machine, signal());
		expect(await f.guard.list()).toEqual([]);
		expect((await f.guard.latest(f.machine.machineId))?.phase).toBe("stopped");
		expect(await f.controller.ownsStart(f.machine.machineId, signal())).toBe(true);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("retries a failed archive before terminal caching and keeps exact stop proof across guard restart", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		await f.controller.stop(f.machine.machineId, signal());
		const archive = vi.spyOn(f.guard, "archive").mockRejectedValueOnce(new Error("archive fsync unavailable"));
		await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("archive fsync");
		expect(f.controller.manages(f.machine.machineId)).toBe(true);
		expect(await f.guard.list()).toHaveLength(1);
		f.moveSource();
		await f.controller.maintain(signal());
		expect(archive).toHaveBeenCalledTimes(2);
		expect(f.controller.manages(f.machine.machineId)).toBe(false);
		const stopped = await f.guard.latest(f.machine.machineId);
		const guard = await f.restartGuard();
		const restarted = new CodingComputerController({ ...f.options, guard });
		f.control.call.mockClear();
		await restarted.initialize(signal());
		await restarted.maintain(signal());
		expect(f.control.call).not.toHaveBeenCalled();
		expect(await guard.list()).toEqual([]);
		expect(await guard.listPrestarts()).toEqual([]);
		expect(await guard.latest(f.machine.machineId)).toEqual(stopped);
		expect(await restarted.ownsStart(f.machine.machineId, signal())).toBe(true);
	});
	it("retains start authority for an archived prepare-only cancellation after a lost archive reply and restart", async () => {
		const f = await fixture();
		await f.controller.ensure(f.claim, f.machine, signal());
		const archive = f.guard.archive.bind(f.guard);
		vi.spyOn(f.guard, "archive").mockImplementationOnce(async (permitId, closure) => {
			await archive(permitId, closure);
			throw new Error("archive reply lost");
		});
		await expect(f.controller.abandonClaim(f.claim, f.machine, signal())).rejects.toThrow("archive reply lost");
		f.control.call.mockClear();
		f.moveSource();
		await f.controller.maintain(signal());
		expect(f.control.call).not.toHaveBeenCalled();
		expect(f.controller.manages(f.machine.machineId)).toBe(false);
		const guard = await f.restartGuard();
		const restarted = new CodingComputerController({ ...f.options, guard });
		f.control.call.mockClear();
		f.moveSource();
		await restarted.initialize(signal());
		expect(f.control.call).not.toHaveBeenCalled();
		expect(await guard.listPrestarts()).toEqual([]);
		expect(await guard.latest(f.machine.machineId)).toBeNull();
		expect(await restarted.ownsStart(f.machine.machineId, signal())).toBe(true);
		await expect(restarted.ensure(f.claim, f.machine, signal())).rejects.toThrow("START_ABANDONED");
		expect(f.calls("qorpera_prepare_coding_computer_permit")).toHaveLength(0);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("retries cancellation archival after SQL has closed the allowance, without caching premature success", async () => {
		const f = await fixture();
		await f.controller.ensure(f.claim, f.machine, signal());
		const archive = vi.spyOn(f.guard, "archive").mockRejectedValueOnce(new Error("archive not durable"));
		await expect(f.controller.abandonClaim(f.claim, f.machine, signal())).rejects.toThrow("archive not durable");
		expect(f.controller.manages(f.machine.machineId)).toBe(true);
		await f.controller.abandonClaim(f.claim, f.machine, signal());
		expect(archive).toHaveBeenCalledTimes(2);
		expect(f.controller.manages(f.machine.machineId)).toBe(false);
		expect(await f.guard.listPrestarts()).toEqual([]);
	});
	it.each([false, true])(
		"checks the exact durable abandonment closure after a lost reply (altered: %s)",
		async (altered) => {
			const f = await fixture();
			await f.controller.ensure(f.claim, f.machine, signal());
			const original = f.control.call.getMockImplementation()!;
			let closure: Record<string, unknown> | null = null;
			f.control.call.mockImplementation(async (method, args) => {
				if (method === "qorpera_abandon_coding_computer_permit") {
					closure = (await original(method, args)) as Record<string, unknown>;
					throw new Error("abandonment reply lost");
				}
				if (method === "qorpera_describe_coding_computer_prestart")
					return {
						state: "abandoned",
						permit: f.getPermit(),
						closure: altered ? { ...closure, permitId: randomUUID() } : closure,
					};
				return original(method, args);
			});
			await expect(f.controller.abandonClaim(f.claim, f.machine, signal())).rejects.toThrow("reply lost");
			f.moveSource();
			if (altered) {
				await expect(f.controller.maintain(signal())).rejects.toThrow("RECOVERY_UNCONFIRMED");
				expect(f.controller.manages(f.machine.machineId)).toBe(true);
			} else {
				await f.controller.maintain(signal());
				expect(f.controller.manages(f.machine.machineId)).toBe(false);
			}
			expect((await f.guard.prestartStatus(f.getPermit()!.permitId))?.state).toBe("abandoned");
			expect(await f.guard.listPrestarts()).toHaveLength(altered ? 1 : 0);
			expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		},
	);
	it("clears a lost finish reply from exact history after the machine owner moves, including queued maintenance", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		await f.controller.stop(f.machine.machineId, signal());
		f.loseNextFinish();
		await expect(f.controller.observe(f.machine.machineId, signal())).rejects.toThrow("finish reply lost");
		expect(f.controller.manages(f.machine.machineId)).toBe(true);
		const stopped = await f.guard.latest(f.machine.machineId);
		f.moveSource();
		f.control.call.mockClear();
		await Promise.all([
			f.controller.maintain(signal()),
			f.controller.maintain(signal()),
			f.controller.stop(f.machine.machineId, signal()),
		]);
		expect(f.controller.manages(f.machine.machineId)).toBe(false);
		expect(f.calls("qorpera_describe_coding_computer_permit")).toHaveLength(0);
		expect(f.calls("qorpera_finish_coding_computer_permit")).toHaveLength(0);
		expect(await f.guard.latest(f.machine.machineId)).toEqual(stopped);
		expect(await f.controller.ownsStart(f.machine.machineId, signal())).toBe(true);
	});
	it("initializes closed v2 history without reauthenticating its replaced live machine", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		await f.controller.stop(f.machine.machineId, signal());
		await f.controller.observe(f.machine.machineId, signal());
		f.moveSource();
		f.control.call.mockClear();
		const restarted = new CodingComputerController(f.options);
		await restarted.initialize(signal());
		await restarted.maintain(signal());
		expect(restarted.manages(f.machine.machineId)).toBe(false);
		expect(f.calls("qorpera_describe_coding_computer_prestart")).toHaveLength(0);
		expect(f.calls("qorpera_describe_coding_computer_permit")).toHaveLength(0);
		expect((await f.guard.latest(f.machine.machineId))?.phase).toBe("stopped");
	});
	it.each(["permitId", "hostBootId", "prestart"])(
		"refuses a terminal history receipt with different %s",
		async (field) => {
			const f = await fixture();
			await f.start();
			await f.bind();
			const original = f.control.call.getMockImplementation()!;
			f.control.call.mockImplementation(async (method, args) => {
				if (method !== "qorpera_describe_coding_computer_prestart") return original(method, args);
				return {
					state: "closed",
					permit: {
						...f.getPermit(),
						state: "closed",
						[field]:
							field === "prestart"
								? { guardIncarnationId: randomUUID(), prepareSha256: "a".repeat(64) }
								: randomUUID(),
					},
				};
			});
			await expect(f.controller.maintain(signal())).rejects.toThrow("RECOVERY_UNCONFIRMED");
			expect(f.controller.manages(f.machine.machineId)).toBe(true);
			expect((await f.guard.latest(f.machine.machineId))?.phase).toBe("running");
		},
	);
	it("reclaims a prepare-only hold after expiry/restart and prevents the same claim minting a replacement", async () => {
		const f = await fixture();
		f.loseNextPrepare();
		await expect(f.controller.ensure(f.claim, f.machine, signal())).rejects.toThrow("reply lost");
		f.host.uptimeMs += 300001;
		const restarted = new CodingComputerController(f.options);
		await restarted.initialize(signal());
		expect(f.getPermit()?.state).toBe("closed");
		expect(f.calls("qorpera_abandon_coding_computer_permit")).toHaveLength(1);
		await expect(restarted.ensure(f.claim, f.machine, signal())).rejects.toThrow("START_ABANDONED");
		expect(f.calls("qorpera_prepare_coding_computer_permit")).toHaveLength(1);
		expect(await restarted.ownsStart(f.machine.machineId, signal())).toBe(true);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("retains no lease credential and cancels an unused claim without an attached physical record", async () => {
		const f = await fixture();
		await f.controller.ensure(f.claim, f.machine, signal());
		const entries = await f.guard.listPrestarts();
		expect(JSON.stringify(entries)).not.toContain(f.claim.leaseToken);
		expect(JSON.stringify(entries)).not.toContain("leaseToken");
		expect(await f.guard.list()).toEqual([]);
		await f.controller.abandonClaim(f.claim, f.machine, signal());
		expect(f.getPermit()?.state).toBe("closed");
		await expect(f.controller.ensure(f.claim, f.machine, signal())).rejects.toThrow("START_ABANDONED");
	});
	it("recovers a zero-use cancellation across host reboot without granting a new start deadline", async () => {
		const f = await fixture();
		await f.controller.ensure(f.claim, f.machine, signal());
		f.host.hostBootId = randomUUID();
		f.host.uptimeMs = 5;
		const restarted = new CodingComputerController(f.options);
		await restarted.initialize(signal());
		expect(f.getPermit()?.state).toBe("closed");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("leaves a dispatched shared machine funded when one claim fails", async () => {
		const f = await fixture();
		await f.start();
		await f.controller.abandonClaim(f.claim, f.machine, signal());
		expect(f.calls("qorpera_abandon_coding_computer_permit")).toHaveLength(0);
		expect(f.controller.manages(f.machine.machineId)).toBe(true);
	});
	it("reserves once before start, routes physical start through guard and recovers exact local reply", async () => {
		const f = await fixture();
		await f.controller.ensure(f.claim, f.machine, signal());
		await f.controller.ensure(f.claim, f.machine, signal());
		expect(f.calls("qorpera_prepare_coding_computer_permit")).toHaveLength(1);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		const reference = await f.controller.start(f.machine.machineId, signal());
		expect(await f.controller.start(f.machine.machineId, signal())).toEqual(reference);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledOnce();
		expect((await f.guard.latest(f.machine.machineId))?.phase).toBe("running");
	});
	it("recovers committed prepare after a lost reply without creating a second hold", async () => {
		const f = await fixture();
		f.loseNextPrepare();
		await expect(f.controller.ensure(f.claim, f.machine, signal())).rejects.toThrow("reply lost");
		await f.controller.ensure(f.claim, f.machine, signal());
		expect(f.calls("qorpera_prepare_coding_computer_permit")).toHaveLength(1);
		await f.controller.start(f.machine.machineId, signal());
	});
	it("binds protected guest boot once and chains samples with verified evidence", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		const bound = f.calls("qorpera_bind_coding_computer_permit")[0][1].p_request as {
			sample: Record<string, unknown>;
		};
		expect(bound.sample).toMatchObject({ previousObservationId: null, state: "running", guestUptimeMs: 50000 });
		expect(bound.sample.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
		f.host.uptimeMs += 5000;
		await f.controller.maintain(signal());
		const checkpoint = f.calls("qorpera_checkpoint_coding_computer_permit")[0][1].p_request as {
			sample: Record<string, unknown>;
		};
		expect(checkpoint.sample).toMatchObject({
			previousObservationId: bound.sample.observationId,
			state: "running",
			guestUptimeMs: 55000,
		});
		expect(f.calls("qorpera_bind_coding_computer_permit")).toHaveLength(1);
	});
	it("lost renewal reply never extends local permit until canonical committed generation is recovered", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		const original = await f.guard.latest(f.machine.machineId);
		f.host.uptimeMs += 250000;
		f.loseNextRenew();
		await expect(f.controller.maintain(signal())).rejects.toThrow("UNCONFIRMED");
		expect((await f.guard.latest(f.machine.machineId))?.stopAtUptimeMs).toBe(original?.stopAtUptimeMs);
		expect(f.getPermit()?.generation).toBe(2);
		await f.controller.maintain(signal());
		const recovered = await f.guard.latest(f.machine.machineId);
		expect(recovered?.permit.generation).toBe(2);
		expect(recovered?.stopAtUptimeMs).toBe(650000);
		expect(f.calls("qorpera_renew_coding_computer_permit")).toHaveLength(1);
		const checkpoint = f.calls("qorpera_checkpoint_coding_computer_permit").at(-1)?.[1].p_request as {
			sample: Record<string, unknown>;
		};
		expect(checkpoint.sample.state).toBe("gap");
	});
	it("inserts a zero-charge continuity gap on process restart and on failed physical reads", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		f.host.uptimeMs += 5000;
		const restarted = new CodingComputerController(f.options);
		await restarted.initialize(signal());
		await restarted.maintain(signal());
		const sample = () =>
			(
				f.calls("qorpera_checkpoint_coding_computer_permit").at(-1)?.[1].p_request as {
					sample: Record<string, unknown>;
				}
			).sample;
		expect(sample()).toMatchObject({ state: "gap", guestUptimeMs: null });
		f.host.uptimeMs += 5000;
		await restarted.maintain(signal());
		expect(sample().state).toBe("running");
		f.client.readInstanceClock.mockRejectedValueOnce(new Error("guest unavailable"));
		await expect(restarted.maintain(signal())).rejects.toThrow("UNCONFIRMED");
		f.host.uptimeMs += 5000;
		await restarted.maintain(signal());
		expect(sample().state).toBe("gap");
	});
	it("keeps terminal host boot separate after reboot and closes accounting only from guard proof", async () => {
		const f = await fixture();
		await f.start();
		await f.bind();
		await f.guard.sweep();
		f.host.hostBootId = randomUUID();
		f.host.uptimeMs = 1000;
		await f.guard.sweep();
		const terminal = await f.guard.latest(f.machine.machineId);
		expect(terminal?.stopReceipt?.closedHostBootId).toBe(f.host.hostBootId);
		const restarted = new CodingComputerController(f.options);
		await restarted.initialize(signal());
		await restarted.maintain(signal());
		const request = f.calls("qorpera_finish_coding_computer_permit")[0][1].p_request as {
			guardClosed: boolean;
			sample: Record<string, unknown>;
		};
		expect(request).toMatchObject({
			guardClosed: true,
			sample: { state: "stopped", hostBootId: f.host.hostBootId, hostUptimeMs: 1000, guestUptimeMs: null },
		});
		expect(restarted.manages(f.machine.machineId)).toBe(false);
	});
	it("returns exact external stop/start custody and refuses replacement physical UUIDs", async () => {
		const f = await fixture();
		const start = await f.start();
		await f.guard.sweep();
		expect(await f.controller.externalStart(f.journal, signal())).toEqual({
			reference: start,
			settled: true,
			stopReference: null,
		});
		await f.controller.stop(f.machine.machineId, signal());
		const stopped = await f.guard.latest(f.machine.machineId);
		expect(await f.controller.externalStop(f.journal, signal())).toEqual(stopped?.stopReference);
		f.instance.config = { ...f.instance.config, "volatile.uuid": randomUUID() };
		expect(await f.controller.externalStart(f.journal, signal())).toBeNull();
		expect(await f.controller.externalStop(f.journal, signal())).toBeNull();
	});
	it("never represents a failed start operation as successful recovery proof", async () => {
		const f = await fixture();
		const started = await f.start();
		f.client.inspectInstanceOperation.mockResolvedValue("failed");
		await f.guard.sweep();
		expect(await f.controller.externalStart(f.journal, signal())).toEqual({
			reference: started,
			settled: false,
			stopReference: null,
		});
	});
	it("describes an allocation only once when initializing retained permit history", async () => {
		const f = await fixture();
		await f.start();
		const entry = (await f.guard.latest(f.machine.machineId))!;
		vi.spyOn(f.guard, "list").mockResolvedValue([entry, structuredClone(entry), structuredClone(entry)]);
		f.control.call.mockClear();
		await new CodingComputerController(f.options).initialize(signal());
		expect(f.calls("qorpera_describe_coding_computer_prestart")).toHaveLength(1);
		expect(f.calls("qorpera_describe_coding_computer_permit")).toHaveLength(0);
	});
});
