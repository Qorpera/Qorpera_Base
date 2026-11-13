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
	/** The least time between the starts of two releases, so a stream of output makes at most a few boundaries a second
	 * (each one publishes what the machine changed). The first after a quiet spell starts at once. */
	spacingMs: number;
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
	#lastStart = Number.NEGATIVE_INFINITY;

	constructor(options: HomeOutputGateOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
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
				const wait = this.#lastStart + this.#options.spacingMs - this.#now();
				if (wait > 0) await this.#sleep(wait);
				if (this.#closed) return;
				const batch = this.#waiting.splice(0);
				this.#lastStart = this.#now();
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
