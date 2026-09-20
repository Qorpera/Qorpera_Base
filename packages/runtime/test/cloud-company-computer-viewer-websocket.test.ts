import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates, type TLSSocket, connect as tlsConnect } from "node:tls";
import { CloudCompanyComputerViews } from "@qorpera/cloud-client/cloud-company-computer-views";
import { COMPANY_COMPUTER_VIEW_SCHEMA } from "@qorpera/cloud-client/node/company-computer-view-protocol";
import { startCompanyComputerViewerWebSocketGateway } from "@qorpera/runtime/cloud-company-computer-viewer-websocket";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerId,
	computerRfbServerClipboard,
	computerRfbServerHello,
	computerScope,
} from "./fixtures/company-computer.ts";

let directory: string;
let cert: Buffer;
let key: Buffer;
const cleanups: Array<() => Promise<void>> = [];
const sockets = new Set<Socket>();
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "qorpera-viewer-tls-test-"));
	const result = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(directory, "key.pem"),
			"-out",
			join(directory, "cert.pem"),
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ encoding: "utf8", timeout: 15000 },
	);
	if (result.status !== 0) throw new Error("Could not create disposable test TLS certificate");
	cert = await readFile(join(directory, "cert.pem"));
	key = await readFile(join(directory, "key.pem"));
});
afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});
afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	for (const close of cleanups.splice(0).reverse()) await close();
});
function masked(payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const header =
		payload.length < 126
			? Buffer.from([130, 128 | payload.length])
			: Buffer.from([130, 254, payload.length >> 8, payload.length & 255]);
	return Buffer.concat([header, mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]);
}
async function fixture() {
	const received: Buffer[] = [];
	const guest = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.on("data", (bytes: Buffer) => received.push(bytes));
		socket.write(Buffer.concat([computerRfbServerHello(), computerRfbServerClipboard("private clipboard canary")]));
	});
	await new Promise<void>((resolve) => guest.listen(0, "127.0.0.1", resolve));
	const guestAddress = guest.address();
	if (!guestAddress || typeof guestAddress === "string") throw new Error("No fixture guest port");
	cleanups.push(() => new Promise<void>((resolve) => guest.close(() => resolve())));
	const grant = {
		binding: computerBinding(),
		viewerSessionId: computerId(21),
		memberId: computerId(8),
		mode: "watch" as const,
		privacyVersion: 0,
		screenEpoch: 1,
		validForMs: 30000,
	};
	const used = new Set<string>();
	const authority = {
		redeem: vi.fn(async (token: string) => {
			if (used.has(token)) throw new Error("consumed");
			used.add(token);
			return structuredClone(grant);
		}),
		check: vi.fn(async () => structuredClone(grant)),
		admitInputWindow: vi.fn(async (): Promise<{ validForMs: number }> => {
			throw new Error("watch cannot type");
		}),
		recordInput: vi.fn((): number => {
			throw new Error("watch cannot type");
		}),
		release: vi.fn(async () => undefined),
	};
	const path = `/office/${computerBinding().companyComputerId}/view`;
	const server = await startCompanyComputerViewerWebSocketGateway({
		host: "127.0.0.1",
		port: 0,
		path,
		origins: ["https://app.qorpera.test"],
		tls: { cert, key },
		authority,
		guest: {
			connect: async () => {
				const socket = (await import("node:net")).connect(guestAddress.port, "127.0.0.1");
				sockets.add(socket);
				socket.on("error", () => undefined);
				await new Promise<void>((resolve, reject) => {
					socket.once("connect", resolve);
					socket.once("error", reject);
				});
				socket.pause();
				return { socket, remainder: Buffer.alloc(0) };
			},
		},
	});
	cleanups.push(server.close);
	async function request(
		origin = "https://app.qorpera.test",
		route = path,
		trusted = true,
	): Promise<{ socket: TLSSocket; bytes: () => Buffer; token: string }> {
		const socket = tlsConnect({
			host: "127.0.0.1",
			port: server.port,
			servername: "localhost",
			...(trusted ? { ca: cert } : {}),
		});
		sockets.add(socket);
		socket.on("error", () => undefined);
		await new Promise<void>((resolve, reject) => {
			socket.once("secureConnect", resolve);
			socket.once("error", reject);
		});
		const data: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => data.push(chunk));
		const token = randomBytes(32).toString("base64url");
		const upgrade = `GET ${route} HTTP/1.1\r\nHost: localhost:${server.port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n`;
		const ticket = Buffer.from(`${JSON.stringify({ schema: COMPANY_COMPUTER_VIEW_SCHEMA, capability: token })}\n`);
		// Coalesced upgrade + ticket + initial noVNC negotiation/input.
		const hello = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1, 4, 1, 0, 0, 0, 0, 0, 65])]);
		socket.write(Buffer.concat([Buffer.from(upgrade), masked(ticket), masked(hello)]));
		return { socket, bytes: () => Buffer.concat(data), token };
	}
	return { server, authority, received, request, path, grant };
}

