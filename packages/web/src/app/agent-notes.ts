import type { CloudRoutine } from "@qorpera/cloud-client/cloud-routines";

/* What the rail says of an agent between runs (Jonas, 11 Nov 2026: the line under an agent's name was empty unless it
 * worked, and its last message is not worth much there): its next planned run, from the company's routines. They are
 * read with the member's own access, once when the company opens and again after a change hint of its folder
 * (routines are files of it) or when the window comes back, and also when a listed next run has passed, since a run
 * moves it without a file change. app/agent-line.ts picks the one line the rail shows.
 *
 * The agent's wall (QorperaOS/agents/<handle>/wall.md) is no longer read here: its Now line, what waited on a member
 * and what the agent last got done went with the wall (Jonas, 14 Nov 2026: "rather drop the wall - it's the wrong
 * medium for activity"; of the Now line: "Let it go too"). */

/** One agent's note. */
export interface AgentNote {
	/** Its active routine that runs next. */
	readonly next?: { readonly title: string; readonly at: string };
}

export type AgentNotesState = Readonly<Record<string, AgentNote>>;

type ListedRoutine = Pick<CloudRoutine, "status" | "staffAgentId" | "title" | "nextRunAt"> &
	Partial<Pick<CloudRoutine, "triggers">>;

/** Each agent's active routine that runs next, after `now`. */
export function nextRuns(routines: readonly ListedRoutine[], now: number): Map<string, { title: string; at: string }> {
	const next = new Map<string, { title: string; at: string }>();
	for (const routine of routines) {
		if (routine.status !== "active" || !routine.nextRunAt) continue;
		const at = Date.parse(routine.nextRunAt);
		if (!Number.isFinite(at) || at <= now) continue;
		const known = next.get(routine.staffAgentId);
		if (!known || at < Date.parse(known.at))
			next.set(routine.staffAgentId, { title: routine.title.trim(), at: routine.nextRunAt });
	}
	return next;
}

/** An active routine on a clock whose next run the cloud has not worked out yet: none listed (a schedule just saved
 * waits for the scheduler) or one that has passed (its occurrence still waits). The scheduler moves it on without a
 * file change, so nothing else says when to look again. */
export function unsettledRuns(routines: readonly ListedRoutine[], now: number): boolean {
	return routines.some(
		(routine) =>
			routine.status === "active" &&
			(routine.triggers ?? []).some((trigger) => trigger.kind === "schedule" || trigger.kind === "once") &&
			(!routine.nextRunAt || !(Date.parse(routine.nextRunAt) > now)),
	);
}

export interface AgentNotesSource {
	/** The active agents of the company. */
	agents(): readonly string[];
	listRoutines(): Promise<readonly ListedRoutine[]>;
	readonly signal: AbortSignal;
}

/** A change hint is read for after this long, so a burst of writes is one read. */
const SETTLE_MS = 1_500;
/** The least time between two reads of everything. */
const SPACING_MS = 15_000;
/** A next run is listed again this long after its time, once the run has moved it. */
const AFTER_RUN_MS = 90_000;
/** The longest a timer for a next run waits (a timer can't wait weeks). */
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** How often the routines are listed again while a next run is unsettled. */
const UNSETTLED_MS = 5 * 60 * 1000;

/** The company's agent notes, kept current while the company is open. */
export class AgentNotes {
	readonly #source: AgentNotesSource;
	readonly #publish: (notes: AgentNotesState) => void;
	#next = new Map<string, { title: string; at: string }>();
	#unsettled = false;
	/** The agents the last read was for: when the roster changes, the new ones are read at once. */
	#readFor = "";
	#shown = "";
	#timer: ReturnType<typeof setTimeout> | undefined;
	#nextTimer: ReturnType<typeof setTimeout> | undefined;
	#lastRead = 0;
	#reading: Promise<void> | undefined;
	#again = false;
	#disposed = false;

	constructor(source: AgentNotesSource, publish: (notes: AgentNotesState) => void) {
		this.#source = source;
		this.#publish = publish;
		source.signal.addEventListener("abort", () => this.dispose(), { once: true });
	}

	open(): void {
		void this.#read();
	}

	/** The company's agents may have changed (the roster arrives after the company opens, an agent is hired): a new
	 * set is read at once. */
	agentsChanged(): void {
		if (this.#disposed || this.#source.agents().join("\n") === this.#readFor) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		void this.#read();
	}

	/** The folder changed, or the window came back: read again once things settle. */
	changed(): void {
		if (this.#disposed || this.#timer) return;
		const wait = Math.max(SETTLE_MS, this.#lastRead + SPACING_MS - Date.now());
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#read();
		}, wait);
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		clearTimeout(this.#nextTimer);
		this.#timer = this.#nextTimer = undefined;
	}

	async #read(): Promise<void> {
		if (this.#disposed) return;
		// One read at a time; a hint meanwhile reads once more after it.
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		this.#lastRead = Date.now();
		this.#reading = this.#readAll().finally(() => {
			this.#reading = undefined;
			if (this.#disposed) return;
			const again = this.#again;
			this.#again = false;
			// Agents that came meanwhile are read now; a hint meanwhile once things settle.
			if (this.#source.agents().join("\n") !== this.#readFor) void this.#read();
			else if (again) this.changed();
		});
		return this.#reading;
	}

	async #readAll(): Promise<void> {
		const { signal } = this.#source;
		const agents = this.#source.agents();
		this.#readFor = agents.join("\n");
		await this.#source.listRoutines().then(
			(listed) => {
				this.#next = nextRuns(listed, Date.now());
				this.#unsettled = unsettledRuns(listed, Date.now());
			},
			() => {},
		);
		if (this.#disposed || signal.aborted) return;
		this.#emit(agents);
		this.#watchNextRun();
	}

	#emit(agents: readonly string[]): void {
		const notes: Record<string, AgentNote> = {};
		for (const id of agents) {
			const next = this.#next.get(id);
			if (next) notes[id] = { next };
		}
		const shown = JSON.stringify(notes);
		if (shown === this.#shown) return;
		this.#shown = shown;
		this.#publish(notes);
	}

	/** Lists the routines again once the soonest next run has run (the run moves it on), and every few minutes while a
	 * next run is unsettled. */
	#watchNextRun(): void {
		clearTimeout(this.#nextTimer);
		this.#nextTimer = undefined;
		const soonest = Math.min(...[...this.#next.values()].map((next) => Date.parse(next.at)));
		const waits = [
			...(Number.isFinite(soonest) ? [Math.max(0, soonest - Date.now()) + AFTER_RUN_MS] : []),
			...(this.#unsettled ? [UNSETTLED_MS] : []),
		];
		if (!waits.length) return;
		const wait = Math.min(MAX_WAIT_MS, ...waits);
		this.#nextTimer = setTimeout(() => {
			this.#nextTimer = undefined;
			void this.#read();
		}, wait);
	}
}
