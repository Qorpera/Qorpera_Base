import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CompanyComputerWebSocket,
	connectCompanyComputerViewChannel,
} from "../src/cloud-company-computer-view-channel.ts";

const id = (n: number) => `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = {
	companyId: id(1),
	environmentId: id(2),
	companyComputerId: id(3),
	logicalComputerId: id(4),
	computerGeneration: 1,
	screenId: id(5),
	screenOrdinal: 1,
	screenGeneration: 2,
	staffAgentId: id(6),
};
const encoded = (value: string) => new TextEncoder().encode(value).buffer;
class Socket implements CompanyComputerWebSocket {
	binaryType = "blob";
	readyState = 0;
	bufferedAmount = 0;
	onopen: CompanyComputerWebSocket["onopen"] = null;
	onmessage: CompanyComputerWebSocket["onmessage"] = null;
	onerror: CompanyComputerWebSocket["onerror"] = null;
	onclose: CompanyComputerWebSocket["onclose"] = null;
	sent: Uint8Array[] = [];
	send(bytes: ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
		this.sent.push(
			bytes instanceof ArrayBuffer
				? new Uint8Array(bytes.slice(0))
				: new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
		);
	}
	close = vi.fn(() => {
		this.readyState = 3;
	});
	open() {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}
	receive(bytes: unknown) {
		this.onmessage?.(new MessageEvent("message", { data: bytes }));
	}
}
function fixture(overrides: Partial<Parameters<typeof connectCompanyComputerViewChannel>[0]> = {}) {
	const socket = new Socket();
	const abort = new AbortController();
	const createWebSocket = vi.fn(() => socket);
	const args = {
		url: `wss://office.qorpera.test/office/${id(3)}/view`,
		capability: "A".repeat(43),
		binding,
		mode: "watch" as const,
		validForMs: 30000,
		signal: abort.signal,
		createWebSocket,
		...overrides,
	};
	const pending = connectCompanyComputerViewChannel(args);
	const ack = (changes = {}) => `${JSON.stringify({ ok: true, binding, mode: args.mode, ...changes })}\n`;
	return { socket, abort, createWebSocket, args, pending, ack };
}
afterEach(() => vi.useRealTimers());
describe("browser-safe office viewer channel", () => {
	it("keeps tickets out of URLs and preserves split/coalesced RFB bytes until noVNC attaches", async () => {
		const f = fixture();
		f.socket.open();
		expect(f.createWebSocket).toHaveBeenCalledExactlyOnceWith(f.args.url);
		expect(new TextDecoder().decode(f.socket.sent[0])).toBe(
			`${JSON.stringify({ schema: "qorpera.company-computer-screen-view/v2", capability: f.args.capability })}\n`,
		);
		f.socket.receive(encoded(f.ack().slice(0, 37)));
		f.socket.receive(encoded(`${f.ack().slice(37)}RFB 003.008\n`));
		f.socket.receive(encoded("next frame"));
		const channel = await f.pending;
		expect(channel.readyState).toBe(1);
		expect(JSON.stringify(channel)).not.toContain(f.args.capability);
		const received: string[] = [];
		channel.onmessage = (event) => {
			received.push(new TextDecoder().decode(event.data));
		};
		expect(received).toEqual([]); // Attach finishes before queued protocol bytes are dispatched.
		await Promise.resolve();
		expect(received).toEqual(["RFB 003.008\n", "next frame"]);
		channel.send(new Uint8Array([1]));
		expect(f.socket.sent[1]).toEqual(new Uint8Array([1]));
		channel.close();
		expect(f.socket.close).toHaveBeenCalledOnce();
	});
	it("rejects insecure, substituted, credential-bearing and noncanonical endpoints before connecting", async () => {
		for (const url of [
			`ws://office.qorpera.test/office/${id(3)}/view`,
			`wss://office.qorpera.test/office/${id(99)}/view`,
			`wss://user:password@office.qorpera.test/office/${id(3)}/view`,
			`wss://office.qorpera.test/office/${id(3)}/view?ticket=secret`,
			`wss://office.qorpera.test/office/${id(3)}/view#ticket`,
			`wss://office.qorpera.test:443/office/${id(3)}/view`,
		]) {
			const f = fixture({ url });
			await expect(f.pending).rejects.toThrow();
			expect(f.createWebSocket).not.toHaveBeenCalled();
		}
	});
	it("rejects mode/binding substitution, unknown fields, malformed UTF-8, text frames and oversized acknowledgements", async () => {
		for (const value of [
			{ mode: "control" },
			{ binding: { ...binding, screenGeneration: 3 } },
			{ credential: "secret" },
			{ binding: { ...binding, credential: "secret" } },
		]) {
			const f = fixture();
			f.socket.open();
			f.socket.receive(encoded(f.ack(value)));
			await expect(f.pending).rejects.toThrow("VIEW_UNAVAILABLE");
			expect(f.socket.close).toHaveBeenCalledOnce();
		}
		for (const bytes of [
			"not binary",
			new Uint8Array([255, 10]).buffer,
			encoded("x".repeat(4097)),
			new ArrayBuffer(256 * 1024 + 1),
		]) {
			const f = fixture();
			f.socket.open();
			f.socket.receive(bytes);
			await expect(f.pending).rejects.toThrow("VIEW_UNAVAILABLE");
		}
	});
	it("bounds handshake time, refuses late acknowledgements and never retries the ticket", async () => {
		vi.useFakeTimers();
		const f = fixture({ validForMs: 20 });
		f.socket.open();
		const rejected = expect(f.pending).rejects.toThrow("VIEW_UNAVAILABLE");
		await vi.advanceTimersByTimeAsync(21);
		await rejected;
		f.socket.receive(encoded(f.ack()));
		expect(f.socket.close).toHaveBeenCalledOnce();
		expect(f.createWebSocket).toHaveBeenCalledOnce();
		expect(f.socket.sent).toHaveLength(1);
	});
	it("aborts active channels, drops queued frames, and rejects input after cancellation", async () => {
		const f = fixture();
		f.socket.open();
		f.socket.receive(encoded(`${f.ack()}secret framebuffer`));
		const channel = await f.pending;
		const received = vi.fn();
		channel.onmessage = received;
		f.abort.abort();
		await Promise.resolve();
		expect(received).not.toHaveBeenCalled();
		expect(channel.readyState).toBe(3);
		expect(() => channel.send(new Uint8Array([1]))).toThrow("VIEW_UNAVAILABLE");
		expect(f.socket.sent).toHaveLength(1);
	});
	it("fails closed on bounded receive/send queues and ignores service close diagnostics", async () => {
		const f = fixture();
		f.socket.open();
		f.socket.receive(encoded(f.ack()));
		const channel = await f.pending;
		const closed = vi.fn();
		channel.onclose = closed;
		f.socket.receive(new ArrayBuffer(256 * 1024));
		f.socket.receive(new ArrayBuffer(1));
		expect(channel.readyState).toBe(3);
		await Promise.resolve();
		expect(closed.mock.calls[0][0].reason).toBe("");
		const g = fixture();
		g.socket.open();
		g.socket.receive(encoded(g.ack()));
		const other = await g.pending;
		g.socket.bufferedAmount = 256 * 1024;
		expect(() => other.send(new Uint8Array([1]))).toThrow("VIEW_UNAVAILABLE");
		expect(g.socket.sent).toHaveLength(1);
	});
});
