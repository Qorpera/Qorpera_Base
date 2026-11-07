import { randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import {
	type RuntimeNodeInventoryContext,
	type RuntimeNodeInventoryPolicy,
	runtimeNodeInstanceConfigurationSha256,
} from "../src/runtime-node-inventory.ts";
import {
	RuntimeNodeInventoryObserver,
	type RuntimeNodeObserverHost,
	type RuntimeNodeObserverRegistry,
} from "../src/runtime-node-observer.ts";

const roots: string[] = [],
	servers: Server[] = [];
const certificate = readFileSync(
	new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
	"utf8",
);
const certificateSha = new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase();
function daemon() {
	return {
		auth: "trusted",
		auth_user_method: "unix",
		api_version: "1.0",
		api_status: "stable",
		public: false,
		api_extensions: ["instance_all_projects"],
		environment: {
			server: "lxd",
			kernel: "Linux",
			server_clustered: false,
			project: "default",
			driver: "lxc | qemu",
			instance_types: ["container", "virtual-machine"],
			certificate,
			certificate_fingerprint: certificateSha,
			server_name: "fixture-node",
			server_version: "6.9",
			kernel_architecture: "x86_64",
		},
	};
}
function instance(project: string, name: string, type = "virtual-machine", status = "Running", status_code = 103) {
	return {
		project,
		name,
		type,
		status,
		status_code,
		location: "none",
		config: { "limits.cpu": "2", "limits.memory": "4GiB" },
		expanded_config: { "limits.cpu": "2", "limits.memory": "4GiB" },
		profiles: [],
		devices: {},
		expanded_devices: {},
	};
}
const items = () => [
	instance("default", "management"),
	instance("company-a", "office"),
	instance("company-b", "office", "container", "Stopped", 102),
];
const urls = () => [
	"/1.0/instances/management",
	"/1.0/instances/office?project=company-a",
	"/1.0/instances/office?project=company-b",
];
const sync = (metadata: unknown) => ({ type: "sync", status_code: 200, metadata });
async function setup(
	change: (
		path: string,
		pass: number,
		body: ReturnType<typeof sync>,
	) => { body?: unknown; status?: number; stall?: boolean } = () => ({}),
) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-host-inventory-"));
	roots.push(root);
	const socket = join(root, "lxd.socket"),
		calls: string[] = [],
		counts = new Map<string, number>();
	const server = createServer((request, response) => {
		const path = request.url ?? "";
		calls.push(`${request.method} ${path}`);
		counts.set(path, (counts.get(path) ?? 0) + 1);
		const metadata = path.startsWith("/1.0?") ? daemon() : path.endsWith("recursion=0") ? urls() : items();
		const body = sync(metadata),
			result = change(path, counts.get(path)!, body);
		if (result.stall) return;
		response.writeHead(result.status ?? 200, { "content-type": "application/json" });
		response.end(JSON.stringify(result.body ?? body));
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	return { client: new LxdUnixClient(socket), calls };
}
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const inspect = (client: LxdUnixClient) => client.inspectHostInventory(new AbortController().signal);

describe("complete LXD host inventory", () => {
	it("reads every project, VM/container and stopped allocation without a scope or state filter", async () => {
		const { client, calls } = await setup();
		const result = await inspect(client);
		expect(result.server).toMatchObject({
			project: "default",
			serverName: "fixture-node",
			certificateSha256: certificateSha,
		});
		expect(result.instances.map((item) => [item.project, item.name, item.type, item.status])).toEqual([
			["company-a", "office", "virtual-machine", "Running"],
			["company-b", "office", "container", "Stopped"],
			["default", "management", "virtual-machine", "Running"],
		]);
		expect(calls).toEqual([
			"GET /1.0?project=default",
			"GET /1.0/instances?all-projects=true&recursion=0",
			"GET /1.0/instances?all-projects=true&recursion=1",
			"GET /1.0/instances?all-projects=true&recursion=1",
			"GET /1.0/instances?all-projects=true&recursion=0",
			"GET /1.0?project=default",
		]);
	});
	it("accepts an empty host only when both complete listings agree", async () => {
		const { client } = await setup((path) => (path.includes("/instances?") ? { body: sync([]) } : {}));
		expect((await inspect(client)).instances).toEqual([]);
	});
	it.each(["extension", "cluster", "untrusted", "remote", "certificate"])(
		"refuses an unsupported or untrusted daemon: %s",
		async (fault) => {
			const { client, calls } = await setup((path) => {
				if (!path.startsWith("/1.0?")) return {};
				const value = daemon();
				if (fault === "extension") value.api_extensions = [];
				if (fault === "cluster") value.environment.server_clustered = true;
				if (fault === "untrusted") value.auth = "untrusted";
				if (fault === "remote") value.auth_user_method = "tls";
				if (fault === "certificate") value.environment.certificate_fingerprint = "a".repeat(64);
				return { body: sync(value) };
			});
			await expect(inspect(client)).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
			expect(calls).toHaveLength(1);
		},
	);
	it.each(["missing", "duplicate", "render-error", "project", "location", "expanded", "state"])(
		"refuses incomplete expanded evidence: %s",
		async (fault) => {
			const { client } = await setup((path) => {
				if (!path.endsWith("recursion=1")) return {};
				const values: Record<string, unknown>[] = items();
				if (fault === "missing") values.pop();
				if (fault === "duplicate") values.push(values[0]);
				if (fault === "render-error")
					values[0] = {
						name: "management",
						project: "default",
						status: "Error",
						status_code: 112,
						type: "virtual-machine",
						location: "none",
					};
				if (fault === "project") delete values[0].project;
				if (fault === "location") values[0].location = "another-node";
				if (fault === "expanded") delete values[0].expanded_config;
				if (fault === "state") values[0].status_code = 1.5;
				return { body: sync(values) };
			});
			await expect(inspect(client)).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
		},
	);
	// Copied with `output[name] = …`, a device named __proto__ became the parsed
	// map's prototype: gone from Object.keys, JSON and the node inventory's
	// digests. LXD's own name rule allows the name, so the scan refuses it.
	it.each<[string, (value: Record<string, unknown>) => void]>([
		[
			"a device named __proto__",
			(v) => {
				v.devices = JSON.parse('{"__proto__":{"type":"disk","source":"/","path":"/host"}}');
			},
		],
		[
			"an inherited device named __proto__",
			(v) => {
				v.expanded_devices = JSON.parse('{"__proto__":{"type":"disk","source":"/","path":"/host"}}');
			},
		],
		[
			"a device named constructor",
			(v) => {
				v.devices = { constructor: { type: "disk", source: "/", path: "/host" } };
			},
		],
		[
			"a device named prototype",
			(v) => {
				v.expanded_devices = { prototype: { type: "disk", source: "/", path: "/host" } };
			},
		],
		[
			"a device option named __proto__",
			(v) => {
				v.devices = JSON.parse('{"eth0":{"type":"nic","network":"qorpera0","__proto__":"x"}}');
			},
		],
		[
			"a configuration key named __proto__",
			(v) => {
				v.config = JSON.parse('{"limits.cpu":"2","limits.memory":"4GiB","__proto__":"x"}');
			},
		],
		[
			"an inherited configuration key named constructor",
			(v) => {
				v.expanded_config = { "limits.cpu": "2", "limits.memory": "4GiB", constructor: "x" };
			},
		],
		[
			"a device name starting with a full stop",
			(v) => {
				v.devices = { ".root": { type: "disk", path: "/", pool: "default" } };
			},
		],
		[
			"a device name with a space",
			(v) => {
				v.devices = { "root disk": { type: "disk", path: "/", pool: "default" } };
			},
		],
		[
			"a device name of 64 characters",
			(v) => {
				v.devices = { ["d".repeat(64)]: { type: "disk", path: "/", pool: "default" } };
			},
		],
		[
			"an empty device name",
			(v) => {
				v.devices = { "": { type: "disk", path: "/", pool: "default" } };
			},
		],
	])("refuses %s instead of dropping or passing it", async (_, change) => {
		const { client } = await setup((path) => {
			if (!path.endsWith("recursion=1")) return {};
			const values: Record<string, unknown>[] = items();
			change(values[0]);
			return { body: sync(values) };
		});
		await expect(inspect(client)).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
	});
	it("keeps every device name LXD's own rule allows, as own entries of a plain object", async () => {
		const names = [
			"root",
			"eth0",
			`identity-${randomUUID()}`,
			"data-0123456789abcdef0123456789abcdef",
			"a/b:c_d.e-f",
			"d".repeat(63),
		];
		const devices = Object.fromEntries(
			names.map((name, index) => [name, { type: "disk", source: `/srv/${index}`, path: `/mnt/${index}` }]),
		);
		const { client } = await setup((path) => {
			if (!path.endsWith("recursion=1")) return {};
			const values = items();
			values[0].devices = values[0].expanded_devices = devices;
			return { body: sync(values) };
		});
		const management = (await inspect(client)).instances.find((i) => i.name === "management");
		expect(Object.keys(management?.devices ?? {})).toEqual(names);
		expect(management?.expandedDevices).toEqual(devices);
		// Callers compare these records with isDeepStrictEqual, which tells a null-prototype object from a plain one.
		expect(Object.getPrototypeOf(management?.devices)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(management?.devices.root)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(management?.config)).toBe(Object.prototype);
	});
	it.each([
		"https://elsewhere.invalid/1.0/instances/office",
		"/1.0/instances/office?project=company-a&project=company-b",
		"/1.0/instances/office?project=company-a&filter=running",
		"/1.0/instances/office/snapshot?project=company-a",
		"/1.0/instances/office?project=company-a#ignored",
	])("refuses substituted or ambiguous inventory URL %#", async (url) => {
		const { client } = await setup((path) => (path.endsWith("recursion=0") ? { body: sync([url]) } : {}));
		await expect(inspect(client)).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
	});
	it.each(["identities", "config", "power", "server"])(
		"refuses a changing %s observation instead of treating it as a stable snapshot",
		async (fault) => {
			const { client } = await setup((path, pass) => {
				if (pass !== 2) return {};
				if (fault === "identities" && path.endsWith("recursion=0")) return { body: sync(urls().slice(1)) };
				if (fault === "server" && path.startsWith("/1.0?")) {
					const value = daemon();
					value.environment.server_name = "changed";
					return { body: sync(value) };
				}
				if (path.endsWith("recursion=1")) {
					const values = items();
					if (fault === "config") values[0].expanded_config["limits.cpu"] = "8";
					if (fault === "power") {
						values[0].status = "Stopped";
						values[0].status_code = 102;
					}
					return { body: sync(values) };
				}
				return {};
			});
			await expect(inspect(client)).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
		},
	);
	it.each([301, 403, 500])("refuses failed or redirected inventory responses (%s)", async (status) => {
		const { client } = await setup((path) => (path.includes("/instances?") ? { status } : {}));
		await expect(inspect(client)).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
	});
	it("bounds entry count and never silently truncates a larger host", async () => {
		const { client } = await setup((path) =>
			path.endsWith("recursion=0")
				? { body: sync(Array.from({ length: 4097 }, (_, i) => `/1.0/instances/guest-${i}`)) }
				: {},
		);
		await expect(inspect(client)).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
	});
	it("cancels a stalled read without returning a partial inventory", async () => {
		const { client, calls } = await setup((path) => (path.endsWith("recursion=1") ? { stall: true } : {})),
			controller = new AbortController();
		const pending = client.inspectHostInventory(controller.signal),
			assertion = expect(pending).rejects.toThrow("LXD_HOST_INVENTORY_UNCONFIRMED");
		const timer = setTimeout(() => controller.abort(), 30);
		await assertion;
		clearTimeout(timer);
		expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
	});
});

describe("the node observer over this client (2026-09-28)", () => {
	const sha = "a".repeat(64),
		physicalId = randomUUID();
	/** A node whose only instance is the management VM with these devices. */
	async function node(devices: string) {
		const management = instance("default", "management"),
			uuid = { "volatile.uuid": physicalId };
		const listed = {
			...management,
			config: { ...management.config, ...uuid },
			expanded_config: { ...management.expanded_config, ...uuid },
			devices: JSON.parse(devices),
			expanded_devices: JSON.parse(devices),
		};
		return (
			await setup((path) =>
				path.endsWith("recursion=0")
					? { body: sync(["/1.0/instances/management"]) }
					: path.endsWith("recursion=1")
						? { body: sync([listed]) }
						: {},
			)
		).client;
	}
	it("a host-path disk named __proto__ makes the node unavailable instead of vanishing from its digest", async () => {
		const clean = await node("{}");
		const enrolled = (await inspect(clean)).instances[0];
		const policy: RuntimeNodeInventoryPolicy = {
			schema: "qorpera.runtime-node-inventory-policy/v1",
			nodeId: randomUUID(),
			host: {
				machineIdSha256: sha,
				socketPath: "/var/snap/lxd/common/lxd/unix.socket",
				socketGid: 2000,
				certificateSha256: certificateSha,
				serverName: "fixture-node",
				serverVersion: "6.9",
				architecture: "x86_64",
			},
			operatingCpuMillis: 1000,
			operatingMemoryBytes: 1024 ** 3,
			infrastructure: [
				{
					project: "default",
					name: "management",
					physicalId,
					type: "virtual-machine",
					configurationSha256: runtimeNodeInstanceConfigurationSha256(enrolled),
					cpuMillis: 2000,
					memoryBytes: 4 * 1024 ** 3,
				},
			],
		};
		const context: RuntimeNodeInventoryContext = {
			policy,
			nodeVersion: 1,
			contextSha256: sha,
			headroomCpuMillis: 4000,
			headroomMemoryBytes: 8 * 1024 ** 3,
			allocations: [],
		};
		const host: RuntimeNodeObserverHost = {
			machineIdSha256: sha,
			cpuMillis: 16000,
			memoryBytes: 64 * 1024 ** 3,
			bootId: randomUUID(),
			namespace: "mnt:[1]",
			socket: { dev: 1, ino: 2, uid: 0, gid: 2000, mode: 0o140660, nlink: 1 },
		};
		const observe = async (lxd: LxdUnixClient) => {
			const published: string[] = [];
			const registry: RuntimeNodeObserverRegistry = {
				call: async (method, args) => {
					if (method === "qorpera_runtime_node_inventory_context") return structuredClone(context);
					published.push(method);
					const o = args.p_observation as Record<string, unknown>;
					// A time-ordered id: reports land beside each other in the receipts' index.
					expect(String(o.observationId)[14]).toBe("7");
					return { nodeId: o.nodeId, observationId: o.observationId, observedAt: o.observedAt };
				},
			};
			const observer = new RuntimeNodeInventoryObserver(policy, registry, {
				lxd,
				host: async () => structuredClone(host),
			});
			return { state: (await observer.observe(new AbortController().signal)).state, published };
		};
		expect(await observe(clean)).toEqual({ state: "ready", published: ["qorpera_observe_runtime_node_inventory"] });
		const disk = '{"type":"disk","source":"/","path":"/host"}';
		// Under an ordinary name the disk is a change of enrollment, named in the published inventory.
		expect(await observe(await node(`{"host":${disk}}`))).toEqual({
			state: "unavailable",
			published: ["qorpera_observe_runtime_node_inventory"],
		});
		// Named __proto__, the scan is refused: unavailable, and no inventory claims the host is known.
		expect(await observe(await node(`{"__proto__":${disk}}`))).toEqual({
			state: "unavailable",
			published: ["qorpera_observe_runtime_node"],
		});
	});
});
