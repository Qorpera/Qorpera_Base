import { parentPort, Worker, workerData } from "node:worker_threads";
import {
	DesktopStream,
	type DesktopStreamOptions,
	type DesktopStreamRelease,
	type DesktopStreamSink,
} from "./company-machine-stream.ts";

// A desktop's live picture, watched in a worker thread of its own (20260930745000, review r11 of #1746): THE INVARIANT
// is that no byte that comes from a desktop is parsed, scanned, copied in a loop or counted on the executor's main
// event loop. The worker opens the machine's relay itself (its own LXD client on the node's socket) and runs everything
// that touches the guest's bytes: the RFB reader, the ring, the dedup, the PNG encoding with its deflating
// (DesktopStream; on this thread, never the process's shared libuv threads). The main loop gets finished stream
// messages only, which it does not parse (their length and their first byte are all it reads), and it trusts none of
// them: a worker that breaks the protocol, sends past its bounds, stops answering, dies, runs out of heap or holds
// buffers past theirs is terminated, and every member's stream ends STREAM_UNAVAILABLE (the window falls back to its
// pictures). Every authority decision — each member's release check: the fence, the folder boundary, SQL — stays on the
// main side: the worker asks, the main side decides.
//
// The protocol, one request outstanding per member each way:
//   worker -> main  { t: "release", m }            the worker's cycle for member m begins: decide
//                   { t: "send", m, b }            after an ok, one message (an ArrayBuffer, transferred) for m's sink
//                   { t: "done", m, r }            m's watch ended with reason r
//                   { t: "ended", r }              the relay ended: every member with r
//                   { t: "pong" }
//   main -> worker  { t: "watch", m } { t: "unwatch", m }
//                   { t: "verdict", m, v }         "ok" | "pending" | { end } | "error"
//                   { t: "sent", m, failed? }      the sink took it (back-pressure)
//                   { t: "ping" } { t: "stop" }

export const DESKTOP_STREAM_WORKER_ROLE = "qorpera.desktop-stream-worker/v1";

/** What a worker is told to watch: the machine's exec of the relay, made by its own LXD client on this node's socket. */
export interface DesktopRelaySpec {
	readonly project: string;
	readonly name: string;
	readonly command: readonly string[];
	readonly maxStdoutBytes: number;
}

/** A watched desktop, as the host uses it: in a worker (the executor), or in this thread (the host's own tests). */
export interface WatchedDesktop {
	readonly ended: string | null;
	watch(release: DesktopStreamRelease, sink: DesktopStreamSink, signal: AbortSignal): Promise<string>;
}

/** Whether this thread was started as a desktop's stream worker. */
export function isDesktopStreamWorker(data: unknown = workerData): boolean {
	return (
		parentPort !== null &&
		typeof data === "object" &&
		data !== null &&
		(data as { role?: unknown }).role === DESKTOP_STREAM_WORKER_ROLE
	);
}

/** The largest stream message the main side takes from a worker: a batch goes out at 1 MiB, a band's PNG is under 800
 * KB, a pointer shape's under 70 KB. */
export const DESKTOP_STREAM_WORKER_MESSAGE_BYTES = 2 * 1024 * 1024 + 1024;
/** What the main side takes from one worker in one turn of its event loop, and in one second; past either, the worker is
 * terminated. A worker keeping to the protocol never comes near them (one message in flight a member). */
const MAX_TURN_MESSAGES = 64;
const MAX_TURN_BYTES = 16 * 1024 * 1024;
const MAX_SECOND_MESSAGES = 4000;
const MAX_SECOND_BYTES = 1024 * 1024 * 1024;
/** A member's release checks at most this often (its cycles are 34 ms apart at the least). */
const MIN_RELEASE_GAP_MS = 25;
/** The heap a worker may use; past it the worker is terminated, never the executor. */
export interface DesktopStreamWorkerLimits {
	readonly maxOldGenerationSizeMb: number;
	readonly maxYoungGenerationSizeMb: number;
	readonly codeRangeSizeMb: number;
	readonly stackSizeMb: number;
}
export const DESKTOP_STREAM_WORKER_LIMITS: DesktopStreamWorkerLimits = Object.freeze({
	maxOldGenerationSizeMb: 128,
	maxYoungGenerationSizeMb: 16,
	codeRangeSizeMb: 32,
	stackSizeMb: 4,
});

