import { deflate } from "node:zlib";

/**
 * A desktop's live picture (20260930745000; POINTER-PROGRESS.md 05:15Z, step 2): the machine's own VNC server (Xvnc,
 * on the machine's loopback 127.0.0.1:5901) read through ONE held-open relay per desktop, its changed areas encoded as
 * PNG on the machine's node and handed to each member who watches in the large view, each only after a release cycle of
 * their own (the three checks every picture passes today) that began after the change.
 *
 * It only SHOWS, by construction, at two places:
 * - this module makes three client messages and no other: SetPixelFormat, SetEncodings and FramebufferUpdateRequest
 *   (rfbSetPixelFormat, rfbSetEncodings, rfbUpdateRequest), besides the handshake's own three answers. It has no way to
 *   make a key, a pointer or a clipboard message;
 * - the relay in the machine (COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM) reads what the host sends and passes on the
 *   handshake and those three message types only; anything else ends it before a byte of it reaches the VNC server.
 * And the desktop's clipboard never leaves: the server's cut text is read and dropped here.
 */

/** The relay (`$1`, its program), as root on exactly the boot SQL named (`$0`, else 97), with python3 (else 98), the
 * desktop running (else 95). It ends when the VNC server's connection ends (a desktop stop or restart ends its X server,
 * and with it this), when its stdin ends (the host stopped watching), or on anything the host sends that is not allowed
 * (93). While it runs it touches the desktop's idle clock every 30 s: a member watching is a member at the desktop (the
 * window stops watching after 30 minutes without a touch, as its looks pause). */
export const COMPANY_MACHINE_DESKTOP_VIEW = [
	'{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97',
	"command -v python3 >/dev/null 2>&1 || exit 98",
	"systemctl is-active --quiet qorpera-machine-desktop.service || exit 95",
	'exec python3 -c "$1"',
].join("\n");

/** The relay's program: the VNC server's bytes to stdout as they come; from stdin, only the handshake's three answers
 * (the version `RFB 003.008`, the security type None, the shared flag) and then SetPixelFormat (0, 20 bytes),
 * SetEncodings (2, 4 + 4n bytes, n at most 16) and FramebufferUpdateRequest (3, 10 bytes). A key (4), a pointer (5),
 * the clipboard (6) or anything else ends it (93) before any of it reaches the server. */
export const COMPANY_MACHINE_DESKTOP_VIEW_PROGRAM = [
	"import os, socket, sys, threading, time",
	"try:",
	"    vnc = socket.create_connection(('127.0.0.1', 5901), timeout=5)",
	"except OSError:",
	"    sys.exit(95)",
	"vnc.settimeout(None)",
	"vnc.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)",
	// The server went away (the desktop stopped or restarted): 96, so the host hears the desktop ended (an exit 0 with
	// the host's input still open is a failed call to LXD; the real machine's run 2 of this step).
	"def down():",
	"    try:",
	"        while True:",
	"            data = vnc.recv(65536)",
	"            if not data:",
	"                break",
	"            sys.stdout.buffer.write(data)",
	"            sys.stdout.buffer.flush()",
	"    except OSError:",
	"        pass",
	"    os._exit(96)",
	"threading.Thread(target=down, daemon=True).start()",
	// A member watching is a member at the desktop: its idle clock, every 30 s while the picture is watched (as a look
	// the member confirmed keeps it).
	"def keep():",
	"    while True:",
	"        try:",
	"            os.utime('/run/qorpera-desktop/last-use')",
	"        except OSError:",
	"            pass",
	"        time.sleep(30)",
	"threading.Thread(target=keep, daemon=True).start()",
	"held = b''",
	"stage = 0",
	"def allowed():",
	"    global held, stage",
	"    while True:",
	"        if stage == 0:",
	"            if len(held) < 12:",
	"                return",
	"            if held[:12] != b'RFB 003.008\\n':",
	"                os._exit(93)",
	"            size = 12",
	"        elif stage in (1, 2):",
	"            if len(held) < 1:",
	"                return",
	"            if held[:1] != b'\\x01':",
	"                os._exit(93)",
	"            size = 1",
	"        else:",
	"            if len(held) < 1:",
	"                return",
	"            kind = held[0]",
	"            if kind == 0:",
	"                size = 20",
	"            elif kind == 3:",
	"                size = 10",
	"            elif kind == 2:",
	"                if len(held) < 4:",
	"                    return",
	"                count = int.from_bytes(held[2:4], 'big')",
	"                if count > 16:",
	"                    os._exit(93)",
	"                size = 4 + 4 * count",
	"            else:",
	"                os._exit(93)",
	"        if len(held) < size:",
	"            return",
	"        vnc.sendall(held[:size])",
	"        held = held[size:]",
	"        stage = min(stage + 1, 3)",
	"while True:",
	"    data = os.read(0, 65536)",
	"    if not data:",
	"        break",
	"    held += data",
	"    if len(held) > 1 << 20:",
	"        os._exit(93)",
	"    allowed()",
	"vnc.close()",
	"os._exit(0)",
].join("\n");

