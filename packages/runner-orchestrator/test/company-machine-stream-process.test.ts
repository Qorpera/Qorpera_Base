import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RFB_VERSION, STREAM_RECTS, STREAM_SIZE } from "../src/company-machine-stream.ts";
import {
	DESKTOP_STREAM_BLOCK_BYTES,
	DESKTOP_STREAM_DRIP_MS,
	DESKTOP_STREAM_GUARD_MS,
	DESKTOP_STREAM_MEMBERS,
	DESKTOP_STREAM_MESSAGE_BYTES,
	DESKTOP_STREAM_MESSAGE_PIECES,
	DESKTOP_STREAM_ROLE,
	DESKTOP_STREAM_SECOND_UNITS,
	DESKTOP_STREAM_TURN_BYTES,
	DESKTOP_STREAM_TURN_UNITS,
	type DesktopRelaySpec,
	type DesktopStreamTurn,
	InstanceDesktop,
} from "../src/company-machine-stream-process.ts";
import { message, plan } from "./fixtures/desktop-stream-plan.ts";

// A desktop's live picture watched in a process of its own (the lead's decision after review r11 of #1746): the
// executor's side speaks frames with an instance it never trusts, and holds it back by not reading. Here each
// connection starts the instance program as a child process with the connection as its standard input, as systemd's
// `qorpera-desktop-stream.socket` (Accept=yes) starts `qorpera-desktop-stream@.service`; the cgroup limits are the
// kernel's and are proved on a real systemd (POINTER-PROGRESS.md).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixture = (name: string) => new URL(`./fixtures/desktop-stream-instance${name}.ts`, import.meta.url).pathname;
const spec = (name: string): DesktopRelaySpec => ({ project: "test", name, command: ["relay"], maxStdoutBytes: 65536 });

