import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCloudCodingNasPolicy } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LxdCodingMachineBinding, lxdCodingMachinePlan } from "../src/coding-machine.ts";
import {
	type CodingPaidComputerMachine,
	type PaidComputerArm,
	PaidComputerGuard,
	PaidComputerGuardJournal,
	type PaidComputerGuardPhysical,
	type PaidComputerHostClock,
	type PaidComputerPrestartIntent,
	parsePaidComputerPrestartIntent,
} from "../src/computer-paid-guard.ts";
import { PaidComputerGuardClient, servePaidComputerGuard } from "../src/computer-paid-guard-ipc.ts";
import { LxdPaidComputerGuardPhysical } from "../src/computer-paid-guard-lxd.ts";
import type { LxdInstanceRecord, LxdOperationReference } from "../src/lxd-client.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(initialize = true) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "paid-guard-")));
	roots.push(root);
	await chmod(root, 0o700);
	const journalRoot = join(root, "journal");
	await mkdir(journalRoot, { mode: 0o700 });
	const binding: LxdCodingMachineBinding = {
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
	const plan = lxdCodingMachinePlan(binding);
	const host: PaidComputerHostClock = {
		hostMachineIdSha256: "f".repeat(64),
		hostBootId: randomUUID(),
		uptimeMs: 100000,
	};
	const input: PaidComputerArm & { machine: CodingPaidComputerMachine } = {
		machine: {
			allocationId: binding.machineId,
			nodeId: randomUUID(),
			binding,
			storage: {
				policy: parseCloudCodingNasPolicy({
					schema: "qorpera.coding-nas-policy/v1",
					mountPoint: "/srv/coding",
					rootPath: "/srv/coding",
					source: "192.168.1.40:/coding",
					serverAddress: "192.168.1.40",
				}),
				machineIdSha256: host.hostMachineIdSha256,
			},
			physicalInstanceId: randomUUID(),
			hostMachineIdSha256: host.hostMachineIdSha256,
			hostBootId: host.hostBootId,
		},
		permit: {
			schema: "qorpera.computer-usage-permit/v1",
			mode: "paid",
			permitId: randomUUID(),
			allocationId: binding.machineId,
			instanceSha256: plan.instanceSha256,
			nodeId: "",
			epoch: randomUUID(),
			generation: 1,
			reservationId: randomUUID(),
			hostBootId: host.hostBootId,
			guestBootId: null,
			physicalId: null,
			issuedAt: "2026-09-25T12:00:00.000Z",
			deadline: "2026-09-25T12:05:30.000Z",
			validForMs: 330000,
			windowMs: 300000,
			stopReserveMs: 30000,
			tariffVersion: 1,
			cpuMillis: 4000,
			memoryBytes: 8589934592,
			state: "prepared",
		},
		requestStartedUptimeMs: host.uptimeMs,
	};
	input.permit.nodeId = input.machine.nodeId;
	let state: "running" | "stopped" | "absent" | "other" = "stopped";
	const operation = (): LxdOperationReference => ({
		project: binding.project,
		instanceName: plan.request.name,
		operationId: randomUUID(),
	});
	const physical = {
		inspect: vi.fn(async () => state),
		start: vi.fn(async (): Promise<LxdOperationReference> => {
			state = "running";
			return operation();
		}),
		startSettled: vi.fn(async (): Promise<"pending" | "succeeded" | "failed"> => "succeeded"),
		stop: vi.fn(async (): Promise<LxdOperationReference> => {
			state = "stopped";
			return operation();
		}),
	} satisfies PaidComputerGuardPhysical;
	const clock = vi.fn(async () => ({ ...host }));
	const journal = new PaidComputerGuardJournal(journalRoot);
	const guard = new PaidComputerGuard(journal, physical, clock);
	const register = async (arm = input) => {
		const prepareRequestText = JSON.stringify({
			schema: "qorpera.coding-computer-prepare/v2",
			requestId: arm.permit.permitId,
			machineId: arm.machine.allocationId,
			machineIdSha256: arm.machine.hostMachineIdSha256,
			hostBootId: arm.machine.hostBootId,
		});
		const intent: PaidComputerPrestartIntent = {
			schema: "qorpera.computer-prestart-intent/v1",
			permitId: arm.permit.permitId,
			allocationId: arm.machine.allocationId,
			instanceSha256: arm.permit.instanceSha256,
			hostMachineIdSha256: arm.machine.hostMachineIdSha256,
			hostBootId: arm.machine.hostBootId,
			prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
			prepareRequestText,
		};
		const retained = await guard.registerPrestart(intent);
		arm.permit = {
			...arm.permit,
			schema: "qorpera.computer-usage-permit/v2",
			prestart: {
				guardIncarnationId: retained.guardIncarnationId,
				prepareSha256: intent.prepareSha256,
			},
		};
		return intent;
	};
	if (initialize) {
		await guard.initialize();
		await register();
	}
	return {
		root,
		journalRoot,
		journal,
		guard,
		clock,
		host,
		input,
		physical,
		operation,
		plan,
		register,
		setState(value: typeof state) {
			state = value;
		},
		restart: () => new PaidComputerGuard(journal, physical, clock),
	};
}

