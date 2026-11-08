import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import { LxdHttpsAccess, readLxdHttpsAccess } from "../src/lxd-https.ts";
import { NodeWebSocket } from "../src/node-websocket.ts";

type Name = "server" | "other" | "client" | "stranger";
interface Pair {
	cert: Buffer;
	key: Buffer;
	sha256: string;
}
const pairs = {} as Record<Name, Pair>;
let root: string;
const servers: Server[] = [];
const sockets = new Set<Socket>();

/** The caller's certificate as LXD names it (auth_user_name): its SHA-256. */
const callerIdentity = (socket: TLSSocket): string =>
	createHash("sha256").update(socket.getPeerCertificate(true).raw).digest("hex");
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "lxd-https-"));
	for (const name of ["server", "other", "client", "stranger"] as const) {
		const key = join(root, `${name}.key`),
			cert = join(root, `${name}.crt`);
		const generated = spawnSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:prime256v1",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				`/CN=${name}`,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(generated.status).toBe(0);
		const bytes = await readFile(cert);
		pairs[name] = {
			cert: bytes,
			key: await readFile(key),
			sha256: new X509Certificate(bytes).fingerprint256.replaceAll(":", "").toLowerCase(),
		};
	}
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});
afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function listener(record: Record<string, unknown> = {}): Buffer {
	return Buffer.from(
		JSON.stringify({
			schema: "qorpera.lxd-listener/v1",
			origin: "https://127.0.0.1:8443",
			certificateSha256: pairs.server.sha256,
			...record,
		}),
	);
}
function access(port: number, pin = pairs.server.sha256, client = pairs.client): LxdHttpsAccess {
	return LxdHttpsAccess.fromFiles(
		listener({ origin: `https://127.0.0.1:${port}`, certificateSha256: pin }),
		Buffer.from(client.cert),
		Buffer.from(client.key),
	);
}
async function listen(server: Server): Promise<number> {
	servers.push(server);
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return (server.address() as AddressInfo).port;
}
function connect(lxd: LxdHttpsAccess, signal?: AbortSignal): Promise<TLSSocket> {
	return new Promise((resolve, reject) => {
		lxd.connection(signal)({}, (error: Error | null, socket?: Duplex) =>
			error ? reject(error) : resolve(socket as TLSSocket),
		);
	});
}
/** LXD's listener as WS15 found it: TLS 1.3, a client certificate asked for and checked by LXD itself, h2 offered. */
async function standIn(
	handle: (request: IncomingMessage, response: ServerResponse) => void,
	pair = pairs.server,
	upgrade?: (request: IncomingMessage, socket: Duplex) => void,
) {
	const seen: { request: string; identity: string; protocol: unknown; alpn: unknown; servername: unknown }[] = [];
	const server = createHttpsServer(
		{
			cert: pair.cert,
			key: pair.key,
			minVersion: "TLSv1.3",
			requestCert: true,
			rejectUnauthorized: false,
			ALPNProtocols: ["h2"],
		},
		(request, response) => {
			const socket = request.socket as TLSSocket;
			seen.push({
				request: `${request.method} ${request.url}`,
				identity: callerIdentity(socket),
				protocol: socket.getProtocol(),
				// Neither is negotiated: Node reads false for none.
				alpn: socket.alpnProtocol || null,
				servername: socket.servername || null,
			});
			handle(request, response);
		},
	);
	if (upgrade) server.on("upgrade", upgrade);
	server.on("tlsClientError", () => undefined);
	return { port: await listen(server), seen };
}
function send(response: ServerResponse, metadata: unknown) {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ type: "sync", status_code: 200, metadata }));
}
const serverRecord = (record: Record<string, unknown> = {}, environment: Record<string, unknown> = {}) => ({
	auth: "trusted",
	auth_user_method: "tls",
	auth_user_name: pairs.client.sha256,
	api_version: "1.0",
	api_status: "stable",
	public: false,
	...record,
	environment: {
		server: "lxd",
		kernel: "Linux",
		server_clustered: false,
		project: "offices",
		driver: "lxc | qemu",
		instance_types: ["container", "virtual-machine"],
		certificate: pairs.server.cert.toString(),
		certificate_fingerprint: pairs.server.sha256,
		server_name: "office-provider",
		server_version: "6.9",
		kernel_architecture: "x86_64",
		...environment,
	},
});

