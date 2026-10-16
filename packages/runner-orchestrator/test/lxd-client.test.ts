import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type LxdCreateInstanceRequest,
	type LxdCreateStorageVolumeRequest,
	LxdOperationFailed,
	LxdUnixClient,
} from "../src/lxd-client.ts";
import { HttpLxdGuestTransport } from "../src/lxd-provider.ts";
import { serverFrame } from "./helpers/realtime-fake.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function unixServer(
	handle: (
		method: string,
		url: string,
		body: unknown,
		headers: IncomingHttpHeaders,
	) => { status?: number; body: unknown; headers?: Record<string, string> },
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-lxd-client-"));
	roots.push(root);
	const socket = join(root, "lxd.socket");
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks);
			const encoded = raw.toString("utf-8");
			const body =
				request.headers["content-type"] === "application/json"
					? encoded
						? (JSON.parse(encoded) as unknown)
						: null
					: raw;
			const result = handle(request.method ?? "", request.url ?? "", body, request.headers);
			response.writeHead(result.status ?? 200, { "content-type": "application/json", ...result.headers });
			response.end(JSON.stringify(result.body));
		});
	});
	servers.push(server);
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(socket, () => {
			server.off("error", reject);
			resolveListen();
		});
	});
	return socket;
}

function createRequest(): LxdCreateInstanceRequest {
	return {
		name: "qorpera-20000000000040008000000000000001",
		type: "virtual-machine",
		profiles: ["qorpera-job-v1"],
		config: { "user.qorpera.runner_id": "20000000-0000-4000-8000-000000000002" },
		devices: {
			root: { type: "disk", path: "/", pool: "qorpera-vm", size: "64GiB" },
		},
		source: {
			type: "image",
			mode: "pull",
			protocol: "simplestreams",
			server: "https://images.example.com/",
			fingerprint: "a".repeat(64),
		},
	};
}

function createVolumeRequest(): LxdCreateStorageVolumeRequest {
	return {
		name: "identity-20000000-0000-4000-8000-000000000011",
		type: "custom",
		content_type: "filesystem",
		description: "Qorpera Compute Identity",
		config: {
			size: "32GiB",
			"user.qorpera.schema": "qorpera.compute-identity-volume/v1",
		},
	};
}

