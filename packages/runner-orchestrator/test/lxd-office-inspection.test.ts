import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const roots: string[] = [];
const servers: Server[] = [];
const certificate = rootCertificates[0]; // Public fixture bytes only; no test or release signing.
const certificateSha256 = new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase();
const fingerprint = "a".repeat(64);
const serverRecord = () => ({
	auth: "trusted",
	auth_user_method: "unix",
	api_version: "1.0",
	api_status: "stable",
	public: false,
	environment: {
		server: "lxd",
		kernel: "Linux",
		server_clustered: false,
		project: "offices",
		driver: "lxc | qemu",
		instance_types: ["container", "virtual-machine"],
		certificate,
		certificate_fingerprint: certificateSha256,
		server_name: "office-provider",
		server_version: "6.9",
		kernel_architecture: "x86_64",
	},
});
const imageRecord = () => ({
	fingerprint,
	architecture: "x86_64",
	size: 1024,
	type: "virtual-machine",
	public: false,
	auto_update: false,
	profiles: [],
});
// The agents' bridge as LXD shows a bridge it does not manage, in its default project.
const agentBridge = () => ({ name: "qagent0", type: "bridge", managed: false, status: "", config: {}, used_by: [] });
function infrastructureReply(
	request: IncomingMessage,
	i: { project: unknown; network: unknown; storagePool: unknown },
	agent: unknown = agentBridge(),
) {
	if (request.url === "/1.0/networks/qagent0") return agent;
	return request.url?.includes("/projects/")
		? i.project
		: request.url?.includes("/networks/")
			? i.network
			: i.storagePool;
}
function send(response: ServerResponse, metadata: unknown, status = 200) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify({ type: "sync", status_code: 200, metadata }));
}
async function fixture(handle: (request: IncomingMessage, response: ServerResponse) => void) {
	const root = await mkdtemp(join(tmpdir(), "lxd-inspect-"));
	roots.push(root);
	const socket = join(root, "socket");
	const calls: string[] = [];
	const server = createServer((request, response) => {
		calls.push(`${request.method} ${request.url}`);
		handle(request, response);
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	const client = new LxdUnixClient(socket);
	return {
		calls,
		server: (signal = new AbortController().signal) => client.inspectOfficeServer("offices", signal),
		image: (signal = new AbortController().signal) => client.inspectOfficeImage("offices", fingerprint, signal),
		client,
	};
}
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("read-only physical office metadata over Unix HTTP", () => {
	it("reads the exact project, effective network and global storage pool without mutable usage metadata", async () => {
		const { infrastructure } = officePhysicalFixture();
		const f = await fixture((request, response) =>
			send(
				response,
				infrastructureReply(request, {
					...infrastructure,
					project: { ...infrastructure.project, replica_mode: "", used_by: ["ignored"] },
				}),
			),
		);
		await expect(
			f.client.inspectOfficeInfrastructure("offices", "office-net", "office-pool", new AbortController().signal),
		).resolves.toEqual(infrastructure);
		expect(f.calls).toEqual([
			"GET /1.0/projects/offices",
			"GET /1.0/networks/office-net?project=offices",
			"GET /1.0/storage-pools/office-pool",
			"GET /1.0/networks/qagent0",
		]);
	});
	it.each([
		["name", "other-bridge"],
		["type", "physical"],
		["managed", true],
		["managed", undefined],
	])("refuses an agents' bridge whose %s is %s", async (field, value) => {
		const { infrastructure } = officePhysicalFixture();
		const f = await fixture((request, response) =>
			send(response, infrastructureReply(request, infrastructure, { ...agentBridge(), [field]: value })),
		);
		await expect(
			f.client.inspectOfficeInfrastructure("offices", "office-net", "office-pool", new AbortController().signal),
		).rejects.toThrow("LXD_OFFICE_INFRASTRUCTURE_UNCONFIRMED");
	});
	it("reads the agents' bridge however many machines are plugged into it", async () => {
		const { infrastructure } = officePhysicalFixture();
		const used = Array.from(
			{ length: 2000 },
			(_, i) => `/1.0/instances/qorpera-coding-machine-${i.toString(16).padStart(32, "0")}?project=machines`,
		);
		const f = await fixture((request, response) =>
			send(response, infrastructureReply(request, infrastructure, { ...agentBridge(), used_by: used })),
		);
		await expect(
			f.client.inspectOfficeInfrastructure("offices", "office-net", "office-pool", new AbortController().signal),
		).resolves.toEqual(infrastructure);
	});
	it.each([
		[{ restricted: "true" }, false],
		[{ restricted: "true", "restricted.devices.nic": "managed" }, false],
		[{ restricted: "true", "restricted.devices.nic": "block" }, false],
		[{ restricted: "true", "restricted.devices.nic": "allow" }, true],
		[{ restricted: "false", "restricted.devices.nic": "managed" }, true],
	])("allows the agent card only in a project that allows it: %j", async (restrictions, allowed) => {
		const { infrastructure: i } = officePhysicalFixture();
		Object.assign(i.project.config, restrictions);
		const f = await fixture((request, response) => send(response, infrastructureReply(request, i)));
		const inspected = f.client.inspectOfficeInfrastructure(
			"offices",
			"office-net",
			"office-pool",
			new AbortController().signal,
		);
		if (allowed) await expect(inspected).resolves.toEqual(i);
		else await expect(inspected).rejects.toThrow("LXD_OFFICE_INFRASTRUCTURE_UNCONFIRMED");
	});
	it("refuses a node without the agents' bridge", async () => {
		const { infrastructure } = officePhysicalFixture();
		const f = await fixture((request, response) =>
			request.url === "/1.0/networks/qagent0"
				? send(response, null, 404)
				: send(response, infrastructureReply(request, infrastructure)),
		);
		await expect(
			f.client.inspectOfficeInfrastructure("offices", "office-net", "office-pool", new AbortController().signal),
		).rejects.toThrow("LXD_OFFICE_INFRASTRUCTURE_UNCONFIRMED");
		expect(f.calls.at(-1)).toBe("GET /1.0/networks/qagent0");
	});
	it.each([
		["project", "name", "another-project"],
		["project", "replica_mode", "standby"],
		["project", "config", null],
		["network", "name", "other-network"],
		["network", "project", "foreign"],
		["network", "type", "physical"],
		["network", "managed", false],
		["network", "status", "Pending"],
		["storagePool", "name", "other-pool"],
		["storagePool", "driver", "ceph"],
		["storagePool", "status", "Unavailable"],
	])("refuses unsupported infrastructure field %s.%s", async (section, field, value) => {
		const { infrastructure } = officePhysicalFixture();
		const changed = {
			...infrastructure,
			[section as string]: { ...infrastructure[section as keyof typeof infrastructure], [field as string]: value },
		};
		const f = await fixture((request, response) => send(response, infrastructureReply(request, changed)));
		await expect(
			f.client.inspectOfficeInfrastructure("offices", "office-net", "office-pool", new AbortController().signal),
		).rejects.toThrow("LXD_OFFICE_INFRASTRUCTURE_UNCONFIRMED");
	});
	it.each([
		["ipv4.nat", "false"],
		["ipv6.address", "auto"],
		["ipv4.firewall", "false"],
		["bridge.external_interfaces", "eth0"],
		["security.acls", "mutable-acl"],
	])("refuses an unsupported effective bridge option %s", async (key, value) => {
		const { infrastructure: i } = officePhysicalFixture();
		i.network.config[key] = value;
		const f = await fixture((request, response) => send(response, infrastructureReply(request, i)));
		await expect(
			f.client.inspectOfficeInfrastructure("offices", "office-net", "office-pool", new AbortController().signal),
		).rejects.toThrow();
	});
	it("bounds stalled infrastructure inspection and honors cancellation without subsequent lookups", async () => {
		const f = await fixture((_request, response) => {
			response.writeHead(200);
			response.flushHeaders();
		});
		await expect(
			f.client.inspectOfficeInfrastructure("offices", "office-net", "office-pool", new AbortController().signal),
		).rejects.toThrow("LXD_OFFICE_INFRASTRUCTURE_UNCONFIRMED");
		expect(f.calls).toHaveLength(1);
		await expect(
			f.client.inspectOfficeInfrastructure("offices", "office-net", "office-pool", AbortSignal.abort()),
		).rejects.toThrow();
		expect(f.calls).toHaveLength(1);
	}, 10000);
	it("derives the certificate fingerprint from actual PEM and reads the exact project/image without mutation", async () => {
		const f = await fixture((request, response) =>
			send(response, request.url?.startsWith("/1.0/images") ? imageRecord() : serverRecord()),
		);
		await expect(f.server()).resolves.toEqual({
			project: "offices",
			certificateSha256,
			serverName: "office-provider",
			serverVersion: "6.9",
			architecture: "x86_64",
		});
		await expect(f.image()).resolves.toEqual({ fingerprint, architecture: "x86_64", size: 1024 });
		expect(f.calls).toEqual(["GET /1.0?project=offices", `GET /1.0/images/${fingerprint}?project=offices`]);
	});
	it.each([
		"server",
		"kernel",
		"server_clustered",
		"project",
		"driver",
		"instance_types",
		"certificate",
		"certificate_fingerprint",
		"server_name",
		"server_version",
		"kernel_architecture",
	])("rejects invalid daemon field %s", async (field) => {
		const value = serverRecord();
		const f = await fixture((_request, response) =>
			send(response, { ...value, environment: { ...value.environment, [field]: "invalid value" } }),
		);
		await expect(f.server()).rejects.toThrow("LXD_OFFICE_SERVER_UNCONFIRMED");
	});
	it.each(["auth", "auth_user_method", "api_version", "api_status", "public"])(
		"rejects invalid server envelope field %s",
		async (field) => {
			const f = await fixture((_request, response) => send(response, { ...serverRecord(), [field]: "untrusted" }));
			await expect(f.server()).rejects.toThrow("LXD_OFFICE_SERVER_UNCONFIRMED");
		},
	);
	it("rejects a well-formed but wrong reported certificate digest", async () => {
		const value = serverRecord();
		value.environment.certificate_fingerprint = "f".repeat(64);
		const f = await fixture((_request, response) => send(response, value));
		await expect(f.server()).rejects.toThrow("LXD_OFFICE_SERVER_UNCONFIRMED");
	});
	it.each(["fingerprint", "type", "public", "auto_update", "architecture", "size", "profiles"])(
		"rejects invalid image field %s",
		async (field) => {
			const f = await fixture((_request, response) => send(response, { ...imageRecord(), [field]: "invalid" }));
			await expect(f.image()).rejects.toThrow("LXD_OFFICE_IMAGE_UNCONFIRMED");
		},
	);
	it("rejects inherited image profiles and a mutable image alias before lookup", async () => {
		const f = await fixture((_request, response) => send(response, { ...imageRecord(), profiles: ["default"] }));
		await expect(f.image()).rejects.toThrow("LXD_OFFICE_IMAGE_UNCONFIRMED");
		await expect(f.client.inspectOfficeImage("offices", "latest", new AbortController().signal)).rejects.toThrow(
			"LXD_OFFICE_IMAGE_UNCONFIRMED",
		);
		expect(f.calls).toHaveLength(1);
	});
	it.each(["server", "image"] as const)(
		"denies redirects, missing images and oversized/truncated/invalid-UTF8 %s responses",
		async (method) => {
			const responses = [
				(response: ServerResponse) => {
					response.writeHead(302, { location: "https://untrusted.test" });
					response.end();
				},
				(response: ServerResponse) => send(response, {}, 404),
				(response: ServerResponse) => response.end(" ".repeat(65537)),
				(response: ServerResponse) => {
					response.writeHead(200, { "content-length": 100 });
					response.write("{}", () => response.socket?.destroy());
				},
				(response: ServerResponse) => response.end(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])),
			];
			for (const respond of responses) {
				const f = await fixture((_request, response) => respond(response));
				await expect(f[method]()).rejects.toThrow(`LXD_OFFICE_${method.toUpperCase()}_UNCONFIRMED`);
				expect(f.calls).toHaveLength(1);
			}
		},
	);
	it.each(["server", "image"] as const)(
		"bounds an entirely stalled %s response",
		async (method) => {
			const f = await fixture((_request, response) => {
				response.writeHead(200);
				response.flushHeaders();
			});
			await expect(f[method]()).rejects.toThrow(`LXD_OFFICE_${method.toUpperCase()}_UNCONFIRMED`);
			expect(f.calls).toHaveLength(1);
		},
		10000,
	);
	it.each(["server", "image"] as const)("honors cancellation during %s inspection", async (method) => {
		const stop = new AbortController();
		const f = await fixture((_request, response) => {
			response.writeHead(200);
			response.flushHeaders();
			stop.abort();
		});
		await expect(f[method](stop.signal)).rejects.toThrow(`LXD_OFFICE_${method.toUpperCase()}_UNCONFIRMED`);
		expect(f.calls).toHaveLength(1);
	});
});