describe("an account's LXD access record", () => {
	it("reads the loopback listener, its pin and the account's own certificate, and zeroes the key", () => {
		const key = Buffer.from(pairs.client.key);
		const lxd = LxdHttpsAccess.fromFiles(listener(), Buffer.from(pairs.client.cert), key);
		expect(lxd).toMatchObject({
			host: "127.0.0.1",
			port: 8443,
			serverCertificateSha256: pairs.server.sha256,
			identitySha256: pairs.client.sha256,
		});
		expect(key.every((byte) => byte === 0)).toBe(true);
		expect(
			LxdHttpsAccess.fromFiles(
				listener({ origin: "https://[::1]:65535" }),
				Buffer.from(pairs.client.cert),
				Buffer.from(pairs.client.key),
			),
		).toMatchObject({ host: "::1", port: 65535 });
	});
	it.each([
		["not JSON", Buffer.from("{")],
		["not UTF-8", Buffer.from([0xff, 0xfe])],
		["a list", Buffer.from("[]")],
		["an extra key", () => listener({ trust: "ca" })],
		["another schema", () => listener({ schema: "qorpera.lxd-listener/v2" })],
		["an address off loopback", () => listener({ origin: "https://192.0.2.1:8443" })],
		["a host name", () => listener({ origin: "https://localhost:8443" })],
		["plain HTTP", () => listener({ origin: "http://127.0.0.1:8443" })],
		["no port", () => listener({ origin: "https://127.0.0.1" })],
		["a path", () => listener({ origin: "https://127.0.0.1:8443/" })],
		["port 0", () => listener({ origin: "https://127.0.0.1:0" })],
		["port 65536", () => listener({ origin: "https://127.0.0.1:65536" })],
		["a padded port", () => listener({ origin: "https://127.0.0.1:08443" })],
		["an upper-case pin", () => listener({ certificateSha256: pairs.server.sha256.toUpperCase() })],
		["a short pin", () => listener({ certificateSha256: pairs.server.sha256.slice(1) })],
		["no pin", () => listener({ certificateSha256: null })],
	])("refuses a listener record with %s, and still zeroes the key", (_case, bytes) => {
		const key = Buffer.from(pairs.client.key);
		expect(() =>
			LxdHttpsAccess.fromFiles(typeof bytes === "function" ? bytes() : bytes, Buffer.from(pairs.client.cert), key),
		).toThrow("LXD_LISTENER_INVALID");
		expect(key.every((byte) => byte === 0)).toBe(true);
	});
	it.each([
		["two certificates", () => Buffer.concat([pairs.client.cert, pairs.other.cert]), () => pairs.client.key],
		[
			"text before the certificate",
			() => Buffer.concat([Buffer.from("x\n"), pairs.client.cert]),
			() => pairs.client.key,
		],
		["a key that is not the certificate's", () => pairs.client.cert, () => pairs.stranger.key],
		[
			"no certificate",
			() => Buffer.from("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"),
			() => pairs.client.key,
		],
		["the listener's own certificate", () => pairs.server.cert, () => pairs.server.key],
	])("refuses an identity with %s", (_case, certificate, keyBytes) => {
		const key = Buffer.from(keyBytes());
		expect(() => LxdHttpsAccess.fromFiles(listener(), Buffer.from(certificate()), key)).toThrow(
			"LXD_IDENTITY_INVALID",
		);
		expect(key.every((byte) => byte === 0)).toBe(true);
	});
	it("reads only protected files, and only for a plain account name", async () => {
		const open = join(root, "open");
		await mkdir(join(open, "qorpera-lxd-provider"), { recursive: true });
		await writeFile(join(open, "listener.json"), listener());
		await writeFile(join(open, "qorpera-lxd-provider", "client.crt"), pairs.client.cert);
		await writeFile(join(open, "qorpera-lxd-provider", "client.key"), pairs.client.key, { mode: 0o400 });
		await chmod(open, 0o777);
		await expect(readLxdHttpsAccess(open, "qorpera-lxd-provider")).rejects.toThrow("LXD_LISTENER_INVALID");
		for (const account of ["../etc", "Provider", "", "a".repeat(33)])
			await expect(readLxdHttpsAccess(open, account)).rejects.toThrow("LXD_IDENTITY_INVALID");
	});
});

