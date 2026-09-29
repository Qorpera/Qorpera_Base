import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
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
			const encoded = Buffer.concat(chunks).toString("utf-8");
			const body =
				request.headers["content-type"] === "application/json"
					? encoded
						? (JSON.parse(encoded) as unknown)
						: null
					: Buffer.from(encoded, "utf-8");
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
});