describe("independent host paid-computer custody", () => {
	it("persists original deadline across replay/restart and stops without executor, DB or network", async () => {
		const f = await fixture();
		const armed = await f.guard.arm(f.input);
		expect(armed.stopAtUptimeMs).toBe(400000);
		await f.guard.start(f.input.permit.permitId, 1);
		await f.guard.sweep();
		f.host.uptimeMs = 200000;
		const restarted = f.restart();
		await restarted.initialize();
		const replay = await restarted.arm({ ...f.input, requestStartedUptimeMs: f.host.uptimeMs });
		expect(replay.stopAtUptimeMs).toBe(armed.stopAtUptimeMs);
		f.host.uptimeMs = 400000;
		await restarted.sweep();
		const stopped = await restarted.status(f.input.permit.permitId);
		expect(stopped.phase).toBe("stopped");
		expect(stopped.stopReceipt).toMatchObject({
			state: "stopped",
			physicalInstanceId: f.input.machine.physicalInstanceId,
			closedAtUptimeMs: 400000,
			closedHostBootId: f.host.hostBootId,
		});
		expect(f.physical.stop).toHaveBeenCalledTimes(1);
		expect(await readFile(join(f.journalRoot, `${f.input.permit.permitId}.json`), "utf8")).toContain(
			'"phase":"stopped"',
		);
	});
	it("subtracts complete RPC time and refuses a permit with less than the stop reserve", async () => {
		const f = await fixture();
		f.host.uptimeMs += 5000;
		expect(
			(await f.guard.arm({ ...f.input, permit: { ...f.input.permit, validForMs: 325000 } })).stopAtUptimeMs,
		).toBe(395000);
		const next = { ...f.input, permit: { ...f.input.permit, permitId: randomUUID(), validForMs: 30000 } };
		await f.register(next);
		await expect(f.guard.arm(next)).rejects.toThrow();
	});
	it("allows only committed next-generation renewal and never revives an expired generation", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		f.host.uptimeMs += 200000;
		const renewed: PaidComputerArm = {
			...f.input,
			requestStartedUptimeMs: f.host.uptimeMs,
			permit: {
				...f.input.permit,
				generation: 2,
				reservationId: randomUUID(),
				issuedAt: "2026-09-25T12:03:20.000Z",
				deadline: "2026-09-25T12:08:50.000Z",
			},
		};
		expect((await f.guard.arm(renewed)).stopAtUptimeMs).toBe(600000);
		await expect(f.guard.arm(f.input)).rejects.toThrow("RENEWAL_REFUSED");
		f.host.uptimeMs = 600000;
		await f.guard.sweep();
		await expect(
			f.guard.arm({ ...renewed, permit: { ...renewed.permit, generation: 3, reservationId: randomUUID() } }),
		).rejects.toThrow("RENEWAL_REFUSED");
	});
	it("requires a stopped exact machine, one active permit per machine, and one start only", async () => {
		const f = await fixture();
		f.setState("running");
		await expect(f.guard.arm(f.input)).rejects.toThrow("STOPPED_MACHINE_REQUIRED");
		f.setState("stopped");
		await f.guard.arm(f.input);
		const second = { ...f.input, permit: { ...f.input.permit, permitId: randomUUID() } };
		await f.register(second);
		await expect(f.guard.arm(second)).rejects.toThrow("MACHINE_BUSY");
		const first = await f.guard.start(f.input.permit.permitId, 1);
		expect(await f.guard.start(f.input.permit.permitId, 1)).toEqual(first);
		expect(f.physical.start).toHaveBeenCalledOnce();
	});
	it("retains unknown start custody after lost reply, repeatedly stopping even if initially absent", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		f.physical.start.mockImplementationOnce(async () => {
			f.setState("absent");
			throw new Error("reply lost");
		});
		await expect(f.guard.start(f.input.permit.permitId, 1)).rejects.toThrow("reply lost");
		expect((await f.guard.status(f.input.permit.permitId)).stopReceipt).toBeNull();
		f.setState("running");
		await f.guard.sweep();
		expect(f.physical.stop).toHaveBeenCalledTimes(1);
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopping");
		const restarted = f.restart();
		await restarted.initialize();
		await restarted.sweep();
		expect((await restarted.status(f.input.permit.permitId)).stopReceipt).toBeNull();
	});
	it("latches expiry while start reply is delayed and rechecks physical state after start settles", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		let complete!: (reference: LxdOperationReference) => void;
		f.physical.start.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const start = f.guard.start(f.input.permit.permitId, 1);
		await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
		f.host.uptimeMs = 400000;
		await f.guard.sweep();
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopping");
		f.setState("running");
		complete(f.operation());
		await start;
		await f.guard.sweep();
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopped");
	});
	it("preserves stop operation identity across asynchronous stop and restart", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		const operation = f.operation();
		f.physical.stop.mockImplementationOnce(async () => operation);
		expect((await f.guard.stop(f.input.permit.permitId)).phase).toBe("stopping");
		f.setState("stopped");
		const restarted = f.restart();
		await restarted.initialize();
		await restarted.sweep();
		expect((await restarted.status(f.input.permit.permitId)).stopReceipt?.operationId).toBe(operation.operationId);
	});
	it("persists known start completion before LXD forgets its operation", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await f.guard.sweep();
		f.physical.startSettled.mockRejectedValue(new Error("LXD_OPERATION_UNKNOWN"));
		f.host.uptimeMs = 400000;
		await f.guard.sweep();
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopped");
	});
	it("invalidates permits on host reboot without rebasing their deadline", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await f.guard.sweep();
		f.host.hostBootId = randomUUID();
		f.host.uptimeMs = 1000;
		await f.guard.sweep();
		expect(f.physical.stop).toHaveBeenCalledOnce();
		expect((await f.guard.status(f.input.permit.permitId)).stopReceipt).toMatchObject({
			hostBootId: f.input.machine.hostBootId,
			closedHostBootId: f.host.hostBootId,
			closedAtUptimeMs: 1000,
		});
		await expect(f.guard.arm(f.input)).rejects.toThrow("HOST_DIFFERS");
	});
	it("still physically stops when the clock or journal becomes unavailable", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		f.clock.mockRejectedValue(new Error("clock unavailable"));
		await expect(f.guard.sweep()).rejects.toThrow("STOP_UNCONFIRMED");
		expect(f.physical.stop).toHaveBeenCalledOnce();
		f.clock.mockImplementation(async () => ({ ...f.host }));
		f.setState("running");
		vi.spyOn(f.journal, "save").mockRejectedValue(new Error("disk unavailable"));
		await expect(f.guard.stop(f.input.permit.permitId)).rejects.toThrow();
		expect(f.physical.stop).toHaveBeenCalledTimes(2);
	});
	it("exposes durable latest/list and rejects tampered, unprotected journal files", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		expect((await f.guard.latest(f.input.machine.allocationId))?.permit.permitId).toBe(f.input.permit.permitId);
		expect(await f.guard.list()).toHaveLength(1);
		await chmod(join(f.journalRoot, `${f.input.permit.permitId}.json`), 0o644);
		await expect(f.restart().initialize()).rejects.toThrow("journal record");
	});
	it("stops on expiry even when persisting the stopping latch fails", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		f.host.uptimeMs = 400000;
		vi.spyOn(f.journal, "save").mockRejectedValue(new Error("disk unavailable"));
		await expect(f.guard.sweep()).rejects.toThrow("STOP_UNCONFIRMED");
		expect(f.physical.stop).toHaveBeenCalledOnce();
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopping");
	});
	it("does not dispatch if the one-use start intent could not be made durable", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		vi.spyOn(f.journal, "save").mockRejectedValue(new Error("disk unavailable"));
		await expect(f.guard.start(f.input.permit.permitId, 1)).rejects.toThrow("disk unavailable");
		expect(f.physical.start).not.toHaveBeenCalled();
	});
	it("never re-times an arm whose rename succeeded but durability reply was lost", async () => {
		const f = await fixture();
		const save = f.journal.save.bind(f.journal);
		vi.spyOn(f.journal, "save").mockImplementationOnce(async (value) => {
			await save(value);
			throw new Error("directory fsync uncertain");
		});
		await expect(f.guard.arm(f.input)).rejects.toThrow("fsync uncertain");
		f.host.uptimeMs += 100000;
		const replay = await f.guard.arm({ ...f.input, requestStartedUptimeMs: f.host.uptimeMs });
		expect(replay.stopAtUptimeMs).toBe(400000);
		expect(replay.phase).toBe("stopping");
		await expect(f.guard.start(f.input.permit.permitId, 1)).rejects.toThrow("START_REFUSED");
	});
	it("uses only exact physical UUID and fixed forced-stop LXD operations", async () => {
		const f = await fixture();
		const config = {
			...f.plan.request.config,
			"volatile.base_image": f.input.machine.binding.imageFingerprint,
			"volatile.uuid": f.input.machine.physicalInstanceId,
		};
		const instance: LxdInstanceRecord = {
			name: f.plan.request.name,
			type: "virtual-machine",
			status: "Stopped",
			statusCode: 102,
			config,
			expandedConfig: config,
			devices: f.plan.request.devices,
			expandedDevices: f.plan.request.devices,
			profiles: [],
		};
		const client = {
			getInstance: vi.fn(async () => instance),
			submitInstanceOperation: vi.fn(async () => f.operation()),
			inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
		};
		const adapter = new LxdPaidComputerGuardPhysical(client, f.clock);
		await adapter.start(f.input.machine, 400000, new AbortController().signal);
		await adapter.stop(f.input.machine, new AbortController().signal);
		expect(client.submitInstanceOperation.mock.calls[1]).toEqual([
			"coding",
			{ action: "stop", name: f.plan.request.name, force: true },
			expect.any(AbortSignal),
		]);
		instance.config = { ...config, "volatile.uuid": randomUUID() };
		await expect(adapter.stop(f.input.machine, new AbortController().signal)).rejects.toThrow(
			"PHYSICAL_INSTANCE_DIFFERS",
		);
		expect(client.submitInstanceOperation).toHaveBeenCalledTimes(2);
	});
	it("serves a private independent Unix control endpoint and stops on shutdown", async () => {
		const f = await fixture(false);
		const controller = new AbortController();
		const socketPath = join(f.root, "guard.sock");
		const report = vi.fn();
		const serving = servePaidComputerGuard({ guard: f.guard, socketPath, signal: controller.signal, report });
		await vi.waitFor(() => expect(report).toHaveBeenCalledWith("ready"));
		const client = new PaidComputerGuardClient(socketPath);
		try {
			await f.register();
			await client.arm(f.input);
			await client.start(f.input.permit.permitId, 1);
			expect((await client.latest(f.input.machine.allocationId))?.phase).toBe("running");
			expect(await client.list()).toHaveLength(1);
		} finally {
			controller.abort();
			await serving;
		}
		expect(f.physical.stop).toHaveBeenCalledOnce();
	});
});

