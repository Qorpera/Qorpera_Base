import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { codeHostProject, codeHostRequest } from "../src/code-host.ts";
import { executionHostIdentityDevice } from "../src/execution-host-identity.ts";
import type { LxdHostInventory, LxdHostInventoryInstance } from "../src/lxd-client.ts";
import { NodeHealthRefusal } from "../src/runtime-node-health-record.ts";
import {
	parseRuntimeNodeInventoryPolicy,
	type RuntimeNodeInventoryContext,
	type RuntimeNodeInventoryPolicy,
	reconcileRuntimeNodeInventory,
	runtimeNodeInstanceConfiguration,
	runtimeNodeInstanceConfigurationSha256,
	runtimeNodeReserved,
} from "../src/runtime-node-inventory.ts";
import {
	RuntimeNodeInventoryObserver,
	RuntimeNodeObserverFailure,
	type RuntimeNodeObserverHost,
	type RuntimeNodeObserverRegistry,
	runtimeNodeObserverFailureReason,
} from "../src/runtime-node-observer.ts";

const sha = "a".repeat(64),
	signal = () => new AbortController().signal;
type TestInstance = Omit<LxdHostInventoryInstance, "config" | "expandedConfig" | "devices" | "expandedDevices"> & {
	config: Record<string, string>;
	expandedConfig: Record<string, string>;
	devices: Record<string, Record<string, string>>;
	expandedDevices: Record<string, Record<string, string>>;
};
function fixture() {
	const policy: RuntimeNodeInventoryPolicy = {
		schema: "qorpera.runtime-node-inventory-policy/v1",
		nodeId: randomUUID(),
		host: {
			machineIdSha256: sha,
			socketPath: "/var/snap/lxd/common/lxd/unix.socket",
			socketGid: 2000,
			certificateSha256: sha,
			serverName: "node",
			serverVersion: "6.9",
			architecture: "x86_64",
		},
		operatingCpuMillis: 1000,
		operatingMemoryBytes: 1024 ** 3,
		infrastructure: [],
	};
	const context: RuntimeNodeInventoryContext = {
		policy,
		nodeVersion: 1,
		contextSha256: sha,
		headroomCpuMillis: 4000,
		headroomMemoryBytes: 8 * 1024 ** 3,
		allocations: ["native", "office", "login", "coding"].map((kind) => ({
			allocationId: randomUUID(),
			providerKind: kind as "native" | "office" | "login" | "coding",
			providerId: kind === "office" ? randomUUID() : kind,
			policySha256: sha,
			instanceSha256: "b".repeat(64),
			physical: null,
			cpuMillis: 2000,
			memoryBytes: 4 * 1024 ** 3,
		})),
	};
	const instances: TestInstance[] = context.allocations.map((a) => {
		const config = {
			"limits.cpu": "2",
			"limits.memory": a.providerKind === "office" ? String(4 * 1024 ** 3) : "4GiB",
			"volatile.uuid": randomUUID(),
			"user.qorpera.schema":
				a.providerKind === "office"
					? "qorpera.lxd-office-guest/v2"
					: a.providerKind === "native"
						? "qorpera.native-job-vm/v1"
						: a.providerKind === "coding"
							? "qorpera.lxd-coding-vm/v2"
							: "qorpera.native-login-vm/v2",
			[`user.qorpera.${a.providerKind === "native" ? "acquisition_id" : "allocation_id"}`]: a.allocationId,
			[`user.qorpera.${a.providerKind === "office" || a.providerKind === "coding" ? "provider_id" : "provider_adapter"}`]:
				a.providerId,
			"user.qorpera.provider_policy_sha256": a.policySha256,
			"user.qorpera.instance_sha256": a.instanceSha256,
		};
		return {
			name: "computer",
			project: a.providerKind,
			location: "none",
			type: "virtual-machine",
			config,
			expandedConfig: { ...config },
			devices: {},
			expandedDevices: {},
			profiles: [],
			status: "Running",
			statusCode: 103,
		};
	});
	const inventory: { server: LxdHostInventory["server"]; instances: TestInstance[] } = {
		server: {
			project: "default",
			certificateSha256: sha,
			serverName: "node",
			serverVersion: "6.9",
			architecture: "x86_64",
		},
		instances,
	};
	const host: RuntimeNodeObserverHost = {
		machineIdSha256: sha,
		cpuMillis: 16000,
		memoryBytes: 64 * 1024 ** 3,
		bootId: randomUUID(),
		namespace: "mnt:[1]",
		socket: { dev: 1, ino: 2, uid: 0, gid: 2000, mode: 0o140660, nlink: 1 },
	};
	return { policy, context, inventory, host };
}
/** An own key named like this, as JSON.parse makes one. A plain assignment of
 * `__proto__` would set the object's prototype instead. */
