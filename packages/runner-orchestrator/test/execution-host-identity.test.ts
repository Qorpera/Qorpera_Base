import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	executionHostIdentityDevice,
	executionHostIdentityDevices,
	executionHostIdentityOf,
	parseExecutionHostIdentityVolumes,
} from "../src/execution-host-identity.ts";
import type { LxdInstanceDeviceUpdateClient, LxdInstanceRecord, LxdStorageVolumeRecord } from "../src/lxd-client.ts";
import { LxdExecutionHostIdentities } from "../src/lxd-execution-host-identity.ts";

const volumes = { pool: "qorpera-vm", sourcePrefix: "phql-a1-identity-" };
const signal = () => new AbortController().signal;
type Devices = Record<string, Record<string, string>>;

describe("execution host identity device shape", () => {
	it("is exactly today's hand-attached device: disk, pool, source from the id, fixed path", () => {
		const id = randomUUID();
		expect(executionHostIdentityDevice(volumes, id)).toEqual({
			name: `identity-${id}`,
			device: {
				type: "disk",
				pool: "qorpera-vm",
				source: `phql-a1-identity-${id}`,
				path: `/var/lib/qorpera/identities/${id}`,
			},
		});
	});
	it.each([
		"",
		"../etc",
		"A0000000-0000-4000-8000-000000000001",
		"30000000-0000-4000-8000-00000000000",
		"x".repeat(36),
	])("derives a device only from a canonical identity id: %j", (id) =>
		expect(() => executionHostIdentityDevice(volumes, id)).toThrow("INVALID_EXECUTION_HOST_IDENTITY"),
	);
	it.each([
		null,
		[],
		{ pool: "qorpera-vm" },
		{ pool: "qorpera-vm", sourcePrefix: "phql-a1-identity-", path: "/" },
		{ pool: "qorpera vm", sourcePrefix: "phql-a1-identity-" },
		{ pool: "qorpera-vm", sourcePrefix: "../identity-" },
		{ pool: "qorpera-vm", sourcePrefix: "Identity-" },
		{ pool: ["qorpera-vm"], sourcePrefix: "phql-a1-identity-" },
	])("refuses identity volumes %j", (value) =>
		expect(() => parseExecutionHostIdentityVolumes(value)).toThrow("INVALID_EXECUTION_HOST_IDENTITY_VOLUMES"),
	);
	it("recognises only that exact device: no other key, value, name or path", () => {
		const id = randomUUID(),
			{ name, device } = executionHostIdentityDevice(volumes, id);
		expect(executionHostIdentityOf(volumes, name, device)).toBe(id);
		const other = randomUUID();
		for (const [changedName, changed] of [
			[name, { ...device, readonly: "false" }],
			[name, { ...device, required: "true" }],
			[name, { ...device, pool: "default" }],
			[name, { ...device, source: `phql-a1-identity-${other}` }],
			[name, { ...device, source: "/var/lib" }],
			[name, { ...device, path: "/" }],
			[name, { ...device, path: `/var/lib/qorpera/identities/${id}/../..` }],
			[name, { type: "unix-block", pool: device.pool, source: device.source, path: device.path }],
			[`identity-${id.toUpperCase()}`, device],
			[`identity-${other}`, device],
			[`data-${id}`, device],
		] as const)
			expect(executionHostIdentityOf(volumes, changedName, changed)).toBeUndefined();
		expect(executionHostIdentityOf(volumes, name, undefined)).toBeUndefined();
	});
	it("leaves out only identity devices the instance itself carries unchanged in its expanded form", () => {
		const a = randomUUID(),
			b = randomUUID(),
			c = randomUUID();
		const da = executionHostIdentityDevice(volumes, a),
			db = executionHostIdentityDevice(volumes, b),
			dc = executionHostIdentityDevice(volumes, c);
		const root = { type: "disk", path: "/", pool: "qorpera-vm" };
		const devices: Devices = { root, [da.name]: { ...da.device }, [db.name]: { ...db.device } };
		const expanded: Devices = {
			...devices,
			eth0: { type: "nic", network: "qorpera0" },
			// From a profile only: not the instance's own device.
			[dc.name]: { ...dc.device },
			// Overridden in the effective configuration.
			[db.name]: { ...db.device, readonly: "true" },
		};
		const split = executionHostIdentityDevices(volumes, devices, expanded);
		expect(split.identities).toEqual([a]);
		expect(split.devices).toEqual({ root, [db.name]: db.device });
		expect(split.expandedDevices).toEqual({
			root,
			eth0: expanded.eth0,
			[dc.name]: dc.device,
			[db.name]: expanded[db.name],
		});
	});
});

