import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NATIVE_CHATGPT_PLAN_EGRESS_HOSTS,
	NATIVE_CLAUDE_CODE_EGRESS_HOSTS,
	NATIVE_CLAUDE_READ_CONNECTIONS,
	NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS,
	NATIVE_CODEX_REALTIME_EGRESS_HOSTS,
	NATIVE_EGRESS_LONG_IDLE_MS,
	type NativeEgressTransport,
	nativeClientHelloServerName,
	nativeEgressPublicAddress,
	startNativeCodexEgress,
} from "@qorpera/runtime/cloud-native-egress";
import { afterEach, describe, expect, it, vi } from "vitest";

function hello(name = "chatgpt.com", extras = Buffer.alloc(0)): Buffer {
	const text = Buffer.from(name);
	const sni = Buffer.alloc(9 + text.length);
	sni.writeUInt16BE(0, 0);
	sni.writeUInt16BE(5 + text.length, 2);
	sni.writeUInt16BE(3 + text.length, 4);
	sni[6] = 0;
	sni.writeUInt16BE(text.length, 7);
	text.copy(sni, 9);
	const extensions = Buffer.concat([sni, extras]);
	const body = Buffer.alloc(43 + extensions.length);
	body.writeUInt16BE(0x0303);
	body[34] = 0;
	body.writeUInt16BE(2, 35);
	body.writeUInt16BE(0x1301, 37);
	body[39] = 1;
	body[40] = 0;
	body.writeUInt16BE(extensions.length, 41);
	extensions.copy(body, 43);
	const record = Buffer.alloc(9 + body.length);
	record[0] = 22;
	record.writeUInt16BE(0x0301, 1);
	record.writeUInt16BE(body.length + 4, 3);
	record[5] = 1;
	record.writeUIntBE(body.length, 6, 3);
	body.copy(record, 9);
	return record;
}