function ownKey<T>(target: Record<string, T>, key: string, value: T) {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
describe("complete host inventory reconciliation", () => {
	it.each(["uuid", "project", "name", "configuration"])("blocks replacement of an observed physical %s", (fault) => {
		const f = fixture(),
			i = f.inventory.instances[0];
		f.context.allocations[0].physical = {
			project: i.project,
			name: i.name,
			physicalId: i.config["volatile.uuid"],
			configurationSha256: runtimeNodeInstanceConfigurationSha256(i),
		};
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		if (fault === "uuid") i.config["volatile.uuid"] = i.expandedConfig["volatile.uuid"] = randomUUID();
		if (fault === "project") i.project = "different";
		if (fault === "name") i.name = "different";
		if (fault === "configuration") i.expandedDevices.extra = { type: "disk", source: "/changed" };
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it("matches a company machine at the size it reserved; nothing may be added to it later", () => {
		const f = fixture(),
			i = f.inventory.instances[3],
			a = f.context.allocations[3];
		a.providerKind = "machine";
		a.providerId = "machine-node";
		a.cpuMillis = 8000;
		a.memoryBytes = 32 * 1024 ** 3;
		for (const config of [i.config, i.expandedConfig]) {
			config["user.qorpera.schema"] = "qorpera.lxd-company-machine/v2";
			config["user.qorpera.provider_id"] = "machine-node";
			config["limits.cpu"] = "8";
			config["limits.memory"] = String(32 * 1024 ** 3);
		}
		a.physical = {
			project: i.project,
			name: i.name,
			physicalId: i.config["volatile.uuid"],
			configurationSha256: runtimeNodeInstanceConfigurationSha256(i),
		};
		const ready = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(ready.state).toBe("ready");
		expect(ready.entries[3].allocation?.providerKind).toBe("machine");
		// A v1 machine (6e-1 retired them all) is no machine of this node's: it shows by name as unregistered.
		for (const config of [i.config, i.expandedConfig])
			config["user.qorpera.schema"] = "qorpera.lxd-company-machine/v1";
		a.physical.configurationSha256 = runtimeNodeInstanceConfigurationSha256(i);
		const left = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(left.state).toBe("unavailable");
		expect(left.entries[3]).toMatchObject({
			project: i.project,
			name: i.name,
			category: "unmanaged",
			reason: "UNREGISTERED_INSTANCE",
		});
		for (const config of [i.config, i.expandedConfig])
			config["user.qorpera.schema"] = "qorpera.lxd-company-machine/v2";
		a.physical.configurationSha256 = runtimeNodeInstanceConfigurationSha256(i);
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		// A machine is never a coding machine: a session folder is a change of its enrollment.
		const workerId = randomUUID();
		for (const devices of [i.devices, i.expandedDevices])
			devices[`data-${workerId.replaceAll("-", "")}`] = {
				type: "disk",
				source: `/srv/qorpera-coding/executor/workers/${randomUUID()}/${randomUUID()}/${workerId}/data`,
				path: `/workspace/${workerId}`,
				required: "true",
			};
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it("does not match a company machine whose limits differ from its reservation", () => {
		const f = fixture(),
			i = f.inventory.instances[3],
			a = f.context.allocations[3];
		a.providerKind = "machine";
		a.providerId = "machine-node";
		for (const config of [i.config, i.expandedConfig]) {
			config["user.qorpera.schema"] = "qorpera.lxd-company-machine/v2";
			config["user.qorpera.provider_id"] = "machine-node";
			config["limits.cpu"] = "4";
		}
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it("matches a member's coding machine, and its sessions' folders coming and going do not change its enrollment", () => {
		const f = fixture(),
			i = f.inventory.instances[3];
		i.config["user.qorpera.schema"] = i.expandedConfig["user.qorpera.schema"] = "qorpera.lxd-coding-machine/v1";
		f.context.allocations[3].physical = {
			project: i.project,
			name: i.name,
			physicalId: i.config["volatile.uuid"],
			configurationSha256: runtimeNodeInstanceConfigurationSha256(i),
		};
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		const workerId = randomUUID(),
			worker = workerId.replaceAll("-", ""),
			folder = `/srv/qorpera-coding/executor/workers/${randomUUID()}/${randomUUID()}/${workerId}`;
		for (const devices of [i.devices, i.expandedDevices]) {
			devices[`data-${worker}`] = {
				type: "disk",
				source: `${folder}/data`,
				path: `/workspace/${workerId}`,
				required: "true",
			};
			devices[`custody-${worker}`] = {
				type: "disk",
				source: `${folder}/guest-state`,
				path: `/var/lib/qorpera-coding/${workerId}`,
				required: "true",
			};
		}
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).entries[3].allocation?.providerKind).toBe("coding");
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		// A device under a session's name that is not exactly its folder is a change of enrollment.
		const changes: Record<string, string>[] = [
			{ type: "disk", source: "/", path: "/host", required: "true" },
			{ type: "disk", source: `${folder}/data`, path: `/workspace/${workerId}` },
			{ type: "disk", source: `${folder}/../../../data`, path: `/workspace/${workerId}`, required: "true" },
			{
				type: "disk",
				source: `${folder}/data`,
				path: `/workspace/${workerId}`,
				required: "true",
				readonly: "false",
			},
		];
		for (const changed of changes) {
			const kept = i.devices[`data-${worker}`];
			i.devices[`data-${worker}`] = i.expandedDevices[`data-${worker}`] = changed;
			expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
			i.devices[`data-${worker}`] = i.expandedDevices[`data-${worker}`] = kept;
		}
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		// Any other device is still a change of enrollment, as for every machine.
		i.expandedDevices.extra = { type: "disk", source: "/changed" };
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
		// A per-session VM keeps its devices in its enrollment.
		const g = fixture(),
			legacy = g.inventory.instances[3];
		const before = runtimeNodeInstanceConfigurationSha256(legacy);
		legacy.devices[`data-${worker}`] = { type: "disk", source: "/srv/coding/data", path: "/workspace/x" };
		expect(runtimeNodeInstanceConfigurationSha256(legacy)).not.toBe(before);
	});
	// The LXD client refuses such a device (lxd-host-inventory.test.ts). Should a
	// record still carry one as its own key, the digests count it like any other.
	it.each([0, 3])("counts a host-path disk named __proto__ in a machine's digest (instance %s)", (index) => {
		const f = fixture(),
			i = f.inventory.instances[index];
		if (index === 3)
			i.config["user.qorpera.schema"] = i.expandedConfig["user.qorpera.schema"] = "qorpera.lxd-coding-machine/v1";
		f.context.allocations[index].physical = {
			project: i.project,
			name: i.name,
			physicalId: i.config["volatile.uuid"],
			configurationSha256: runtimeNodeInstanceConfigurationSha256(i),
		};
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		for (const devices of [i.devices, i.expandedDevices])
			ownKey(devices, "__proto__", { type: "disk", source: "/", path: "/host", required: "true" });
		expect(Object.keys(i.expandedDevices)).toEqual(["__proto__"]);
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[index].reason).toBe("INSTANCE_AUTHORITY_DIFFERS");
		expect(result.state).toBe("unavailable");
	});
	it("matches all three physical provider types with exact ledger costs across projects", () => {
		const f = fixture(),
			result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("ready");
		expect(result.entries.map((i) => i.allocation?.providerKind)).toEqual(["native", "office", "login", "coding"]);
	});
	it.each(["Stopped", "Frozen", "Starting", "Stopping", "Error"])(
		"retains %s computers and their charge",
		(status) => {
			const f = fixture();
			f.inventory.instances[0].status = status;
			f.inventory.instances[0].statusCode = { Stopped: 102, Frozen: 110, Starting: 106, Stopping: 107, Error: 112 }[
				status
			]!;
			const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
			expect(result.state).toBe("ready");
			expect(result.entries[0].allocation).toEqual(f.context.allocations[0]);
			expect(result.entries[0].state).not.toBe("running");
		},
	);
	it("does not release reservations when an allocated VM is absent", () => {
		const f = fixture();
		f.inventory.instances = [];
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context)).toEqual({
			state: "ready",
			entries: [],
			headroomValid: true,
		});
		expect(f.context.allocations).toHaveLength(4);
	});
	it.each([
		"legacy",
		"unmanaged-container",
		"wrong-policy",
		"wrong-instance",
		"wrong-provider",
		"wrong-allocation",
		"expanded-tag",
		"expanded-cpu",
		"expanded-memory",
		"unlimited",
		"pinned",
		"missing-uuid",
		"unknown-state",
	])("blocks unaccounted or altered instance: %s", (fault) => {
		const f = fixture(),
			i = f.inventory.instances[0];
		if (fault === "legacy") delete i.config["user.qorpera.schema"];
		if (fault === "unmanaged-container") i.type = "container";
		for (const [test, key] of [
			["wrong-policy", "provider_policy_sha256"],
			["wrong-instance", "instance_sha256"],
			["wrong-provider", "provider_adapter"],
			["wrong-allocation", "acquisition_id"],
		])
			if (fault === test) i.config[`user.qorpera.${key}`] = i.expandedConfig[`user.qorpera.${key}`] = "changed";
		if (fault === "expanded-tag") i.expandedConfig["user.qorpera.instance_sha256"] = "c".repeat(64);
		if (fault === "expanded-cpu") i.expandedConfig["limits.cpu"] = "8";
		if (fault === "expanded-memory") i.expandedConfig["limits.memory"] = "8GiB";
		if (fault === "unlimited") delete i.expandedConfig["limits.memory"];
		if (fault === "pinned") i.config["limits.cpu"] = i.expandedConfig["limits.cpu"] = "0-7";
		if (fault === "missing-uuid") delete i.config["volatile.uuid"];
		if (fault === "unknown-state") i.status = "Unknown";
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it.each(["physical", "allocation", "name"])("refuses duplicate %s identity", (fault) => {
		const f = fixture(),
			i = structuredClone(f.inventory.instances[0]);
		if (fault !== "name") i.name = "second";
		if (fault === "allocation") i.config["volatile.uuid"] = i.expandedConfig["volatile.uuid"] = randomUUID();
		f.inventory.instances.push(i);
		expect(() => reconcileRuntimeNodeInventory(f.inventory, f.context)).toThrow("DUPLICATE");
	});
	it("enrolls infrastructure by exact physical identity/configuration and charges it inside headroom", () => {
		const f = fixture(),
			i = structuredClone(f.inventory.instances[0]);
		i.name = "management";
		i.project = "default";
		i.config = {
			"limits.cpu": "2",
			"limits.memory": "4GiB",
			"volatile.uuid": randomUUID(),
			"cloud-init.user-data": "PRIVATE_BYTES",
			"user.qorpera.management_vm": "fixture-management-marker",
		};
		i.expandedConfig = { ...i.config };
		f.inventory.instances.push(i);
		f.policy.infrastructure.push({
			project: i.project,
			name: i.name,
			type: "virtual-machine",
			physicalId: i.config["volatile.uuid"],
			cpuMillis: 2000,
			memoryBytes: 4 * 1024 ** 3,
			configurationSha256: runtimeNodeInstanceConfigurationSha256(i),
		});
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("ready");
		expect(result.entries[4].category).toBe("infrastructure");
		expect(JSON.stringify(result)).not.toContain("PRIVATE_BYTES");
		f.context.headroomCpuMillis = 2000;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
		f.context.headroomCpuMillis = 4000;
		i.expandedConfig["cloud-init.user-data"] = "changed";
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it.each([null, [], { extra: true }, "bad"])("refuses invalid policy %#", (value) =>
		expect(() => parseRuntimeNodeInventoryPolicy(value)).toThrow(),
	);
	it("refuses scalar coercion, duplicate infrastructure and a substituted daemon", () => {
		const f = fixture();
		expect(() => parseRuntimeNodeInventoryPolicy({ ...f.policy, operatingCpuMillis: [1000] })).toThrow();
		f.inventory.server.serverName = "other";
		expect(() => reconcileRuntimeNodeInventory(f.inventory, f.context)).toThrow("HOST_DIFFERS");
	});
});

describe("shared execution host identity devices (2026-09-27)", () => {
	const volumes = { pool: "qorpera-vm", sourcePrefix: "phql-a1-identity-" };
	/** Node 2's exec host as LXD reports it: a VM on a profile, its root and nic, no user.qorpera.* tag. */
	function execHost(declared = true) {
		const f = fixture();
		const config = {
			"limits.cpu": "4",
			"limits.memory": "8GiB",
			"boot.mode": "uefi-secureboot",
			"image.os": "Ubuntu",
			"volatile.uuid": randomUUID(),
			"volatile.base_image": "c".repeat(64),
		};
		const i: TestInstance = {
			name: "qorpera-exec-node02",
			project: "qn25b2",
			location: "none",
			type: "virtual-machine",
			config,
			expandedConfig: { ...config, "security.secureboot": "true" },
			devices: {
				root: { type: "disk", path: "/", pool: "qorpera-vm", size: "80GiB" },
				eth0: { type: "nic", network: "qorpera0", name: "eth0", "security.port_isolation": "true" },
			},
			expandedDevices: {},
			profiles: ["native25-job-a1"],
			status: "Running",
			statusCode: 103,
		};
		i.expandedDevices = structuredClone(i.devices);
		f.inventory.instances.push(i);
		f.policy.infrastructure.push({
			project: i.project,
			name: i.name,
			type: "virtual-machine",
			physicalId: config["volatile.uuid"],
			cpuMillis: 4000,
			memoryBytes: 8 * 1024 ** 3,
			configurationSha256: runtimeNodeInstanceConfigurationSha256(i, declared ? volumes : undefined),
			...(declared ? { identityVolumes: volumes } : {}),
		});
		f.context.headroomCpuMillis = 8000;
		f.context.headroomMemoryBytes = 16 * 1024 ** 3;
		if (declared) f.context.acceptedIdentities = [];
		/** The login gateway's attach, after this node reserved the identity's login machine. */
		const attach = (id: string, device = executionHostIdentityDevice(volumes, id).device) => {
			i.devices[`identity-${id}`] = { ...device };
			i.expandedDevices[`identity-${id}`] = { ...device };
			f.context.acceptedIdentities?.push(id);
		};
		return { ...f, i, attach };
	}
	it("keeps the node ready while the login gateway attaches identities, and reports them sorted", () => {
		const f = execHost(),
			before = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(before.state).toBe("ready");
		expect(before.entries[4]).toMatchObject({ category: "infrastructure", reason: null, identities: [] });
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		for (const id of ids) f.attach(id);
		const after = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(after.state).toBe("ready");
		expect(after.entries[4].configurationSha256).toBe(before.entries[4].configurationSha256);
		expect(after.entries[4].identities).toEqual([...ids].sort());
		// Only the declared entry reports identities; every other entry keeps its shape.
		expect(after.entries.slice(0, 4).every((e) => !Object.hasOwn(e, "identities"))).toBe(true);
	});
	it("an attached identity this node never reserved a login machine for makes the node unavailable, named in its receipt", () => {
		const f = execHost(),
			[kept, foreign] = [randomUUID(), randomUUID()];
		f.attach(kept);
		f.attach(foreign);
		f.context.acceptedIdentities = [kept];
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("unavailable");
		expect(result.entries[4]).toMatchObject({
			reason: "INSTANCE_AUTHORITY_DIFFERS",
			identities: [kept, foreign].sort(),
		});
		// A context without the accepted set accepts nothing.
		delete f.context.acceptedIdentities;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
		for (const accepted of [["../x"], [kept.toUpperCase()], [1], "all"]) {
			const context = {
				...structuredClone(f.context),
				acceptedIdentities: accepted,
			} as unknown as RuntimeNodeInventoryContext;
			expect(() => reconcileRuntimeNodeInventory(f.inventory, context)).toThrow("INVALID_NODE_INVENTORY_CONTEXT");
		}
	});
	it("without the declaration an attach is still a change of enrollment, as before", () => {
		const f = execHost(false);
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		expect(Object.hasOwn(reconcileRuntimeNodeInventory(f.inventory, f.context).entries[4], "identities")).toBe(false);
		f.attach(randomUUID());
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it.each([
		["a writable-flag", (id: string) => ({ ...executionHostIdentityDevice(volumes, id).device, readonly: "false" })],
		["another pool", (id: string) => ({ ...executionHostIdentityDevice(volumes, id).device, pool: "default" })],
		["a host path", (id: string) => ({ ...executionHostIdentityDevice(volumes, id).device, source: "/var/lib/lxd" })],
		[
			"another identity's volume",
			(id: string) => ({
				...executionHostIdentityDevice(volumes, id).device,
				source: `phql-a1-identity-${randomUUID()}`,
			}),
		],
		["another mount point", (id: string) => ({ ...executionHostIdentityDevice(volumes, id).device, path: "/root" })],
	])("an identity-named device with %s is a change of enrollment", (_label, shape) => {
		const f = execHost(),
			id = randomUUID();
		f.attach(id, shape(id));
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("unavailable");
		expect(result.entries[4]).toMatchObject({ reason: "INSTANCE_AUTHORITY_DIFFERS", identities: [] });
	});
	it("a profile can neither add nor alter an identity device, and every other difference stays exact", () => {
		const f = execHost(),
			id = randomUUID();
		f.i.expandedDevices[`identity-${id}`] = executionHostIdentityDevice(volumes, id).device;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
		f.attach(id);
		f.i.expandedDevices[`identity-${id}`] = { ...f.i.expandedDevices[`identity-${id}`], readonly: "true" };
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
		f.attach(id);
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		for (const change of [
			(i: TestInstance) => {
				i.devices.data = { type: "disk", source: "/srv", path: "/srv" };
				i.expandedDevices.data = { ...i.devices.data };
			},
			(i: TestInstance) => {
				i.config["image.os"] = "Debian";
				i.expandedConfig["image.os"] = "Debian";
			},
			(i: TestInstance) => {
				i.expandedConfig["user.qorpera.schema"] = "qorpera.native-job-vm/v1";
			},
			(i: TestInstance) => {
				i.config["limits.cpu"] = "8";
				i.expandedConfig["limits.cpu"] = "8";
			},
		]) {
			const g = execHost();
			g.attach(randomUUID());
			change(g.i);
			expect(reconcileRuntimeNodeInventory(g.inventory, g.context).state).toBe("unavailable");
		}
	});
	it("a device named __proto__ is neither an identity nor left out of the digest", () => {
		const f = execHost();
		f.attach(randomUUID());
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		for (const devices of [f.i.devices, f.i.expandedDevices])
			ownKey(devices, "__proto__", { type: "disk", source: "/var/lib/lxd", path: "/host" });
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("unavailable");
		expect(result.entries[4]).toMatchObject({ reason: "INSTANCE_AUTHORITY_DIFFERS" });
	});
	it("declares identity volumes only for a virtual machine, with exactly pool and source prefix", () => {
		const f = execHost();
		expect(parseRuntimeNodeInventoryPolicy(structuredClone(f.policy))).toEqual(f.policy);
		for (const identityVolumes of [
			{ pool: "qorpera-vm" },
			{ ...volumes, path: "/var/lib/qorpera/identities" },
			{ pool: "qorpera-vm", sourcePrefix: "../" },
			"qorpera-vm",
		]) {
			const policy = structuredClone(f.policy) as unknown as { infrastructure: Record<string, unknown>[] };
			policy.infrastructure[0].identityVolumes = identityVolumes;
			expect(() => parseRuntimeNodeInventoryPolicy(policy)).toThrow("INVALID_NODE_INVENTORY_POLICY");
		}
		const container = structuredClone(f.policy);
		container.infrastructure[0].type = "container";
		expect(() => parseRuntimeNodeInventoryPolicy(container)).toThrow("INVALID_NODE_INVENTORY_POLICY");
	});
	it("the operators' Python digest (deploy/shared-execution/exec-host-inventory-digest.py) agrees", () => {
		const python = spawnSync("python3", ["--version"]);
		if (python.status !== 0) return;
		const f = execHost();
		f.attach(randomUUID());
		f.attach(randomUUID());
		f.i.devices.odd = f.i.expandedDevices.odd = { type: "disk", source: "/srv/ünïcode", path: "/mnt" };
		const lxdQuery = {
			name: f.i.name,
			project: f.i.project,
			type: f.i.type,
			profiles: f.i.profiles,
			config: f.i.config,
			expanded_config: f.i.expandedConfig,
			devices: f.i.devices,
			expanded_devices: f.i.expandedDevices,
		};
		const script = fileURLToPath(
			new URL("../../../deploy/shared-execution/exec-host-inventory-digest.py", import.meta.url),
		);
		for (const declared of [true, false]) {
			const run = spawnSync(
				"python3",
				[script, ...(declared ? ["--pool", volumes.pool, "--source-prefix", volumes.sourcePrefix] : [])],
				{ input: JSON.stringify(lxdQuery), encoding: "utf-8" },
			);
			expect(run.status, run.stderr).toBe(0);
			const expected = runtimeNodeInstanceConfiguration(f.i, declared ? volumes : undefined);
			expect(JSON.parse(run.stdout)).toEqual({
				configurationSha256: expected.configurationSha256,
				identities: expected.identities ?? [],
			});
		}
	});
	describe("listed by role (identical nodes, change 6)", () => {
		const [current, next] = ["c".repeat(64), "d".repeat(64)];
		/** The same host enrolled as `role: execution-host`, and the images the node's releases pin. */
		function byRole(declared = false) {
			const f = execHost(declared);
			f.policy.infrastructure[0].role = "execution-host";
			f.policy.infrastructure[0].configurationSha256 = runtimeNodeInstanceConfigurationSha256(
				f.i,
				declared ? volumes : undefined,
				"execution-host",
			);
			/** `lxc rebuild` onto another image: only image.* and volatile.base_image change. */
			const rebuild = (image: string) => {
				for (const config of [f.i.config, f.i.expandedConfig]) {
					config["image.os"] = `Ubuntu ${image.slice(0, 4)}`;
					config["image.serial"] = image.slice(0, 8);
					config["volatile.base_image"] = image;
				}
			};
			return { ...f, rebuild, released: new Set([current, next]) };
		}
		it("a rebuild onto an image a signed release pins keeps the digest and the node ready", () => {
			const f = byRole(),
				before = reconcileRuntimeNodeInventory(f.inventory, f.context, f.released);
			expect(before.state).toBe("ready");
			expect(before.entries[4]).toMatchObject({ category: "infrastructure", reason: null });
			expect(Object.hasOwn(before.entries[4], "role")).toBe(false);
			f.rebuild(next);
			const after = reconcileRuntimeNodeInventory(f.inventory, f.context, f.released);
			expect(after.state).toBe("ready");
			expect(after.entries[4].configurationSha256).toBe(before.entries[4].configurationSha256);
		});
		it("an image no signed release pins makes the node unavailable, with its own reason", () => {
			const f = byRole();
			f.rebuild("e".repeat(64));
			const result = reconcileRuntimeNodeInventory(f.inventory, f.context, f.released);
			expect(result.state).toBe("unavailable");
			expect(result.entries[4]).toMatchObject({ reason: "INSTANCE_IMAGE_NOT_RELEASED" });
			// No releases read (the default) accepts no image.
			const g = byRole();
			expect(reconcileRuntimeNodeInventory(g.inventory, g.context).entries[4].reason).toBe(
				"INSTANCE_IMAGE_NOT_RELEASED",
			);
			// A profile cannot claim another base image, and a missing one is not released.
			const h = byRole();
			h.i.expandedConfig["volatile.base_image"] = next;
			expect(reconcileRuntimeNodeInventory(h.inventory, h.context, h.released).entries[4].reason).toBe(
				"INSTANCE_IMAGE_NOT_RELEASED",
			);
			const k = byRole();
			delete k.i.config["volatile.base_image"];
			delete k.i.expandedConfig["volatile.base_image"];
			expect(reconcileRuntimeNodeInventory(k.inventory, k.context, k.released).entries[4].reason).toBe(
				"INSTANCE_IMAGE_NOT_RELEASED",
			);
		});
		it("everything but the image stays exact", () => {
			for (const change of [
				(i: TestInstance) => {
					i.config["limits.cpu"] = "8";
					i.expandedConfig["limits.cpu"] = "8";
				},
				(i: TestInstance) => {
					i.devices.data = { type: "disk", source: "/srv", path: "/srv" };
					i.expandedDevices.data = { ...i.devices.data };
				},
				(i: TestInstance) => {
					i.profiles = ["default"];
				},
				(i: TestInstance) => {
					i.config["security.secureboot"] = "false";
					i.expandedConfig["security.secureboot"] = "false";
				},
				(i: TestInstance) => {
					i.config["user.qorpera.schema"] = "qorpera.native-job-vm/v1";
					i.expandedConfig["user.qorpera.schema"] = "qorpera.native-job-vm/v1";
				},
			]) {
				const f = byRole();
				change(f.i);
				const result = reconcileRuntimeNodeInventory(f.inventory, f.context, f.released);
				expect(result.state).toBe("unavailable");
				expect(result.entries[4].reason).toBe("INSTANCE_AUTHORITY_DIFFERS");
			}
			// A different physical machine under the same name is not the enrolled host.
			const f = byRole();
			f.i.config["volatile.uuid"] = f.i.expandedConfig["volatile.uuid"] = randomUUID();
			expect(reconcileRuntimeNodeInventory(f.inventory, f.context, f.released).entries[4].reason).toBe(
				"INSTANCE_AUTHORITY_DIFFERS",
			);
			// Without the role, the image keys still count exactly, as before.
			const g = execHost(false);
			for (const config of [g.i.config, g.i.expandedConfig]) config["image.os"] = "Debian";
			expect(reconcileRuntimeNodeInventory(g.inventory, g.context, new Set([current])).state).toBe("unavailable");
		});
		it("combines with identity volumes: attaches and a rebuild both keep it ready", () => {
			const f = byRole(true);
			f.attach(randomUUID());
			f.rebuild(next);
			const result = reconcileRuntimeNodeInventory(f.inventory, f.context, f.released);
			expect(result.state).toBe("ready");
			expect(result.entries[4].identities).toHaveLength(1);
		});
		it("the role is only execution-host, only on a virtual machine", () => {
			const f = byRole(true);
			expect(parseRuntimeNodeInventoryPolicy(structuredClone(f.policy))).toEqual(f.policy);
			for (const role of ["office", "", null, ["execution-host"]]) {
				const policy = structuredClone(f.policy) as unknown as { infrastructure: Record<string, unknown>[] };
				policy.infrastructure[0].role = role;
				expect(() => parseRuntimeNodeInventoryPolicy(policy)).toThrow("INVALID_NODE_INVENTORY_POLICY");
			}
			const container = structuredClone(byRole().policy);
			container.infrastructure[0].type = "container";
			expect(() => parseRuntimeNodeInventoryPolicy(container)).toThrow("INVALID_NODE_INVENTORY_POLICY");
		});
		it("the operators' Python digest agrees with --role", () => {
			const python = spawnSync("python3", ["--version"]);
			if (python.status !== 0) return;
			const f = byRole(true);
			f.attach(randomUUID());
			const lxdQuery = {
				name: f.i.name,
				project: f.i.project,
				type: f.i.type,
				profiles: f.i.profiles,
				config: f.i.config,
				expanded_config: f.i.expandedConfig,
				devices: f.i.devices,
				expanded_devices: f.i.expandedDevices,
			};
			const script = fileURLToPath(
				new URL("../../../deploy/shared-execution/exec-host-inventory-digest.py", import.meta.url),
			);
			for (const [declared, role] of [
				[true, true],
				[false, true],
				[true, false],
			]) {
				const run = spawnSync(
					"python3",
					[
						script,
						...(declared ? ["--pool", volumes.pool, "--source-prefix", volumes.sourcePrefix] : []),
						...(role ? ["--role", "execution-host"] : []),
					],
					{ input: JSON.stringify(lxdQuery), encoding: "utf-8" },
				);
				expect(run.status, run.stderr).toBe(0);
				const expected = runtimeNodeInstanceConfiguration(
					f.i,
					declared ? volumes : undefined,
					role ? "execution-host" : undefined,
				);
				expect(JSON.parse(run.stdout).configurationSha256).toBe(expected.configurationSha256);
			}
			expect(spawnSync("python3", [script, "--role", "office"], { input: "{}" }).status).not.toBe(0);
		});
		it("the observer reads the node's releases only when an entry is listed by role", async () => {
			const run = async (f: ReturnType<typeof byRole>) => {
				const registry: RuntimeNodeObserverRegistry = {
					call: vi.fn(async (method, args) => {
						if (method === "qorpera_runtime_node_inventory_context") return structuredClone(f.context);
						const o = args.p_observation as Record<string, unknown>;
						return { nodeId: o.nodeId, observationId: o.observationId, observedAt: o.observedAt };
					}),
				};
				const releases = vi.fn(async () => new Set([next]));
				const observer = new RuntimeNodeInventoryObserver(f.policy, registry, {
					host: vi.fn(async () => structuredClone(f.host)),
					lxd: { inspectHostInventory: vi.fn(async () => structuredClone(f.inventory)) },
					releases,
					healthRecord: async () => {},
				});
				return { state: (await observer.observe(signal())).state, releases };
			};
			const f = byRole();
			f.rebuild(next);
			expect(await run(f)).toMatchObject({ state: "ready" });
			expect((await run(f)).releases).toHaveBeenCalledTimes(1);
			const g = byRole();
			g.rebuild(current);
			expect((await run(g)).state).toBe("unavailable");
			const h = byRole();
			delete h.policy.infrastructure[0].role;
			h.policy.infrastructure[0].configurationSha256 = runtimeNodeInstanceConfigurationSha256(h.i);
			const plain = await run(h);
			expect(plain.state).toBe("ready");
			expect(plain.releases).not.toHaveBeenCalled();
		});
	});
});

describe("image build space (identical nodes, 2026-09-28)", () => {
	const space = { project: "qorpera-build", network: "qorpera0", cpuMillis: 2000, memoryBytes: 4 * 1024 ** 3 };
	function builder(name: string, cpu = "1", memory = "2GiB"): TestInstance {
		const config = {
			"limits.cpu": cpu,
			"limits.memory": memory,
			"volatile.uuid": randomUUID(),
			"boot.autostart": "false",
			"user.qorpera.image_builder": "true",
			"user.qorpera.purpose": "runtime-image",
		};
		const devices = { root: { type: "disk", path: "/", pool: "qorpera-vm", size: "80GiB" } };
		return {
			name,
			project: space.project,
			location: "none",
			type: "virtual-machine",
			config,
			expandedConfig: { ...config },
			devices,
			expandedDevices: {
				...devices,
				eth0: {
					type: "nic",
					network: "qorpera0",
					name: "eth0",
					"security.mac_filtering": "true",
					"security.ipv4_filtering": "true",
					"security.ipv6_filtering": "true",
					"security.port_isolation": "true",
				},
			},
			profiles: ["default"],
			status: "Running",
			statusCode: 103,
		};
	}
	function withSpace() {
		const f = fixture();
		f.context.policy = f.policy = { ...f.policy, buildSpace: { ...space } };
		return f;
	}
	it("accepts a builder and its verifier inside the declared space and keeps the node ready", () => {
		const f = withSpace();
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		f.inventory.instances.push(builder("image-build"), builder("image-verify"));
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("ready");
		expect(result.entries.slice(4).map((e) => [e.category, e.reason, e.cpuMillis, e.allocation])).toEqual([
			["build", null, 1000, null],
			["build", null, 1000, null],
		]);
		// Stopped build machines keep their charge.
		f.inventory.instances[4].status = "Stopped";
		f.inventory.instances[4].statusCode = 102;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
	});
	it("accepts the image lane's exact builder: no profiles, its own root, the isolation NIC", () => {
		const f = withSpace(),
			config = {
				"limits.cpu": "4",
				"limits.memory": "8GiB",
				"boot.autostart": "false",
				"volatile.uuid": randomUUID(),
				"volatile.base_image": "e".repeat(64),
				"volatile.eth0.hwaddr": "00:16:3e:00:00:01",
				"image.os": "Ubuntu",
				"image.user.qorpera.source_commit": "f".repeat(40),
			},
			root = { type: "disk", path: "/", pool: "qorpera-vm", size: "80GiB" },
			nic = {
				type: "nic",
				network: "qorpera0",
				name: "eth0",
				"security.mac_filtering": "true",
				"security.ipv4_filtering": "true",
				"security.ipv6_filtering": "true",
				"security.port_isolation": "true",
			};
		f.inventory.instances.push({
			name: "qorpera-native142-build-phql-a1",
			project: space.project,
			location: "none",
			type: "virtual-machine",
			config,
			expandedConfig: { ...config },
			devices: { root, eth0: nic },
			expandedDevices: { root, eth0: nic },
			profiles: [],
			status: "Stopped",
			statusCode: 102,
		});
		f.context.policy = f.policy = {
			...f.policy,
			buildSpace: { ...space, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
		};
		f.context.headroomCpuMillis = 5000;
		f.context.headroomMemoryBytes = 9 * 1024 ** 3;
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[4]).toMatchObject({ category: "build", reason: null });
		expect(result.state).toBe("ready");
	});
	it("refuses build machines beyond the declared space", () => {
		const f = withSpace();
		f.inventory.instances.push(builder("image-build", "2"), builder("image-verify"));
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("unavailable");
		expect(result.entries.slice(4).map((e) => e.reason)).toEqual(["BUILD_SPACE_EXCEEDED", "BUILD_SPACE_EXCEEDED"]);
		const g = withSpace();
		g.inventory.instances.push(builder("image-build", "1", "5GiB"));
		expect(reconcileRuntimeNodeInventory(g.inventory, g.context).entries[4].reason).toBe("BUILD_SPACE_EXCEEDED");
	});
	it.each<[string, number]>([
		["Stopped", 102],
		["Running", 103],
	])("accepts the company machine image's builder as LXD reported it, %s", (status, statusCode) => {
		// The record nested LXD 6.9 gave for build-machine-image.sh's builder (node 2's test machine, 2026-10-02):
		// one shape from creation to deletion, stopped and running.
		const f = withSpace(),
			config = {
				"boot.autostart": "false",
				"boot.mode": "uefi-secureboot",
				"image.architecture": "amd64",
				"image.description": "ubuntu 26.04 LTS (release)",
				"image.label": "release",
				"image.os": "ubuntu",
				"image.release": "resolute",
				"image.serial": "20260927",
				"image.type": "disk1.img",
				"image.version": "26.04",
				"limits.cpu": "4",
				"limits.memory": "8GiB",
				"user.qorpera.image_builder": "true",
				"user.qorpera.purpose": "machine-image",
				"volatile.base_image": "f".repeat(64),
				"volatile.cloud-init.instance-id": randomUUID(),
				"volatile.eth0.hwaddr": "00:16:3e:d7:87:78",
				"volatile.uuid": randomUUID(),
			},
			devices = {
				eth0: {
					name: "eth0",
					network: "qorpera0",
					"security.ipv4_filtering": "true",
					"security.ipv6_filtering": "true",
					"security.mac_filtering": "true",
					"security.port_isolation": "true",
					type: "nic",
				},
				root: { path: "/", pool: "qorpera-vm", size: "10GiB", type: "disk" },
			};
		f.inventory.instances.push({
			name: "qorpera-machine-build-20261001231057",
			project: space.project,
			location: "none",
			type: "virtual-machine",
			config,
			expandedConfig: { ...config },
			devices,
			expandedDevices: devices,
			profiles: [],
			status,
			statusCode,
		});
		f.context.policy = f.policy = {
			...f.policy,
			buildSpace: { ...space, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
		};
		f.context.headroomCpuMillis = 5000;
		f.context.headroomMemoryBytes = 9 * 1024 ** 3;
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[4]).toMatchObject({ category: "build", reason: null, cpuMillis: 4000 });
		expect(result.state).toBe("ready");
	});
	it.each<[string, (i: TestInstance) => void]>([
		[
			"a container",
			(i) => {
				i.type = "container";
			},
		],
		[
			"no CPU limit",
			(i) => {
				delete i.expandedConfig["limits.cpu"];
			},
		],
		[
			"a runtime marker",
			(i) => {
				i.expandedConfig["user.qorpera.schema"] = "qorpera.native-job-vm/v1";
			},
		],
		[
			"the management marker",
			(i) => {
				i.config["user.qorpera.management_vm"] = "true";
			},
		],
		[
			"a false builder marker",
			(i) => {
				i.expandedConfig["user.qorpera.image_builder"] = "false";
			},
		],
		[
			"raw hypervisor settings",
			(i) => {
				i.expandedConfig["raw.qemu"] = "-device vfio-pci";
			},
		],
		[
			"a host path",
			(i) => {
				i.expandedDevices.src = { type: "disk", source: "/srv/company", path: "/mnt" };
			},
		],
		[
			"an identity volume",
			(i) => {
				i.devices.id = { type: "disk", pool: "qorpera-vm", source: "phql-a1-identity-x", path: "/i" };
			},
		],
		[
			"a second root",
			(i) => {
				i.expandedDevices.root = { type: "disk", path: "/", pool: "p", source: "/dev/sda" };
			},
		],
		[
			"a proxy",
			(i) => {
				i.expandedDevices.p = { type: "proxy", listen: "tcp:0.0.0.0:80", connect: "tcp:127.0.0.1:80" };
			},
		],
		[
			"a physical NIC",
			(i) => {
				i.expandedDevices.eth1 = { type: "nic", nictype: "physical", parent: "enp1s0" };
			},
		],
		[
			"a macvlan NIC",
			(i) => {
				i.expandedDevices.eth0 = { ...i.expandedDevices.eth0, nictype: "macvlan", parent: "nas-vlan" };
			},
		],
		[
			"an undeclared network",
			(i) => {
				i.expandedDevices.eth0 = { ...i.expandedDevices.eth0, network: "lxdbr0" };
			},
		],
		[
			"MAC filtering off",
			(i) => {
				i.expandedDevices.eth0 = { ...i.expandedDevices.eth0, "security.mac_filtering": "false" };
			},
		],
		[
			"port isolation off",
			(i) => {
				i.expandedDevices.eth0 = { ...i.expandedDevices.eth0, "security.port_isolation": "false" };
			},
		],
		[
			"a guest API setting",
			(i) => {
				i.expandedConfig["security.devlxd.management.volumes"] = "true";
			},
		],
		[
			"cloud-init user data",
			(i) => {
				i.config["cloud-init.user-data"] = "#cloud-config";
			},
		],
		[
			"stateful migration",
			(i) => {
				i.expandedConfig["migration.stateful"] = "true";
			},
		],
		[
			"autostart",
			(i) => {
				i.expandedConfig["boot.autostart"] = "true";
			},
		],
		[
			"raw settings in its own config only",
			(i) => {
				i.config["raw.qemu"] = "-device x";
			},
		],
		[
			"a root disk without a size",
			(i) => {
				i.expandedDevices.root = { type: "disk", path: "/", pool: "qorpera-vm" };
			},
		],
		[
			"no root disk",
			(i) => {
				delete i.expandedDevices.root;
			},
		],
		[
			"two root disks",
			(i) => {
				i.expandedDevices.root2 = { type: "disk", path: "/", pool: "qorpera-vm", size: "1GiB" };
			},
		],
		[
			"IPv4 filtering off",
			(i) => {
				i.expandedDevices.eth0 = { ...i.expandedDevices.eth0, "security.ipv4_filtering": "false" };
			},
		],
		[
			"IPv6 filtering off",
			(i) => {
				i.expandedDevices.eth0 = { ...i.expandedDevices.eth0, "security.ipv6_filtering": "false" };
			},
		],
		[
			"no port isolation",
			(i) => {
				const { "security.port_isolation": _isolation, ...nic } = i.expandedDevices.eth0;
				i.expandedDevices.eth0 = nic;
			},
		],
		[
			"an empty root size",
			(i) => {
				i.expandedDevices.root = { ...i.expandedDevices.root, size: "" };
			},
		],
		[
			"a GPU",
			(i) => {
				i.expandedDevices.g = { type: "gpu" };
			},
		],
		[
			"a host path disk named __proto__",
			(i) => {
				ownKey(i.expandedDevices, "__proto__", { type: "disk", source: "/", path: "/host" });
			},
		],
		[
			"a configuration key named __proto__",
			(i) => {
				ownKey(i.expandedConfig, "__proto__", "true");
			},
		],
	])("refuses a build machine with %s", (_, change) => {
		const f = withSpace(),
			i = builder("image-build");
		change(i);
		f.inventory.instances.push(i);
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[4]).toMatchObject({ category: "build", reason: "INSTANCE_AUTHORITY_DIFFERS" });
		expect(result.state).toBe("unavailable");
	});
	it("treats a runtime guest in the build project as a build machine, never as its allocation", () => {
		const f = withSpace();
		f.inventory.instances[0].project = space.project;
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[0]).toMatchObject({
			category: "build",
			allocation: null,
			reason: "INSTANCE_AUTHORITY_DIFFERS",
		});
		expect(result.state).toBe("unavailable");
	});
	it("keeps a builder outside the space unregistered, as before", () => {
		const f = withSpace(),
			i = builder("image-build");
		i.project = "qn25b2";
		f.inventory.instances.push(i);
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[4]).toMatchObject({ category: "unmanaged", reason: "UNREGISTERED_INSTANCE" });
		expect(result.state).toBe("unavailable");
		// And without a declared space nothing changes.
		const g = fixture();
		g.inventory.instances.push(builder("image-build"));
		expect(reconcileRuntimeNodeInventory(g.inventory, g.context).entries[4].category).toBe("unmanaged");
	});
	it("counts the space against headroom whether a build runs or not", () => {
		const f = withSpace();
		f.context.headroomCpuMillis = 2999;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context)).toMatchObject({
			headroomValid: false,
			state: "unavailable",
		});
		f.context.headroomCpuMillis = 3000;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context)).toMatchObject({
			headroomValid: true,
			state: "ready",
		});
	});
	it("parses the space strictly and never next to infrastructure in the same project", () => {
		const base = fixture().policy;
		expect(parseRuntimeNodeInventoryPolicy({ ...base, buildSpace: space }).buildSpace).toEqual(space);
		const { network: _network, ...withoutNetwork } = space;
		expect(parseRuntimeNodeInventoryPolicy(base)).not.toHaveProperty("buildSpace");
		for (const bad of [
			{ ...space, extra: 1 },
			withoutNetwork,
			{ ...space, network: "../net" },
			{ ...space, cpuMillis: 0 },
			{ ...space, project: "../x" },
			null,
		])
			expect(() => parseRuntimeNodeInventoryPolicy({ ...base, buildSpace: bad })).toThrow(
				/^INVALID_(NODE_INVENTORY_POLICY|OFFICE_PHYSICAL_RECORD)$/,
			);
		const infra = {
			project: space.project,
			name: "exec",
			physicalId: randomUUID(),
			type: "virtual-machine",
			configurationSha256: sha,
			cpuMillis: 1000,
			memoryBytes: 1024,
		};
		expect(() => parseRuntimeNodeInventoryPolicy({ ...base, infrastructure: [infra], buildSpace: space })).toThrow(
			"INVALID_NODE_INVENTORY_POLICY",
		);
	});
});

describe("code hosts (F3 step 5e)", () => {
	const hosts = {
		imageFingerprint: "c".repeat(64),
		storagePool: "qorpera-vm",
		cpus: 1,
		memoryBytes: 1024 ** 3,
		rootDiskBytes: 20 * 1024 ** 3,
		running: 2,
	};
	const company = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
	/** A code host exactly as the executor makes it, with what LXD adds. */
	function codeHost(companyId: string, statusCode = 103): TestInstance {
		const request = codeHostRequest(hosts, companyId),
			config = {
				...request.config,
				"volatile.uuid": randomUUID(),
				"volatile.base_image": hosts.imageFingerprint,
				"image.os": "Ubuntu",
			};
		return {
			name: "code-host",
			project: codeHostProject(companyId),
			location: "none",
			type: "virtual-machine",
			config,
			expandedConfig: { ...config },
			devices: structuredClone(request.devices) as TestInstance["devices"],
			expandedDevices: structuredClone(request.devices) as TestInstance["devices"],
			profiles: [],
			status: statusCode === 102 ? "Stopped" : statusCode === 110 ? "Frozen" : "Running",
			statusCode,
		};
	}
	function withHosts() {
		const f = fixture();
		f.context.policy = f.policy = { ...f.policy, codeHosts: { ...hosts } };
		return f;
	}
	it("accepts code hosts exactly as the executor makes them, at most `running` of them not stopped", () => {
		const f = withHosts();
		f.inventory.instances.push(codeHost(company(1)), codeHost(company(2)), codeHost(company(3), 102));
		let result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("ready");
		expect(result.entries.slice(4).map((e) => [e.category, e.reason, e.state, e.cpuMillis, e.allocation])).toEqual([
			["code-host", null, "running", 1000, null],
			["code-host", null, "running", 1000, null],
			["code-host", null, "suspended", 1000, null],
		]);
		f.inventory.instances[6].status = "Running";
		f.inventory.instances[6].statusCode = 103;
		result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("unavailable");
		expect(result.entries.slice(4).map((e) => e.reason)).toEqual(Array(3).fill("CODE_HOST_SPACE_EXCEEDED"));
	});
	it("never accepts a frozen code host, which would hold its memory outside the count", () => {
		const f = withHosts();
		f.inventory.instances.push(codeHost(company(1), 110));
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[4]).toMatchObject({ category: "code-host", reason: "INSTANCE_AUTHORITY_DIFFERS" });
		expect(result.state).toBe("unavailable");
	});
	const both = (i: TestInstance, key: string, value: string) => {
		i.config[key] = value;
		i.expandedConfig[key] = value;
	};
	it.each<[string, (i: TestInstance) => void]>([
		["another image", (i) => both(i, "volatile.base_image", "d".repeat(64))],
		["other limits", (i) => both(i, "limits.cpu", "2")],
		["/dev/lxd", (i) => both(i, "security.devlxd", "true")],
		["another company's marker", (i) => both(i, "user.qorpera.company_id", company(2))],
		["another user key", (i) => both(i, "user.qorpera.purpose", "x")],
		["a raw LXD key", (i) => both(i, "raw.qemu", "-S")],
		[
			"a NIC from a profile",
			(i) => {
				i.expandedDevices.eth0 = { type: "nic", network: "qorpera0", name: "eth0" };
			},
		],
		[
			"a profile",
			(i) => {
				i.profiles = ["default"];
			},
		],
		[
			"a host path",
			(i) => {
				i.devices.data = { type: "disk", path: "/data", source: "/srv" };
				i.expandedDevices.data = { ...i.devices.data };
			},
		],
		[
			"another name",
			(i) => {
				i.name = "code-host-2";
			},
		],
		[
			"a container",
			(i) => {
				i.type = "container";
			},
		],
		[
			"two physical ids",
			(i) => {
				i.expandedConfig["volatile.uuid"] = randomUUID();
			},
		],
	])("reports a VM in a code host project with %s as unregistered", (_, change) => {
		const f = withHosts(),
			i = codeHost(company(1));
		change(i);
		f.inventory.instances.push(i);
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[4]).toMatchObject({ category: "unmanaged", reason: "UNREGISTERED_INSTANCE" });
		expect(result.state).toBe("unavailable");
	});
	it("without the policy's codeHosts an exact code host is unregistered", () => {
		const f = fixture();
		f.inventory.instances.push(codeHost(company(1)));
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).entries[4]).toMatchObject({
			category: "unmanaged",
			reason: "UNREGISTERED_INSTANCE",
		});
	});
	it("never takes a guest in a code host project for its allocation", () => {
		const f = withHosts();
		f.inventory.instances[0].project = codeHostProject(company(1));
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.entries[0]).toMatchObject({
			category: "unmanaged",
			allocation: null,
			reason: "UNREGISTERED_INSTANCE",
		});
		expect(result.state).toBe("unavailable");
	});
	it("counts `running` code hosts against headroom whether any runs or not", () => {
		const f = withHosts();
		f.context.headroomCpuMillis = 2999;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context)).toMatchObject({
			headroomValid: false,
			state: "unavailable",
		});
		f.context.headroomCpuMillis = 3000;
		f.context.headroomMemoryBytes = 3 * 1024 ** 3 - 1;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).headroomValid).toBe(false);
		f.context.headroomMemoryBytes = 3 * 1024 ** 3;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context)).toMatchObject({
			headroomValid: true,
			state: "ready",
		});
		expect(runtimeNodeReserved(f.policy)).toEqual({ cpuMillis: 3000, memoryBytes: 3 * 1024 ** 3 });
	});
	it("parses the block strictly, and keeps infrastructure and the build space out of code host projects", () => {
		const base = fixture().policy;
		expect(parseRuntimeNodeInventoryPolicy({ ...base, codeHosts: hosts }).codeHosts).toEqual(hosts);
		expect(parseRuntimeNodeInventoryPolicy(base)).not.toHaveProperty("codeHosts");
		const { running: _running, ...withoutRunning } = hosts;
		for (const bad of [
			{ ...hosts, extra: 1 },
			withoutRunning,
			{ ...hosts, cpus: 0 },
			{ ...hosts, cpus: 1.5 },
			{ ...hosts, memoryBytes: 1024 ** 3 + 1 },
			{ ...hosts, rootDiskBytes: 9 * 1024 ** 3 },
			{ ...hosts, running: 65 },
			{ ...hosts, imageFingerprint: "C".repeat(64) },
			{ ...hosts, storagePool: "../pool" },
			"default",
			null,
		])
			expect(() => parseRuntimeNodeInventoryPolicy({ ...base, codeHosts: bad })).toThrow(
				"INVALID_NODE_INVENTORY_POLICY",
			);
		const project = codeHostProject(company(1)),
			infra = {
				project,
				name: "exec",
				physicalId: randomUUID(),
				type: "virtual-machine",
				configurationSha256: sha,
				cpuMillis: 1000,
				memoryBytes: 1024,
			};
		expect(() => parseRuntimeNodeInventoryPolicy({ ...base, codeHosts: hosts, infrastructure: [infra] })).toThrow(
			"INVALID_NODE_INVENTORY_POLICY",
		);
		const space = { project, network: "qorpera0", cpuMillis: 2000, memoryBytes: 4 * 1024 ** 3 };
		expect(() => parseRuntimeNodeInventoryPolicy({ ...base, buildSpace: space })).toThrow(
			"INVALID_NODE_INVENTORY_POLICY",
		);
	});
});

