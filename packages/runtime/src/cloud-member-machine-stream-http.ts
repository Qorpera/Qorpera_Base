import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Writable } from "node:stream";

// A member's live picture of an agent's desktop (20260930745000; POINTER-PROGRESS.md 05:15Z, the lead's B1): the
// executor's own listener behind node 1's own Cloudflare tunnel (`screens.qorpera.com`), on the loopback only (the
// tunnel's connector on the same host is all that reaches it). ONE route:
//   GET /v1/member-machine-streams/<ticket>, a WebSocket upgrade with the subprotocol `qorpera.machine-stream.v1` and the
//   Origin the ticket was bought for.
// The ticket (43 characters, single use, 30 s; bought on the pointer route as the member) is all that admits it. Anything
// else, a ticket used, unknown, run out or of another Origin, or one over the limits, is 404 with no body, and nothing
// else on the way is read or written. The stream only SENDS: the browser's data messages end it (1008); pings are
// answered. What is sent is the desktop's picture as the machine's node lets it go (the messages of
// runner-orchestrator's company-machine-stream.ts: the size, changed areas as PNG, the pointer's shape). A close says
// why it ended: 4001 the pass ran out (the window buys another), 4003 a release cycle refused (its reason), 4004 the
// desktop ended (off, restarted, another boot), 1000 the member closed it, 1001 the executor stops.
//
// THE CLIENT'S SIDE, AS AN INVARIANT (the v245 release review F1, and the lead's words on it): WHATEVER A CLIENT SENDS ON
// AN UPGRADED STREAM, THE LISTENER SPENDS A BOUNDED AMOUNT OF WORK ON IT AND HOLDS A BOUNDED NUMBER OF BYTES FOR IT; ONCE A
// STREAM IS ENDED, NOTHING MORE OF ITS INPUT IS READ. The upgrade before it is Node's to bound: its request whole within
// 5 s (checked every second), headers at most Node's 16 KiB, at most 256 connections, nothing after the request taken.
// After it:
//  - What is kept of a client's input is at most one control frame's bytes (CLIENT_FRAME_BYTES): a read is parsed where
//    it is, a frame's first two bytes are checked (a control frame, masked, at most 125 bytes) BEFORE anything of it is
//    copied, and only a frame split across reads waits, in a carry of exactly that size. Nothing is joined.
//  - A browser's frames are rare: a pong for each of our pings, one close, and seldom a ping of its own. Past
//    CLIENT_FRAMES frames or CLIENT_READS reads in a CLIENT_WINDOW_MS window the client is not a correct one: ended
//    (1008), and no longer read. Every frame costs at most CLIENT_FRAME_BYTES bytes looked at, every read one call.
//  - A pong is written only while at most MAX_UNFLUSHED_PONGS of them wait unflushed (a client that does not read its
//    pongs is ended); our own ping goes only once the last was answered. What waits to be written to a client is the
//    pictures' bound (MEMBER_STREAM_HIGH_WATER_BYTES and a message, MEMBER_STREAM_UNFLUSHED_MESSAGES and one), at most
//    four pongs, one ping and the close.
//  - Ended means not read: the socket is paused and its data handler taken off at once, the carry let go; the close
//    frame is written, and the socket destroyed once that is flushed, or after 2 s at the latest. (Paused, Node takes
//    at most its readable high-water mark from the kernel, never looked at, and gone with the socket.)
//  - Its windows run on a monotonic clock (performance.now()): a wall clock stepped back changes nothing.

export const CLOUD_MEMBER_MACHINE_STREAM_PROTOCOL = "qorpera.machine-stream.v1";
const ROUTE = /^\/v1\/member-machine-streams\/([A-Za-z0-9_-]{43})$/;
const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The most a client's frame may be here: a control frame (a ping, a pong, a close), its 2 bytes of head, its 4 of mask
 * and at most 125 of payload. What the listener keeps of a client's input is at most this. */
