import { spawn, spawnSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMPANY_MACHINE_DESKTOP_VIEW,
	COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM,
	DesktopStream,
	type DesktopStreamRelease,
	encodePng,
	RFB_VERSION,
	RfbReader,
	rfbSetEncodings,
	rfbSetPixelFormat,
	rfbUpdateRequest,
	STREAM_CURSOR,
	STREAM_RECTS,
	STREAM_SIZE,
} from "../src/company-machine-stream.ts";

/** A PNG's pixels, as RGB (or RGBA) bytes, undoing the Sub filter this module uses. */
function decodePng(png: Buffer): { width: number; height: number; channels: number; data: Buffer } {
	expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
	let at = 8;
	let width = 0;
	let height = 0;
	let channels = 3;
	const idat: Buffer[] = [];
	while (at < png.byteLength) {
		const length = png.readUInt32BE(at);
		const type = png.subarray(at + 4, at + 8).toString("latin1");
		const data = png.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			channels = data[9] === 6 ? 4 : 3;
		}
		if (type === "IDAT") idat.push(data);
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		expect(raw[y * (stride + 1)]).toBe(1);
		for (let i = 0; i < stride; i++) {
			const value = raw[y * (stride + 1) + 1 + i] as number;
			out[y * stride + i] = (value + (i >= channels ? (out[y * stride + i - channels] as number) : 0)) & 0xff;
		}
	}
	return { width, height, channels, data: out };
}
/** Pixels of one colour, as the server sends them (blue, green, red, unused). */
const fill = (width: number, height: number, [r, g, b]: [number, number, number]) => {
	const pixels = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) pixels.set([b, g, r, 0], i * 4);
	return pixels;
};
/** A raw rectangle as a server writes it. */
const rawRect = (x: number, y: number, width: number, height: number, rgb: [number, number, number]) => {
	const head = Buffer.alloc(12);
	head.writeUInt16BE(x, 0);
	head.writeUInt16BE(y, 2);
	head.writeUInt16BE(width, 4);
	head.writeUInt16BE(height, 6);
	head.writeInt32BE(0, 8);
	return Buffer.concat([head, fill(width, height, rgb)]);
};
const update = (...rects: Buffer[]) => {
	const head = Buffer.alloc(4);
	head.writeUInt16BE(rects.length, 2);
	return Buffer.concat([head, ...rects]);
};
/** The server's side of the handshake, up to its init of a `width` x `height` screen. */
const serverHello = (width = 64, height = 40) => {
	const init = Buffer.alloc(24 + 6);
	init.writeUInt16BE(width, 0);
	init.writeUInt16BE(height, 2);
	init.writeUInt32BE(6, 20);
	init.write("Xvnc:1", 24, "latin1");
	return [Buffer.from(RFB_VERSION), Buffer.from([1, 1]), Buffer.alloc(4), init];
};

/** Splits what the client sent into its messages; throws on anything this module may never send. */
function clientMessages(sent: Buffer): string[] {
	const out: string[] = [];
	let at = 0;
	const expectBytes = (bytes: Buffer, name: string) => {
		expect(sent.subarray(at, at + bytes.byteLength).equals(bytes)).toBe(true);
		at += bytes.byteLength;
		out.push(name);
	};
	expectBytes(RFB_VERSION, "version");
	expectBytes(Buffer.from([1]), "security none");
	expectBytes(Buffer.from([1]), "shared");
	while (at < sent.byteLength) {
		const type = sent[at];
		if (type === 0) {
			expect(sent.subarray(at, at + 20).equals(rfbSetPixelFormat())).toBe(true);
			at += 20;
			out.push("pixel format");
		} else if (type === 2) {
			expect(sent.subarray(at, at + 16).equals(rfbSetEncodings())).toBe(true);
			at += 16;
			out.push("encodings");
		} else if (type === 3) {
			out.push(`update ${sent[at + 1] === 1 ? "incremental" : "whole"}`);
			at += 10;
		} else throw new Error(`the client sent message type ${type}`);
	}
	return out;
}

