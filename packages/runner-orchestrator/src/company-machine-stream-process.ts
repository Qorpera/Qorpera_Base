import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Worker } from "node:worker_threads";
import {
	DesktopStream,
	type DesktopStreamOptions,
	type DesktopStreamRelease,
	type DesktopStreamSink,
} from "./company-machine-stream.ts";

// A desktop's live picture, watched in a PROCESS of its own (20260930745000; the lead's decision after review r11 of
// #1746). The executor's safety must not depend on the stream code being right: the kernel holds the line. Each watched
// desktop is one instance of `qorpera-desktop-stream@.service`, which systemd starts for each connection to
// `qorpera-desktop-stream.socket` (deploy/coding-worker/), in a slice and a cgroup of its own with its own memory, CPU and
// task limits, as an account of its own that holds LXD's socket and nothing else: no network, no credential, no
// config. It runs the executor's own program file with DESKTOP_STREAM_ROLE, opens the machine's relay itself, and does
// everything that touches the guest's bytes (the reader, the ring, the dedup, the PNGs). A crash, a leak or a spin in it
// is that instance's, never the executor's.
//
// The executor's side (InstanceDesktop) speaks with it over that one connection in frames: a 9-byte header (u32 payload
// length, u8 type, u32 member), then the payload. Main parses a header in constant time and never scans a payload: of a
// stream message (SEND, at most DESKTOP_STREAM_MESSAGE_BYTES) it reads the first byte, the kind; every other payload is
// at most CONTROL_BYTES.
//
// THE INVARIANT (the lead's, review r12 of #1746): WHATEVER AN INSTANCE SENDS, MAIN SPENDS AT MOST A FIXED BUDGET OF
// WORK ON ITS CONNECTION PER TURN AND PER SECOND, AND HOLDS AT MOST A FIXED NUMBER OF BYTES AND OF OBJECTS FOR IT.
// - Every unit of main's work for a connection is charged in ONE place (InstanceDesktop's #charge): a read (one piece
//   taken from the socket; its bytes too, each copied once into its block), a frame taken, a piece handed to a sink.
// - Budgets: per turn of main's loop, across everything main does for the connection in that turn (TURN_UNITS,
//   TURN_BYTES), and per second (SECOND_UNITS, SECOND_BYTES), checked before every unit. When one is spent main stops
//   reading the connection (the socket paused: nothing is read ahead) until the next turn or the next second; the time
//   counts as main not reading, for the pong. Nothing is ended for it: the instance's frames wait in the kernel.
// - A read that brought little (under DRIP_BYTES) and completed no frame is not followed by another read at once: the
//   next waits DRIP_MS, and the kernel's buffer gathers what was written meanwhile, so a byte-a-read drip costs main at
//   most 1000 / DRIP_MS reads a second.
// - Held: what was read is copied into blocks of DESKTOP_STREAM_BLOCK_BYTES (FrameQueue): at most the frame being
//   completed and one read, 35 blocks; a frame of n bytes is at most ceil(n / DESKTOP_STREAM_BLOCK_BYTES) + 1 pieces, so
//   a message handed to a sink is at most DESKTOP_STREAM_MESSAGE_PIECES (34).
// Every frame main reads belongs to a step main asked for or allowed, or it ends the instance; what main has written
// that the instance has not read is bounded too (MAX_UNREAD_BYTES). The instance is ended only for what a correct one
// never does; everything else a correct one could do is a delay.
//
// What main holds for its instances at the worst: each member's sink one message it was handed (8 desktops x 8 members
// x DESKTOP_STREAM_MESSAGE_BYTES = 128 MiB, the listener's to send), each connection its read buffer and at most 35
// blocks (8 x 36 x 64 KiB, 18 MiB), and what waits to be written to an instance that does not read (8 x
// MAX_UNREAD_BYTES, 8 MiB): about 154 MiB, in the executor's 2 GiB.
//
//   main -> instance  HELLO {protocol, version, spec}   first, once: a program of another version is refused
//                     WATCH m, UNWATCH m
//                     VERDICT m (u8: 0 ok, 1 pending, 2 error, 3 end + its reason)   m's release check, decided by MAIN
//                     SENT m (u8 failed)                m's sink took the message (back-pressure)
//                     PING
//   instance -> main  READY                             the hello was taken
//                     RELEASE m                         m's cycle begins: decide
//                     SEND m <message>                  after an ok, one message for m's sink
//                     DONE m <reason>                   m's watch ended
//                     ENDED <reason>\n<why>             the relay ended: every member with reason
//                     PONG

/** The executor's program file run with this as its first argument is a desktop's stream instance, and nothing else. */
export const DESKTOP_STREAM_ROLE = "--qorpera-desktop-stream";
/** The frames' protocol; with the program's own version (its file's sha-256) in HELLO. */
export const DESKTOP_STREAM_PROTOCOL = 1;

export const DESKTOP_STREAM_FRAME = Object.freeze({
	hello: 1,
	watch: 2,
	unwatch: 3,
	verdict: 4,
	sent: 5,
	ping: 6,
	ready: 16,
	release: 17,
	send: 18,
	done: 19,
	ended: 20,
	pong: 21,
});
const F = DESKTOP_STREAM_FRAME;
export const DESKTOP_STREAM_HEADER_BYTES = 9;
/** The largest stream message an instance may send: a batch goes out at 1 MiB, a band's PNG is under 800 KB, a pointer
 * shape's under 70 KB. */
