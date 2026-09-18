import { randomBytes } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import {
	connectCompanyComputerScreenView,
	parseViewerEndpoint,
	startLocalScreenViewWebSocketBridge,
} from "@qorpera/cloud-client/node/cloud-company-computer-view";
import {
	assertCompanyComputerViewerGrant,
	type CompanyComputerViewerAuthority,
	type CompanyComputerViewerGrant,
	startCompanyComputerViewerGateway,
} from "@qorpera/runtime/cloud-company-computer-viewer-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerId,
	computerLease,
	computerRfbRectangle,
	computerRfbServerClipboard,
	computerRfbServerHello,
	computerRfbUpdate,
	computerScope,
} from "./fixtures/company-computer.ts";

const sockets = new Set<Socket>();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("NO_TEST_PORT");
	return address.port;
}

function viewerGrant(mode: "watch" | "control" = "watch"): CompanyComputerViewerGrant {
	return {
		binding: computerBinding(),
		viewerSessionId: computerId(21),
		memberId: computerId(8),
		mode,
		privacyVersion: 0,
		screenEpoch: 1,
		validForMs: 30_000,
		...(mode === "control"
			? {
					lease: {
						...computerLease(),
						driver: { kind: "member" as const, memberId: computerId(8), sessionId: computerId(21) },
					},
				}
			: {}),
	};
}

async function gatewayFixture(mode: "watch" | "control" = "watch", initial?: { greeting: Buffer; remainder?: Buffer }) {
	const received: Buffer[] = [];
	const guestSockets = new Set<Socket>();
	const guestPort = await listen(
		createServer((socket) => {
			sockets.add(socket);
			guestSockets.add(socket);
			socket.on("error", () => undefined);
			socket.on("data", (bytes: Buffer) => received.push(bytes));
			socket.write(initial?.greeting ?? Buffer.from("RFB 003.008\n"));
		}),
	);
	const grant = viewerGrant(mode);
	const used = new Set<string>();
	const authority: CompanyComputerViewerAuthority = {
		redeem: vi.fn(async (token: string) => {
			if (used.has(token)) throw new Error("CAPABILITY_ALREADY_REDEEMED");
			used.add(token);
			return structuredClone(grant);
		}),
		check: vi.fn(async () => structuredClone(grant)),
		forwardInput: vi.fn(
			async (
				_grant: CompanyComputerViewerGrant,
				_input: Parameters<CompanyComputerViewerAuthority["forwardInput"]>[1],
				forward: () => void,
			) => {
				forward();
			},
		),
		release: vi.fn(async () => undefined),
	};
	const gateway = await startCompanyComputerViewerGateway({
		host: "127.0.0.1",
		port: 0,
		authority,
		guest: {
			connect: async (_grant, signal) => {
				const socket = connect(guestPort, "127.0.0.1");
				sockets.add(socket);
				socket.on("error", () => undefined);
				await new Promise<void>((resolve, reject) => {
					socket.once("connect", resolve);
					socket.once("error", reject);
				});
				signal.throwIfAborted();
				socket.pause();
				return { socket, remainder: initial?.remainder ?? Buffer.alloc(0) };
			},
		},
	});
	cleanups.push(gateway.close);
	const attach = async (capability = randomBytes(32).toString("base64url")) => {
		const view = await connectCompanyComputerScreenView({
			host: "127.0.0.1",
			port: gateway.port,
			capability,
			binding: computerBinding(),
			mode,
			signal: new AbortController().signal,
		});
		sockets.add(view.socket);
		return view;
	};
	return { gateway, authority, grant, received, attach, guestSockets };
}

const hello = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);

