import { crc32, deflateSync } from "node:zlib";

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

/** What an emptied slot of a ByteQueue holds. */
const NO_BYTES = Buffer.alloc(0);
/** A piece smaller than this is copied into a block of this size shared with the small pieces around it. */
const COALESCE_BYTES = 4096;
/** Bytes that came in pieces, read off in order without copying more than is asked. Every operation is linear in what
 * it reads or takes, however small the pieces (the v245 release review). And the pieces are themselves bounded by the
 * bytes (review r11 of #1746): a piece under 4 KiB is copied into a 4 KiB block with the small pieces next to it, so a
 * server that sends one byte at a time makes one piece for every 4 KiB, not one for every byte — at most two pieces
 * for every 4 KiB held, and at most twice the bytes held in memory. */
class ByteQueue {
	readonly #chunks: Buffer[] = [];
	/** The first piece still held: taken pieces are let go at once (their slot emptied) and their slots dropped in bulk,
	 * never shifted one by one. */
	#head = 0;
	#length = 0;
	/** Where the last look ahead began: a walk of increasing offsets (an update's headers) goes on from there. */
	#mark = { offset: 0, index: 0, base: 0 };
	/** The block small pieces are being gathered into, and how much of it is filled. */
	#block: Buffer | null = null;
	#filled = 0;
	get length(): number {
		return this.#length;
	}
	/** How many pieces are held (read by the tests and nothing else). */
	get pieces(): number {
		return this.#chunks.length - this.#head;
	}
	push(chunk: Buffer): void {
		if (chunk.byteLength === 0) return;
		this.#length += chunk.byteLength;
		if (chunk.byteLength >= COALESCE_BYTES) {
			this.#chunks.push(chunk);
			this.#block = null;
			return;
		}
		// A small piece goes on the end of the last one when that is the block being gathered and has room for it.
		const block = this.#block;
		const last = this.#chunks.length - 1 >= this.#head ? this.#chunks[this.#chunks.length - 1] : undefined;
		if (
			block &&
			last &&
			last.buffer === block.buffer &&
			last.byteOffset + last.byteLength === block.byteOffset + this.#filled &&
			this.#filled + chunk.byteLength <= block.byteLength
		) {
			chunk.copy(block, this.#filled);
			this.#filled += chunk.byteLength;
			this.#chunks[this.#chunks.length - 1] = Buffer.from(
				last.buffer,
				last.byteOffset,
				last.byteLength + chunk.byteLength,
			);
			return;
		}
		const fresh = Buffer.allocUnsafeSlow(COALESCE_BYTES);
		chunk.copy(fresh, 0);
		this.#block = fresh;
		this.#filled = chunk.byteLength;
		this.#chunks.push(fresh.subarray(0, chunk.byteLength));
	}
	/** The first `size` bytes, without taking them. */
	peek(size: number): Buffer {
		return this.peekAt(0, size);
	}
	/** `size` bytes from `offset` on, without taking them: a view of one piece, or a copy of just those bytes when they
	 * span pieces (never of what comes before them: a large update read header by header costs no more than its size). */
	peekAt(offset: number, size: number): Buffer {
		if (offset < 0 || offset + size > this.#length) throw new Error("RFB_SHORT");
		let index = this.#head;
		let base = 0;
		if (offset >= this.#mark.offset && this.#mark.index >= this.#head) {
			index = this.#mark.index;
			base = this.#mark.base;
		}
		while (offset - base >= (this.#chunks[index] as Buffer).byteLength) {
			base += (this.#chunks[index] as Buffer).byteLength;
			index++;
		}
		this.#mark = { offset, index, base };
		const skip = offset - base;
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
		if (size === 0) return Buffer.alloc(0);
		const first = this.#chunks[this.#head];
		// A part of one piece is copied out (the piece is let go); one made of several pieces is a copy already.
		const out = first && first.byteLength >= size ? Buffer.from(first.subarray(0, size)) : this.peek(size);
		this.#drop(size);
		return out;
	}
	/** Drops the next `size` bytes without reading or copying them: only pieces are let go (the server's cut text, a
	 * colour map, a bell: of no use to a live picture). */
	skip(size: number): void {
		this.#drop(size);
	}
	/** Moves the next `size` bytes into `target` at `at`, piece by piece (so a large area is taken across several turns
	 * without ever copying it twice). */
	takeInto(target: Buffer, at: number, size: number): void {
		let left = size;
		let to = at;
		for (let i = this.#head; left > 0; i++) {
			const chunk = this.#chunks[i] as Buffer;
			const part = Math.min(chunk.byteLength, left);
			chunk.copy(target, to, 0, part);
			to += part;
			left -= part;
		}
		this.#drop(size);
	}
	#drop(size: number): void {
		let left = size;
		while (left > 0) {
			const first = this.#chunks[this.#head] as Buffer;
			if (first.byteLength <= left) {
				// The piece is let go now, not when its slot is dropped (review r11 of #1746).
				this.#chunks[this.#head] = NO_BYTES;
				this.#head++;
				left -= first.byteLength;
			} else {
				this.#chunks[this.#head] = first.subarray(left);
				left = 0;
			}
		}
		this.#length -= size;
		// Pieces left behind go in one splice once they are most of the array: each piece is moved at most once more.
		if (this.#head > 64 && this.#head * 2 > this.#chunks.length) {
			this.#chunks.splice(0, this.#head);
			this.#head = 0;
		}
		this.#mark = { offset: 0, index: this.#head, base: 0 };
	}
}

/** At most this many rectangles in one update: Xvnc sends a screen in bands (28 for 1600 x 1000), never thousands.
 * RFB allows 65,535, each of up to the whole screen, which is why a bound of our own is needed (review r1 F1 of #1746). */
const MAX_RECTS = 1024;
/** Besides the screen's own pixels, this much slack for an update's headers, its pointer shape and overlapping areas. */
const UPDATE_SLACK_BYTES = 1024 * 1024;

/** The largest screen a machine has (`desktop size`: 3840 x 2160), and so the largest area a server may send. A server
 * that says it is larger is ended (the v245 release review: the bounds are what CPU time is paid against). */
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
/** What the reader may do in one turn of the event loop, counted in bytes: a whole update of the largest screen (twice
 * its 33 MB) is read over many turns of about a millisecond each on node 2, never in one stretch that holds an
 * executor (the v245 release review). EVERY unit of the reader's work is charged against it (RFB_UNIT_COST plus its
 * bytes), and it is checked in one place, before each unit (review r10 of #1746). */
export const RFB_TAKE_PER_TURN = 1024 * 1024;
/** What one unit of the reader's work costs besides its bytes — a message, an area's header walked or taken, an update
 * handed on, a piece of bytes dropped: so a flood of tiny messages pauses the reading as surely as one large area does.
 * At most RFB_TAKE_PER_TURN / RFB_UNIT_COST (4,096) units a turn. */
export const RFB_UNIT_COST = 256;
/** The longest cut text (the desktop's clipboard) a server may send; it is dropped as it comes, never held. */
const MAX_CUT_TEXT = 16 * 1024 * 1024;

/**
 * Reads an RFB 3.8 server's bytes as they come (feed) and answers what the handshake asks, with nothing else: the
 * version, the security type None and the shared flag; then, once the server said what it is, this module's pixel
 * format, its encodings and a request for the whole screen. Every FramebufferUpdate becomes one `update` event; a
 * colour map, a bell and the server's cut text (the desktop's clipboard) are dropped without being read or copied.
 * Anything it does not know throws: the relay is ended.
 *
 * Its work is done ONE UNIT AT A TIME, each unit charged to the turn's budget (RFB_UNIT_COST plus its bytes), and the
 * budget is checked in exactly one place, the loop in drain() that runs the units (review r10 of #1746): however the
 * server's bytes come — one large area, a million empty updates, bells, cut text — one call of drain() does at most
 * about its budget's worth of work, and a stream drains again on the next turn while `busy`.
 */
export class RfbReader {
	readonly #queue = new ByteQueue();
	readonly #onEvent: (event: RfbEvent) => void;
	#stage: "version" | "security" | "result" | "init" | "messages" = "version";
	#width = 0;
	#height = 0;
	/** How far the sizes of an update's rectangles were walked while its bytes come: one header a unit. */
	#walk: { count: number; index: number; at: number } | null = null;
	/** An update whose bytes are all here, being taken out a unit at a time: what is taken so far, and the area that is
	 * part taken (its buffer and how much of it is filled). */
	#taking: {
		readonly count: number;
		index: number;
		/** Bytes of this update still in the queue. */
		left: number;
		readonly rects: RfbRect[];
		cursor: RfbCursor | null;
		size: { width: number; height: number } | null;
		width: number;
		height: number;
		part: { readonly head: Buffer; readonly pixels: Buffer; filled: number } | null;
	} | null = null;
	/** Bytes still to be dropped of a message this reader has no use for (cut text, a colour map). */
	#skipping = 0;
	/** What this call of drain() has done so far, and may do. */
	#taken = 0;
	#budgetLeft = Number.POSITIVE_INFINITY;
	/** Whether the last drain() stopped at its budget with work still to do. */
	#paused = false;
	constructor(onEvent: (event: RfbEvent) => void) {
		this.#onEvent = onEvent;
	}
	get width(): number {
		return this.#width;
	}
	get height(): number {
		return this.#height;
	}
	/**
	 * What one update of this screen may need at most: twice its own pixels (areas may overlap) and the slack above.
	 * The desktop's own account, and anything a page runs there, can drive that VNC server, so every byte from it is
	 * taken as hostile: an update that declares more than this, or bytes held past it, end the relay (review r1 F1).
	 */
	get #budget(): number {
		return 2 * 4 * Math.max(this.#width * this.#height, 1) + UPDATE_SLACK_BYTES;
	}

	/** Takes the server's next bytes and reads all of them at once; answers what to send it now (the handshake's answers
	 * only). The stream itself does not use it: it pushes, and drains a turn's budget at a time (`push`, `drain`). */
	feed(chunk: Buffer): Buffer[] {
		this.push(chunk);
		return this.drain(Number.POSITIVE_INFINITY);
	}
	/** Takes the server's next bytes, reading none of them yet. Nothing is held past what this screen's update may need,
	 * counting apart what is left of an update being taken out and what is to be dropped unread. */
	push(chunk: Buffer): void {
		this.#queue.push(chunk);
		const held = this.#queue.length - (this.#taking?.left ?? 0) - Math.min(this.#skipping, this.#queue.length);
		if (held > this.#budget) throw new Error("RFB_UPDATE_TOO_LARGE");
	}
	/** Reads what is here, ONE UNIT AT A TIME while this turn's `budget` lasts: answers what to send the server now. */
	drain(budget: number): Buffer[] {
		this.#taken = 0;
		this.#budgetLeft = budget;
		this.#paused = false;
		const out: Buffer[] = [];
		for (;;) {
			// THE one check of the budget: before every unit of work, whatever kind it is.
			if (this.#taken >= this.#budgetLeft) {
				// Paused with work it can go on with: bytes still here, or an update being taken out (all of whose bytes
				// are here, down to the last unit that hands it on).
				this.#paused = this.#queue.length > 0 || this.#taking !== null;
				return out;
			}
			const step = this.#step();
			if (step === null) return out;
			out.push(...step);
		}
	}
	/** Whether the last drain() stopped at its budget with work it can go on with: drain again on the next turn. */
	get busy(): boolean {
		return this.#paused;
	}
	/** What is queued and not read yet, in bytes and in pieces (read by the tests and nothing else). */
	get queued(): { readonly bytes: number; readonly pieces: number } {
		return { bytes: this.#queue.length, pieces: this.#queue.pieces };
	}
	/** What the last drain() was charged (read by the tests and nothing else). */
	get charged(): number {
		return this.#taken;
	}
	/** One unit of work if its bytes are there, charged: what to send for it; null when more bytes are needed. */
	#step(): Buffer[] | null {
		const queue = this.#queue;
		switch (this.#stage) {
			case "version": {
				if (queue.length < 12) return null;
				const version = queue.take(12).toString("latin1");
				this.#taken += RFB_UNIT_COST + 12;
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
				this.#taken += RFB_UNIT_COST + 1 + count;
				if (!types.includes(RFB_SECURITY_NONE)) throw new Error("RFB_SECURITY_REFUSED");
				this.#stage = "result";
				return [Buffer.from([RFB_SECURITY_NONE])];
			}
			case "result": {
				if (queue.length < 4) return null;
				this.#taken += RFB_UNIT_COST + 4;
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
				this.#taken += RFB_UNIT_COST + 24 + nameLength;
				this.#width = init.readUInt16BE(0);
				this.#height = init.readUInt16BE(2);
				if (this.#width < 1 || this.#height < 1 || this.#width > MAX_WIDTH || this.#height > MAX_HEIGHT)
					throw new Error("RFB_INVALID");
				this.#stage = "messages";
				this.#onEvent({ kind: "init", width: this.#width, height: this.#height });
				return [rfbSetPixelFormat(), rfbSetEncodings(), rfbUpdateRequest(false, this.#width, this.#height)];
			}
			case "messages":
				return this.#message();
		}
	}
	/** One unit of the messages: of an update under way, of bytes being dropped, or the start of the next message. */
	#message(): Buffer[] | null {
		const queue = this.#queue;
		// An update being walked or taken out goes on where it stopped (its type byte is not looked at again).
		if (this.#walk || this.#taking) return this.#update();
		// Bytes of a message of no use here: dropped as they come, a unit at a time, never copied.
		if (this.#skipping > 0) {
			if (queue.length === 0) return null;
			const now = Math.min(this.#skipping, queue.length, Math.max(1, this.#budgetLeft - this.#taken));
			queue.skip(now);
			this.#skipping -= now;
			this.#taken += RFB_UNIT_COST + now;
			return [];
		}
		if (queue.length < 1) return null;
		const type = queue.peek(1)[0] as number;
		if (type === 0) return this.#update();
		if (type === 1) {
			// A colour map: of no use to a picture in true colour. Its header is read, its entries dropped.
			if (queue.length < 6) return null;
			const count = queue.peek(6).readUInt16BE(4);
			queue.skip(6);
			this.#taken += RFB_UNIT_COST + 6;
			this.#skipping = 6 * count;
			return [];
		}
		if (type === 2) {
			// A bell.
			queue.skip(1);
			this.#taken += RFB_UNIT_COST + 1;
			return [];
		}
		if (type === 3) {
			// The server's cut text: the desktop's clipboard. Dropped as it comes, never kept, copied or passed on.
			if (queue.length < 8) return null;
			const length = queue.peek(8).readUInt32BE(4);
			if (length > MAX_CUT_TEXT) throw new Error("RFB_INVALID");
			queue.skip(8);
			this.#taken += RFB_UNIT_COST + 8;
			this.#skipping = length;
			return [];
		}
		throw new Error("RFB_UNKNOWN_MESSAGE");
	}
	/** One unit of a FramebufferUpdate: one header walked (nothing is taken until the whole update is there, so a half
	 * one never shows), then one header or one piece of an area's pixels taken out, then the update handed on. */
	#update(): Buffer[] | null {
		const queue = this.#queue;
		if (!this.#taking) {
			if (!this.#walk) {
				if (queue.length < 4) return null;
				const walk = { count: queue.peek(4).readUInt16BE(2), index: 0, at: 4 };
				if (walk.count > MAX_RECTS) throw new Error("RFB_UPDATE_TOO_LARGE");
				this.#walk = walk;
				this.#taken += RFB_UNIT_COST + 4;
				return [];
			}
			const walk = this.#walk;
			if (walk.index < walk.count) {
				if (queue.length < walk.at + 12) return null;
				const head = queue.peekAt(walk.at, 12);
				const w = head.readUInt16BE(4);
				const h = head.readUInt16BE(6);
				const encoding = head.readInt32BE(8);
				if (w > MAX_WIDTH || h > MAX_HEIGHT) throw new Error("RFB_INVALID");
				if (encoding === 0) walk.at += 12 + w * h * 4;
				else if (encoding === -239) walk.at += 12 + w * h * 4 + Math.ceil(w / 8) * h;
				else if (encoding === -223) walk.at += 12;
				else throw new Error("RFB_UNKNOWN_ENCODING");
				// The whole update's size is known as its headers are walked: refused before any more of it is buffered.
				if (walk.at > this.#budget) throw new Error("RFB_UPDATE_TOO_LARGE");
				walk.index++;
				this.#taken += RFB_UNIT_COST + 12;
				return [];
			}
			if (queue.length < walk.at) return null;
			this.#walk = null;
			queue.take(4);
			this.#taken += RFB_UNIT_COST + 4;
			this.#taking = {
				count: walk.count,
				index: 0,
				left: walk.at - 4,
				rects: [],
				cursor: null,
				size: null,
				// A size change in this update bounds its later areas.
				width: this.#width,
				height: this.#height,
				part: null,
			};
			return [];
		}
		const taking = this.#taking;
		if (taking.index < taking.count) {
			if (!taking.part) {
				const head = queue.take(12);
				taking.left -= 12;
				this.#taken += RFB_UNIT_COST + 12;
				const w = head.readUInt16BE(4);
				const h = head.readUInt16BE(6);
				const encoding = head.readInt32BE(8);
				if (encoding === -223) {
					taking.size = { width: w, height: h };
					this.#width = w;
					this.#height = h;
					taking.width = w;
					taking.height = h;
					if (w < 1 || h < 1) throw new Error("RFB_INVALID");
					// The areas of this update that came before the resize are of the screen that is gone: they are
					// dropped here, so one update — and so one ring entry — never holds pixels of two sizes (review r5 F3
					// of #1746). The server sends the whole screen of the new size right after, which this module asks for.
					taking.rects.length = 0;
					taking.index++;
					return [];
				}
				const bytes = w * h * 4 + (encoding === -239 ? Math.ceil(w / 8) * h : 0);
				taking.part = { head, pixels: Buffer.allocUnsafe(bytes), filled: 0 };
				return [];
			}
			// A piece of the area's bytes, as much as this turn's budget allows (at least one byte, so it always goes on).
			const part = taking.part;
			const now = Math.min(part.pixels.byteLength - part.filled, Math.max(1, this.#budgetLeft - this.#taken));
			queue.takeInto(part.pixels, part.filled, now);
			part.filled += now;
			taking.left -= now;
			this.#taken += now;
			if (part.filled < part.pixels.byteLength) return [];
			taking.part = null;
			taking.index++;
			const x = part.head.readUInt16BE(0);
			const y = part.head.readUInt16BE(2);
			const w = part.head.readUInt16BE(4);
			const h = part.head.readUInt16BE(6);
			if (part.head.readInt32BE(8) === -239) {
				taking.cursor = {
					hotX: x,
					hotY: y,
					width: w,
					height: h,
					pixels: part.pixels.subarray(0, w * h * 4),
					mask: part.pixels.subarray(w * h * 4),
				};
			} else if (w > 0 && h > 0 && x + w <= taking.width && y + h <= taking.height)
				taking.rects.push({ x, y, width: w, height: h, pixels: part.pixels });
			else if (w > 0 && h > 0) throw new Error("RFB_INVALID");
			return [];
		}
		this.#taking = null;
		this.#taken += RFB_UNIT_COST;
		this.#onEvent({ kind: "update", rects: taking.rects, cursor: taking.cursor, size: taking.size });
		return [];
	}
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_OVERHEAD = 12;
const PNG_IEND_CHUNK = (() => {
	const buf = Buffer.alloc(PNG_CHUNK_OVERHEAD);
	buf.write("IEND", 4, "latin1");
	buf.writeUInt32BE(crc32(buf.subarray(4, 8)), 8);
	return buf;
})();
// WHY: stay single-threaded under CPUQuota=100% (avoiding libuv CFS throttling) while yielding before level-3 deflateSync (~0.1-1.9 ms up to MAX_AREA_PIXELS).
const PNG_DEFLATE_LEVEL = 3;

function writeChunk(target: Buffer, offset: number, type: string, data: Buffer): number {
	target.writeUInt32BE(data.byteLength, offset);
	target.write(type, offset + 4, "latin1");
	data.copy(target, offset + 8);
	target.writeUInt32BE(crc32(data, crc32(target.subarray(offset + 4, offset + 8))), offset + 8 + data.byteLength);
	return offset + PNG_CHUNK_OVERHEAD + data.byteLength;
}
/** At most this many pixels are filtered in one turn of the event loop (about a millisecond on node 2): a whole screen of
 * the largest desktop held it for 64 ms in one stretch before (the v245 release review). An area is at most four such
 * slices now (MAX_AREA_PIXELS), the pointer at most one. */
export const PNG_PIXELS_PER_TURN = 65_536;
export async function encodePng(
	width: number,
	height: number,
	pixels: Buffer,
	alpha?: (index: number) => number,
): Promise<Buffer> {
	const channels = alpha ? 4 : 3;
	const stride = width * channels;
	const raw = Buffer.allocUnsafe((stride + 1) * height);
	const rowsPerTurn = Math.max(1, Math.floor(PNG_PIXELS_PER_TURN / Math.max(width, 1)));
	if (!alpha) {
		for (let y = 0; y < height; y++) {
			if (y > 0 && y % rowsPerTurn === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			const rowOut = y * (stride + 1);
			raw[rowOut] = 1;
			let inOff = y * width * 4;
			let outOff = rowOut + 1;
			let prevR = 0;
			let prevG = 0;
			let prevB = 0;
			for (let x = 0; x < width; x++) {
				const b = pixels[inOff] as number;
				const g = pixels[inOff + 1] as number;
				const r = pixels[inOff + 2] as number;
				raw[outOff] = (r - prevR) & 0xff;
				raw[outOff + 1] = (g - prevG) & 0xff;
				raw[outOff + 2] = (b - prevB) & 0xff;
				prevR = r;
				prevG = g;
				prevB = b;
				inOff += 4;
				outOff += 3;
			}
		}
	} else {
		for (let y = 0; y < height; y++) {
			if (y > 0 && y % rowsPerTurn === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			const rowOut = y * (stride + 1);
			raw[rowOut] = 1;
			let inOff = y * width * 4;
			let outOff = rowOut + 1;
			let prevR = 0;
			let prevG = 0;
			let prevB = 0;
			let prevA = 0;
			const rowPixelStart = y * width;
			for (let x = 0; x < width; x++) {
				const b = pixels[inOff] as number;
				const g = pixels[inOff + 1] as number;
				const r = pixels[inOff + 2] as number;
				const a = alpha(rowPixelStart + x);
				raw[outOff] = (r - prevR) & 0xff;
				raw[outOff + 1] = (g - prevG) & 0xff;
				raw[outOff + 2] = (b - prevB) & 0xff;
				raw[outOff + 3] = (a - prevA) & 0xff;
				prevR = r;
				prevG = g;
				prevB = b;
				prevA = a;
				inOff += 4;
				outOff += 4;
			}
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const compressed = deflateSync(raw, { level: PNG_DEFLATE_LEVEL });
	const out = Buffer.allocUnsafe(
		PNG_SIGNATURE.byteLength +
			PNG_CHUNK_OVERHEAD +
			ihdr.byteLength +
			PNG_CHUNK_OVERHEAD +
			compressed.byteLength +
			PNG_IEND_CHUNK.byteLength,
	);
	PNG_SIGNATURE.copy(out, 0);
	let at = PNG_SIGNATURE.byteLength;
	at = writeChunk(out, at, "IHDR", ihdr);
	at = writeChunk(out, at, "IDAT", compressed);
	PNG_IEND_CHUNK.copy(out, at);
	return out;
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
	/** How many updates the ring keeps at most, whatever they weigh (4096): an update of no areas at all costs no bytes
	 * but one entry, and a member whose cycles lag must not let a guest pile up entries (review r2 F1 of #1746). */
	ringEntries?: number;
	/** How many areas the ring keeps at most across all its updates (2048): a tiny area weighs almost nothing, and what a
	 * lagging member is sent at once is walked area by area (the v245 release review). Past it, the oldest updates go
	 * and those members get the whole screen anew, as for the other two bounds. */
	ringRects?: number;
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
	/** The size this update's own pixels belong to: carried on the entry, so nothing in the ring can be paired with a
	 * size that is not its own, whatever is evicted (review r4 F2 of #1746). */
	readonly at: { readonly width: number; readonly height: number };
	/** Whether this update is itself where the size changed. */
	readonly resized: boolean;
	readonly bytes: number;
}

/**
 * The updates kept for members whose cycles lag, oldest first, with what they hold in total. Every operation is O(1),
 * or amortised O(1) per update, at any size up to its caps (review r10 of #1746): the oldest goes by moving a head index
 * (the array is compacted in one splice only once most of it is gone), and the newest size change in it is kept as
 * state rather than searched for. Seqs in it are consecutive, so a member's window is found by arithmetic.
 */
class UpdateRing {
	/** Entries before the head are let go (undefined) as they are taken, so nothing evicted is held until the splice. */
	#entries: (StreamUpdate | undefined)[] = [];
	#head = 0;
	bytes = 0;
	rects = 0;
	/** The seq of the newest update that changed the size, ever (still in the ring while it is past the oldest's). */
	#newestResize = 0;
	get length(): number {
		return this.#entries.length - this.#head;
	}
	push(update: StreamUpdate): void {
		this.#entries.push(update);
		this.bytes += update.bytes;
		this.rects += update.rects.length;
		if (update.resized) this.#newestResize = update.seq;
	}
	/** The oldest update, or undefined. */
	get oldest(): StreamUpdate | undefined {
		return this.#entries[this.#head];
	}
	/** Lets the oldest go; answers it. */
	shift(): StreamUpdate | undefined {
		const old = this.#entries[this.#head];
		if (!old) return undefined;
		// Let go at once: an entry left in the array until the splice kept its pixels alive with it — up to 1024 whole
		// screens, gigabytes under full-screen noise on the real machine (review r11 of #1746).
		this.#entries[this.#head] = undefined;
		this.#head++;
		this.bytes -= old.bytes;
		this.rects -= old.rects.length;
		if (this.#head > 1024 && this.#head * 2 > this.#entries.length) {
			this.#entries.splice(0, this.#head);
			this.#head = 0;
		}
		return old;
	}
	/** The seq of the newest size change still in the ring, or 0. */
	get newestResize(): number {
		const oldest = this.oldest;
		return oldest && this.#newestResize >= oldest.seq ? this.#newestResize : 0;
	}
	/** The updates after seq `after` up to `upTo`, in order: found by their seqs, which follow one another. */
	window(after: number, upTo: number): StreamUpdate[] {
		const oldest = this.oldest;
		if (!oldest) return [];
		const from = this.#head + Math.max(0, after + 1 - oldest.seq);
		const to = this.#head + Math.max(0, upTo + 1 - oldest.seq);
		return this.#entries.slice(from, Math.min(to, this.#entries.length)) as StreamUpdate[];
	}
	clear(): void {
		this.#entries = [];
		this.#head = 0;
		this.bytes = 0;
		this.rects = 0;
	}
}
interface Watcher {
	sentSeq: number;
	wake: () => void;
	/** The size this member was last told. Zero width means "tell it the screen's size before any pixels": that is how a
	 * member who joined is served, and how one whose updates were evicted is served again, since the eviction may have
	 * thrown away the very update that carried a new size (review r3 F2 of #1746). */
	sizeSent: { width: number; height: number };
	evictionRefresh: "clean" | "requested" | "stale";
}

/**
 * What to send the VNC server, in order, until it is closed: the handshake's answers (a handful, once, in the order
 * they came), then update requests — of which only the newest of each kind can matter: the whole-screen request (a
 * member may be waiting for exactly that picture) and the incremental one. A request replaces the waiting one of its
 * kind, so a guest that stops reading its socket holds at most the handshake's answers and two requests, and every push
 * is O(1) however many come (review r2 F1, and r10 of #1746: no search or splice over waiting items per push).
 */
class Outbox {
	/** The handshake's answers and anything else that is not an update request (six at most, once). */
	readonly #other: Buffer[] = [];
	#whole: Buffer | null = null;
	#incremental: Buffer | null = null;
	#wake: () => void = () => {};
	#closed = false;
	get waiting(): number {
		return this.#other.length + (this.#whole ? 1 : 0) + (this.#incremental ? 1 : 0);
	}
	push(message: Buffer): void {
		if (this.#closed) return;
		// FramebufferUpdateRequest: type 3, incremental flag, then x, y, width, height.
		if (message.length === 10 && message[0] === 3) {
			if (message[1] === 1) this.#incremental = message;
			else this.#whole = message;
		} else this.#other.push(message);
		this.#wake();
	}
	close(): void {
		this.#closed = true;
		this.#wake();
	}
	async *messages(): AsyncGenerator<Uint8Array> {
		for (;;) {
			const next = this.#other.shift() ?? this.#whole ?? this.#incremental;
			if (next) {
				if (next === this.#whole) this.#whole = null;
				else if (next === this.#incremental) this.#incremental = null;
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

/** Thrown when a stream was cancelled while a message was on its way to a member's sink (review r1 F3 of #1746). */
const STREAM_CANCELLED = "STREAM_CANCELLED";

/** Sends one message, and gives up the moment `signal` aborts: a browser that stops reading but keeps answering pings
 * can hold a sink's send for as long as it likes, and must hold neither this watcher nor the relay (review r1 F3). The
 * message may still be on the socket; nothing after it is sent. */
async function sendOrStop(sink: DesktopStreamSink, message: Buffer, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw new Error(STREAM_CANCELLED);
	let give: () => void = () => {};
	const stopped = new Promise<never>((_, reject) => {
		give = () => reject(new Error(STREAM_CANCELLED));
		signal.addEventListener("abort", give, { once: true });
	});
	// The rejection is handled by the race below; nothing is left unhandled when the send wins.
	stopped.catch(() => {});
	try {
		await Promise.race([sink.send(message), stopped]);
	} finally {
		signal.removeEventListener("abort", give);
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

/** How many of the largest later areas an area is checked against for being covered. */
const VISIBLE_CANDIDATES = 8;
/**
 * The areas worth sending, in their order: one wholly covered by a LATER one is left out, since it would only be
 * painted over. In ONE pass from the newest back, each area checked against the same spot seen later and against the
 * few largest later areas only — linear in the number of areas (the v245 release review: the old pairwise check copied
 * and scanned the rest of the list for every area, 49 ms for 4,096 tiny areas on node 2 and minutes for a hundred
 * updates of 1,024). A covered area the check does not catch is sent and painted over; nothing visible is ever left out.
 */
export function visibleRects(rects: readonly RfbRect[]): RfbRect[] {
	const keep: boolean[] = new Array(rects.length);
	const spots = new Set<string>();
	const largest: RfbRect[] = [];
	for (let index = rects.length - 1; index >= 0; index--) {
		const rect = rects[index] as RfbRect;
		const spot = `${rect.x},${rect.y},${rect.width},${rect.height}`;
		const hidden = spots.has(spot) || largest.some((later) => covers(later, rect));
		keep[index] = !hidden;
		// A hidden area covers nothing its own cover does not: only kept ones are remembered.
		if (hidden) continue;
		spots.add(spot);
		const area = rect.width * rect.height;
		if (largest.length < VISIBLE_CANDIDATES) largest.push(rect);
		else {
			let smallest = 0;
			for (let i = 1; i < largest.length; i++)
				if (
					(largest[i] as RfbRect).width * (largest[i] as RfbRect).height <
					(largest[smallest] as RfbRect).width * (largest[smallest] as RfbRect).height
				)
					smallest = i;
			if (area > (largest[smallest] as RfbRect).width * (largest[smallest] as RfbRect).height)
				largest[smallest] = rect;
		}
	}
	return rects.filter((_, index) => keep[index]);
}

/** A batch of areas goes out once it passes this many bytes (the browser and the peer take up to 8 MiB a message; a
 * smaller batch keeps every join of one message near a millisecond, the v245 release review). */
export const DESKTOP_STREAM_BATCH_BYTES = 1024 * 1024;
const BATCH_BYTES = DESKTOP_STREAM_BATCH_BYTES;
/** At most this many pixels in one area as it is kept and sent (768 KiB of RGB): a larger area is kept as bands of
 * whole rows, without copying, so no PNG is more than about that to encode in one call or to join into a message
 * (the v245 release review). Xvnc's own bands are smaller (1600 x 36). */
const MAX_AREA_PIXELS = 262_144;
/** The browser shows a pointer shape of at most this many pixels a side; a larger one is not sent at all. */
const MAX_CURSOR_SIDE = 128;
/** `rect` as bands of whole rows of at most MAX_AREA_PIXELS each, its pixels shared, never copied. */
function bands(rect: RfbRect): RfbRect[] {
	const rows = Math.max(1, Math.floor(MAX_AREA_PIXELS / Math.max(rect.width, 1)));
	if (rect.height <= rows) return [rect];
	const out: RfbRect[] = [];
	for (let y = 0; y < rect.height; y += rows) {
		const height = Math.min(rows, rect.height - y);
		out.push({
			x: rect.x,
			y: rect.y + y,
			width: rect.width,
			height,
			pixels: rect.pixels.subarray(y * rect.width * 4, (y + height) * rect.width * 4),
		});
	}
	return out;
}
/** How many updates the ring keeps at most (review r2 F1 of #1746): an empty update weighs nothing and still costs an
 * entry, so bytes alone bound nothing. At 30 updates a second this is over two minutes of a lagging member's cycles. */
const MAX_RING_ENTRIES = 4096;
/** How many areas the ring holds at most across its updates (the v245 release review): what one member is sent at once
 * is at most this many areas, walked in one pass (about a millisecond on node 2). A whole screen is 28 to 32 bands, so
 * this is some 64 whole screens. */
const MAX_RING_RECTS = 2048;
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
	readonly #ring = new UpdateRing();
	readonly #stop = new AbortController();
	readonly #outbox = new Outbox();
	readonly #png = new WeakMap<RfbRect | RfbCursor, Promise<Buffer>>();
	#seq = 0;
	#width = 0;
	#height = 0;
	#started = false;
	/** Whether the next request asks for the whole screen (a size change, or members moved on past an eviction). The
	 * server is asked ONE thing for every update it sent: never a request of its own beside the next one, so however long
	 * members lag behind a screen that changes all the time, no more than one answer is ever on its way (before, every
	 * eviction made a request of its own and every request an update: full-screen noise on the real machine piled up
	 * updates past the reader's bound within seconds, review r11 of #1746). */
	#wantWhole = false;
	#wholeInFlight = false;
	#ended: string | null = null;
	#relay: Promise<void> = Promise.resolve();
	constructor(options: DesktopStreamOptions) {
		this.#options = options;
	}
	/** Why it ended, or null while it lives. */
	get ended(): string | null {
		return this.#ended;
	}

	/** What the stream holds right now, in entries: the ring's updates and the messages waiting for the VNC server.
	 * Both are bounded whatever the guest sends (review r2 F1 of #1746); read by the tests and by nothing else. */
	get held(): { readonly ring: number; readonly rects: number; readonly outbox: number } {
		return { ring: this.#ring.length, rects: this.#ring.rects, outbox: this.#outbox.waiting };
	}

	#requestWhole(): void {
		// WHY: Coalesce concurrent whole-screen requests so join storms cannot stack full frames past RFB_UPDATE_TOO_LARGE.
		if (this.#width <= 0 || this.#wholeInFlight) return;
		this.#wholeInFlight = true;
		this.#outbox.push(rfbUpdateRequest(false, this.#width, this.#height));
	}

	/** Streams the desktop to `sink`, released by `release`, until `signal` aborts, a cycle ends it, or the relay ends:
	 * answers why it ended (`closed` when the signal aborted). */
	async watch(release: DesktopStreamRelease, sink: DesktopStreamSink, signal: AbortSignal): Promise<string> {
		if (this.#ended) return this.#ended;
		const now = this.#options.now ?? Date.now;
		const watcher: Watcher = {
			sentSeq: this.#seq,
			wake: () => {},
			sizeSent: { width: 0, height: 0 },
			evictionRefresh: "clean",
		};
		this.#watchers.add(watcher);
		const done = AbortSignal.any([signal, this.#stop.signal]);
		const wakeOnEnd = () => watcher.wake();
		done.addEventListener("abort", wakeOnEnd, { once: true });
		const began = now();
		let failures = 0;
		try {
			this.#start();
			// The whole screen for this member: asked anew, so it is a change after the member came, and passes a cycle.
			this.#requestWhole();
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
				const sent = await this.#send(watcher, upTo, sink, done);
				watcher.sentSeq = Math.max(watcher.sentSeq, upTo);
				if (watcher.evictionRefresh === "stale") {
					watcher.evictionRefresh = "requested";
					this.#requestWhole();
				} else if (sent && watcher.evictionRefresh === "requested") {
					watcher.evictionRefresh = "clean";
				}
				this.#trim();
				await pause(cycleBegan + (this.#options.cycleEveryMs ?? STREAM_CYCLE_EVERY_MS) - now(), done);
			}
		} catch (error) {
			// Cancelled while a message was on its way: the member closed it, or the executor is stopping.
			if (error instanceof Error && error.message === STREAM_CANCELLED)
				return this.#ended ?? (signal.aborted ? "closed" : "stopping");
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
				this.#wholeInFlight = true;
				// The members already here get the size from their first update; the screen is asked whole by the reader.
				this.#push({ rects: [], cursor: null, size: { width: event.width, height: event.height } });
				return;
			}
			if (event.size) {
				this.#width = event.size.width;
				this.#height = event.size.height;
				this.#wantWhole = true;
			}
			// An update with no areas, no pointer shape and no size changes nothing a member sees: it is not kept (review
			// r10 of #1746), and only asks for the next one.
			if (event.rects.length > 0 || event.cursor || event.size) this.#push(event);
			// Keep the changes coming: ONE request for this update, at once — the whole screen when members need it anew,
			// what changed otherwise (it replaces any of its kind still waiting: O(1)).
			if (this.#wantWhole) {
				this.#wantWhole = false;
				this.#wholeInFlight = true;
				this.#outbox.push(rfbUpdateRequest(false, this.#width, this.#height));
			} else {
				this.#wholeInFlight = false;
				this.#outbox.push(rfbUpdateRequest(true, this.#width, this.#height));
			}
		});
		// What the server sends is taken in as it comes (bounded at once), and read in turns of at most about
		// RFB_TAKE_PER_TURN bytes of charged work — every message, header and piece counted (review r10 of #1746) — each
		// followed by a turn of everything else the executor does (the v245 release review).
		let reading = false;
		const read = () => {
			reading = false;
			if (this.#ended) return;
			try {
				for (const message of reader.drain(RFB_TAKE_PER_TURN)) this.#outbox.push(message);
			} catch {
				// What the server sent is not the protocol, or past its bounds: as a refusal in the relay's own handler.
				this.#end("STREAM_UNAVAILABLE");
				return;
			}
			if (reader.busy) readSoon();
		};
		const readSoon = () => {
			if (reading) return;
			reading = true;
			setImmediate(read);
		};
		this.#relay = this.#options
			.run(
				(chunk) => {
					reader.push(chunk);
					readSoon();
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
		// Kept as bands of at most MAX_AREA_PIXELS: every member's PNG of a band is the same one (#encoded).
		const rects = update.rects.flatMap(bands);
		const bytes =
			rects.reduce((sum, rect) => sum + rect.pixels.byteLength, 0) + (update.cursor?.pixels.byteLength ?? 0);
		const ring = this.#ring;
		ring.push({
			seq: ++this.#seq,
			rects,
			cursor: update.cursor,
			// The screen's size as it stands for these pixels (the caller set it before pushing).
			at: { width: this.#width, height: this.#height },
			resized: update.size !== null,
			bytes,
		});
		// Over the ring's bound, in bytes, in entries or in areas: the oldest go (each once, in O(1)), and every member who
		// had not been sent them gets the whole screen anew.
		let dropped = 0;
		while (
			ring.length > 1 &&
			(ring.bytes > (this.#options.ringBytes ?? 64 * 1024 * 1024) ||
				ring.length > (this.#options.ringEntries ?? MAX_RING_ENTRIES) ||
				ring.rects > (this.#options.ringRects ?? MAX_RING_RECTS))
		)
			dropped = (ring.shift() as StreamUpdate).seq;
		if (dropped > 0) {
			// What is left of the ring begins at the newest size change in it, if any: pixels from before that change
			// belong to a size this member was never told and are of no use now, since the whole screen is coming anyway
			// (review r4 F2 of #1746). The newest change is the ring's own state, never searched for (r10).
			const newestResize = ring.newestResize;
			const from = Math.max(dropped, newestResize > 0 ? newestResize - 1 : 0);
			let refresh = false;
			for (const watcher of this.#watchers)
				if (watcher.sentSeq < from) {
					watcher.sentSeq = from;
					// The size is told again from the first entry this member is sent, whatever the eviction left: the
					// entry carries its own size, so the two can never disagree.
					watcher.sizeSent = { width: 0, height: 0 };
					// WHY: Request one whole screen on first eviction, then defer further refreshes until the lagging watcher catches up.
					if (watcher.evictionRefresh === "clean") {
						watcher.evictionRefresh = "requested";
						refresh = true;
					} else {
						watcher.evictionRefresh = "stale";
					}
				}
			// The whole screen is asked with the next request, never beside it.
			if (refresh) this.#wantWhole = true;
		}
		for (const watcher of this.#watchers) watcher.wake();
	}

	/** Drops what every member was sent. */
	#trim(): void {
		let least = this.#seq;
		for (const watcher of this.#watchers) least = Math.min(least, watcher.sentSeq);
		while ((this.#ring.oldest?.seq ?? Number.POSITIVE_INFINITY) <= least) this.#ring.shift();
	}

	/**
	 * Sends a member what changed after its last cycle up to `upTo`: the size whenever it is not the one that member
	 * already has, then the changed areas in order (one wholly covered by a later one is left out), then the newest
	 * pointer shape. Every area goes under the size it belongs to, which each entry carries (`at`), so nothing an
	 * eviction leaves behind can be paired with another size: the first entry of the window decides the size told, and a
	 * later entry of another size clears what came before it (review r4 F2 of #1746).
	 */
	async #send(watcher: Watcher, upTo: number, sink: DesktopStreamSink, signal: AbortSignal): Promise<boolean> {
		const sizeSent = watcher.sizeSent;
		const updates = this.#ring.window(watcher.sentSeq, upTo);
		// WHY: Skip sending a blank post-upTo STREAM_SIZE when eviction emptied the pre-cycle window during release().
		if (updates.length === 0) return false;
		// The size these pixels are of: the first entry's own, which is what a member who joined, or one whose updates
		// were evicted, is told before any of them.
		let size = sizeSent.width === 0 ? (updates[0]?.at ?? { width: this.#width, height: this.#height }) : sizeSent;
		let rects: RfbRect[] = [];
		let cursor: RfbCursor | null = null;
		for (const update of updates) {
			if (update.at.width !== size.width || update.at.height !== size.height) {
				size = update.at;
				// What was drawn before a new size is gone with it.
				rects = [];
			}
			rects.push(...update.rects);
			if (update.cursor) cursor = update.cursor;
		}
		if (size !== sizeSent) {
			watcher.sizeSent = size;
			const message = Buffer.alloc(5);
			message[0] = STREAM_SIZE;
			message.writeUInt16BE(size.width, 1);
			message.writeUInt16BE(size.height, 3);
			await sendOrStop(sink, message, signal);
		}
		const kept = visibleRects(rects);
		let batch: Buffer[] = [];
		let batchBytes = 0;
		let count = 0;
		const flush = async () => {
			if (count === 0) return;
			const head = Buffer.alloc(3);
			head[0] = STREAM_RECTS;
			head.writeUInt16BE(count, 1);
			await sendOrStop(sink, Buffer.concat([head, ...batch]), signal);
			batch = [];
			batchBytes = 0;
			count = 0;
		};
		for (const rect of kept) {
			// Cancelled between batches: nothing more is encoded or sent.
			if (signal.aborted) throw new Error(STREAM_CANCELLED);
			const png = await this.#encoded(rect, () => encodePng(rect.width, rect.height, rect.pixels));
			const head = Buffer.alloc(12);
			head.writeUInt16BE(rect.x, 0);
			head.writeUInt16BE(rect.y, 2);
			head.writeUInt16BE(rect.width, 4);
			head.writeUInt16BE(rect.height, 6);
			head.writeUInt32BE(png.byteLength, 8);
			if (batchBytes + 12 + png.byteLength > BATCH_BYTES || count === 0xffff) await flush();
			batch.push(head, png);
			batchBytes += 12 + png.byteLength;
			count++;
		}
		await flush();
		if (signal.aborted) throw new Error(STREAM_CANCELLED);
		// A pointer shape larger than the browser shows is not sent at all (the member keeps the last one).
		if (cursor && cursor.width <= MAX_CURSOR_SIDE && cursor.height <= MAX_CURSOR_SIDE) {
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
			await sendOrStop(sink, Buffer.concat([head, png]), signal);
		}
		return true;
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
		this.#ring.clear();
		for (const watcher of this.#watchers) watcher.wake();
		void this.#relay.finally(() => this.#options.ended?.());
	}
}