/** The relay's exits besides 0 (its input ended: the host stopped watching): not allowed (93, never for what this
 * module sends), the desktop off (95), the desktop's server went away (96), another boot (97), an image without python3
 * (98). */
export const DESKTOP_VIEW_EXITS: Readonly<
	Record<number, "DESKTOP_NOT_RUNNING" | "DESKTOP_ENDED" | "MACHINE_BOOT_CHANGED" | "MACHINE_IMAGE_WITHOUT_SCREEN">
> = Object.freeze({
	95: "DESKTOP_NOT_RUNNING",
	96: "DESKTOP_ENDED",
	97: "MACHINE_BOOT_CHANGED",
	98: "MACHINE_IMAGE_WITHOUT_SCREEN",
});

// The client's side of RFB 3.8: the only messages this module can make.

export const RFB_VERSION = Buffer.from("RFB 003.008\n", "latin1");
const RFB_SECURITY_NONE = 1;
/** 32 bits a pixel, true colour, little-endian: each pixel's bytes are blue, green, red, unused. */
export function rfbSetPixelFormat(): Buffer {
	const message = Buffer.alloc(20);
	message[0] = 0;
	message.set([32, 24, 0, 1], 4);
	message.writeUInt16BE(255, 8);
	message.writeUInt16BE(255, 10);
	message.writeUInt16BE(255, 12);
	message.set([16, 8, 0], 14);
	return message;
}
/** Raw (0), the cursor's shape (-239) and the desktop's size (-223): nothing the module could not read. */
export const RFB_ENCODINGS: readonly number[] = Object.freeze([0, -239, -223]);
export function rfbSetEncodings(): Buffer {
	const message = Buffer.alloc(4 + 4 * RFB_ENCODINGS.length);
	message[0] = 2;
	message.writeUInt16BE(RFB_ENCODINGS.length, 2);
	for (const [index, encoding] of RFB_ENCODINGS.entries()) message.writeInt32BE(encoding, 4 + 4 * index);
	return message;
}
export function rfbUpdateRequest(incremental: boolean, width: number, height: number): Buffer {
	const message = Buffer.alloc(10);
	message[0] = 3;
	message[1] = incremental ? 1 : 0;
	message.writeUInt16BE(width, 6);
	message.writeUInt16BE(height, 8);
	return message;
}

/** A changed area of the screen, its pixels as the server sent them (blue, green, red, unused). */
export interface RfbRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly pixels: Buffer;
}
/** The pointer's shape: its hot spot, its pixels, and which of them it shows (one bit each, rows to whole bytes). */
export interface RfbCursor {
	readonly hotX: number;
	readonly hotY: number;
	readonly width: number;
	readonly height: number;
	readonly pixels: Buffer;
	readonly mask: Buffer;
}
export type RfbEvent =
	| { readonly kind: "init"; readonly width: number; readonly height: number }
	| {
			readonly kind: "update";
			readonly rects: readonly RfbRect[];
			readonly cursor: RfbCursor | null;
			readonly size: { readonly width: number; readonly height: number } | null;
	  };