describe("durable prestart cancellation", () => {
	it("retains the exact prepare identity and original clock through replay and reboot", async () => {
		const f = await fixture(),
			original = (await f.guard.listPrestarts())[0];
		f.host.uptimeMs += 900000;
		expect(await f.guard.registerPrestart(original.intent)).toEqual(original);
		f.host.hostBootId = randomUUID();
		f.host.uptimeMs = 10;
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.prestartStatus(original.intent.permitId)).toEqual(original);
		const abandoned = await restarted.abandonPrestart(original.intent);
		expect(abandoned.state).toBe("abandoned");
		expect(abandoned.abandonment?.hostBootId).toBe(original.intent.hostBootId);
		expect(f.physical.inspect).not.toHaveBeenCalled();
		expect(f.physical.start).not.toHaveBeenCalled();
	});
	it("permanently denies an abandoned absent machine and returns the same cancellation after restart", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		f.setState("absent");
		const cancelled = await f.guard.abandonPrestart(intent);
		expect(await f.guard.abandonPrestart(intent)).toEqual(cancelled);
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.abandonPrestart(intent)).toEqual(cancelled);
		expect(await restarted.registerPrestart(intent)).toEqual(cancelled);
		await expect(restarted.arm(f.input)).rejects.toThrow("PRESTART_ABANDONED");
		await expect(restarted.start(intent.permitId, 1)).rejects.toThrow();
		expect(f.physical.start).not.toHaveBeenCalled();
	});
	it("serializes abandonment before a delayed start of an already armed computer", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		await f.guard.arm(f.input);
		const result = await Promise.allSettled([f.guard.abandonPrestart(intent), f.guard.start(intent.permitId, 1)]);
		expect(result.map((entry) => entry.status)).toEqual(["fulfilled", "rejected"]);
		await expect(f.guard.arm(f.input)).rejects.toThrow("PRESTART_ABANDONED");
		expect(f.physical.start).not.toHaveBeenCalled();
	});
	it("refuses cancellation once dispatch wins even while its physical reply is unresolved", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		await f.guard.arm(f.input);
		let finish!: (reference: LxdOperationReference) => void;
		f.physical.start.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const start = f.guard.start(intent.permitId, 1);
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		expect((await f.guard.prestartStatus(intent.permitId))?.state).toBe("dispatched");
		await expect(f.guard.abandonPrestart(intent)).rejects.toThrow("PRESTART_DISPATCHED");
		finish(f.operation());
		await start;
	});
	it("does not infer unused execution if a dispatched physical guard record is missing", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		await f.guard.arm(f.input);
		await f.guard.start(intent.permitId, 1);
		await unlink(join(f.journalRoot, `${intent.permitId}.json`));
		const restarted = f.restart();
		await restarted.initialize();
		await expect(restarted.abandonPrestart(intent)).rejects.toThrow("PRESTART_DISPATCHED");
		await expect(restarted.arm(f.input)).rejects.toThrow("PRESTART_DISPATCHED");
		expect(f.physical.start).toHaveBeenCalledOnce();
	});
	it("retains a conservative dispatch fence if the physical guard write fails after the prestart write", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		await f.guard.arm(f.input);
		vi.spyOn(f.journal, "save").mockRejectedValueOnce(new Error("guard write failed"));
		await expect(f.guard.start(intent.permitId, 1)).rejects.toThrow("guard write failed");
		const restarted = f.restart();
		await restarted.initialize();
		await expect(restarted.abandonPrestart(intent)).rejects.toThrow("PRESTART_DISPATCHED");
		await expect(restarted.start(intent.permitId, 1)).rejects.toThrow("PRESTART_DISPATCHED");
		expect(f.physical.start).not.toHaveBeenCalled();
	});
	it("does not issue cancellation proof after ambiguous durability until a validated restart", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		await f.guard.arm(f.input);
		const save = f.journal.savePrestarts.bind(f.journal);
		vi.spyOn(f.journal, "savePrestarts").mockImplementationOnce(async (value) => {
			await save(value);
			throw new Error("fsync uncertain");
		});
		await expect(f.guard.abandonPrestart(intent)).rejects.toThrow("fsync uncertain");
		await expect(f.guard.prestartStatus(intent.permitId)).rejects.toThrow("PRESTART_UNCONFIRMED");
		await expect(f.guard.start(intent.permitId, 1)).rejects.toThrow("PRESTART_UNCONFIRMED");
		const restarted = f.restart();
		await restarted.initialize();
		expect((await restarted.abandonPrestart(intent)).state).toBe("abandoned");
		expect(f.physical.start).not.toHaveBeenCalled();
	});
	it("rejects missing, mismatched, secret-bearing and corrupt prestart evidence", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		const prepareRequestText = JSON.stringify({
			...JSON.parse(intent.prepareRequestText),
			leaseToken: "not-a-real-secret",
		});
		expect(() =>
			parsePaidComputerPrestartIntent({
				...intent,
				prepareRequestText,
				prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
			}),
		).toThrow("PRESTART_SECRET");
		await expect(f.guard.registerPrestart({ ...intent, instanceSha256: "d".repeat(64) })).rejects.toThrow(
			"PRESTART_DIFFERS",
		);
		const otherText = JSON.stringify({ ...JSON.parse(intent.prepareRequestText), requestId: randomUUID() });
		await expect(
			f.guard.abandonPrestart({
				...intent,
				permitId: JSON.parse(otherText).requestId,
				prepareRequestText: otherText,
				prepareSha256: createHash("sha256").update(otherText).digest("hex"),
			}),
		).rejects.toThrow("PRESTART_MISSING");
		await writeFile(join(f.journalRoot, "prestarts.json"), "{corrupt", { mode: 0o600 });
		await expect(f.restart().initialize()).rejects.toThrow();
	});
	it("cannot discard the intent journal while retaining v2 physical custody", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await unlink(join(f.journalRoot, "prestarts.json"));
		await expect(f.restart().initialize()).rejects.toThrow("PRESTART_MISSING");
	});
	it("rejects fresh legacy permits and mismatched journal incarnations", async () => {
		const f = await fixture();
		await expect(
			f.guard.arm({
				...f.input,
				permit: { ...f.input.permit, schema: "qorpera.computer-usage-permit/v1", prestart: undefined },
			}),
		).rejects.toThrow("PRESTART_REQUIRED");
		await expect(
			f.guard.arm({
				...f.input,
				permit: {
					...f.input.permit,
					prestart: { prepareSha256: f.input.permit.prestart!.prepareSha256, guardIncarnationId: randomUUID() },
				},
			}),
		).rejects.toThrow("PRESTART_DIFFERS");
	});
	it("refuses an expired first attachment without rebasing the retained registration clock", async () => {
		const f = await fixture();
		f.host.uptimeMs += 900000;
		await expect(f.guard.arm({ ...f.input, requestStartedUptimeMs: f.host.uptimeMs })).rejects.toThrow(
			"PERMIT_EXPIRED",
		);
		expect((await f.guard.abandonPrestart((await f.guard.listPrestarts())[0].intent)).state).toBe("abandoned");
	});
	it("uses remaining RPC TTL without subtracting elapsed prestart time twice", async () => {
		const f = await fixture();
		f.host.uptimeMs += 180000;
		const restarted = f.restart();
		await restarted.initialize();
		const attached = await restarted.arm({
			...f.input,
			requestStartedUptimeMs: f.host.uptimeMs,
			permit: { ...f.input.permit, validForMs: 150000 },
		});
		expect(attached.deadlineUptimeMs).toBe(430000);
		expect(attached.stopAtUptimeMs).toBe(400000);
	});
	it("retires undispatched stop custody without later presenting it as abandonment", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		await f.guard.arm(f.input);
		expect((await f.guard.stop(intent.permitId)).phase).toBe("stopped");
		expect((await f.guard.prestartStatus(intent.permitId))?.state).toBe("retired");
		const restarted = f.restart();
		await restarted.initialize();
		await expect(restarted.abandonPrestart(intent)).rejects.toThrow("PRESTART_RETIRED");
		await expect(restarted.arm(f.input)).rejects.toThrow("PRESTART_RETIRED");
		await expect(restarted.start(intent.permitId, 1)).rejects.toThrow("PRESTART_RETIRED");
		expect((await restarted.status(intent.permitId)).stopReceipt).not.toBeNull();
	});
	it("resumes stop custody if retirement persisted before its physical journal write", async () => {
		const f = await fixture(),
			intent = (await f.guard.listPrestarts())[0].intent;
		await f.guard.arm(f.input);
		const save = vi.spyOn(f.journal, "save").mockRejectedValue(new Error("stop disk unavailable"));
		await expect(f.guard.stop(intent.permitId)).rejects.toThrow();
		save.mockRestore();
		const restarted = f.restart();
		await restarted.initialize();
		expect((await restarted.status(intent.permitId)).phase).toBe("stopping");
		await restarted.sweep();
		expect((await restarted.status(intent.permitId)).phase).toBe("stopped");
		await expect(restarted.abandonPrestart(intent)).rejects.toThrow("PRESTART_RETIRED");
		expect(f.physical.start).not.toHaveBeenCalled();
	});
	it("exposes the durable prestart lifecycle through the private IPC endpoint", async () => {
		const f = await fixture(false),
			controller = new AbortController(),
			report = vi.fn();
		const socketPath = join(f.root, "guard.sock");
		const serving = servePaidComputerGuard({ guard: f.guard, socketPath, signal: controller.signal, report });
		await vi.waitFor(() => expect(report).toHaveBeenCalledWith("ready"));
		try {
			const intent = await f.register(),
				client = new PaidComputerGuardClient(socketPath);
			const registered = await client.registerPrestart(intent);
			expect(await client.prestartStatus(intent.permitId)).toEqual(registered);
			expect(await client.listPrestarts()).toEqual([registered]);
			const abandoned = await client.abandonPrestart(intent);
			expect(abandoned.state).toBe("abandoned");
			expect(await client.abandonPrestart(intent)).toEqual(abandoned);
			await expect(client.arm(f.input)).rejects.toThrow("PRESTART_ABANDONED");
		} finally {
			controller.abort();
			await serving;
		}
		expect(f.physical.start).not.toHaveBeenCalled();
	});
	it("retains permanent tombstones at capacity instead of pruning replay fences", async () => {
		const f = await fixture(),
			original = (await f.guard.listPrestarts())[0];
		const abandoned = await f.guard.abandonPrestart(original.intent);
		const records = [
			abandoned,
			...Array.from({ length: 4095 }, () => {
				const permitId = randomUUID(),
					prepareRequestText = JSON.stringify({
						...JSON.parse(original.intent.prepareRequestText),
						requestId: permitId,
					});
				return {
					...original,
					intent: {
						...original.intent,
						permitId,
						prepareRequestText,
						prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
					},
				};
			}),
		];
		await f.journal.savePrestarts({
			schema: "qorpera.computer-prestart-journal/v1",
			guardIncarnationId: original.guardIncarnationId,
			records,
		});
		const restarted = f.restart();
		await restarted.initialize();
		expect((await restarted.prestartStatus(original.intent.permitId))?.state).toBe("abandoned");
		const permitId = randomUUID(),
			prepareRequestText = JSON.stringify({
				...JSON.parse(original.intent.prepareRequestText),
				requestId: permitId,
			});
		await expect(
			restarted.registerPrestart({
				...original.intent,
				permitId,
				prepareRequestText,
				prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
			}),
		).rejects.toThrow("JOURNAL_FULL");
		expect(await restarted.abandonPrestart(original.intent)).toEqual(abandoned);
	});
});