/** The buffers a worker may hold: its ArrayBuffers and zlib's memory, which live OUTSIDE the heap resourceLimits caps,
 * as the worker's own V8 counts them (garbage not yet collected included). The main side looks every
 * BUFFER_CHECK_EVERY_MS — V8 answers for the worker even while its JavaScript is busy — and terminates it past this.
 * What a worker holds alive is bounded by the stream's own bounds: at 3840 x 2160, the reader's queue and the update
 * being taken out (2 x 67 MB), the ring (64 MiB, or one update of up to 67 MB), the windows members' sends are walking
 * and each band's PNG once; full-screen 4K noise with two to six members peaked at 231 MB on this Mac (review r11 of
 * #1746). Before r11 the ring kept every update it let go until its array was compacted, up to 1,024 of them: 2.4 GB in
 * ten seconds of noise on the real machine. */
export const DESKTOP_STREAM_WORKER_BUFFER_BYTES = 512 * 1024 * 1024;
const BUFFER_CHECK_EVERY_MS = 500;

const REASON = /^[A-Za-z_]{1,64}$/;
const reasonOf = (value: unknown): string =>
	typeof value === "string" && REASON.test(value) ? value : "STREAM_UNAVAILABLE";

interface Member {
	readonly release: DesktopStreamRelease;
	readonly sink: DesktopStreamSink;
	readonly signal: AbortSignal;
	readonly resolve: (reason: string) => void;
	readonly onAbort: () => void;
	/** A release check under way, its verdict an ok (sends allowed until the next check), a send under way. */
	releasing: boolean;
	released: boolean;
	sending: boolean;
	lastAsked: number;
}

/** The main side of one desktop's worker (see the top of this file). */
export class WorkerDesktop implements WatchedDesktop {
	readonly #worker: Worker;
	readonly #members = new Map<number, Member>();
	readonly #onEnded: () => void;
	readonly #now: () => number;
	readonly #pongWithinMs: number;
	readonly #pinger: ReturnType<typeof setInterval>;
	readonly #buffers: ReturnType<typeof setInterval>;
	#reason: string | null = null;
	/** Why, in a few words for an operator's log: what the worker broke, or what it said ended its relay. */
	#cause: string | null = null;
	#nextId = 1;
	#lastPong: number;
	#turn = { messages: 0, bytes: 0, counting: false };
	#second = { since: 0, messages: 0, bytes: 0 };