const CLIENT_FRAME_BYTES = 2 + 4 + 125;
/** A correct browser sends in any 10 s at most: a pong (our pings are 30 s apart), a close, and a ping of its own now and
 * then (browsers send none of their own; a proxy on the way that keeps the line alive, at most about one a second): about
 * a dozen at the very most. 32 is well past that and still nothing for the executor's loop (64 streams: about 200 frames
 * a second in all, each at most 131 bytes looked at). */
const CLIENT_WINDOW_MS = 10_000;
const CLIENT_FRAMES = 32;
/** And at most this many reads in a window: a correct client's frames come whole, one read each; a frame split a byte a
 * read is 131 reads at the most, so one such frame still passes. A client that trickles bytes costs at most this. */
const CLIENT_READS = 256;
/** Pongs written to a client and not yet flushed: a correct browser reads what it is sent, and its own pings are rare. At
 * this many, its next ping ends it (1008): pongs never pile up for a client that does not read them. */
const MAX_UNFLUSHED_PONGS = 4;
/** Past this much waiting to go out, a send waits for the way to drain. */
export const MEMBER_STREAM_HIGH_WATER_BYTES = 2 * 1024 * 1024;
/** And past this many messages written and not yet flushed (the lead's review r12, second round): a member that stops
 * reading holds at most these, whatever their sizes, never hundreds of thousands of small ones (each its head and its
 * bytes). A correct stream's messages leave as fast as the member reads; 16 is far past what one cycle sends a member
 * with little to send (3) and still small. */
export const MEMBER_STREAM_UNFLUSHED_MESSAGES = 16;
/** What one member's way has written and not yet flushed, counted by the writes' own callbacks. */
export interface MemberStreamWay {
	unflushed: number;
	wake?: (() => void) | undefined;
}
/** Writes one message to a member's way, its head and its bytes corked (its bytes never copied here), and resolves once
 * the way holds at most MEMBER_STREAM_UNFLUSHED_MESSAGES messages and MEMBER_STREAM_HIGH_WATER_BYTES bytes not yet
 * flushed, or the way closed, or `signal` aborted. Every head is a buffer of its own, never from Node's shared pool,
 * which a queued write would keep alive 8 KiB at a time. */
