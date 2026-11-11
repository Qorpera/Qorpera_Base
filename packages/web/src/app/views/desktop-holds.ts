import type { MemberAgentMachine, MemberDesktopHold } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { WebCompanyComputer } from "../../cloud/computer.ts";

/** The waits before a hand-back that was not answered is asked again: 2, 4, 8, then 15 s. */
export const RELEASE_RETRY_MS = [2000, 4000, 8000, 15_000];
/** The own deadline of a take-over and of a hand-back: neither is a window's. */
export const HOLD_CALL_MS = 15_000;
/** The most take-over attempts one hand-back names (the database's own limit). */
const NAMED_MAX = 32;
/** How many hand-backs one "give it all back" asks in a row (attempts called off while one is on its way need another)
 * before it says no. */
const SETTLE_ROUNDS = 4;

/** A take-over as the ledger answers it: held; refused (the database said why); uncertain (the answer was lost: the
 * machine may be held); called off (a hand-back was asked for it meanwhile: whatever it got goes back with that); or
 * not sent, because the machine's earlier hand-back is not answered yet. */
export type DesktopTake =
	| { readonly state: "ok" }
	| Extract<MemberDesktopHold, { state: "refused" }>
	| { readonly state: "uncertain" }
	| { readonly state: "called-off" }
	| { readonly state: "releasing" };

/** How a machine's hand-back stands: on its way, not answered (asked again after a wait), or waiting to be asked. */
export type DesktopRelease = "asking" | "failed" | "pending";

interface Attempt {
	/** The page's own uuid for one take-over, sent with it and named in the hand-back that calls it off. */
	readonly id: string;
	/** queued: made, waiting for the machine's earlier hand-back before it is sent; taking: sent, no answer yet; held: the
	 * database gave the lease to it (its answer, or the member's own list naming it); maybe: its answer was lost. */
	state: "queued" | "taking" | "held" | "maybe";
	/** A hand-back was asked for it: it is never sent (when still queued), never used nor renewed, and it goes once a
	 * hand-back naming it was answered. */
	calledOff: boolean;
	/** When its state last changed: a list read asked before then says nothing of it. */
	changedAt: number;
}
interface Hold {
	readonly machineId: string;
	/** The agents whose windows took it over or took it up (one machine may be on two agents' lists): each agent's
	 * take-over card asks the ledger by its own id. */
	readonly agents: Set<string>;
	/** Every take-over attempt of this page for the machine that is not confirmed gone. */
	readonly attempts: Map<string, Attempt>;
	/** What the database records for the hand-back: the member's word, or a window that closed. */
	reason: "handed_back" | "closed";
	/** The hand-back on its way. */
	asking?: Promise<boolean>;
	tries: number;
	failed: boolean;
	timer?: ReturnType<typeof setTimeout>;
	/** The page went (or the company was left) while a take-over was on its way. */
	gone?: boolean;
}

/**
 * What this member may hold of the company's desktops, for the page's lifetime (migration 20260930713000; reviews r2
 * and r3 of #1661). It is the company's (ComputerPanels), never a window's, so closing a window forgets nothing.
 *
 * Every take-over is one attempt: a uuid made and entered here before anything is awaited, also for a take-over that
 * must first wait for the machine's earlier hand-back. The database fences them: a hand-back names attempts and calls
 * them off for good under the machine's lock, ends the member's lease there, and a take-over naming a called-off attempt
 * is refused whenever it arrives. So the hand-back's answer is the confirmation, whatever the network did to a
 * take-over: no list read is needed and nothing is guessed.
 *
 * - A release of a machine (Hand back, the card's I'm done, a window's close, a switch to another machine) calls off
 *   every attempt the ledger has for it, held, may be held, on its way or queued, and sends one hand-back naming them;
 *   it is asked again with growing waits (RELEASE_RETRY_MS) until answered, window or not. When it is answered, those
 *   attempts are done; a queued one is never sent.
 * - A take-over's answer for an attempt called off meanwhile is nothing to act on: the hand-back covers it.
 * - The member's own list names the attempt that holds each lease of theirs: a lost answer whose attempt the list names
 *   is held; a held attempt the list no longer names has lost its lease. A hold the list shows on a machine this page
 *   gave back is never taken up; one of an attempt this page does not know (the page was loaded again) may be.
 * - The take-over card asks it, not a window: I'm done answers only once nothing of that agent's is in it.
 * - As the page goes (pagehide, or the company's page left), each machine is asked back once more, naming its attempts,
 *   in a request the browser finishes after the page. The lease's own end, 5 minutes without a heartbeat, stays the
 *   last word.
 */
