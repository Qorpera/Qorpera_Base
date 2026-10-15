import { randomUUID } from "node:crypto";
import { chmod, link, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODING_HOST_LEASE_TTL_MS,
	type CodingHostClock,
	CodingHostLeases,
	judgeCodingHostLease,
	runCodingHostWatchdog,
} from "../src/coding-host-lease.ts";
import { lxdCodingMachineName } from "../src/coding-machine.ts";
import type { LxdHostInventoryInstance } from "../src/lxd-client.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-host-lease-")));
	roots.push(root);
	await chmod(root, 0o700);
	const now = { bootId: randomUUID(), uptimeMs: 3_600_000 };
	const clock: CodingHostClock = { bootId: async () => now.bootId, uptimeMs: async () => now.uptimeMs };
	const leases = new CodingHostLeases({ root, clock });
	const machine = (machineId = randomUUID()) => ({
		project: "coding",
		machineId,
		name: lxdCodingMachineName(machineId),
	});
	const verdict = (name: string, project = "coding") =>
		judgeCodingHostLease(name, project, { root, bootId: now.bootId, nowMs: now.uptimeMs });
	const file = (name: string) => join(root, `${name}.json`);
	const read = async (name: string) => JSON.parse(await readFile(file(name), "utf8"));
	return { root, now, clock, leases, machine, verdict, file, read };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe("a member machine's host lease", () => {
	it("is written for 90 seconds of this boot, renewed, and dropped", async () => {
		const f = await fixture();
		const a = f.machine();
		await f.leases.renew(a);
		expect(await f.read(a.name)).toEqual({
			schema: "qorpera.coding-host-lease/v1",
			project: "coding",
			name: a.name,
			machineId: a.machineId,
			bootId: f.now.bootId,
			renewedAtBootMs: 3_600_000,
			expiresAtBootMs: 3_600_000 + CODING_HOST_LEASE_TTL_MS,
		});
		// Only the executor's user reads it; the write leaves nothing else behind.
		expect((await stat(f.file(a.name))).mode & 0o777).toBe(0o600);
		expect(await readdir(f.root)).toEqual([`${a.name}.json`]);
		f.now.uptimeMs += CODING_HOST_LEASE_TTL_MS - 1;
		expect(await f.verdict(a.name)).toBe("live");
		f.now.uptimeMs += 1;
		expect(await f.verdict(a.name)).toBe("lapsed");
		await f.leases.renew(a);
		expect(await f.verdict(a.name)).toBe("live");
		await f.leases.drop(a);
		expect(await f.verdict(a.name)).toBe("missing");
		// Dropping a lease that is not there is fine.
		await f.leases.drop(a);
		expect(await readdir(f.root)).toEqual([]);
	});
	it("refuses a root anyone else may reach, and a holder no lease can name", async () => {
		const f = await fixture();
		await chmod(f.root, 0o750);
		await expect(f.leases.renew(f.machine())).rejects.toThrow("CODING_HOST_LEASE_ROOT_UNPROTECTED");
		await expect(f.leases.drop(f.machine())).rejects.toThrow("CODING_HOST_LEASE_ROOT_UNPROTECTED");
		await chmod(f.root, 0o700);
		await expect(f.leases.renew({ project: "../coding", machineId: randomUUID() })).rejects.toThrow(
			"CODING_HOST_LEASE_INVALID",
		);
		await expect(f.leases.renew({ project: "coding", machineId: "not-a-machine" })).rejects.toThrow(
			"INVALID_CODING_MACHINE_BINDING",
		);
		// The queue goes on after a refusal.
		const a = f.machine();
		await f.leases.renew(a);
		expect(await f.verdict(a.name)).toBe("live");
		expect(() => new CodingHostLeases({ root: f.root, clock: f.clock, ttlMs: CODING_HOST_LEASE_TTL_MS + 1 })).toThrow(
			"CODING_HOST_LEASE_INVALID",
		);
	});
	it("lets its machine run only while it is this machine's, of this boot, and as written", async () => {
		const f = await fixture();
		const a = f.machine(),
			b = f.machine();
		await f.leases.renew(a);
		const lease = await f.read(a.name);
		const rewrite = async (value: unknown, mode = 0o600) => {
			await rm(f.file(a.name), { force: true });
			await writeFile(f.file(a.name), typeof value === "string" ? value : JSON.stringify(value), { mode });
		};
		expect(await f.verdict(a.name, "coding-other")).toBe("mismatched");
		await rewrite({ ...lease, name: b.name, machineId: b.machineId });
		expect(await f.verdict(a.name)).toBe("mismatched");
		await rewrite({ ...lease, machineId: b.machineId });
		expect(await f.verdict(a.name)).toBe("mismatched");
		await rewrite({ ...lease, machineId: "not-a-machine" });
		expect(await f.verdict(a.name)).toBe("mismatched");
		await rewrite({ ...lease, bootId: randomUUID() });
		expect(await f.verdict(a.name)).toBe("other-boot");
		// Never written so: from the future, or for longer than the TTL.
		await rewrite({ ...lease, renewedAtBootMs: f.now.uptimeMs + 1, expiresAtBootMs: f.now.uptimeMs + 2 });
		expect(await f.verdict(a.name)).toBe("unreadable");
		await rewrite({ ...lease, expiresAtBootMs: lease.renewedAtBootMs + CODING_HOST_LEASE_TTL_MS + 1 });
		expect(await f.verdict(a.name)).toBe("unreadable");
		await rewrite({ ...lease, expiresAtBootMs: lease.renewedAtBootMs });
		expect(await f.verdict(a.name)).toBe("unreadable");
		await rewrite({ ...lease, extra: true });
		expect(await f.verdict(a.name)).toBe("unreadable");
		await rewrite({ ...lease, schema: "qorpera.coding-host-lease/v2" });
		expect(await f.verdict(a.name)).toBe("unreadable");
		await rewrite({ ...lease, renewedAtBootMs: 1.5 });
		expect(await f.verdict(a.name)).toBe("unreadable");
		await rewrite("{");
		expect(await f.verdict(a.name)).toBe("unreadable");
		await rewrite(lease, 0o644);
		expect(await f.verdict(a.name)).toBe("unreadable");
		// A link is never followed or trusted: a symlink, or a second name for the file.
		await rewrite(lease);
		expect(await f.verdict(a.name)).toBe("live");
		await link(f.file(a.name), join(f.root, "copy"));
		expect(await f.verdict(a.name)).toBe("unreadable");
		await rm(join(f.root, "copy"));
		await rm(f.file(a.name));
		await writeFile(join(f.root, "elsewhere.json"), JSON.stringify(lease), { mode: 0o600 });
		await symlink(join(f.root, "elsewhere.json"), f.file(a.name));
		expect(await f.verdict(a.name)).toBe("unreadable");
		// A root anyone else may reach lets nothing run; a missing one has no lease at all.
		await rewrite(lease);
		await chmod(f.root, 0o755);
		expect(await f.verdict(a.name)).toBe("unreadable");
		await chmod(f.root, 0o700);
		expect(
			await judgeCodingHostLease(a.name, "coding", {
				root: join(f.root, "absent"),
				bootId: f.now.bootId,
				nowMs: f.now.uptimeMs,
			}),
		).toBe("missing");
	});
	it("a keeper pass renews every lease it holds and removes the rest that let nothing run", async () => {
		const f = await fixture();
		const held = f.machine(),
			lapsed = f.machine(),
			earlier = f.machine(),
			starting = f.machine(),
			garbled = f.machine();
		await f.leases.renew(lapsed);
		f.now.uptimeMs += CODING_HOST_LEASE_TTL_MS;
		await f.leases.renew(starting);
		await writeFile(
			f.file(earlier.name),
			JSON.stringify({
				...(await f.read(starting.name)),
				name: earlier.name,
				machineId: earlier.machineId,
				bootId: randomUUID(),
			}),
			{ mode: 0o600 },
		);
		await writeFile(f.file(garbled.name), "{", { mode: 0o600 });
		// What a write that crashed leaves behind, and a file the leases never made.
		const crashed = `.${held.name}.${randomUUID()}.tmp`;
		await writeFile(join(f.root, crashed), "{", { mode: 0o600 });
		await writeFile(join(f.root, "notes.txt"), "kept", { mode: 0o600 });
		expect(await f.leases.hold([held, { project: "coding", machineId: "not-a-machine" }])).toEqual([
			{ machineId: "not-a-machine", error: new Error("INVALID_CODING_MACHINE_BINDING") },
		]);
		// A live lease of a machine not held stays: its start may be under way. It lapses on its own.
		expect((await readdir(f.root)).sort()).toEqual(
			[`${held.name}.json`, `${starting.name}.json`, "notes.txt"].sort(),
		);
		expect(await f.verdict(held.name)).toBe("live");
		expect(await f.verdict(starting.name)).toBe("live");
		f.now.uptimeMs += CODING_HOST_LEASE_TTL_MS;
		expect(await f.leases.hold([held])).toEqual([]);
		expect((await readdir(f.root)).sort()).toEqual([`${held.name}.json`, "notes.txt"].sort());
		// Every renewal fails on a root anyone else may reach; each is returned.
		await chmod(f.root, 0o755);
		expect(await f.leases.hold([held, starting])).toEqual([
			{ machineId: held.machineId, error: new Error("CODING_HOST_LEASE_ROOT_UNPROTECTED") },
			{ machineId: starting.machineId, error: new Error("CODING_HOST_LEASE_ROOT_UNPROTECTED") },
		]);
	});
	it("writes, drops and prunes one at a time, in the order asked", async () => {
		const f = await fixture();
		const a = f.machine();
		await Promise.all([f.leases.renew(a), f.leases.drop(a)]);
		expect(await f.verdict(a.name)).toBe("missing");
		await Promise.all([f.leases.drop(a), f.leases.renew(a)]);
		expect(await f.verdict(a.name)).toBe("live");
		f.now.uptimeMs += CODING_HOST_LEASE_TTL_MS;
		// The pass asked first removes the lapsed lease; the start asked next writes a fresh one after it.
		await Promise.all([f.leases.hold([]), f.leases.renew(a)]);
		expect(await f.verdict(a.name)).toBe("live");
	});
});