export async function writeMemberStreamMessage(
	out: Writable,
	way: MemberStreamWay,
	head: Buffer,
	message: Buffer,
	signal?: AbortSignal,
): Promise<void> {
	way.unflushed++;
	out.cork();
	out.write(head);
	out.write(message, () => {
		way.unflushed--;
		way.wake?.();
	});
	out.uncork();
	while (
		!out.destroyed &&
		!signal?.aborted &&
		(way.unflushed > MEMBER_STREAM_UNFLUSHED_MESSAGES || out.writableLength > MEMBER_STREAM_HIGH_WATER_BYTES)
	)
		await new Promise<void>((resolve) => {
			const done = () => {
				way.wake = undefined;
				out.off("drain", done);
				out.off("close", done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			way.wake = done;
			out.once("drain", done);
			out.once("close", done);
			signal?.addEventListener("abort", done, { once: true });
		});
}
const PING_EVERY_MS = 30_000;
const PONG_WITHIN_MS = 60_000;
/** How long a connection may take to send its whole upgrade request, and how often that is checked. Node checks the
 * request's deadline only every `connectionsCheckingInterval` (30 s unless told), so with the default a connection that
 * sends nothing would be held for up to about 35 s; checked every second, it goes within about 6 s (the lead's read of
 * #1746, 13 Nov). */
const UPGRADE_WITHIN_MS = 5000;
const CHECK_EVERY_MS = 1000;
/** Connections this listener holds at once, upgraded or not: room for its 64 streams and the upgrades on their way.
 * Past it, Node closes a new connection the moment it is accepted, before a byte of it is read. */
const MAX_CONNECTIONS = 256;

/** Where a member's stream goes: `send` resolves once the message is on its way and the way is not full. */
export interface CloudMemberMachineStreamSink {
	send(message: Buffer): Promise<void>;
}
/** A stream admitted on its ticket: running it streams to `sink` until `signal` aborts or it ends, and answers why. */
export type CloudMemberMachineStreamRun = (sink: CloudMemberMachineStreamSink, signal: AbortSignal) => Promise<string>;

export interface CloudMemberMachineStreamOptions {
	readonly host: "127.0.0.1";
	readonly port: number;
	/** The ticket and the browser's Origin: the stream to run (the ticket is used up), or null (404). */
	admit(ticket: string, origin: string): CloudMemberMachineStreamRun | null;
	/** At most this many streams at once on this listener (64); past it, 404. */
	readonly maxStreams?: number;
}

/** Why a stream ended, as the browser is told it (code, reason). */
export function cloudMemberMachineStreamClose(reason: string): { code: number; reason: string } {
	if (reason === "closed") return { code: 1000, reason: "" };
	if (reason === "POINTER_PASS_ENDED" || reason === "STREAM_TOO_LONG") return { code: 4001, reason };
	if (
		["DESKTOP_NOT_RUNNING", "MACHINE_BOOT_CHANGED", "MACHINE_IMAGE_WITHOUT_SCREEN", "DESKTOP_ENDED", "idle"].includes(
			reason,
		)
	)
		return { code: 4004, reason: reason === "idle" ? "DESKTOP_ENDED" : reason };
	if (reason === "stopping") return { code: 1001, reason: "" };
	return { code: 4003, reason: /^[A-Z_]{1,64}$/.test(reason) ? reason : "STREAM_UNAVAILABLE" };
}

/** A frame's head: its opcode and its length. The payload goes after it as it is, never copied into one buffer with it
 * (a picture is up to 8 MiB; the v245 release review: no copying on node 1's event loop that the guest can make long). */
function frameHead(opcode: number, length: number): Buffer {
	// A buffer of its own (Buffer.alloc never takes from Node's shared pool).
	const head = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10);
	head[0] = 0x80 | opcode;
	if (length < 126) head[1] = length;
	else if (length < 65536) {
		head[1] = 126;
		head.writeUInt16BE(length, 2);
	} else {
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(length), 2);
	}
	return head;
}
function closeFrame(code: number, reason: string): Buffer {
	const text = Buffer.from(reason, "utf8").subarray(0, 123);
	const close = Buffer.alloc(4 + text.byteLength);
	close[0] = 0x88;
	close[1] = 2 + text.byteLength;
	close.writeUInt16BE(code, 2);
	text.copy(close, 4);
	return close;
}
const now = (): number => performance.now();
function refuse(socket: Socket): void {
	socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
	socket.destroy();
}