describe("TLS WebSocket office viewer (loopback, synthetic guest/authority)", () => {
	it("connects the shared member SDK through the native WebSocket API to the TLS gateway", async () => {
		const f = await fixture();
		const originalCAs = getCACertificates("default");
		// Trust only this disposable certificate in addition to normal CAs; never
		// disable TLS verification. Restored before any other test runs.
		setDefaultCACertificates([...originalCAs, cert]);
		const abort = new AbortController();
		try {
			const rpc = vi.fn(async (method: string) => ({
				error: null,
				data:
					method === "qorpera_create_runtime_office_viewer"
						? {
								state: "issued",
								capability: randomBytes(32).toString("base64url"),
								grant: structuredClone(f.grant),
							}
						: { state: "released" },
			}));
			const client = new CloudCompanyComputerViews({
				scope: computerScope(),
				memberId: f.grant.memberId,
				url: `wss://localhost:${f.server.port}${f.path}`,
				rpc,
				// Browsers set their own Origin. Node's native WebSocket supplies the
				// same header through its host option for this loopback acceptance.
				createWebSocket: (url) => new WebSocket(url, { headers: { Origin: "https://app.qorpera.test" } }),
			});
			const view = await client.connect({ binding: f.grant.binding, screenEpoch: 1, signal: abort.signal });
			const received: Buffer[] = [];
			view.channel.onmessage = (event) => received.push(Buffer.from(event.data));
			await vi.waitFor(() => expect(Buffer.concat(received).includes(Buffer.from("Test cloud screen"))).toBe(true));
			expect(Buffer.concat(received).toString()).not.toContain("private clipboard canary");
			// One guest chunk is one WebSocket frame, not one frame per parsed RFB field.
			expect(received.length).toBeLessThanOrEqual(2);
			view.channel.send(new TextEncoder().encode("RFB 003.008\n"));
			view.channel.send(new Uint8Array([1, 1, 4, 1, 0, 0, 0, 0, 0, 65]));
			await vi.waitFor(() =>
				expect(Buffer.concat(f.received)).toEqual(
					Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]),
				),
			);
			await view.close();
			await vi.waitFor(() => expect(f.authority.release).toHaveBeenCalledOnce());
			expect(rpc.mock.calls.map(([method]) => method)).toEqual([
				"qorpera_create_runtime_office_viewer",
				"qorpera_cancel_runtime_office_viewer",
			]);
		} finally {
			abort.abort();
			setDefaultCACertificates(originalCAs);
		}
	});
	it("verifies TLS, authenticates in the binary handshake and filters input/clipboard through the existing gateway", async () => {
		const f = await fixture();
		const client = await f.request();
		await vi.waitFor(() => expect(client.bytes().includes(Buffer.from("Test cloud screen"))).toBe(true));
		expect(client.socket.authorized).toBe(true);
		expect(client.socket.getProtocol()).toBe("TLSv1.3");
		expect(client.bytes().toString()).toContain("101 Switching Protocols");
		expect(client.bytes().toString()).not.toContain("Sec-WebSocket-Extensions");
		expect(client.bytes().toString()).not.toContain("private clipboard canary");
		expect(client.bytes().toString()).not.toContain(client.token);
		await vi.waitFor(() =>
			expect(Buffer.concat(f.received)).toEqual(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])])),
		);
		expect(f.authority.admitInputWindow).not.toHaveBeenCalled();
		expect(f.authority.recordInput).not.toHaveBeenCalled();
		expect(f.authority.redeem).toHaveBeenCalledExactlyOnceWith(client.token, expect.any(AbortSignal));
	});
	it("rejects foreign origins, token-bearing URLs and untrusted certificates", async () => {
		const f = await fixture();
		const foreign = await f.request("https://untrusted.example");
		await vi.waitFor(() => expect(foreign.socket.destroyed).toBe(true));
		const query = await f.request("https://app.qorpera.test", `${f.path}?capability=must-not-be-in-url`);
		await vi.waitFor(() => expect(query.socket.destroyed).toBe(true));
		await expect(f.request("https://app.qorpera.test", f.path, false)).rejects.toThrow();
		expect(f.authority.redeem).not.toHaveBeenCalled();
	});
	it("closes the actual TLS viewer stream before a privacy fence resolves", async () => {
		const f = await fixture();
		const client = await f.request();
		await vi.waitFor(() => expect(f.authority.check).toHaveBeenCalled());
		await f.server.connections.fencePrivacy(
			{
				scope: computerScope(),
				computerGeneration: 1,
				version: 1,
				challengeId: computerId(30),
				state: "entering",
				memberId: computerId(8),
				profileId: computerId(31),
				profileVersion: 2,
				screenId: computerBinding().screenId,
				drains: [{ state: "draining", drainId: computerId(32), epoch: 2, binding: computerBinding() }],
			},
			new AbortController().signal,
		);
		await vi.waitFor(() => expect(client.socket.destroyed).toBe(true));
		expect(f.authority.release).toHaveBeenCalledOnce();
	});
});
