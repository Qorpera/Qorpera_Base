import type { MemberAgentMachines, MemberDesktopHold } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { WebCompanyComputer } from "../../cloud/computer.ts";

/** The waits before a hand-back that was not answered is asked again: 2, 4, 8, then 15 s. */
export const RELEASE_RETRY_MS = [2000, 4000, 8000, 15_000];
/** The own deadline of a take-over, a hand-back and the ledger's own list reads: none is a window's. */
export const HOLD_CALL_MS = 15_000;
/** The most take-over attempts one hand-back names (the database's own limit). */
const NAMED_MAX = 32;
/** How many hand-backs one "give it all back" asks in a row for a machine (attempts called off while one is on its way
 * need another) before it says no. */
const SETTLE_ROUNDS = 4;
/** How many times one "give it all back" reads the member's list again after a hand-back said they still hold a
 * machine by an attempt it did not name (another tab of theirs, an earlier page). */
const ELSEWHERE_ROUNDS = 2;

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
	/** The page's own uuid for one take-over (version 7: its time, by the database's clock as the page knows it), sent
	 * with it and named in the hand-back that calls it off; or the attempt the member's list names as holding a lease
	 * of theirs that this page did not make. */
	readonly id: string;
	/** queued: made, waiting for the machine's earlier hand-back before it is sent; taking: sent, no answer yet; held: the
	 * database gave the lease to it (its answer, or the member's own list naming it); maybe: its answer was lost. */
	state: "queued" | "taking" | "held" | "maybe";
	/** A hand-back was asked for it: it is never sent (when still queued), never used nor renewed, and it goes only once
	 * a hand-back naming it was answered. */
	calledOff: boolean;
	/** When its state last changed: a list read asked before then says nothing of it. */
	changedAt: number;
}
interface Hold {
	readonly machineId: string;
	/** The agents whose windows took it over or took it up (one machine may be on two agents' lists): each agent's
	 * take-over card asks the ledger by its own id. */
	readonly agents: Set<string>;
	/** Every take-over attempt for the machine that is not confirmed gone. */
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

/** A version 7 uuid of the time `ms` (milliseconds since the epoch, its first 48 bits), the rest random. */
export function desktopAttempt(ms: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let time = Math.max(0, Math.floor(ms));
	for (let index = 5; index >= 0; index--) {
		bytes[index] = time % 256;
		time = Math.floor(time / 256);
	}
	bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * What this member may hold of the company's desktops, for the page's lifetime (migration 20260930713000; reviews r2,
 * r3 and r4 of #1661). It is the company's (ComputerPanels), never a window's, so closing a window forgets nothing.
 *
 * Every take-over is one attempt: a version 7 uuid made and entered here before anything is awaited, also for a
 * take-over that must first wait for the machine's earlier hand-back. The database fences them: a hand-back names
 * attempts and calls them off for good under the machine's lock, and gives back only a lease one of them holds; a
 * take-over naming a called-off attempt, or one more than 2 minutes from the database's clock, is refused whenever it
 * arrives. So a hand-back's answer is the confirmation for the attempts it named, whatever the network did to them:
 * no list read is needed and nothing is guessed. The page makes its attempts' times by the database's clock, from the
 * time its latest list read answered.
 *
 * - A release of a machine (Hand back, the card's I'm done, a window's close, a change of the window's machine) calls
 *   off every attempt the ledger has for it, held, may be held, on its way or queued, and sends one hand-back naming
 *   them; it is asked again with growing waits (RELEASE_RETRY_MS) until answered, window or not. An attempt goes only
 *   when a hand-back naming it was answered, or when its own take-over was refused while no hand-back was asked for it.
 * - Hand back and I'm done also read the member's list first and name the attempt it shows holding each of the agent's
 *   machines (another tab of theirs, an earlier page); a hand-back that says the member still holds one by an attempt
 *   it did not name has the list read again.
 * - The member's own list names the attempt that holds each lease of theirs: a lost answer whose attempt the list names
 *   is held; a held attempt the list no longer names has lost its lease. A hold the list shows on a machine this page
 *   gave back is never taken up; one of an attempt this page does not know (the page was loaded again) may be.
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
	/** Machines a hand-back said the member still holds by an attempt it did not name, and the agents they were asked
	 * for. */
	readonly #elsewhere = new Map<string, Set<string>>();
	readonly #listeners = new Set<() => void>();
	readonly #newAttempt: (ms: number) => string;
	/** The database's clock less this page's, from the latest list read (milliseconds). */
	#offset = 0;
	/** The company's page is gone: nothing is asked any more. */
	#left = false;

	constructor(
		computer: WebCompanyComputer | undefined,
		signal?: AbortSignal,
		newAttempt: (ms: number) => string = desktopAttempt,
	) {
		this.#computer = computer;
		this.#newAttempt = newAttempt;
		if (signal?.aborted) {
			this.#left = true;
			return;
		}
		// The page goes for good (or into the browser's cache): everything is asked back as it goes, and stays here until
		// a hand-back is answered, should the page come back.
		if (typeof window !== "undefined")
			window.addEventListener("pagehide", () => this.#hidden(), signal ? { signal } : undefined);
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

	/** A take-over the member asked for on purpose, from this agent's window, of the machine chosen at the click. Its
	 * attempt is made and entered before anything is awaited; the machine's earlier hand-back is answered before it is
	 * sent, and it is not sent at all once it was called off meanwhile (review r3 F7). Refused as expired (this page's
	 * clock is off), it reads the database's time from the list and is sent once more as a fresh attempt. */
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
		let attempt: Attempt = {
			id: this.#newAttempt(Date.now() + this.#offset),
			state: "queued",
			calledOff: false,
			changedAt: Date.now(),
		};
		hold.attempts.set(attempt.id, attempt);
		// On purpose: this machine may be taken up again.
		this.#givenBack.delete(machineId);
		this.#changed();
		const entry = hold;
		const live = (one: Attempt) =>
			!this.#left && !entry.gone && this.#holds.get(machineId) === entry && entry.attempts.get(one.id) === one;
		if (this.#calling(entry) && !(await this.#settle(entry))) {
			// The earlier hand-back was not answered: this attempt is never sent, so it can hold nothing, and goes (unless a
			// hand-back names it meanwhile, which then confirms it).
			if (live(attempt) && !attempt.calledOff) this.#drop(entry, attempt);
			return { state: "releasing" };
		}
		for (let round = 0; ; round++) {
			if (!live(attempt) || attempt.calledOff) return { state: "called-off" };
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
			// Called off while it was on its way: the hand-back that names it ends whatever it got and confirms it; until
			// that is answered it stays, refused or not (review r4).
			if (!live(attempt) || attempt.calledOff) return { state: "called-off" };
			if (answer?.state === "ok") {
				attempt.state = "held";
				this.#changed();
				return { state: "ok" };
			}
			if (answer?.state === "refused" && answer.reason === "TAKE_EXPIRED" && round === 0) {
				// This page's clock is off: the database's time from the list, then a fresh attempt in its place (the
				// refused one can never take). It stays the machine's slot meanwhile, so a release meanwhile calls it off.
				attempt.state = "queued";
				await this.#readClock(agentId);
				if (!live(attempt) || attempt.calledOff) return { state: "called-off" };
				const fresh: Attempt = {
					id: this.#newAttempt(Date.now() + this.#offset),
					state: "queued",
					calledOff: false,
					changedAt: Date.now(),
				};
				entry.attempts.delete(attempt.id);
				entry.attempts.set(fresh.id, fresh);
				attempt = fresh;
				continue;
			}
			if (answer?.state === "refused") {
				// Refused while no hand-back was asked for it: it holds nothing, ever.
				this.#drop(entry, attempt);
				return answer;
			}
			// Lost: the database may have given it. Kept as such until the list names it, or a hand-back names it.
			attempt.state = "maybe";
			this.#changed();
			return { state: "uncertain" };
		}
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
	 * until answered (window or not). Nothing is sent when the ledger has none. */
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

	/** The window's machine changed (review r4 F8): every machine of this agent's in the ledger but the one now chosen
	 * is given back, whatever its state and whatever the window believes. */
	releaseOthers(agentId: string, keep: string | undefined): void {
		for (const hold of [...this.#holds.values()])
			if (hold.agents.has(agentId) && hold.machineId !== keep) this.release(hold.machineId, agentId);
	}

	/** Everything this agent's windows may hold, given back: true once every hand-back was answered and nothing of the
	 * agent's is in the ledger; false while one is not answered (asked again meanwhile; the lease also ends by itself in
	 * 5 minutes). With `elsewhere` (Hand back, I'm done) it first reads the member's list and names, too, the attempt it
	 * shows holding each of the agent's machines, and reads it again when a hand-back says the member still holds one by
	 * an attempt it did not name; without a list it says no. */
	async releaseAgent(agentId: string, reason: Hold["reason"] = "handed_back", elsewhere = false): Promise<boolean> {
		for (let round = 0; round < ELSEWHERE_ROUNDS; round++) {
			const listed = elsewhere ? await this.#nameElsewhere(agentId) : true;
			const holds = [...this.#holds.values()].filter((hold) => hold.agents.has(agentId));
			for (const hold of holds) this.release(hold.machineId, agentId, reason);
			const settled = (await Promise.all(holds.map((hold) => this.#settle(hold)))).every(Boolean);
			if (!listed || !settled) return false;
			if (!elsewhere || ![...this.#elsewhere.values()].some((agents) => agents.has(agentId)))
				return !this.has(agentId);
		}
		return false;
	}

	/** A list read of an agent's machines, asked at `askedAt` and answered at `answeredAt`: the database's time, a lost
	 * answer whose attempt holds the member's lease (held), and a held attempt that no longer holds it (it lost it:
	 * lapsed, idle, or a newer take-over of the member's). Attempts called off, or on their way, wait for their own
	 * answers. */
	listed(list: MemberAgentMachines, askedAt: number, answeredAt: number): void {
		this.#clock(list, askedAt, answeredAt);
		let changed = false;
		for (const row of list.machines) {
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

	/** As the page is hidden for good or put in the browser's cache: every machine is given back, as a release does, and
	 * also asked back in a request the browser finishes after the page. Its attempts stay until a hand-back naming them
	 * is answered, so a page that comes back from the cache confirms them as ever before I'm done answers. */
	#hidden(): void {
		if (this.#left) return;
		for (const hold of [...this.#holds.values()]) {
			if (!hold.attempts.size) continue;
			this.release(hold.machineId);
			this.#computer?.handBackOnLeave(hold.machineId, [...hold.attempts.keys()].slice(0, NAMED_MAX));
		}
	}

	/** As the company's page is left for good (or its access is gone): each machine is asked back once more, naming its
	 * attempts, in a request the browser finishes after the page; nothing waits for it, and nothing is kept. */
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

	/** The database's clock less this page's, from a list answered between `askedAt` and `answeredAt`. */
	#clock(list: MemberAgentMachines, askedAt: number, answeredAt: number): void {
		const server = list.serverNow === null ? Number.NaN : Date.parse(list.serverNow);
		if (Number.isFinite(server)) this.#offset = server - (askedAt + answeredAt) / 2;
	}

	/** Reads the agent's list for the database's time alone; a failed read leaves the clock as it was. */
	async #readClock(agentId: string): Promise<void> {
		const computer = this.#computer;
		if (!computer) return;
		const asked = Date.now();
		try {
			this.#clock(await computer.agentMachines(agentId, AbortSignal.timeout(HOLD_CALL_MS)), asked, Date.now());
		} catch {
			// The clock stays as it was.
		}
	}

	/** Reads the agent's list and enters the attempt it shows holding each of the agent's machines, so the hand-back
	 * names it too (another tab's, an earlier page's). False when the list could not be read. */
	async #nameElsewhere(agentId: string): Promise<boolean> {
		const computer = this.#computer;
		if (!computer || this.#left) return false;
		const asked = Date.now();
		let list: MemberAgentMachines;
		try {
			list = await computer.agentMachines(agentId, AbortSignal.timeout(HOLD_CALL_MS));
		} catch {
			return false;
		}
		this.#clock(list, asked, Date.now());
		// The list is the word on what the member holds elsewhere: a machine it shows no hold of theirs on is no longer so.
		for (const [machineId, agents] of [...this.#elsewhere]) {
			const row = list.machines.find((machine) => machine.machineId === machineId);
			if (row?.control?.mine === true || !agents.has(agentId)) continue;
			agents.delete(agentId);
			if (!agents.size) this.#elsewhere.delete(machineId);
		}
		for (const row of list.machines) {
			const attempt = row.control?.mine === true ? row.control.attempt : null;
			if (!attempt || this.#left) continue;
			const hold = this.#holds.get(row.machineId) ?? this.#entry(row.machineId);
			hold.agents.add(agentId);
			if (!hold.attempts.has(attempt))
				hold.attempts.set(attempt, { id: attempt, state: "held", calledOff: false, changedAt: Date.now() });
		}
		this.#changed();
		return true;
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
	 * that none of those attempts holds the machine or ever will: they are done. Not answered: asked again after a wait. */
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
				const answer = await computer.handBackDesktop(
					hold.machineId,
					hold.reason,
					named,
					AbortSignal.timeout(HOLD_CALL_MS),
				);
				hold.asking = undefined;
				hold.failed = false;
				hold.tries = 0;
				if (answer.heldElsewhere) this.#elsewhere.set(hold.machineId, new Set(hold.agents));
				else this.#elsewhere.delete(hold.machineId);
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
