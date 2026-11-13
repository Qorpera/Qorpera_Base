import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
// stream message (SEND, at most DESKTOP_STREAM_MESSAGE_BYTES) it reads the first byte, the kind, and hands the bytes on
// as the pieces they came in; every other payload is at most CONTROL_BYTES. Main's bounds are held by NOT READING: the
// connection is paused after every piece and read again only when main is ready for the next frame (a turn's budget,
// a member's next release not yet due), so the kernel's socket buffer holds the instance back. The instance is ended
// only for what a correct one never does.
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
/** What main takes from one instance in one turn of its event loop; past either, the rest waits for the next turn,
 * unread. Eight members' release, send and done, a pong and an end are 26 frames. */
export const DESKTOP_STREAM_TURN_FRAMES = 32;
const TURN_BYTES = 4 * 1024 * 1024;
/** At most this many members watch one desktop (the live-picture listener's own cap is 8 a machine). */
export const DESKTOP_STREAM_MEMBERS = 8;
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
	/** The payload as the pieces it came in (views, never copied), or one buffer. */
	readonly pieces: readonly Buffer[];
}
class FrameError extends Error {}

/**
 * Frames read off the pieces a connection gives, in order. A header is checked as soon as its 9 bytes are here — its
 * type known and its length within that type's bound — before any of its payload is waited for. A payload is never
 * looked into here: it is handed on as views of the pieces it came in (a small control payload, joined, is at most
 * CONTROL_BYTES).
 */