export class DesktopHoldLedger {
	readonly #computer: WebCompanyComputer | undefined;
	readonly #holds = new Map<string, Hold>();
	/** Machines whose hand-back was asked in this page's lifetime: a hold a list shows there is never taken up, unless
	 * the member took the machine over again on purpose. */
	readonly #givenBack = new Set<string>();
	readonly #listeners = new Set<() => void>();
	readonly #newAttempt: () => string;
	/** The company's page is gone: nothing is asked any more. */
	#left = false;

	constructor(
		computer: WebCompanyComputer | undefined,
		signal?: AbortSignal,
		newAttempt: () => string = () => crypto.randomUUID(),
	) {
		this.#computer = computer;
		this.#newAttempt = newAttempt;
		if (signal?.aborted) {
			this.#left = true;
			return;
		}
		// The page goes for good (or into the browser's cache): everything is asked back as it goes.
		if (typeof window !== "undefined")
			window.addEventListener("pagehide", () => this.leave(), signal ? { signal } : undefined);
		signal?.addEventListener(
			"abort",
			() => {
				this.#left = true;
				this.leave();
			},
			{ once: true },
		);
	}

	/** Calls `listener` whenever what the ledger holds changes. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Whether anything of this agent's may be held: an attempt held, may be held, on its way, queued or called off and
	 * not yet confirmed. */
	has(agentId: string): boolean {
		return [...this.#holds.values()].some((hold) => hold.agents.has(agentId));
	}

	/** How this machine's hand-back stands, while one was asked and is not answered yet. */
	releasing(machineId: string): DesktopRelease | undefined {
		const hold = this.#holds.get(machineId);
		if (!hold || !this.#calling(hold)) return undefined;
		return hold.asking ? "asking" : hold.failed ? "failed" : "pending";
	}

	/** The attempt whose hold a window may use and renew on this machine: held, and no hand-back asked for the machine. */
	holder(machineId: string): string | undefined {
		const hold = this.#holds.get(machineId);
		if (!hold || this.#calling(hold)) return undefined;
		let holder: string | undefined;
		for (const attempt of hold.attempts.values()) if (attempt.state === "held") holder = attempt.id;
		return holder;
	}

	/** A take-over the member asked for on purpose, from this agent's window. Its attempt is made and entered before
	 * anything is awaited; the machine's earlier hand-back is answered before it is sent, and it is not sent at all once
	 * it was called off meanwhile (review r3 F7). */
	async take(machineId: string, agentId: string): Promise<DesktopTake> {
		const computer = this.#computer;
		if (!computer || this.#left) return { state: "uncertain" };
		let hold = this.#holds.get(machineId);
		if (hold && this.holder(machineId)) {
			// Another of the member's windows holds it already: it is this one's too.
			hold.agents.add(agentId);
			return { state: "ok" };
		}
		hold ??= this.#entry(machineId);
		hold.agents.add(agentId);
		const attempt: Attempt = { id: this.#newAttempt(), state: "queued", calledOff: false, changedAt: Date.now() };
		hold.attempts.set(attempt.id, attempt);
		// On purpose: this machine may be taken up again.
		this.#givenBack.delete(machineId);
		this.#changed();
		const entry = hold;
		const live = () =>
			!this.#left && !entry.gone && this.#holds.get(machineId) === entry && entry.attempts.has(attempt.id);
		if (this.#calling(entry) && !(await this.#settle(entry))) {
			// The earlier hand-back was not answered: this attempt is never sent, so it can hold nothing, and goes (unless a
			// hand-back names it meanwhile, which then confirms it).
			if (live() && !attempt.calledOff) this.#drop(entry, attempt);
			return { state: "releasing" };
		}
		if (!live() || attempt.calledOff) return { state: "called-off" };
		attempt.state = "taking";
		attempt.changedAt = Date.now();
		this.#changed();
		let answer: MemberDesktopHold | undefined;
		try {
			answer = await computer.takeDesktop(machineId, attempt.id, AbortSignal.timeout(HOLD_CALL_MS));
		} catch {
			answer = undefined;
		}
		attempt.changedAt = Date.now();
		if (entry.gone) {
			// The page went (or the company was left) meanwhile: what it got goes back in a request that outlives it.
			if (answer?.state === "ok") computer.handBackOnLeave(machineId, [attempt.id]);
			return { state: "called-off" };
		}
		if (!live()) return { state: "called-off" };
		if (attempt.calledOff) {
			// Called off while it was on its way: the hand-back that names it ends whatever it got. A refusal held nothing.
			if (answer?.state === "refused") this.#drop(entry, attempt);
			return { state: "called-off" };
		}
		if (answer?.state === "ok") {
			attempt.state = "held";
			this.#changed();
			return { state: "ok" };
		}
		if (answer?.state === "refused") {
			this.#drop(entry, attempt);
			return answer;
		}
		// Lost: the database may have given it. Kept as such until the list names it, or a hand-back names it.
		attempt.state = "maybe";
		this.#changed();
		return { state: "uncertain" };
	}

	/** A hold of this member's that the list shows on this agent's machine, by the attempt that holds it, and that no
	 * window knows (the page was loaded again): true, it is the window's now. False on a machine this page gave back (and
	 * did not take over again), while a hand-back or a take-over of it is on its way, or without an attempt. */
	adopt(machineId: string, agentId: string, attemptId: string | null): boolean {
		if (this.#left || !attemptId || this.#givenBack.has(machineId)) return false;
		const hold = this.#holds.get(machineId) ?? this.#entry(machineId);
		if (this.#calling(hold)) return false;
		const known = hold.attempts.get(attemptId);
		if (known && (known.state === "queued" || known.state === "taking")) return false;
		if (known) {
			known.state = "held";
			known.changedAt = Date.now();
		} else hold.attempts.set(attemptId, { id: attemptId, state: "held", calledOff: false, changedAt: Date.now() });
		hold.agents.add(agentId);
		this.#changed();
		return true;
	}

	/** The attempt's hold ended by itself (a heartbeat or an action was told so): it goes, unless a hand-back names it. */
	ended(machineId: string, attemptId: string): void {
		const hold = this.#holds.get(machineId);
		const attempt = hold?.attempts.get(attemptId);
		if (hold && attempt && !attempt.calledOff) this.#drop(hold, attempt);
	}

	/** Gives this machine back: every attempt the ledger has for it is called off and named in one hand-back, asked again
	 * until answered (window or not). Nothing to do when the ledger has none. */
	release(machineId: string, agentId?: string, reason: Hold["reason"] = "handed_back"): void {
		if (this.#left || !this.#computer) return;
		const hold = this.#holds.get(machineId);
		if (!hold?.attempts.size) return;
		if (agentId) hold.agents.add(agentId);
		this.#givenBack.add(machineId);
		if (!this.#calling(hold)) hold.reason = reason;
		for (const attempt of hold.attempts.values()) attempt.calledOff = true;
		this.#changed();
		void this.#ask(hold);
	}

	/** Everything this agent's windows may hold, given back: true once every hand-back was answered and nothing of the
	 * agent's is in the ledger; false while one is not answered (asked again meanwhile; the lease also ends by itself in
	 * 5 minutes). */
	async releaseAgent(agentId: string, reason: Hold["reason"] = "handed_back"): Promise<boolean> {
		const holds = [...this.#holds.values()].filter((hold) => hold.agents.has(agentId));
		for (const hold of holds) this.release(hold.machineId, agentId, reason);
		const settled = await Promise.all(holds.map((hold) => this.#settle(hold)));
		return settled.every(Boolean) && !this.has(agentId);
	}

	/** A list read of an agent's machines, asked at `askedAt`: a lost answer whose attempt holds the member's lease is
	 * held; a held attempt that no longer holds it lost it (lapsed, idle, or a newer take-over of the member's). Attempts
	 * called off, or on their way, wait for their own answers. */
	listed(machines: readonly MemberAgentMachine[], askedAt: number): void {
		let changed = false;
		for (const row of machines) {
			const hold = this.#holds.get(row.machineId);
			if (!hold) continue;
			const holding = row.control?.mine === true ? row.control.attempt : null;
			for (const attempt of [...hold.attempts.values()]) {
				if (attempt.calledOff || askedAt < attempt.changedAt) continue;
				if (attempt.id === holding && attempt.state === "maybe") {
					attempt.state = "held";
					attempt.changedAt = Date.now();
					changed = true;
				} else if (attempt.id !== holding && attempt.state === "held") {
					hold.attempts.delete(attempt.id);
					changed = true;
				}
			}
			if (!hold.attempts.size) this.#holds.delete(row.machineId);
		}
		if (changed) this.#changed();
	}

	/** As the page goes: each machine is asked back once more, naming its attempts, in a request the browser finishes after
	 * the page; nothing waits for it. The machines count as given back in this page's lifetime. */
	leave(): void {
		if (!this.#holds.size) return;
		for (const hold of this.#holds.values()) {
			hold.gone = true;
			clearTimeout(hold.timer);
			this.#givenBack.add(hold.machineId);
			this.#computer?.handBackOnLeave(hold.machineId, [...hold.attempts.keys()].slice(0, NAMED_MAX));
		}
		this.#holds.clear();
		this.#changed();
	}

	#entry(machineId: string): Hold {
		const hold: Hold = {
			machineId,
			agents: new Set(),
			attempts: new Map(),
			reason: "handed_back",
			tries: 0,
			failed: false,
		};
		this.#holds.set(machineId, hold);
		return hold;
	}

	/** Whether a hand-back is asked for the machine and not answered: some attempt of it is called off. */
	#calling(hold: Hold): boolean {
		for (const attempt of hold.attempts.values()) if (attempt.calledOff) return true;
		return false;
	}

	/** The attempt is done; the machine leaves once none is left. */
	#drop(hold: Hold, attempt: Attempt): void {
		hold.attempts.delete(attempt.id);
		if (!hold.attempts.size && this.#holds.get(hold.machineId) === hold) {
			clearTimeout(hold.timer);
			this.#holds.delete(hold.machineId);
		}
		this.#changed();
	}

	/** One hand-back naming the machine's called-off attempts, or the one on its way. Its answer is the database's word
	 * that the member holds nothing of the machine and none of those attempts ever will: they are done. Not answered:
	 * asked again after a wait. */
	#ask(hold: Hold): Promise<boolean> {
		if (hold.asking) return hold.asking;
		if (!this.#calling(hold)) return Promise.resolve(true);
		const computer = this.#computer;
		if (!computer || this.#left || this.#holds.get(hold.machineId) !== hold) return Promise.resolve(false);
		clearTimeout(hold.timer);
		hold.timer = undefined;
		const named = [...hold.attempts.values()]
			.filter((attempt) => attempt.calledOff)
			.slice(0, NAMED_MAX)
			.map((attempt) => attempt.id);
		const asking = (async () => {
			try {
				await computer.handBackDesktop(hold.machineId, hold.reason, named, AbortSignal.timeout(HOLD_CALL_MS));
				hold.asking = undefined;
				hold.failed = false;
				hold.tries = 0;
				for (const id of named) hold.attempts.delete(id);
				if (!hold.attempts.size && this.#holds.get(hold.machineId) === hold) this.#holds.delete(hold.machineId);
				// Attempts called off while it was on its way go in the next one.
				else if (this.#calling(hold)) void this.#ask(hold);
				this.#changed();
				return true;
			} catch {
				hold.asking = undefined;
				if (this.#holds.get(hold.machineId) !== hold || this.#left) return false;
				hold.failed = true;
				hold.tries++;
				hold.timer = setTimeout(() => void this.#ask(hold), this.#wait(hold.tries));
				this.#changed();
				return false;
			}
		})();
		hold.asking = asking;
		this.#changed();
		return asking;
	}

	/** The machine's hand-backs, asked now and waited for, a few rounds while attempts are called off meanwhile. True
	 * once no attempt of it is called off and unanswered. */
	async #settle(hold: Hold): Promise<boolean> {
		for (let round = 0; round < SETTLE_ROUNDS; round++) {
			if (this.#holds.get(hold.machineId) !== hold || !this.#calling(hold)) return true;
			if (!(await this.#ask(hold))) return false;
		}
		return this.#holds.get(hold.machineId) !== hold || !this.#calling(hold);
	}

	#wait(tries: number): number {
		return RELEASE_RETRY_MS[Math.min(Math.max(tries, 1), RELEASE_RETRY_MS.length) - 1] as number;
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}
