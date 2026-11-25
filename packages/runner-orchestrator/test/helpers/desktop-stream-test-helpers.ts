import { type ChildProcess, spawn } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, vi } from "vitest";
import { RFB_VERSION, STREAM_RECTS } from "../../src/company-machine-stream.ts";
import {
	DESKTOP_STREAM_MESSAGE_BYTES,
	DESKTOP_STREAM_READ_BYTES,
	DESKTOP_STREAM_ROLE,
	DESKTOP_STREAM_TURN_BYTES,
	DESKTOP_STREAM_TURN_UNITS,
	type DesktopRelaySpec,
	type DesktopStreamTurn,
	InstanceDesktop,
} from "../../src/company-machine-stream-process.ts";

export const fixture = (name: string) =>
	new URL(`../fixtures/desktop-stream-instance${name}.ts`, import.meta.url).pathname;
export const spec = (name: string): DesktopRelaySpec => ({
	project: "test",
	name,
	command: ["relay"],
	maxStdoutBytes: 65536,
});

export type CleanupList = (() => void | Promise<void>)[];

export async function instances(cleanups: CleanupList, program: string) {
	const dir = mkdtempSync(join(tmpdir(), "desktop-stream-"));
	const path = join(dir, "stream.sock");
	const started: {
		child: ChildProcess;
		exited: Promise<{ code: number | null; signal: string | null; at: number }>;
	}[] = [];
	const server: Server = createServer({ pauseOnConnect: true }, (connection: Socket) => {
		const child = spawn(process.execPath, [program, DESKTOP_STREAM_ROLE], {
			stdio: [connection, "ignore", "inherit"],
		});
		connection.destroy();
		started.push({
			child,
			exited: new Promise((resolve) =>
				child.on("exit", (code, signal) => resolve({ code, signal, at: performance.now() })),
			),
		});
	});
	await new Promise<void>((resolve) => server.listen(path, () => resolve()));
	cleanups.push(() => {
		for (const { child } of started) child.kill("SIGKILL");
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		path,
		started,
		watched: (name: string, options: Partial<ConstructorParameters<typeof InstanceDesktop>[3]> = {}) => {
			let endings = 0;
			const desktop = new InstanceDesktop(path, spec(name), () => endings++, {
				version: "test-version",
				...options,
			});
			cleanups.push(() => desktop.close());
			return { desktop, endings: () => endings };
		},
	};
}

export async function played(cleanups: CleanupList, reads: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "desktop-stream-played-"));
	const path = join(dir, "played.sock");
	let joined: (socket: Socket) => void = () => {};
	const connected = new Promise<Socket>((resolve) => {
		joined = resolve;
	});
	const sockets: Socket[] = [];
	const server = createServer({ pauseOnConnect: !reads }, (socket: Socket) => {
		socket.on("error", () => {});
		sockets.push(socket);
		joined(socket);
	});
	await new Promise<void>((resolve) => server.listen(path, () => resolve()));
	cleanups.push(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { path, write: async (bytes: Buffer) => void (await connected).write(bytes) };
}

export const TURN_CLOCK_MS = 500;
export const LOOP_CLOCK_MS = 1000;

export function withinBudget(turns: readonly DesktopStreamTurn[]): void {
	expect(turns.length).toBeGreaterThan(0);
	for (const turn of turns) {
		expect(turn.units).toBeLessThanOrEqual(DESKTOP_STREAM_TURN_UNITS + 2);
		expect(turn.bytes).toBeLessThanOrEqual(DESKTOP_STREAM_TURN_BYTES + DESKTOP_STREAM_READ_BYTES);
		expect(turn.held).toBeLessThanOrEqual(DESKTOP_STREAM_MESSAGE_BYTES + 9);
		expect(turn.ms).toBeLessThan(TURN_CLOCK_MS);
	}
}

export function gate() {
	const asked: { resolve: (verdict: "ok" | "pending" | { end: string }) => void }[] = [];
	return {
		asked,
		release: () =>
			new Promise<"ok" | "pending" | { end: string }>((resolve) => {
				asked.push({ resolve });
			}),
	};
}

