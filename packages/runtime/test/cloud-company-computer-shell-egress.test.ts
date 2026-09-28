import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	companyComputerShellEgressTarget,
	startCompanyComputerShellEgress,
} from "@qorpera/runtime/cloud-company-computer-shell-egress";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

/** A local server standing in for a public host; the injected transport dials it. */
async function upstream(handler: (socket: Socket) => void): Promise<Server> {
	const server = createServer((socket) => {
		socket.on("error", () => undefined);
		handler(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	return server;
}

async function fixture(target?: Server) {
	// Leave room for the Unix socket name under macOS's isolated test TMPDIR.
	const root = await mkdtemp(join(await realpath(tmpdir()), "se-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const signal = new AbortController();
	const assertActive = vi.fn((): void => undefined);
	const transport = {
		resolve: vi.fn(async (_host: string, _signal: AbortSignal) => ["93.184.216.34"]),
		connect: vi.fn((_address: string, _port: number) => {
			const address = target?.address();
			return createConnection({
				host: "127.0.0.1",
				port: address && typeof address === "object" ? address.port : 1,
			});
		}),
	};
	const relay = await startCompanyComputerShellEgress({ root, assertActive, signal: signal.signal, transport });
	cleanups.push(() => relay.close());
	return { signal, assertActive, transport, relay };
}

async function connect(path: string): Promise<Socket> {
	const peer = createConnection(path);
	peer.on("error", () => undefined);
	cleanups.push(async () => {
		peer.destroy();
	});
	await once(peer, "connect");
	return peer;
}

/** Everything the relay sends until it closes the connection. */
async function answer(peer: Socket, request: string): Promise<string> {
	const chunks: Buffer[] = [];
	peer.on("data", (bytes: Buffer) => chunks.push(bytes));
	const closed = once(peer, "close");
	peer.write(request);
	await closed;
	return Buffer.concat(chunks).toString("latin1");
}

describe("office shell internet relay", () => {
	it("accepts public names and public IPv4 on any port and refuses local, private and metadata destinations", () => {
		expect(companyComputerShellEgressTarget("github.com:22")).toEqual({ host: "github.com", port: 22 });
		expect(companyComputerShellEgressTarget("PyPI.org:443")).toEqual({ host: "pypi.org", port: 443 });
		expect(companyComputerShellEgressTarget("93.184.216.34:5432")).toEqual({ host: "93.184.216.34", port: 5432 });
		expect(companyComputerShellEgressTarget("example.com", 80)).toEqual({ host: "example.com", port: 80 });
		for (const authority of ["127.0.0.1:80", "10.0.0.1:445", "169.254.169.254:80", "100.100.100.100:80"])
			expect(() => companyComputerShellEgressTarget(authority)).toThrow("OFFICE_SHELL_ADDRESS_DENIED");
		for (const authority of [
			"192.168.1.40:2049",
			"localhost:3000",
			"app.local:80",
			"[::1]:80",
			"example.com",
			"example.com:0",
			"example.com:65536",
			"user@example.com:443",
			"2130706433:80",
		])
			expect(() => companyComputerShellEgressTarget(authority)).toThrow(/OFFICE_SHELL_(DESTINATION|ADDRESS)_DENIED/);
	});

	it("tunnels CONNECT to any port of a public address, resolved once and dialled as checked", async () => {
		const server = await upstream((socket) =>
			socket.on("data", (bytes) => socket.write(Buffer.concat([Buffer.from("db:"), bytes]))),
		);
		const f = await fixture(server);
		const peer = await connect(f.relay.path);
		const replies: Buffer[] = [];
		peer.on("data", (bytes: Buffer) => replies.push(bytes));
		peer.write("CONNECT db.example.com:5432 HTTP/1.1\r\nHost: db.example.com:5432\r\n\r\nhello");
		await vi.waitFor(() => expect(Buffer.concat(replies).toString()).toContain("db:hello"));
		expect(Buffer.concat(replies).toString()).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
		expect(f.transport.resolve).toHaveBeenCalledTimes(1);
		expect(f.transport.resolve.mock.calls[0][0]).toBe("db.example.com");
		expect(f.transport.connect).toHaveBeenCalledWith("93.184.216.34", 5432);
	});

	it("forwards plain HTTP in origin form as the only request of its connection", async () => {
		let received = "";
		const server = await upstream((socket) =>
			socket.on("data", (bytes) => {
				received += bytes.toString("latin1");
				if (received.includes("\r\n\r\n")) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
			}),
		);
		const f = await fixture(server);
		const reply = await answer(
			await connect(f.relay.path),
			"GET http://files.example.com/a/b?c=1 HTTP/1.1\r\nHost: files.example.com\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic eA==\r\nConnection: keep-alive\r\nUser-Agent: curl/8\r\n\r\n",
		);
		expect(received).toBe(
			"GET /a/b?c=1 HTTP/1.1\r\nHost: files.example.com\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n",
		);
		expect(reply).toBe("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
		expect(f.transport.connect).toHaveBeenCalledWith("93.184.216.34", 80);
	});

	it("refuses a private literal before any lookup, and says why", async () => {
		const f = await fixture();
		const reply = await answer(await connect(f.relay.path), "CONNECT 192.168.1.40:2049 HTTP/1.1\r\n\r\n");
		expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
		expect(reply).toContain("local and private network addresses are not reachable");
		expect(f.transport.resolve).not.toHaveBeenCalled();
		expect(f.transport.connect).not.toHaveBeenCalled();
	});

	it.each(["10.42.0.1", "169.254.169.254", "127.0.0.53", "100.80.160.64"])(
		"refuses a name that resolves to a private address (%s) without dialling",
		async (address) => {
			const f = await fixture();
			f.transport.resolve.mockResolvedValue(["93.184.216.34", address]);
			const reply = await answer(await connect(f.relay.path), "CONNECT sneaky.example.com:443 HTTP/1.1\r\n\r\n");
			expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
			expect(f.transport.connect).not.toHaveBeenCalled();
		},
	);

	it.each([
		"GET https://site.example.com/ HTTP/1.1\r\n\r\n",
		"CONNECT localhost:3000 HTTP/1.1\r\n\r\n",
		"CONNECT site.example.com HTTP/1.1\r\n\r\n",
		"CONNECT site.example.com:443 HTTP/2\r\n\r\n",
		"CONNECT site.example.com:443 HTTP/1.1\r\nBad Header\r\n\r\n",
	])("refuses a request it cannot route: %j", async (request) => {
		const f = await fixture();
		const reply = await answer(await connect(f.relay.path), request);
		expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
		expect(f.transport.resolve).not.toHaveBeenCalled();
	});

	it("answers 502 when a name cannot be found or a server cannot be reached", async () => {
		const f = await fixture();
		f.transport.resolve.mockRejectedValueOnce(new Error("ENOTFOUND"));
		expect(await answer(await connect(f.relay.path), "CONNECT missing.example.com:443 HTTP/1.1\r\n\r\n")).toMatch(
			/^HTTP\/1\.1 502 Bad Gateway\r\n[\s\S]*could not find missing\.example\.com/,
		);
		const closed = await upstream(() => undefined);
		const port = (closed.address() as { port: number }).port;
		await new Promise((resolve) => closed.close(resolve));
		f.transport.connect.mockImplementationOnce(() => createConnection({ host: "127.0.0.1", port }));
		expect(await answer(await connect(f.relay.path), "CONNECT down.example.com:443 HTTP/1.1\r\n\r\n")).toMatch(
			/^HTTP\/1\.1 502 Bad Gateway\r\n[\s\S]*could not connect to down\.example\.com:443/,
		);
	});

	it("carries nothing once its screen is gone, and closing ends open tunnels", async () => {
		const server = await upstream((socket) => socket.on("data", (bytes) => socket.write(bytes)));
		const f = await fixture(server);
		const open = await connect(f.relay.path);
		const replies: Buffer[] = [];
		open.on("data", (bytes: Buffer) => replies.push(bytes));
		open.write("CONNECT echo.example.com:7 HTTP/1.1\r\n\r\nping");
		await vi.waitFor(() => expect(Buffer.concat(replies).toString()).toContain("ping"));
		f.assertActive.mockImplementation(() => {
			throw new Error("SCREEN_GONE");
		});
		const refused = await connect(f.relay.path);
		await once(refused, "close");
		expect(f.transport.connect).toHaveBeenCalledTimes(1);
		const ended = once(open, "close");
		await f.relay.close();
		await ended;
	});
});