export const DESKTOP_STREAM_MESSAGE_BYTES = 2 * 1024 * 1024 + 1024;
/** The largest of every other payload: a reason and the operator's few words of why. */
const CONTROL_BYTES = 256;
/** The largest frame main sends (HELLO with the relay's spec), and how soon an instance must have it. */
const HELLO_BYTES = 64 * 1024;
const HELLO_WITHIN_MS = 10_000;
/** Bytes read off a connection are copied into blocks of this size (one read is at most this). */
export const DESKTOP_STREAM_BLOCK_BYTES = 64 * 1024;
/** The most pieces a message handed to a sink has: ceil(DESKTOP_STREAM_MESSAGE_BYTES / block) + 1 = 34. */
export const DESKTOP_STREAM_MESSAGE_PIECES = Math.ceil(DESKTOP_STREAM_MESSAGE_BYTES / DESKTOP_STREAM_BLOCK_BYTES) + 1;
/** What main does for one connection in one turn of its loop, at most (then the rest waits for the next turn): 256
 * units, about a millisecond (a frame's dispatch or a piece's write is a few microseconds), and 4 MiB of reads copied
 * (a fraction of a millisecond). */
export const DESKTOP_STREAM_TURN_UNITS = 256;
const TURN_UNITS = DESKTOP_STREAM_TURN_UNITS;
export const DESKTOP_STREAM_TURN_BYTES = 4 * 1024 * 1024;
const TURN_BYTES = DESKTOP_STREAM_TURN_BYTES;
/** What main does for one connection in one second, at most. Bytes: 32 MiB (the lead's decision: the live picture is for
 * watching work, not video; his host proof measured 36 MB a second a member on full-screen noise, which then updates
 * more slowly, and nothing ends). Units: what a correct instance with 8 members needs a second is at most about 7,000:
 * each member's cycles at most 30 a second, each a RELEASE and its small messages (a size, a small batch, a pointer
 * shape: 3 frames of 1 or 2 pieces), 8 x 30 x 4 = 960 frames and about 1,500 pieces; under the byte budget at most 32
 * batches of 1 MiB, 32 frames and 576 pieces; a read for each frame at the most and 512 reads of a full block: about
 * 1,000 + 2,100 + 1,500 + 600 + 1,000 = 6,200 units, with the DONEs and pongs about 7,000. SECOND_UNITS, 20,000, is about
 * three times that; past it main only waits. */
export const DESKTOP_STREAM_SECOND_UNITS = 20_000;
const SECOND_UNITS = DESKTOP_STREAM_SECOND_UNITS;
export const DESKTOP_STREAM_SECOND_BYTES = 32 * 1024 * 1024;
const SECOND_BYTES = DESKTOP_STREAM_SECOND_BYTES;
/** A read under this that completes no frame is a drip: the next read waits DRIP_MS (a correct instance's frames come in
 * large reads, or reads that complete them). */
const DRIP_BYTES = 4096;
export const DESKTOP_STREAM_DRIP_MS = 5;
const DRIP_MS = DESKTOP_STREAM_DRIP_MS;
/** At most this many members watch one desktop (the live-picture listener's own cap is 8 a machine). */
export const DESKTOP_STREAM_MEMBERS = 8;
/** What main may have written to an instance that it has not read, past the kernel's socket buffer (about 200 KB on
 * Linux): past it, the instance is ended. A correct instance reads its connection on every turn of its loop, and its
 * loop is held at most tens of milliseconds (a band's PNG is about 11 ms; its guard ends it after 5 s); main writes it
 * at most about 50 KB a second (each member's verdicts no more often than every 25 ms, a SENT for each of its sends,
 * a ping every 5 s), so 1 MiB waiting is far past any correct instance, and still small in the executor's 2 GiB. */
const MAX_UNREAD_BYTES = 1024 * 1024;
/** Members that left on main's side and whose DONE has not come yet: a correct instance answers an UNWATCH at once, but
 * its loop may be held (its guard allows 5 s) while members join and leave fast. At this many, a newcomer is refused
 * STREAM_BUSY until DONEs come: the set is bounded by construction, and nobody is ended for it. */
const MAX_LEAVING = 2 * DESKTOP_STREAM_MEMBERS;
/** What ONE ok lets through to a member: one cycle's messages, which DesktopStream's #send makes from the member's
 * window of the ring. The window's raw pixels are at most the ring's bound, 64 MiB, or one update when that is larger
 * (2 x 3840 x 2160 x 4 + 1 MiB = 67,403,776 bytes), in at most 2,048 areas (the ring's own cap; one update makes at
 * most about 1,100 bands). An area's PNG is at most its raw bytes (RGB is 3/4, a filter byte a row is at most 1/4 more
 * when the area is one pixel wide) plus 1 % of stored-deflate framing and 64 bytes of PNG chunks, and 12 bytes of its
 * head in the batch: at most 67.4 MB x 1.01 + 2,048 x 76 bytes, about 68.2 MB; with the size (5 bytes), a pointer
 * shape (128 x 128 RGBA, about 66 KB) and 3 bytes a batch, under 68.5 MB. CYCLE_BYTES, 72 MiB, is past it. A batch
 * goes out once the next area would pass 1 MiB, so two batches in a row are more than 1 MiB together: at most
 * 2 x 66 + 1 = 133 batches, and the size and the pointer shape: 135 messages. CYCLE_MESSAGES, 160, is past it. */
