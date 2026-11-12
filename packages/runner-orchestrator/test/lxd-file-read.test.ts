import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_GUEST_HELPER_MAX_BYTES } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import { withShortDeadline } from "./helpers/short-deadline.ts";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
	}
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function client(handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<LxdUnixClient> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-lxd-file-"));
	directories.push(directory);
	const socket = join(directory, "lxd.socket");
	const server = createServer(handle);
	servers.push(server);
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(socket, done);
	});
	return new LxdUnixClient(socket);
}
const headers = {
	"x-lxd-type": "file",
	"x-lxd-uid": "0",
	"x-lxd-gid": "0",
	"x-lxd-mode": "0400",
	"content-type": "application/octet-stream",
};
const read = (value: LxdUnixClient, signal?: AbortSignal) =>
	value.readInstanceFile("office-project", "office-guest", "/run/qorpera-office-bootstrap/report.json", 1024, signal);
describe("bounded LXD guest file readback", () => {
	it.each(["0400", "256"])("reads exact bytes and octal/decimal metadata (%s)", async (mode) => {
		const bytes = Buffer.from([0, 1, 255, 10]);
		const value = await client((request, response) => {
			expect(request.method).toBe("GET");
			expect(request.url).toBe(
				"/1.0/instances/office-guest/files?path=%2Frun%2Fqorpera-office-bootstrap%2Freport.json&project=office-project",
			);
			response.writeHead(200, { ...headers, "x-lxd-mode": mode });
			response.write(bytes.subarray(0, 2));
			response.end(bytes.subarray(2));
		});
		await expect(read(value)).resolves.toEqual({ content: bytes, uid: 0, gid: 0, mode: 0o400 });
	});
	it.each([
		{ "x-lxd-type": "symlink" },
		{ "x-lxd-type": "directory" },
		{ "x-lxd-uid": "-1" },
		{ "x-lxd-gid": "4294967296" },
		{ "x-lxd-mode": "0888" },
		{ "x-lxd-mode": "65535" },
		{ "x-lxd-mode": "0400, 0600" },
		{ "x-lxd-type": "file, file" },
		{ "x-lxd-uid": "" },
	])("rejects non-file or malformed metadata %#", async (overrides) => {
		const value = await client((_request, response) => {
			response.writeHead(200, { ...headers, ...overrides });
			response.end("private-data");
		});
		await expect(read(value)).rejects.toThrow(/^LXD_INSTANCE_FILE_UNCONFIRMED$/);
	});
	it.each([302, 403, 404, 500])("never treats HTTP %s as file data or follows a redirect", async (status) => {
		let requests = 0;
		const value = await client((_request, response) => {
			requests++;
			response.writeHead(status, { ...headers, location: "http://127.0.0.1/secret" });
			response.flushHeaders();
		});
		await expect(read(value)).rejects.toThrow(/^LXD_INSTANCE_FILE_UNCONFIRMED$/);
		expect(requests).toBe(1);
	});
	it.each(["advertised", "streamed", "truncated"])("rejects %s size failures", async (failure) => {
		const value = await client((_request, response) => {
			response.writeHead(200, {
				...headers,
				...(failure !== "streamed" ? { "content-length": failure === "advertised" ? "1025" : "10" } : {}),
			});
			response.flushHeaders();
			if (failure === "streamed") response.end(Buffer.alloc(1025));
			if (failure === "truncated") {
				response.write("short");
				setImmediate(() => response.destroy());
			}
		});
		await expect(read(value)).rejects.toThrow(/^LXD_INSTANCE_FILE_UNCONFIRMED$/);
	});
	it("cancels a read after response headers while the body is stalled", async () => {
		const stop = new AbortController();
		const value = await client((_request, response) => {
			response.writeHead(200, headers);
			response.flushHeaders();
			setImmediate(() => stop.abort());
		});
		await expect(read(value, stop.signal)).rejects.toThrow(/^LXD_INSTANCE_FILE_UNCONFIRMED$/);
	});
	it("has a total deadline even before response headers", async () => {
		const value = await client(() => undefined);
		const deadlines = await withShortDeadline(5000, () =>
			expect(read(value)).rejects.toThrow(/^LXD_INSTANCE_FILE_UNCONFIRMED$/),
		);
		expect(deadlines).toBeGreaterThan(0);
	}, 10000);
	it.each(["/", "relative", "/run/../secret", "/run/file\n", "/run/file\\name"])(
		"rejects unsafe path %s without a request",
		async (path) => {
			let requests = 0;
			const value = await client(() => {
				requests++;
			});
			await expect(value.readInstanceFile("office", "guest", path, 1024)).rejects.toThrow(
				/^LXD_INSTANCE_FILE_UNCONFIRMED$/,
			);
			expect(requests).toBe(0);
		},
	);
	it.each([0, 65537, 1.5, Infinity])("rejects invalid byte bound %s", async (maximum) => {
		const value = new LxdUnixClient("/nonexistent/lxd.socket");
		await expect(value.readInstanceFile("office", "guest", "/run/report", maximum)).rejects.toThrow(
			/^LXD_INSTANCE_FILE_UNCONFIRMED$/,
		);
	});
	it("reads a coding guest helper past 64 KiB, within the helpers' bound, and nothing else so far", async () => {
		const helper = "/opt/qorpera-coding/cloud-coding-command-guest.mjs";
		const bytes = Buffer.alloc(100_000, 0x61);
		let requests = 0;
		const value = await client((_request, response) => {
			requests++;
			response.writeHead(200, { ...headers, "x-lxd-mode": "0444", "content-length": String(bytes.length) });
			response.end(bytes);
		});
		await expect(value.readInstanceFile("coding", "machine", helper, CODING_GUEST_HELPER_MAX_BYTES)).resolves.toEqual(
			{
				content: bytes,
				uid: 0,
				gid: 0,
				mode: 0o444,
			},
		);
		expect(requests).toBe(1);
		// Past the bound, or this bound for any other file: refused before a request.
		for (const [path, maximum] of [
			[helper, CODING_GUEST_HELPER_MAX_BYTES + 1],
			["/opt/qorpera-coding/../secret.mjs", CODING_GUEST_HELPER_MAX_BYTES],
			["/run/qorpera-coding/observation.json", CODING_GUEST_HELPER_MAX_BYTES],
			["/opt/qorpera-guest/agent.mjs", CODING_GUEST_HELPER_MAX_BYTES],
		] as const)
			await expect(value.readInstanceFile("coding", "machine", path, maximum)).rejects.toThrow(
				/^LXD_INSTANCE_FILE_UNCONFIRMED$/,
			);
		expect(requests).toBe(1);
		// A helper larger than the bound the caller gave is refused as it streams.
		const big = await client((_request, response) => {
			response.writeHead(200, { ...headers, "x-lxd-mode": "0444" });
			response.end(Buffer.alloc(CODING_GUEST_HELPER_MAX_BYTES + 1));
		});
		await expect(big.readInstanceFile("coding", "machine", helper, CODING_GUEST_HELPER_MAX_BYTES)).rejects.toThrow(
			/^LXD_INSTANCE_FILE_UNCONFIRMED$/,
		);
	});
});
