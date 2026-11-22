import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	codingMachineStartOperation,
	type LxdCodingMachineBinding,
	lxdCodingMachineJournalPlan,
	reconcileCodingMachine,
} from "../src/coding-machine.ts";
import {
	CODING_STANDBY_VM_PREFIX,
	type CodingStandbyLxdClient,
	CodingStandbyPool,
} from "../src/coding-standby-pool.ts";
import {
	type LxdInstanceRecord,
	type LxdOperationReference,
	type LxdOperationState,
	LxdSubmissionRefused,
	type LxdTrackedInstanceAction,
} from "../src/lxd-client.ts";

const BASE_FP = "a".repeat(64);
const SNAP_FP = "b".repeat(64);
const MACHINE_SHA = "c".repeat(64);
const PROVIDER_POLICY_SHA = "d".repeat(64);
const BOOTSTRAP_SHA = "e".repeat(64);

function makeFakeStandbyLxd(options?: {
	refuseStatefulStop?: boolean;
	refuseStatefulStart?: boolean;
	failHotplugNic?: boolean;
}) {
	const instances = new Map<string, LxdInstanceRecord>();
	const operations = new Map<string, { state: LxdOperationState; action: LxdTrackedInstanceAction }>();
	const trackedActions: LxdTrackedInstanceAction[] = [];
	const powerCalls: { name: string; action: "start" | "stop"; stateful: boolean; force?: boolean }[] = [];
	const renames: { oldName: string; newName: string }[] = [];
	const deviceReplacements: { name: string; devices: Readonly<Record<string, Readonly<Record<string, string>>>> }[] =
		[];

	const client: CodingStandbyLxdClient & {
		submitInstanceOperation(
			project: string,
			action: LxdTrackedInstanceAction,
			signal: AbortSignal,
		): Promise<LxdOperationReference>;
		inspectInstanceOperation(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	} = {
		async getInstance(_project, name) {
			return instances.get(name);
		},
		async createInstance(_project, request) {
			instances.set(request.name, {
				name: request.name,
				type: "virtual-machine",
				status: "Stopped",
				statusCode: 102,
				stateful: false,
				config: { ...request.config, "volatile.base_image": request.source.fingerprint },
				profiles: [...request.profiles],
				devices: request.devices,
				expandedDevices: request.devices,
				expandedConfig: { ...request.config, "volatile.base_image": request.source.fingerprint },
			});
		},
		async setInstancePower(_project, name, action) {
			powerCalls.push({ name, action, stateful: false });
			const inst = instances.get(name);
			if (!inst) throw new Error("instance missing");
			instances.set(name, {
				...inst,
				status: action === "start" ? "Running" : "Stopped",
				statusCode: action === "start" ? 103 : 102,
				stateful: false,
			});
		},
		async setInstancePowerStateful(_project, name, action, stateful, _signal, force) {
			powerCalls.push({ name, action, stateful, force });
			if (action === "stop" && stateful && options?.refuseStatefulStop) {
				throw new Error("stateful stop unsupported");
			}
			if (action === "start" && stateful && options?.refuseStatefulStart) {
				throw new Error("stateful start unsupported");
			}
			const inst = instances.get(name);
			if (!inst) throw new Error("instance missing");
			instances.set(name, {
				...inst,
				status: action === "start" ? "Running" : "Stopped",
				statusCode: action === "start" ? 103 : 102,
				stateful: action === "stop" ? stateful : false,
			});
		},
		async deleteInstance(_project, name) {
			instances.delete(name);
		},
		async renameInstance(_project, oldName, newName) {
			renames.push({ oldName, newName });
			const inst = instances.get(oldName);
			if (!inst) throw new Error("instance missing");
			if (inst.status !== "Stopped") throw new Error("cannot rename running instance");
			instances.delete(oldName);
			instances.set(newName, { ...inst, name: newName });
		},
		async updateInstanceConfig(_project, name, update) {
			const inst = instances.get(name);
			if (!inst) throw new Error("instance missing");
			const nextConfig: Record<string, string> = {};
			for (const [k, v] of Object.entries(inst.config)) {
				if (k.startsWith("volatile.") || k.startsWith("image.")) nextConfig[k] = v;
			}
			for (const [k, v] of Object.entries(update.config)) nextConfig[k] = v;
			const nextDevices = update.devices ?? inst.devices;
			instances.set(name, {
				...inst,
				config: nextConfig,
				expandedConfig: nextConfig,
				devices: nextDevices,
				expandedDevices: nextDevices,
			});
		},
		async replaceInstanceDevices(_project, name, devices) {
			deviceReplacements.push({ name, devices });
			if (options?.failHotplugNic) throw new Error("hotplug refused");
			const inst = instances.get(name);
			if (!inst) throw new Error("instance missing");
			instances.set(name, { ...inst, devices, expandedDevices: devices });
		},
		async listInstances() {
			return [...instances.values()];
		},
		async hasImage(_project, fingerprint) {
			return fingerprint === BASE_FP || fingerprint === SNAP_FP;
		},
		async execInstancePipe() {
			return { exitCode: 0, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) };
		},
		async submitInstanceOperation(project, action) {
			trackedActions.push(action);
			if (action.action === "stop" && action.stateful === true && options?.refuseStatefulStop) {
				throw new LxdSubmissionRefused(400, 400, "stateful stop unsupported");
			}
			if (action.action === "start" && action.stateful === true && options?.refuseStatefulStart) {
				throw new LxdSubmissionRefused(400, 400, "stateful start unsupported");
			}
			const operationId = randomUUID();
			const instanceName = action.action === "create" ? action.request.name : action.name;
			if (action.action === "create") {
				await client.createInstance(project, action.request);
			} else if (action.action === "start") {
				const inst = instances.get(action.name);
				if (inst) {
					instances.set(action.name, { ...inst, status: "Running", statusCode: 103, stateful: false });
				}
			} else if (action.action === "stop") {
				const inst = instances.get(action.name);
				if (inst) {
					instances.set(action.name, {
						...inst,
						status: "Stopped",
						statusCode: 102,
						stateful: action.stateful === true,
					});
				}
			} else if (action.action === "delete") {
				instances.delete(action.name);
			}
			operations.set(operationId, { state: "succeeded", action });
			return { project, instanceName, operationId };
		},
		async inspectInstanceOperation(reference) {
			return operations.get(reference.operationId)?.state ?? "failed";
		},
	};

	return { client, instances, trackedActions, powerCalls, renames, deviceReplacements };
}

