// The agent's home in the company folder (lanes/agent-box-20261113, slice 3; migration 20260930754000).
//
// A home is a company machine whose /company is its boot's own company-wide view, as for `machine_run`. While a run's
// channel to it is open, two things make what the run does there the run's own in the folder, as a command's work is:
// - credit: the folder service holds a command window for the session, its id the session's, so what the machine
//   changes meanwhile is credited to the session's run, its agent and its member (SQL takes a session as a credit);
// - reads before output: what the machine sends back leaves only after a boundary released every read the machine was
//   served and the run took them in, as a command's output does. HomeOutputGate holds it until then.

import { UUID_PATTERN } from "@qorpera/contracts";

/** One home session as SQL answers the executor before its channel starts (qorpera_folder_home_session_window): the ids
 * its folder command window carries, and the boot it is on. */
export interface HomeFolderSession {
	readonly sessionId: string;
	readonly runId: string;
	readonly staffAgentId: string;
	readonly requestedByUserId: string;
	readonly machineId: string;
	readonly placementId: string;
	readonly bootId: string;
}

/** Why SQL refuses a session's channel: the session or its boot is over, or the run may not share this machine (another
 * member's, another worker access, or a run that does not read the whole company folder). */
export const HOME_FOLDER_REFUSALS = ["HOME_SESSION_ENDED", "HOME_NOT_SHARED"] as const;
export type HomeFolderRefusal = (typeof HOME_FOLDER_REFUSALS)[number];

export type HomeFolderAnswer =
	| { readonly state: "open"; readonly session: HomeFolderSession }
	| { readonly state: "refused"; readonly reason: HomeFolderRefusal };

const SESSION_KEYS = [
	"sessionId",
	"runId",
	"staffAgentId",
	"requestedByUserId",
	"machineId",
	"placementId",
	"bootId",
] as const;

/** Reads SQL's answer for the session the executor asked about, on the placement it was authorized on; anything else is
 * HOME_FOLDER_SESSION_INVALID. */
export function parseHomeFolderAnswer(
	value: unknown,
	request: { readonly sessionId: string; readonly placementId: string },
): HomeFolderAnswer {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HOME_FOLDER_SESSION_INVALID");
	const answer = value as Record<string, unknown>;
	if (answer.schema !== "qorpera.folder-home-session/v1") throw new Error("HOME_FOLDER_SESSION_INVALID");
	if (answer.state === "refused") {
		const reason = answer.reason;
		if (
			Object.keys(answer).length !== 3 ||
			typeof reason !== "string" ||
			!(HOME_FOLDER_REFUSALS as readonly string[]).includes(reason)
		)
			throw new Error("HOME_FOLDER_SESSION_INVALID");
		return { state: "refused", reason: reason as HomeFolderRefusal };
	}
	if (answer.state !== "open" || Object.keys(answer).length !== SESSION_KEYS.length + 2)
		throw new Error("HOME_FOLDER_SESSION_INVALID");
	const session: Record<string, string> = {};
	for (const key of SESSION_KEYS) {
		const id = answer[key];
		if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new Error("HOME_FOLDER_SESSION_INVALID");
		session[key] = id;
	}
	if (session.sessionId !== request.sessionId || session.placementId !== request.placementId)
		throw new Error("HOME_FOLDER_SESSION_INVALID");
	return { state: "open", session: session as unknown as HomeFolderSession };
}