/** Systemd's part: a unix socket whose every connection starts the instance program with it as standard input. */
async function instances(program: string) {
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
		// The instance holds the connection now; this side lets go of its own copy.
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

/** An instance the test plays itself, on a socket of its own: what it writes, the test writes. One that does not read
 * takes nothing main writes. */
async function played(reads: boolean) {
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

/** Every turn within its budget: the units checked before each (a frame's pieces may pass it by one frame's worth), the
 * bytes (a read may pass it by one read), what is held, and the wall time of main's work for it. */
function withinBudget(turns: readonly DesktopStreamTurn[]): void {
	expect(turns.length).toBeGreaterThan(0);
	for (const turn of turns) {
		expect(turn.units).toBeLessThanOrEqual(DESKTOP_STREAM_TURN_UNITS + DESKTOP_STREAM_MESSAGE_PIECES + 1);
		expect(turn.bytes).toBeLessThanOrEqual(DESKTOP_STREAM_TURN_BYTES + DESKTOP_STREAM_BLOCK_BYTES);
		expect(turn.heldBlocks).toBeLessThanOrEqual(
			Math.ceil(DESKTOP_STREAM_MESSAGE_BYTES / DESKTOP_STREAM_BLOCK_BYTES) + 3,
		);
		expect(turn.heldBytes).toBeLessThanOrEqual(DESKTOP_STREAM_MESSAGE_BYTES + 9 + DESKTOP_STREAM_BLOCK_BYTES);
		expect(turn.ms).toBeLessThan(25);
	}
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

/** A sink that keeps what it was sent (joined from its pieces): each message's type and its areas' first colours. */
function sinkOf() {
	const messages: Buffer[] = [];
	const pieces: number[] = [];
	return {
		messages,
		pieces,
		send: vi.fn(async (message: Buffer | readonly Buffer[]) => {
			pieces.push(Buffer.isBuffer(message) ? 1 : message.length);
			messages.push(Buffer.isBuffer(message) ? Buffer.from(message) : Buffer.concat(message as Buffer[]));
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

/** A fake VNC server on the loopback that an instance's relay connects to. */
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One frame as an instance writes it: a 9-byte header (length, type, member) and the payload. */
const frameOf = (type: number, member: number, payload: Buffer = Buffer.alloc(0)) => {
	const head = Buffer.alloc(9);
	head.writeUInt32BE(payload.byteLength, 0);
	head[4] = type;
	head.writeUInt32BE(member, 5);
	return Buffer.concat([head, payload]);
};

describe("a desktop watched in a process of its own (the lead's decision after review r11 of #1746)", () => {
	it("lets go to a member only what changed before that member's cycle began, through the instance", async () => {
		const desktop = await tcpDesktop();
		const { watched, started } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const sink = sinkOf();
		const { release, asked } = gate();
		const stop = new AbortController();
		const ending = watching.watch(release, sink, stop.signal);
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		asked[0]!.resolve("ok");
		await vi.waitFor(() => expect(sink.types()).toEqual([STREAM_SIZE]));
		await desktop.send(update(rawRect(0, 0, 64, 40, [255, 0, 0])));
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		// While that cycle runs, an area turns green: it changed after the cycle began, and is not let go with it.
		await desktop.send(update(rawRect(4, 4, 8, 8, [0, 255, 0])));
		await sleep(50);
		asked[1]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"]]));
		await vi.waitFor(() => expect(asked).toHaveLength(3));
		asked[2]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"], ["4,4 8x8 #00ff00"]]));
		// The member closes it: closed at once, and the last member takes the instance with it, its process gone.
		const closedAt = performance.now();
		stop.abort();
		expect(await ending).toBe("closed");
		expect(watching.ended).toBe("idle");
		const exited = await started[0]!.exited;
		expect(exited.code).toBe(0);
		expect(exited.at - closedAt).toBeLessThan(1000);
	});

	it("ends a member on its release check's refusal, and every member with the relay's end", async () => {
		const desktop = await tcpDesktop();
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const refused = gate();
		const kept = gate();
		const one = watching.watch(refused.release, sinkOf(), new AbortController().signal);
		const two = watching.watch(kept.release, sinkOf(), new AbortController().signal);
		await vi.waitFor(() => expect(refused.asked).toHaveLength(1));
		refused.asked[0]!.resolve({ end: "DESKTOP_HELD_SINCE" });
		expect(await one).toBe("DESKTOP_HELD_SINCE");
		expect(watching.ended).toBeNull();
		await vi.waitFor(() => expect(kept.asked).toHaveLength(1));
		kept.asked[0]!.resolve("ok");
		await desktop.end();
		expect(await two).toBe("DESKTOP_ENDED");
		expect(watching.cause).toMatch(/^its relay ended DESKTOP_ENDED/);
	});

	it("is refused cleanly by an instance of another program version", async () => {
		const { watched, started } = await instances(fixture(""));
		const { desktop } = watched("tcp:1", { version: "another-version" });
		expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(desktop.cause).toBe("its relay ended STREAM_UNAVAILABLE (another program version)");
		expect((await started[0]!.exited).code).toBe(0);
	});

	it("takes at most DESKTOP_STREAM_MEMBERS members a desktop, and refuses one more STREAM_BUSY", async () => {
		const desktop = await tcpDesktop();
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const never = () => new Promise<"ok">(() => {});
		for (let n = 0; n < DESKTOP_STREAM_MEMBERS; n++)
			void watching.watch(never, sinkOf(), new AbortController().signal);
		expect(await watching.watch(never, sinkOf(), new AbortController().signal)).toBe("STREAM_BUSY");
		expect(watching.ended).toBeNull();
	});

	for (const [mode, cause] of [
		["flood", "a send without a released cycle"],
		["oversized", "a frame too large"],
		["unknown", "a frame of no known type"],
		["stranger", "a frame for no member it was given"],
		["die", "its process ended"],
	] as const)
		it(`ends an instance that does what a correct one never does (${mode}), and every member's stream with it`, async () => {
			const { watched } = await instances(fixture("-hostile"));
			const { desktop, endings } = watched(mode);
			const sink = sinkOf();
			const one = desktop.watch(async () => "ok", sink, new AbortController().signal);
			const two = desktop.watch(async () => "ok", sinkOf(), new AbortController().signal);
			expect(await Promise.all([one, two])).toEqual(["STREAM_UNAVAILABLE", "STREAM_UNAVAILABLE"]);
			expect(sink.send).not.toHaveBeenCalled();
			expect(desktop.cause).toBe(cause);
			expect(endings()).toBe(1);
		});

	it("ends an instance that stops answering while main reads", async () => {
		const { watched } = await instances(fixture("-hostile"));
		const { desktop } = watched("silent", { pingEveryMs: 50, pongWithinMs: 400 });
		const began = Date.now();
		expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(Date.now() - began).toBeLessThan(5000);
		expect(desktop.cause).toBe("no answer to its pings");
	});

	it("ends an instance that sends pongs nobody asked for: no frame is free", async () => {
		const { watched } = await instances(fixture("-hostile"));
		const { desktop } = watched("chatter", { pingEveryMs: 100, pongWithinMs: 1500 });
		const result = await mainLoopWhile(async () => {
			expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe(
				"STREAM_UNAVAILABLE",
			);
		});
		expect(desktop.cause).toBe("a pong it was not asked for");
		expect(result.longest).toBeLessThan(50);
	});

	for (const [mode, messages] of [
		["overcycle", 160],
		["overbytes", 35],
	] as const)
		it(`lets one ok through for one cycle only, by count and by bytes, and ends an instance that sends on (${mode})`, async () => {
			const { watched } = await instances(fixture("-hostile"));
			const { desktop } = watched(mode);
			const sink = sinkOf();
			const result = await mainLoopWhile(async () => {
				expect(await desktop.watch(async () => "ok", sink, new AbortController().signal)).toBe(
					"STREAM_UNAVAILABLE",
				);
			});
			// What one cycle can send at most went through (CYCLE_MESSAGES, CYCLE_BYTES); the next ended it.
			expect(sink.send).toHaveBeenCalledTimes(messages);
			expect(desktop.cause).toBe("more for one ok than one cycle can send");
			expect(result.longest).toBeLessThan(50);
		}, 30_000);

	it("lets a member go on main's side with what a correct instance can still have on its way, and nothing more", async () => {
		const desktop = await tcpDesktop();
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}`);
		const stays = sinkOf();
		const leaving = new AbortController();
		const kept = gate();
		void watching.watch(async () => "ok", stays, new AbortController().signal);
		// The leaving member's cycle is under way when it leaves: its verdict never comes, its DONE does.
		const left = watching.watch(kept.release, sinkOf(), leaving.signal);
		await vi.waitFor(() => expect(kept.asked).toHaveLength(1));
		leaving.abort();
		expect(await left).toBe("closed");
		await desktop.send(update(rawRect(0, 0, 64, 40, [1, 2, 3])));
		await vi.waitFor(() => expect(stays.areas().length).toBeGreaterThan(0));
		expect(watching.ended).toBeNull();
	});

	for (const [mode, cause] of [
		["lingerer", "more of a member than could be on its way after it left"],
		["doubledone", "a frame for a member already done"],
	] as const)
		it(`ends an instance that goes on with a member it was told to let go of (${mode})`, async () => {
			const { watched } = await instances(fixture("-hostile"));
			const { desktop } = watched(mode);
			const stays = desktop.watch(async () => "pending", sinkOf(), new AbortController().signal);
			const leaving = new AbortController();
			const asked = gate();
			const left = desktop.watch(asked.release, sinkOf(), leaving.signal);
			await vi.waitFor(() => expect(asked.asked).toHaveLength(1));
			leaving.abort();
			expect(await left).toBe("closed");
			expect(await stays).toBe("STREAM_UNAVAILABLE");
			expect(desktop.cause).toBe(cause);
		});

	it("refuses a newcomer STREAM_BUSY, and ends nothing, while as many members let go of as may wait for their DONE have not had it", async () => {
		const { watched } = await instances(fixture("-hostile"));
		const { desktop } = watched("nodone");
		void desktop.watch(async () => "pending", sinkOf(), new AbortController().signal);
		const answers: string[] = [];
		for (let n = 0; n < 16; n++) {
			const leaving = new AbortController();
			const left = desktop.watch(async () => "pending", sinkOf(), leaving.signal);
			await sleep(10);
			leaving.abort();
			answers.push(await left);
		}
		expect(answers).toEqual(Array.from({ length: 16 }, () => "closed"));
		// Sixteen let go of and no DONE yet (a correct instance whose loop is held could be there): a delay, not an end.
		expect(await desktop.watch(async () => "pending", sinkOf(), new AbortController().signal)).toBe("STREAM_BUSY");
		expect(desktop.ended).toBeNull();
	});

	it("ends an instance that does not read what it is sent, past MAX_UNREAD_BYTES waiting in main", async () => {
		// The instance played by the test, on a socket it never reads: whatever main writes waits.
		const instance = await played(false);
		const desktop = new InstanceDesktop(instance.path, spec("deaf"), () => {}, {
			version: "test-version",
			maxUnreadBytes: 1024,
			releaseGapMs: 0,
		});
		cleanups.push(() => desktop.close());
		let asked = 0;
		const ending = desktop.watch(
			async () => {
				asked++;
				return "pending";
			},
			sinkOf(),
			new AbortController().signal,
		);
		await instance.write(frameOf(16, 0));
		// It asks and asks, never reading the verdicts: each is written, and waits (in the kernel's buffer, then in main).
		for (let n = 0; n < 20_000 && desktop.ended === null; n++) {
			const before = asked;
			await instance.write(frameOf(17, 1));
			while (asked === before && desktop.ended === null) await new Promise((resolve) => setImmediate(resolve));
		}
		expect(await ending).toBe("STREAM_UNAVAILABLE");
		expect(desktop.cause).toBe("it does not read what it is sent");
	}, 60_000);

	it("never ends an instance for main's own lateness: a pong already in the socket is read first", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			let clock = 0;
			const ticks = (ms: number) => {
				clock += ms;
				vi.advanceTimersByTime(ms);
			};
			const late = await played(true);
			const desktop = new InstanceDesktop(late.path, spec("late"), () => {}, {
				version: "test-version",
				now: () => clock,
			});
			cleanups.push(() => desktop.close());
			void desktop.watch(async () => "pending", sinkOf(), new AbortController().signal);
			await late.write(frameOf(16, 0));
			await sleep(50);
			// The first ping at 5 s; then main's own loop is held 20 s, and its next tick comes 15 s late, with the pong
			// waiting in the socket.
			ticks(5000);
			clock += 15_000;
			ticks(5000);
			expect(desktop.ended).toBeNull();
			await late.write(frameOf(21, 0));
			await sleep(50);
			ticks(5000);
			expect(desktop.ended).toBeNull();
			// And one that does not answer while main reads on time is ended at 15 s.
			const silent = await played(true);
			const quiet = new InstanceDesktop(silent.path, spec("quiet"), () => {}, {
				version: "test-version",
				now: () => clock,
			});
			cleanups.push(() => quiet.close());
			void quiet.watch(async () => "pending", sinkOf(), new AbortController().signal);
			await silent.write(frameOf(16, 0));
			await sleep(50);
			for (let n = 0; n < 4; n++) ticks(5000);
			expect(quiet.ended).toBeNull();
			ticks(5000);
			expect(quiet.cause).toBe("no answer to its pings");
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes a largest message a byte a write through to a sink within every turn's budget, holding a few blocks, the loop free (the reviewer's scenario)", async () => {
		const turns: DesktopStreamTurn[] = [];
		const { watched } = await instances(fixture("-pieces"));
		const { desktop } = watched("fragment", { observe: (turn) => turns.push(turn) });
		const sink = sinkOf();
		const result = await mainLoopWhile(async () => {
			void desktop.watch(async () => "ok", sink, new AbortController().signal);
			await vi.waitFor(() => expect(sink.messages).toHaveLength(1), { timeout: 60_000, interval: 50 });
		});
		expect(sink.messages[0]!.equals(message(1, 0, DESKTOP_STREAM_MESSAGE_BYTES))).toBe(true);
		expect(Math.max(...sink.pieces)).toBeLessThanOrEqual(DESKTOP_STREAM_MESSAGE_PIECES);
		withinBudget(turns);
		expect(result.longest).toBeLessThan(50);
		expect(desktop.ended).toBeNull();
	}, 90_000);

	for (const seed of [11, 4242, 90_210])
		it(`stands guard over main's side of the connection: seeded random frames in random pieces, with long runs of 1-byte pieces (seed ${seed})`, async () => {
			const turns: DesktopStreamTurn[] = [];
			const { watched } = await instances(fixture("-pieces"));
			const { desktop } = watched(`random:${seed}`, { observe: (turn) => turns.push(turn) });
			const cycles = plan(seed, 3, 3);
			const sinks = cycles.map(() => sinkOf());
			const result = await mainLoopWhile(async () => {
				for (const sink of sinks) void desktop.watch(async () => "ok", sink, new AbortController().signal);
				await vi.waitFor(
					() =>
						expect(sinks.map((sink) => sink.messages.length)).toEqual(
							cycles.map((member) => member.flat().length),
						),
					{ timeout: 90_000, interval: 50 },
				);
			});
			// Every message arrived whole and in order, each in at most DESKTOP_STREAM_MESSAGE_PIECES pieces.
			cycles.forEach((member, n) => {
				member.flat().forEach((size, index) => {
					expect(sinks[n]!.messages[index]!.equals(message(n + 1, index, size))).toBe(true);
				});
				expect(Math.max(...sinks[n]!.pieces)).toBeLessThanOrEqual(DESKTOP_STREAM_MESSAGE_PIECES);
			});
			withinBudget(turns);
			expect(result.longest).toBeLessThan(50);
			expect(desktop.ended).toBeNull();
		}, 120_000);

	it("takes no more than its budget a second from an instance offering every small send the protocol allows, the loop free, nothing ended", async () => {
		const turns: (DesktopStreamTurn & { at: number })[] = [];
		const { watched } = await instances(fixture("-pieces"));
		const { desktop } = watched("smallflood", { observe: (turn) => turns.push({ ...turn, at: performance.now() }) });
		const sinks = Array.from({ length: 8 }, () => sinkOf());
		const began = performance.now();
		const result = await mainLoopWhile(async () => {
			for (const sink of sinks) void desktop.watch(async () => "ok", sink, new AbortController().signal);
			await sleep(3000);
		});
		const seconds = (performance.now() - began) / 1000;
		const units = turns.reduce((sum, turn) => sum + turn.units, 0);
		// At most the budget for every second begun, and the sends went on all along (each a write to a member's sink).
		expect(units).toBeLessThanOrEqual((Math.ceil(seconds) + 1) * DESKTOP_STREAM_SECOND_UNITS);
		expect(sinks.reduce((sum, sink) => sum + sink.messages.length, 0)).toBeGreaterThan(1000);
		withinBudget(turns);
		expect(result.longest).toBeLessThan(50);
		expect(desktop.ended).toBeNull();
	}, 30_000);

	it("reads a drip a few times a second at most: a byte a write costs main no more than 1000 / DESKTOP_STREAM_DRIP_MS reads a second", async () => {
		const turns: DesktopStreamTurn[] = [];
		const { watched } = await instances(fixture("-pieces"));
		const { desktop } = watched("drip", { observe: (turn) => turns.push(turn) });
		void desktop.watch(async () => "ok", sinkOf(), new AbortController().signal);
		await sleep(500);
		const from = turns.length;
		const began = performance.now();
		await sleep(2000);
		const seconds = (performance.now() - began) / 1000;
		const reads = turns.slice(from).reduce((sum, turn) => sum + turn.reads, 0);
		expect(reads).toBeGreaterThan(50);
		expect(reads / seconds).toBeLessThanOrEqual(1000 / DESKTOP_STREAM_DRIP_MS + 20);
		expect(desktop.ended).toBeNull();
	}, 30_000);

	it("smokes the units as the release does: another version refused, its own taken and ended by its relay; a unit of another file named", async () => {
		const smoke = new URL("../../../deploy/coding-worker/desktop-stream-smoke.mjs", import.meta.url).pathname;
		const { path } = await instances(fixture("-versioned"));
		// Run as a child of its own, this process's loop free to start the instances it connects to (as systemd does).
		const run = (program: string, socket = path) =>
			new Promise<{ stdout: string; status: number | null }>((resolve) => {
				const child = spawn(process.execPath, [smoke, socket, program], { stdio: ["ignore", "pipe", "inherit"] });
				let stdout = "";
				child.stdout.on("data", (piece: Buffer) => {
					stdout += piece.toString("utf8");
				});
				child.on("close", (status) => resolve({ stdout, status }));
			});
		const ok = await run(fixture("-versioned"));
		expect(ok.stdout.trim().split("\n")).toEqual([
			"step 1: another version refused: ENDED STREAM_UNAVAILABLE (another program version), closed",
			"step 2: its own version taken: READY",
			"step 2: its relay to a machine that is not there ended it: ENDED STREAM_UNAVAILABLE (Instance not found), closed",
			"STREAM UNITS SMOKE OK",
		]);
		expect(ok.status).toBe(0);
		// The units run another file than the one named: a clear line, and 1.
		const other = await run(fixture(""));
		expect(other.stdout.trim().split("\n").at(-1)).toBe(
			`STREAM UNITS SMOKE FAILED: step 2: the instance runs another program than ${fixture("")}: the stream unit's ExecStart and the executor's must name one file`,
		);
		expect(other.status).toBe(1);
		const nowhere = await run(fixture("-versioned"), `${path}.missing`);
		expect(nowhere.stdout.trim()).toBe(`STREAM UNITS SMOKE FAILED: cannot reach ${path}.missing: ENOENT`);
		expect(nowhere.status).toBe(1);
	}, 60_000);

	it("holds back, never ends, an instance whose releases come early (two clocks): each is asked no sooner than 25 ms after the last", async () => {
		const { watched } = await instances(fixture("-hostile"));
		const { desktop } = watched("eager");
		const asked: number[] = [];
		void desktop.watch(
			async () => {
				asked.push(performance.now());
				return "pending";
			},
			sinkOf(),
			new AbortController().signal,
		);
		await sleep(1000);
		expect(desktop.ended).toBeNull();
		expect(asked.length).toBeGreaterThan(15);
		expect(asked.length).toBeLessThanOrEqual(41);
		const gaps = asked.slice(1).map((at, n) => at - (asked[n] as number));
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(24);
	});

	it("keeps the executor's loop free while a desktop sends a whole 3840 x 2160 screen one byte at a time (the reviewer's scenario)", async () => {
		const { watched } = await instances(fixture(""));
		const { desktop } = watched("bytes");
		const sink = sinkOf();
		const stop = new AbortController();
		let ending: Promise<string> = Promise.resolve("");
		const result = await mainLoopWhile(async () => {
			ending = desktop.watch(async () => "ok", sink, stop.signal);
			await sleep(4000);
		});
		expect(desktop.ended).toBeNull();
		expect(sink.types()).toEqual([STREAM_SIZE]);
		expect(result.longest).toBeLessThan(50);
		expect(result.heapGrowth).toBeLessThan(16 * 1024 * 1024);
		stop.abort();
		expect(await ending).toBe("closed");
	}, 30_000);

	it("leaves nothing on a member's signal from one release cycle to the next, however many there are", async () => {
		const desktop = await tcpDesktop();
		const dir = mkdtempSync(join(tmpdir(), "desktop-stream-held-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const file = join(dir, "held");
		const { watched } = await instances(fixture(""));
		const { desktop: watching } = watched(`tcp:${desktop.port}:${file}`);
		const sink = sinkOf();
		const stop = new AbortController();
		const ending = watching.watch(async () => "ok", sink, stop.signal);
		await vi.waitFor(() => expect(sink.types()).toContain(STREAM_SIZE));
		await sleep(300);
		const before = Number(readFileSync(file, "utf8"));
		for (let n = 0; n < 120; n++) {
			await desktop.send(update(rawRect(0, 0, 8, 8, [n, 0, 0])));
			await sleep(25);
		}
		await sleep(300);
		expect(sink.types().filter((type) => type === STREAM_RECTS).length).toBeGreaterThan(40);
		expect(Number(readFileSync(file, "utf8")) - before).toBeLessThan(5);
		stop.abort();
		expect(await ending).toBe("closed");
	}, 30_000);

	it("an instance stuck in its own loop is ended by its guard once its connection is closed, whatever that loop does", async () => {
		const { watched, started } = await instances(fixture(""));
		const { desktop } = watched("spin", { pingEveryMs: 100, pongWithinMs: 1000 });
		// Its first member starts the relay, which never returns: its loop is stuck from here on.
		expect(await desktop.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe("STREAM_UNAVAILABLE");
		expect(desktop.cause).toBe("no answer to its pings");
		const closedAt = performance.now();
		const exited = await started[0]!.exited;
		expect(exited.signal).toBe("SIGKILL");
		expect(exited.at - closedAt).toBeLessThan(2 * DESKTOP_STREAM_GUARD_MS);
	}, 30_000);
});
