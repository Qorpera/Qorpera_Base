import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES,
	COMPANY_COMPUTER_BOOT_SERVICE_RESTART_MAX_BYTES,
	COMPANY_COMPUTER_BOOT_SERVICE_START_MAX_BYTES,
	COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES,
	COMPANY_COMPUTER_RESET_SERVICE_RESTART_MAX_BYTES,
	COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES,
	COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES,
	COMPANY_COMPUTER_SERVICE_START_MAX_BYTES,
	COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";

const roots: string[] = [],
	servers: Server[] = [];
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const signal = () => new AbortController().signal;
async function fixture(handle: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void) {
	const root = await mkdtemp(join(tmpdir(), "office-preparation-transport-"));
	roots.push(root);
	const socket = join(root, "socket");
	const failures: unknown[] = [],
		calls: string[] = [];
	const server = createServer((request, response) => {
		calls.push(`${request.method} ${request.url}`);
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			try {
				handle(request, response, Buffer.concat(chunks));
			} catch (error) {
				failures.push(error);
				response.writeHead(500);
				response.end();
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	return { client: new LxdUnixClient(socket), failures, calls };
}
function bytes(response: ServerResponse, content: Buffer, headers: Record<string, string> = {}) {
	response.writeHead(200, {
		"content-type": "application/octet-stream",
		"x-lxd-type": "file",
		"x-lxd-uid": "0",
		"x-lxd-gid": "0",
		"x-lxd-mode": "0400",
		...headers,
	});
	response.end(content);
}
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
for (const lane of [
	{
		name: "reset-service-restart",
		push: "pushOfficeResetServiceRestartRequest",
		read: "readOfficeResetServiceRestartRequest",
		maximum: COMPANY_COMPUTER_RESET_SERVICE_RESTART_MAX_BYTES,
		sample: 16384,
		prefix: "reset-service-restart-incoming",
		error: "RESET_SERVICE_RESTART",
	},
	{
		name: "boot-service-restart",
		push: "pushOfficeBootServiceRestartRequest",
		read: "readOfficeBootServiceRestartRequest",
		maximum: COMPANY_COMPUTER_BOOT_SERVICE_RESTART_MAX_BYTES,
		sample: 16384,
		prefix: "boot-service-restart-incoming",
		error: "BOOT_SERVICE_RESTART",
	},
	{
		name: "boot-service-start",
		push: "pushOfficeBootServiceStartRequest",
		read: "readOfficeBootServiceStartRequest",
		maximum: COMPANY_COMPUTER_BOOT_SERVICE_START_MAX_BYTES,
		sample: 8192,
		prefix: "boot-service-start-incoming",
		error: "BOOT_SERVICE_START",
	},
	{
		name: "boot-configuration",
		push: "pushOfficeBootConfigurationRequest",
		read: "readOfficeBootConfigurationRequest",
		maximum: COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES,
		sample: 128 * 1024,
		prefix: "boot-configuration-incoming",
		error: "BOOT_CONFIGURATION",
	},
	{
		name: "preparation",
		push: "pushOfficePreparationRequest",
		read: "readOfficePreparationRequest",
		maximum: COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
		sample: 2 * 1024 ** 2,
		prefix: "incoming",
		error: "PREPARATION",
	},
	{
		name: "configuration",
		push: "pushOfficeConfigurationRequest",
		read: "readOfficeConfigurationRequest",
		maximum: COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES,
		sample: 96 * 1024,
		prefix: "configuration-incoming",
		error: "CONFIGURATION",
	},
	{
		name: "service-start",
		push: "pushOfficeServiceStartRequest",
		read: "readOfficeServiceStartRequest",
		maximum: COMPANY_COMPUTER_SERVICE_START_MAX_BYTES,
		sample: 8192,
		prefix: "service-start-incoming",
		error: "SERVICE_START",
	},
	{
		name: "service-stop",
		push: "pushOfficeServiceStopRequest",
		read: "readOfficeServiceStopRequest",
		maximum: COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES,
		sample: 8192,
		prefix: "service-stop-incoming",
		error: "SERVICE_STOP",
	},
	{
		name: "service-restart",
		push: "pushOfficeServiceRestartRequest",
		read: "readOfficeServiceRestartRequest",
		maximum: COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES,
		sample: 8192,
		prefix: "service-restart-incoming",
		error: "SERVICE_RESTART",
	},
	{
		name: "reset-configuration",
		push: "pushOfficeResetConfigurationRequest",
		read: "readOfficeResetConfigurationRequest",
		maximum: COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES,
		sample: 128 * 1024,
		prefix: "reset-configuration-incoming",
		error: "RESET_CONFIGURATION",
	},
	{
		name: "reset-service-start",
		push: "pushOfficeResetServiceStartRequest",
		read: "readOfficeResetServiceStartRequest",
		maximum: COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES,
		sample: 8192,
		prefix: "reset-service-start-incoming",
		error: "RESET_SERVICE_START",
	},
] as const)
	describe(`bounded content-addressed office ${lane.name} staging`, () => {
		it.each([lane.sample, lane.maximum])(
			"uploads and verifies exactly %i bytes using only the protected staging path",
			async (length) => {
				const content = Buffer.alloc(length, 31),
					sha256 = digest(content);
				const f = await fixture((request, response, body) => {
					if (request.method === "POST") {
						expect(body.equals(content)).toBe(true);
						expect(request.headers["x-lxd-mode"]).toBe("0400");
						expect(request.headers["x-lxd-uid"]).toBe("0");
						expect(request.headers["x-lxd-gid"]).toBe("0");
						response.writeHead(200, { "content-type": "application/json" });
						response.end(JSON.stringify({ type: "sync", status_code: 200, metadata: {} }));
					} else bytes(response, content, { "content-length": String(content.length) });
				});
				await f.client[lane.push]("offices", "office-fixture", sha256, content, signal());
				const read = await f.client[lane.read]("offices", "office-fixture", sha256, length, signal());
				expect(read.content.equals(content)).toBe(true);
				expect([read.uid, read.gid, read.mode]).toEqual([0, 0, 0o400]);
				const path = `/1.0/instances/office-fixture/files?path=${encodeURIComponent(`/run/qorpera-office-preparation/${lane.prefix}-${sha256}.json`)}&project=offices`;
				expect(f.calls).toEqual([`POST ${path}`, `GET ${path}`]);
				expect(f.failures).toEqual([]);
			},
		);
		it.each([0, -1, 1.5, lane.maximum + 1])("refuses an invalid read limit %s before HTTP", async (length) => {
			const f = await fixture(() => {
				throw new Error("unexpected request");
			});
			await expect(f.client[lane.read]("offices", "guest", "c".repeat(64), length, signal())).rejects.toThrow(
				`LXD_OFFICE_${lane.error}_READBACK_UNCONFIRMED`,
			);
			expect(f.calls).toEqual([]);
		});

		it("copies caller bytes before asynchronous transmission", async () => {
			const content = Buffer.from("original request"),
				sha256 = digest(content);
			let received: Buffer | undefined;
			const f = await fixture((_request, response, body) => {
				received = body;
				response.end(JSON.stringify({ type: "sync", status_code: 200, metadata: {} }));
			});
			const upload = f.client[lane.push]("offices", "guest", sha256, content, signal());
			content.fill(0);
			await upload;
			expect(received).toEqual(Buffer.from("original request"));
			expect(f.failures).toEqual([]);
		});
		it("preserves the small generic runner file limits", async () => {
			const f = await fixture(() => {
				throw new Error("unexpected request");
			});
			await expect(
				f.client.pushInstanceFile("offices", "guest", "/generic", "x".repeat(256 * 1024 + 1), 0o400, signal()),
			).rejects.toThrow("supported size");
			await expect(f.client.readInstanceFile("offices", "guest", "/generic", 65537, signal())).rejects.toThrow(
				"LXD_INSTANCE_FILE_UNCONFIRMED",
			);
			expect(f.calls).toEqual([]);
		});
		it.each(["empty", "oversized", "wrong-hash", "path", "project", "cancelled"])(
			"refuses %s upload before HTTP",
			async (kind) => {
				const f = await fixture(() => {
					throw new Error("unexpected request");
				});
				const content =
					kind === "empty"
						? Buffer.alloc(0)
						: kind === "oversized"
							? Buffer.alloc(lane.maximum + 1)
							: Buffer.from("request");
				await expect(
					f.client[lane.push](
						kind === "project" ? "../foreign" : "offices",
						"guest",
						kind === "path" ? "../escape" : kind === "wrong-hash" ? "0".repeat(64) : digest(content),
						content,
						kind === "cancelled" ? AbortSignal.abort() : signal(),
					),
				).rejects.toThrow(`LXD_OFFICE_${lane.error}_UPLOAD_UNCONFIRMED`);
				expect(f.calls).toEqual([]);
			},
		);
		it.each(["uid", "gid", "mode", "kind", "short", "extra", "hash", "redirect", "truncated"])(
			"refuses %s readback without exposing file bytes",
			async (kind) => {
				const content = Buffer.from("private synthetic request"),
					sha256 = digest(content);
				const f = await fixture((_request, response) => {
					if (kind === "redirect") {
						response.writeHead(302, { location: "http://127.0.0.1/never-follow" });
						response.end();
						return;
					}
					const headers: Record<string, string> = {};
					if (["uid", "gid"].includes(kind)) headers[`x-lxd-${kind}`] = "1000";
					if (kind === "mode") headers["x-lxd-mode"] = "0444";
					if (kind === "kind") headers["x-lxd-type"] = "directory";
					if (kind === "truncated") {
						headers["content-length"] = String(content.length);
						headers.connection = "close";
					}
					bytes(
						response,
						kind === "short" || kind === "truncated"
							? content.subarray(1)
							: kind === "extra"
								? Buffer.concat([content, Buffer.from("!")])
								: kind === "hash"
									? Buffer.alloc(content.length, 1)
									: content,
						headers,
					);
				});
				await expect(f.client[lane.read]("offices", "guest", sha256, content.length, signal())).rejects.toThrow(
					`LXD_OFFICE_${lane.error}_READBACK_UNCONFIRMED`,
				);
				expect(f.calls).toHaveLength(1);
				expect(f.failures).toEqual([]);
			},
		);
		it.each(["upload", "read"])("honors cancellation of a stalled %s without retry", async (kind) => {
			const f = await fixture(() => {});
			const content = Buffer.from("private request"),
				sha256 = digest(content),
				cancel = new AbortController();
			const operation =
				kind === "upload"
					? f.client[lane.push]("offices", "guest", sha256, content, cancel.signal)
					: f.client[lane.read]("offices", "guest", sha256, content.length, cancel.signal);
			const rejected = expect(operation).rejects.toThrow(
				new RegExp(`LXD_OFFICE_${lane.error}_(UPLOAD|READBACK)_UNCONFIRMED`),
			);
			setTimeout(() => cancel.abort(), 25);
			await rejected;
			expect(f.calls.length).toBeLessThanOrEqual(1);
		});
		it.each(["redirect", "async", "failure", "malformed", "contradictory"])(
			"refuses %s upload acknowledgements without exposing daemon data",
			async (kind) => {
				const f = await fixture((_request, response) => {
					response.writeHead(kind === "redirect" ? 302 : kind === "failure" ? 500 : kind === "async" ? 202 : 200, {
						"content-type": "application/json",
						...(kind === "redirect" ? { location: "http://127.0.0.1/never-follow" } : {}),
					});
					response.end(
						kind === "malformed"
							? "private malformed response"
							: JSON.stringify({
									type: kind === "contradictory" ? "sync" : "async",
									status_code: kind === "contradictory" ? 200 : 100,
									error: "private daemon data",
								}),
					);
				});
				const content = Buffer.from("request");
				await expect(f.client[lane.push]("offices", "guest", digest(content), content, signal())).rejects.toThrow(
					new RegExp(`^LXD_OFFICE_${lane.error}_UPLOAD_UNCONFIRMED$`),
				);
				expect(f.calls).toHaveLength(1);
				expect(f.failures).toEqual([]);
			},
		);
		it("bounds a stalled read without relying on caller cancellation", async () => {
			const f = await fixture(() => {}),
				content = Buffer.from("request"),
				began = performance.now();
			await expect(
				f.client[lane.read]("offices", "guest", digest(content), content.length, signal()),
			).rejects.toThrow(`LXD_OFFICE_${lane.error}_READBACK_UNCONFIRMED`);
			expect(performance.now() - began).toBeLessThan(7000);
			expect(f.calls).toHaveLength(1);
		}, 8000);
	});

describe("reset custody public boot history transport", () => {
	it.each(["reset-configuration-claim", "reset-configuration-completion"])(
		"reads exact retained %s without allowing overwrite or credentials",
		async (leaf) => {
			const content = Buffer.from("{}"),
				path = `/etc/qorpera-office/boots/${"a".repeat(32)}/${leaf}.json`;
			const f = await fixture((_request, response) => bytes(response, content, { "x-lxd-mode": "0444" }));
			expect((await f.client.readOfficeResetFile("offices", "office-test", path, 65536, signal())).content).toEqual(
				content,
			);
			expect(f.calls).toHaveLength(1);
			await expect(
				f.client.pushOfficeResetFile("offices", "office-test", path, content, 0, 0, 0o444, signal()),
			).rejects.toThrow();
			await expect(
				f.client.readOfficeResetFile(
					"offices",
					"office-test",
					path.replace(`${leaf}.json`, "credentials/secret.json"),
					65536,
					signal(),
				),
			).rejects.toThrow();
			expect(f.calls).toHaveLength(1);
			expect(f.failures).toEqual([]);
		},
	);
});