	constructor(
		entry: URL,
		spec: DesktopRelaySpec,
		onEnded: () => void,
		options: {
			readonly resourceLimits?: Partial<DesktopStreamWorkerLimits>;
			readonly pingEveryMs?: number;
			readonly pongWithinMs?: number;
			/** DESKTOP_STREAM_WORKER_BUFFER_BYTES and BUFFER_CHECK_EVERY_MS, for the tests. */
			readonly bufferBytes?: number;
			readonly bufferCheckEveryMs?: number;
			readonly now?: () => number;
		} = {},
	) {
		this.#onEnded = onEnded;
		this.#now = options.now ?? Date.now;
		this.#pongWithinMs = options.pongWithinMs ?? 15_000;
		this.#lastPong = this.#now();
		this.#worker = new Worker(entry, {
			workerData: { role: DESKTOP_STREAM_WORKER_ROLE, spec },
			resourceLimits: { ...DESKTOP_STREAM_WORKER_LIMITS, ...options.resourceLimits },
			stdout: true,
			stderr: true,
		});
		// Nothing of the worker's own output is read here.
		this.#worker.stdout.resume();
		this.#worker.stderr.resume();
		this.#worker.on("message", (message: unknown) => this.#receive(message));
		this.#worker.on("messageerror", () => this.#fail("a message the main side could not read"));
		this.#worker.on("error", (error: Error & { code?: string }) =>
			this.#fail(`worker error ${error.code ?? error.name ?? "unknown"}`),
		);
		this.#worker.on("exit", (code) => this.#fail(`worker exited ${code}`));
		this.#pinger = setInterval(() => {
			if (this.#now() - this.#lastPong > this.#pongWithinMs) this.#fail("no answer to its pings");
			else this.#post({ t: "ping" });
		}, options.pingEveryMs ?? 5000);
		this.#pinger.unref();
		// Its buffers, which no resourceLimits caps: looked at from here, one look at a time.
		const bufferBytes = options.bufferBytes ?? DESKTOP_STREAM_WORKER_BUFFER_BYTES;
		let looking = false;
		this.#buffers = setInterval(() => {
			if (looking || this.#reason) return;
			looking = true;
			this.#worker.getHeapStatistics().then(
				(heap) => {
					looking = false;
					const external = (heap as { external_memory?: number }).external_memory ?? 0;
					if (external > bufferBytes)
						this.#fail(`its buffers past their bound (${Math.round(external / 1048576)} MB)`);
				},
				() => {
					looking = false;
				},
			);
		}, options.bufferCheckEveryMs ?? BUFFER_CHECK_EVERY_MS);
		this.#buffers.unref();
	}

	/** Why it ended, or null while it lives. */
	get ended(): string | null {
		return this.#reason;
	}

	/** Why it ended, in a few words (what the worker broke or said), or null while it lives. */
	get cause(): string | null {
		return this.#cause;
	}

	/** The worker's heap as its own V8 counts it, its external memory (its buffers) apart: for an operator's look, and
	 * read by the proofs. Null once it ended. */
	async heap(): Promise<{ readonly used: number; readonly external: number } | null> {
		if (this.#reason) return null;
		try {
			const heap = await this.#worker.getHeapStatistics();
			return { used: heap.used_heap_size, external: (heap as { external_memory?: number }).external_memory ?? 0 };
		} catch {
			return null;
		}
	}

	/** Ends it now: the worker is terminated and every member's stream ends `stopping`. */
	close(): void {
		this.#finish("stopping", "closed by its host");
	}

	watch(release: DesktopStreamRelease, sink: DesktopStreamSink, signal: AbortSignal): Promise<string> {
		if (this.#reason) return Promise.resolve(this.#reason);
		if (signal.aborted) return Promise.resolve("closed");
		const id = this.#nextId++;
		return new Promise<string>((resolve) => {
			const onAbort = () => {
				this.#leave(id, "closed");
				this.#post({ t: "unwatch", m: id });
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
			this.#post({ t: "watch", m: id });
		});
	}

	#post(message: unknown): void {
		if (!this.#reason) this.#worker.postMessage(message);
	}

	/** One message from the worker: checked, bounded, and only then acted on; anything amiss ends the worker. */
	#receive(raw: unknown): void {
		if (this.#reason) return;
		const broken = this.#take(raw);
		if (broken) this.#fail(broken);
	}

	/** Acts on one message from the worker; what it broke, or null when it kept to the protocol and its bounds. */
	#take(raw: unknown): string | null {
		const now = this.#now();
		if (now - this.#second.since >= 1000) this.#second = { since: now, messages: 0, bytes: 0 };
		if (!this.#turn.counting) {
			this.#turn = { messages: 0, bytes: 0, counting: true };
			setImmediate(() => {
				this.#turn.counting = false;
			});
		}
		this.#turn.messages++;
		this.#second.messages++;
		if (this.#turn.messages > MAX_TURN_MESSAGES) return "too many messages in one turn";
		if (this.#second.messages > MAX_SECOND_MESSAGES) return "too many messages in one second";
		if (typeof raw !== "object" || raw === null) return "a message that is no object";
		const message = raw as { t?: unknown; m?: unknown; b?: unknown; r?: unknown; why?: unknown };
		if (message.t === "pong") {
			this.#lastPong = now;
			return null;
		}
		if (message.t === "ended") {
			const why = typeof message.why === "string" ? message.why.replace(/[^A-Za-z0-9_ :.-]/g, "").slice(0, 120) : "";
			this.#finish(reasonOf(message.r), `its relay ended ${reasonOf(message.r)}${why ? ` (${why})` : ""}`);
			return null;
		}
		const id = message.m;
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id >= this.#nextId)
			return "a message for no member it was given";
		const member = this.#members.get(id);
		switch (message.t) {
			case "release": {
				// A member that left on this side: nothing more of it is asked or sent.
				if (!member) return null;
				if (member.releasing) return "a release asked while one was under way";
				if (member.sending) return "a release asked while a send was under way";
				if (now - member.lastAsked < MIN_RELEASE_GAP_MS) return "releases asked too often";
				member.releasing = true;
				member.released = false;
				member.lastAsked = now;
				member.release(member.signal).then(
					(verdict) => {
						member.releasing = false;
						if (this.#members.get(id) !== member) return;
						member.released = verdict === "ok";
						this.#post({ t: "verdict", m: id, v: verdict });
					},
					() => {
						member.releasing = false;
						if (this.#members.get(id) !== member) return;
						this.#post({ t: "verdict", m: id, v: "error" });
					},
				);
				return null;
			}
			case "send": {
				const bytes = message.b;
				if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 1) return "a send that is no message";
				if (bytes.byteLength > DESKTOP_STREAM_WORKER_MESSAGE_BYTES) return "a message too large";
				this.#turn.bytes += bytes.byteLength;
				this.#second.bytes += bytes.byteLength;
				if (this.#turn.bytes > MAX_TURN_BYTES) return "too many bytes in one turn";
				if (this.#second.bytes > MAX_SECOND_BYTES) return "too many bytes in one second";
				if (!member) return null;
				if (!member.released || member.releasing) return "a send without a released cycle";
				if (member.sending) return "a send while one was under way";
				// The one byte the main side reads of a message: its type (size, areas, pointer shape).
				const type = new Uint8Array(bytes, 0, 1)[0] as number;
				if (type < 1 || type > 3) return "a message of no known type";
				member.sending = true;
				member.sink.send(Buffer.from(bytes)).then(
					() => {
						member.sending = false;
						if (this.#members.get(id) === member) this.#post({ t: "sent", m: id });
					},
					() => {
						member.sending = false;
						if (this.#members.get(id) === member) this.#post({ t: "sent", m: id, failed: true });
					},
				);
				return null;
			}
			case "done":
				if (member) this.#leave(id, reasonOf(message.r));
				return null;
			default:
				return "a message of no known kind";
		}
	}

	/** A member is through (on either side); the last one takes the worker with it. */
	#leave(id: number, reason: string): void {
		const member = this.#members.get(id);
		if (!member) return;
		this.#members.delete(id);
		member.signal.removeEventListener("abort", member.onAbort);
		member.resolve(reason);
		if (this.#members.size === 0) this.#finish("idle", "its last member left");
	}

	/** The worker broke the protocol or its bounds, stopped answering, died or ran out of memory. */
	#fail(cause: string): void {
		this.#finish("STREAM_UNAVAILABLE", cause);
	}

	#finish(reason: string, cause: string): void {
		if (this.#reason) return;
		this.#reason = reason;
		this.#cause = cause;
		clearInterval(this.#pinger);
		clearInterval(this.#buffers);
		for (const [id, member] of this.#members) {
			this.#members.delete(id);
			member.signal.removeEventListener("abort", member.onAbort);
			member.resolve(reason);
		}
		void this.#worker.terminate().catch(() => undefined);
		this.#onEnded();
	}
}

/**
 * The worker's side (call it as the whole of a stream worker's work): runs the desktop's DesktopStream with the relay
 * `openRelay` makes, and every member's release checks and sends through the main side.
 */
export function runDesktopStreamWorker(openRelay: (spec: DesktopRelaySpec) => DesktopStreamOptions["run"]): void {
	const port = parentPort;
	if (!port || !isDesktopStreamWorker()) throw new Error("DESKTOP_STREAM_WORKER_INVALID");
	const spec = (workerData as { spec: DesktopRelaySpec }).spec;
	const members = new Map<
		number,
		{
			readonly stop: AbortController;
			verdict?: (value: unknown) => void;
			sent?: (failed: boolean) => void;
		}
	>();
	// What ended the relay, when it was an error: told to the main side for its operator's log, never acted on.
	let why = "";
	const relay = openRelay(spec);
	const desktop: DesktopStream = new DesktopStream({
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
		ended: () => port.postMessage({ t: "ended", r: desktop.ended ?? "STREAM_UNAVAILABLE", why }),
	});
	port.on("message", (raw: { t?: unknown; m?: unknown; v?: unknown; failed?: unknown }) => {
		const id = typeof raw.m === "number" ? raw.m : 0;
		switch (raw.t) {
			case "ping":
				port.postMessage({ t: "pong" });
				return;
			case "stop":
				for (const member of members.values()) member.stop.abort();
				return;
			case "unwatch":
				members.get(id)?.stop.abort();
				return;
			case "verdict":
				members.get(id)?.verdict?.(raw.v);
				return;
			case "sent":
				members.get(id)?.sent?.(raw.failed === true);
				return;
			case "watch": {
				if (members.has(id)) return;
				const member: {
					readonly stop: AbortController;
					verdict?: (value: unknown) => void;
					sent?: (failed: boolean) => void;
				} = { stop: new AbortController() };
				members.set(id, member);
				const release: DesktopStreamRelease = (signal) =>
					new Promise((resolve, reject) => {
						// The member's signal lives as long as its stream: its listener goes with each cycle's verdict, or
						// 30 cycles a second would pile them up for hours.
						const stopped = () => {
							member.verdict = undefined;
							reject(new Error("stopped"));
						};
						member.verdict = (verdict) => {
							member.verdict = undefined;
							signal.removeEventListener("abort", stopped);
							if (verdict === "ok" || verdict === "pending") resolve(verdict);
							else if (typeof verdict === "object" && verdict !== null && "end" in verdict)
								resolve({ end: reasonOf((verdict as { end: unknown }).end) });
							else reject(new Error("STREAM_RELEASE_FAILED"));
						};
						signal.addEventListener("abort", stopped, { once: true });
						port.postMessage({ t: "release", m: id });
					});
				const sink: DesktopStreamSink = {
					send: (message) =>
						new Promise<void>((resolve, reject) => {
							member.sent = (failed) => {
								member.sent = undefined;
								if (failed) reject(new Error("STREAM_SINK_FAILED"));
								else resolve();
							};
							// Handed over, not copied, when the message owns its memory whole; a copy of it otherwise (a small
							// message in Node's shared pool must not take the pool with it).
							const own =
								message.byteOffset === 0 &&
								message.byteLength === message.buffer.byteLength &&
								message.buffer instanceof ArrayBuffer
									? message.buffer
									: message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
							port.postMessage({ t: "send", m: id, b: own }, [own as ArrayBuffer]);
						}),
				};
				void desktop.watch(release, sink, member.stop.signal).then((reason) => {
					members.delete(id);
					port.postMessage({ t: "done", m: id, r: reason });
				});
				return;
			}
		}
	});
}
