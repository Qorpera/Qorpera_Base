import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RFB_VERSION, STREAM_RECTS, STREAM_SIZE } from "../src/company-machine-stream.ts";
import {
	DESKTOP_STREAM_WORKER_BUFFER_BYTES,
	DESKTOP_STREAM_WORKER_LIMITS,
	type DesktopRelaySpec,
	WorkerDesktop,
} from "../src/company-machine-stream-worker.ts";

// A desktop's live picture watched in a worker thread of its own (review r11 of #1746): no byte of the guest's is read on
// the executor's main loop, and the main side trusts nothing the worker sends. The worker here is the real one (the real
// DesktopStream, the real protocol), with a test's transport for its relay, or a hostile one that breaks the protocol.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = (name: string) => new URL(`./fixtures/desktop-stream-worker-${name}.ts`, import.meta.url);
const spec = (name: string): DesktopRelaySpec => ({ project: "test", name, command: ["relay"], maxStdoutBytes: 65536 });

/** Starts a watched desktop in its worker; ended when the test ends. */
function watched(name: string, specName: string, options: ConstructorParameters<typeof WorkerDesktop>[3] = {}) {
	let endings = 0;
	const desktop = new WorkerDesktop(fixture(name), spec(specName), () => endings++, options);
	cleanups.push(() => desktop.close());
	return { desktop, endings: () => endings };
}

/** A release the test answers, cycle by cycle. */
function gate() {
	const asked: { resolve: (verdict: "ok" | "pending" | { end: string }) => void }[] = [];
	return {
		asked,
		release: () =>
			new Promise<"ok" | "pending" | { end: string }>((resolve) => {
				asked.push({ resolve });
			}),
	};
}