describe("private viewer gateway and member client (loopback only, authority/guest doubles)", () => {
	it("closes old streams at privacy entry, permits only its owner, and fences private streams on exit", async () => {
		const f = await gatewayFixture("control");
		const first = await f.attach();
		const entering = {
			scope: computerScope(),
			computerGeneration: 1,
			challengeId: computerId(50),
			version: 1,
			state: "entering" as const,
			memberId: computerId(8),
			profileId: computerId(51),
			profileVersion: 2,
			screenId: computerBinding().screenId,
			drains: [{ state: "draining" as const, drainId: computerId(52), epoch: 2, binding: computerBinding() }],
		};
		await f.gateway.connections.fencePrivacy(entering, new AbortController().signal);
		await vi.waitFor(() => expect(first.socket.destroyed).toBe(true));
		await expect(f.attach()).rejects.toThrow("VIEW_UNAVAILABLE");
		f.grant.privacyVersion = 1;
		f.grant.screenEpoch = 2;
		f.grant.lease = { ...f.grant.lease!, epoch: 2 };
		f.grant.privateSignIn = { challengeId: entering.challengeId, profileId: entering.profileId, profileVersion: 2 };
		const privateView = await f.attach();
		// Runtime expiry/cancellation can advance one screen while sign-in is
		// already private. Re-reading the same privacy state must not rewind it.
		await f.gateway.connections.fenceScreen(
			{ ...entering.drains[0], drainId: computerId(55), epoch: 3 },
			new AbortController().signal,
		);
		await vi.waitFor(() => expect(privateView.socket.destroyed).toBe(true));
		await f.gateway.connections.fencePrivacy(entering, new AbortController().signal);
		await expect(f.attach()).rejects.toThrow();
		f.grant.screenEpoch = 3;
		f.grant.lease = { ...f.grant.lease!, epoch: 3 };
		const reconnectedPrivateView = await f.attach();
		const leaving = {
			...entering,
			state: "leaving" as const,
			version: 2,
			challengeId: computerId(53),
			drains: [{ ...entering.drains[0], drainId: computerId(54), epoch: 4 }],
		};
		await f.gateway.connections.fencePrivacy(leaving, new AbortController().signal);
		await vi.waitFor(() => expect(reconnectedPrivateView.socket.destroyed).toBe(true));
		await expect(f.attach()).rejects.toThrow();
		await expect(f.gateway.connections.fencePrivacy(entering, new AbortController().signal)).rejects.toThrow(
			"STALE_VIEWER_PRIVACY_BARRIER",
		);
	});

	it("a screen drain blocks an in-flight input callback before it reaches the guest", async () => {
		const f = await gatewayFixture("control");
		let delayed: (() => void) | undefined;
		f.authority.forwardInput = vi.fn(async (_grant, _input, forward) => {
			delayed = forward;
			await new Promise(() => undefined);
		});
		const view = await f.attach();
		view.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(delayed).toBeTypeOf("function"));
		await f.gateway.connections.fenceScreen(
			{ state: "draining", drainId: computerId(55), epoch: 2, binding: computerBinding() },
			new AbortController().signal,
		);
		expect(() => delayed!()).toThrow();
		expect(Buffer.concat(f.received).includes(key)).toBe(false);
	});
	it.each([
		["watch", false],
		["control", false],
		["watch", true],
		["control", true],
	] as const)("blocks guest clipboard egress for %s including coalesced remainder: %s", async (mode, coalesced) => {
		const hello = computerRfbServerHello();
		const clipboard = computerRfbServerClipboard("private cloud clipboard");
		const initialBytes = Buffer.concat([hello, clipboard]);
		const fixture = await gatewayFixture(
			mode,
			coalesced ? { greeting: Buffer.alloc(0), remainder: initialBytes } : { greeting: initialBytes },
		);
		const view = await fixture.attach();
		const received = [view.remainder];
		view.socket.on("data", (bytes: Buffer) => received.push(bytes));
		view.socket.resume();
		const pixels = Buffer.alloc(40, 3);
		clipboard.copy(pixels); // Clipboard-shaped bytes inside a pixel payload MUST survive.
		const update = computerRfbUpdate([computerRfbRectangle(0, 5, 2, pixels)]);
		for (const socket of fixture.guestSockets)
			socket.write(
				Buffer.concat([
					computerRfbServerClipboard("private extended clipboard", true),
					update,
					clipboard,
					Buffer.from([2]),
				]),
			);
		await vi.waitFor(() => expect(Buffer.concat(received)).toEqual(Buffer.concat([hello, update, Buffer.from([2])])));
		expect(view.socket.destroyed).toBe(false);
	});

	it("closes malformed guest output without returning service diagnostics or clipboard bytes", async () => {
		const fixture = await gatewayFixture("watch", { greeting: computerRfbServerHello() });
		const view = await fixture.attach();
		const received = [view.remainder];
		view.socket.on("data", (bytes: Buffer) => received.push(bytes));
		view.socket.resume();
		await vi.waitFor(() => expect(Buffer.concat(received)).toEqual(computerRfbServerHello()));
		for (const socket of fixture.guestSockets)
			socket.write(Buffer.concat([Buffer.from([99]), Buffer.from("PRIVATE_SERVICE_ERROR")]));
		await vi.waitFor(() => expect(view.socket.destroyed).toBe(true));
		expect(Buffer.concat(received)).toEqual(computerRfbServerHello());
		await vi.waitFor(() => expect(fixture.authority.release).toHaveBeenCalledOnce());
	});

	it.each(["watch", "control"] as const)(
		"enforces %s in the raw input stream, independently of noVNC",
		async (mode) => {
			const fixture = await gatewayFixture(mode);
			const view = await fixture.attach();
			view.socket.write(Buffer.concat([hello, key]));
			await vi.waitFor(() =>
				expect(Buffer.concat(fixture.received).length).toBe(
					mode === "control" ? hello.length + key.length : hello.length,
				),
			);
			expect(fixture.authority.forwardInput).toHaveBeenCalledTimes(mode === "control" ? 1 : 0);
			if (mode === "control")
				expect(fixture.authority.forwardInput).toHaveBeenCalledWith(
					expect.objectContaining({ mode: "control", binding: computerBinding() }),
					expect.objectContaining({
						sequence: 1,
						bytes: Uint8Array.from(key),
						sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
					}),
					expect.any(Function),
					expect.any(AbortSignal),
				);
		},
	);

	it("drops clipboard transfer even for a controller and refuses capability reuse", async () => {
		const fixture = await gatewayFixture("control");
		const capability = randomBytes(32).toString("base64url");
		const view = await fixture.attach(capability);
		const clipboard = Buffer.alloc(9);
		clipboard[0] = 6;
		clipboard.writeUInt32BE(1, 4);
		clipboard[8] = 65;
		view.socket.write(Buffer.concat([hello, clipboard]));
		await vi.waitFor(() => expect(Buffer.concat(fixture.received)).toEqual(hello));
		await expect(fixture.attach(capability)).rejects.toThrow("VIEW_UNAVAILABLE");
		expect(fixture.authority.forwardInput).not.toHaveBeenCalled();
	});

	it("checks revocation at input dispatch, disconnects and releases only the old session", async () => {
		const fixture = await gatewayFixture("control");
		const view = await fixture.attach();
		view.socket.write(hello);
		await vi.waitFor(() => expect(Buffer.concat(fixture.received)).toEqual(hello));
		fixture.authority.check = vi.fn(async () => {
			throw new Error("MEMBER_REVOKED private-service-detail");
		});
		view.socket.resume();
		view.socket.write(key);
		await vi.waitFor(() => expect(view.socket.destroyed).toBe(true));
		expect(Buffer.concat(fixture.received)).toEqual(hello);
		await vi.waitFor(() => expect(fixture.authority.release).toHaveBeenCalledOnce());
		expect(fixture.authority.release).toHaveBeenCalledWith(
			expect.objectContaining({ viewerSessionId: computerId(21), binding: computerBinding() }),
			expect.any(AbortSignal),
		);
	});

	it("expires an open viewer when renewal stalls instead of retaining remote control", async () => {
		const fixture = await gatewayFixture();
		fixture.grant.validForMs = 150;
		const view = await fixture.attach();
		view.socket.resume();
		fixture.authority.check = vi.fn(() => new Promise<CompanyComputerViewerGrant>(() => {}));
		await vi.waitFor(() => expect(view.socket.destroyed).toBe(true), { timeout: 1000, interval: 10 });
		await vi.waitFor(() => expect(fixture.authority.release).toHaveBeenCalledOnce());
	});

	it("rejects a renewal that changes member, screen generation or control mode", async () => {
		for (const changed of [
			{ memberId: computerId(99) },
			{ binding: { ...computerBinding(), screenGeneration: 2 } },
			{ mode: "control" as const },
		]) {
			const fixture = await gatewayFixture();
			const view = await fixture.attach();
			view.socket.resume();
			Object.assign(fixture.grant, changed);
			view.socket.write(hello);
			await vi.waitFor(() => expect(view.socket.destroyed).toBe(true));
			expect(fixture.received).toEqual([]);
		}
	});

	it("makes the effect callback single-use and rejects delayed forwarding after it settles", async () => {
		const fixture = await gatewayFixture("control");
		let late: (() => void) | undefined;
		fixture.authority.forwardInput = vi.fn(
			async (
				_grant: CompanyComputerViewerGrant,
				_input: Parameters<CompanyComputerViewerAuthority["forwardInput"]>[1],
				forward: () => void,
			) => {
				forward();
				late = forward;
			},
		);
		const view = await fixture.attach();
		view.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(Buffer.concat(fixture.received)).toEqual(Buffer.concat([hello, key])));
		expect(late).toBeDefined();
		expect(() => late?.()).toThrow("VIEWER_INPUT_ALREADY_SETTLED");
		expect(Buffer.concat(fixture.received)).toEqual(Buffer.concat([hello, key]));
	});

	it("rejects substituted binding and oversized handshake lines including a newline in the same chunk", async () => {
		for (const reply of [
			`${JSON.stringify({ ok: true, binding: { ...computerBinding(), companyId: computerId(99) }, mode: "watch" })}\n`,
			`${" ".repeat(4097)}{}\n`,
			`${JSON.stringify({ ok: false, error: "PRIVATE_SERVICE_SECRET" })}\n`,
		]) {
			const port = await listen(
				createServer((socket) => {
					sockets.add(socket);
					socket.on("error", () => undefined);
					socket.once("data", () => socket.end(reply));
				}),
			);
			await expect(
				connectCompanyComputerScreenView({
					host: "127.0.0.1",
					port,
					capability: randomBytes(32).toString("base64url"),
					binding: computerBinding(),
					mode: "watch",
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("VIEW_UNAVAILABLE");
		}
	});

	it("requires exact member takeover leases and private numeric endpoints", () => {
		expect(() => assertCompanyComputerViewerGrant({ ...viewerGrant("control"), lease: computerLease() })).toThrow();
		expect(() => assertCompanyComputerViewerGrant({ ...viewerGrant(), lease: viewerGrant("control").lease })).toThrow(
			"WATCHER_CANNOT_HOLD_CONTROL",
		);
		for (const endpoint of [
			"example.com:5901",
			"8.8.8.8:5901",
			"0.0.0.0:5901",
			"127.00.0.1:5901",
			"127.0.0.1:65536",
			"127.0.0.1:0",
		]) {
			expect(() => parseViewerEndpoint(endpoint)).toThrow();
		}
		expect(parseViewerEndpoint("100.64.0.1:5901")).toEqual({ host: "100.64.0.1", port: 5901 });
	});
});

function websocketRequest(url: string, origin: string, head = Buffer.alloc(0)): Socket {
	const parsed = new URL(url);
	const socket = connect(Number(parsed.port), "127.0.0.1");
	sockets.add(socket);
	const websocketKey = randomBytes(16).toString("base64");
	socket.on("error", () => undefined);
	socket.once("connect", () =>
		socket.write(
			Buffer.concat([
				Buffer.from(
					`GET ${parsed.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${parsed.port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
				),
				head,
			]),
		),
	);
	socket.resume();
	return socket;
}

describe("member loopback bridge", () => {
	it("checks exact renderer origin, consumes one URL, and preserves masked bytes coalesced with the HTTP upgrade", async () => {
		const fixture = await gatewayFixture();
		const view = await fixture.attach();
		const unregister = vi.fn();
		const registerRendererUrl = vi.fn(() => unregister);
		const bridge = await startLocalScreenViewWebSocketBridge(view, {
			origin: "https://trusted-renderer.example",
			registerRendererUrl,
		});
		cleanups.push(bridge.close);
		const wrong = websocketRequest(bridge.url, "https://untrusted.example");
		await vi.waitFor(() => expect(wrong.destroyed).toBe(true));
		expect(unregister).not.toHaveBeenCalled();
		const mask = Buffer.from([1, 2, 3, 4]);
		const head = Buffer.concat([
			Buffer.from([130, 128 | hello.length]),
			mask,
			Buffer.from(hello.map((byte, index) => byte ^ mask[index % 4])),
		]);
		const accepted = websocketRequest(bridge.url, "https://trusted-renderer.example", head);
		const response: Buffer[] = [];
		accepted.on("data", (bytes: Buffer) => response.push(bytes));
		await vi.waitFor(() => expect(Buffer.concat(fixture.received)).toEqual(hello));
		expect(Buffer.concat(response).toString()).toContain("101 Switching Protocols");
		expect(registerRendererUrl).toHaveBeenCalledWith(bridge.url);
		expect(unregister).toHaveBeenCalledOnce();
		const duplicate = websocketRequest(bridge.url, "https://trusted-renderer.example");
		await vi.waitFor(() => expect(duplicate.destroyed).toBe(true));
		expect(accepted.destroyed).toBe(false);
		await bridge.close();
		expect(view.socket.destroyed).toBe(true);
	});

	it("cleans up an unclaimed renderer bridge within its attach deadline", async () => {
		const fixture = await gatewayFixture();
		const view = await fixture.attach();
		const unregister = vi.fn();
		const bridge = await startLocalScreenViewWebSocketBridge(view, {
			origin: "null",
			registerRendererUrl: () => unregister,
			attachTimeoutMs: 20,
		});
		cleanups.push(bridge.close);
		await vi.waitFor(() => expect(view.socket.destroyed).toBe(true));
		expect(unregister).toHaveBeenCalledOnce();
	});
});