describe("a pinned connection to LXD's loopback listener", () => {
	it("hands node:http a TLS 1.3 connection with the account's certificate, no ALPN and no server name", async () => {
		const { port, seen } = await standIn((_request, response) => response.end("ok"));
		const body = await new Promise<string>((resolve, reject) => {
			const request = httpRequest(
				{ host: "127.0.0.1", port, path: "/1.0", createConnection: access(port).connection() },
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.once("end", () => resolve(Buffer.concat(chunks).toString()));
				},
			);
			request.once("error", reject);
			request.end();
		});
		expect(body).toBe("ok");
		expect(seen).toEqual([
			{ request: "GET /1.0", identity: pairs.client.sha256, protocol: "TLSv1.3", alpn: null, servername: null },
		]);
	});
	it("sends no request byte to a listener whose certificate is not the pinned one", async () => {
		const received: Buffer[] = [];
		let closed!: () => void;
		const ended = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const server = createTlsServer(
			{
				cert: pairs.other.cert,
				key: pairs.other.key,
				minVersion: "TLSv1.3",
				requestCert: true,
				rejectUnauthorized: false,
			},
			(socket) => {
				socket.on("data", (chunk: Buffer) => received.push(chunk));
				socket.on("error", () => undefined);
			},
		);
		server.on("tlsClientError", () => undefined);
		server.on("connection", (socket: Socket) => socket.once("close", () => closed()));
		const port = await listen(server);
		const failed = await new Promise<Error>((resolve) => {
			const request = httpRequest({
				host: "127.0.0.1",
				port,
				path: "/1.0",
				createConnection: access(port).connection(),
			});
			request.once("error", resolve);
			request.end();
		});
		expect(failed.message).toBe("LXD_HTTPS_SERVER_UNPINNED");
		await ended;
		expect(Buffer.concat(received).byteLength).toBe(0);
	});
	it("refuses a listener that offers less than TLS 1.3, and a port with no listener", async () => {
		const old = createTlsServer({ cert: pairs.server.cert, key: pairs.server.key, maxVersion: "TLSv1.2" });
		old.on("tlsClientError", () => undefined);
		const port = await listen(old);
		await expect(connect(access(port))).rejects.toThrow("LXD_HTTPS_UNAVAILABLE");
		const gone = createTcpServer();
		const unused = await listen(gone);
		await new Promise<void>((resolve) => gone.close(() => resolve()));
		await expect(connect(access(unused))).rejects.toThrow("LXD_HTTPS_UNAVAILABLE");
	});
	it("gives up on a listener that never finishes the handshake after five seconds", async () => {
		const port = await listen(createTcpServer());
		const started = Date.now();
		await expect(connect(access(port))).rejects.toThrow("LXD_HTTPS_HANDSHAKE_TIMEOUT");
		expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
	}, 10_000);
	it("stops when its request's signal stops, before or during the handshake", async () => {
		const port = await listen(createTcpServer());
		await expect(connect(access(port), AbortSignal.abort())).rejects.toThrow("LXD_HTTPS_STOPPED");
		const stop = new AbortController();
		const started = Date.now();
		setTimeout(() => stop.abort(), 100);
		await expect(connect(access(port), stop.signal)).rejects.toThrow("LXD_HTTPS_STOPPED");
		expect(Date.now() - started).toBeLessThan(2000);
	});
});

