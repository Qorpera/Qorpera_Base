import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { crc32, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMPANY_MACHINE_DESKTOP_VIEW,
	COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM,
	DesktopStream,
	type DesktopStreamRelease,
	encodePng,
	PNG_PIXELS_PER_TURN,
	RFB_TAKE_PER_TURN,
	RFB_UNIT_COST,
	RFB_VERSION,
	RfbReader,
	rfbSetEncodings,
	rfbSetPixelFormat,
	rfbUpdateRequest,
	STREAM_CURSOR,
	STREAM_RECTS,
	STREAM_SIZE,
	visibleRects,
} from "../src/company-machine-stream.ts";

/** The clock's part of these guards. The rules are the budgets these tests check exactly (charges, events, what is
 * held); the wall clock only tells a blown budget (seconds of work in one turn) from a kept one. It is NOT a measure of
 * this machine: the test VM runs several suites side by side on two cores, and a turn or a timer the kernel sets aside
 * reads as tens of milliseconds there (129 ms seen on 14 Nov 2026 where a bound was 100), so the bounds are wide. */
const TURN_CLOCK_MS = 500;
const LOOP_CLOCK_MS = 1000;

/** A PNG's pixels, as RGB (or RGBA) bytes, undoing the Sub filter this module uses. */
function decodePng(png: Buffer): { width: number; height: number; channels: number; data: Buffer } {
	expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
	let at = 8;
	let width = 0;
	let height = 0;
	let channels = 3;
	let sawIend = false;
	const idat: Buffer[] = [];
	while (at < png.byteLength) {
		expect(sawIend).toBe(false);
		expect(at + 12).toBeLessThanOrEqual(png.byteLength);
		const length = png.readUInt32BE(at);
		expect(at + 12 + length).toBeLessThanOrEqual(png.byteLength);
		const type = png.subarray(at + 4, at + 8).toString("latin1");
		const data = png.subarray(at + 8, at + 8 + length);
		const expectedCrc = crc32(png.subarray(at + 4, at + 8 + length));
		expect(png.readUInt32BE(at + 8 + length)).toBe(expectedCrc);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			channels = data[9] === 6 ? 4 : 3;
		}
		if (type === "IDAT") idat.push(data);
		if (type === "IEND") {
			expect(length).toBe(0);
			sawIend = true;
		}
		at += 12 + length;
	}
	expect(sawIend).toBe(true);
	expect(at).toBe(png.byteLength);
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
		// One area larger than any screen a machine has (3840 x 2160), declared in a header: refused at the header.
		const huge = new RfbReader(() => {});
		huge.feed(Buffer.concat(serverHello(64, 40)));
		const hugeHead = Buffer.alloc(4 + 12);
		hugeHead.writeUInt16BE(1, 2);
		hugeHead.writeUInt16BE(4096, 8);
		hugeHead.writeUInt16BE(4096, 10);
		hugeHead.writeInt32BE(0, 12);
		expect(() => huge.feed(hugeHead)).toThrow("RFB_INVALID");
		// One area far larger than this screen, declared in a header and never sent: refused at the header.
		const big = new RfbReader(() => {});
		big.feed(Buffer.concat(serverHello(64, 40)));
		const head = Buffer.alloc(4 + 12);
		head.writeUInt16BE(1, 2);
		head.writeUInt16BE(3840, 8);
		head.writeUInt16BE(2160, 10);
		head.writeInt32BE(0, 12);
		expect(() => big.feed(head)).toThrow("RFB_UPDATE_TOO_LARGE");
		// A server that says its screen is larger than any machine's: refused at its hello.
		expect(() => new RfbReader(() => {}).feed(Buffer.concat(serverHello(3841, 2160)))).toThrow("RFB_INVALID");
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
		for (let i = 0; i < 15; i++)
			pixels.set([(255 - i * 17) & 0xff, (i * 53) & 0xff, (200 - i * 31) & 0xff, 0], i * 4);
		const png = decodePng(await encodePng(5, 3, pixels));
		expect(png).toMatchObject({ width: 5, height: 3, channels: 3 });
		for (let i = 0; i < 15; i++) {
			expect([...png.data.subarray(i * 3, i * 3 + 3)]).toEqual([
				(200 - i * 31) & 0xff,
				(i * 53) & 0xff,
				(255 - i * 17) & 0xff,
			]);
		}
		const singleRgb = decodePng(await encodePng(1, 1, Buffer.from([10, 20, 250, 0])));
		expect(singleRgb).toMatchObject({ width: 1, height: 1, channels: 3 });
		expect([...singleRgb.data]).toEqual([250, 20, 10]);

		const cursor = decodePng(await encodePng(2, 1, fill(2, 1, [9, 8, 7]), (index) => (index === 0 ? 255 : 0)));
		expect([...cursor.data]).toEqual([9, 8, 7, 255, 9, 8, 7, 0]);
		const singleRgba = decodePng(await encodePng(1, 1, Buffer.from([1, 2, 3, 0]), () => 128));
		expect(singleRgba).toMatchObject({ width: 1, height: 1, channels: 4 });
		expect([...singleRgba.data]).toEqual([3, 2, 1, 128]);
		const multiRgba = decodePng(await encodePng(5, 3, pixels, (index) => (255 - index * 19) & 0xff));
		expect(multiRgba).toMatchObject({ width: 5, height: 3, channels: 4 });
		for (let i = 0; i < 15; i++) {
			expect([...multiRgba.data.subarray(i * 4, i * 4 + 4)]).toEqual([
				(200 - i * 31) & 0xff,
				(i * 53) & 0xff,
				(255 - i * 17) & 0xff,
				(255 - i * 19) & 0xff,
			]);
		}
		const tallAlphaPixels = Buffer.alloc(1024 * 130 * 4);
		for (let i = 0; i < 1024 * 130; i++) tallAlphaPixels.set([i & 0xff, (i * 3) & 0xff, (255 - i) & 0xff, 0], i * 4);
		const turns = vi.spyOn(globalThis, "setImmediate");
		const before = turns.mock.calls.length;
		const tallAlpha = decodePng(await encodePng(1024, 130, tallAlphaPixels, (index) => (255 - index) & 0xff));
		const yielded = turns.mock.calls.length - before;
		turns.mockRestore();
		expect(yielded).toBeGreaterThanOrEqual(2);
		expect(tallAlpha).toMatchObject({ width: 1024, height: 130, channels: 4 });
		expect([...tallAlpha.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
		const last = 1024 * 130 - 1;
		expect([...tallAlpha.data.subarray(last * 4, last * 4 + 4)]).toEqual([
			(255 - last) & 0xff,
			(last * 3) & 0xff,
			last & 0xff,
			(255 - last) & 0xff,
		]);
	});

	/** A desktop whose VNC server the test drives: what the client sent, and `send` for what the server says. */
	function fakeDesktop(width = 64, height = 40) {
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
			for (const part of serverHello(width, height)) out(part);
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

	it("bounds what the queues hold in ENTRIES, not only in bytes: empty updates and piled-up requests (review r2 F1 and r10 of #1746)", async () => {
		const desktop = fakeDesktop();
		// A member whose cycles never answer: everything the guest sends that a member could see stays in the ring for it.
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ringEntries: 8 });
		const watching = stream.watch(async () => "pending", sinkOf(), new AbortController().signal);
		await settle();
		const first = stream.held.ring;
		// 700 updates of no areas at all: they change nothing a member sees, so none is kept (r10), and the requests they
		// answer with replace one another: the outbox holds at most the handshake's answers and two requests.
		const empty = Buffer.alloc(4);
		for (let n = 0; n < 700; n++) desktop.send(empty);
		await settle();
		expect(stream.held).toEqual({ ring: first, rects: 0, outbox: expect.any(Number) });
		expect(stream.held.outbox).toBeLessThanOrEqual(3);
		// A guest that changes the screen's size again and again: each change is kept (a member must be told it), the
		// ring bounded in entries; its whole-screen requests replace one another too, the newest standing.
		const resize = (width: number, height: number) => {
			const head = Buffer.alloc(12);
			head.writeUInt16BE(width, 4);
			head.writeUInt16BE(height, 6);
			head.writeInt32BE(-223, 8);
			desktop.send(update(head));
		};
		for (let n = 0; n < 500; n++) resize(64 + (n % 8), 40 + (n % 8));
		await settle();
		expect(stream.held.outbox).toBeLessThanOrEqual(3);
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

	it("keeps old-size pixels with their own size across an eviction, and never sends them under a newer one (review r4 F2 of #1746)", async () => {
		const desktop = fakeDesktop();
		let letGo = () => {};
		const held = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		let gate: Promise<void> | null = null;
		const sink = sinkOf();
		// A ring so small that a few updates evict the earlier ones.
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
		desktop.send(update(rawRect(0, 0, 64, 40, [1, 2, 3])));
		await vi.waitFor(() => expect(sink.messages.some((message) => message.type === STREAM_RECTS)).toBe(true));
		// This member's cycles stop. The screen SHRINKS, and pixels of both sizes pile up behind the shrink.
		gate = held;
		desktop.send(update(rawRect(8, 8, 32, 16, [9, 9, 9])));
		const shrink = Buffer.alloc(12);
		shrink.writeUInt16BE(32, 4);
		shrink.writeUInt16BE(20, 6);
		shrink.writeInt32BE(-223, 8);
		desktop.send(update(shrink));
		for (let n = 0; n < 4; n++) desktop.send(update(rawRect(0, 0, 32, 20, [4, 5, 6])));
		await settle();
		sink.messages.length = 0;
		letGo();
		await vi.waitFor(() => expect(sink.messages.some((message) => message.type === STREAM_RECTS)).toBe(true));
		// Whatever the eviction kept, the size comes first and every area that follows fits inside it.
		const sizes = sink.messages.filter((message) => message.type === STREAM_SIZE);
		expect(sink.messages[0]?.type).toBe(STREAM_SIZE);
		const last = sizes.at(-1);
		const width = last?.body.readUInt16BE(0) as number;
		const height = last?.body.readUInt16BE(2) as number;
		for (const area of sink.areas().flat()) {
			const [x, y, w, h] = area
				.match(/^(\d+),(\d+) (\d+)x(\d+)/)
				?.slice(1)
				.map(Number) as number[];
			expect(x + w, area).toBeLessThanOrEqual(width);
			expect(y + h, area).toBeLessThanOrEqual(height);
		}
		desktop.end(95);
		await watching;
	});

	it("keeps what one member is sent at once bounded in AREAS, and walks them in one pass, however many tiny ones a guest piles up behind a held cycle (v245 release review F1)", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0 });
		const sink = sinkOf();
		const { release, asked } = gate();
		const stop = new AbortController();
		const watching = stream.watch(release, sink, stop.signal);
		await settle();
		// The member's first cycle is asked and held: everything the guest sends now waits in the ring for it.
		desktop.send(update(rawRect(0, 0, 64, 40, [1, 1, 1])));
		await settle();
		expect(asked).toHaveLength(1);
		// 100 updates of 1,024 one-pixel areas each: 400 KiB of pixels, 102,400 areas.
		const tiny = (n: number) => rawRect(n % 64, Math.floor(n / 64) % 40, 1, 1, [n & 0xff, 2, 3]);
		const wholesBefore = desktop.requests().filter((request) => request === "update whole").length;
		for (let u = 0; u < 100; u++) {
			desktop.send(update(...Array.from({ length: 1024 }, (_, n) => tiny(u * 1024 + n))));
			await settle();
			// Never more than 2,048 areas held, whatever came.
			expect(stream.held.rects).toBeLessThanOrEqual(2048);
		}
		// Past the bound the oldest went, and the member gets the whole screen anew, as for the other bounds.
		expect(desktop.requests().filter((request) => request === "update whole").length).toBeGreaterThan(wholesBefore);
		// The held cycle lets go: it releases nothing the eviction left (the member was moved on past it), and the next
		// cycle releases what the ring holds — at most the bound's areas, walked in one pass, never each against every
		// later one. (Each tiny area is then encoded and sent in turn, which takes a while for 2,048 of them.)
		asked[0]!.resolve("ok");
		await vi.waitFor(() => expect(asked.length).toBe(2));
		asked[1]!.resolve("ok");
		await vi.waitFor(() => expect(sink.messages.some((message) => message.type === STREAM_RECTS)).toBe(true), {
			timeout: 20_000,
		});
		expect(sink.areas().flat().length).toBeLessThanOrEqual(2048);
		stop.abort();
		await watching;
	}, 30_000);

	it("coalesces concurrent join whole-screen requests and avoids perpetual full-screen eviction amplification for a lagging watcher", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ringBytes: 64 * 40 * 4 * 2 });
		const firstSink = sinkOf();
		const stop = new AbortController();
		const first = stream.watch(async () => "ok", firstSink, stop.signal);
		await settle();
		desktop.send(update(rawRect(0, 0, 64, 40, [1, 2, 3])));
		await vi.waitFor(() => expect(firstSink.areas()).toHaveLength(1));

		const wholesBeforeJoin = desktop.requests().filter((r) => r === "update whole").length;
		const joiners = Array.from({ length: 6 }, () => stream.watch(async () => "ok", sinkOf(), stop.signal));
		await settle();
		expect(desktop.requests().filter((r) => r === "update whole").length).toBe(wholesBeforeJoin + 1);
		desktop.send(update(rawRect(0, 0, 64, 40, [4, 5, 6])));
		await settle();

		const slowGate = gate();
		const slowSink = sinkOf();
		const slow = stream.watch(slowGate.release, slowSink, stop.signal);
		await settle();
		desktop.send(update(rawRect(0, 0, 64, 40, [7, 8, 9])));
		await vi.waitFor(() => expect(slowGate.asked).toHaveLength(1));
		const wholesBeforeEvict = desktop.requests().filter((r) => r === "update whole").length;
		for (let i = 0; i < 20; i++) {
			desktop.send(update(rawRect(0, 0, 64, 40, [i, i, i])));
			await settle();
		}
		expect(desktop.requests().filter((r) => r === "update whole").length).toBe(wholesBeforeEvict + 1);

		const wholesBeforeRecover = desktop.requests().filter((r) => r === "update whole").length;
		slowGate.asked[0]!.resolve("ok");
		await vi.waitFor(() => expect(slowGate.asked).toHaveLength(2));
		expect(slowSink.messages).toHaveLength(0);
		expect(desktop.requests().filter((r) => r === "update whole").length).toBe(wholesBeforeRecover + 1);
		slowGate.asked[1]!.resolve("ok");
		await vi.waitFor(() => expect(slowSink.messages.some((m) => m.type === STREAM_RECTS)).toBe(true));

		stop.abort();
		await Promise.all([first, slow, ...joiners]);
	});

	/** The most any one drain() may do (review r10 of #1746): its budget, plus the one unit that may start just under it
	 * (the largest is the server's init with a 4 KiB name). */
	const MAX_CHARGE_A_TURN = RFB_TAKE_PER_TURN + RFB_UNIT_COST + 24 + 4096;
	/** The most events one drain() may hand on: every event is a unit, and so costs at least RFB_UNIT_COST. */
	const MAX_EVENTS_A_TURN = Math.ceil(MAX_CHARGE_A_TURN / RFB_UNIT_COST);

	it("charges every message to the turn, so a large update followed by 100,000 empty updates and 100,000 bells is read over many bounded turns (review r10 of #1746)", () => {
		let events = 0;
		const reader = new RfbReader((event) => {
			if (event.kind === "update") events++;
		});
		reader.feed(Buffer.concat(serverHello(1600, 1000)));
		// The whole screen in one area, then the flood, all pushed before a byte is read: the pile-up the push-then-read
		// design allows.
		reader.push(update(rawRect(0, 0, 1600, 1000, [1, 2, 3])));
		const empties = Buffer.alloc(4 * 100_000);
		for (let at = 0; at < empties.length; at += 4) empties[at] = 0;
		reader.push(empties);
		reader.push(Buffer.alloc(100_000, 2));
		let turns = 0;
		let most = 0;
		do {
			const before = events;
			reader.drain(RFB_TAKE_PER_TURN);
			turns++;
			most = Math.max(most, events - before);
			expect(reader.charged).toBeLessThanOrEqual(MAX_CHARGE_A_TURN);
		} while (reader.busy && turns < 100_000);
		expect(events).toBe(100_001);
		// Never more than a turn's worth: before, one drain handed on all 100,000 updates at once.
		expect(most).toBeLessThanOrEqual(MAX_EVENTS_A_TURN);
		expect(turns).toBeGreaterThan(100);
	});

	it("keeps the reader's pieces bounded by its bytes however small they come: a server that sends one byte at a time (review r11 of #1746)", () => {
		const events: { kind: string; rects?: { pixels: Buffer }[] }[] = [];
		const reader = new RfbReader((event) => events.push(event as never));
		reader.feed(Buffer.concat(serverHello(512, 320)));
		const pixels = fill(512, 320, [9, 8, 7]);
		const bytes = update(rawRect(0, 0, 512, 320, [9, 8, 7]));
		// 655,376 bytes, each its own piece, all pushed before a byte is read.
		let most = 0;
		for (let at = 0; at < bytes.length; at++) {
			reader.push(bytes.subarray(at, at + 1));
			if (at % 4096 === 0) most = Math.max(most, reader.queued.pieces);
		}
		// At most two pieces for every 4 KiB held (gathered into 4 KiB blocks), never one for every byte.
		expect(reader.queued.bytes).toBe(bytes.length);
		expect(reader.queued.pieces).toBeLessThanOrEqual(2 * Math.ceil(bytes.length / 4096) + 2);
		expect(most).toBeLessThanOrEqual(2 * Math.ceil(bytes.length / 4096) + 2);
		// And read in bounded turns, each well inside its time.
		let turns = 0;
		do {
			const began = performance.now();
			reader.drain(RFB_TAKE_PER_TURN);
			expect(performance.now() - began).toBeLessThan(TURN_CLOCK_MS);
			expect(reader.charged).toBeLessThanOrEqual(MAX_CHARGE_A_TURN);
			turns++;
		} while (reader.busy && turns < 1000);
		expect(events.at(-1)?.kind).toBe("update");
		expect(events.at(-1)?.rects?.[0]?.pixels.equals(pixels)).toBe(true);
		expect(reader.queued).toEqual({ bytes: 0, pieces: 0 });
	});

	it("drops the server's cut text and colour maps as they come, never holding or copying them, a turn's budget at a time (review r10 of #1746)", () => {
		const reader = new RfbReader(() => {});
		reader.feed(Buffer.concat(serverHello(64, 40)));
		// A 16 MiB cut text on a small screen (whose own budget is about 1 MiB): it streams through, dropped as it comes.
		const head = Buffer.alloc(8);
		head[0] = 3;
		head.writeUInt32BE(16 * 1024 * 1024, 4);
		reader.push(head);
		let turns = 0;
		for (let sent = 0; sent < 16 * 1024 * 1024; sent += 256 * 1024) {
			reader.push(Buffer.alloc(256 * 1024, 0x41));
			do {
				reader.drain(RFB_TAKE_PER_TURN);
				turns++;
				expect(reader.charged).toBeLessThanOrEqual(MAX_CHARGE_A_TURN);
			} while (reader.busy);
		}
		// A colour map of 65,535 entries (393 KB), then a bell: dropped the same way.
		const map = Buffer.alloc(6);
		map[0] = 1;
		map.writeUInt16BE(65_535, 4);
		reader.push(Buffer.concat([map, Buffer.alloc(6 * 65_535), Buffer.from([2])]));
		do reader.drain(RFB_TAKE_PER_TURN);
		while (reader.busy);
		// Then an update still reads: nothing of what was dropped is left in the way.
		let read = 0;
		const after = new RfbReader((event) => {
			if (event.kind === "update") read++;
		});
		after.feed(Buffer.concat(serverHello(64, 40)));
		// As the relay brings it: in pieces of at most its own 1 MiB buffer.
		const whole = Buffer.concat([head, Buffer.alloc(16 * 1024 * 1024, 0x41), update(rawRect(0, 0, 8, 8, [1, 1, 1]))]);
		for (let at = 0; at < whole.length; at += 1024 * 1024) after.feed(whole.subarray(at, at + 1024 * 1024));
		expect(read).toBe(1);
		expect(turns).toBeGreaterThan(16);
	});

	it("keeps the executor's loop free while a guest floods empty updates and bells behind a held release check (review r10 of #1746)", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0 });
		const { release } = gate();
		const stop = new AbortController();
		const watching = stream.watch(release, sinkOf(), stop.signal);
		await settle();
		desktop.send(update(rawRect(0, 0, 64, 40, [5, 5, 5])));
		await settle();
		const kept = stream.held.ring;
		// The longest stretch the event loop is held while the flood is read: a timer that should fire every millisecond.
		let last = performance.now();
		let longest = 0;
		const tick = setInterval(() => {
			const now = performance.now();
			longest = Math.max(longest, now - last);
			last = now;
		}, 1);
		const empties = Buffer.alloc(4 * 200_000);
		desktop.send(empties);
		desktop.send(Buffer.alloc(200_000, 2));
		// Read in turns: about 150 turns for the empty updates and 50 for the bells; a second and a half is plenty.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await vi.waitFor(() => expect(stream.held.outbox).toBeLessThanOrEqual(3));
		await new Promise((resolve) => setTimeout(resolve, 200));
		clearInterval(tick);
		// Nothing of the flood is kept, the requests it answers with replace one another, and no turn held the loop long
		// (before: one turn read all 200,000 updates, each a ring eviction with a scan of the whole ring).
		expect(stream.held.ring).toBe(kept);
		expect(stream.held.outbox).toBeLessThanOrEqual(3);
		expect(longest).toBeLessThan(LOOP_CLOCK_MS);
		stop.abort();
		await watching;
	}, 30_000);

	it("stands guard over the reader's turn: seeded random sequences of every message it accepts, at and around its bounds, in random pieces (review r10 of #1746)", () => {
		// A small seeded generator: the same sequences on every run, and a new seed is one number away.
		const generator = (seed: number) => () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		for (const seed of [1, 7, 1746]) {
			const random = generator(seed);
			const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
			let width = 256;
			let height = 160;
			const budget = () => 2 * 4 * width * height + 1024 * 1024;
			const sent: { rects: number; size: boolean; cursor: boolean }[] = [];
			const got: { rects: number; size: boolean; cursor: boolean }[] = [];
			let eventsThisTurn = 0;
			const reader = new RfbReader((event) => {
				if (event.kind !== "update") return;
				eventsThisTurn++;
				got.push({ rects: event.rects.length, size: event.size !== null, cursor: event.cursor !== null });
			});
			reader.feed(Buffer.concat(serverHello(width, height)));
			const rect = (x: number, y: number, w: number, h: number) => rawRect(x, y, w, h, [int(0, 255), 1, 2]);
			const message = (): Buffer => {
				const kind = random();
				if (kind < 0.25) {
					// An update of areas within the screen: often a few, sometimes the most allowed (1,024), sometimes up to
					// the screen's own budget in pixels.
					const most = random() < 0.05;
					const count = most ? 1024 : int(0, 12);
					const parts: Buffer[] = [];
					let bytes = 4;
					for (let n = 0; n < count; n++) {
						const w = most ? int(1, 4) : int(1, width);
						const h = most ? int(1, 4) : int(1, height);
						if (bytes + 12 + w * h * 4 > budget() - 4096) break;
						parts.push(rect(int(0, width - w), int(0, height - h), w, h));
						bytes += 12 + w * h * 4;
					}
					// A pointer shape too, now and then (never beyond the 1,024 entries an update may have).
					const withCursor = parts.length < 1024 && random() < 0.1;
					if (withCursor) {
						const side = int(1, 32);
						const head = Buffer.alloc(12);
						head.writeUInt16BE(side, 4);
						head.writeUInt16BE(side, 6);
						head.writeInt32BE(-239, 8);
						parts.push(
							Buffer.concat([head, Buffer.alloc(side * side * 4), Buffer.alloc(Math.ceil(side / 8) * side)]),
						);
					}
					sent.push({ rects: parts.length - (withCursor ? 1 : 0), size: false, cursor: withCursor });
					return update(...parts);
				}
				if (kind < 0.3) {
					// The screen's size changes (alone in its update, as Xvnc sends it).
					width = int(32, 320);
					height = int(32, 200);
					const head = Buffer.alloc(12);
					head.writeUInt16BE(width, 4);
					head.writeUInt16BE(height, 6);
					head.writeInt32BE(-223, 8);
					sent.push({ rects: 0, size: true, cursor: false });
					return update(head);
				}
				if (kind < 0.55) {
					// Empty updates, many at once.
					const many = int(1, 20_000);
					for (let n = 0; n < many; n++) sent.push({ rects: 0, size: false, cursor: false });
					return Buffer.alloc(4 * many);
				}
				if (kind < 0.75) return Buffer.alloc(int(1, 20_000), 2);
				if (kind < 0.88) {
					const count = random() < 0.1 ? 65_535 : int(0, 300);
					const head = Buffer.alloc(6);
					head[0] = 1;
					head.writeUInt16BE(count, 4);
					return Buffer.concat([head, Buffer.alloc(6 * count, 9)]);
				}
				const length = random() < 0.05 ? 4 * 1024 * 1024 : int(0, 70_000);
				const head = Buffer.alloc(8);
				head[0] = 3;
				head.writeUInt32BE(length, 4);
				return Buffer.concat([head, Buffer.alloc(length, 0x42)]);
			};
			let turns = 0;
			let slowest = 0;
			for (let n = 0; n < 400; n++) {
				const bytes = message();
				// In random pieces, from single bytes to 256 KiB, read after each piece until the reader waits for more.
				for (let at = 0; at < bytes.length; ) {
					const piece = random() < 0.2 ? int(1, 16) : int(1, 262_144);
					reader.push(bytes.subarray(at, at + piece));
					at += piece;
					do {
						eventsThisTurn = 0;
						const began = performance.now();
						reader.drain(RFB_TAKE_PER_TURN);
						const took = performance.now() - began;
						slowest = Math.max(slowest, took);
						turns++;
						// For EVERY turn: what it handed on, what it was charged (every byte it copied is charged), its time.
						expect(eventsThisTurn).toBeLessThanOrEqual(MAX_EVENTS_A_TURN);
						expect(reader.charged).toBeLessThanOrEqual(MAX_CHARGE_A_TURN);
						// Its own time: a turn's work is about a millisecond; the limit leaves room for the shared test
						// machine's pauses (its strict bounds are the two above).
						expect(took).toBeLessThan(TURN_CLOCK_MS);
					} while (reader.busy);
				}
			}
			// And nothing was lost or reordered on the way: every update, in order.
			expect(got).toEqual(sent);
			expect(turns).toBeGreaterThan(400);
			expect(slowest).toBeLessThan(TURN_CLOCK_MS);
		}
	}, 120_000);

	it("asks the server ONE thing for every update it sent, however long a member lags: never a request of its own per eviction (review r11 of #1746)", async () => {
		const desktop = fakeDesktop();
		// A ring of two screens and a member whose cycle never answers: every update evicts and moves the member on.
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ringBytes: 64 * 40 * 4 * 2 });
		const { release } = gate();
		const stop = new AbortController();
		const watching = stream.watch(release, sinkOf(), stop.signal);
		await settle();
		const before = desktop.requests().length;
		for (let n = 0; n < 50; n++) {
			desktop.send(update(rawRect(0, 0, 64, 40, [n, n, n])));
			await settle();
		}
		const asked = desktop.requests().slice(before);
		// One request for each of the 50 updates (some for the whole screen, the member having been moved on), never two:
		// before, every eviction asked beside the next request, and full-screen noise on the real machine piled the
		// server's answers past the reader's bound within seconds.
		expect(asked.length).toBeLessThanOrEqual(50);
		expect(asked.length).toBeGreaterThanOrEqual(45);
		expect(asked.filter((request) => request === "update whole").length).toBeGreaterThan(0);
		stop.abort();
		await watching;
	});

	it("lets an update's pixels go the moment the ring lets it go, and a piece of the server's bytes the moment it is read: what it holds is its bounds, whatever was garbage before (review r11 of #1746)", async () => {
		// The worker's buffers grew by 2.4 GB in ten seconds of full-screen noise on the real machine: the ring and the
		// reader's queue left what they let go in their arrays until those were compacted (1,024 updates, 64 pieces).
		setFlagsFromString("--expose-gc");
		const collect = runInNewContext("gc") as () => void;
		const buffers = () => {
			collect();
			return process.memoryUsage().arrayBuffers;
		};
		// A 512 x 512 screen (1 MiB an update), a ring of two of them, and a member whose cycle never answers: every update
		// evicts the one before it, as under noise.
		const desktop = fakeDesktop(512, 512);
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0, ringBytes: 2 * 1024 * 1024 });
		const { release } = gate();
		const stop = new AbortController();
		const watching = stream.watch(release, sinkOf(), stop.signal);
		await settle();
		const before = buffers();
		for (let n = 0; n < 300; n++) {
			desktop.send(update(rawRect(0, 0, 512, 512, [n & 0xff, 0, 0])));
			await settle();
		}
		expect(stream.held.ring).toBeLessThanOrEqual(3);
		// 300 MiB went through; the ring holds two, the queue none, and nothing else is left of them.
		expect(buffers() - before).toBeLessThan(16 * 1024 * 1024);
		stop.abort();
		await watching;
	});

	it("keeps a large area as bands of whole rows sharing its pixels, so no PNG or message is much over a megabyte to make (v245 release review)", async () => {
		const desktop = fakeDesktop();
		const stream = new DesktopStream({ run: desktop.run, cycleEveryMs: 0 });
		const sink = sinkOf();
		const stop = new AbortController();
		const watching = stream.watch(async () => "ok", sink, stop.signal);
		await settle();
		// The screen grows to 1024 x 600 (its own update, as Xvnc sends it), then comes whole in one area of 2.4 MB.
		const resize = Buffer.alloc(12);
		resize.writeUInt16BE(1024, 4);
		resize.writeUInt16BE(600, 6);
		resize.writeInt32BE(-223, 8);
		desktop.send(update(resize));
		await settle();
		desktop.send(update(rawRect(0, 0, 1024, 600, [7, 8, 9])));
		// Bands of at most 262,144 pixels: 256 rows of 1,024, in order, the last what is left.
		await vi.waitFor(() => expect(sink.areas().flat()).toHaveLength(3));
		expect(sink.areas().flat()).toEqual(["0,0 1024x256 #070809", "0,256 1024x256 #070809", "0,512 1024x88 #070809"]);
		for (const message of sink.messages.filter((one) => one.type === STREAM_RECTS))
			expect(message.body.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
		// A pointer shape larger than the browser shows (128 a side) is not sent at all; one it shows is.
		const shape = (side: number) => {
			const head = Buffer.alloc(12);
			head.writeUInt16BE(side, 4);
			head.writeUInt16BE(side, 6);
			head.writeInt32BE(-239, 8);
			return Buffer.concat([head, Buffer.alloc(side * side * 4), Buffer.alloc(Math.ceil(side / 8) * side, 0xff)]);
		};
		desktop.send(update(shape(200)));
		await settle();
		await settle();
		expect(sink.messages.some((message) => message.type === STREAM_CURSOR)).toBe(false);
		desktop.send(update(shape(16)));
		await vi.waitFor(() => expect(sink.messages.some((message) => message.type === STREAM_CURSOR)).toBe(true));
		stop.abort();
		await watching;
	});

	it("leaves out an area a later one covers in ONE pass, keeping their order, linear in how many there are (v245 release review F1)", () => {
		const at = (x: number, y: number, width: number, height: number) => ({
			x,
			y,
			width,
			height,
			pixels: Buffer.alloc(0),
		});
		// The same spot later, and a later area that covers an earlier one, hide it; the order of the rest stands.
		const a = at(0, 0, 10, 10);
		const b = at(5, 5, 2, 2);
		const c = at(0, 0, 10, 10);
		const d = at(20, 20, 4, 4);
		expect(visibleRects([a, b, c, d])).toEqual([c, d]);
		const whole = at(0, 0, 64, 40);
		expect(visibleRects([b, d, whole, at(1, 1, 1, 1)])).toEqual([whole, at(1, 1, 1, 1)]);
		// 102,400 tiny areas: the old pairwise check took minutes on node 2 (49 ms for 4,096, 545 ms for 16,384).
		const many = Array.from({ length: 102_400 }, (_, n) => at(n % 1600, Math.floor(n / 1600), 1, 1));
		const began = performance.now();
		expect(visibleRects(many)).toHaveLength(102_400);
		expect(performance.now() - began).toBeLessThan(1500);
	});

	it("takes a whole screen of the largest desktop out over many turns, each within its budget (v245 release review)", () => {
		const events: { kind: string; rects?: { width: number; height: number; pixels: Buffer }[] }[] = [];
		const reader = new RfbReader((event) => events.push(event as never));
		reader.feed(Buffer.concat(serverHello(3840, 2160)));
		// One area of the whole 3840 x 2160 screen: 33 MB, in 64 KiB pieces, all pushed before any is read.
		const head = Buffer.alloc(4 + 12);
		head.writeUInt16BE(1, 2);
		head.writeUInt16BE(3840, 8);
		head.writeUInt16BE(2160, 10);
		head.writeInt32BE(0, 12);
		// Every byte non-zero: a resumed take that read the pixels as a message's type would be refused, not lucky.
		const pixels = Buffer.alloc(3840 * 2160 * 4, 0x5a);
		for (let i = 0; i < pixels.length; i += 4096) pixels[i] = ((i >> 12) & 0xff) | 1;
		const bytes = Buffer.concat([head, pixels]);
		for (let at = 0; at < bytes.byteLength; at += 65536) reader.push(bytes.subarray(at, at + 65536));
		let drains = 0;
		do {
			reader.drain(RFB_TAKE_PER_TURN);
			drains++;
		} while (reader.busy && drains < 1000);
		// Never all of it in one turn: about one turn for every RFB_TAKE_PER_TURN bytes.
		expect(drains).toBeGreaterThanOrEqual(Math.floor(pixels.byteLength / RFB_TAKE_PER_TURN));
		const last = events.at(-1);
		expect(last?.kind).toBe("update");
		expect(last?.rects?.[0]?.pixels.equals(pixels)).toBe(true);
		// A screen like this in many small pieces still reads in time linear in its size.
		const small = new RfbReader(() => {});
		small.feed(Buffer.concat(serverHello(3840, 2160)));
		const began = performance.now();
		for (let at = 0; at < bytes.byteLength; at += 1024) small.feed(bytes.subarray(at, at + 1024));
		expect(performance.now() - began).toBeLessThan(3000);
	});

	it("filters a PNG's rows a slice at a time, giving the event loop a turn after each (v245 release review)", async () => {
		const turns = vi.spyOn(globalThis, "setImmediate");
		const before = turns.mock.calls.length;
		const png = await encodePng(1600, 1000, fill(1600, 1000, [10, 20, 30]));
		const yielded = turns.mock.calls.length - before;
		turns.mockRestore();
		const rowsPerTurn = Math.floor(PNG_PIXELS_PER_TURN / 1600);
		expect(yielded).toBeGreaterThanOrEqual(Math.floor(1000 / rowsPerTurn) - 1);
		const decoded = decodePng(png);
		expect([decoded.width, decoded.height]).toEqual([1600, 1000]);
		expect([...decoded.data.subarray(0, 3)]).toEqual([10, 20, 30]);
		expect([...decoded.data.subarray(-3)]).toEqual([10, 20, 30]);
	});

	it("yields the event loop before deflating a sub-turn 1600x36 Xvnc band so 28-band frames cannot chain in one turn", async () => {
		const band = Buffer.alloc(1600 * 36 * 4);
		for (let i = 0; i < band.byteLength; i++) band[i] = (i * 73 + (i >> 3)) & 0xff;
		let settled = false;
		const pending = encodePng(1600, 36, band).then((png) => {
			settled = true;
			return png;
		});
		for (let i = 0; i < 3; i++) {
			await new Promise<void>((resolve) => process.nextTick(resolve));
		}
		expect(settled).toBe(false);
		const encoded = await pending;
		expect(settled).toBe(true);
		const sample = decodePng(encoded);
		expect([sample.width, sample.height, sample.channels]).toEqual([1600, 36, 3]);
		expect([...sample.data.subarray(0, 3)]).toEqual([band[2], band[1], band[0]]);
		expect([...sample.data.subarray(-3)]).toEqual([
			band[band.byteLength - 2],
			band[band.byteLength - 3],
			band[band.byteLength - 4],
		]);
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

	it.skipIf(process.platform !== "linux" || spawnSync("python3", ["-c", "0"]).status !== 0)(
		"runs its relay only on SQL's boot, with python3 and the desktop running, in a real shell",
		async () => {
			const bin = await realpath(await mkdtemp(join(tmpdir(), "desktop-view-")));
			try {
				const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
				const run = (bootId = boot) =>
					spawnSync("/bin/sh", ["-c", COMPANY_MACHINE_DESKTOP_VIEW, bootId, "import sys; sys.exit(7)"], {
						env: { PATH: bin },
					}).status;
				const systemctl = async (body: string) => {
					await writeFile(join(bin, "systemctl"), `#!/bin/sh\n${body}\n`);
					await chmod(join(bin, "systemctl"), 0o755);
				};
				expect(run(randomUUID())).toBe(97);
				expect(run()).toBe(98);
				const python = spawnSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
				await symlink(python, join(bin, "python3"));
				await systemctl("exit 3");
				expect(run()).toBe(95);
				await systemctl('[ "$*" = "is-active --quiet qorpera-machine-desktop.service" ] || exit 9');
				expect(run(randomUUID())).toBe(97);
				expect(run()).toBe(7);
			} finally {
				await rm(bin, { recursive: true, force: true });
			}
		},
	);

	it("runs nothing else from its relay: no subprocess, shell, exec, eval or file open", () => {
		expect(COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM).not.toMatch(/subprocess|os\.system|exec\(|eval\(|open\(/);
	});

	it("ends the stream cleanly on a synchronous push-time RFB_UPDATE_TOO_LARGE burst instead of throwing", async () => {
		let pushChunk: ((chunk: Buffer) => void) | undefined;
		const stream = new DesktopStream({
			run(stdout, _stdin, signal) {
				pushChunk = stdout;
				return new Promise((resolve) => {
					signal.addEventListener("abort", () => resolve(0), { once: true });
				});
			},
		});
		const watcher = stream.watch(async () => "ok", { send: async () => {} }, new AbortController().signal);
		await vi.waitFor(() => expect(pushChunk).toBeDefined());
		expect(() => pushChunk?.(Buffer.alloc(2 * 1024 * 1024))).not.toThrow();
		expect(await watcher).toBe("STREAM_UNAVAILABLE");
	});

	it.skipIf(process.platform !== "linux" || spawnSync("python3", ["-c", "0"]).status !== 0)(
		"exits with 96 when the VNC socket resets during send instead of crashing with exit 1",
		async () => {
			const server = createServer((socket: Socket) => {
				socket.destroy();
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				const port = (server.address() as { port: number }).port;
				const program = COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM.replace(
					"('127.0.0.1', 5901)",
					`('127.0.0.1', ${port})`,
				).replace("/run/qorpera-desktop/last-use", "/nonexistent/last-use");
				const relay = spawn("python3", ["-c", program], { stdio: ["pipe", "pipe", "ignore"] });
				relay.stdin.write(RFB_VERSION);
				const code = await new Promise<number | null>((resolve) => relay.on("exit", resolve));
				expect(code).toBe(96);
			} finally {
				server.close();
			}
		},
		15_000,
	);
});
