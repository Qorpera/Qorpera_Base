import { describe, expect, it } from "vitest";
import { agentPlugCard, withAgentPlug } from "../src/agent-plug.ts";
import { CODING_MACHINE_BASE_CONFIG } from "../src/coding-machine.ts";
import {
	CODING_STANDBY_SCHEMA,
	CODING_STANDBY_VM_PREFIX,
	type CodingStandbyLxdClient,
	CodingStandbyPool,
} from "../src/coding-standby-pool.ts";
import type { LxdCreateInstanceRequest, LxdInstanceRecord } from "../src/lxd-client.ts";

const BASE_FP = "a".repeat(64);
const SNAP_FP = "b".repeat(64);

function makeStandbyLxd(options?: { failUpdateConfig?: boolean; missingImages?: ReadonlySet<string> }) {
	const instances = new Map<string, LxdInstanceRecord>();
	const powerCalls: { name: string; action: string }[] = [];
	const renames: { from: string; to: string }[] = [];
	const configUpdates: { name: string; config: Record<string, string>; devices?: Record<string, unknown> }[] = [];
	const deleted: string[] = [];

	const client: CodingStandbyLxdClient = {
		async hasImage(_project, fingerprint) {
			return !options?.missingImages?.has(fingerprint);
		},
		async getInstance(_project, name) {
			return instances.get(name);
		},
		async createInstance(_project, request) {
			instances.set(request.name, {
				name: request.name,
				type: request.type,
				status: "Stopped",
				statusCode: 102,
				config: { ...request.config },
				profiles: [...request.profiles],
				devices: { ...request.devices },
				expandedDevices: { ...request.devices },
				expandedConfig: { ...request.config },
			});
		},
		async setInstancePower(_project, name, action) {
			powerCalls.push({ name, action });
			const inst = instances.get(name);
			if (!inst) return;
			inst.status = action === "start" ? "Running" : "Stopped";
			inst.statusCode = action === "start" ? 103 : 102;
		},
		async deleteInstance(_project, name) {
			deleted.push(name);
			instances.delete(name);
		},
		async renameInstance(_project, oldName, newName) {
			const inst = instances.get(oldName);
			if (!inst) throw new Error("not found");
			renames.push({ from: oldName, to: newName });
			instances.delete(oldName);
			instances.set(newName, { ...inst, name: newName });
		},
		async updateInstanceConfig(_project, name, update) {
			if (options?.failUpdateConfig) throw new Error("LXD_CONFIG_UPDATE_FAILED");
			const inst = instances.get(name);
			if (!inst) throw new Error("not found");
			configUpdates.push({ name, config: { ...update.config }, devices: update.devices });
			inst.config = { ...update.config };
			inst.expandedConfig = { ...update.config };
			if (update.devices) {
				inst.devices = { ...update.devices };
				inst.expandedDevices = { ...update.devices };
			}
		},
		async listInstances() {
			return [...instances.values()];
		},
	};

	return { client, instances, powerCalls, renames, configUpdates, deleted };
}

function memberRequest(name: string, fingerprint = BASE_FP): LxdCreateInstanceRequest {
	const base: LxdCreateInstanceRequest = {
		name,
		type: "virtual-machine",
		profiles: [],
		source: { type: "image", fingerprint },
		config: {
			...CODING_MACHINE_BASE_CONFIG,
			"limits.cpu": "4",
			"limits.memory": String(8 * 1024 ** 3),
			"user.qorpera.machine_id": "11111111-1111-4111-8111-111111111111",
		},
		devices: {
			root: { type: "disk", path: "/", pool: "coding-disks", size: String(64 * 1024 ** 3) },
			network: agentPlugCard("eth0"),
		},
	};
	return withAgentPlug(base, "network", "0e:51:0a:d2:01:02");
}