function makeBinding(imageFingerprint = BASE_FP): LxdCodingMachineBinding {
	return {
		schema: "qorpera.lxd-coding-machine/v1",
		machineId: "11111111-1111-4111-8111-111111111111",
		companyId: "22222222-2222-4222-8222-222222222222",
		environmentId: "33333333-3333-4333-8333-333333333333",
		memberUserId: "44444444-4444-4444-8444-444444444444",
		providerId: "native-node",
		providerPolicySha256: PROVIDER_POLICY_SHA,
		project: "coding",
		imageFingerprint,
		bootstrapSha256: BOOTSTRAP_SHA,
		storagePool: "coding-disks",
		network: "qagent0",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
		rootDiskBytes: 64 * 1024 ** 3,
	};
}

function makeStorage() {
	return {
		policy: {
			schema: "qorpera.coding-nas-policy/v1" as const,
			mountPoint: "/srv/coding",
			rootPath: "/srv/coding/executor",
			source: "192.168.1.40:/coding",
			serverAddress: "192.168.1.40",
		},
		machineIdSha256: MACHINE_SHA,
	};
}

describe("coding warm standby pool and stateful sleep", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("pre-boots network-isolated standby VMs, hands over via stateful resume + NIC hotplug, and replenishes in background", async () => {
		const fake = makeFakeStandbyLxd();
		const binding = makeBinding(BASE_FP);
		const pool = new CodingStandbyPool({
			lxd: fake.client,
			vmPolicy: {
				project: binding.project,
				imageFingerprint: binding.imageFingerprint,
				storagePool: binding.storagePool,
				cpus: binding.cpus,
				memoryBytes: binding.memoryBytes,
				rootDiskBytes: binding.rootDiskBytes,
			},
			standbyPoolSize: 2,
			bootPollMs: 5,
		});

		pool.start();
		await pool.waitIdle();
		expect(pool.readyCount(BASE_FP)).toBe(2);
		for (const inst of fake.instances.values()) {
			expect(inst.name.startsWith(CODING_STANDBY_VM_PREFIX)).toBe(true);
			expect(Object.keys(inst.devices)).toEqual(["root"]);
			expect(inst.status).toBe("Stopped");
			expect(inst.stateful).toBe(true);
		}

		const journalRoot = await mkdtemp(join(tmpdir(), "qorpera-standby-"));
		tempDirs.push(journalRoot);
		const plan = lxdCodingMachineJournalPlan(binding, makeStorage());

		const result = await reconcileCodingMachine({
			plan,
			journalRoot,
			desiredState: "running",
			client: fake.client,
			authorize: async (intent) => ({
				schema: "qorpera.coding-machine-admission/v1",
				machineId: binding.machineId,
				workerId: null,
				instanceSha256: plan.instanceSha256,
				intent,
				guestUid: null,
				validForMs: 5000,
				nodeId: "99999999-9999-4999-8999-999999999999",
				nodeVersion: 1,
			}),
			signal: AbortSignal.timeout(10_000),
			plug: async () => "0e:51:0a:d2:01:02",
			claimStandby: (request, signal) => pool.claim(request, signal),
		});

		expect(result.state).toBe("running");
		expect(fake.renames).toHaveLength(1);
		expect(fake.renames[0].newName).toBe(plan.name);
		expect(fake.deviceReplacements).toHaveLength(1);
		expect(fake.deviceReplacements[0].devices.network?.hwaddr).toBe("0e:51:0a:d2:01:02");
		const claimedInstance = fake.instances.get(plan.name);
		expect(claimedInstance?.status).toBe("Running");
		expect(() => plan.assertInstance(claimedInstance!, "run")).not.toThrow();

		const startOpId = await codingMachineStartOperation(journalRoot, plan);
		expect(startOpId).toMatch(/^[0-9a-f-]{36}$/);

		await pool.waitIdle();
		expect(pool.readyCount(BASE_FP)).toBe(2);
		await pool.close();
		expect(pool.readyCount()).toBe(0);
		expect(fake.instances.has(plan.name)).toBe(true);
		expect(fake.instances.size).toBe(1);
	});

	it("falls back transparently to cold start when standby stateful resume or NIC hotplug fails", async () => {
		const fake = makeFakeStandbyLxd({ failHotplugNic: true });
		const binding = makeBinding(BASE_FP);
		const pool = new CodingStandbyPool({
			lxd: fake.client,
			vmPolicy: {
				project: binding.project,
				imageFingerprint: binding.imageFingerprint,
				storagePool: binding.storagePool,
				cpus: binding.cpus,
				memoryBytes: binding.memoryBytes,
				rootDiskBytes: binding.rootDiskBytes,
			},
			standbyPoolSize: 1,
			bootPollMs: 5,
		});

		pool.start();
		await pool.waitIdle();
		expect(pool.readyCount(BASE_FP)).toBe(1);

		const journalRoot = await mkdtemp(join(tmpdir(), "qorpera-standby-fb-"));
		tempDirs.push(journalRoot);
		const plan = lxdCodingMachineJournalPlan(binding, makeStorage());
		const auth = async (intent: string) => ({
			schema: "qorpera.coding-machine-admission/v1",
			machineId: binding.machineId,
			workerId: null,
			instanceSha256: plan.instanceSha256,
			intent,
			guestUid: null,
			validForMs: 5000,
			nodeId: "99999999-9999-4999-8999-999999999999",
			nodeVersion: 1,
		});

		const first = await reconcileCodingMachine({
			plan,
			journalRoot,
			desiredState: "running",
			client: fake.client,
			authorize: auth,
			signal: AbortSignal.timeout(10_000),
			plug: async () => "0e:51:0a:d2:01:03",
			claimStandby: (request, signal) => pool.claim(request, signal),
		});
		expect(first.state).toBe("pending");
		expect(fake.trackedActions.some((a) => a.action === "start" && a.stateful === false)).toBe(true);

		const second = await reconcileCodingMachine({
			plan,
			journalRoot,
			desiredState: "running",
			client: fake.client,
			authorize: auth,
			signal: AbortSignal.timeout(10_000),
			plug: async () => "0e:51:0a:d2:01:03",
		});
		expect(second.state).toBe("running");
		expect(fake.instances.get(plan.name)?.devices.network?.hwaddr).toBe("0e:51:0a:d2:01:03");
		await pool.close();
	});

	it("invalidates stale fingerprints, sweeps orphans, and supports stateful sleep with cold stop fallback", async () => {
		const fake = makeFakeStandbyLxd({ refuseStatefulStop: true });
		const binding = makeBinding(BASE_FP);
		fake.instances.set(`${CODING_STANDBY_VM_PREFIX}orphan0001`, {
			name: `${CODING_STANDBY_VM_PREFIX}orphan0001`,
			type: "virtual-machine",
			status: "Stopped",
			statusCode: 102,
			config: {},
			profiles: [],
			devices: {},
			expandedDevices: {},
			expandedConfig: {},
		});

		const pool = new CodingStandbyPool({
			lxd: fake.client,
			vmPolicy: {
				project: binding.project,
				imageFingerprint: binding.imageFingerprint,
				storagePool: binding.storagePool,
				cpus: binding.cpus,
				memoryBytes: binding.memoryBytes,
				rootDiskBytes: binding.rootDiskBytes,
			},
			standbyPoolSize: 1,
			bootPollMs: 5,
		});

		const orphans = await pool.sweepOrphans(AbortSignal.timeout(5_000));
		expect(orphans).toEqual([`${CODING_STANDBY_VM_PREFIX}orphan0001`]);

		pool.setActiveFingerprints([BASE_FP, SNAP_FP]);
		await pool.waitIdle();
		expect(pool.readyCount(BASE_FP)).toBe(1);
		expect(pool.readyCount(SNAP_FP)).toBe(1);

		await pool.invalidateFingerprint(SNAP_FP);
		expect(pool.readyCount(SNAP_FP)).toBe(0);
		expect(pool.readyCount(BASE_FP)).toBe(1);
		await pool.close();

		const journalRoot = await mkdtemp(join(tmpdir(), "qorpera-stateful-sleep-"));
		tempDirs.push(journalRoot);
		const plan = lxdCodingMachineJournalPlan(binding, makeStorage());
		const auth = async (intent: string) => ({
			schema: "qorpera.coding-machine-admission/v1",
			machineId: binding.machineId,
			workerId: null,
			instanceSha256: plan.instanceSha256,
			intent,
			guestUid: null,
			validForMs: 5000,
			nodeId: "99999999-9999-4999-8999-999999999999",
			nodeVersion: 1,
		});
		const runOnce = (desiredState: "running" | "stopped", statefulStop?: boolean) =>
			reconcileCodingMachine({
				plan,
				journalRoot,
				desiredState,
				client: fake.client,
				authorize: auth,
				signal: AbortSignal.timeout(10_000),
				plug: async () => "0e:51:0a:d2:01:04",
				statefulStop,
			});

		while ((await runOnce("running")).state === "pending") {}
		expect(fake.instances.get(plan.name)?.status).toBe("Running");

		while ((await runOnce("stopped", true)).state === "pending") {}
		expect(fake.instances.get(plan.name)?.status).toBe("Stopped");
		const stopActions = fake.trackedActions.filter((a) => a.action === "stop");
		expect(stopActions).toEqual([
			{ action: "stop", name: plan.name, stateful: true },
			{ action: "stop", name: plan.name, force: true },
		]);
	});

	it("statefully sleeps and resumes a coding machine when LXD accepts stateful operations", async () => {
		const fake = makeFakeStandbyLxd();
		const binding = makeBinding(BASE_FP);
		const journalRoot = await mkdtemp(join(tmpdir(), "qorpera-stateful-ok-"));
		tempDirs.push(journalRoot);
		const plan = lxdCodingMachineJournalPlan(binding, makeStorage());
		const auth = async (intent: string) => ({
			schema: "qorpera.coding-machine-admission/v1",
			machineId: binding.machineId,
			workerId: null,
			instanceSha256: plan.instanceSha256,
			intent,
			guestUid: null,
			validForMs: 5000,
			nodeId: "99999999-9999-4999-8999-999999999999",
			nodeVersion: 1,
		});
		const runOnce = (desiredState: "running" | "stopped", statefulStop?: boolean) =>
			reconcileCodingMachine({
				plan,
				journalRoot,
				desiredState,
				client: fake.client,
				authorize: auth,
				signal: AbortSignal.timeout(10_000),
				plug: async () => "0e:51:0a:d2:01:05",
				statefulStop,
			});

		while ((await runOnce("running")).state === "pending") {}
		while ((await runOnce("stopped", true)).state === "pending") {}
		expect(fake.instances.get(plan.name)?.stateful).toBe(true);

		while ((await runOnce("running", true)).state === "pending") {}
		expect(fake.instances.get(plan.name)?.status).toBe("Running");
		expect(fake.trackedActions.some((a) => a.action === "start" && a.stateful === true)).toBe(true);
	});
});