describe("LXD Unix client", () => {
	it("replaces only an instance's devices, under the ETag of its own read, and waits for the operation", async () => {
		const requests: { method: string; url: string; body: unknown; ifMatch: unknown }[] = [];
		const metadata = {
			name: "qorpera-coding-machine-1",
			architecture: "x86_64",
			config: { "limits.cpu": "4", "user.qorpera.schema": "qorpera.lxd-coding-machine/v1" },
			devices: { root: { type: "disk", path: "/", pool: "coding" } },
			ephemeral: false,
			profiles: [],
			stateful: false,
			description: "",
			type: "virtual-machine",
		};
		const socket = await unixServer((method, url, body, headers) => {
			requests.push({ method, url, body, ifMatch: headers["if-match"] });
			if (method === "GET" && url.startsWith("/1.0/instances/"))
				return { body: { type: "sync", metadata }, headers: { etag: '"v7"' } };
			if (method === "PUT") return { body: { type: "async", operation: "/1.0/operations/devices", metadata: {} } };
			return { body: { type: "sync", metadata: { status_code: 200, err: "" } } };
		});
		const devices = {
			root: { type: "disk", path: "/", pool: "coding" },
			"data-0123": { type: "disk", source: "/srv/x/data", path: "/workspace/x", required: "true" },
		};
		await new LxdUnixClient(socket).replaceInstanceDevices(
			"coding",
			"qorpera-coding-machine-1",
			devices,
			new AbortController().signal,
		);
		expect(requests.map((request) => [request.method, request.url])).toEqual([
			["GET", "/1.0/instances/qorpera-coding-machine-1?project=coding"],
			["PUT", "/1.0/instances/qorpera-coding-machine-1?project=coding"],
			["GET", "/1.0/operations/devices/wait?timeout=120"],
		]);
		expect(requests[1].ifMatch).toBe('"v7"');
		expect(requests[1].body).toEqual({
			architecture: "x86_64",
			config: metadata.config,
			devices,
			ephemeral: false,
			profiles: [],
			stateful: false,
			description: "",
		});
	});
	it("refuses to replace devices without an ETag to write under, or outside an instance's scope", async () => {
		let puts = 0;
		const socket = await unixServer((method) => {
			if (method === "PUT") puts++;
			return { body: { type: "sync", metadata: { architecture: "x86_64", config: {}, devices: {}, profiles: [] } } };
		});
		const client = new LxdUnixClient(socket);
		await expect(
			client.replaceInstanceDevices("coding", "qorpera-coding-machine-1", {}, new AbortController().signal),
		).rejects.toThrow("LXD instance version is unavailable");
		await expect(
			client.replaceInstanceDevices("coding", "../other", {}, new AbortController().signal),
		).rejects.toThrow("LXD instance scope is invalid");
		expect(puts).toBe(0);
	});
	it("decides a device change from the read whose ETag the write carries, and writes nothing when told so", async () => {
		const requests: { method: string; url: string; body: unknown; ifMatch: unknown }[] = [];
		const identity = {
			type: "disk",
			pool: "qorpera-vm",
			source: "phql-a1-identity-x",
			path: "/var/lib/qorpera/identities/x",
		};
		const metadata = {
			name: "qorpera-exec-node02",
			architecture: "x86_64",
			type: "virtual-machine",
			status: "Running",
			status_code: 103,
			config: { "limits.cpu": "4", "volatile.uuid": "30000000-0000-4000-8000-000000000001" },
			expanded_config: { "limits.cpu": "4", "volatile.uuid": "30000000-0000-4000-8000-000000000001" },
			devices: { root: { type: "disk", path: "/", pool: "qorpera-vm" } },
			expanded_devices: { root: { type: "disk", path: "/", pool: "qorpera-vm" }, eth0: { type: "nic" } },
			ephemeral: false,
			profiles: ["native25-job-a1"],
			stateful: false,
			description: "",
		};
		const socket = await unixServer((method, url, body, headers) => {
			requests.push({ method, url, body, ifMatch: headers["if-match"] });
			if (method === "GET" && url.startsWith("/1.0/instances/"))
				return { body: { type: "sync", metadata }, headers: { etag: '"v9"' } };
			if (method === "PUT") return { body: { type: "async", operation: "/1.0/operations/attach", metadata: {} } };
			return { body: { type: "sync", metadata: { status_code: 200, err: "" } } };
		});
		const client = new LxdUnixClient(socket);
		const seen: string[] = [];
		expect(
			await client.updateInstanceDevices(
				"qn25b2",
				"qorpera-exec-node02",
				(instance) => {
					seen.push(...Object.keys(instance.expandedDevices));
					return { ...instance.devices, "identity-x": identity };
				},
				new AbortController().signal,
			),
		).toBe(true);
		expect(seen).toEqual(["root", "eth0"]);
		expect(requests.map((request) => [request.method, request.url])).toEqual([
			["GET", "/1.0/instances/qorpera-exec-node02?project=qn25b2"],
			["PUT", "/1.0/instances/qorpera-exec-node02?project=qn25b2"],
			["GET", "/1.0/operations/attach/wait?timeout=120"],
		]);
		expect(requests[1].ifMatch).toBe('"v9"');
		expect(requests[1].body).toEqual({
			architecture: "x86_64",
			config: metadata.config,
			devices: { root: metadata.devices.root, "identity-x": identity },
			ephemeral: false,
			profiles: ["native25-job-a1"],
			stateful: false,
			description: "",
		});
		requests.length = 0;
		expect(
			await client.updateInstanceDevices(
				"qn25b2",
				"qorpera-exec-node02",
				() => undefined,
				new AbortController().signal,
			),
		).toBe(false);
		expect(requests.map((request) => request.method)).toEqual(["GET"]);
		await expect(
			client.updateInstanceDevices("qn25b2", "../x", () => undefined, new AbortController().signal),
		).rejects.toThrow("LXD instance scope is invalid");
	});
	it.each(["devices", "expanded_devices", "config", "expanded_config"])(
		"refuses an instance whose %s carries a __proto__ key before deciding or writing anything",
		async (field) => {
			const methods: string[] = [];
			const metadata: Record<string, unknown> = {
				name: "qorpera-exec-node02",
				architecture: "x86_64",
				type: "virtual-machine",
				status: "Running",
				status_code: 103,
				config: { "limits.cpu": "4" },
				expanded_config: { "limits.cpu": "4" },
				devices: { root: { type: "disk", path: "/", pool: "qorpera-vm" } },
				expanded_devices: { root: { type: "disk", path: "/", pool: "qorpera-vm" } },
				ephemeral: false,
				profiles: [],
				stateful: false,
				description: "",
			};
			// As LXD's JSON carries it: an own key. Copied by assignment, it was
			// dropped, and the PUT below would have deleted it from the instance.
			metadata[field] = JSON.parse(
				field.endsWith("devices")
					? '{"root":{"type":"disk","path":"/","pool":"qorpera-vm"},"__proto__":{"type":"disk","source":"/","path":"/host"}}'
					: '{"limits.cpu":"4","__proto__":"x"}',
			);
			const socket = await unixServer((method) => {
				methods.push(method);
				return method === "GET"
					? { body: { type: "sync", metadata }, headers: { etag: '"v9"' } }
					: { body: { type: "async", operation: "/1.0/operations/attach", metadata: {} } };
			});
			const update = vi.fn((instance: { devices: Record<string, Record<string, string>> }) => ({
				...instance.devices,
			}));
			await expect(
				new LxdUnixClient(socket).updateInstanceDevices(
					"qn25b2",
					"qorpera-exec-node02",
					update,
					new AbortController().signal,
				),
			).rejects.toThrow("is invalid");
			expect(update).not.toHaveBeenCalled();
			expect(methods).toEqual(["GET"]);
		},
	);
	it("lists a pool's custom volumes in one project", async () => {
		const urls: string[] = [];
		const socket = await unixServer((_method, url) => {
			urls.push(url);
			return {
				body: {
					type: "sync",
					metadata: [
						{
							name: "phql-a1-identity-x",
							type: "custom",
							content_type: "filesystem",
							description: "Qorpera Compute Identity x",
							config: { size: "2GiB", "user.qorpera.schema": "qorpera.compute-identity-volume/v1" },
						},
					],
				},
			};
		});
		expect(
			await new LxdUnixClient(socket).listCustomStorageVolumes("qn25b2", "qorpera-vm", new AbortController().signal),
		).toEqual([
			{
				name: "phql-a1-identity-x",
				type: "custom",
				contentType: "filesystem",
				description: "Qorpera Compute Identity x",
				config: { size: "2GiB", "user.qorpera.schema": "qorpera.compute-identity-volume/v1" },
			},
		]);
		expect(urls).toEqual(["/1.0/storage-pools/qorpera-vm/volumes/custom?recursion=1&project=qn25b2"]);
	});
	it.each(["create", "start"])("observes accepted %s after its dispatch grant expires", async (action) => {
		const dispatch = new AbortController(),
			caller = new AbortController();
		const requests: string[] = [];
		const socket = await unixServer((method) => {
			requests.push(method);
			if (method !== "GET") return { body: { type: "async", operation: "/1.0/operations/accepted", metadata: {} } };
			dispatch.abort(new Error("admission expired while observing"));
			return { body: { type: "sync", metadata: { status_code: 200, err: "" } } };
		});
		const client = new LxdUnixClient(socket);
		if (action === "create")
			await client.createInstance("qorpera-runners", createRequest(), caller.signal, dispatch.signal);
		else await client.setInstancePower("qorpera-runners", "guest", "start", caller.signal, dispatch.signal);
		expect(requests).toEqual([action === "create" ? "POST" : "PUT", "GET"]);
		expect(dispatch.signal.aborted).toBe(true);
		expect(caller.signal.aborted).toBe(false);
	});
	it.each(["create", "start"])("refuses %s before sending an expired admission", async (action) => {
		let requests = 0;
		const socket = await unixServer(() => {
			requests++;
			return { body: { type: "sync", metadata: {} } };
		});
		const client = new LxdUnixClient(socket),
			expired = AbortSignal.abort(new Error("expired grant"));
		await expect(
			action === "create"
				? client.createInstance("qorpera-runners", createRequest(), undefined, expired)
				: client.setInstancePower("qorpera-runners", "guest", "start", undefined, expired),
		).rejects.toThrow("expired grant");
		expect(requests).toBe(0);
	});
	it.each(["submission", "observation"])("retains cancellation during %s without another mutation", async (phase) => {
		const dispatch = new AbortController(),
			caller = new AbortController();
		const requests: string[] = [];
		const socket = await unixServer((method) => {
			requests.push(method);
			if (method !== "GET") {
				if (phase === "submission") dispatch.abort();
				return { body: { type: "async", operation: "/1.0/operations/accepted", metadata: {} } };
			}
			caller.abort();
			return { body: { type: "sync", metadata: { status_code: 200, err: "" } } };
		});
		await expect(
			new LxdUnixClient(socket).createInstance("qorpera-runners", createRequest(), caller.signal, dispatch.signal),
		).rejects.toThrow();
		expect(requests).toEqual(phase === "submission" ? ["POST"] : ["POST", "GET"]);
	});
	it("preserves stopped VM status when LXD returns a null network map", async () => {
		let requests = 0;
		const socket = await unixServer(() => {
			requests++;
			return { body: { type: "sync", metadata: { status: "Stopped", status_code: 102, network: null } } };
		});
		const client = new LxdUnixClient(socket);
		await expect(client.getInstanceState("qorpera-runners", "guest")).resolves.toEqual({
			status: "Stopped",
			statusCode: 102,
			network: {},
		});
		await expect(
			new HttpLxdGuestTransport(client).waitReady("qorpera-runners", "guest", "enp5s0", 8082, 10_000),
		).rejects.toThrow("powered off before activating");
		expect(requests).toBe(2);
	});

	it.each([
		{ status: "Running", status_code: 103, network: null },
		{ status: "Stopped", status_code: 102 },
		{ status: "Stopped", status_code: 102, network: [] },
		{ status: "Stopped", status_code: 102, network: 42 },
	])("rejects malformed network state outside the stopped-null case (%#)", async (metadata) => {
		const socket = await unixServer(() => ({ body: { type: "sync", metadata } }));
		await expect(new LxdUnixClient(socket).getInstanceState("qorpera-runners", "guest")).rejects.toThrow(
			"network state is invalid",
		);
	});

	it("retains normalized optional guest MAC identity and omits absent/blank MACs", async () => {
		const socket = await unixServer(() => ({
			body: {
				type: "sync",
				metadata: {
					status: "Running",
					status_code: 103,
					network: {
						enp5s0: { hwaddr: "00:16:3E:B9:C4:8C", addresses: [] },
						lo: { hwaddr: "", addresses: [] },
						other: { addresses: [] },
					},
				},
			},
		}));
		expect((await new LxdUnixClient(socket).getInstanceState("qorpera-runners", "guest")).network).toEqual({
			enp5s0: { hwaddr: "00:16:3e:b9:c4:8c", addresses: [] },
			lo: { addresses: [] },
			other: { addresses: [] },
		});
	});

	it.each([null, 42, "bad", "00:16:3e:b9:c4", "00:16:3e:b9:c4:zz"])(
		"rejects malformed guest MAC %s",
		async (hwaddr) => {
			const socket = await unixServer(() => ({
				body: {
					type: "sync",
					metadata: {
						status: "Running",
						status_code: 103,
						network: { eth0: { hwaddr, addresses: [] } },
					},
				},
			}));
			await expect(new LxdUnixClient(socket).getInstanceState("qorpera-runners", "guest")).rejects.toThrow(
				"network MAC is invalid",
			);
		},
	);

	it.each(["__proto__", "constructor", "prototype"])(
		"rejects a guest interface named %s instead of hiding it from the one-interface-per-MAC check",
		async (name) => {
			const socket = await unixServer(() => ({
				body: {
					type: "sync",
					metadata: JSON.parse(
						`{"status":"Running","status_code":103,"network":{"enp5s0":{"hwaddr":"00:16:3e:b9:c4:8c","addresses":[]},"${name}":{"hwaddr":"00:16:3e:b9:c4:8c","addresses":[]}}}`,
					),
				},
			}));
			await expect(new LxdUnixClient(socket).getInstanceState("qorpera-runners", "guest")).rejects.toThrow(
				"network state is invalid",
			);
		},
	);

	it("returns inherited devices and configuration, not only local overrides", async () => {
		const request = createRequest();
		const inherited = { type: "disk", path: "/company", source: "/srv/company" };
		const socket = await unixServer(() => ({
			body: {
				type: "sync",
				metadata: {
					...request,
					status: "Running",
					status_code: 103,
					expanded_devices: { ...request.devices, inherited },
					expanded_config: { ...request.config, "raw.qemu": "profile override" },
				},
			},
		}));
		const actual = await new LxdUnixClient(socket).getInstance("qorpera-runners", request.name);
		expect(actual?.devices.inherited).toBeUndefined();
		expect(actual?.expandedDevices.inherited).toEqual(inherited);
		expect(actual?.expandedConfig["raw.qemu"]).toBe("profile override");
	});

	it("rejects a response that omits expanded authority", async () => {
		const request = createRequest();
		const socket = await unixServer(() => ({
			body: { type: "sync", metadata: { ...request, status: "Running", status_code: 103 } },
		}));
		await expect(new LxdUnixClient(socket).getInstance("qorpera-runners", request.name)).rejects.toThrow("devices");
	});
	it("uses the local socket, waits for async operations, and preserves the VM type", async () => {
		const requests: Array<{ method: string; url: string; body: unknown }> = [];
		const socket = await unixServer((method, url, body) => {
			requests.push({ method, url, body });
			if (method === "POST" && url === "/1.0/instances?project=qorpera-runners") {
				return {
					body: {
						type: "async",
						status: "Operation created",
						status_code: 100,
						operation: "/1.0/operations/operation-1",
						metadata: {},
					},
				};
			}
			if (method === "GET" && url === "/1.0/operations/operation-1/wait?timeout=30") {
				return {
					body: {
						type: "sync",
						status: "Success",
						status_code: 200,
						metadata: { status: "Success", status_code: 200, err: "" },
					},
				};
			}
			if (method === "GET" && url.includes("/instances/missing")) {
				return {
					status: 404,
					body: { type: "error", status: "Not Found", status_code: 404, error: "not found", error_code: 404 },
				};
			}
			throw new Error(`unexpected request ${method} ${url}`);
		});
		const client = new LxdUnixClient(socket, 30);
		const request = createRequest();

		await client.createInstance("qorpera-runners", request);
		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "/1.0/instances?project=qorpera-runners",
			body: { type: "virtual-machine", source: { fingerprint: "a".repeat(64) } },
		});
		expect(requests[1]).toMatchObject({
			method: "GET",
			url: "/1.0/operations/operation-1/wait?timeout=30",
		});
		expect(await client.getInstance("qorpera-runners", "missing")).toBeUndefined();
	});

	it("creates and reads a project-scoped custom filesystem volume", async () => {
		const requests: Array<{ method: string; url: string; body: unknown }> = [];
		const volumeRequest = createVolumeRequest();
		const socket = await unixServer((method, url, body) => {
			requests.push({ method, url, body });
			if (method === "POST" && url === "/1.0/storage-pools/qorpera-vm/volumes/custom?project=qorpera-runners") {
				return {
					body: { type: "sync", status: "Success", status_code: 200, metadata: {} },
				};
			}
			if (
				method === "GET" &&
				url ===
					"/1.0/storage-pools/qorpera-vm/volumes/custom/identity-20000000-0000-4000-8000-000000000011?project=qorpera-runners"
			) {
				return {
					body: {
						type: "sync",
						status: "Success",
						status_code: 200,
						metadata: volumeRequest,
					},
				};
			}
			throw new Error(`unexpected request ${method} ${url}`);
		});
		const client = new LxdUnixClient(socket, 30);

		await client.createStorageVolume("qorpera-runners", "qorpera-vm", volumeRequest);
		await expect(client.getStorageVolume("qorpera-runners", "qorpera-vm", volumeRequest.name)).resolves.toMatchObject(
			{
				name: volumeRequest.name,
				type: "custom",
				contentType: "filesystem",
				config: { size: "32GiB" },
			},
		);
		expect(requests[0]).toMatchObject({ method: "POST", body: volumeRequest });
	});

	it("deletes a custom volume: true when it existed, false when LXD had none, and throws when LXD refuses", async () => {
		const path =
			"/1.0/storage-pools/qorpera-vm/volumes/custom/identity-20000000-0000-4000-8000-000000000011?project=qorpera-runners";
		let answer: { status?: number; body: unknown } = {
			body: { type: "sync", status: "Success", status_code: 200, metadata: null },
		};
		const requests: string[] = [];
		const socket = await unixServer((method, url) => {
			requests.push(`${method} ${url}`);
			if (method === "DELETE" && url === path) return answer;
			throw new Error(`unexpected request ${method} ${url}`);
		});
		const client = new LxdUnixClient(socket, 30);
		const name = "identity-20000000-0000-4000-8000-000000000011";
		await expect(client.deleteStorageVolume("qorpera-runners", "qorpera-vm", name)).resolves.toBe(true);
		answer = { status: 404, body: { type: "error", error_code: 404, error: "Storage volume not found" } };
		await expect(client.deleteStorageVolume("qorpera-runners", "qorpera-vm", name)).resolves.toBe(false);
		answer = { status: 400, body: { type: "error", error_code: 400, error: "The storage volume is still in use" } };
		await expect(client.deleteStorageVolume("qorpera-runners", "qorpera-vm", name)).rejects.toThrow();
		await expect(client.deleteStorageVolume("qorpera-runners", "qorpera-vm", "../other")).rejects.toThrow(
			"LXD storage scope is invalid",
		);
		expect(requests).toEqual([`DELETE ${path}`, `DELETE ${path}`, `DELETE ${path}`]);
	});

	it("creates and deletes a project, whose answers are synchronous with null or empty metadata", async () => {
		const project = "qorpera-codehost-0123456789abcdef0123456789abcdef";
		const path = `/1.0/projects/${project}`;
		// LXD 6.9: a project's create answers with null metadata, its delete with an empty object.
		const created = { body: { type: "sync", status: "Success", status_code: 200, metadata: null } };
		const deleted = { body: { type: "sync", status: "Success", status_code: 200, metadata: {} } };
		let answer: { status?: number; body: unknown } = created;
		const requests: string[] = [];
		const posted: unknown[] = [];
		const socket = await unixServer((method, url, body) => {
			requests.push(`${method} ${url}`);
			if (method === "POST" && url === "/1.0/projects") {
				posted.push(body);
				return answer;
			}
			if (method === "DELETE" && url === path) return answer;
			throw new Error(`unexpected request ${method} ${url}`);
		});
		const client = new LxdUnixClient(socket, 30);
		await expect(client.createProject(project, { "features.images": "true" })).resolves.toBeUndefined();
		answer = { status: 409, body: { type: "error", error_code: 409, error: "The project already exists" } };
		await expect(client.createProject(project, {})).rejects.toThrow("LXD: The project already exists");
		answer = deleted;
		await expect(client.deleteProject(project)).resolves.toBe(true);
		answer = created;
		await expect(client.deleteProject(project)).resolves.toBe(true);
		answer = { status: 404, body: { type: "error", error_code: 404, error: "Project not found" } };
		await expect(client.deleteProject(project)).resolves.toBe(false);
		answer = { status: 400, body: { type: "error", error_code: 400, error: "Only empty projects can be removed" } };
		await expect(client.deleteProject(project)).rejects.toThrow("LXD: Only empty projects can be removed");
		// No operation is waited for.
		expect(requests).toEqual([...Array(2).fill("POST /1.0/projects"), ...Array(4).fill(`DELETE ${path}`)]);
		expect(posted).toEqual([
			{ name: project, description: "", config: { "features.images": "true" } },
			{ name: project, description: "", config: {} },
		]);
	});

	describe("an exec operation that fails", () => {
		const name = "qorpera-20000000000040008000000000000001";
		const agentOffline = "LXD VM agent is not currently running";
		async function exec(
			wait: { status?: number; body: unknown },
			post?: { status?: number; body: unknown },
			ended?: { status?: number; body: unknown },
		) {
			const socket = await unixServer((method, url) => {
				if (method === "POST" && url.includes("/exec?project="))
					return (
						post ?? {
							status: 202,
							body: {
								type: "async",
								status: "Operation created",
								status_code: 100,
								operation: "/1.0/operations/operation-3",
								metadata: {},
							},
						}
					);
				if (method === "GET" && url === "/1.0/operations/operation-3/wait?timeout=30") return wait;
				if (method === "GET" && url === "/1.0/operations/operation-3")
					return ended ?? { status: 404, body: { type: "error", error_code: 404, error: "not found" } };
				throw new Error(`unexpected request ${method} ${url}`);
			});
			return new LxdUnixClient(socket, 30).execInstance("coding", name, ["/usr/bin/systemctl", "is-active", "x"]);
		}
		// LXD 5.21-6.x: the wait writes its 200 header first, so the failed
		// operation's SmartError arrives as an error envelope under HTTP 200.
		const errorEnvelope = (error: string) => ({
			status: 200,
			body: { type: "error", status: "", status_code: 0, operation: "", error_code: 500, error, metadata: null },
		});
		// Newer LXD renders the failed operation itself.
		const failedOperation = (err: string) => ({
			body: {
				type: "sync",
				status: "Success",
				status_code: 200,
				operation: "",
				error_code: 0,
				error: "",
				metadata: {
					id: "operation-3",
					class: "task",
					description: "Executing command",
					status: "Failure",
					status_code: 400,
					resources: { instances: [`/1.0/instances/${name}?project=coding`] },
					metadata: null,
					may_cancel: false,
					err,
				},
			},
		});
		it.each([
			["an error envelope under HTTP 200 (LXD 5.21-6.x)", errorEnvelope(agentOffline)],
			["the failed operation (newer LXD)", failedOperation(agentOffline)],
			["the older wording", errorEnvelope("LXD VM agent isn't currently running")],
		])("names a VM agent that is not running yet: %s", async (_shape, wait) => {
			await expect(exec(wait)).rejects.toThrow(/^LXD instance agent not running$/);
		});
		it("names it when the exec request itself is refused for it", async () => {
			await expect(
				exec(errorEnvelope("unused"), {
					status: 500,
					body: { type: "error", error_code: 500, error: agentOffline, metadata: null },
				}),
			).rejects.toThrow(/^LXD instance agent not running$/);
		});
		it.each([
			["another failure as an error envelope", errorEnvelope("Instance is not running"), /^LXD operation failed$/],
			["another failed operation", failedOperation("Command not found"), /^LXD operation failed$/],
			[
				"a malformed wait reply",
				{ body: { type: "sync", status: "Success", status_code: 200, metadata: null } },
				/^LXD operation is invalid$/,
			],
			[
				"an unavailable operation",
				{ status: 404, body: { type: "error", error_code: 404, error: "not found" } },
				/^LXD: not found$/,
			],
		])("keeps %s a plain failure", async (_case, wait, expected) => {
			await expect(exec(wait)).rejects.toThrow(expected);
		});
		it("marks only an ended failure as definite, never a wait that returned it still running", async () => {
			// A provider releases a failed create's capacity only on proof that no guest will appear.
			await expect(exec(failedOperation("Command not found"))).rejects.toBeInstanceOf(LxdOperationFailed);
			// LXD 5.21-6.x writes the same error envelope for a failed operation and for a wait that timed
			// out: the operation's own end decides.
			const operationIs = (status: string, statusCode: number) => ({
				body: {
					type: "sync",
					status: "Success",
					status_code: 200,
					metadata: { status, status_code: statusCode, err: "" },
				},
			});
			await expect(
				exec(errorEnvelope("Instance is not running"), undefined, operationIs("Failure", 400)),
			).rejects.toBeInstanceOf(LxdOperationFailed);
			for (const ended of [operationIs("Running", 103), undefined]) {
				const timedOut = await exec(errorEnvelope("context deadline exceeded"), undefined, ended).catch(
					(error: unknown) => error,
				);
				expect(timedOut).toBeInstanceOf(Error);
				expect(timedOut).not.toBeInstanceOf(LxdOperationFailed);
			}
			const running = failedOperation("");
			running.body.metadata.status = "Running";
			running.body.metadata.status_code = 103;
			const pending = await exec(running).catch((error: unknown) => error);
			expect(pending).toBeInstanceOf(Error);
			expect(pending).not.toBeInstanceOf(LxdOperationFailed);
		});
		it("still separates a command that ran and exited non-zero", async () => {
			const ran = {
				body: {
					type: "sync",
					status: "Success",
					status_code: 200,
					metadata: { status: "Success", status_code: 200, err: "", metadata: { return: 3 } },
				},
			};
			await expect(exec(ran)).rejects.toThrow(/^LXD instance command failed$/);
		});
	});

	it("pushes root-owned private files and starts bootstrap through the VM agent", async () => {
		const requests: Array<{
			method: string;
			url: string;
			body: unknown;
			headers: IncomingHttpHeaders;
		}> = [];
		const socket = await unixServer((method, url, body, headers) => {
			requests.push({ method, url, body, headers });
			if (method === "POST" && url.includes("/files?path=")) {
				return { body: { type: "sync", status: "Success", status_code: 200, metadata: {} } };
			}
			if (method === "POST" && url.includes("/exec?project=")) {
				return {
					body: {
						type: "async",
						status: "Operation created",
						status_code: 100,
						operation: "/1.0/operations/operation-2",
						metadata: {},
					},
				};
			}
			if (method === "GET" && url === "/1.0/operations/operation-2/wait?timeout=30") {
				return {
					body: {
						type: "sync",
						status: "Success",
						status_code: 200,
						metadata: {
							status: "Success",
							status_code: 200,
							err: "",
							metadata: { return: 0 },
						},
					},
				};
			}
			throw new Error(`unexpected request ${method} ${url}`);
		});
		const client = new LxdUnixClient(socket, 30);

		await client.pushInstanceFile(
			"qorpera-runners",
			"qorpera-20000000000040008000000000000001",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-runner-activation",
			"private-token\n",
			0o600,
		);
		await client.execInstance("qorpera-runners", "qorpera-20000000000040008000000000000001", [
			"/usr/bin/systemctl",
			"enable",
			"--now",
			"qorpera-lxd-runner-bootstrap.service",
		]);

		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "/1.0/instances/qorpera-20000000000040008000000000000001/files?path=%2Fvar%2Flib%2Fqorpera-bootstrap%2Fcredentials%2Fqorpera-runner-activation&project=qorpera-runners",
			headers: {
				"content-type": "application/octet-stream",
				"x-lxd-type": "file",
				"x-lxd-uid": "0",
				"x-lxd-gid": "0",
				"x-lxd-mode": "0600",
				"x-lxd-modify-perm": "uid,gid,mode",
			},
		});
		expect(Buffer.isBuffer(requests[0]?.body)).toBe(true);
		expect((requests[0]?.body as Buffer).toString("utf-8")).toBe("private-token\n");
		expect(requests[1]).toMatchObject({
			method: "POST",
			body: {
				command: ["/usr/bin/systemctl", "enable", "--now", "qorpera-lxd-runner-bootstrap.service"],
				interactive: false,
				"wait-for-websocket": false,
				"record-output": true,
				user: 0,
				group: 0,
			},
		});
	});

	it("waits longer for one command only when asked, within 600 seconds", async () => {
		const waits: string[] = [];
		const socket = await unixServer((method, url) => {
			if (method === "POST" && url.includes("/exec?project="))
				return {
					body: {
						type: "async",
						status: "Operation created",
						status_code: 100,
						operation: `/1.0/operations/operation-${waits.length}`,
						metadata: {},
					},
				};
			if (method === "GET" && url.includes("/wait?timeout=")) {
				waits.push(url);
				return {
					body: {
						type: "sync",
						status: "Success",
						status_code: 200,
						metadata: { status: "Success", status_code: 200, err: "", metadata: { return: 0 } },
					},
				};
			}
			throw new Error(`unexpected request ${method} ${url}`);
		});
		const client = new LxdUnixClient(socket, 30);
		await client.execInstance("coding", "qorpera-coding-x", ["/usr/bin/true"], undefined, 600);
		await client.execInstance("coding", "qorpera-coding-x", ["/usr/bin/true"]);
		expect(waits).toEqual([
			"/1.0/operations/operation-0/wait?timeout=600",
			"/1.0/operations/operation-1/wait?timeout=30",
		]);
		for (const wait of [0, 601, 1.5])
			await expect(
				client.execInstance("coding", "qorpera-coding-x", ["/usr/bin/true"], undefined, wait),
			).rejects.toThrow(/^LXD instance command is invalid$/);
		expect(waits).toHaveLength(2);
	});

	it("pushes a guest program's bytes as root's file, only into the guest's program folders", async () => {
		const requests: Array<{ url: string; body: unknown; headers: IncomingHttpHeaders }> = [];
		const socket = await unixServer((method, url, body, headers) => {
			requests.push({ url, body, headers });
			if (method === "POST" && url.includes("/files?path=")) {
				return { body: { type: "sync", status: "Success", status_code: 200, metadata: {} } };
			}
			throw new Error(`unexpected request ${method} ${url}`);
		});
		const client = new LxdUnixClient(socket, 30);
		const name = "qorpera-coding-machine-20000000000040008000000000000001";
		// Past the 256 KiB text file's bound, and not UTF-8.
		const program = Buffer.alloc(300 * 1024, 0xff);

		await client.pushInstanceProgram(
			"qorpera-coding",
			name,
			"/opt/qorpera-folder/qorpera-folder.1d7e0a9c.new",
			program,
			0o555,
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: `/1.0/instances/${name}/files?path=%2Fopt%2Fqorpera-folder%2Fqorpera-folder.1d7e0a9c.new&project=qorpera-coding`,
			headers: {
				"content-type": "application/octet-stream",
				"x-lxd-type": "file",
				"x-lxd-uid": "0",
				"x-lxd-gid": "0",
				"x-lxd-mode": "0555",
				"x-lxd-modify-perm": "uid,gid,mode",
			},
		});
		expect(Buffer.compare(requests[0]?.body as Buffer, program)).toBe(0);

		const push = (path: string, content: Buffer = program, mode = 0o444) =>
			client.pushInstanceProgram("qorpera-coding", name, path, content, mode);
		await push("/opt/qorpera-guest/agent.mjs.3c2b.new");
		expect(requests).toHaveLength(2);
		for (const path of [
			"/opt/qorpera-guest",
			"/opt/qorpera-guest/",
			"/opt/qorpera-guest/.agent.mjs",
			"/opt/qorpera-guest/sub/agent.mjs",
			"/opt/qorpera-guest/../../etc/passwd",
			"/opt/qorpera-other/agent.mjs",
			"/etc/qorpera-guest/agent.mjs",
			"/opt/qorpera-guest/agent.mjs\n",
		])
			await expect(push(path)).rejects.toThrow("LXD instance program path is invalid");
		await expect(push("/opt/qorpera-guest/agent.mjs", program, 0o1777)).rejects.toThrow(
			"LXD instance program mode is invalid",
		);
		await expect(push("/opt/qorpera-guest/agent.mjs", Buffer.alloc(0))).rejects.toThrow(
			"LXD instance program exceeds the supported size",
		);
		await expect(push("/opt/qorpera-guest/agent.mjs", Buffer.alloc(16 * 1024 * 1024 + 1))).rejects.toThrow(
			"LXD instance program exceeds the supported size",
		);
		expect(requests).toHaveLength(2);
	});
});