describe("trusted node inventory publisher composition", () => {
	function observer(change?: (method: string, args: Record<string, unknown>) => void) {
		const f = fixture();
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const registry: RuntimeNodeObserverRegistry = {
			call: vi.fn(async (method, args) => {
				calls.push({ method, args: structuredClone(args) });
				change?.(method, args);
				if (method === "qorpera_runtime_node_inventory_context") return structuredClone(f.context);
				const o = args.p_observation as Record<string, unknown>;
				return { nodeId: o.nodeId, observationId: o.observationId, observedAt: o.observedAt };
			}),
		};
		const ports = {
			host: vi.fn(async () => structuredClone(f.host)),
			lxd: { inspectHostInventory: vi.fn(async () => structuredClone(f.inventory)) },
			healthRecord: vi.fn(async (_bootId: string) => {}),
		};
		return { ...f, calls, registry, ports, observer: new RuntimeNodeInventoryObserver(f.policy, registry, ports) };
	}
	it("publishes a bounded receipt after complete inventory and matching physical readback", async () => {
		const f = observer();
		expect(await f.observer.observe(signal())).toMatchObject({ state: "ready", reason: null });
		expect(f.ports.host).toHaveBeenCalledTimes(2);
		expect(f.ports.healthRecord.mock.calls).toEqual([[f.host.bootId]]);
		expect(f.calls.map((c) => c.method)).toEqual([
			"qorpera_runtime_node_inventory_context",
			"qorpera_observe_runtime_node_inventory",
		]);
		expect(f.calls[1].args.p_inventory).toMatchObject({
			bootId: f.host.bootId,
			entries: Array(4).fill({ category: "managed" }),
		});
	});
	it.each(["socket", "boot", "hardware", "policy", "inventory"])(
		"publishes unavailable after failed %s evidence",
		async (fault) => {
			const f = observer();
			if (fault === "policy") {
				f.context.policy = structuredClone(f.policy);
				f.context.policy.host.serverName = "other";
			}
			if (fault === "inventory") f.ports.lxd.inspectHostInventory.mockRejectedValue(new Error("SECRET /etc/x"));
			if (["socket", "boot", "hardware"].includes(fault))
				f.ports.host.mockResolvedValueOnce(structuredClone(f.host)).mockImplementation(async () => {
					const h = structuredClone(f.host);
					if (fault === "socket") h.socket.ino++;
					if (fault === "boot") h.bootId = randomUUID();
					if (fault === "hardware") h.cpuMillis++;
					return h;
				});
			const look = await f.observer.observe(signal());
			expect(look.state).toBe("unavailable");
			expect(f.calls.at(-1)?.method).toBe("qorpera_observe_runtime_node");
			expect(JSON.stringify(f.calls)).not.toContain("SECRET");
			// The log line names the step that stopped the scan and its closed code; the error's text is not one.
			expect(look.reason).toEqual(
				fault === "policy"
					? { check: "policy", code: "NODE_OBSERVER_POLICY_DIFFERS" }
					: fault === "inventory"
						? { check: "inventory", code: "UNCODED" }
						: { check: "host-again", code: "NODE_OBSERVER_HOST_CHANGED" },
			);
		},
	);
	it("names the step and its code when the context cannot be read", async () => {
		const f = observer((method) => {
			if (method === "qorpera_runtime_node_inventory_context")
				throw new RuntimeNodeObserverFailure("NODE_OBSERVER_RPC_UNCONFIRMED", "NODE_OBSERVER_RPC_HTTP_401");
		});
		expect(await f.observer.observe(signal())).toMatchObject({
			state: "unavailable",
			reason: { check: "context", code: "NODE_OBSERVER_RPC_HTTP_401" },
		});
		expect(f.calls.at(-1)?.method).toBe("qorpera_observe_runtime_node");
	});
	it("names the kinds of entry that keep a host unavailable, or its headroom, never an instance", async () => {
		const f = observer();
		delete f.inventory.instances[0].config["user.qorpera.schema"];
		const unknown = await f.observer.observe(signal());
		expect(unknown.reason).toEqual({
			check: "reconcile",
			code: "NODE_INVENTORY_ENTRY_UNAVAILABLE",
			entries: ["unmanaged:UNREGISTERED_INSTANCE"],
		});
		expect(JSON.stringify(unknown.reason)).not.toContain("computer");
		const g = observer();
		g.context.headroomCpuMillis = runtimeNodeReserved(g.policy).cpuMillis - 1;
		expect(await g.observer.observe(signal())).toMatchObject({
			state: "unavailable",
			reason: { check: "reconcile", code: "NODE_INVENTORY_HEADROOM_EXCEEDED", entries: [] },
		});
	});
	it("takes no work while the node health record refuses, naming the failed local checks", async () => {
		const f = observer();
		f.ports.healthRecord.mockRejectedValue(new NodeHealthRefusal("NODE_HEALTH_NOT_OK", ["pool-write", "zpool"]));
		expect(await f.observer.observe(signal())).toMatchObject({
			state: "unavailable",
			reason: { check: "health-record", code: "NODE_HEALTH_NOT_OK", entries: ["pool-write", "zpool"] },
		});
		// No inventory is published: the host is not claimed ready or known.
		expect(f.calls.map((c) => c.method)).toEqual([
			"qorpera_runtime_node_inventory_context",
			"qorpera_observe_runtime_node",
		]);
		const g = observer();
		g.ports.healthRecord.mockRejectedValue(new NodeHealthRefusal("NODE_HEALTH_RECORD_STALE"));
		expect((await g.observer.observe(signal())).reason).toEqual({
			check: "health-record",
			code: "NODE_HEALTH_RECORD_STALE",
		});
	});
	it("publishes unknown machines without dropping them or claiming a ready host", async () => {
		const f = observer();
		delete f.inventory.instances[0].config["user.qorpera.schema"];
		expect((await f.observer.observe(signal())).state).toBe("unavailable");
		expect(f.calls.at(-1)?.args.p_inventory).toMatchObject({
			entries: [
				{ category: "unmanaged" },
				{ category: "managed" },
				{ category: "managed" },
				{ category: "managed" },
			],
		});
	});
	it("does not rebind an uncertain publication or retry it with new bytes", async () => {
		const f = observer((method) => {
			if (method === "qorpera_observe_runtime_node_inventory") throw new Error("PRIVATE RESPONSE");
		});
		await expect(f.observer.observe(signal())).rejects.toThrow(/^NODE_OBSERVER_UNCONFIRMED$/);
		expect(f.calls).toHaveLength(2);
	});
	it("names the publication or its receipt when the look itself is unconfirmed, keeping the one message", async () => {
		const failure = async (f: ReturnType<typeof observer>) => {
			const error = await f.observer.observe(signal()).then(
				() => null,
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(RuntimeNodeObserverFailure);
			expect((error as Error).message).toBe("NODE_OBSERVER_UNCONFIRMED");
			return runtimeNodeObserverFailureReason(error, "look");
		};
		expect(
			await failure(
				observer((method) => {
					if (method === "qorpera_observe_runtime_node_inventory")
						throw new RuntimeNodeObserverFailure("NODE_OBSERVER_RPC_UNCONFIRMED", "NODE_OBSERVER_RPC_TIMEOUT");
				}),
			),
		).toEqual({ check: "publish", code: "NODE_OBSERVER_RPC_TIMEOUT" });
		const wrong = observer();
		wrong.registry.call = vi.fn(async (method: string) =>
			method === "qorpera_runtime_node_inventory_context" ? structuredClone(wrong.context) : { nodeId: "private" },
		);
		expect(await failure(wrong)).toEqual({
			check: "receipt",
			code: "NODE_OBSERVER_PUBLICATION_UNCONFIRMED",
		});
		const unhosted = observer();
		unhosted.ports.host.mockRejectedValueOnce(new Error("NODE_OBSERVER_HOST_DIFFERS"));
		expect(await failure(unhosted)).toEqual({ check: "host", code: "NODE_OBSERVER_HOST_DIFFERS" });
	});
	it("holds the observation slot until cancelled host IO actually settles", async () => {
		const f = observer(),
			controller = new AbortController();
		let settle!: () => void;
		f.ports.host.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					settle = () => resolve(f.host);
				}),
		);
		const first = f.observer.observe(controller.signal),
			assertion = expect(first).rejects.toThrow("UNCONFIRMED");
		controller.abort();
		await expect(f.observer.observe(signal())).rejects.toThrow("BUSY");
		expect(f.calls).toHaveLength(0);
		settle();
		await assertion;
		expect((await f.observer.observe(signal())).state).toBe("ready");
	});
});