describe("a desktop's live picture (20260930745000)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("answers the handshake with the version, no security, shared, then its pixel format, its encodings and a whole screen, and reads updates in any pieces", () => {
		const events: unknown[] = [];
		const reader = new RfbReader((event) => events.push(event));
		const sent: Buffer[] = [];
		const bytes = Buffer.concat([
			...serverHello(64, 40),
			update(rawRect(0, 0, 2, 2, [255, 0, 0])),
			// A colour map, a bell and the server's cut text (the desktop's clipboard): read past, never passed on.
			Buffer.from([1, 0, 0, 0, 0, 1, 1, 2, 3, 4, 5, 6]),
			Buffer.from([2]),
			Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0, 0, 6]), Buffer.from("secret")]),
			update(
				(() => {
					const head = Buffer.alloc(12);
					head.writeUInt16BE(1, 0);
					head.writeUInt16BE(1, 2);
					head.writeUInt16BE(2, 4);
					head.writeUInt16BE(1, 6);
					head.writeInt32BE(-239, 8);
					return Buffer.concat([head, fill(2, 1, [0, 0, 0]), Buffer.from([0x80])]);
				})(),
				(() => {
					const head = Buffer.alloc(12);
					head.writeUInt16BE(80, 4);
					head.writeUInt16BE(50, 6);
					head.writeInt32BE(-223, 8);
					return head;
				})(),
			),
		]);
		// Byte by byte: nothing is taken until a whole message is there.
		for (let i = 0; i < bytes.byteLength; i++) sent.push(...reader.feed(bytes.subarray(i, i + 1)));
		expect(clientMessages(Buffer.concat(sent))).toEqual([
			"version",
			"security none",
			"shared",
			"pixel format",
			"encodings",
			"update whole",
		]);
		expect(events).toEqual([
			{ kind: "init", width: 64, height: 40 },
			{
				kind: "update",
				rects: [{ x: 0, y: 0, width: 2, height: 2, pixels: fill(2, 2, [255, 0, 0]) }],
				cursor: null,
				size: null,
			},
			{
				kind: "update",
				rects: [],
				cursor: { hotX: 1, hotY: 1, width: 2, height: 1, pixels: fill(2, 1, [0, 0, 0]), mask: Buffer.from([0x80]) },
				size: { width: 80, height: 50 },
			},
		]);
		expect(JSON.stringify(events)).not.toContain(Buffer.from("secret").toString("hex"));
		expect(reader.width).toBe(80);
		// A message it does not know (a server extension it never asked for) ends it.
		expect(() => reader.feed(Buffer.from([250]))).toThrow("RFB_UNKNOWN_MESSAGE");
		// A server that wants a password, or an older protocol: refused.
		expect(() => new RfbReader(() => {}).feed(Buffer.concat([RFB_VERSION, Buffer.from([1, 2])]))).toThrow(
			"RFB_SECURITY_REFUSED",
		);
		expect(() => new RfbReader(() => {}).feed(Buffer.from("RFB 003.003\n"))).toThrow("RFB_VERSION_REFUSED");
	});

	/** A whole 1600 x 1000 screen as Xvnc sends it: 28 bands of raw pixels, 6.4 MB. */
	const update28 = () =>
		update(
			...Array.from({ length: 28 }, (_, n) =>
				rawRect(0, n * 36, 1600, n === 27 ? 1000 - 27 * 36 : 36, [n, 2 * n, 3 * n]),
			),
		);

	it("reads a whole large screen that comes in many small pieces in time linear in its size (the real machine's first picture took 1.6 s)", () => {
		const events: {
			kind: string;
			rects?: { x: number; y: number; width: number; height: number; pixels: Buffer }[];
		}[] = [];
		const reader = new RfbReader((event) => events.push(event as never));
		reader.feed(Buffer.concat(serverHello(1600, 1000)));
		// The whole screen as Xvnc sends it: 28 bands of raw pixels, 6.4 MB, given in 4 KiB pieces.
		const bytes = update28();
		const began = performance.now();
		for (let at = 0; at < bytes.byteLength; at += 4096) reader.feed(bytes.subarray(at, at + 4096));
		const took = performance.now() - began;
		const last = events.at(-1);
		expect(last?.kind).toBe("update");
		expect(last?.rects?.map((rect) => [rect.y, rect.height])).toEqual(
			Array.from({ length: 28 }, (_, n) => [n * 36, n === 27 ? 1000 - 27 * 36 : 36]),
		);
		expect(last?.rects?.[13]?.pixels.equals(fill(1600, 36, [13, 26, 39]))).toBe(true);
		// Before: every piece walked the headers again, copying all that came before each (minutes for this).
		expect(took).toBeLessThan(1500);
	});

	it("ends the relay on an update larger than this screen can need, before its payload is buffered (review r1 F1 of #1746)", () => {
		// The desktop's own account, and any page it runs, can drive that VNC server: every byte from it is hostile.
		const reader = new RfbReader(() => {});
		reader.feed(Buffer.concat(serverHello(64, 40)));
		// 65,535 areas of 4096 x 4096 each: refused at the count, before a byte of payload is held.
		const many = Buffer.alloc(4);
		many.writeUInt16BE(0xffff, 2);
		expect(() => reader.feed(many)).toThrow("RFB_UPDATE_TOO_LARGE");
		// One area far larger than the screen, declared in a header and never sent: refused at the header.
		const big = new RfbReader(() => {});
		big.feed(Buffer.concat(serverHello(64, 40)));
		const head = Buffer.alloc(4 + 12);
		head.writeUInt16BE(1, 2);
		head.writeUInt16BE(4096, 8);
		head.writeUInt16BE(4096, 10);
		head.writeInt32BE(0, 12);
		expect(() => big.feed(head)).toThrow("RFB_UPDATE_TOO_LARGE");
		// Many areas that are each small but together far past the screen, given in small transport pieces: refused
		// while the headers are walked, so the pieces that follow are never buffered.
		const sum = new RfbReader(() => {});
		sum.feed(Buffer.concat(serverHello(64, 40)));
		const rects = 600;
		const update = Buffer.concat([
			(() => {
				const count = Buffer.alloc(4);
				count.writeUInt16BE(rects, 2);
				return count;
			})(),
			...Array.from({ length: rects }, () => rawRect(0, 0, 64, 40, [1, 2, 3])),
		]);
		expect(() => {
			for (let at = 0; at < update.byteLength; at += 4096) sum.feed(update.subarray(at, at + 4096));
		}).toThrow("RFB_UPDATE_TOO_LARGE");
		// A whole screen of a large desktop still passes: 28 bands of 1600 x 1000, in small pieces.
		const fine = new RfbReader(() => {});
		fine.feed(Buffer.concat(serverHello(1600, 1000)));
		const whole = update28();
		for (let at = 0; at < whole.byteLength; at += 4096) fine.feed(whole.subarray(at, at + 4096));
		expect(fine.width).toBe(1600);
	});

	it("encodes an area as a PNG of its own pixels, and the pointer as RGBA with its mask", async () => {
		const pixels = Buffer.alloc(5 * 3 * 4);
		for (let i = 0; i < 15; i++) pixels.set([i * 3, i * 5, i * 7, 0], i * 4);
		const png = decodePng(await encodePng(5, 3, pixels));
		expect(png).toMatchObject({ width: 5, height: 3, channels: 3 });
		for (let i = 0; i < 15; i++) expect([...png.data.subarray(i * 3, i * 3 + 3)]).toEqual([i * 7, i * 5, i * 3]);
		const cursor = decodePng(await encodePng(2, 1, fill(2, 1, [9, 8, 7]), (index) => (index === 0 ? 255 : 0)));
		expect([...cursor.data]).toEqual([9, 8, 7, 255, 9, 8, 7, 0]);
	});

	/** A desktop whose VNC server the test drives: what the client sent, and `send` for what the server says. */
	function fakeDesktop() {
		const sent: Buffer[] = [];
		let stdout: (chunk: Buffer) => void = () => {};
		let finish: (exitCode: number) => void = () => {};
		const state = { runs: 0, aborted: false };
		const run = vi.fn(async (out: (chunk: Buffer) => void, stdin: AsyncIterable<Uint8Array>, signal: AbortSignal) => {
			state.runs++;
			stdout = out;
			const ended = new Promise<number>((resolve) => {
				finish = resolve;
			});
			signal.addEventListener(
				"abort",
				() => {
					state.aborted = true;
					finish(137);
				},
				{ once: true },
			);
			void (async () => {
				for await (const chunk of stdin) sent.push(Buffer.from(chunk));
			})();
			for (const part of serverHello()) out(part);
			return ended;
		});
		return {
			run,
			sent,
			state,
			send: (bytes: Buffer) => stdout(bytes),
			end: (exitCode: number) => finish(exitCode),
			/** The update requests the client made. */
			requests: () => clientMessages(Buffer.concat(sent)).filter((message) => message.startsWith("update")),
		};
	}
	/** A sink that keeps what it was sent, decoded. */
	function sinkOf() {
		const messages: { type: number; body: Buffer }[] = [];
		return {
			messages,
			send: vi.fn(async (message: Buffer) => {
				messages.push({ type: message[0] as number, body: message.subarray(1) });
			}),
			/** Each RECTS message's areas, as `x,y wxh #rrggbb`. */
			areas: () =>
				messages
					.filter((message) => message.type === STREAM_RECTS)
					.map((message) => {
						const out: string[] = [];
						let at = 2;
						for (let n = 0; n < message.body.readUInt16BE(0); n++) {
							const [x, y, w, h] = [0, 2, 4, 6].map((o) => message.body.readUInt16BE(at + o)) as number[];
							const length = message.body.readUInt32BE(at + 8);
							const png = decodePng(message.body.subarray(at + 12, at + 12 + length));
							out.push(`${x},${y} ${w}x${h} #${png.data.subarray(0, 3).toString("hex")}`);
							at += 12 + length;
						}
						return out;
					}),
		};
	}
	const settle = async () => {
		for (let n = 0; n < 20; n++) await new Promise((resolve) => setImmediate(resolve));
	};
	/** A release the test answers, cycle by cycle. */
	function gate() {
		const asked: {
			resolve: (verdict: Awaited<ReturnType<DesktopStreamRelease>>) => void;
			reject: (error: Error) => void;
		}[] = [];
		const release: DesktopStreamRelease = (signal) =>
			new Promise((resolve, reject) => {
				asked.push({ resolve, reject });
				// A cycle on its way ends with the stream, as SQL's call does.
				signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
			});
		return { release, asked };
	}

	it("lets go to a member only what changed before that member's cycle began, and nothing after it, until the next cycle", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0 });
		const sink = sinkOf();
		const { release, asked } = gate();
		const stop = new AbortController();
		const watching = stream.watch(release, sink, stop.signal);
		await settle();
		// The server said what it is: its size, let go by the first cycle.
		expect(asked).toHaveLength(1);
		asked[0]!.resolve("ok");
		await settle();
		expect(sink.messages.map((message) => message.type)).toEqual([STREAM_SIZE]);
		// The whole screen, red: it waits for a cycle.
		desktop.send(update(rawRect(0, 0, 64, 40, [255, 0, 0])));
		await settle();
		expect(asked).toHaveLength(2);
		expect(sink.messages).toHaveLength(1);
		// While that cycle runs, an area turns green: it changed after the cycle began.
		desktop.send(update(rawRect(4, 4, 8, 8, [0, 255, 0])));
		await settle();
		asked[1]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"]]));
		// The next cycle lets the green one go.
		await vi.waitFor(() => expect(asked).toHaveLength(3));
		asked[2]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"], ["4,4 8x8 #00ff00"]]));
		// Nothing changed: no cycle at all.
		await settle();
		expect(asked).toHaveLength(3);
		stop.abort();
		expect(await watching).toBe("closed");
		// The last member left: the relay is ended.
		await settle();
		expect(desktop.state.aborted).toBe(true);
	});

	it("ends a member's stream on a cycle's refusal and sends nothing after it, leaving no timer and no relay behind", async () => {
		vi.useFakeTimers();
		for (const [verdict, expected] of [
			[{ end: "DESKTOP_HELD_SINCE" }, "DESKTOP_HELD_SINCE"],
			[{ end: "MEMBER_CANNOT_READ" }, "MEMBER_CANNOT_READ"],
		] as const) {
			const desktop = fakeDesktop();
			const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0 });
			const sink = sinkOf();
			const { release, asked } = gate();
			const watching = stream.watch(release, sink, new AbortController().signal);
			await vi.advanceTimersByTimeAsync(0);
			desktop.send(update(rawRect(0, 0, 64, 40, [255, 0, 0])));
			await vi.advanceTimersByTimeAsync(0);
			asked[0]!.resolve(verdict);
			expect(await watching).toBe(expected);
			expect(sink.messages).toEqual([]);
			await vi.advanceTimersByTimeAsync(0);
			expect(desktop.state.aborted).toBe(true);
			// Nothing of it is left running: no timer.
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it("holds on `pending` and asks again, and ends after failed cycles in a row", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, retryMs: 40 });
		const sink = sinkOf();
		const { release, asked } = gate();
		const stop = new AbortController();
		const watching = stream.watch(release, sink, stop.signal);
		await settle();
		desktop.send(update(rawRect(0, 0, 64, 40, [255, 0, 0])));
		await settle();
		asked[0]!.resolve("pending");
		await settle();
		expect(asked).toHaveLength(1);
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		asked[1]!.resolve("ok");
		await vi.waitFor(() => expect(sink.areas()).toEqual([["0,0 64x40 #ff0000"]]));
		// Three failed cycles in a row end it.
		desktop.send(update(rawRect(0, 0, 4, 4, [0, 0, 255])));
		for (let n = 2; n < 5; n++) {
			await vi.waitFor(() => expect(asked).toHaveLength(n + 1));
			asked[n]!.reject(new Error("SQL is away"));
		}
		expect(await watching).toBe("STREAM_UNAVAILABLE");
		expect(sink.areas()).toHaveLength(1);
	});

	it("gives each member its own cycles: a member who joins gets the size and the whole screen anew, a slow one holds nobody else", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0 });
		const first = sinkOf();
		const a = gate();
		const stopA = new AbortController();
		const watchingA = stream.watch(a.release, first, stopA.signal);
		await settle();
		a.asked[0]!.resolve("ok");
		desktop.send(update(rawRect(0, 0, 64, 40, [255, 0, 0])));
		await vi.waitFor(() => expect(a.asked).toHaveLength(2));
		a.asked[1]!.resolve("ok");
		await vi.waitFor(() => expect(first.areas()).toEqual([["0,0 64x40 #ff0000"]]));
		// The second member: one relay for both, and the whole screen asked of the server anew for it.
		const second = sinkOf();
		const b = gate();
		const stopB = new AbortController();
		const wholes = desktop.requests().filter((request) => request === "update whole").length;
		const watchingB = stream.watch(b.release, second, stopB.signal);
		await settle();
		expect(desktop.run).toHaveBeenCalledTimes(1);
		expect(desktop.requests().filter((request) => request === "update whole")).toHaveLength(wholes + 1);
		desktop.send(update(rawRect(0, 0, 64, 40, [0, 0, 255])));
		await vi.waitFor(() => expect(a.asked).toHaveLength(3));
		await vi.waitFor(() => expect(b.asked).toHaveLength(1));
		// B's cycle does not answer yet (a slow member): A's go on.
		a.asked[2]!.resolve("ok");
		await vi.waitFor(() => expect(first.areas()).toEqual([["0,0 64x40 #ff0000"], ["0,0 64x40 #0000ff"]]));
		expect(second.messages).toEqual([]);
		b.asked[0]!.resolve("ok");
		await vi.waitFor(() => expect(second.areas()).toEqual([["0,0 64x40 #0000ff"]]));
		expect(second.messages.map((message) => message.type)).toEqual([STREAM_SIZE, STREAM_RECTS]);
		stopA.abort();
		await watchingA;
		await settle();
		// One member still watches: the relay goes on.
		expect(desktop.state.aborted).toBe(false);
		stopB.abort();
		await watchingB;
		await settle();
		expect(desktop.state.aborted).toBe(true);
	});

	it("drops what a lagging member was not sent past the ring's bound, and gives that member the whole screen anew", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ringBytes: 64 * 40 * 4 * 2 });
		const sink = sinkOf();
		const { release, asked } = gate();
		const stop = new AbortController();
		const watching = stream.watch(release, sink, stop.signal);
		await settle();
		for (const rgb of [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[9, 9, 9],
		] as [number, number, number][]) {
			desktop.send(update(rawRect(0, 0, 64, 40, rgb)));
			await settle();
		}
		const wholes = desktop.requests().filter((request) => request === "update whole").length;
		expect(wholes).toBeGreaterThan(1);
		asked[0]!.resolve("ok");
		await settle();
		// What it was sent covers only what stayed in the ring and changed before its cycle.
		expect(
			sink
				.areas()
				.flat()
				.every((area) => area.endsWith("#0000ff") || area.endsWith("#090909")),
		).toBe(true);
		stop.abort();
		await watching;
	});

	it("only ever sends the VNC server the handshake's answers, its pixel format, its encodings and update requests, however the screen changes, and drops the server's clipboard", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0 });
		const sink = sinkOf();
		const stop = new AbortController();
		const watching = stream.watch(async () => "ok", sink, stop.signal);
		await settle();
		desktop.send(update(rawRect(0, 0, 64, 40, [1, 2, 3])));
		desktop.send(Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0, 0, 8]), Buffer.from("password")]));
		const size = Buffer.alloc(12);
		size.writeUInt16BE(32, 4);
		size.writeUInt16BE(20, 6);
		size.writeInt32BE(-223, 8);
		desktop.send(update(size, rawRect(0, 0, 32, 20, [4, 5, 6])));
		await settle();
		stop.abort();
		await watching;
		const kinds = new Set(clientMessages(Buffer.concat(desktop.sent)));
		expect([...kinds].sort()).toEqual(
			[
				"encodings",
				"pixel format",
				"security none",
				"shared",
				"update incremental",
				"update whole",
				"version",
			].sort(),
		);
		expect(Buffer.concat(sink.messages.map((message) => message.body)).includes(Buffer.from("password"))).toBe(false);
		// The size went with the new screen.
		expect(
			sink.messages
				.filter((message) => message.type === STREAM_SIZE)
				.map((message) => `${message.body.readUInt16BE(0)}x${message.body.readUInt16BE(2)}`),
		).toEqual(["64x40", "32x20"]);
		expect(sink.messages.some((message) => message.type === STREAM_CURSOR)).toBe(false);
	});

	it("bounds what the queues hold in ENTRIES, not only in bytes: empty updates and piled-up requests (review r2 F1 of #1746)", async () => {
		const desktop = fakeDesktop();
		// A member whose cycles never answer: everything the guest sends stays in the ring for it.
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ringEntries: 8 });
		const watching = stream.watch(async () => "pending", sinkOf(), new AbortController().signal);
		await settle();
		// 200 updates of no areas at all: each weighs nothing and still costs an entry.
		const empty = Buffer.alloc(4);
		for (let n = 0; n < 200; n++) desktop.send(empty);
		await settle();
		expect(stream.held).toEqual({ ring: 8, outbox: expect.any(Number) });
		// The guest stops reading its socket: the requests the reader answers with pile up, bounded too, and a
		// whole-screen request is never the one dropped.
		expect(stream.held.outbox).toBeLessThanOrEqual(64);
		for (let n = 0; n < 500; n++) desktop.send(empty);
		await settle();
		expect(stream.held.ring).toBe(8);
		expect(stream.held.outbox).toBeLessThanOrEqual(64);
		// A guest that changes the screen's size again and again makes whole-screen requests, which are never dropped for
		// being worthless: they are bounded all the same (twice the bound, then the oldest goes).
		const resize = (width: number, height: number) => {
			const head = Buffer.alloc(12);
			head.writeUInt16BE(width, 4);
			head.writeUInt16BE(height, 6);
			head.writeInt32BE(-223, 8);
			desktop.send(update(head));
		};
		for (let n = 0; n < 500; n++) resize(64 + (n % 8), 40 + (n % 8));
		await settle();
		expect(stream.held.outbox).toBeLessThanOrEqual(128);
		expect(stream.held.ring).toBe(8);
		// The relay's end lets that member go.
		desktop.end(95);
		expect(await watching).toBe("DESKTOP_NOT_RUNNING");
	});

	it("lets cancelling interrupt a send the member's browser is not reading, and sends nothing after it (review r1 F3 of #1746)", async () => {
		const desktop = fakeDesktop();
		const ended = vi.fn();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ended });
		// A browser that answers pings but never reads what it is sent: its sink's send never resolves.
		let blocked = 0;
		const sink = {
			send: vi.fn(async () => {
				blocked++;
				await new Promise<void>(() => {});
			}),
		};
		const stop = new AbortController();
		const watching = stream.watch(async () => "ok", sink, stop.signal);
		desktop.send(update(rawRect(0, 0, 8, 8, [1, 2, 3])));
		await vi.waitFor(() => expect(blocked).toBe(1));
		// The member closes the window (or the pass ended and the executor cancels): the watcher does not wait for that
		// socket, and nothing more is sent.
		stop.abort();
		expect(await watching).toBe("closed");
		desktop.send(update(rawRect(8, 8, 8, 8, [4, 5, 6])));
		await settle();
		expect(sink.send).toHaveBeenCalledTimes(1);
		// The last watcher is gone, so the relay was let go with it.
		await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
		expect(stream.ended).toBe("idle");
		expect(desktop.state.aborted).toBe(true);
	});

	it("tells a member the screen's size again when an eviction threw away the resize that changed it (review r3 F2 of #1746)", async () => {
		const desktop = fakeDesktop();
		// A ring that keeps almost nothing, and a member whose cycles lag behind the guest.
		let letGo = () => {};
		const held = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		// This member's cycles are let through until the test holds them.
		let gate: Promise<void> | null = null;
		const sink = sinkOf();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ringBytes: 64 * 40 * 4 });
		const watching = stream.watch(
			async () => {
				if (gate) await gate;
				return "ok";
			},
			sink,
			new AbortController().signal,
		);
		await settle();
		// The first picture of the 64 x 40 screen reaches the member.
		desktop.send(update(rawRect(0, 0, 64, 40, [1, 2, 3])));
		await vi.waitFor(() => expect(sink.messages.some((message) => message.type === STREAM_RECTS)).toBe(true));
		// Now the screen grows and the pixels of that size come while this member's cycle is held: the ring drops the
		// update that carried the new size.
		gate = held;
		const resize = Buffer.alloc(12);
		resize.writeUInt16BE(96, 4);
		resize.writeUInt16BE(60, 6);
		resize.writeInt32BE(-223, 8);
		desktop.send(update(resize));
		await settle();
		for (let n = 0; n < 6; n++) desktop.send(update(rawRect(0, 0, 96, 60, [4, 5, 6])));
		await settle();
		sink.messages.length = 0;
		letGo();
		// What this member is sent next begins with the size it must have, before any pixels of it.
		await vi.waitFor(() => expect(sink.messages.some((message) => message.type === STREAM_RECTS)).toBe(true));
		const first = sink.messages[0];
		expect(first?.type).toBe(STREAM_SIZE);
		expect(`${first?.body.readUInt16BE(0)}x${first?.body.readUInt16BE(2)}`).toBe("96x60");
		desktop.end(95);
		await watching;
	});

	it("ends every member's stream when the relay ends (the X server or the boot) with why", async () => {
		const desktop = fakeDesktop();
		const ended = vi.fn();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ended });
		const watching = stream.watch(async () => "ok", sinkOf(), new AbortController().signal);
		await settle();
		desktop.end(95);
		expect(await watching).toBe("DESKTOP_NOT_RUNNING");
		await settle();
		expect(ended).toHaveBeenCalledTimes(1);
		expect(stream.ended).toBe("DESKTOP_NOT_RUNNING");
		expect(await stream.watch(async () => "ok", sinkOf(), new AbortController().signal)).toBe("DESKTOP_NOT_RUNNING");
		// The desktop's server went away under a watched stream (96): the desktop ended.
		const again = fakeDesktop();
		const restarted = new DesktopStream({ run: again.run, cycleEveryMs: 0 });
		const watched = restarted.watch(async () => "ok", sinkOf(), new AbortController().signal);
		await settle();
		again.end(96);
		expect(await watched).toBe("DESKTOP_ENDED");
	});

	it.skipIf(process.platform !== "linux" || spawnSync("python3", ["-c", "0"]).status !== 0)(
		"has its relay in the machine pass on the handshake and the three messages only, and end on a key, a pointer or the clipboard before any of it reaches the server",
		async () => {
			for (const forbidden of [
				Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]),
				Buffer.from([5, 1, 0, 10, 0, 10]),
				Buffer.from([6, 0, 0, 0, 0, 0, 0, 3, 0x61, 0x62, 0x63]),
			]) {
				const received: Buffer[] = [];
				const server = createServer((socket: Socket) => {
					socket.on("data", (chunk: Buffer) => received.push(chunk));
					socket.write(Buffer.concat(serverHello()));
				});
				await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
				const port = (server.address() as { port: number }).port;
				const program = COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM.replace(
					"('127.0.0.1', 5901)",
					`('127.0.0.1', ${port})`,
				).replace("/run/qorpera-desktop/last-use", "/nonexistent/last-use");
				const relay = spawn("python3", ["-c", program], { stdio: ["pipe", "pipe", "ignore"] });
				const down: Buffer[] = [];
				relay.stdout.on("data", (chunk: Buffer) => down.push(chunk));
				const allowed = Buffer.concat([
					RFB_VERSION,
					Buffer.from([1]),
					Buffer.from([1]),
					rfbSetPixelFormat(),
					rfbSetEncodings(),
					rfbUpdateRequest(false, 64, 40),
				]);
				relay.stdin.write(allowed);
				await vi.waitFor(() => expect(Buffer.concat(received).byteLength).toBe(allowed.byteLength));
				relay.stdin.write(forbidden);
				const exitCode = await new Promise<number | null>((resolve) => relay.on("exit", resolve));
				expect(exitCode).toBe(93);
				// Byte for byte what was allowed, and nothing of the forbidden message.
				expect(Buffer.concat(received).equals(allowed)).toBe(true);
				// The server's own bytes came down.
				expect(Buffer.concat(down).subarray(0, 12).equals(RFB_VERSION)).toBe(true);
				server.close();
			}
			// The server goes away while the host still watches (its input open): 96, the desktop ended.
			const server = createServer((socket: Socket) => {
				socket.write(Buffer.concat(serverHello()));
				setTimeout(() => socket.destroy(), 100);
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			const relay = spawn(
				"python3",
				[
					"-c",
					COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM.replace("('127.0.0.1', 5901)", `('127.0.0.1', ${port})`).replace(
						"/run/qorpera-desktop/last-use",
						"/nonexistent/last-use",
					),
				],
				{ stdio: ["pipe", "ignore", "ignore"] },
			);
			expect(await new Promise<number | null>((resolve) => relay.on("exit", resolve))).toBe(96);
			relay.stdin.destroy();
			server.close();
		},
		20_000,
	);

	it("runs its relay as root on SQL's boot only, with the desktop running, and nothing else", () => {
		for (const part of [
			'[ "$boot" = "$0" ]; } || exit 97',
			"command -v python3 >/dev/null 2>&1 || exit 98",
			"systemctl is-active --quiet qorpera-machine-desktop.service || exit 95",
			'exec python3 -c "$1"',
		])
			expect(COMPANY_MACHINE_DESKTOP_VIEW).toContain(part);
		expect(COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM).toContain("socket.create_connection(('127.0.0.1', 5901)");
		expect(COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM).not.toMatch(/subprocess|os\.system|exec\(|eval\(|open\(/);
	});
});