const EXEC_OPERATION = "/1.0/operations/3f0b8f8e-4c1d-4e2a-9b7c-0d1e2f3a4b5c";
const EXEC_SECRETS = { "0": "a".repeat(64), "1": "b".repeat(64), "2": "c".repeat(64), control: "d".repeat(64) };

interface ExecStreamCommand {
	stdout?: Buffer[];
	stderr?: Buffer[];
	exitCode?: number;
	/** Keeps running after its output until LXD kills it (its stdout websocket closed early). */
	hold?: boolean;
	/** Closes its stdout websocket without the end message. */
	dropStdout?: boolean;
}

/** LXD's non-interactive exec with `wait-for-websocket` on a Unix socket: it starts the command once fds 0, 1 and 2
 * are connected, hands it stdin up to the text message that ends it, sends its output as binary messages with an
 * empty text message at each stream's end, and kills it (137) when its stdout websocket closes while it runs. */
class FakeExecStream {
	readonly posts: unknown[] = [];
	readonly upgrades: string[] = [];
	stdin = Buffer.alloc(0);
	stdinEnded = false;
	killed = false;
	socket = "";
	/** The fd whose upgrade it never answers, as an LXD that stalls the handshake. */
	withhold?: string;
	withheldSeen = false;
	withheldClosed = false;
	readonly #sockets = new Set<Socket>();
	readonly #connected = new Map<string, Socket>();
	#ended?: number;
	readonly #waiters: Array<(exitCode: number) => void> = [];
	readonly #command: (stdin: Buffer) => ExecStreamCommand;