/** Bytes that came in pieces, read off in order without copying more than is asked. */
class ByteQueue {
	readonly #chunks: Buffer[] = [];
	#length = 0;
	get length(): number {
		return this.#length;
	}
	push(chunk: Buffer): void {
		if (chunk.byteLength === 0) return;
		this.#chunks.push(chunk);
		this.#length += chunk.byteLength;
	}
	/** The first `size` bytes, without taking them. */
	peek(size: number): Buffer {
		return this.peekAt(0, size);
	}
	/** `size` bytes from `offset` on, without taking them: a view of one piece, or a copy of just those bytes when they
	 * span pieces (never of what comes before them: a large update read header by header costs no more than its size). */
	peekAt(offset: number, size: number): Buffer {
		if (offset < 0 || offset + size > this.#length) throw new Error("RFB_SHORT");
		let index = 0;
		let skip = offset;
		while (skip > 0 && skip >= (this.#chunks[index] as Buffer).byteLength) {
			skip -= (this.#chunks[index] as Buffer).byteLength;
			index++;
		}
		const first = this.#chunks[index] as Buffer;
		if (first.byteLength - skip >= size) return first.subarray(skip, skip + size);
		const out = Buffer.allocUnsafe(size);
		let at = 0;
		for (let i = index; at < size; i++) {
			const chunk = this.#chunks[i] as Buffer;
			const from = i === index ? skip : 0;
			const part = Math.min(chunk.byteLength - from, size - at);
			chunk.copy(out, at, from, from + part);
			at += part;
		}
		return out;
	}
	take(size: number): Buffer {
		const first = this.#chunks[0];
		// A part of one piece is copied out (the piece is let go); one made of several pieces is a copy already.
		const out =
			size === 0
				? Buffer.alloc(0)
				: first && first.byteLength >= size
					? Buffer.from(first.subarray(0, size))
					: this.peek(size);
		let left = size;
		while (left > 0) {
			const first = this.#chunks[0] as Buffer;
			if (first.byteLength <= left) {
				this.#chunks.shift();
				left -= first.byteLength;
			} else {
				this.#chunks[0] = first.subarray(left);
				left = 0;
			}
		}
		this.#length -= size;
		return out;
	}
}

/** The largest screen a machine has (`desktop size`), and so the largest area a server may send. */
const MAX_SIDE = 4096;

/**
 * Reads an RFB 3.8 server's bytes as they come (feed) and answers what the handshake asks, with nothing else: the
 * version, the security type None and the shared flag; then, once the server said what it is, this module's pixel
 * format, its encodings and a request for the whole screen. Every FramebufferUpdate becomes one `update` event; a
 * colour map, a bell and the server's cut text (the desktop's clipboard) are read and dropped. Anything it does not
 * know throws: the relay is ended.
 */
export class RfbReader {
	readonly #queue = new ByteQueue();
	readonly #onEvent: (event: RfbEvent) => void;
	#stage: "version" | "security" | "result" | "init" | "messages" = "version";
	#width = 0;
	#height = 0;
	/** How far the sizes of an update's rectangles were walked while its bytes come: each piece goes on from there. */
	#walk: { count: number; index: number; at: number } | null = null;
	constructor(onEvent: (event: RfbEvent) => void) {
		this.#onEvent = onEvent;
	}
	get width(): number {
		return this.#width;
	}
	get height(): number {
		return this.#height;
	}
	/** Takes the server's next bytes; answers what to send it now (the handshake's answers only). */
	feed(chunk: Buffer): Buffer[] {
		this.#queue.push(chunk);
		const out: Buffer[] = [];
		for (;;) {
			const step = this.#step();
			if (step === null) return out;
			out.push(...step);
		}
	}
	/** One step if its bytes are all there: what to send for it; null when more bytes are needed. */
	#step(): Buffer[] | null {
		const queue = this.#queue;
		switch (this.#stage) {
			case "version": {
				if (queue.length < 12) return null;
				const version = queue.take(12).toString("latin1");
				if (!/^RFB 003\.(00[89]|[0-9]{3})\n$/.test(version) || version < "RFB 003.008\n")
					throw new Error("RFB_VERSION_REFUSED");
				this.#stage = "security";
				return [Buffer.from(RFB_VERSION)];
			}
			case "security": {
				if (queue.length < 1) return null;
				const count = queue.peek(1)[0] as number;
				if (count === 0) throw new Error("RFB_REFUSED");
				if (queue.length < 1 + count) return null;
				const types = queue.take(1 + count).subarray(1);
				if (!types.includes(RFB_SECURITY_NONE)) throw new Error("RFB_SECURITY_REFUSED");
				this.#stage = "result";
				return [Buffer.from([RFB_SECURITY_NONE])];
			}
			case "result": {
				if (queue.length < 4) return null;
				if (queue.take(4).readUInt32BE(0) !== 0) throw new Error("RFB_REFUSED");
				this.#stage = "init";
				// Shared: other viewers (an earlier one of this host's, another tool) are not cut off.
				return [Buffer.from([1])];
			}
			case "init": {
				if (queue.length < 24) return null;
				const nameLength = queue.peek(24).readUInt32BE(20);
				if (nameLength > 4096) throw new Error("RFB_INVALID");
				if (queue.length < 24 + nameLength) return null;
				const init = queue.take(24 + nameLength);
				this.#width = init.readUInt16BE(0);
				this.#height = init.readUInt16BE(2);
				if (this.#width < 1 || this.#height < 1 || this.#width > MAX_SIDE || this.#height > MAX_SIDE)
					throw new Error("RFB_INVALID");
				this.#stage = "messages";
				this.#onEvent({ kind: "init", width: this.#width, height: this.#height });
				return [rfbSetPixelFormat(), rfbSetEncodings(), rfbUpdateRequest(false, this.#width, this.#height)];
			}
			case "messages":
				return this.#message();
		}
	}
	#message(): Buffer[] | null {
		const queue = this.#queue;
		if (queue.length < 1) return null;
		const type = queue.peek(1)[0] as number;
		if (type === 0) return this.#update();
		if (type === 1) {
			if (queue.length < 6) return null;
			const count = queue.peek(6).readUInt16BE(4);
			if (queue.length < 6 + 6 * count) return null;
			queue.take(6 + 6 * count);
			return [];
		}
		if (type === 2) {
			queue.take(1);
			return [];
		}
		if (type === 3) {
			// The server's cut text: the desktop's clipboard. Read past and dropped, never kept or passed on.
			if (queue.length < 8) return null;
			const length = queue.peek(8).readUInt32BE(4);
			if (length > 16 * 1024 * 1024) throw new Error("RFB_INVALID");
			if (queue.length < 8 + length) return null;
			queue.take(8 + length);
			return [];
		}
		throw new Error("RFB_UNKNOWN_MESSAGE");
	}
	/** A FramebufferUpdate, once all of it is there (it is read whole, so a half one never shows). */
	#update(): Buffer[] | null {
		const queue = this.#queue;
		if (queue.length < 4) return null;
		// Walk its rectangles' sizes first: nothing is taken until the whole update is there. The walk goes on from where
		// the last piece left it.
		const walk = this.#walk ?? { count: queue.peek(4).readUInt16BE(2), index: 0, at: 4 };
		this.#walk = walk;
		for (; walk.index < walk.count; walk.index++) {
			if (queue.length < walk.at + 12) return null;
			const head = queue.peekAt(walk.at, 12);
			const w = head.readUInt16BE(4);
			const h = head.readUInt16BE(6);
			const encoding = head.readInt32BE(8);
			if (w > MAX_SIDE || h > MAX_SIDE) throw new Error("RFB_INVALID");
			if (encoding === 0) walk.at += 12 + w * h * 4;
			else if (encoding === -239) walk.at += 12 + w * h * 4 + Math.ceil(w / 8) * h;
			else if (encoding === -223) walk.at += 12;
			else throw new Error("RFB_UNKNOWN_ENCODING");
		}
		if (queue.length < walk.at) return null;
		this.#walk = null;
		const count = walk.count;
		// A size change in this update bounds its later areas.
		let width = this.#width;
		let height = this.#height;
		queue.take(4);
		const rects: RfbRect[] = [];
		let cursor: RfbCursor | null = null;
		let size: { width: number; height: number } | null = null;
		for (let index = 0; index < count; index++) {
			const head = queue.take(12);
			const x = head.readUInt16BE(0);
			const y = head.readUInt16BE(2);
			const w = head.readUInt16BE(4);
			const h = head.readUInt16BE(6);
			const encoding = head.readInt32BE(8);
			if (encoding === 0) {
				const pixels = queue.take(w * h * 4);
				if (w > 0 && h > 0 && x + w <= width && y + h <= height) rects.push({ x, y, width: w, height: h, pixels });
				else if (w > 0 && h > 0) throw new Error("RFB_INVALID");
			} else if (encoding === -239) {
				const pixels = queue.take(w * h * 4);
				const mask = queue.take(Math.ceil(w / 8) * h);
				cursor = { hotX: x, hotY: y, width: w, height: h, pixels, mask };
			} else {
				size = { width: w, height: h };
				this.#width = w;
				this.#height = h;
				width = w;
				height = h;
				if (w < 1 || h < 1) throw new Error("RFB_INVALID");
			}
		}
		this.#onEvent({ kind: "update", rects, cursor, size });
		return [];
	}
}

// PNG, as small as is cheap: RGB (or RGBA for the pointer), each row filtered by its byte to the left, deflated off the
// event loop (zlib's own threads).

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();
function crc32(parts: readonly Buffer[]): number {
	let c = 0xffffffff;
	for (const part of parts)
		for (let i = 0; i < part.byteLength; i++) c = (CRC_TABLE[(c ^ (part[i] as number)) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.byteLength, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32([head.subarray(4), data]), 0);
	return Buffer.concat([head, data, crc]);
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function deflated(data: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		deflate(data, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result))),
	);
}
/** A PNG of `width` x `height` pixels given as blue, green, red, unused; `alpha` (a function of the pixel's index) makes
 * it RGBA. Each row is filtered by the byte one pixel to its left (PNG's Sub), which suits a screen's flat areas. */
export async function encodePng(
	width: number,
	height: number,
	pixels: Buffer,
	alpha?: (index: number) => number,
): Promise<Buffer> {
	const channels = alpha ? 4 : 3;
	const stride = width * channels;
	const raw = Buffer.allocUnsafe((stride + 1) * height);
	const line = Buffer.allocUnsafe(stride);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const from = (y * width + x) * 4;
			const to = x * channels;
			line[to] = pixels[from + 2] as number;
			line[to + 1] = pixels[from + 1] as number;
			line[to + 2] = pixels[from] as number;
			if (alpha) line[to + 3] = alpha(y * width + x);
		}
		const row = y * (stride + 1);
		raw[row] = 1;
		for (let i = 0; i < stride; i++)
			raw[row + 1 + i] = ((line[i] as number) - (i >= channels ? (line[i - channels] as number) : 0)) & 0xff;
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", await deflated(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// What a member's stream is sent: binary messages the browser draws (packages/web/src/cloud/machine-stream.ts).
/** `1, width u16, height u16`: the screen's size (first, and again when it changes). */
export const STREAM_SIZE = 1;
/** `2, count u16`, then each `x, y, width, height` (u16) and `bytes` (u32) of a PNG: changed areas, drawn in order. */
export const STREAM_RECTS = 2;
/** `3, hotX, hotY, width, height` (u16), `bytes` (u32) of an RGBA PNG: the pointer's shape. */
export const STREAM_CURSOR = 3;

/** Where a member's stream goes: `send` resolves once the message is on its way and the way is not full. */
export interface DesktopStreamSink {
	send(message: Buffer): Promise<void>;
}
/** One release cycle (the three checks every picture passes, for this member): `ok` lets go what changed before it
 * began; `pending` holds it for the next (the folder's boundary did not answer in time); `{ end }` ends the stream
 * with why. A cycle that throws is asked again, up to DesktopStreamOptions.maxCycleFailures in a row. */
export type DesktopStreamRelease = (signal: AbortSignal) => Promise<"ok" | "pending" | { readonly end: string }>;

export interface DesktopStreamOptions {
	/** Runs the relay into the machine: each piece of its stdout to `stdout` as it comes, `stdin` what to send the VNC
	 * server; resolves its exit code. Ends when `signal` aborts. */
	run(stdout: (chunk: Buffer) => void, stdin: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<number>;
	/** Changed areas kept for members whose cycles lag, in raw bytes; past it the oldest go and those members get the
	 * whole screen anew (64 MiB). */
	ringBytes?: number;
	/** At most one cycle a member this often (34 ms: at most 30 updates a second, the accepted design's bound), and
	 * none while nothing changed. Each cycle is one read-only SQL call for that member. */
	cycleEveryMs?: number;
	/** A cycle that held (`pending`) or failed is tried again after this (250 ms). */
	retryMs?: number;
	/** This many failed cycles in a row end the stream (3). */
	maxCycleFailures?: number;
	/** No stream lasts longer than this (8 h): the window asks for a new one. */
	maxMs?: number;
	/** Called once the relay is gone and every member's stream has ended. */
	ended?(): void;
	now?(): number;
}

interface StreamUpdate {
	readonly seq: number;
	readonly rects: readonly RfbRect[];
	readonly cursor: RfbCursor | null;
	readonly size: { readonly width: number; readonly height: number } | null;
	readonly bytes: number;
}
interface Watcher {
	sentSeq: number;
	wake: () => void;
}

/** What to send the VNC server: the handshake's answers and the three messages, in order, until it is closed. */
class Outbox {
	readonly #items: Buffer[] = [];
	#wake: () => void = () => {};
	#closed = false;
	push(message: Buffer): void {
		if (this.#closed) return;
		this.#items.push(message);
		this.#wake();
	}
	close(): void {
		this.#closed = true;
		this.#wake();
	}
	async *messages(): AsyncGenerator<Uint8Array> {
		for (;;) {
			const next = this.#items.shift();
			if (next) {
				yield next;
				continue;
			}
			if (this.#closed) return;
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
			});
			this.#wake = () => {};
		}
	}
}

/** Waits `ms`, or until `signal` aborts; leaves no timer behind either way. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			globalThis.clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = globalThis.setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Whether `outer` covers all of `inner`. */
function covers(outer: RfbRect, inner: RfbRect): boolean {
	return (
		outer.x <= inner.x &&
		outer.y <= inner.y &&
		outer.x + outer.width >= inner.x + inner.width &&
		outer.y + outer.height >= inner.y + inner.height
	);
}

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** At most 30 updates a second for a member (the accepted design, 05:15Z): a hover shows one cycle after it was drawn,
 * not up to one pace later (100 ms on the real machine's run 3). */
const STREAM_CYCLE_EVERY_MS = 34;

/**
 * One desktop's live picture for every member who watches it in the large view: ONE relay into the machine (started
 * with the first member, ended with the last, and ended with the VNC server's connection, so with the X server), one
 * reader, and the changed areas kept in order (a ring of at most ringBytes) for the members whose cycles have not let
 * them go yet.
 *
 * Each member's stream is gated by its own release cycles: what changed up to the moment a cycle BEGAN goes once that
 * cycle answered `ok`, and nothing that changed after. Cycles run only while something waits, back to back, at most one
 * every cycleEveryMs; the member's sink is waited for before the next (a slow browser holds its own cycles, nobody
 * else's). A member who joins is sent the screen's size and then the whole screen (asked of the server anew, so it
 * passes a cycle too); one whose changes fell out of the ring gets the whole screen anew the same way.
 */
export class DesktopStream {
	readonly #options: DesktopStreamOptions;
	readonly #watchers = new Set<Watcher>();
	readonly #ring: StreamUpdate[] = [];
	readonly #stop = new AbortController();
	readonly #outbox = new Outbox();
	readonly #png = new WeakMap<RfbRect | RfbCursor, Promise<Buffer>>();
	#ringBytes = 0;
	#seq = 0;
	#width = 0;
	#height = 0;
	#started = false;
	#ended: string | null = null;
	#relay: Promise<void> = Promise.resolve();
	constructor(options: DesktopStreamOptions) {
		this.#options = options;
	}
	/** Why it ended, or null while it lives. */
	get ended(): string | null {
		return this.#ended;
	}

	/** Streams the desktop to `sink`, released by `release`, until `signal` aborts, a cycle ends it, or the relay ends:
	 * answers why it ended (`closed` when the signal aborted). */
	async watch(release: DesktopStreamRelease, sink: DesktopStreamSink, signal: AbortSignal): Promise<string> {
		if (this.#ended) return this.#ended;
		const now = this.#options.now ?? Date.now;
		const watcher: Watcher = { sentSeq: this.#seq, wake: () => {} };
		this.#watchers.add(watcher);
		const done = AbortSignal.any([signal, this.#stop.signal]);
		const wakeOnEnd = () => watcher.wake();
		done.addEventListener("abort", wakeOnEnd, { once: true });
		const began = now();
		let failures = 0;
		let sizeSent = { width: 0, height: 0 };
		try {
			this.#start();
			// The whole screen for this member: asked anew, so it is a change after the member came, and passes a cycle.
			if (this.#width > 0) this.#outbox.push(rfbUpdateRequest(false, this.#width, this.#height));
			for (;;) {
				if (this.#ended) return this.#ended;
				if (signal.aborted) return "closed";
				if (now() - began > (this.#options.maxMs ?? 8 * 3600_000)) return "STREAM_TOO_LONG";
				if (this.#seq <= watcher.sentSeq) {
					await new Promise<void>((resolve) => {
						watcher.wake = resolve;
						if (done.aborted || this.#seq > watcher.sentSeq) resolve();
					});
					watcher.wake = () => {};
					continue;
				}
				// Everything up to here changed before this cycle begins.
				const upTo = this.#seq;
				const cycleBegan = now();
				let verdict: Awaited<ReturnType<DesktopStreamRelease>>;
				try {
					verdict = await release(done);
				} catch {
					if (done.aborted) continue;
					if (++failures >= (this.#options.maxCycleFailures ?? 3)) return "STREAM_UNAVAILABLE";
					await pause(this.#options.retryMs ?? 250, done);
					continue;
				}
				failures = 0;
				if (typeof verdict === "object") return verdict.end;
				if (verdict === "pending") {
					await pause(this.#options.retryMs ?? 250, done);
					continue;
				}
				if (done.aborted) continue;
				sizeSent = await this.#send(watcher, upTo, sink, sizeSent);
				watcher.sentSeq = Math.max(watcher.sentSeq, upTo);
				this.#trim();
				await pause(cycleBegan + (this.#options.cycleEveryMs ?? STREAM_CYCLE_EVERY_MS) - now(), done);
			}
		} catch {
			return this.#ended ?? "STREAM_UNAVAILABLE";
		} finally {
			done.removeEventListener("abort", wakeOnEnd);
			this.#watchers.delete(watcher);
			this.#trim();
			if (this.#watchers.size === 0) this.#end("idle");
		}
	}

	/** Starts the relay once. */
	#start(): void {
		if (this.#started) return;
		this.#started = true;
		const reader = new RfbReader((event) => {
			if (event.kind === "init") {
				this.#width = event.width;
				this.#height = event.height;
				// The members already here get the size from their first update; the screen is asked whole by the reader.
				this.#push({ rects: [], cursor: null, size: { width: event.width, height: event.height } });
				return;
			}
			if (event.size) {
				this.#width = event.size.width;
				this.#height = event.size.height;
				this.#outbox.push(rfbUpdateRequest(false, this.#width, this.#height));
			}
			this.#push(event);
			// Keep the changes coming: the next request at once.
			this.#outbox.push(rfbUpdateRequest(true, this.#width, this.#height));
		});
		this.#relay = this.#options
			.run(
				(chunk) => {
					for (const message of reader.feed(chunk)) this.#outbox.push(message);
				},
				this.#outbox.messages(),
				this.#stop.signal,
			)
			.then(
				(exitCode) => this.#end(DESKTOP_VIEW_EXITS[exitCode] ?? "DESKTOP_ENDED"),
				() => this.#end(this.#stop.signal.aborted ? (this.#ended ?? "idle") : "STREAM_UNAVAILABLE"),
			);
	}

	#push(update: {
		rects: readonly RfbRect[];
		cursor: RfbCursor | null;
		size: { width: number; height: number } | null;
	}): void {
		const bytes =
			update.rects.reduce((sum, rect) => sum + rect.pixels.byteLength, 0) + (update.cursor?.pixels.byteLength ?? 0);
		this.#ring.push({ seq: ++this.#seq, rects: update.rects, cursor: update.cursor, size: update.size, bytes });
		this.#ringBytes += bytes;
		// Over the ring's bound: the oldest go, and every member who had not been sent them gets the whole screen anew.
		let dropped = 0;
		while (this.#ringBytes > (this.#options.ringBytes ?? 64 * 1024 * 1024) && this.#ring.length > 1) {
			const old = this.#ring.shift() as StreamUpdate;
			this.#ringBytes -= old.bytes;
			dropped = old.seq;
		}
		if (dropped > 0) {
			let refresh = false;
			for (const watcher of this.#watchers)
				if (watcher.sentSeq < dropped) {
					watcher.sentSeq = dropped;
					refresh = true;
				}
			if (refresh && this.#width > 0) this.#outbox.push(rfbUpdateRequest(false, this.#width, this.#height));
		}
		for (const watcher of this.#watchers) watcher.wake();
	}

	/** Drops what every member was sent. */
	#trim(): void {
		const least = Math.min(...[...this.#watchers].map((watcher) => watcher.sentSeq), this.#seq);
		while (this.#ring.length > 0 && (this.#ring[0] as StreamUpdate).seq <= least) {
			const old = this.#ring.shift() as StreamUpdate;
			this.#ringBytes -= old.bytes;
		}
	}

	/** Sends a member what changed after its last cycle up to `upTo`: the size when it changed, the changed areas in
	 * order (one wholly covered by a later one is left out), the newest pointer shape. */
	async #send(
		watcher: Watcher,
		upTo: number,
		sink: DesktopStreamSink,
		sizeSent: { width: number; height: number },
	): Promise<{ width: number; height: number }> {
		const updates = this.#ring.filter((update) => update.seq > watcher.sentSeq && update.seq <= upTo);
		// A member who joined after the screen's size was told is told it first.
		let size = sizeSent.width === 0 && this.#width > 0 ? { width: this.#width, height: this.#height } : sizeSent;
		let rects: RfbRect[] = [];
		let cursor: RfbCursor | null = null;
		for (const update of updates) {
			if (update.size && (update.size.width !== size.width || update.size.height !== size.height)) {
				size = update.size;
				// What was drawn before a new size is gone with it.
				rects = [];
			}
			rects.push(...update.rects);
			if (update.cursor) cursor = update.cursor;
		}
		if (size !== sizeSent) {
			const message = Buffer.alloc(5);
			message[0] = STREAM_SIZE;
			message.writeUInt16BE(size.width, 1);
			message.writeUInt16BE(size.height, 3);
			await sink.send(message);
		}
		const kept = rects.filter((rect, index) => !rects.slice(index + 1).some((later) => covers(later, rect)));
		let batch: Buffer[] = [];
		let batchBytes = 0;
		let count = 0;
		const flush = async () => {
			if (count === 0) return;
			const head = Buffer.alloc(3);
			head[0] = STREAM_RECTS;
			head.writeUInt16BE(count, 1);
			await sink.send(Buffer.concat([head, ...batch]));
			batch = [];
			batchBytes = 0;
			count = 0;
		};
		for (const rect of kept) {
			const png = await this.#encoded(rect, () => encodePng(rect.width, rect.height, rect.pixels));
			const head = Buffer.alloc(12);
			head.writeUInt16BE(rect.x, 0);
			head.writeUInt16BE(rect.y, 2);
			head.writeUInt16BE(rect.width, 4);
			head.writeUInt16BE(rect.height, 6);
			head.writeUInt32BE(png.byteLength, 8);
			if (batchBytes + 12 + png.byteLength > MAX_MESSAGE_BYTES || count === 0xffff) await flush();
			batch.push(head, png);
			batchBytes += 12 + png.byteLength;
			count++;
		}
		await flush();
		if (cursor) {
			const shape = cursor;
			const stride = Math.ceil(shape.width / 8);
			const png =
				shape.width > 0 && shape.height > 0
					? await this.#encoded(shape, () =>
							encodePng(shape.width, shape.height, shape.pixels, (index) => {
								const x = index % shape.width;
								const y = Math.floor(index / shape.width);
								return ((shape.mask[y * stride + (x >> 3)] as number) >> (7 - (x & 7))) & 1 ? 255 : 0;
							}),
						)
					: Buffer.alloc(0);
			const head = Buffer.alloc(13);
			head[0] = STREAM_CURSOR;
			head.writeUInt16BE(shape.hotX, 1);
			head.writeUInt16BE(shape.hotY, 3);
			head.writeUInt16BE(shape.width, 5);
			head.writeUInt16BE(shape.height, 7);
			head.writeUInt32BE(png.byteLength, 9);
			await sink.send(Buffer.concat([head, png]));
		}
		return size;
	}

	/** One PNG per area or shape, however many members it goes to. */
	#encoded(key: RfbRect | RfbCursor, encode: () => Promise<Buffer>): Promise<Buffer> {
		let png = this.#png.get(key);
		if (!png) {
			png = encode();
			this.#png.set(key, png);
		}
		return png;
	}

	#end(reason: string): void {
		if (this.#ended) return;
		this.#ended = reason;
		this.#stop.abort();
		this.#outbox.close();
		this.#ring.length = 0;
		this.#ringBytes = 0;
		for (const watcher of this.#watchers) watcher.wake();
		void this.#relay.finally(() => this.#options.ended?.());
	}
}