describe("CodingStandbyPool", () => {
	it("pre-provisions stopped standby VMs with exact member base config, claims by rename+config, and replenishes", async () => {
		const fake = makeStandbyLxd();
		const pool = new CodingStandbyPool({
			lxd: fake.client,
			vmPolicy: {
				project: "coding",
				imageFingerprint: BASE_FP,
				storagePool: "coding-disks",
				cpus: 4,
				memoryBytes: 8 * 1024 ** 3,
				rootDiskBytes: 64 * 1024 ** 3,
			},
			standbyPoolSize: 2,
		});

		pool.start();
		await pool.waitIdle();
		expect(pool.readyCount(BASE_FP)).toBe(2);
		expect(fake.instances.size).toBe(2);
		expect(fake.powerCalls).toHaveLength(0);
		for (const inst of fake.instances.values()) {
			expect(inst.name.startsWith(CODING_STANDBY_VM_PREFIX)).toBe(true);
			expect(inst.status).toBe("Stopped");
			expect(inst.statusCode).toBe(102);
			expect(inst.config).toEqual({
				...CODING_MACHINE_BASE_CONFIG,
				"limits.cpu": "4",
				"limits.memory": String(8 * 1024 ** 3),
				"user.qorpera.schema": CODING_STANDBY_SCHEMA,
				"user.qorpera.standby_image": BASE_FP,
			});
			expect(inst.config).not.toHaveProperty("security.secureboot");
			expect(Object.keys(inst.devices)).toEqual(["root"]);
		}

		const request = memberRequest("qorpera-coding-machine-1111");
		const claimed = await pool.claim(request, AbortSignal.timeout(5_000));
		expect(claimed).not.toBeNull();
		expect(fake.renames).toHaveLength(1);
		expect(fake.renames[0].to).toBe("qorpera-coding-machine-1111");
		expect(fake.instances.get("qorpera-coding-machine-1111")?.devices.network?.hwaddr).toBe("0e:51:0a:d2:01:02");
		expect(fake.instances.get("qorpera-coding-machine-1111")?.config["user.qorpera.machine_id"]).toBe(
			"11111111-1111-4111-8111-111111111111",
		);

		await pool.waitIdle();
		expect(pool.readyCount(BASE_FP)).toBe(2);

		await pool.close();
		expect(pool.readyCount()).toBe(0);
		expect(fake.instances.has("qorpera-coding-machine-1111")).toBe(true);
		expect(fake.instances.size).toBe(1);
	});

	it("keeps total standby VMs bounded by standbyPoolSize across multiple fingerprints and cleans invalidated fingerprints", async () => {
		const fake = makeStandbyLxd();
		const pool = new CodingStandbyPool({
			lxd: fake.client,
			vmPolicy: {
				project: "coding",
				imageFingerprint: BASE_FP,
				storagePool: "coding-disks",
				cpus: 4,
				memoryBytes: 8 * 1024 ** 3,
				rootDiskBytes: 64 * 1024 ** 3,
			},
			standbyPoolSize: 2,
		});

		pool.setActiveFingerprints([BASE_FP, SNAP_FP]);
		await pool.waitIdle();
		expect(pool.readyCount()).toBe(2);
		expect(pool.readyCount(BASE_FP)).toBe(1);
		expect(pool.readyCount(SNAP_FP)).toBe(1);

		await pool.invalidateFingerprint(SNAP_FP);
		await pool.waitIdle();
		expect(pool.readyCount(SNAP_FP)).toBe(0);
		expect(pool.readyCount(BASE_FP)).toBe(2);
		await pool.close();
	});

	it("destroys a renamed standby VM if updateInstanceConfig fails and sweeps orphan standby VMs", async () => {
		const fake = makeStandbyLxd({ failUpdateConfig: true });
		fake.instances.set(`${CODING_STANDBY_VM_PREFIX}deadbeef0000000000000000`, {
			name: `${CODING_STANDBY_VM_PREFIX}deadbeef0000000000000000`,
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
				project: "coding",
				imageFingerprint: BASE_FP,
				storagePool: "coding-disks",
				cpus: 4,
				memoryBytes: 8 * 1024 ** 3,
				rootDiskBytes: 64 * 1024 ** 3,
			},
			standbyPoolSize: 1,
		});

		const orphans = await pool.sweepOrphans(AbortSignal.timeout(5_000));
		expect(orphans).toEqual([`${CODING_STANDBY_VM_PREFIX}deadbeef0000000000000000`]);

		pool.start();
		await pool.waitIdle();
		await expect(
			pool.claim(memberRequest("qorpera-coding-machine-2222"), AbortSignal.timeout(5_000)),
		).rejects.toThrow("LXD_CONFIG_UPDATE_FAILED");
		expect(fake.instances.has("qorpera-coding-machine-2222")).toBe(false);
		expect(fake.deleted).toContain("qorpera-coding-machine-2222");
		await pool.close();
	});

	it("backs off cleanly instead of looping when an image is absent from LXD", async () => {
		const fake = makeStandbyLxd({ missingImages: new Set([BASE_FP]) });
		const events: Record<string, unknown>[] = [];
		const pool = new CodingStandbyPool({
			lxd: fake.client,
			vmPolicy: {
				project: "coding",
				imageFingerprint: BASE_FP,
				storagePool: "coding-disks",
				cpus: 4,
				memoryBytes: 8 * 1024 ** 3,
				rootDiskBytes: 64 * 1024 ** 3,
			},
			standbyPoolSize: 1,
			replenishBackoffMs: 60_000,
			report: (e) => events.push(e),
		});

		pool.start();
		await pool.waitIdle();
		expect(pool.readyCount()).toBe(0);
		expect(events.some((e) => e.event === "coding-standby-provision-failed")).toBe(true);
		await pool.close();
	});
});