class FrameReader {
	readonly #pieces: Buffer[] = [];
	#length = 0;
	#header: { type: number; member: number; length: number } | null = null;
	readonly #limit: (type: number) => number;
	constructor(limit: (type: number) => number) {
		this.#limit = limit;
	}
	push(piece: Buffer): void {
		if (piece.byteLength === 0) return;
		this.#pieces.push(piece);
		this.#length += piece.byteLength;
	}
	/** The next whole frame, or null while more bytes are needed; throws FrameError for a header no frame may have. */
	next(): Frame | null {
		if (!this.#header) {
			if (this.#length < DESKTOP_STREAM_HEADER_BYTES) return null;
			const bytes = Buffer.concat(this.#take(DESKTOP_STREAM_HEADER_BYTES), DESKTOP_STREAM_HEADER_BYTES);
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
	/** The next `size` bytes as views of the pieces they are in. */
	#take(size: number): Buffer[] {
		const out: Buffer[] = [];
		let left = size;
		while (left > 0) {
			const first = this.#pieces[0] as Buffer;
			if (first.byteLength <= left) {
				out.push(first);
				this.#pieces.shift();
				left -= first.byteLength;
			} else {
				out.push(first.subarray(0, left));
				this.#pieces[0] = first.subarray(left);
				left = 0;
			}
		}
		this.#length -= size;
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
}

/** What main does with one frame: nothing more to do, wait (a release not yet due: the frame is held), or why the
 * instance broke the protocol. */
const HOLD = Symbol("hold");

/** The executor's side of one desktop's instance (see the top of this file). */
export class InstanceDesktop implements WatchedDesktop {
	readonly #connection: Duplex;
	readonly #members = new Map<number, Member>();
	readonly #onEnded: () => void;
	readonly #now: () => number;
	readonly #pongWithinMs: number;
	readonly #maxMembers: number;
	readonly #releaseGapMs: number;
	readonly #reader = new FrameReader((type) => {
		if (type === F.send) return DESKTOP_STREAM_MESSAGE_BYTES;
		if (type === F.done || type === F.ended) return CONTROL_BYTES;
		if (type === F.ready || type === F.release || type === F.pong) return 0;
		return -1;
	});
	readonly #pinger: ReturnType<typeof setInterval>;
	#reason: string | null = null;
	#cause: string | null = null;
	#ready = false;
	#nextId = 1;
	/** A release that came before it was due, held unread with everything after it. */
	#held: Frame | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#scheduled = false;
	/** The ping waiting for its pong, and how long main itself was not reading since it was sent. */
	#ping: { sentAt: number; notReading: number } | null = null;
	#stalledSince: number | null = null;

	constructor(
		connection: Duplex,
		spec: DesktopRelaySpec,
		onEnded: () => void,
		options: {
			readonly version: string;
			readonly maxMembers?: number;
			readonly pingEveryMs?: number;
			readonly pongWithinMs?: number;
			readonly releaseGapMs?: number;
			readonly now?: () => number;
		},
	) {
		this.#connection = connection;
		this.#onEnded = onEnded;
		this.#now = options.now ?? Date.now;
		this.#pongWithinMs = options.pongWithinMs ?? 15_000;
		this.#maxMembers = options.maxMembers ?? DESKTOP_STREAM_MEMBERS;
		this.#releaseGapMs = options.releaseGapMs ?? RELEASE_GAP_MS;
		connection.on("data", (piece: Buffer) => {
			// Every piece pauses the connection: it is read again only when main is ready for the next frame.
			connection.pause();
			this.#reader.push(piece);
			if (!this.#scheduled && !this.#timer) this.#pump();
		});
		connection.on("error", (error: Error & { code?: string }) =>
			this.#fail(this.#ready ? "its connection failed" : `no way to an instance (${error.code ?? error.name})`),
		);
		connection.on("close", () =>
			this.#fail(
				this.#ready ? "its process ended" : "closed before it was ready (the socket's cap, or a failed start)",
			),
		);
		writeFrame(
			connection,
			F.hello,
			0,
			Buffer.from(JSON.stringify({ protocol: DESKTOP_STREAM_PROTOCOL, version: options.version, spec })),
		);
		this.#pinger = setInterval(() => this.#tick(), options.pingEveryMs ?? 5000);
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
		if (this.#members.size >= this.#maxMembers) return Promise.resolve("STREAM_BUSY");
		const id = this.#nextId++;
		return new Promise<string>((resolve) => {
			const onAbort = () => {
				this.#leave(id, "closed");
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
			});
			signal.addEventListener("abort", onAbort, { once: true });
			this.#write(F.watch, id);
		});
	}

	#write(type: number, member: number, payload?: Buffer): void {
		if (!this.#reason) writeFrame(this.#connection, type, member, payload);
	}

	/** The pings, and the pong's deadline counted only while main itself was reading. */
	#tick(): void {
		if (this.#reason) return;
		const now = this.#now();
		if (this.#ping) {
			const stalled = this.#stalledSince === null ? 0 : now - this.#stalledSince;
			if (now - this.#ping.sentAt - this.#ping.notReading - stalled > this.#pongWithinMs)
				this.#fail("no answer to its pings");
			return;
		}
		this.#ping = { sentAt: now, notReading: 0 };
		this.#write(F.ping, 0);
	}

	/** Reads frames while main is ready for them: at most a turn's budget, and never past a release not yet due. */
	#pump(): void {
		this.#scheduled = false;
		this.#timer = null;
		if (this.#reason) return;
		const now = this.#now();
		if (this.#stalledSince !== null) {
			if (this.#ping) this.#ping.notReading += now - this.#stalledSince;
			this.#stalledSince = null;
		}
		let frames = 0;
		let bytes = 0;
		for (;;) {
			if (frames >= DESKTOP_STREAM_TURN_FRAMES || bytes >= TURN_BYTES) {
				// The turn's budget is spent: the rest waits, unread, for the next turn.
				this.#stalledSince = now;
				this.#scheduled = true;
				setImmediate(() => this.#pump());
				return;
			}
			let frame = this.#held;
			if (!frame) {
				try {
					frame = this.#reader.next();
				} catch (error) {
					this.#fail(error instanceof FrameError ? error.message : "a frame main could not read");
					return;
				}
				if (!frame) {
					// More bytes are needed, and main is ready for them.
					this.#connection.resume();
					return;
				}
			}
			this.#held = null;
			frames++;
			bytes += DESKTOP_STREAM_HEADER_BYTES + frame.length;
			const outcome = this.#take(frame, now);
			if (outcome === HOLD) {
				// A release before it is due: it and everything after it wait, unread, until it is.
				const member = this.#members.get(frame.member) as Member;
				this.#held = frame;
				this.#stalledSince = now;
				this.#timer = setTimeout(() => this.#pump(), Math.max(1, member.lastAsked + this.#releaseGapMs - now));
				return;
			}
			if (outcome) {
				this.#fail(outcome);
				return;
			}
			if (this.#reason) return;
		}
	}

	/** Acts on one frame: what the instance broke, HOLD, or null when it kept to the protocol. */
	#take(frame: Frame, now: number): string | typeof HOLD | null {
		const memberScoped = frame.type === F.release || frame.type === F.send || frame.type === F.done;
		if (!memberScoped) {
			if (frame.member !== 0) return "a frame for a member it is not about";
			if (frame.type === F.pong) {
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
		if (frame.type === F.done) {
			if (member) this.#leave(id, reasonOf(joined(frame).toString("latin1")));
			return null;
		}
		if (frame.type === F.release) {
			// A member that left on this side: nothing more of it is asked or sent.
			if (!member) return null;
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
		if (!member) return null;
		if (!member.released || member.releasing) return "a send without a released cycle";
		if (member.sending) return "a send while one was under way";
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

	/** A member is through (on either side); the last one takes the instance with it. */
	#leave(id: number, reason: string): void {
		const member = this.#members.get(id);
		if (!member) return;
		this.#members.delete(id);
		member.signal.removeEventListener("abort", member.onAbort);
		member.resolve(reason);
		if (this.#members.size === 0) this.#finish("idle", "its last member left");
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
		if (this.#timer) clearTimeout(this.#timer);
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
	const reader = new FrameReader((type) => {
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
		reader.push(piece);
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