/** A sink that keeps what it was sent: each message's type and its areas' first colours. */
function sinkOf() {
	const messages: Buffer[] = [];
	return {
		messages,
		send: vi.fn(async (message: Buffer) => void messages.push(Buffer.from(message))),
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
						// The first pixel: after the PNG's IDAT, the first row's filter byte, then R, G, B.
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
const rawRect = (x: number, y: number, width: number, height: number, rgb: [number, number, number]) => {
	const head = Buffer.alloc(12);
	head.writeUInt16BE(x, 0);
	head.writeUInt16BE(y, 2);
	head.writeUInt16BE(width, 4);
	head.writeUInt16BE(height, 6);
	return Buffer.concat([head, fill(width, height, rgb)]);
};
const update = (...rects: Buffer[]) => {
	const head = Buffer.alloc(4);
	head.writeUInt16BE(rects.length, 2);
	return Buffer.concat([head, ...rects]);
};

/** A fake VNC server on the loopback that the worker's relay connects to. */
async function tcpDesktop(width = 64, height = 40) {
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

/** The longest the main loop was held while `work` ran: a timer that should fire every millisecond records its gaps. */
async function mainLoopWhile(work: () => Promise<void>): Promise<{ longest: number; heapGrowth: number }> {
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

describe("a desktop watched in a worker thread of its own (review r11 of #1746)", () => {
	it("lets go to a member only what changed before that member's cycle began, through the worker", async () => {
		const desktop = await tcpDesktop();
		const { desktop: watching } = watched("tcp", desktop.port);
		const sink = sinkOf();
		const { release, asked } = gate();
		const stop = new AbortController();
		const ending = watching.watch(release, sink, stop.signal);
		// The server said what it is: its size, let go by the member's first cycle, which the MAIN side decides.
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		asked[0]!.resolve("ok");
		await vi.waitFor(() => expect(sink.types()).toEqual([STREAM_SIZE]));
		// The whole screen, red: it waits for a cycle.
		await desktop.send(update(rawRect(0, 0, 64, 40, [255, 0, 0])));
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		// While that cycle runs, an area turns green: it changed after the cycle began, and is not let go with it.
		await desktop.send(update(rawRect(4, 4, 8, 8, [0, 255, 0])));
		await new Promise((resolve) => setTimeout(resolve, 50));
		asked[1]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"]]));
		await vi.waitFor(() => expect(asked).toHaveLength(3));
		asked[2]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"], ["4,4 8x8 #00ff00"]]));
		// The member closes it: closed at once, and the last member takes the worker with it.
		stop.abort();
		expect(await ending).toBe("closed");
		expect(watching.ended).toBe("idle");
	});

	it("leaves nothing on a member's signal from one release cycle to the next, however many there are", async () => {
		const desktop = await tcpDesktop();
		const file = join(mkdtempSync(join(tmpdir(), "desktop-stream-worker-")), "held");
		cleanups.push(() => rmSync(dirname(file), { recursive: true, force: true }));
		const { desktop: watching } = watched("listeners", `${desktop.port}:${file}`);
		const sink = sinkOf();
		const stop = new AbortController();
		const ending = watching.watch(async () => "ok", sink, stop.signal);
		await vi.waitFor(() => expect(sink.types()).toContain(STREAM_SIZE));
		await new Promise((resolve) => setTimeout(resolve, 300));
		const before = Number(readFileSync(file, "utf8"));
		// Some 80 cycles of the member's: the screen changes every 25 ms for 3 s.
		for (let n = 0; n < 120; n++) {
			await desktop.send(update(rawRect(0, 0, 8, 8, [n, 0, 0])));
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(sink.types().filter((type) => type === STREAM_RECTS).length).toBeGreaterThan(40);
		expect(Number(readFileSync(file, "utf8")) - before).toBeLessThan(5);
		stop.abort();
		expect(await ending).toBe("closed");
	}, 30_000);

	it("ends a member on its release check's refusal, and every member with the relay's end", async () => {
		const desktop = await tcpDesktop();
		const { desktop: watching } = watched("tcp", desktop.port);
		const refused = gate();
		const kept = gate();
		const one = watching.watch(refused.release, sinkOf(), new AbortController().signal);
		const two = watching.watch(kept.release, sinkOf(), new AbortController().signal);
		await vi.waitFor(() => expect(refused.asked).toHaveLength(1));
		refused.asked[0]!.resolve({ end: "DESKTOP_HELD_SINCE" });
		expect(await one).toBe("DESKTOP_HELD_SINCE");
		// The other member goes on; the desktop's end ends it with why.
		expect(watching.ended).toBeNull();
		await vi.waitFor(() => expect(kept.asked).toHaveLength(1));
		kept.asked[0]!.resolve("ok");
		await desktop.end();
		expect(await two).toBe("DESKTOP_ENDED");
	});

	it("terminates a worker that sends for a member it holds no released cycle for, and ends every member's stream", async () => {
		const { desktop, endings } = watched("hostile", "flood");
		const sink = sinkOf();
		expect(await desktop.watch(async () => "ok", sink, new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(sink.send).not.toHaveBeenCalled();
		expect(desktop.ended).toBe("STREAM_UNAVAILABLE");
		expect(desktop.cause).toBe("a send without a released cycle");
		expect(endings()).toBe(1);
	});

	it("terminates a worker that floods the main side past its bound in one turn", async () => {
		const { desktop } = watched("hostile", "chatter");
		const result = await mainLoopWhile(async () => {
			expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe(
				"STREAM_UNAVAILABLE",
			);
		});
		expect(result.longest).toBeLessThan(250);
		expect(desktop.cause).toBe("too many messages in one turn");
	});

	it("ends every member's stream cleanly when its worker dies mid-stream", async () => {
		const { desktop, endings } = watched("hostile", "die");
		const one = desktop.watch(async () => "ok", sinkOf(), new AbortController().signal);
		const two = desktop.watch(async () => "ok", sinkOf(), new AbortController().signal);
		expect(await Promise.all([one, two])).toEqual(["STREAM_UNAVAILABLE", "STREAM_UNAVAILABLE"]);
		expect(endings()).toBe(1);
		expect(desktop.cause).toBe("worker exited 3");
	});

	it("terminates a worker that stops answering", async () => {
		const { desktop } = watched("hostile", "silent", { pingEveryMs: 50, pongWithinMs: 400 });
		const began = Date.now();
		expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(Date.now() - began).toBeLessThan(5000);
		expect(desktop.cause).toBe("no answer to its pings");
	});

	it("loses only the worker when its heap runs out, never the executor's loop or heap", async () => {
		const { desktop } = watched("hostile", "oom", { resourceLimits: { maxOldGenerationSizeMb: 32 } });
		const result = await mainLoopWhile(async () => {
			expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe(
				"STREAM_UNAVAILABLE",
			);
		});
		expect(result.longest).toBeLessThan(250);
		expect(result.heapGrowth).toBeLessThan(32 * 1024 * 1024);
		expect(desktop.cause).toBe("worker error ERR_WORKER_OUT_OF_MEMORY");
	}, 60_000);

	it("terminates a worker whose buffers pass their bound, which no resourceLimits cap, while it answers everything else", async () => {
		const { desktop } = watched("hostile", "hoard", { bufferBytes: 128 * 1024 * 1024, bufferCheckEveryMs: 50 });
		const result = await mainLoopWhile(async () => {
			expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe(
				"STREAM_UNAVAILABLE",
			);
		});
		expect(desktop.cause).toMatch(/^its buffers past their bound \(\d+ MB\)$/);
		expect(result.longest).toBeLessThan(250);
		expect(DESKTOP_STREAM_WORKER_BUFFER_BYTES).toBe(512 * 1024 * 1024);
	}, 30_000);

	it("keeps the executor's loop free while a desktop sends a whole 3840 x 2160 screen one byte at a time (the reviewer's scenario)", async () => {
		const { desktop } = watched("bytes", "bytes");
		const sink = sinkOf();
		const stop = new AbortController();
		let ending: Promise<string> = Promise.resolve("");
		const result = await mainLoopWhile(async () => {
			ending = desktop.watch(async () => "ok", sink, stop.signal);
			// Four seconds of one-byte pieces, millions of them, read in the worker.
			await new Promise((resolve) => setTimeout(resolve, 4000));
		});
		// The worker kept it within its bounds (its pieces gathered into blocks), and lives; the main loop was never held
		// long, and its heap did not grow with the pieces.
		expect(desktop.ended).toBeNull();
		expect(sink.types()).toEqual([STREAM_SIZE]);
		expect(result.longest).toBeLessThan(100);
		expect(result.heapGrowth).toBeLessThan(16 * 1024 * 1024);
		stop.abort();
		expect(await ending).toBe("closed");
	}, 30_000);

	it("never keeps the executor's process alive by itself: a process with only a watched desktop left ends", () => {
		const module = new URL("../src/company-machine-stream-worker.ts", import.meta.url).href;
		const dir = mkdtempSync(join(tmpdir(), "desktop-stream-worker-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const script = join(dir, "only-a-desktop.mjs");
		writeFileSync(
			script,
			[
				`import { WorkerDesktop } from ${JSON.stringify(module)};`,
				`const desktop = new WorkerDesktop(new URL(${JSON.stringify(fixture("tcp").href)}), ${JSON.stringify(spec("1"))}, () => {});`,
				// Its worker runs (nothing ended it) when the process has nothing else left to do.
				'setTimeout(() => console.log("running", desktop.ended === null), 500);',
			].join("\n"),
		);
		const done = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15_000 });
		expect(done.stdout.trim()).toBe("running true");
		expect(done.signal).toBeNull();
		expect(done.status).toBe(0);
	}, 30_000);

	it("caps the worker's heap by its own limits", () => {
		expect(DESKTOP_STREAM_WORKER_LIMITS).toEqual({
			maxOldGenerationSizeMb: 128,
			maxYoungGenerationSizeMb: 16,
			codeRangeSizeMb: 32,
			stackSizeMb: 4,
		});
	});
});