describe("native egress framing", () => {
	it("parses complete and fragmented ClientHello without decrypting TLS", () => {
		const frame = hello();
		for (let index = 0; index < frame.length; index++)
			expect(nativeClientHelloServerName(frame.subarray(0, index))).toBeUndefined();
		expect(nativeClientHelloServerName(frame)).toBe("chatgpt.com");
		const first = Buffer.from(frame.subarray(0, 23));
		first.writeUInt16BE(18, 3);
		const second = Buffer.alloc(5 + frame.length - 23);
		second[0] = 22;
		second.writeUInt16BE(0x0303, 1);
		second.writeUInt16BE(frame.length - 23, 3);
		frame.copy(second, 5, 23);
		expect(nativeClientHelloServerName(Buffer.concat([first, second]))).toBe("chatgpt.com");
	});
	it.each([
		"127.0.0.1",
		"0.0.0.0",
		"10.41.0.1",
		"192.168.0.90",
		"172.16.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"198.18.0.1",
		"203.0.113.1",
		"198.51.100.1",
		"224.0.0.1",
		"255.255.255.255",
		"::1",
		"::ffff:127.0.0.1",
		"garbage",
	])("denies non-public destination %s", (address) => {
		expect(nativeEgressPublicAddress(address)).toBe(false);
	});
	it("accepts ordinary public IPv4", () => {
		expect(nativeEgressPublicAddress("93.184.216.34")).toBe(true);
	});
	it.each([Buffer.from([0xfe, 0x0d, 0, 0]), Buffer.from([0, 0, 0, 0])])(
		"rejects ECH or duplicate SNI",
		(extension) => {
			expect(() => nativeClientHelloServerName(hello("chatgpt.com", extension))).toThrow();
		},
	);
	it("rejects HTTP, oversized records, missing/ambiguous and malformed names", () => {
		for (const name of ["CHATGPT.COM", "chatgpt.com\0evil.test", "", "user@chatgpt.com", "chatgpt.com/evil"])
			expect(() => nativeClientHelloServerName(hello(name))).toThrow();
		expect(() => nativeClientHelloServerName(Buffer.from("GET / HTTP/1.1\r\n"))).toThrow();
		expect(() => nativeClientHelloServerName(Buffer.alloc(65_537))).toThrow();
		const record = hello();
		record.writeUInt16BE(16_385, 3);
		expect(() => nativeClientHelloServerName(record)).toThrow();
		const malformed = hello();
		malformed[9 + 43 + 4] = 1;
		expect(() => nativeClientHelloServerName(malformed)).toThrow();
	});
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function relay(transport: NativeEgressTransport, hosts?: readonly string[]) {
	const root = await mkdtemp(join(tmpdir(), "q-egress-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const abort = new AbortController();
	const server = await startNativeCodexEgress({ root, signal: abort.signal, transport, ...(hosts ? { hosts } : {}) });
	cleanup.push(() => server.close());
	const client = createConnection(server.path);
	client.on("error", () => undefined);
	client.on("data", () => undefined);
	cleanup.push(async () => {
		client.destroy();
	});
	await once(client, "connect");
	return { client, abort, path: server.path, server };
}

async function rejected(client: Socket, bytes: Buffer | string): Promise<void> {
	const closed = once(client, "close");
	client.write(bytes);
	await closed;
}

describe("private native egress relay", () => {
	it("closes idempotently and rejects creation with cancelled authority", async () => {
		const root = await mkdtemp(join(tmpdir(), "q-egress-close-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		await expect(startNativeCodexEgress({ root, signal: AbortSignal.abort() })).rejects.toThrow();
		const server = await startNativeCodexEgress({ root, signal: new AbortController().signal });
		cleanup.push(() => server.close());
		await Promise.all([server.close(), server.close()]);
		const socket = createConnection(server.path);
		await once(socket, "error");
	});
	it("fails closed when the private socket cannot be created", async () => {
		const root = await mkdtemp(join(tmpdir(), "q-egress-occupied-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		const first = await startNativeCodexEgress({ root, signal: new AbortController().signal });
		cleanup.push(() => first.close());
		await expect(startNativeCodexEgress({ root, signal: new AbortController().signal })).rejects.toThrow(
			"Native egress unavailable",
		);
	});
	it.each([
		"CONNECT evil.test:443 HTTP/1.1\r\n\r\n",
		"CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n",
		"CONNECT chatgpt.com:80 HTTP/1.1\r\n\r\n",
		"CONNECT user@chatgpt.com:443 HTTP/1.1\r\n\r\n",
		"CONNECT chatgpt.com.:443 HTTP/1.1\r\n\r\n",
		"GET https://chatgpt.com/ HTTP/1.1\r\n\r\n",
		"CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: evil.test\r\n\r\n",
		"CONNECT chatgpt.com:443 HTTP/1.1\r\nContent-Length: 10\r\n\r\n",
		"CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nHost: chatgpt.com:443\r\n\r\n",
	])("denies malformed or unauthorized target before DNS", async (header) => {
		const transport = { resolve: vi.fn(async () => ["93.184.216.34"]), connect: vi.fn(() => new Socket()) };
		const { client } = await relay(transport);
		await rejected(client, header);
		expect(transport.resolve).not.toHaveBeenCalled();
		expect(transport.connect).not.toHaveBeenCalled();
	});
	it("denies mismatched SNI before DNS", async () => {
		const transport = { resolve: vi.fn(async () => ["93.184.216.34"]), connect: vi.fn(() => new Socket()) };
		const { client } = await relay(transport);
		await rejected(
			client,
			Buffer.concat([Buffer.from("CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n"), hello("evil.test")]),
		);
		expect(transport.resolve).not.toHaveBeenCalled();
	});
	it.each([{ addresses: ["127.0.0.1"] }, { addresses: ["93.184.216.34", "10.0.0.1"] }, { addresses: [] }])(
		"denies private/mixed/empty DNS answers",
		async ({ addresses }) => {
			const transport = { resolve: vi.fn(async () => addresses), connect: vi.fn(() => new Socket()) };
			const { client } = await relay(transport);
			await rejected(client, Buffer.concat([Buffer.from("CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n"), hello()]));
			expect(transport.connect).not.toHaveBeenCalled();
		},
	);
	it("pins the checked literal and forwards TLS bytes unchanged, then aborts both peers", async () => {
		let received = Buffer.alloc(0);
		const target = createServer((socket) => {
			socket.on("data", (bytes) => {
				received = Buffer.concat([received, bytes]);
				socket.write("synthetic-encrypted-response");
			});
		});
		target.listen(0, "127.0.0.1");
		await once(target, "listening");
		cleanup.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
		const address = target.address();
		if (!address || typeof address === "string") throw new Error("Missing listener");
		const transport = {
			resolve: vi.fn(async () => ["93.184.216.34"]),
			connect: vi.fn(() => createConnection(address.port, "127.0.0.1")),
		};
		const { client, abort } = await relay(transport);
		let response = "";
		const ready = new Promise<void>((resolve) =>
			client.on("data", (bytes) => {
				response += bytes.toString();
				if (response.includes("synthetic-encrypted-response")) resolve();
			}),
		);
		client.write(
			Buffer.concat([Buffer.from("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n"), hello()]),
		);
		await ready;
		expect(transport.resolve).toHaveBeenCalledExactlyOnceWith("chatgpt.com", expect.any(AbortSignal));
		expect(transport.connect).toHaveBeenCalledExactlyOnceWith("93.184.216.34");
		expect(received).toEqual(hello());
		const closed = once(client, "close");
		abort.abort();
		await closed;
	});
	it("lets a ChatGPT plan run reach OpenAI's API alone, and a Codex login's run not reach it", async () => {
		const transport = { resolve: vi.fn(async () => ["93.184.216.34"]), connect: vi.fn(() => new Socket()) };
		for (const host of ["chatgpt.com", "auth.openai.com"]) {
			const { client } = await relay(transport, NATIVE_CHATGPT_PLAN_EGRESS_HOSTS);
			await rejected(client, Buffer.concat([Buffer.from(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`), hello(host)]));
		}
		const { client } = await relay(transport);
		await rejected(
			client,
			Buffer.concat([Buffer.from("CONNECT api.openai.com:443 HTTP/1.1\r\n\r\n"), hello("api.openai.com")]),
		);
		expect(transport.resolve).not.toHaveBeenCalled();
		const plan = await relay(transport, NATIVE_CHATGPT_PLAN_EGRESS_HOSTS);
		plan.client.write(
			Buffer.concat([Buffer.from("CONNECT api.openai.com:443 HTTP/1.1\r\n\r\n"), hello("api.openai.com")]),
		);
		await vi.waitFor(() => expect(transport.resolve).toHaveBeenCalledWith("api.openai.com", expect.any(AbortSignal)));
		// Only the two lists the runtime knows: a run cannot name its own hosts.
		const root = await mkdtemp(join(tmpdir(), "q-egress-hosts-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		await expect(
			startNativeCodexEgress({ root, signal: new AbortController().signal, hosts: ["evil.test"] }),
		).rejects.toThrow("Unsupported native egress hosts");
	});
	it("holds 32 connections at once for a Claude read, and no more connections for any other relay", async () => {
		const root = await mkdtemp(join(tmpdir(), "q-egress-claude-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		for (const hosts of [NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS, undefined])
			await expect(
				startNativeCodexEgress({
					root,
					signal: new AbortController().signal,
					connections: NATIVE_CLAUDE_READ_CONNECTIONS,
					...(hosts ? { hosts } : {}),
				}),
			).rejects.toThrow("Only a Claude read's relay holds more connections");
		const server = await startNativeCodexEgress({
			root,
			signal: new AbortController().signal,
			hosts: NATIVE_CLAUDE_CODE_EGRESS_HOSTS,
			connections: NATIVE_CLAUDE_READ_CONNECTIONS,
		});
		cleanup.push(() => server.close());
		const held = await Promise.all(
			Array.from({ length: NATIVE_CLAUDE_READ_CONNECTIONS }, async () => {
				const socket = createConnection(server.path);
				socket.on("error", () => undefined);
				await once(socket, "connect");
				return socket;
			}),
		);
		cleanup.push(async () => {
			for (const socket of held) socket.destroy();
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(held.every((socket) => !socket.destroyed)).toBe(true);
		const over = createConnection(server.path);
		over.on("error", () => undefined);
		await once(over, "close");
	});
	it("carries any number of connections and bytes over a run's life, eight at a time (no caps on runs)", async () => {
		// Each connection answers 520 KiB: 130 in a row move 66 MiB, past the old 64 MiB and 128-connection totals.
		const answer = Buffer.alloc(520 * 1024, 7);
		const target = createServer((socket) => {
			socket.once("data", () => socket.write(answer));
			socket.on("error", () => undefined);
		});
		target.listen(0, "127.0.0.1");
		await once(target, "listening");
		cleanup.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
		const address = target.address();
		if (!address || typeof address === "string") throw new Error("Missing listener");
		const transport = {
			resolve: vi.fn(async () => ["93.184.216.34"]),
			connect: vi.fn(() => createConnection(address.port, "127.0.0.1")),
		};
		const { client, path } = await relay(transport);
		client.destroy();
		const established = Buffer.byteLength("HTTP/1.1 200 Connection Established\r\n\r\n");
		const open = async (): Promise<Socket> => {
			const socket = createConnection(path);
			socket.on("error", () => undefined);
			await once(socket, "connect");
			return socket;
		};
		// One connection through the relay: its CONNECT and ClientHello, then the whole answer back.
		const through = async (): Promise<number> => {
			const socket = await open();
			let bytes = 0;
			const done = new Promise<void>((resolve, reject) => {
				socket.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes >= established + answer.length) resolve();
				});
				socket.once("close", () =>
					bytes >= established + answer.length ? resolve() : reject(new Error("closed early")),
				);
			});
			socket.write(
				Buffer.concat([Buffer.from("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n"), hello()]),
			);
			await done;
			socket.destroy();
			return bytes - established;
		};
		let moved = 0;
		for (let connection = 0; connection < 130; connection += 1) moved += await through();
		expect(moved).toBeGreaterThan(64 * 1024 * 1024);
		expect(transport.connect).toHaveBeenCalledTimes(130);
		// The relay is still up, and still holds eight at once: a ninth waiting one is refused, and a slot frees.
		const held = await Promise.all(Array.from({ length: 8 }, open));
		const ninth = createConnection(path);
		ninth.on("error", () => undefined);
		await once(ninth, "close");
		held[0]?.destroy();
		await vi.waitFor(async () => {
			const socket = await open();
			const closed = once(socket, "close");
			const alive = await Promise.race([
				closed.then(() => false),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50)),
			]);
			socket.destroy();
			expect(alive).toBe(true);
		});
		for (const socket of held) socket.destroy();
		await vi.waitFor(async () => expect(await through()).toBe(answer.length));
	});

	it("cancels an unresolved DNS request without opening a connection", async () => {
		let resolving: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			resolving = resolve;
		});
		const transport = {
			resolve: vi.fn(
				(_host: string, signal: AbortSignal) =>
					new Promise<string[]>((_resolve, reject) => {
						resolving();
						signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
					}),
			),
			connect: vi.fn(() => new Socket()),
		};
		const { client, abort } = await relay(transport);
		client.write(Buffer.concat([Buffer.from("CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n"), hello()]));
		await started;
		const closed = once(client, "close");
		abort.abort();
		await closed;
		expect(transport.connect).not.toHaveBeenCalled();
	});

	describe("a voice call's window", () => {
		const marker = "synthetic-encrypted-response";
		async function target() {
			const listener = createServer((socket) => {
				socket.on("data", () => socket.write(marker));
				socket.on("error", () => undefined);
			});
			listener.listen(0, "127.0.0.1");
			await once(listener, "listening");
			cleanup.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
			const address = listener.address();
			if (!address || typeof address === "string") throw new Error("Missing listener");
			return {
				resolve: vi.fn(async () => ["93.184.216.34"]),
				connect: vi.fn(() => createConnection(address.port, "127.0.0.1")),
			};
		}
		async function open(path: string): Promise<Socket> {
			const socket = createConnection(path);
			socket.on("error", () => undefined);
			// Read, so the relay's close is seen.
			socket.on("data", () => undefined);
			cleanup.push(async () => {
				socket.destroy();
			});
			await once(socket, "connect");
			return socket;
		}
		/** Sends `bytes` and waits for the target's answer through the tunnel. */
		function answered(socket: Socket, bytes: Buffer | string): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				let text = "";
				const data = (chunk: Buffer): void => {
					text += chunk.toString();
					if (!text.includes(marker)) return;
					socket.removeListener("data", data);
					socket.removeListener("close", closed);
					resolve();
				};
				const closed = (): void => reject(new Error("Tunnel closed"));
				socket.on("data", data);
				socket.once("close", closed);
				socket.write(bytes);
			});
		}
		const connect = (host: string, name = host): Buffer =>
			Buffer.concat([Buffer.from(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`), hello(name)]);
		async function tunnel(path: string, host: string): Promise<Socket> {
			const socket = await open(path);
			await answered(socket, connect(host));
			return socket;
		}

		it("lets OpenAI's API through a Codex login's relay only while a window is open, under the same checks", async () => {
			expect(NATIVE_CODEX_REALTIME_EGRESS_HOSTS).toEqual(["api.openai.com"]);
			expect(Object.isFrozen(NATIVE_CODEX_REALTIME_EGRESS_HOSTS)).toBe(true);
			const transport = await target();
			const { client, path, server } = await relay(transport);
			client.destroy();
			if (!server.allowRealtime) throw new Error("A Codex login's relay has a voice window");
			await rejected(await open(path), connect("api.openai.com"));
			expect(transport.resolve).not.toHaveBeenCalled();
			const end = server.allowRealtime();
			// The SNI must still name the host the CONNECT named, and only port 443 passes.
			await rejected(await open(path), connect("api.openai.com", "chatgpt.com"));
			await rejected(await open(path), "CONNECT api.openai.com:80 HTTP/1.1\r\n\r\n");
			await rejected(await open(path), connect("api.anthropic.com"));
			expect(transport.resolve).not.toHaveBeenCalled();
			await tunnel(path, "api.openai.com");
			expect(transport.resolve).toHaveBeenCalledExactlyOnceWith("api.openai.com", expect.any(AbortSignal));
			end();
			await rejected(await open(path), connect("api.openai.com"));
			expect(transport.resolve).toHaveBeenCalledTimes(1);
			// The list's own hosts are as they were.
			await tunnel(path, "chatgpt.com");
		});

		it("nests windows, counts each closer once, and cuts the host's tunnels with the last one", async () => {
			const transport = await target();
			const { client, path, server } = await relay(transport);
			client.destroy();
			if (!server.allowRealtime) throw new Error("A Codex login's relay has a voice window");
			const first = server.allowRealtime();
			const second = server.allowRealtime();
			const call = await tunnel(path, "api.openai.com");
			const login = await tunnel(path, "chatgpt.com");
			first();
			first();
			// One window is still open: the tunnel carries on, and a new one opens.
			await answered(call, "more");
			const later = await tunnel(path, "api.openai.com");
			const cut = Promise.all([once(call, "close"), once(later, "close")]);
			second();
			await cut;
			await rejected(await open(path), connect("api.openai.com"));
			// A tunnel to the list's own host stands.
			await answered(login, "more");
			// A closer that already ran opens nothing again; a new window opens the host again.
			second();
			await rejected(await open(path), connect("api.openai.com"));
			const third = server.allowRealtime();
			await tunnel(path, "api.openai.com");
			third();
		});

		it("cuts a connection to the host that is still dialling when the window closes", async () => {
			let resolving: () => void = () => undefined;
			const started = new Promise<void>((resolve) => {
				resolving = resolve;
			});
			let answer: (addresses: string[]) => void = () => undefined;
			const transport = {
				resolve: vi.fn(
					() =>
						new Promise<string[]>((resolve) => {
							answer = resolve;
							resolving();
						}),
				),
				connect: vi.fn(() => new Socket()),
			};
			const { client, path, server } = await relay(transport);
			client.destroy();
			if (!server.allowRealtime) throw new Error("A Codex login's relay has a voice window");
			const end = server.allowRealtime();
			const socket = await open(path);
			const closed = once(socket, "close");
			socket.write(connect("api.openai.com"));
			await started;
			end();
			answer(["93.184.216.34"]);
			await closed;
			expect(transport.connect).not.toHaveBeenCalled();
		});

		it.each([
			["a ChatGPT plan", NATIVE_CHATGPT_PLAN_EGRESS_HOSTS],
			["a Claude sign-in", NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS],
		])("cannot widen the relay of %s", async (_name, hosts) => {
			const transport = await target();
			const { server } = await relay(transport, hosts);
			expect(server.allowRealtime).toBeUndefined();
			expect("allowRealtime" in server).toBe(false);
			expect("allowLongWaits" in server).toBe(false);
		});

		// A picture call (cloud-picture-channel.ts): the images request is silent until the picture exists.
		it("lets a Codex login's connections wait for a picture while a window is open, and lets no other host through", async () => {
			expect(NATIVE_EGRESS_LONG_IDLE_MS).toBe(300_000);
			const transport = await target();
			const { client, path, server } = await relay(transport);
			client.destroy();
			if (!server.allowLongWaits) throw new Error("A Codex login's relay has a picture window");
			const timeouts = vi.spyOn(Socket.prototype, "setTimeout");
			cleanup.push(async () => timeouts.mockRestore());
			const login = await tunnel(path, "chatgpt.com");
			// The connection and its upstream are each held to 30 s of silence.
			expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([30_000, 30_000]);
			timeouts.mockClear();
			const first = server.allowLongWaits();
			const second = server.allowLongWaits();
			// Open connections may wait five minutes once a window opens; a second window changes nothing.
			expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([
				NATIVE_EGRESS_LONG_IDLE_MS,
				NATIVE_EGRESS_LONG_IDLE_MS,
			]);
			timeouts.mockClear();
			// So may new ones, while the list's hosts stay the list's.
			const picture = await tunnel(path, "chatgpt.com");
			expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([
				NATIVE_EGRESS_LONG_IDLE_MS,
				NATIVE_EGRESS_LONG_IDLE_MS,
			]);
			await rejected(await open(path), connect("api.openai.com"));
			expect(transport.resolve).toHaveBeenCalledTimes(2);
			timeouts.mockClear();
			// A closer counts once; with the last one, every connection's 30 s count starts again.
			first();
			first();
			expect(timeouts).not.toHaveBeenCalled();
			second();
			const counted = timeouts.mock.calls.map(([ms]) => ms);
			expect(counted.length).toBeGreaterThanOrEqual(4);
			expect(counted.every((ms) => ms === 30_000)).toBe(true);
			await answered(login, "more");
			await answered(picture, "more");
		});
	});
});