export interface HomeOutputGateOptions {
	/** The company folder's release for the session's run: a boundary, then the run's take-in. Undefined: released;
	 * otherwise why it is held. */
	release(): Promise<string | undefined>;
	/** What may leave now, in the order the machine sent it. */
	pass(chunk: Buffer): void;
	/** A release held: nothing more leaves, and the channel ends (once). */
	fail(why: string): void;
	/** What a sustained stream of output may make: one release every `spacingMs` at most, so it makes at most a few
	 * boundaries a second (each one publishes what the machine changed). 0: no bound, one release as soon as the one
	 * before it ended. */
	spacingMs: number;
	/** How many releases may start without waiting, one given back every `spacingMs` up to this many (a token bucket;
	 * default 1: the first after a quiet spell at once, each later one `spacingMs` after the one before began). One shell
	 * command is three messages close together (the start's answer, its output, its exit): with 1, the second and the
	 * third each waited for the spacing, about 350 ms a command with nothing protected by the wait (C2's measurement,
	 * 14 Nov 2026: a `grep -rl` 479 ms through the gate against 130 ms without). A few in hand let such a short exchange
	 * pass at once, and a stream is still held to one release per `spacingMs`. */
	burst?: number;
	/** What may wait for a release before the channel ends instead. */
	limitBytes: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/** What a home sends back, held until the company folder released it: every chunk that arrived before a release began
 * leaves once that release answers, in order; chunks that arrive meanwhile wait for the next one. One release at a time,
 * so a busy channel batches its output. A release that holds ends the gate: nothing more leaves. */
export class HomeOutputGate {
	readonly #options: HomeOutputGateOptions;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	#waiting: Buffer[] = [];
	#bytes = 0;
	#draining: Promise<void> | undefined;
	#closed = false;
	readonly #burst: number;
	/** The releases in hand, and when they were last counted up. */
	#tokens: number;
	#counted: number;

	constructor(options: HomeOutputGateOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
		this.#burst = Math.max(1, Math.floor(options.burst ?? 1));
		this.#tokens = this.#burst;
		this.#counted = this.#now();
	}

	/** How long until a release may start: 0 when one is in hand, counted up to the burst since it was last counted. */
	#wait(): number {
		const now = this.#now();
		const spacing = this.#options.spacingMs;
		// Only time that moved forward counts: a clock set back gives nothing and takes nothing, so the longest wait
		// stays one spacing whatever the clock does (review r2 of #1821).
		const elapsed = Math.max(0, now - this.#counted);
		this.#tokens = spacing > 0 ? Math.min(this.#burst, this.#tokens + elapsed / spacing) : this.#burst;
		this.#counted = now;
		return this.#tokens >= 1 ? 0 : Math.ceil((1 - this.#tokens) * spacing);
	}

	push(chunk: Buffer): void {
		if (this.#closed) return;
		this.#waiting.push(chunk);
		this.#bytes += chunk.byteLength;
		if (this.#bytes > this.#options.limitBytes) {
			this.#stop("HOME_OUTPUT_UNRELEASED");
			return;
		}
		// Begun on a later turn, so the drain that clears #draining at its end is always the one set here.
		if (!this.#draining) this.#draining = Promise.resolve().then(() => this.#drain());
	}

	/** Once everything that came in has left or the gate ended. */
	async drained(): Promise<void> {
		while (this.#draining) await this.#draining;
	}

	/** The channel ends from the other side: nothing more leaves, and nothing is released for it. */
	close(): void {
		this.#closed = true;
		this.#waiting = [];
		this.#bytes = 0;
	}

	#stop(why: string): void {
		if (this.#closed) return;
		this.close();
		this.#options.fail(why);
	}

	async #drain(): Promise<void> {
		try {
			while (this.#waiting.length && !this.#closed) {
				for (let wait = this.#wait(); wait > 0; wait = this.#wait()) {
					await this.#sleep(wait);
					if (this.#closed) return;
				}
				if (this.#closed) return;
				this.#tokens -= 1;
				const batch = this.#waiting.splice(0);
				let held: string | undefined;
				try {
					held = await this.#options.release();
				} catch {
					held = "HOME_OUTPUT_UNRELEASED";
				}
				if (this.#closed) return;
				if (held !== undefined) {
					this.#stop(held);
					return;
				}
				for (const chunk of batch) {
					this.#bytes -= chunk.byteLength;
					this.#options.pass(chunk);
				}
			}
		} finally {
			this.#draining = undefined;
		}
	}
}