export function sinkOf() {
	const messages: Buffer[] = [];
	return {
		messages,
		send: vi.fn(async (message: Buffer) => {
			messages.push(message);
		}),
		types: () => messages.map((message) => message[0]),
		areas: () =>
			messages
				.filter((message) => message[0] === STREAM_RECTS)
				.map((message) => {
					const out: string[] = [];
					let at = 3;
					for (let n = 0; n < message.readUInt16BE(1); n++) {
						const [x, y, w, h] = [0, 2, 4, 6].map((o) => message.readUInt16BE(at + o)) as number[];
						const length = message.readUInt32BE(at + 8);
						const png = message.subarray(at + 12, at + 12 + length);
						const idat = png.indexOf("IDAT");
						const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
						out.push(`${x},${y} ${w}x${h} #${raw.subarray(1, 4).toString("hex")}`);
						at += 12 + length;
					}
					return out;
				}),
	};
}

const fill = (width: number, height: number, [r, g, b]: [number, number, number]) => {
	const pixels = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) pixels.set([b, g, r, 0], i * 4);
	return pixels;
};
export const rawRect = (x: number, y: number, width: number, height: number, rgb: [number, number, number]) => {
	const head = Buffer.alloc(12);
	head.writeUInt16BE(x, 0);
	head.writeUInt16BE(y, 2);
	head.writeUInt16BE(width, 4);
	head.writeUInt16BE(height, 6);
	return Buffer.concat([head, fill(width, height, rgb)]);
};
export const noiseRect = (x: number, y: number, width: number, height: number) => {
	const head = Buffer.alloc(12);
	head.writeUInt16BE(x, 0);
	head.writeUInt16BE(y, 2);
	head.writeUInt16BE(width, 4);
	head.writeUInt16BE(height, 6);
	return Buffer.concat([head, randomFillSync(Buffer.allocUnsafe(width * height * 4))]);
};
export const update = (...rects: Buffer[]) => {
	const head = Buffer.alloc(4);
	head.writeUInt16BE(rects.length, 2);
	return Buffer.concat([head, ...rects]);
};

export async function tcpDesktop(cleanups: CleanupList, width = 64, height = 40) {
	let socket: Socket | null = null;
	let joined: (socket: Socket) => void = () => {};
	const connected = new Promise<Socket>((resolve) => {
		joined = resolve;
	});
	const server: Server = createServer((client) => {
		socket = client;
		client.on("error", () => {});
		client.on("data", () => {});
		const init = Buffer.alloc(30);
		init.writeUInt16BE(width, 0);
		init.writeUInt16BE(height, 2);
		init.writeUInt32BE(6, 20);
		init.write("Xvnc:1", 24, "latin1");
		client.write(Buffer.concat([RFB_VERSION, Buffer.from([1, 1]), Buffer.alloc(4), init]));
		joined(client);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	cleanups.push(() => {
		(socket as Socket | null)?.destroy();
		server.close();
	});
	return {
		port: String((server.address() as { port: number }).port),
		send: async (bytes: Buffer) => void (await connected).write(bytes),
		end: async () => void (await connected).end(),
	};
}

export async function mainLoopWhile(work: () => Promise<void>): Promise<{ longest: number; heapGrowth: number }> {
	const heapBefore = process.memoryUsage().heapUsed;
	let last = performance.now();
	let longest = 0;
	const tick = setInterval(() => {
		const now = performance.now();
		longest = Math.max(longest, now - last);
		last = now;
	}, 1);
	try {
		await work();
	} finally {
		clearInterval(tick);
	}
	return { longest, heapGrowth: process.memoryUsage().heapUsed - heapBefore };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const frameOf = (type: number, member: number, payload: Buffer = Buffer.alloc(0)) => {
	const head = Buffer.alloc(9);
	head.writeUInt32BE(payload.byteLength, 0);
	head[4] = type;
	head.writeUInt32BE(member, 5);
	return Buffer.concat([head, payload]);
};