describe("the LXD client over its pinned listener", () => {
	it("confirms the server only when LXD names this account by its own certificate and shows the pinned one", async () => {
		const { port, seen } = await standIn((_request, response) => send(response, serverRecord()));
		await expect(
			new LxdUnixClient(access(port)).inspectOfficeServer("offices", new AbortController().signal),
		).resolves.toEqual({
			project: "offices",
			certificateSha256: pairs.server.sha256,
			serverName: "office-provider",
			serverVersion: "6.9",
			architecture: "x86_64",
		});
		expect(seen).toEqual([
			{
				request: "GET /1.0?project=offices",
				identity: pairs.client.sha256,
				protocol: "TLSv1.3",
				alpn: null,
				servername: null,
			},
		]);
	});
	it.each([
		["another account's name", () => serverRecord({ auth_user_name: pairs.stranger.sha256 })],
		["no name", () => serverRecord({ auth_user_name: undefined })],
		["the socket's method", () => serverRecord({ auth_user_method: "unix" })],
		["a CA-issued identity", () => serverRecord({ auth_user_method: "pki" })],
		[
			"another server certificate",
			() =>
				serverRecord({}, { certificate: pairs.other.cert.toString(), certificate_fingerprint: pairs.other.sha256 }),
		],
	])("refuses an answer with %s", async (_case, answer) => {
		const { port } = await standIn((_request, response) => send(response, answer()));
		await expect(
			new LxdUnixClient(access(port)).inspectOfficeServer("offices", new AbortController().signal),
		).rejects.toThrow("LXD_OFFICE_SERVER_UNCONFIRMED");
	});
	it("asks nothing of a listener whose certificate is not the pinned one", async () => {
		const { port, seen } = await standIn((_request, response) => send(response, serverRecord()), pairs.other);
		await expect(
			new LxdUnixClient(access(port)).inspectOfficeServer("offices", new AbortController().signal),
		).rejects.toThrow("LXD_OFFICE_SERVER_UNCONFIRMED");
		expect(seen).toEqual([]);
	});
});

describe("an operation's websocket over the pinned listener", () => {
	it("upgrades over wss: on the pinned connection, and refuses ws: with its own connection", async () => {
		const upgraded: string[] = [];
		const { port } = await standIn(
			(_request, response) => response.end(),
			pairs.server,
			(request, socket) => {
				upgraded.push(`${request.url} ${callerIdentity(socket as TLSSocket)}`);
				const accept = createHash("sha1")
					.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
					.digest("base64");
				socket.write(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
				);
				socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("hello")]));
			},
		);
		const messages: string[] = [];
		let heard!: () => void;
		const message = new Promise<void>((resolve) => {
			heard = resolve;
		});
		const lxd = access(port);
		const socket = await NodeWebSocket.connect(
			new URL(`wss://127.0.0.1:${port}/1.0/operations/one/websocket?secret=two`),
			{
				message: (text) => {
					messages.push(text);
					heard();
				},
				close: () => undefined,
			},
			5000,
			{ createConnection: lxd.connection() },
		);
		await message;
		socket.close();
		expect(messages).toEqual(["hello"]);
		expect(upgraded).toEqual([`/1.0/operations/one/websocket?secret=two ${pairs.client.sha256}`]);
		expect(() =>
			NodeWebSocket.connect(
				new URL(`ws://127.0.0.1:${port}/1.0/operations/one/websocket`),
				{ message: () => undefined, close: () => undefined },
				5000,
				{ createConnection: lxd.connection() },
			),
		).toThrow("A WebSocket URL with its own connection must use wss:");
	});
});
