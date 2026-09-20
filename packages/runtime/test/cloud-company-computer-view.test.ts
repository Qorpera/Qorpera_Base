import { randomBytes } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import {
	connectCompanyComputerScreenView,
	parseViewerEndpoint,
	startLocalScreenViewWebSocketBridge,
} from "@qorpera/cloud-client/node/cloud-company-computer-view";
import {
	assertCompanyComputerViewerGrant,
	type CompanyComputerViewerAuthority,
	type CompanyComputerViewerGrant,
	CompanyComputerViewerInputRefused,
	coalesceCompanyComputerPointerMoves,
	startCompanyComputerViewerGateway,
} from "@qorpera/runtime/cloud-company-computer-viewer-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function viewerGrant(mode: CompanyComputerViewerGrant["mode"] = "watch"): CompanyComputerViewerGrant {
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

async function gatewayFixture(
	mode: CompanyComputerViewerGrant["mode"] = "watch",
	initial?: { greeting: Buffer; remainder?: Buffer },
	onRefusal?: Parameters<typeof startCompanyComputerViewerGateway>[0]["onRefusal"],
) {
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
		admitInputWindow: vi.fn(async () => ({ validForMs: 1000, pendingReports: 0 })),
		// Packets in the open window. The doubles never close one, so report a constant.
		recordInput: vi.fn(() => 1),
		release: vi.fn(async () => undefined),
	};
	const gateway = await startCompanyComputerViewerGateway({
		host: "127.0.0.1",
		port: 0,
		authority,
		onRefusal,
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

type InputWindow = { validForMs: number; pendingReports: number };
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

	it("a screen drain during an in-flight window admission keeps the waiting input from the guest", async () => {
		const f = await gatewayFixture("control");
		let admit: ((value: InputWindow) => void) | undefined;
		f.authority.admitInputWindow = vi.fn(
			() =>
				new Promise<InputWindow>((resolve) => {
					admit = resolve;
				}),
		);
		const view = await f.attach();
		view.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(admit).toBeTypeOf("function"));
		await f.gateway.connections.fenceScreen(
			{ state: "draining", drainId: computerId(55), epoch: 2, binding: computerBinding() },
			new AbortController().signal,
		);
		admit!({ validForMs: 1000, pendingReports: 0 });
		await vi.waitFor(() => expect(f.authority.release).toHaveBeenCalledOnce());
		expect(f.authority.recordInput).not.toHaveBeenCalled();
		expect(Buffer.concat(f.received).includes(key)).toBe(false);
	});
	it.each([
		["watch", false],
		["control", false],
		["shared", false],
		["watch", true],
		["control", true],
		["shared", true],
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

	it.each(["watch", "control", "shared"] as const)(
		"enforces %s in the raw input stream, independently of noVNC",
		async (mode) => {
			const fixture = await gatewayFixture(mode);
			const view = await fixture.attach();
			view.socket.write(Buffer.concat([hello, key]));
			await vi.waitFor(() =>
				expect(Buffer.concat(fixture.received).length).toBe(
					mode === "watch" ? hello.length : hello.length + key.length,
				),
			);
			expect(fixture.authority.admitInputWindow).toHaveBeenCalledTimes(mode === "watch" ? 0 : 1);
			expect(fixture.authority.recordInput).toHaveBeenCalledTimes(mode === "watch" ? 0 : 1);
			if (mode !== "watch")
				expect(fixture.authority.recordInput).toHaveBeenCalledWith(
					expect.objectContaining({ mode, binding: computerBinding() }),
					{ sequence: 1, bytes: key },
				);
		},
	);

	it("releases only a shared viewer's held input when it disconnects", async () => {
		const fixture = await gatewayFixture("shared");
		const view = await fixture.attach();
		const pointer = Buffer.from([5, 1, 0, 20, 0, 30]);
		const releasedKey = Buffer.from(key);
		releasedKey[1] = 0;
		const releasedPointer = Buffer.from(pointer);
		releasedPointer[1] = 0;
		view.socket.write(Buffer.concat([hello, key, pointer]));
		await vi.waitFor(() => expect(Buffer.concat(fixture.received)).toEqual(Buffer.concat([hello, key, pointer])));
		view.socket.destroy();
		await vi.waitFor(() => expect(fixture.authority.release).toHaveBeenCalledOnce());
		expect(Buffer.concat(fixture.received)).toEqual(
			Buffer.concat([hello, key, pointer, releasedKey, releasedPointer]),
		);
		expect(fixture.authority.recordInput).toHaveBeenCalledTimes(2);
		expect(fixture.authority.admitInputWindow).toHaveBeenCalledOnce();
		const replacement = await fixture.attach();
		expect(replacement.socket.destroyed).toBe(false);
	});

	it("fences shared input immediately and drains only previously forwarded keys", async () => {
		const fixture = await gatewayFixture("shared");
		const view = await fixture.attach();
		view.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(Buffer.concat(fixture.received)).toEqual(Buffer.concat([hello, key])));
		await fixture.gateway.connections.fenceScreen(
			{ state: "draining", drainId: computerId(55), epoch: 2, binding: computerBinding() },
			new AbortController().signal,
		);
		const release = Buffer.from(key);
		release[1] = 0;
		expect(Buffer.concat(fixture.received)).toEqual(Buffer.concat([hello, key, release]));
		await expect(fixture.attach()).rejects.toThrow("VIEW_UNAVAILABLE");
	});

	it("journals why a ticket was refused while the member still sees only VIEW_UNAVAILABLE", async () => {
		const refusals: Array<[string, unknown]> = [];
		const fixture = await gatewayFixture("watch", undefined, (stage, error) => refusals.push([stage, error]));
		const capability = randomBytes(32).toString("base64url");
		(await fixture.attach(capability)).socket.destroy();
		// The same ticket again: the authority refuses it before any guest contact.
		await expect(fixture.attach(capability)).rejects.toThrow("VIEW_UNAVAILABLE");
		const redeem = refusals.filter(([stage]) => stage === "redeem");
		expect(redeem).toHaveLength(1);
		expect((redeem[0][1] as Error).message).toBe("CAPABILITY_ALREADY_REDEEMED");
		// A malformed first line is refused at the handshake, again with the same closed answer.
		const socket = connect(fixture.gateway.port, "127.0.0.1");
		sockets.add(socket);
		const answer = await new Promise<string>((resolve) => {
			let text = "";
			socket.on("data", (bytes: Buffer) => {
				text += bytes.toString("utf8");
			});
			socket.on("close", () => resolve(text));
			socket.write(`${JSON.stringify({ schema: "not-the-view-schema", capability })}\n`);
		});
		expect(JSON.parse(answer)).toEqual({ ok: false, error: "VIEW_UNAVAILABLE" });
		expect(refusals.at(-1)?.[0]).toBe("handshake");
		expect((refusals.at(-1)?.[1] as Error).message).toBe("INVALID_VIEW_HANDSHAKE");
		// An observer that throws changes nothing for the member.
		const broken = await gatewayFixture("watch", undefined, () => {
			throw new Error("journal unavailable");
		});
		const reused = randomBytes(32).toString("base64url");
		(await broken.attach(reused)).socket.destroy();
		await expect(broken.attach(reused)).rejects.toThrow("VIEW_UNAVAILABLE");
	});

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
		expect(fixture.authority.admitInputWindow).not.toHaveBeenCalled();
		expect(fixture.authority.recordInput).not.toHaveBeenCalled();
	});

	it("checks revocation before input dispatch, disconnects and releases only the old session", async () => {
		const fixture = await gatewayFixture("control");
		const view = await fixture.attach();
		view.socket.write(hello);
		await vi.waitFor(() => expect(Buffer.concat(fixture.received)).toEqual(hello));
		fixture.authority.admitInputWindow = vi.fn(async () => {
			throw new CompanyComputerViewerInputRefused();
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
		expect(fixture.authority.recordInput).not.toHaveBeenCalled();
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
			// The periodic check runs at half the grant's validity.
			fixture.grant.validForMs = 300;
			const view = await fixture.attach();
			view.socket.resume();
			Object.assign(fixture.grant, changed);
			await vi.waitFor(() => expect(view.socket.destroyed).toBe(true), { timeout: 1000, interval: 10 });
		}
	});

	it("revalidates other client traffic at most once per second instead of once per chunk", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		cleanups.push(async () => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});
		const fixture = await gatewayFixture();
		const view = await fixture.attach();
		view.socket.resume();
		const checks = vi.mocked(fixture.authority.check).mock.calls.length;
		view.socket.write(hello);
		const request = Buffer.from([3, 1, 0, 0, 0, 0, 7, 128, 4, 176]);
		for (let index = 0; index < 50; index++) view.socket.write(request);
		await vi.waitFor(() => expect(Buffer.concat(fixture.received).length).toBe(hello.length + 50 * request.length));
		expect(fixture.authority.check).toHaveBeenCalledTimes(checks);
		vi.setSystemTime(Date.now() + 1050);
		fixture.authority.check = vi.fn(async () => {
			throw new Error("MEMBER_REVOKED");
		});
		view.socket.write(request);
		await vi.waitFor(() => expect(view.socket.destroyed).toBe(true));
		expect(Buffer.concat(fixture.received).length).toBe(hello.length + 50 * request.length);
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

const move = (x: number, mask = 0): Buffer => Buffer.from([5, mask, x >> 8, x & 255, 0, 9]);
const inputsOf = (received: Buffer[]): Buffer => Buffer.concat(received).subarray(hello.length);

describe("windowed member input (loopback only, authority/guest doubles)", () => {
	// Sockets stay real; only the clocks the gateway schedules and measures with are fake.
	// The gateway measures with perf_hooks, which fake timers do not reach: tie it to the fake clock.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	const admitted = (validForMs = 1000): InputWindow => ({ validForMs, pendingReports: 0 });
	// Real time, for the gateway to finish work that no fake timer stands for.
	const settle = (ms = 30) =>
		new Promise<void>((resolve) => {
			const timer = setInterval(() => {
				clearInterval(timer);
				resolve();
			}, ms);
		});
	const keyUp = Buffer.from([4, 0, 0, 0, 0, 0, 0, 65]);
	const otherKey = Buffer.from([4, 1, 0, 0, 0, 0, 0, 66]);

	it("dispatches a burst of 500 pointer packets under one window admission, in contiguous sequence", async () => {
		const fixture = await gatewayFixture("shared");
		const view = await fixture.attach();
		view.socket.resume();
		// Alternating button masks: every packet is a press or release, so none may be coalesced.
		const packets = Array.from({ length: 500 }, (_, index) => move(index, index % 2));
		const started = performance.now();
		view.socket.write(Buffer.concat([hello, ...packets]));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(Buffer.concat(packets)), { interval: 5 });
		expect(vi.mocked(fixture.authority.admitInputWindow).mock.calls.length).toBeLessThanOrEqual(
			1 + Math.floor((performance.now() - started) / 500),
		);
		expect(vi.mocked(fixture.authority.recordInput).mock.calls.map(([, input]) => input.sequence)).toEqual(
			packets.map((_, index) => index + 1),
		);
		// Input keeps flowing: about one renewal per half second, never one per packet.
		const before = vi.mocked(fixture.authority.admitInputWindow).mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(vi.mocked(fixture.authority.admitInputWindow).mock.calls.length - before).toBeLessThanOrEqual(3);
	});

	it("forwards input while a renewal is still in flight, without waiting for the registry", async () => {
		const fixture = await gatewayFixture("control");
		const view = await fixture.attach();
		view.socket.resume();
		view.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(key), { interval: 5 });
		fixture.authority.admitInputWindow = vi.fn(() => new Promise<InputWindow>(() => undefined));
		await vi.advanceTimersByTimeAsync(600);
		expect(fixture.authority.admitInputWindow).toHaveBeenCalledOnce();
		view.socket.write(keyUp);
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(Buffer.concat([key, keyUp])), { interval: 5 });
		expect(view.socket.destroyed).toBe(false);
	});

	it("ends at once on an explicit refusal, within the window bound, and releases held keys", async () => {
		const fixture = await gatewayFixture("shared");
		const view = await fixture.attach();
		view.socket.resume();
		const held = move(40, 1);
		view.socket.write(Buffer.concat([hello, key, held]));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(Buffer.concat([key, held])), { interval: 5 });
		// The registry fences this viewer now. The gateway learns it at the next renewal.
		const fenced = performance.now();
		fixture.authority.admitInputWindow = vi.fn(async () => {
			throw new CompanyComputerViewerInputRefused();
		});
		await vi.advanceTimersByTimeAsync(600);
		await vi.waitFor(() => expect(view.socket.destroyed).toBe(true), { interval: 5 });
		expect(performance.now() - fenced).toBeLessThan(1000);
		await vi.waitFor(() => expect(fixture.authority.release).toHaveBeenCalledOnce());
		expect(inputsOf(fixture.received)).toEqual(Buffer.concat([key, held, keyUp, move(40, 0)]));
		expect(fixture.authority.admitInputWindow).toHaveBeenCalledOnce();
	});

	it("drops packets that arrive without a window, never replays them, and keeps the stream", async () => {
		const fixture = await gatewayFixture("control");
		let fail: ((error: Error) => void) | undefined;
		fixture.authority.admitInputWindow = vi.fn(
			() =>
				new Promise<InputWindow>((_resolve, reject) => {
					fail = reject;
				}),
		);
		const view = await fixture.attach();
		view.socket.resume();
		view.socket.write(Buffer.concat([hello, key, move(1), move(2, 1)]));
		await vi.waitFor(() => expect(fail).toBeTypeOf("function"), { interval: 5 });
		view.socket.write(move(3, 1));
		fail!(new Error("OFFICE_REGISTRY_UNCONFIRMED"));
		fixture.authority.admitInputWindow = vi.fn(async () => admitted());
		// Both chunks are read and dropped now, not held for the next window.
		await settle();
		await vi.advanceTimersByTimeAsync(1000);
		expect(inputsOf(fixture.received).length).toBe(0);
		expect(fixture.authority.recordInput).not.toHaveBeenCalled();
		// Nothing was dispatched, so nothing retries by itself. The next packet opens a fresh window.
		expect(fixture.authority.admitInputWindow).not.toHaveBeenCalled();
		expect(view.socket.destroyed).toBe(false);
		view.socket.write(otherKey);
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(otherKey), { interval: 5 });
		expect(vi.mocked(fixture.authority.recordInput).mock.calls.map(([, input]) => input.sequence)).toEqual([1]);
	});

	it("a renewal slower than the window keeps the stream, drops input meanwhile and resumes on the next window", async () => {
		const fixture = await gatewayFixture("shared");
		const view = await fixture.attach();
		view.socket.resume();
		view.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(key), { interval: 5 });
		// A slow agent-side transaction holds the office rows for 1.5 s.
		const slow = vi.fn(() => new Promise<InputWindow>((resolve) => setTimeout(() => resolve(admitted()), 1500)));
		fixture.authority.admitInputWindow = slow;
		await vi.advanceTimersByTimeAsync(1100);
		expect(slow).toHaveBeenCalledOnce();
		// The confirmed window lapsed at one second: input is dropped and the held key released.
		view.socket.write(move(7));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(Buffer.concat([key, keyUp])), { interval: 5 });
		fixture.authority.admitInputWindow = vi.fn(async () => admitted());
		// The attempt is given up after one second; the unreported window is resent shortly after.
		await vi.advanceTimersByTimeAsync(800);
		expect(fixture.authority.admitInputWindow).toHaveBeenCalled();
		expect(view.socket.destroyed).toBe(false);
		view.socket.write(otherKey);
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(Buffer.concat([key, keyUp, otherKey])), {
			interval: 5,
		});
		expect(fixture.authority.release).not.toHaveBeenCalled();
	});

	it("ends the connection and releases held keys once dispatched input stays unreported for the retry budget", async () => {
		const fixture = await gatewayFixture("shared");
		const view = await fixture.attach();
		view.socket.resume();
		view.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(key), { interval: 5 });
		const started = performance.now();
		fixture.authority.admitInputWindow = vi.fn(async () => {
			throw new Error("OFFICE_REGISTRY_UNCONFIRMED");
		});
		await vi.advanceTimersByTimeAsync(2900);
		await settle();
		expect(view.socket.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(1200);
		await vi.waitFor(() => expect(view.socket.destroyed).toBe(true), { interval: 5 });
		expect(performance.now() - started).toBeLessThan(4500);
		await vi.waitFor(() => expect(fixture.authority.release).toHaveBeenCalledOnce());
		expect(inputsOf(fixture.received)).toEqual(Buffer.concat([key, keyUp]));
		// Bounded resends, a quarter second apart: never a tight loop.
		expect(vi.mocked(fixture.authority.admitInputWindow).mock.calls.length).toBeLessThanOrEqual(14);
	});

	it("a failed idle renewal with nothing to report never ends the connection", async () => {
		const fixture = await gatewayFixture("control");
		const view = await fixture.attach();
		view.socket.resume();
		view.socket.write(Buffer.concat([hello, key, keyUp]));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(Buffer.concat([key, keyUp])), { interval: 5 });
		// The first renewal reports the two packets. Every later one is an empty linger renewal.
		await vi.advanceTimersByTimeAsync(600);
		expect(fixture.authority.admitInputWindow).toHaveBeenCalledTimes(2);
		fixture.authority.admitInputWindow = vi.fn(async () => {
			throw new Error("OFFICE_REGISTRY_UNCONFIRMED");
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fixture.authority.admitInputWindow).toHaveBeenCalledOnce();
		expect(view.socket.destroyed).toBe(false);
		fixture.authority.admitInputWindow = vi.fn(async () => admitted());
		view.socket.write(otherKey);
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(Buffer.concat([key, keyUp, otherKey])), {
			interval: 5,
		});
	});

	it("lets the window lapse when input stops: no registry calls while idle", async () => {
		const fixture = await gatewayFixture("control");
		fixture.authority.admitInputWindow = vi.fn(async () => admitted(40));
		const view = await fixture.attach();
		view.socket.resume();
		view.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(key), { interval: 5 });
		// Renewals continue through the linger (3 s), then stop.
		await vi.advanceTimersByTimeAsync(3300);
		const calls = vi.mocked(fixture.authority.admitInputWindow).mock.calls.length;
		expect(calls).toBeGreaterThan(1);
		await vi.advanceTimersByTimeAsync(5000);
		expect(fixture.authority.admitInputWindow).toHaveBeenCalledTimes(calls);
		expect(view.socket.destroyed).toBe(false);
	});

	it("a button released for a lapsed window is not pressed again, late, when the next window opens", async () => {
		const fixture = await gatewayFixture("shared");
		fixture.authority.admitInputWindow = vi.fn(async () => admitted(100));
		const view = await fixture.attach();
		view.socket.resume();
		view.socket.write(Buffer.concat([hello, move(10, 1)]));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(move(10, 1)), { interval: 5 });
		fixture.authority.admitInputWindow = vi.fn(async () => {
			throw new Error("OFFICE_REGISTRY_UNCONFIRMED");
		});
		await vi.advanceTimersByTimeAsync(200);
		view.socket.write(move(11, 1));
		await vi.waitFor(() => expect(inputsOf(fixture.received)).toEqual(Buffer.concat([move(10, 1), move(10, 0)])), {
			interval: 5,
		});
		fixture.authority.admitInputWindow = vi.fn(async () => admitted());
		await vi.advanceTimersByTimeAsync(400);
		// The member still holds the button: the drag continues as plain moves until it is let go.
		view.socket.write(move(12, 1));
		await vi.waitFor(() => expect(inputsOf(fixture.received).subarray(-6)).toEqual(move(12, 0)), { interval: 5 });
		view.socket.write(move(12, 0));
		await vi.waitFor(() => expect(fixture.authority.recordInput).toHaveBeenCalledTimes(3), { interval: 5 });
		view.socket.write(move(13, 1));
		await vi.waitFor(() => expect(inputsOf(fixture.received).subarray(-6)).toEqual(move(13, 1)), { interval: 5 });
	});

	it("caps input throughput per viewer: excess moves are dropped, an excess of key or button events ends it", async () => {
		const fixture = await gatewayFixture("shared");
		const view = await fixture.attach();
		view.socket.resume();
		view.socket.write(hello);
		// Separate chunks, so the moves are not already collapsed by coalescing.
		for (let index = 0; index < 560; index++) {
			view.socket.write(move(index));
			await new Promise((resolve) => setImmediate(resolve));
		}
		await vi.waitFor(() => expect(fixture.authority.recordInput).toHaveBeenCalled(), { interval: 5 });
		await new Promise((resolve) => setImmediate(resolve));
		expect(vi.mocked(fixture.authority.recordInput).mock.calls.length).toBeLessThanOrEqual(500);
		expect(view.socket.destroyed).toBe(false);
		const flood = Array.from({ length: 501 }, (_, index) => move(index, index % 2));
		view.socket.write(Buffer.concat(flood));
		await vi.waitFor(() => expect(view.socket.destroyed).toBe(true), { interval: 5 });
		expect(vi.mocked(fixture.authority.recordInput).mock.calls.length).toBeLessThanOrEqual(500);
		// The next second starts a fresh allowance for a new connection.
		await vi.advanceTimersByTimeAsync(1000);
		const next = await fixture.attach();
		next.socket.write(Buffer.concat([hello, key]));
		await vi.waitFor(() => expect(inputsOf(fixture.received).subarray(-8)).toEqual(key), { interval: 5 });
	});

	it("coalesces pending pointer moves but never across a button change or a key event", async () => {
		const input = (bytes: Buffer) => ({ kind: "input" as const, bytes });
		const protocol = { kind: "protocol" as const, bytes: Buffer.from([3, 1, 0, 0, 0, 0, 7, 128, 4, 176]) };
		const down = Buffer.from(key);
		const batch = [
			input(move(1)),
			input(move(2)),
			protocol,
			input(move(3)),
			input(move(4, 1)), // press: kept at its own position
			input(move(5, 1)),
			input(move(6, 1)),
			input(move(7)), // release
			input(move(8)),
			input(down),
			input(move(9)),
			input(move(10)),
		];
		expect(coalesceCompanyComputerPointerMoves(batch, 0).map((message) => message.bytes)).toEqual(
			[protocol.bytes, move(3), move(4, 1), move(6, 1), move(7), move(8), down, move(9), move(10)].map((bytes) =>
				Buffer.from(bytes),
			),
		);
		// The first pointer packet of a connection, and the first after a key, count as a transition.
		expect(coalesceCompanyComputerPointerMoves([input(move(1)), input(move(2)), input(move(3))], undefined)).toEqual([
			input(move(1)),
			input(move(3)),
		]);
		// A mask carried over from the previous chunk still protects the press in this one.
		expect(coalesceCompanyComputerPointerMoves([input(move(1, 1)), input(move(2, 1))], 0)).toEqual([
			input(move(1, 1)),
			input(move(2, 1)),
		]);
		const fixture = await gatewayFixture("shared");
		const view = await fixture.attach();
		view.socket.resume();
		const moves = Array.from({ length: 450 }, (_, index) => move(index));
		view.socket.write(Buffer.concat([hello, ...moves, key]));
		await vi.waitFor(
			() => expect(inputsOf(fixture.received).subarray(-14)).toEqual(Buffer.concat([move(449), key])),
			{ interval: 5 },
		);
		// Only what each received chunk ends with survives; never the whole queue.
		expect(inputsOf(fixture.received).length).toBeLessThan(40 * 6);
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
		view.socket.resume();
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
		view.socket.resume();
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