/** The executor's live-picture listener (see the top of this file). */
export class CloudMemberMachineStreamListener {
	readonly #options: CloudMemberMachineStreamOptions;
	readonly #server: Server;
	readonly #open = new Set<{ readonly stop: AbortController; readonly socket: Socket }>();
	constructor(options: CloudMemberMachineStreamOptions) {
		if (
			options.host !== "127.0.0.1" ||
			!Number.isSafeInteger(options.port) ||
			options.port < 0 ||
			options.port > 65535 ||
			typeof options.admit !== "function" ||
			(options.maxStreams !== undefined && (!Number.isSafeInteger(options.maxStreams) || options.maxStreams < 1))
		)
			throw new Error("Member machine stream listener is invalid");
		this.#options = options;
		this.#server = createServer({ connectionsCheckingInterval: CHECK_EVERY_MS }, (_request, reply) => {
			// Only the upgrade is served: anything else is nothing.
			reply.writeHead(404, { "content-length": "0", connection: "close" });
			reply.end();
		});
		// The upgrade's request comes whole within 5 s, or the connection goes — checked every second, so a connection
		// that sends nothing at all is gone within about 6 s, never the 35 s Node's default check would allow.
		this.#server.headersTimeout = UPGRADE_WITHIN_MS;
		this.#server.requestTimeout = UPGRADE_WITHIN_MS;
		// And at most this many at once: a flood of idle connections holds at most 256 sockets for at most ~6 s each,
		// and an upgraded stream keeps its own (it counts among them until it ends).
		this.#server.maxConnections = MAX_CONNECTIONS;
		this.#server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) =>
			this.#upgrade(request, socket, head),
		);
		this.#server.on("clientError", (_error, socket: Socket) => socket.destroy());
	}

	listen(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen(this.#options.port, this.#options.host, () => {
				this.#server.off("error", reject);
				resolve((this.#server.address() as { port: number }).port);
			});
		});
	}

	/** Stops taking streams and ends every open one (1001). A connection that has not upgraded is cut at once: closing
	 * stops Node's deadline check, so one that sends nothing would otherwise hold the close for as long as it liked. An
	 * upgraded stream is ended by its own close (1001), which lets its socket go within 2 s. */
	async close(): Promise<void> {
		for (const open of this.#open) open.stop.abort("stopping");
		const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
		this.#server.closeAllConnections();
		await closed;
	}

	#upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const route = ROUTE.exec(request.url ?? "");
		const key = request.headers["sec-websocket-key"];
		const origin = request.headers.origin;
		const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
			.split(",")
			.map((part) => part.trim());
		if (
			request.method !== "GET" ||
			!route ||
			String(request.headers.upgrade ?? "").toLowerCase() !== "websocket" ||
			request.headers["sec-websocket-version"] !== "13" ||
			typeof key !== "string" ||
			!/^[A-Za-z0-9+/]{22}==$/.test(key) ||
			typeof origin !== "string" ||
			!protocols.includes(CLOUD_MEMBER_MACHINE_STREAM_PROTOCOL) ||
			head.byteLength > 0 ||
			this.#open.size >= (this.#options.maxStreams ?? 64)
		) {
			refuse(socket);
			return;
		}
		let run: CloudMemberMachineStreamRun | null;
		try {
			run = this.#options.admit(route[1] as string, origin);
		} catch {
			run = null;
		}
		if (!run) {
			refuse(socket);
			return;
		}
		const accept = createHash("sha1").update(`${key}${ACCEPT_GUID}`).digest("base64");
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${accept}`,
				`Sec-WebSocket-Protocol: ${CLOUD_MEMBER_MACHINE_STREAM_PROTOCOL}`,
				"",
				"",
			].join("\r\n"),
		);
		socket.setNoDelay(true);
		socket.setTimeout(0);
		this.#stream(socket, run);
	}

	#stream(socket: Socket, run: CloudMemberMachineStreamRun): void {
		const stop = new AbortController();
		const open = { stop, socket };
		this.#open.add(open);
		let ended = false;
		/** A frame split across reads waits here, at most CLIENT_FRAME_BYTES; null once ended (let go). */
		let carry: Buffer | null = Buffer.alloc(CLIENT_FRAME_BYTES);
		let carried = 0;
		let windowAt = now();
		let frames = 0;
		let reads = 0;
		let pongs = 0;
		/** When our ping went out, until its pong comes: one at a time. */
		let pingAt: number | null = null;
		const end = (code: number, reason: string) => {
			if (ended) return;
			ended = true;
			stop.abort(reason || "closed");
			globalThis.clearInterval(pinger);
			this.#open.delete(open);
			// Ended means not read: nothing more of the client's input is taken, and what was kept of it goes.
			socket.off("data", onData);
			socket.pause();
			carry = null;
			carried = 0;
			if (socket.destroyed) return;
			// The close goes after what was already written; the socket goes once it is flushed, or after 2 s at the latest
			// (a client that does not read).
			const late = globalThis.setTimeout(() => socket.destroy(), 2000);
			socket.once("close", () => globalThis.clearTimeout(late));
			socket.end(closeFrame(code, reason), () => socket.destroy());
		};
		const pinger = globalThis.setInterval(() => {
			if (pingAt !== null) {
				// Unanswered: no second ping on top of it, and the stream ends once PONG_WITHIN_MS passed without its pong.
				if (now() - pingAt >= PONG_WITHIN_MS) {
					end(1001, "");
					socket.destroy();
				}
				return;
			}
			pingAt = now();
			if (!socket.destroyed) socket.write(frameHead(0x9, 0));
		}, PING_EVERY_MS);
		const onData = (chunk: Buffer) => {
			const kept = carry;
			if (ended || !kept) return;
			const at = now();
			if (at - windowAt >= CLIENT_WINDOW_MS) {
				windowAt = at;
				frames = 0;
				reads = 0;
			}
			if (++reads > CLIENT_READS) {
				end(1008, "");
				return;
			}
			let from = 0;
			/** The i-th byte of what waits: the carry first, then this read where it is. */
			const byte = (i: number): number => (i < carried ? kept[i] : chunk[from + i - carried]) as number;
			for (;;) {
				const have = carried + chunk.byteLength - from;
				if (have === 0) return;
				// Only whole, masked control frames come from a browser here, each checked before a byte of it is kept: a
				// data frame ends the stream (1008: it only shows), anything else that is not a control frame too (1002).
				const first = byte(0);
				const opcode = first & 0x0f;
				if (opcode <= 0x2) {
					end(1008, "");
					return;
				}
				if ((first & 0x80) === 0 || (first & 0x70) !== 0 || (opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xa)) {
					end(1002, "");
					return;
				}
				if (have < 2) break;
				const second = byte(1);
				const length = second & 0x7f;
				if ((second & 0x80) === 0 || length > 125) {
					end(1002, "");
					return;
				}
				const total = 6 + length;
				if (have < total) break;
				if (++frames > CLIENT_FRAMES) {
					end(1008, "");
					return;
				}
				if (opcode === 0x9) {
					if (pongs >= MAX_UNFLUSHED_PONGS) {
						end(1008, "");
						return;
					}
					// Its answer: a buffer of its own, at most 127 bytes, unmasked as it is copied.
					const pong = Buffer.alloc(2 + length);
					pong[0] = 0x8a;
					pong[1] = length;
					for (let i = 0; i < length; i++) pong[2 + i] = byte(6 + i) ^ byte(2 + (i % 4));
					pongs++;
					socket.write(pong, () => {
						pongs--;
					});
				} else if (opcode === 0xa) {
					// The answer to our ping (one a browser sends unasked counts as a frame and nothing more).
					pingAt = null;
				} else {
					end(1000, "");
					return;
				}
				from += total - carried;
				carried = 0;
			}
			// Less than a frame is left, and its length is known to fit (under 2 bytes, or under its checked total): it
			// waits for the next read.
			carried += chunk.copy(kept, carried, from);
		};
		socket.on("data", onData);
		// The browser's side ended (the upgraded socket is half-open: its end alone is no close): the stream ends too.
		socket.on("end", () => {
			if (!ended) end(1001, "");
			socket.destroy();
		});
		socket.on("error", () => {
			if (!ended) end(1001, "");
			socket.destroy();
		});
		socket.on("close", () => {
			if (!ended) {
				ended = true;
				stop.abort("closed");
				globalThis.clearInterval(pinger);
				this.#open.delete(open);
			}
			carry = null;
		});
		const way: MemberStreamWay = { unflushed: 0 };
		const sink: CloudMemberMachineStreamSink = {
			send: async (message) => {
				if (ended || socket.destroyed) throw new Error("MEMBER_MACHINE_STREAM_CLOSED");
				// The head and the picture as writes in one, corked: the picture's bytes are never copied here. A send waiting
				// for the way ends with the stream, not with the socket's last 2 s.
				await writeMemberStreamMessage(socket, way, frameHead(0x2, message.byteLength), message, stop.signal);
			},
		};
		void run(sink, stop.signal).then(
			(reason) => {
				const close = cloudMemberMachineStreamClose(
					stop.signal.aborted && stop.signal.reason === "stopping" ? "stopping" : reason,
				);
				end(close.code, close.reason);
			},
			() => end(4003, "STREAM_UNAVAILABLE"),
		);
	}
}
