import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type LxdCreateInstanceRequest, type LxdCreateStorageVolumeRequest, LxdUnixClient } from "../src/lxd-client.ts";
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
	) => { status?: number; body: unknown },
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
			response.writeHead(result.status ?? 200, { "content-type": "application/json" });
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