describe("the host watchdog", () => {
	const instance = (patch: Partial<LxdHostInventoryInstance> & { name: string }): LxdHostInventoryInstance => ({
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		config: {},
		profiles: [],
		devices: {},
		expandedDevices: {},
		expandedConfig: {},
		project: "coding",
		location: "none",
		...patch,
	});
	/** LXD as the watchdog sees it: the host inventory and a forced stop. */
	function lxd(f: Fixture, instances: LxdHostInventoryInstance[]) {
		const client = {
			inspectHostInventory: vi.fn(async (_signal: AbortSignal) => ({
				server: {
					project: "default",
					certificateSha256: "a".repeat(64),
					serverName: "node-02",
					serverVersion: "6.9",
					architecture: "x86_64",
				},
				instances,
			})),
			setInstancePower: vi.fn(async (_project: string, _name: string, _action: string, _signal?: AbortSignal) => {}),
		};
		const signal = new AbortController().signal;
		const run = () => runCodingHostWatchdog({ client, project: "coding", signal, root: f.root, clock: f.clock });
		return { client, signal, run, stops: () => client.setInstancePower.mock.calls.map((call) => call.slice(0, 3)) };
	}
	it("force-stops every member machine of the project that may be running without a live lease", async () => {
		const f = await fixture();
		const live = f.machine(),
			lapsed = f.machine(),
			missing = f.machine(),
			earlier = f.machine(),
			garbled = f.machine(),
			starting = f.machine(),
			stopped = f.machine();
		await f.leases.renew(lapsed);
		f.now.uptimeMs += CODING_HOST_LEASE_TTL_MS;
		await f.leases.renew(live);
		await writeFile(
			f.file(earlier.name),
			JSON.stringify({
				...(await f.read(live.name)),
				name: earlier.name,
				machineId: earlier.machineId,
				bootId: randomUUID(),
			}),
			{ mode: 0o600 },
		);
		await writeFile(f.file(garbled.name), "{", { mode: 0o600 });
		const other = randomUUID().replaceAll("-", "");
		const { client, run, stops, signal } = lxd(f, [
			instance({ name: live.name }),
			instance({ name: lapsed.name }),
			instance({ name: missing.name }),
			instance({ name: earlier.name }),
			instance({ name: garbled.name }),
			// Anything but stopped may still run: starting, freezing, frozen.
			instance({ name: starting.name, status: "Starting", statusCode: 106 }),
			instance({ name: stopped.name, status: "Stopped", statusCode: 102 }),
			// Never judged: other projects, containers, kept per-session VMs, company machines, anything else.
			instance({ name: f.machine().name, project: "default" }),
			instance({ name: f.machine().name, project: "coding-other" }),
			instance({ name: f.machine().name, type: "container" }),
			instance({ name: `qorpera-coding-${other}` }),
			instance({ name: `qorpera-machine-${other}` }),
			instance({ name: `qorpera-coding-machine-${other}-copy` }),
			instance({ name: "office" }),
		]);
		expect(await run()).toEqual([
			{ name: lapsed.name, verdict: "lapsed", state: "stopped" },
			{ name: missing.name, verdict: "missing", state: "stopped" },
			{ name: earlier.name, verdict: "other-boot", state: "stopped" },
			{ name: garbled.name, verdict: "unreadable", state: "stopped" },
			{ name: starting.name, verdict: "missing", state: "stopped" },
		]);
		expect(stops()).toEqual(
			[lapsed, missing, earlier, garbled, starting].map(({ name }) => ["coding", name, "stop"]),
		);
		// Each stop runs under the watchdog's own deadline.
		expect(client.setInstancePower.mock.calls.every((call) => call[3] === signal)).toBe(true);
	});
	it("stops every running member machine when no lease is there at all, as after a reboot", async () => {
		const f = await fixture();
		const a = f.machine();
		const { run, stops } = lxd(f, [instance({ name: a.name })]);
		await rm(f.root, { recursive: true });
		expect(await run()).toEqual([{ name: a.name, verdict: "missing", state: "stopped" }]);
		expect(stops()).toEqual([["coding", a.name, "stop"]]);
	});
	it("reads the leases only after the listing, so a machine started meanwhile is left running", async () => {
		const f = await fixture();
		const a = f.machine();
		const { client, run, stops } = lxd(f, [instance({ name: a.name })]);
		const listing = client.inspectHostInventory.getMockImplementation()!;
		client.inspectHostInventory.mockImplementationOnce(async (signal) => {
			const inventory = await listing(signal);
			// The executor writes the lease, then starts the machine, while LXD answers.
			await f.leases.renew(a);
			return inventory;
		});
		expect(await run()).toEqual([]);
		expect(stops()).toEqual([]);
	});
	it("reports each stop LXD refuses and still stops the rest", async () => {
		const f = await fixture();
		const a = f.machine(),
			b = f.machine(),
			c = f.machine();
		const { client, run, stops } = lxd(f, [
			instance({ name: a.name }),
			instance({ name: b.name }),
			instance({ name: c.name }),
		]);
		client.setInstancePower.mockImplementation(async (_project, name) => {
			if (name === a.name) throw new Error("LXD_OPERATION_FAILED");
			if (name === b.name) throw new Error("connect ECONNREFUSED /var/snap/lxd/common/lxd/unix.socket");
		});
		expect(await run()).toEqual([
			{ name: a.name, verdict: "missing", state: "failed", code: "LXD_OPERATION_FAILED" },
			{ name: b.name, verdict: "missing", state: "failed", code: "UNCLASSIFIED" },
			{ name: c.name, verdict: "missing", state: "stopped" },
		]);
		expect(stops()).toHaveLength(3);
	});
	it("stops nothing when LXD cannot confirm its inventory or the node's clock cannot be read", async () => {
		const f = await fixture();
		const a = f.machine();
		const { client, run } = lxd(f, [instance({ name: a.name })]);
		client.inspectHostInventory.mockRejectedValueOnce(new Error("LXD_HOST_INVENTORY_UNCONFIRMED"));
		await expect(run()).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
		const bootId = f.now.bootId;
		f.now.bootId = "not-a-boot";
		await expect(run()).rejects.toThrow("CODING_HOST_CLOCK_UNAVAILABLE");
		f.now.bootId = bootId;
		f.now.uptimeMs = -1;
		await expect(run()).rejects.toThrow("CODING_HOST_CLOCK_UNAVAILABLE");
		expect(client.setInstancePower).not.toHaveBeenCalled();
		await expect(
			runCodingHostWatchdog({
				client,
				project: "../coding",
				signal: new AbortController().signal,
				root: f.root,
				clock: f.clock,
			}),
		).rejects.toThrow("CODING_HOST_LEASE_INVALID");
	});
});