const CYCLE_MESSAGES = 160;
const CYCLE_BYTES = 72 * 1024 * 1024;
/** A member's release check is asked no sooner than this after its last (its cycles begin 34 ms apart on the
 * instance's clock): an early one is held, unread, until it is due, never refused. */
const RELEASE_GAP_MS = 25;
/** The instance's loop beats this often; its guard kills the process once a beat is GUARD_MS late. */
const BEAT_EVERY_MS = 250;
export const DESKTOP_STREAM_GUARD_MS = 5000;

/** What an instance is told to watch: the machine's exec of the relay, made by its own LXD client on the node's socket. */
export interface DesktopRelaySpec {
	readonly project: string;
	readonly name: string;
	readonly command: readonly string[];
	readonly maxStdoutBytes: number;
}

/** A watched desktop, as the host uses it: an instance of its own (the executor), or this process (the host's tests). */
export interface WatchedDesktop {
	readonly ended: string | null;
	watch(release: DesktopStreamRelease, sink: DesktopStreamSink, signal: AbortSignal): Promise<string>;
}

/** This program's version: its own file's sha-256. Main and every instance it starts must be the same program. */
export function desktopStreamProgramVersion(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const REASON = /^[A-Za-z_]{1,64}$/;
const reasonOf = (value: unknown): string =>
	typeof value === "string" && REASON.test(value) ? value : "STREAM_UNAVAILABLE";
const NO_BYTES = Buffer.alloc(0);

/** A frame's header. */
function head(type: number, member: number, length: number): Buffer {
	const out = Buffer.allocUnsafe(DESKTOP_STREAM_HEADER_BYTES);
	out.writeUInt32BE(length, 0);
	out[4] = type;
	out.writeUInt32BE(member, 5);
	return out;
}
/** Writes one frame: its header and its payload as written, never joined. */
function writeFrame(to: Duplex, type: number, member: number, payload: Buffer = NO_BYTES): void {
	to.cork();
	to.write(head(type, member, payload.byteLength));
	if (payload.byteLength > 0) to.write(payload);
	to.uncork();
}

interface Frame {
	readonly type: number;
	readonly member: number;
	readonly length: number;
	/** The payload as views of the blocks it was copied into: at most ceil(length / DESKTOP_STREAM_BLOCK_BYTES) + 1. */
	readonly pieces: readonly Buffer[];
}
class FrameError extends Error {}

/**
 * Frames read off a connection, in order. Every byte read is copied once, as it comes, into blocks of
 * DESKTOP_STREAM_BLOCK_BYTES (one read of the connection fills at most two), so however small the pieces a connection
 * gives, what is held is a few blocks, never one object a piece: a frame of n bytes is taken as at most
 * ceil(n / DESKTOP_STREAM_BLOCK_BYTES) + 1 views. Blocks are taken from a head index and let go as they are used up,
 * the array compacted once most of it is behind the head; nothing is shifted one by one. A header is checked as soon as
 * its 9 bytes are here (its type known, its length within that type's bound), before any of its payload is waited for;
 * a payload is never looked into.
 */
class FrameQueue {
	readonly #blocks: (Buffer | undefined)[] = [];
	#head = 0;
	#offset = 0;
	/** How much of the last block is written: a full one means the next byte starts a new block. */
	#fill = DESKTOP_STREAM_BLOCK_BYTES;
	#length = 0;
	#header: { type: number; member: number; length: number } | null = null;
	readonly #limit: (type: number) => number;
	constructor(limit: (type: number) => number) {
		this.#limit = limit;
	}
	/** Bytes held (read and not yet taken). */
	get bytes(): number {
		return this.#length;
	}
	/** Blocks held. */
	get blocks(): number {
		return this.#blocks.length - this.#head;
	}
	/** Copies the first `size` bytes of `from` in, block by block. */
	append(from: Uint8Array, size: number): void {
		let at = 0;
		while (at < size) {
			if (this.#fill === DESKTOP_STREAM_BLOCK_BYTES) {
				this.#blocks.push(Buffer.allocUnsafeSlow(DESKTOP_STREAM_BLOCK_BYTES));
				this.#fill = 0;
			}
			const block = this.#blocks[this.#blocks.length - 1] as Buffer;
			const part = Math.min(size - at, DESKTOP_STREAM_BLOCK_BYTES - this.#fill);
			block.set(from.subarray(at, at + part), this.#fill);
			this.#fill += part;
			at += part;
		}
		this.#length += size;
	}
	/** The next whole frame, or null while more bytes are needed; throws FrameError for a header no frame may have. */
	next(): Frame | null {
		if (!this.#header) {
			if (this.#length < DESKTOP_STREAM_HEADER_BYTES) return null;
			const pieces = this.#take(DESKTOP_STREAM_HEADER_BYTES);
			const bytes = pieces.length === 1 ? (pieces[0] as Buffer) : Buffer.concat(pieces, DESKTOP_STREAM_HEADER_BYTES);
			const header = { length: bytes.readUInt32BE(0), type: bytes[4] as number, member: bytes.readUInt32BE(5) };
			const limit = this.#limit(header.type);
			if (limit < 0) throw new FrameError("a frame of no known type");
			if (header.length > limit) throw new FrameError("a frame too large");
			this.#header = header;
		}
		const header = this.#header;
		if (this.#length < header.length) return null;
		this.#header = null;
		return { ...header, pieces: header.length === 0 ? [] : this.#take(header.length) };
	}
	/** The next `size` bytes (all here) as views of the blocks they are in. */
	#take(size: number): Buffer[] {
		const out: Buffer[] = [];
		let left = size;
		while (left > 0) {
			const end = this.#head === this.#blocks.length - 1 ? this.#fill : DESKTOP_STREAM_BLOCK_BYTES;
			if (this.#offset === end) {
				// Used up (bytes are past it, so it is not the block being filled): let go.
				this.#blocks[this.#head] = undefined;
				this.#head++;
				this.#offset = 0;
				continue;
			}
			const part = Math.min(end - this.#offset, left);
			out.push((this.#blocks[this.#head] as Buffer).subarray(this.#offset, this.#offset + part));
			this.#offset += part;
			left -= part;
		}
		this.#length -= size;
		if (this.#head > 64 && this.#head * 2 > this.#blocks.length) {
			this.#blocks.splice(0, this.#head);
			this.#head = 0;
		}
		return out;
	}
}

/** A small payload (at most CONTROL_BYTES) as one buffer. */
const joined = (frame: Frame): Buffer =>
	frame.pieces.length === 1 ? (frame.pieces[0] as Buffer) : Buffer.concat(frame.pieces as Buffer[], frame.length);

interface Member {
	readonly release: DesktopStreamRelease;
	readonly sink: DesktopStreamSink;
	readonly signal: AbortSignal;
	readonly resolve: (reason: string) => void;
	readonly onAbort: () => void;
	/** A release check under way; its verdict an ok (a send allowed until the next check); a send under way. */
	releasing: boolean;
	released: boolean;
	sending: boolean;
	lastAsked: number;
	/** What the last ok still lets through: one cycle's messages and bytes (CYCLE_MESSAGES, CYCLE_BYTES). */
	cycle: { messages: number; bytes: number };
}

/** What main does with one frame: nothing more to do, wait (a release not yet due: the frame is held), or why the
 * instance broke the protocol. */
const HOLD = Symbol("hold");

/** One turn of main's loop, or one second, of work for one connection: its units and bytes (see the top of the file). */
interface Spent {
	units: number;
	bytes: number;
}
/** What one turn of main's loop spent on a connection, for the tests' look: its units and bytes, its reads, the time
 * main's own work for it took, and what it held at the turn's end. */
export interface DesktopStreamTurn {
	readonly units: number;
	readonly bytes: number;
	readonly reads: number;
	/** Reads that brought little and completed no frame: each made the next read wait DRIP_MS. */
	readonly drips: number;
	readonly ms: number;
	readonly heldBytes: number;
	readonly heldBlocks: number;
}

/** The executor's side of one desktop's instance (see the top of this file). */
export class InstanceDesktop implements WatchedDesktop {
	readonly #connection: Socket;
	readonly #members = new Map<number, Member>();
	readonly #onEnded: () => void;
	readonly #now: () => number;
	readonly #pongWithinMs: number;
	readonly #maxMembers: number;
	readonly #releaseGapMs: number;
	readonly #queue = new FrameQueue((type) => {
		if (type === F.send) return DESKTOP_STREAM_MESSAGE_BYTES;
		if (type === F.done || type === F.ended) return CONTROL_BYTES;
		if (type === F.ready || type === F.release || type === F.pong) return 0;
		return -1;
	});
	readonly #pinger: ReturnType<typeof setInterval>;
	readonly #pingEveryMs: number;
	/** Members that left on this side, whose DONE has not come yet, each with how many frames it may still send before
	 * it: at most one RELEASE or one SEND a correct instance can have on its way when it reads the UNWATCH. */
	readonly #leaving = new Map<number, { frames: number }>();
	readonly #maxUnreadBytes: number;
	readonly #observe: ((turn: DesktopStreamTurn) => void) | undefined;
	#reason: string | null = null;
	#cause: string | null = null;
	#ready = false;
	#nextId = 1;
	/** A release that came before it was due, held unread with everything after it. */
	#held: Frame | null = null;
	/** While the connection is not being read, the one wake that reads it again. */
	#wake: { readonly clear: () => void } | null = null;
	/** This turn's work (null until something is charged in it) and this second's. */
	#turn: (Spent & { reads: number; drips: number; ms: number }) | null = null;
	#second: Spent & { start: number } = { start: Number.NEGATIVE_INFINITY, units: 0, bytes: 0 };
	/** Frames taken so far: a read that took none and brought little is a drip. */
	#taken = 0;
	/** The ping waiting for its pong, and how long main itself was not reading since it was sent. */
	#ping: { sentAt: number; notReading: number } | null = null;
	#stalledSince: number | null = null;
	/** When the last ping tick ran: a tick that comes late says main's own loop was held, which is not the instance's. */
	#lastTick: number;

	constructor(
		socket: string,
		spec: DesktopRelaySpec,
		onEnded: () => void,
		options: {
			readonly version: string;
			readonly maxMembers?: number;
			readonly pingEveryMs?: number;
			readonly pongWithinMs?: number;
			readonly releaseGapMs?: number;
			/** MAX_UNREAD_BYTES, for the tests. */
			readonly maxUnreadBytes?: number;
			/** Called at the end of every turn something was charged in, for the tests. */
			readonly observe?: (turn: DesktopStreamTurn) => void;
			readonly now?: () => number;
		},
	) {
		this.#onEnded = onEnded;
		this.#now = options.now ?? Date.now;
		this.#pongWithinMs = options.pongWithinMs ?? 15_000;
		this.#maxMembers = options.maxMembers ?? DESKTOP_STREAM_MEMBERS;
		this.#releaseGapMs = options.releaseGapMs ?? RELEASE_GAP_MS;
		this.#maxUnreadBytes = options.maxUnreadBytes ?? MAX_UNREAD_BYTES;
		this.#observe = options.observe;
		this.#pingEveryMs = options.pingEveryMs ?? 5000;
		this.#lastTick = this.#now();
		// Every read lands in one buffer of this connection's own and is handed here; returning false stops reading at
		// once (nothing is read ahead while main waits).
		this.#connection = createConnection({
			path: socket,
			onread: {
				buffer: Buffer.allocUnsafe(DESKTOP_STREAM_BLOCK_BYTES),
				callback: (size: number, buffer: Uint8Array) => this.#onRead(size, buffer),
			},
		});
		this.#connection.on("error", (error: Error & { code?: string }) =>
			this.#fail(this.#ready ? "its connection failed" : `no way to an instance (${error.code ?? error.name})`),
		);
		this.#connection.on("close", () =>
			this.#fail(
				this.#ready ? "its process ended" : "closed before it was ready (the socket's cap, or a failed start)",
			),
		);
		writeFrame(
			this.#connection,
			F.hello,
			0,
			Buffer.from(JSON.stringify({ protocol: DESKTOP_STREAM_PROTOCOL, version: options.version, spec })),
		);
		this.#pinger = setInterval(() => this.#tick(), this.#pingEveryMs);
		this.#pinger.unref();
	}

	/** Why it ended, or null while it lives. */
	get ended(): string | null {
		return this.#reason;
	}
	/** Why, in a few words for an operator's log: what the instance broke, or what it said ended its relay. */
	get cause(): string | null {
		return this.#cause;
	}

	/** Ends it now: its connection is closed (the instance ends with it) and every member's stream ends `stopping`. */
	close(): void {
		this.#finish("stopping", "closed by its host");
	}

	watch(release: DesktopStreamRelease, sink: DesktopStreamSink, signal: AbortSignal): Promise<string> {
		if (this.#reason) return Promise.resolve(this.#reason);
		if (signal.aborted) return Promise.resolve("closed");
		// Full, or as many members let go of as may wait for their DONE (a correct instance whose loop is held): a delay,
		// never an end.
		if (this.#members.size >= this.#maxMembers || this.#leaving.size >= MAX_LEAVING)
			return Promise.resolve("STREAM_BUSY");
		const id = this.#nextId++;
		return new Promise<string>((resolve) => {
			const onAbort = () => {
				// Left on this side: the instance may still have one frame of it on the way, then its DONE.
				if (this.#leave(id, "closed")) this.#leaving.set(id, { frames: 1 });
				this.#write(F.unwatch, id);
			};
			this.#members.set(id, {
				release,
				sink,
				signal,
				resolve,
				onAbort,
				releasing: false,
				released: false,
				sending: false,
				lastAsked: Number.NEGATIVE_INFINITY,
				cycle: { messages: 0, bytes: 0 },
			});
			signal.addEventListener("abort", onAbort, { once: true });
			this.#write(F.watch, id);
		});
	}

	#write(type: number, member: number, payload?: Buffer): void {
		if (this.#reason) return;
		writeFrame(this.#connection, type, member, payload);
		// What waits to be written past the kernel's buffer: an instance that does not read is ended (MAX_UNREAD_BYTES).
		if (this.#connection.writableLength > this.#maxUnreadBytes) this.#fail("it does not read what it is sent");
	}

	/** The pings, and the pong's deadline counted only while main itself was reading: a tick that comes late (main's own
	 * loop held) counts its lateness as time main was not reading, so a pong waiting in the socket is read before any
	 * deadline can pass for it. */
	#tick(): void {
		if (this.#reason) return;
		const now = this.#now();
		const late = Math.max(0, now - this.#lastTick - this.#pingEveryMs);
		this.#lastTick = now;
		if (this.#ping) {
			this.#ping.notReading += late;
			const stalled = this.#stalledSince === null ? 0 : now - this.#stalledSince;
			if (now - this.#ping.sentAt - this.#ping.notReading - stalled > this.#pongWithinMs)
				this.#fail("no answer to its pings");
			return;
		}
		this.#ping = { sentAt: now, notReading: 0 };
		this.#write(F.ping, 0);
	}

	/** THE one place main's work for this connection is charged: a read (a unit, and its bytes, each copied once into its
	 * block), a frame taken (a unit), a piece handed to a sink (a unit). */
	#charge(units: number, bytes: number): void {
		if (!this.#turn) {
			const turn = { units: 0, bytes: 0, reads: 0, drips: 0, ms: 0 };
			this.#turn = turn;
			// The turn ends after this turn's reads and wakes (the check phase of the loop): its budget with it.
			setImmediate(() => {
				this.#turn = null;
				this.#observe?.({ ...turn, heldBytes: this.#queue.bytes, heldBlocks: this.#queue.blocks });
			});
		}
		this.#turn.units += units;
		this.#turn.bytes += bytes;
		this.#second.units += units;
		this.#second.bytes += bytes;
	}
	/** Whether this turn's budget and this second's both have room left: checked before every unit. */
	#room(): boolean {
		const now = this.#now();
		if (now - this.#second.start >= 1000) this.#second = { start: now, units: 0, bytes: 0 };
		const turn = this.#turn;
		return (
			(turn === null || (turn.units < TURN_UNITS && turn.bytes < TURN_BYTES)) &&
			this.#second.units < SECOND_UNITS &&
			this.#second.bytes < SECOND_BYTES
		);
	}

	/** One read of the connection (its bytes in `buffer`): charged, copied into the queue, and the frames it completed
	 * taken while there is budget. Answers whether to read again at once. */
	#onRead(size: number, buffer: Uint8Array): boolean {
		if (this.#reason) return false;
		const began = performance.now();
		this.#charge(1, size);
		(this.#turn as { reads: number }).reads++;
		this.#queue.append(buffer, size);
		const taken = this.#taken;
		let more = this.#drain();
		if (more && size < DRIP_BYTES && this.#taken === taken) {
			// It brought little and completed no frame: the next read waits DRIP_MS, and the kernel gathers meanwhile.
			(this.#turn as { drips: number }).drips++;
			this.#pause(DRIP_MS);
			more = false;
		} else if (more && !this.#room()) {
			this.#pause();
			more = false;
		}
		if (this.#turn) this.#turn.ms += performance.now() - began;
		return more;
	}

	/** Takes frames while there is budget: true when it wants more bytes and may read them now; false when it stopped
	 * (a wake is set, or it ended). */
	#drain(): boolean {
		for (;;) {
			if (this.#reason) return false;
			if (!this.#room()) {
				this.#pause();
				return false;
			}
			let frame = this.#held;
			if (frame === null) {
				try {
					frame = this.#queue.next();
				} catch (error) {
					this.#fail(error instanceof FrameError ? error.message : "a frame main could not read");
					return false;
				}
				if (frame === null) return true;
			}
			const now = this.#now();
			const outcome = this.#take(frame, now);
			if (outcome === HOLD) {
				// A release before it is due: it and everything after it wait, unread, until it is.
				this.#held = frame;
				const member = this.#members.get(frame.member) as Member;
				this.#pause(Math.max(1, member.lastAsked + this.#releaseGapMs - now));
				return false;
			}
			this.#held = null;
			this.#charge(1 + (frame.type === F.send ? frame.pieces.length : 0), 0);
			this.#taken++;
			if (outcome) {
				this.#fail(outcome);
				return false;
			}
		}
	}

	/** Not reading: until `ms` from now, or until the budget has room again (the next turn, or the next second). The time
	 * counts as main not reading, for the pong. */
	#pause(ms?: number): void {
		if (this.#stalledSince === null) this.#stalledSince = this.#now();
		if (this.#wake) return;
		const now = this.#now();
		let wait = ms;
		if (wait === undefined && (this.#second.units >= SECOND_UNITS || this.#second.bytes >= SECOND_BYTES))
			wait = Math.max(1, this.#second.start + 1000 - now);
		if (wait === undefined) {
			const handle = setImmediate(() => this.#go());
			this.#wake = { clear: () => clearImmediate(handle) };
		} else {
			const handle = setTimeout(() => this.#go(), wait);
			this.#wake = { clear: () => clearTimeout(handle) };
		}
	}

	/** A wake: takes what waits, then reads again if there is budget. */
	#go(): void {
		this.#wake = null;
		if (this.#reason) return;
		const began = performance.now();
		if (this.#stalledSince !== null) {
			if (this.#ping) this.#ping.notReading += this.#now() - this.#stalledSince;
			this.#stalledSince = null;
		}
		if (this.#drain()) {
			if (this.#room()) this.#connection.resume();
			else this.#pause();
		}
		if (this.#turn) this.#turn.ms += performance.now() - began;
	}

	/** Acts on one frame: what the instance broke, HOLD, or null when it kept to the protocol. */
	#take(frame: Frame, now: number): string | typeof HOLD | null {
		const memberScoped = frame.type === F.release || frame.type === F.send || frame.type === F.done;
		if (!memberScoped) {
			if (frame.member !== 0) return "a frame for a member it is not about";
			if (frame.type === F.pong) {
				// A pong answers a ping; one nobody asked for is not free.
				if (!this.#ping) return "a pong it was not asked for";
				this.#ping = null;
				return null;
			}
			if (frame.type === F.ready) {
				if (this.#ready) return "a second ready";
				this.#ready = true;
				return null;
			}
			// ENDED: why the relay ended, for an operator's log; its reason ends every member.
			const [reason, why = ""] = joined(frame).toString("latin1").split("\n");
			const said = reasonOf(reason);
			const words = why.replace(/[^A-Za-z0-9_ :./-]/g, "").slice(0, 120);
			this.#finish(said, `its relay ended ${said}${words ? ` (${words})` : ""}`);
			return null;
		}
		const id = frame.member;
		if (id < 1 || id >= this.#nextId) return "a frame for no member it was given";
		const member = this.#members.get(id);
		if (!member) {
			// A member that left on this side: what may still be on its way (one release or one send), then its DONE;
			// after its DONE, nothing.
			const leaving = this.#leaving.get(id);
			if (!leaving) return "a frame for a member already done";
			if (frame.type === F.done) {
				this.#leaving.delete(id);
				return null;
			}
			if (leaving.frames <= 0) return "more of a member than could be on its way after it left";
			leaving.frames--;
			return null;
		}
		if (frame.type === F.done) {
			this.#leave(id, reasonOf(joined(frame).toString("latin1")));
			return null;
		}
		if (frame.type === F.release) {
			if (member.releasing) return "a release asked while one was under way";
			if (member.sending) return "a release asked while a send was under way";
			if (now - member.lastAsked < this.#releaseGapMs) return HOLD;
			member.releasing = true;
			member.released = false;
			member.lastAsked = now;
			member.release(member.signal).then(
				(verdict) => {
					member.releasing = false;
					if (this.#members.get(id) !== member) return;
					member.released = verdict === "ok";
					// One ok is one cycle: what it lets through is counted from here.
					member.cycle = { messages: CYCLE_MESSAGES, bytes: CYCLE_BYTES };
					this.#write(F.verdict, id, verdictBytes(verdict));
				},
				() => {
					member.releasing = false;
					if (this.#members.get(id) === member) this.#write(F.verdict, id, Buffer.from([2]));
				},
			);
			return null;
		}
		// SEND: one stream message, of which main reads the first byte, the kind; its bytes go on as they came.
		if (frame.length < 1) return "a send that is no message";
		const kind = (frame.pieces[0] as Buffer)[0] as number;
		if (kind < 1 || kind > 3) return "a message of no known kind";
		if (!member.released || member.releasing) return "a send without a released cycle";
		if (member.sending) return "a send while one was under way";
		member.cycle.messages--;
		member.cycle.bytes -= frame.length;
		if (member.cycle.messages < 0 || member.cycle.bytes < 0) return "more for one ok than one cycle can send";
		member.sending = true;
		member.sink.send(frame.pieces.length === 1 ? (frame.pieces[0] as Buffer) : frame.pieces).then(
			() => {
				member.sending = false;
				if (this.#members.get(id) === member) this.#write(F.sent, id, Buffer.from([0]));
			},
			() => {
				member.sending = false;
				if (this.#members.get(id) === member) this.#write(F.sent, id, Buffer.from([1]));
			},
		);
		return null;
	}

	/** A member is through (on either side); the last one takes the instance with it. Whether it was one still here. */
	#leave(id: number, reason: string): boolean {
		const member = this.#members.get(id);
		if (!member) return false;
		this.#members.delete(id);
		member.signal.removeEventListener("abort", member.onAbort);
		member.resolve(reason);
		if (this.#members.size === 0) this.#finish("idle", "its last member left");
		return true;
	}

	/** The instance broke the protocol, stopped answering, or its connection or process ended. */
	#fail(cause: string): void {
		this.#finish("STREAM_UNAVAILABLE", cause);
	}

	#finish(reason: string, cause: string): void {
		if (this.#reason) return;
		this.#reason = reason;
		this.#cause = cause;
		clearInterval(this.#pinger);
		this.#wake?.clear();
		this.#wake = null;
		this.#held = null;
		for (const [id, member] of this.#members) {
			this.#members.delete(id);
			member.signal.removeEventListener("abort", member.onAbort);
			member.resolve(reason);
		}
		// Closing the connection ends the instance: at once while its loop runs, by its guard when it does not.
		this.#connection.destroy();
		this.#onEnded();
	}
}

function verdictBytes(verdict: Awaited<ReturnType<DesktopStreamRelease>>): Buffer {
	if (verdict === "ok") return Buffer.from([0]);
	if (verdict === "pending") return Buffer.from([1]);
	return Buffer.concat([Buffer.from([3]), Buffer.from(reasonOf(verdict.end), "latin1")]);
}

/** The instance's guard: a thread of its own that kills the process once its event loop stops beating, whatever that
 * loop is doing (a spin, a native call that never returns). It needs nothing of that loop. */
const GUARD = `
const { workerData } = require("node:worker_threads");
const beat = new Int32Array(workerData.beat);
let last = Atomics.load(beat, 0);
for (;;) {
	Atomics.wait(beat, 1, 0, workerData.ms);
	const now = Atomics.load(beat, 0);
	if (now === last) process.kill(process.pid, "SIGKILL");
	last = now;
}`;

/**
 * The instance's side (call it as the whole of an instance's work): takes main's HELLO on `connection`, refuses a
 * program of another version, then runs the desktop's DesktopStream with the relay `openRelay` makes, every member's
 * release check and send asked of main. It ends with its connection: at once while its loop runs, and by its guard
 * (DESKTOP_STREAM_GUARD_MS without a beat) when it does not.
 */
export function runDesktopStreamInstance(options: {
	readonly connection: Duplex;
	readonly version: string;
	readonly openRelay: (spec: DesktopRelaySpec) => DesktopStreamOptions["run"];
	readonly exit?: (code: number) => void;
	readonly guardMs?: number;
}): void {
	const { connection } = options;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const beat = new Int32Array(new SharedArrayBuffer(8));
	const guard = new Worker(GUARD, {
		eval: true,
		workerData: { beat: beat.buffer, ms: options.guardMs ?? DESKTOP_STREAM_GUARD_MS },
	});
	guard.unref();
	setInterval(() => Atomics.add(beat, 0, 1), BEAT_EVERY_MS).unref();
	const reader = new FrameQueue((type) => {
		if (type === F.hello) return HELLO_BYTES;
		if (type === F.verdict) return CONTROL_BYTES;
		if (type === F.sent) return 1;
		if (type === F.watch || type === F.unwatch || type === F.ping) return 0;
		return -1;
	});
	const write = (type: number, member: number, payload?: Buffer) => {
		if (!connection.destroyed) writeFrame(connection, type, member, payload);
	};
	let desktop: DesktopStream | null = null;
	let openRelay: DesktopStreamOptions["run"] | null = null;
	let why = "";
	const ended = (reason: string, words: string) => {
		write(F.ended, 0, Buffer.from(`${reasonOf(reason)}\n${words.replace(/[^A-Za-z0-9_ :./-]/g, "").slice(0, 120)}`));
		connection.end();
	};
	const members = new Map<
		number,
		{ readonly stop: AbortController; verdict?: (value: Buffer) => void; sent?: (failed: boolean) => void }
	>();
	const hello = (payload: Buffer) => {
		let said: { protocol?: unknown; version?: unknown; spec?: unknown };
		try {
			said = JSON.parse(payload.toString("utf8")) as typeof said;
		} catch {
			ended("STREAM_UNAVAILABLE", "a hello it could not read");
			return;
		}
		if (said.protocol !== DESKTOP_STREAM_PROTOCOL || said.version !== options.version) {
			ended("STREAM_UNAVAILABLE", "another program version");
			return;
		}
		const spec = said.spec as DesktopRelaySpec;
		if (
			typeof spec !== "object" ||
			spec === null ||
			typeof spec.project !== "string" ||
			typeof spec.name !== "string" ||
			!Array.isArray(spec.command) ||
			!spec.command.every((part) => typeof part === "string") ||
			!Number.isSafeInteger(spec.maxStdoutBytes)
		) {
			ended("STREAM_UNAVAILABLE", "a spec it could not read");
			return;
		}
		openRelay = options.openRelay(spec);
		const relay = openRelay;
		const stream: DesktopStream = new DesktopStream({
			run: (stdout, stdin, signal) =>
				relay(
					(chunk) => {
						try {
							stdout(chunk);
						} catch (error) {
							why = error instanceof Error ? error.message : "a read that failed";
							throw error;
						}
					},
					stdin,
					signal,
				).catch((error: unknown) => {
					why ||= error instanceof Error ? error.message : "a relay that failed";
					throw error;
				}),
			ended: () => ended(stream.ended ?? "STREAM_UNAVAILABLE", why),
		});
		desktop = stream;
		write(F.ready, 0);
	};
	const watch = (id: number) => {
		if (!desktop || members.has(id)) return;
		const member: {
			readonly stop: AbortController;
			verdict?: (value: Buffer) => void;
			sent?: (failed: boolean) => void;
		} = { stop: new AbortController() };
		members.set(id, member);
		const release: DesktopStreamRelease = (signal) =>
			new Promise((resolve, reject) => {
				// The member's signal lives as long as its stream: its listener goes with each cycle's verdict, or 30
				// cycles a second would pile them up for hours (review r11 of #1746).
				const stopped = () => {
					member.verdict = undefined;
					reject(new Error("stopped"));
				};
				member.verdict = (value) => {
					member.verdict = undefined;
					signal.removeEventListener("abort", stopped);
					const kind = value[0];
					if (kind === 0) resolve("ok");
					else if (kind === 1) resolve("pending");
					else if (kind === 3) resolve({ end: reasonOf(value.subarray(1).toString("latin1")) });
					else reject(new Error("STREAM_RELEASE_FAILED"));
				};
				signal.addEventListener("abort", stopped, { once: true });
				write(F.release, id);
			});
		const sink: DesktopStreamSink = {
			send: (message) =>
				new Promise<void>((resolve, reject) => {
					member.sent = (failed) => {
						member.sent = undefined;
						if (failed) reject(new Error("STREAM_SINK_FAILED"));
						else resolve();
					};
					const bytes = Buffer.isBuffer(message) ? message : Buffer.concat(message as Buffer[]);
					write(F.send, id, bytes);
				}),
		};
		void desktop.watch(release, sink, member.stop.signal).then((reason) => {
			members.delete(id);
			write(F.done, id, Buffer.from(reasonOf(reason), "latin1"));
		});
	};
	const take = (frame: Frame) => {
		const id = frame.member;
		if (!desktop) {
			if (frame.type !== F.hello || openRelay) {
				ended("STREAM_UNAVAILABLE", "no hello first");
				return;
			}
			hello(joined(frame));
			return;
		}
		switch (frame.type) {
			case F.ping:
				write(F.pong, 0);
				return;
			case F.watch:
				watch(id);
				return;
			case F.unwatch:
				members.get(id)?.stop.abort();
				return;
			case F.verdict:
				members.get(id)?.verdict?.(joined(frame));
				return;
			case F.sent:
				members.get(id)?.sent?.(joined(frame)[0] === 1);
				return;
		}
	};
	connection.on("data", (piece: Buffer) => {
		reader.append(piece, piece.byteLength);
		for (;;) {
			let frame: Frame | null;
			try {
				frame = reader.next();
			} catch {
				exit(2);
				return;
			}
			if (!frame) return;
			take(frame);
		}
	});
	// A connection that says no hello within HELLO_WITHIN_MS is no executor's: nothing more to do.
	setTimeout(() => {
		if (!openRelay) exit(2);
	}, HELLO_WITHIN_MS).unref();
	// Main closed it (or went away): this instance has nothing more to do.
	connection.on("end", () => exit(0));
	connection.on("close", () => exit(0));
	connection.on("error", () => exit(0));
}
