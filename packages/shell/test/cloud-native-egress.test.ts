import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

async function relay(transport: NativeEgressTransport) {
	const root = await mkdtemp(join(tmpdir(), "q-egress-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const abort = new AbortController();
	const server = await startNativeCodexEgress({ root, signal: abort.signal, transport });
	cleanup.push(() => server.close());
	const client = createConnection(server.path);
	client.on("error", () => undefined);
	client.on("data", () => undefined);
	cleanup.push(async () => {
		client.destroy();
	});
	await once(client, "connect");
	return { client, abort };
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
});
