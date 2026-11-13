import { CloudRpcError } from "../cloud/client.ts";
import type { ScreensInUse } from "../cloud/screens-in-use.ts";

/* Which of the company's agents use their desktop computers now (migration 20260930742000; Jonas, 13 Nov 2026: the
 * computer's window shows by itself in the agent's thread, and its figure in the rail shows it "like it's gaming").
 *
 * The database says it: an agent's own screen call within its window, on a running machine no member holds privately.
 * This page reads that list when the company opens, when a `machines` hint comes (the database sends one at every new
 * stretch of an agent's use), when the page comes back, and once more at the end of an entry's window, where the entry
 * goes unless the read finds a newer call. So while nobody uses a computer nothing is read, and while someone does, about
 * one read a minute. The window's length is the database's alone: each entry carries its end. */

export interface AgentAtComputer {
	machineId: string;
	/** When this stretch of use began (the database's time): a new value is a new stretch. */
	since: string;
	/** The end of the entry, on this page's clock (ms). */
	until: number;
}

/** By staff agent id. */
export type AgentsAtComputers = Readonly<Record<string, AgentAtComputer>>;

/** How long after an entry's end the list is read again (the database's clock and this page's may differ a little). */
export const READ_PAST_END_MS = 1000;
/** A burst of `machines` hints is one read. */
export const HINT_SETTLE_MS = 300;
/** After a failed read, the next try: then twice as long each time, up to RETRY_MAX_MS, until a read answers. A read
 * that fails never ends the watch: an agent may still be at its computer, and its stretch sends no new hint. */
export const RETRY_MS = 15_000;
export const RETRY_MAX_MS = 60_000;

export interface AtComputerWatchOptions {
	read(): Promise<ScreensInUse>;
	onChange(agents: AgentsAtComputers): void;
	/** The cloud has no such list (before 20260930742000): nothing is shown, and nothing is read again. */
	onUnavailable(): void;
	/** A read now would be for nobody (a hidden tab with live hints): it waits for the page's return. */
	resting?(): boolean;
	now?(): number;
}

export class AtComputerWatch {
	readonly #options: AtComputerWatchOptions;
	#agents: AgentsAtComputers = {};
	#timer: ReturnType<typeof setTimeout> | undefined;
	#hint: ReturnType<typeof setTimeout> | undefined;
	#reading = false;
	/** Reads that failed in a row. */
	#failures = 0;
	#again = false;
	#owed = false;
	#done = false;

	constructor(options: AtComputerWatchOptions) {
		this.#options = options;
	}

	get agents(): AgentsAtComputers {
		return this.#agents;
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}

	/** Reads the list now (one read at a time; a call meanwhile reads once more after it). */
	read(): void {
		if (this.#done) return;
		if (this.#options.resting?.()) {
			this.#owed = true;
			this.#expire();
			return;
		}
		if (this.#reading) {
			this.#again = true;
			return;
		}
		this.#reading = true;
		this.#owed = false;
		void this.#options.read().then(
			(answer) => {
				this.#reading = false;
				if (this.#done) return;
				this.#failures = 0;
				this.#take(answer);
				this.#next();
			},
			(error: unknown) => {
				this.#reading = false;
				if (this.#done) return;
				if (error instanceof CloudRpcError && error.missing) {
					this.dispose();
					this.#agents = {};
					this.#options.onUnavailable();
					return;
				}
				this.#expire();
				this.#failures++;
				this.#next(Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (this.#failures - 1)));
			},
		);
	}

	/** A `machines` hint: an agent may have begun a stretch. */
	hinted(): void {
		if (this.#done || this.#hint) return;
		this.#hint = setTimeout(() => {
			this.#hint = undefined;
			this.read();
		}, HINT_SETTLE_MS);
	}

	/** The page is shown again: a read it skipped while hidden is made now. */
	returned(): void {
		if (this.#owed) this.read();
	}

	dispose(): void {
		this.#done = true;
		clearTimeout(this.#timer);
		clearTimeout(this.#hint);
		this.#timer = this.#hint = undefined;
	}

	#take(answer: ScreensInUse): void {
		const now = this.#now();
		// The database's clock against this page's: each end is placed on this page's clock.
		const offset = Date.parse(answer.now) - now;
		const agents: Record<string, AgentAtComputer> = {};
		for (const screen of answer.screens) {
			const until = Date.parse(screen.until) - offset;
			if (!(until > now)) continue;
			// An agent at two computers: the one it used last.
			const known = agents[screen.staffAgentId];
			if (known && known.until >= until) continue;
			agents[screen.staffAgentId] = { machineId: screen.machineId, since: screen.since, until };
		}
		this.#set(agents);
	}

	/** Entries past their end go. */
	#expire(): void {
		const now = this.#now();
		const kept = Object.fromEntries(Object.entries(this.#agents).filter(([, agent]) => agent.until > now));
		if (Object.keys(kept).length !== Object.keys(this.#agents).length) this.#set(kept);
	}

	#set(agents: AgentsAtComputers): void {
		if (JSON.stringify(agents) === JSON.stringify(this.#agents)) return;
		this.#agents = agents;
		this.#options.onChange(agents);
	}

	/** The next read: a coalesced call at once, else at the soonest entry's end or after `retry` (a failed read's),
	 * whichever is first, else none (a read answered and nobody is at a computer). */
	#next(retry?: number): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#again) {
			this.#again = false;
			this.read();
			return;
		}
		const ends = Object.values(this.#agents).map((agent) => agent.until);
		const end = ends.length ? Math.max(0, Math.min(...ends) - this.#now()) + READ_PAST_END_MS : undefined;
		const wait = end === undefined ? retry : retry === undefined ? end : Math.min(end, retry);
		if (wait === undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#expire();
			this.read();
		}, wait);
	}
}