	constructor(command: (stdin: Buffer) => ExecStreamCommand) {
		this.#command = command;
	}

	async start(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "qorpera-lxd-exec-"));
		roots.push(root);
		this.socket = join(root, "lxd.socket");
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const reply = (status: number, body: unknown) =>
					response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
				if (request.method === "POST" && request.url?.startsWith("/1.0/instances/coding-vm/exec?project=coding")) {
					this.posts.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
					reply(202, {
						type: "async",
						status: "Operation created",
						status_code: 100,
						operation: EXEC_OPERATION,
						metadata: { id: EXEC_OPERATION.slice(16), class: "websocket", metadata: { fds: EXEC_SECRETS } },
					});
				} else if (request.method === "GET" && request.url === `${EXEC_OPERATION}/wait?timeout=30`) {
					const answer = (exitCode: number) =>
						reply(200, {
							type: "sync",
							status: "Success",
							status_code: 200,
							metadata: { status: "Success", status_code: 200, err: "", metadata: { return: exitCode } },
						});
					if (this.#ended === undefined) this.#waiters.push(answer);
					else answer(this.#ended);
				} else reply(404, { type: "error", error_code: 404, error: "not found" });
			});
		});
		server.on("upgrade", (request: IncomingMessage, socket: Socket) => this.#upgrade(request, socket));
		servers.push(server);
		await new Promise<void>((resolveListen) => server.listen(this.socket, () => resolveListen()));
		return this.socket;
	}

	close(): void {
		for (const socket of this.#sockets) socket.destroy();
	}

	#upgrade(request: IncomingMessage, socket: Socket): void {
		this.#sockets.add(socket);
		const url = new URL(request.url ?? "/", "http://lxd");
		const fd = Object.entries(EXEC_SECRETS).find(([, secret]) => secret === url.searchParams.get("secret"))?.[0];
		const key = request.headers["sec-websocket-key"];
		if (url.pathname !== `${EXEC_OPERATION}/websocket` || !fd || fd === "control" || typeof key !== "string") {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		if (fd === this.withhold) {
			this.withheldSeen = true;
			// Reads on, so the client's end of the connection is seen; the server keeps its sockets half open.
			const closed = (): void => {
				this.withheldClosed = true;
				socket.destroy();
			};
			socket.once("end", closed);
			socket.once("error", closed);
			socket.once("close", closed);
			socket.resume();
			return;
		}
		this.upgrades.push(fd);
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		this.#connected.set(fd, socket);
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.byteLength < 2) return;
				const opcode = buffer[0]! & 0x0f;
				let length = buffer[1]! & 0x7f;
				let offset = 2;
				if (length === 126) {
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					length = buffer.readUInt32BE(6);
					offset = 10;
				}
				if (buffer.byteLength < offset + 4 + length) return;
				const mask = buffer.subarray(offset, offset + 4);
				const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
				for (let index = 0; index < payload.byteLength; index++)
					payload[index] = payload[index]! ^ mask[index & 3]!;
				buffer = buffer.subarray(offset + 4 + length);
				if (opcode === 0x8) {
					socket.end(serverFrame(0x8, payload));
					this.#closedEarly(fd);
					return;
				}
				if (fd !== "0" || this.stdinEnded) continue;
				if (opcode === 0x2) this.stdin = Buffer.concat([this.stdin, payload]);
				else if (opcode === 0x1) {
					this.stdinEnded = true;
					this.#run();
				}
			}
		});
		socket.on("close", () => this.#closedEarly(fd));
	}

	#closedEarly(fd: string): void {
		if (fd !== "1" || this.#ended !== undefined) return;
		this.killed = true;
		this.#end(137);
	}

	#run(): void {
		if (!["0", "1", "2"].every((fd) => this.#connected.has(fd))) throw new Error("the command started early");
		const command = this.#command(this.stdin);
		const stdout = this.#connected.get("1")!;
		const stderr = this.#connected.get("2")!;
		for (const chunk of command.stdout ?? []) stdout.write(serverFrame(0x2, chunk));
		for (const chunk of command.stderr ?? []) stderr.write(serverFrame(0x2, chunk));
		if (command.hold) return;
		if (command.dropStdout) {
			this.#end(command.exitCode ?? 0);
			stdout.destroy();
		} else {
			stdout.write(serverFrame(0x1, Buffer.alloc(0)));
			stderr.write(serverFrame(0x1, Buffer.alloc(0)));
			this.#end(command.exitCode ?? 0);
		}
	}

	#end(exitCode: number): void {
		if (this.#ended !== undefined) return;
		this.#ended = exitCode;
		for (const waiter of this.#waiters.splice(0)) waiter(exitCode);
	}
}

describe("LXD exec stream", () => {
	const fakes: FakeExecStream[] = [];
	afterEach(() => {
		for (const fake of fakes.splice(0)) fake.close();
	});
	async function fake(command: (stdin: Buffer) => ExecStreamCommand): Promise<FakeExecStream> {
		const exec = new FakeExecStream(command);
		fakes.push(exec);
		await exec.start();
		return exec;
	}
	const request = {
		command: ["/usr/bin/node", "/opt/qorpera-guest/agent.mjs", "status"],
		stdin: Buffer.from('{"pass":"p"}'),
		maxStdoutBytes: 64,
		maxStderrBytes: 16,
		timeoutMs: 10_000,
	};

	it("hands the command its stdin and reads its output off the stream, with nothing recorded on the host", async () => {
		const exec = await fake((stdin) => ({
			stdout: [Buffer.from("echo:"), stdin],
			stderr: [Buffer.from("note")],
			exitCode: 3,
		}));
		const result = await new LxdUnixClient(exec.socket, 30).execInstanceStream("coding", "coding-vm", request);
		expect(result).toEqual({
			exitCode: 3,
			stdout: Buffer.from('echo:{"pass":"p"}'),
			stderr: Buffer.from("note"),
		});
		expect(exec.posts).toEqual([
			{
				command: request.command,
				interactive: false,
				"wait-for-websocket": true,
				"record-output": false,
				user: 0,
				group: 0,
				cwd: "/",
				environment: {},
			},
		]);
		// stdin is in no request body; the control websocket stays unconnected.
		expect(JSON.stringify(exec.posts)).not.toContain("pass");
		expect(exec.upgrades.sort()).toEqual(["0", "1", "2"]);
		expect(exec.stdinEnded).toBe(true);
		expect(exec.killed).toBe(false);
	});

	it("closes stdin at once when there is none", async () => {
		const exec = await fake(() => ({ stdout: [Buffer.from("ok")] }));
		const result = await new LxdUnixClient(exec.socket, 30).execInstanceStream("coding", "coding-vm", {
			...request,
			stdin: Buffer.alloc(0),
		});
		expect(result.stdout.toString()).toBe("ok");
		expect(exec.stdin.byteLength).toBe(0);
		expect(exec.stdinEnded).toBe(true);
	});

	it("kills a command whose output passes its bound and fails", async () => {
		const exec = await fake(() => ({ stdout: [Buffer.alloc(40), Buffer.alloc(40)], hold: true }));
		await expect(
			new LxdUnixClient(exec.socket, 30).execInstanceStream("coding", "coding-vm", request),
		).rejects.toThrow("LXD exec stream output exceeded its bound");
		await vi.waitFor(() => expect(exec.killed).toBe(true));
	});

	it("kills a command still running at its deadline or when its signal stops it", async () => {
		const timed = await fake(() => ({ stdout: [Buffer.from("partial")], hold: true }));
		await expect(
			new LxdUnixClient(timed.socket, 30).execInstanceStream("coding", "coding-vm", { ...request, timeoutMs: 300 }),
		).rejects.toThrow("LXD exec stream was stopped");
		await vi.waitFor(() => expect(timed.killed).toBe(true));
		const stopped = await fake(() => ({ hold: true }));
		const controller = new AbortController();
		const call = new LxdUnixClient(stopped.socket, 30).execInstanceStream(
			"coding",
			"coding-vm",
			request,
			controller.signal,
		);
		await vi.waitFor(() => expect(stopped.stdinEnded).toBe(true));
		controller.abort();
		await expect(call).rejects.toThrow("LXD exec stream was stopped");
		await vi.waitFor(() => expect(stopped.killed).toBe(true));
	});

	it("stops a handshake LXD never answers at the deadline or on the signal, well before its own timeout", async () => {
		const timed = await fake(() => ({ hold: true }));
		timed.withhold = "2";
		const started = Date.now();
		await expect(
			new LxdUnixClient(timed.socket, 30).execInstanceStream("coding", "coding-vm", { ...request, timeoutMs: 300 }),
		).rejects.toThrow("LXD exec stream was stopped");
		// The handshake's own timeout is 10 s.
		expect(Date.now() - started).toBeLessThan(3_000);
		await vi.waitFor(() => expect(timed.withheldClosed).toBe(true));
		// The stdout websocket already connected is closed too.
		expect(timed.upgrades).toEqual(["1"]);
		await vi.waitFor(() => expect(timed.killed).toBe(true));
		const stopped = await fake(() => ({ hold: true }));
		stopped.withhold = "1";
		const controller = new AbortController();
		const call = new LxdUnixClient(stopped.socket, 30).execInstanceStream(
			"coding",
			"coding-vm",
			request,
			controller.signal,
		);
		await vi.waitFor(() => expect(stopped.withheldSeen).toBe(true));
		const abortedAt = Date.now();
		controller.abort();
		await expect(call).rejects.toThrow("LXD exec stream was stopped");
		expect(Date.now() - abortedAt).toBeLessThan(1_000);
		await vi.waitFor(() => expect(stopped.withheldClosed).toBe(true));
		expect(stopped.upgrades).toEqual([]);
		expect(stopped.stdinEnded).toBe(false);
	});

	it("fails when a stream ends without its end message", async () => {
		const exec = await fake(() => ({ stdout: [Buffer.from("cut")], dropStdout: true }));
		await expect(
			new LxdUnixClient(exec.socket, 30).execInstanceStream("coding", "coding-vm", request),
		).rejects.toThrow("LXD exec stream ended before its output");
	});

	it("refuses an invalid command, input or bound before asking LXD", async () => {
		const exec = await fake(() => ({}));
		const client = new LxdUnixClient(exec.socket, 30);
		for (const invalid of [
			{ ...request, command: [] },
			{ ...request, command: ["/usr/bin/node", "a\nb"] },
			{ ...request, stdin: Buffer.alloc(64 * 1024 + 1) },
			{ ...request, maxStdoutBytes: 8 * 1024 * 1024 + 1 },
			{ ...request, maxStderrBytes: -1 },
			{ ...request, timeoutMs: 0 },
			{ ...request, timeoutMs: 30_001 },
		])
			await expect(client.execInstanceStream("coding", "coding-vm", invalid)).rejects.toThrow(
				"LXD instance command is invalid",
			);
		expect(exec.posts).toEqual([]);
	});
});
