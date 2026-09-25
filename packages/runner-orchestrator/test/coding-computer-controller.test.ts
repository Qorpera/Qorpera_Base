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
import type { LxdInstanceFile, LxdInstanceRecord, LxdTrackedInstanceAction } from "../src/lxd-client.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
async function fixture() {
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
		lastSample: Record<string, unknown> | null = null;
	let losePrepare = false,
		loseRenew = false;
	const receipt = () => (permit ? { ...permit, validForMs: Math.max(0, Date.parse(permit.deadline) - now()) } : null);
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
			const request = args.p_request as Record<string, unknown>;
			if (method === "qorpera_describe_coding_computer_permit")
				return permit?.state === "closed" || !permit
					? null
					: { permit: receipt(), lastSample: structuredClone(lastSample) };
			if (method === "qorpera_prepare_coding_computer_permit") {
				permit = {
					schema: "qorpera.computer-usage-permit/v1",
					mode: "paid",
					permitId: randomUUID(),
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
			if (!permit) throw new Error("No permit");
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
			if (method === "qorpera_finish_coding_computer_permit") permit = { ...permit, state: "closed" };
			return receipt();
		}),
	};
	const clock = async () => ({ ...host });
	const guard = new PaidComputerGuard(
		new PaidComputerGuardJournal(root),
		new LxdPaidComputerGuardPhysical(client, clock),
		clock,
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
		f.client.readInstanceFile.mockRejectedValueOnce(new Error("guest unavailable"));
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
		expect(f.calls("qorpera_describe_coding_computer_permit")).toHaveLength(1);
	});
});