type FakeInstance = Omit<LxdInstanceRecord, "devices" | "expandedDevices"> & {
	devices: Devices;
	expandedDevices: Devices;
};
class FakeHost implements LxdInstanceDeviceUpdateClient {
	instance: FakeInstance = {
		name: "qorpera-exec-node02",
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		config: { "limits.cpu": "4" },
		profiles: ["native25-job-a1"],
		devices: { root: { type: "disk", path: "/", pool: "qorpera-vm" } },
		expandedDevices: {
			root: { type: "disk", path: "/", pool: "qorpera-vm" },
			eth0: { type: "nic", network: "qorpera0" },
		},
		expandedConfig: { "limits.cpu": "4" },
	};
	volumes: LxdStorageVolumeRecord[] = [];
	writes: Devices[] = [];
	failures: Error[] = [];
	/** Runs between the read and the conditional write, like a concurrent writer. */
	interleave?: () => void;
	async getInstance() {
		return structuredClone(this.instance);
	}
	async updateInstanceDevices(
		project: string,
		name: string,
		update: (instance: LxdInstanceRecord) => Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
		signal: AbortSignal,
	): Promise<boolean> {
		signal.throwIfAborted();
		expect([project, name]).toEqual(["qn25b2", "qorpera-exec-node02"]);
		const read = structuredClone(this.instance),
			devices = update(read);
		if (!devices) return false;
		const version = JSON.stringify(this.instance);
		this.interleave?.();
		this.interleave = undefined;
		const failure = this.failures.shift();
		if (failure) throw failure;
		if (JSON.stringify(this.instance) !== version) throw new Error("LXD: Precondition failed");
		this.writes.push(structuredClone(devices) as Devices);
		const expandedExtras = Object.fromEntries(
			Object.entries(this.instance.expandedDevices).filter(([key]) => !Object.hasOwn(this.instance.devices, key)),
		);
		const written = structuredClone(devices) as Devices;
		this.instance = { ...this.instance, devices: written, expandedDevices: { ...expandedExtras, ...written } };
		return true;
	}
	async listCustomStorageVolumes(project: string, pool: string) {
		expect([project, pool]).toEqual(["qn25b2", "qorpera-vm"]);
		return structuredClone(this.volumes);
	}
}

describe("login gateway attaching identity volumes to the execution host", () => {
	const host = () => {
		const fake = new FakeHost();
		return {
			fake,
			host: new LxdExecutionHostIdentities({ project: "qn25b2", instance: fake.instance.name }, volumes, fake),
		};
	};
	it("hot-plugs exactly the identity device, keeps every other device, and is idempotent", async () => {
		const { fake, host: exec } = host(),
			id = randomUUID();
		expect(await exec.attach([id], signal())).toEqual({ attached: [id], refused: [] });
		expect(fake.writes).toEqual([
			{
				root: { type: "disk", path: "/", pool: "qorpera-vm" },
				[`identity-${id}`]: {
					type: "disk",
					pool: "qorpera-vm",
					source: `phql-a1-identity-${id}`,
					path: `/var/lib/qorpera/identities/${id}`,
				},
			},
		]);
		expect(await exec.attach([id], signal())).toEqual({ attached: [], refused: [] });
		expect(fake.writes).toHaveLength(1);
	});
	it("attaches several missing identities in one change and leaves attached ones alone", async () => {
		const { fake, host: exec } = host(),
			[a, b, c] = [randomUUID(), randomUUID(), randomUUID()].sort();
		await exec.attach([b], signal());
		expect(await exec.attach([c, a, b, a], signal())).toEqual({ attached: [a, c], refused: [] });
		expect(fake.writes).toHaveLength(2);
		expect(Object.keys(fake.instance.devices).sort()).toEqual([
			`identity-${a}`,
			`identity-${b}`,
			`identity-${c}`,
			"root",
		]);
	});
	it("never replaces a device of that name in another shape, from the instance or a profile, and still attaches the rest", async () => {
		const { fake, host: exec } = host(),
			[a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
		fake.instance.devices[`identity-${a}`] = { type: "disk", source: "/", path: `/var/lib/qorpera/identities/${a}` };
		fake.instance.expandedDevices[`identity-${a}`] = fake.instance.devices[`identity-${a}`];
		fake.instance.expandedDevices[`identity-${b}`] = executionHostIdentityDevice(volumes, b).device;
		expect(await exec.attach([a, b, c], signal())).toEqual({ attached: [c], refused: [a, b].sort() });
		expect(fake.instance.devices[`identity-${a}`]).toEqual({
			type: "disk",
			source: "/",
			path: `/var/lib/qorpera/identities/${a}`,
		});
		expect(fake.instance.devices[`identity-${b}`]).toBeUndefined();
	});
	it("decides again from a fresh read when another writer changed the host in between", async () => {
		const { fake, host: exec } = host(),
			[a, b] = [randomUUID(), randomUUID()];
		fake.interleave = () => {
			fake.instance.devices = {
				...fake.instance.devices,
				[`identity-${b}`]: executionHostIdentityDevice(volumes, b).device,
			};
			fake.instance.expandedDevices = { ...fake.instance.expandedDevices, ...fake.instance.devices };
		};
		expect(await exec.attach([a, b], signal())).toEqual({ attached: [a], refused: [] });
		expect(Object.keys(fake.instance.devices).sort()).toEqual([`identity-${a}`, `identity-${b}`, "root"].sort());
	});
	it("gives up after three failed writes and reports the failure", async () => {
		const { fake, host: exec } = host();
		fake.failures = [new Error("LXD: busy"), new Error("LXD: busy"), new Error("LXD: busy")];
		await expect(exec.attach([randomUUID()], signal())).rejects.toThrow("LXD: busy");
		expect(fake.writes).toHaveLength(0);
	});
	it("refuses a host that is not a virtual machine and invalid identities before touching LXD", async () => {
		const { fake, host: exec } = host();
		fake.instance.type = "container";
		await expect(exec.attach([randomUUID()], signal())).rejects.toThrow("not a virtual machine");
		await expect(exec.attach(["../../etc"], signal())).rejects.toThrow("INVALID_EXECUTION_HOST_IDENTITY");
		expect(fake.writes).toHaveLength(0);
		expect(() => new LxdExecutionHostIdentities({ project: "qn25b2", instance: "../x" }, volumes, fake)).toThrow();
		expect(
			() =>
				new LxdExecutionHostIdentities(
					{ project: "qn25b2", instance: "x" },
					{ ...volumes, sourcePrefix: "/" },
					fake,
				),
		).toThrow();
	});
});
