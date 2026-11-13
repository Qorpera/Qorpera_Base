import type { MemberAgentMachines, MemberDesktopHold } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { WebCompanyComputer } from "../../cloud/computer.ts";

/** The waits before a hand-back that was not answered is asked again: 2, 4, 8, then 15 s. */
export const RELEASE_RETRY_MS = [2000, 4000, 8000, 15_000];
/** The own deadline of a take-over, a hand-back and the ledger's own list reads: none is a window's. */
export const HOLD_CALL_MS = 15_000;
/** How many hand-backs one "give it all back" waits for in a row for a machine before it says no. */
const SETTLE_ROUNDS = 3;
/** How many more rounds Hand back and I'm done read the list and hand back while something is still owed (another tab of
 * the member's taking the desktop again each time) before they say no. */
const HOLDING_ROUNDS = 3;

/** A take-over as the ledger answers it: held; refused (the database said why); uncertain (the answer was lost, or the
 * epoch could not be read: the machine may be held); called off (a release was asked meanwhile: its hand-back covers
 * whatever it got); or not sent, because the machine's earlier hand-back is not answered yet. */
export type DesktopTake =
	| { readonly state: "ok" }
	| Extract<MemberDesktopHold, { state: "refused" }>
	| { readonly state: "uncertain" }
	| { readonly state: "called-off" }
	| { readonly state: "releasing" };

/** How a machine's hand-back stands: on its way, not answered (asked again after a wait), or waiting to be asked. */
export type DesktopRelease = "asking" | "failed" | "pending";

/** A hold the window may use (F26 of #1661): the hand-back epoch it was taken under and its seat, the number the
 * database gave that seating of the member. Everything the window does as holder (a heartbeat, an action) names both. */
export interface DesktopSeat {
	readonly epoch: number;
	readonly seat: number;
}

interface Hold {
	readonly machineId: string;
	/** The agents whose windows took it over, took it up or listed it (one machine may be on two agents' lists): each
	 * agent's take-over card asks the ledger by its own id. */
	readonly agents: Set<string>;
	/** The member's hand-back epoch for the machine, the highest the page learned from the database (a hand-back's answer,
	 * a TAKE_CALLED_OFF, a list). A take-over is sent at it; everything owed is owed at it. */
	epoch: number | undefined;
	/** What the window may use (display and input, not what is owed): a take-over waiting for the machine's hand-back to
	 * be answered (queued), one on its way (taking), held, or may be held (maybe: its answer was lost). It may end early:
	 * a refusal, a heartbeat's `ended`, an action's DESKTOP_CONTROL_ENDED. */
	state: "queued" | "taking" | "held" | "maybe" | undefined;
	/** Owed at `epoch`: the seat this page's own latest answered take-over got (F26), held or not, from that answer, or,
	 * when the answer was lost, from a list that shows the hold seated by that very request. The window uses it while
	 * held. Discharged (F27, R5) by an EXACT hand-back's answer for it (ended now, or gone already), by a heartbeat or an
	 * action answered `ended` for it, or by an epoch above. */
	mine: number | undefined;
	/** Owed at `epoch` (F27, F28): a take-over this page sent under it has no answer of its own (lost, timed out, cut off),
	 * so it may still be on its way and seat the member whenever it arrives. While it stands only VOID gives the machine
	 * back, and no new take-over is sent before a VOID was answered (R2): so there is at most one. Discharged by its own
	 * answer, by a list that shows the hold seated by it, or by an epoch above. */
	unanswered: boolean;
	/** The id of the latest take-over request this page sent for the machine at `epoch` (F26): recognition in a list
	 * only, never authority. */
	press: string | undefined;
	/** Owed at `epoch` (review r10, F26): the highest seat of a hold of the member's that a list or a hand-back's answer
	 * showed under it, on a machine this page gave back or while an I'm done works on its agent (another tab, an earlier
	 * page). Hand back and I'm done hand it back; a close or a switch alone give back only what this page took. Discharged
	 * by an EXACT hand-back's answer for it or a higher seat, or by an epoch above. */
	seen: number | undefined;
	/** The take-over the state is of, and its promise: an answer of an older one is told apart. */
	take?: object;
	pending?: Promise<DesktopTake>;
	/** A release was asked and its hand-back is not answered: from that moment nothing of the machine is used or
	 * renewed, and any take-over answer for it is nothing to act on. */
	calling: boolean;
	/** The epoch that hand-back is at, and its form (F27, F28): EXACT names a seat, VOID (null) whichever seat. */
	callEpoch: number | undefined;
	callSeat: number | null;
	/** What the database records for the hand-back: the member's word, or a window that closed. */
	reason: "handed_back" | "closed";
	asking?: Promise<boolean>;
	tries: number;
	failed: boolean;
	timer?: ReturnType<typeof setTimeout>;
	/** The company's page was left while a take-over was on its way. */
	gone?: boolean;
}

/**
 * What this member may hold of the company's desktops, for the page's lifetime (migration 20260930713000; reviews r2
 * to r10 of #1661). It is the company's (ComputerPanels), never a window's, so closing a window forgets nothing.
 *
 * The database keeps one hand-back epoch per member and machine, which only it moves: a take-over is accepted only at
 * the current epoch, and the epoch moves from E to E+1 only by the member's hand-back at E, which ends the lease taken
 * under E. So an epoch above E means nothing taken or sent under E or below holds the desktop, or ever can.
 *
 * What the page owes for a machine is owed at the epoch it knows (review r10): `unanswered` (a take-over of its own
 * with no answer: it may still be on its way), `mine` (the seat its own latest answered take-over got) and `seen` (the
 * seat of a hold of the member's a list or an answer showed). What discharges them (release review r1 of #1667, F26 to
 * F28 of #1661):
 * - The page learning, from the database, that the member's epoch for the machine is above it (a hand-back's answer, a
 *   TAKE_CALLED_OFF, a list) discharges everything owed at it: the epoch moves past E only when nothing of the member's
 *   is live under E, and a take-over sent at E is refused whenever it arrives.
 * - An EXACT hand-back's answer for seat g at E discharges `mine` and `seen` at g or below: g ended now or was gone
 *   already, and a seat once left is never live again (seats only grow, and a lease that ran out is never renewed).
 * - A heartbeat or an action answered `ended` (or another member's hold) for seat g at E discharges `mine` g.
 * - A take-over's own answer, or a list that shows the hold seated by that very request, discharges `unanswered`.
 * Nothing else: no refusal of another request, no timeout, no close or switch. What the page knows is ordered by the
 * database's counters alone, never by its own clock.
 *
 * Seats (F26): two holds of the member's can live under one epoch (a lease that ran out and was taken again, another
 * tab's take-over of the member's own lease), so the database gives every seating a seat, and the window's heartbeat and
 * actions name it beside the epoch: a hold the page did not get from the answer to its own take-over is never used.
 *
 * A hand-back has two forms, chosen by what the page knows (F27, F28): EXACT names a seat and ends the member's lease
 * in that seat only (the epoch moves when none of theirs is left live), so a tab whose take-overs were all answered
 * never ends another tab's hold; VOID, sent while a take-over of this page's is unanswered, moves the epoch at the
 * current one and ends the member's lease under it, whichever seat, which voids that take-over whenever it arrives (and
 * ends another tab's hold under that epoch too: the one race where a closing tab ends another's). A page never has two
 * take-overs that may both be alive: before a new one goes while one is unanswered, VOID goes first and is answered.
 *
 * - A release of a machine (Hand back, the card's I'm done, a window's close, a change of the window's machine, the
 *   page hidden) is marked at once, before anything is awaited: from then on the window takes no input, sends no
 *   heartbeat and ignores any take-over answer for the machine. Then one hand-back at the known epoch is sent, and asked
 *   again with growing waits (RELEASE_RETRY_MS) until answered, window or not. A take-over queued behind an unanswered
 *   hand-back waits for its answer, and is never sent once it was called off meanwhile.
 * - Hand back and I'm done then read the member's list and hand back what it shows them holding, until a read that
 *   counts leaves nothing owed (releaseAgent).
 * - Leaving the company's page asks every machine back once more, at its epoch, in a request the browser finishes after
 *   the page. The lease's own end, 5 minutes without a heartbeat, stays the last word.
 */
export class DesktopHoldLedger {
	readonly #computer: WebCompanyComputer | undefined;
	readonly #holds = new Map<string, Hold>();
	/** Machines whose release was asked in this page's lifetime, whether or not anything was owed there: an own hold a
	 * list shows there is owed (`saw`), until the member takes the machine over again on purpose here. (Nothing is ever
	 * taken up from a list: review r14 removed that; a hold from elsewhere is only shown, and a press takes it over.) */
	readonly #givenBack = new Set<string>();
	/** Agents whose machines were all given back in this page's lifetime (Hand back, I'm done, a window's close), and
	 * whether the page's were (pagehide): a machine of theirs the page learns of only later was given back too. */
	readonly #agentsGivenBack = new Set<string>();
	#pageGivenBack = false;
	readonly #listeners = new Set<() => void>();
	/** Each take-over's answer, with the hold and the ticket it is of (calledOff). */
	readonly #attempts = new WeakMap<Promise<DesktopTake>, { readonly hold: Hold; readonly ticket: object }>();
	/** The agents an I'm done (or Hand back) is working on now, how many at once. */
	readonly #finishing = new Map<string, number>();
	/** The company's page is gone: nothing is asked any more. */
	#left = false;
	/** Releases in turn (review r13 F20): every release moves this on, and records it for its machine, for the agent
	 * whose machines all went back, or for the whole page (hidden, left). A press records it as it stands; nothing the
	 * press asked may be sent once a release came after it (releasedSince). */
	#releases = 0;
	readonly #machineReleasedAt = new Map<string, number>();
	readonly #agentReleasedAt = new Map<string, number>();
	#pageReleasedAt = 0;
	/** The page's pointer moves on each machine whose answer has not come, and until when one whose answer never came may
	 * still land (its pass's end on every node): by machine, here, because the executor keeps a pass for its 10 s whatever
	 * the page made of it, and stamps a late move with the fence of then (v242 release review r1 F1). A hold or sharing
	 * made anew for the same desktop (Back and in again), or another window, waits for them as the one that sent them. */
	readonly #moves = new Map<string, { readonly going: Set<Promise<void>>; unsure: number }>();

	constructor(computer: WebCompanyComputer | undefined, signal?: AbortSignal) {
		this.#computer = computer;
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

	/** A pointer move of this page's on `machineId` is on its way until `moved` settles. */
	moveGoing(machineId: string, moved: Promise<void>): void {
		const entry = this.#movesOf(machineId);
		entry.going.add(moved);
		void moved.finally(() => {
			entry.going.delete(moved);
			this.#pruneMoves(machineId);
		});
	}

	/** A pointer move on `machineId` got no answer: it may still land until `until` (its pass's end on every node). */
	moveUnsure(machineId: string, until: number): void {
		const entry = this.#movesOf(machineId);
		entry.unsure = Math.max(entry.unsure, until);
	}

	/** Waits until no pointer move of this page's on `machineId` can land any more: those on their way answered, and one
	 * that got no answer has had its pass end everywhere (or `signal` ended the wait). True when nothing was waited for. */
	async movesSettled(machineId: string, signal: AbortSignal): Promise<boolean> {
		let settled = true;
		for (;;) {
			const entry = this.#moves.get(machineId);
			if (!entry || signal.aborted) return settled;
			if (entry.going.size > 0) {
				settled = false;
				await Promise.all(entry.going);
				continue;
			}
			const unsure = entry.unsure - Date.now();
			if (unsure <= 0) {
				this.#pruneMoves(machineId);
				return settled;
			}
			settled = false;
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, unsure);
				signal.addEventListener("abort", done, { once: true });
			});
		}
	}

	#movesOf(machineId: string): { readonly going: Set<Promise<void>>; unsure: number } {
		let entry = this.#moves.get(machineId);
		if (!entry) {
			entry = { going: new Set(), unsure: Number.NEGATIVE_INFINITY };
			this.#moves.set(machineId, entry);
		}
		return entry;
	}

	#pruneMoves(machineId: string): void {
		const entry = this.#moves.get(machineId);
		if (entry && entry.going.size === 0 && entry.unsure <= Date.now()) this.#moves.delete(machineId);
	}

	/** Calls `listener` whenever what the ledger holds changes. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Whether anything of this agent's machines is owed: taken or sent, seen held, or a hand-back unanswered. */
	has(agentId: string): boolean {
		return [...this.#holds.values()].some((hold) => hold.agents.has(agentId) && this.#busy(hold));
	}

	/** How this machine's hand-back stands, while one was asked and is not answered yet. */
	releasing(machineId: string): DesktopRelease | undefined {
		const hold = this.#holds.get(machineId);
		if (!hold?.calling) return undefined;
		return hold.asking ? "asking" : hold.failed ? "failed" : "pending";
	}

	/** The hold a window may use and renew on this machine, its epoch and seat (F26): held, and no release asked. */
	holder(machineId: string): DesktopSeat | undefined {
		const hold = this.#holds.get(machineId);
		return hold?.state === "held" && !hold.calling && hold.epoch !== undefined && hold.mine !== undefined
			? { epoch: hold.epoch, seat: hold.mine }
			: undefined;
	}

	/** Whether the page knows of any private hold of this machine's, in any form (shared input is never sent then:
	 * 20260930734000, review r3 of #1701): a take-over waiting, on its way, held or maybe held, anything owed of it, or a
	 * hand-back not answered. */
	mayHold(machineId: string): boolean {
		const hold = this.#holds.get(machineId);
		return hold !== undefined && (hold.state !== undefined || this.#busy(hold));
	}

	/** The member's hand-back epoch for this machine, the highest the page learned (a hand-back's answer, a
	 * TAKE_CALLED_OFF, a list); undefined while it learned none. Every move up is told to the listeners. */
	epochOf(machineId: string): number | undefined {
		return this.#holds.get(machineId)?.epoch;
	}

	/** Where the releases stand: a press records it, and passes it to take(). */
	stamp(): number {
		return this.#releases;
	}

	/** Whether a release came after a press stamped `at`: of this machine, of all this agent's machines, or the page's
	 * (review r13 F20). What such a press asked is never sent: only a new press can take the desktop over again. */
	releasedSince(machineId: string | undefined, agentId: string, at: number): boolean {
		return (
			this.#pageReleasedAt > at ||
			(this.#agentReleasedAt.get(agentId) ?? 0) > at ||
			(machineId !== undefined && (this.#machineReleasedAt.get(machineId) ?? 0) > at)
		);
	}

	/** A take-over the member asked for on purpose, from this agent's window, of the machine chosen at the click, by the
	 * press stamped `pressedAt`. It is entered before anything is awaited; it waits for the machine's unanswered
	 * hand-back and is never sent once a release called it off meanwhile, nor once any release came after the press
	 * (review r13); it is sent at the epoch the page knows (read from the list first when it knows none). */
	take(machineId: string, agentId: string, pressedAt?: number): Promise<DesktopTake> {
		const computer = this.#computer;
		if (!computer || this.#left) return Promise.resolve({ state: "uncertain" });
		// A release came after the press: nothing of it is asked (review r13 F20).
		if (pressedAt !== undefined && this.releasedSince(machineId, agentId, pressedAt))
			return Promise.resolve({ state: "called-off" });
		const hold = this.#holds.get(machineId) ?? this.#entry(machineId);
		hold.agents.add(agentId);
		if (this.holder(machineId) !== undefined) return Promise.resolve({ state: "ok" });
		// One on its way that no release called off is this press's too; one called off is not (review r11).
		if ((hold.state === "queued" || hold.state === "taking") && hold.pending && hold.take) return hold.pending;
		const ticket = {};
		hold.take = ticket;
		this.#state(hold, "queued");
		// On purpose: what lists show of this machine is this press's again, not owed apart.
		this.#givenBack.delete(machineId);
		// An earlier take-over of this page's at the epoch is unanswered (F28, R2): it is voided first, and this one waits
		// for that answer and goes at the epoch it names, so no two take-overs of this page's are ever alive at once.
		if (hold.unanswered && !hold.calling) this.#void(hold);
		const mine = () => !this.#left && !hold.gone && this.#holds.get(machineId) === hold && hold.take === ticket;
		const pending = (async (): Promise<DesktopTake> => {
			if (hold.calling && !(await this.#settle(hold))) {
				// Called off meanwhile (a release, or one after the press): said to no one (review r14 F22).
				if (!mine() || (pressedAt !== undefined && this.releasedSince(machineId, agentId, pressedAt)))
					return { state: "called-off" };
				// The earlier hand-back was not answered: this take-over is never sent, and the member is told.
				if (hold.state === "queued") this.#state(hold, undefined);
				return { state: "releasing" };
			}
			if (!mine() || hold.state !== "queued" || hold.calling) return { state: "called-off" };
			if (hold.epoch === undefined) await this.#readList(agentId);
			if (!mine() || hold.state !== "queued" || hold.calling) return { state: "called-off" };
			const epoch = hold.epoch;
			if (epoch === undefined) {
				this.#state(hold, undefined);
				return { state: "uncertain" };
			}
			// The last word before anything leaves the page: a release after the press calls it off (review r13 F20).
			if (pressedAt !== undefined && this.releasedSince(machineId, agentId, pressedAt)) {
				if (hold.state === "queued") this.#state(hold, undefined);
				return { state: "called-off" };
			}
			// From here the take-over may reach the database: unanswered until its own answer comes (F27, F28). Its press is
			// new (F26): the hold it seats remembers it, for a list to show.
			const press = globalThis.crypto.randomUUID();
			hold.unanswered = true;
			hold.press = press;
			this.#state(hold, "taking");
			let answer: MemberDesktopHold | undefined;
			try {
				answer = await computer.takeDesktop(machineId, epoch, press, AbortSignal.timeout(HOLD_CALL_MS));
			} catch {
				answer = undefined;
			}
			// Its own answer, whatever it says: this request is no longer on its way (the hand-back of a release meanwhile
			// was VOID, and covers it).
			if (answer && hold.epoch === epoch && hold.press === press) hold.unanswered = false;
			if (hold.gone) {
				// The company's page was left meanwhile (its keepalive was VOID): what it got goes back once more, by its seat.
				if (answer?.state === "ok") computer.handBackOnLeave(machineId, epoch, answer.seat);
				return { state: "called-off" };
			}
			// A refusal that names the member's epoch is knowledge from the database, whatever came of this one.
			if (answer?.state === "refused" && answer.epoch !== null) this.#learn(hold, answer.epoch);
			// This page asked a release meanwhile (it calls the take-over off): its hand-back covers whatever this got
			// (review r5 F11), and nothing is said.
			if (!mine() || hold.calling) return { state: "called-off" };
			if (hold.epoch !== epoch) {
				// The database moved the epoch on meanwhile (another tab gave the machine back): nothing taken at the older
				// one holds. The member is told, as of a refusal, and the next press goes out at the epoch now known (review
				// r11 F18): the database's own refusal, or the one it would give this take-over now. (The state is read anew.)
				if ((hold.state as Hold["state"]) === "taking") this.#state(hold, undefined);
				if (answer?.state === "refused") return answer;
				return { state: "refused", reason: "TAKE_CALLED_OFF", memberName: null, epoch: hold.epoch ?? null };
			}
			if (answer?.state === "ok") {
				// The seat of the hold comes from this answer, to this page's own press, alone (F26).
				hold.mine = answer.seat;
				this.#state(hold, "held");
				return { state: "ok" };
			}
			if (answer?.state === "refused") {
				// Nothing of this one holds; it was the only one of this page's on its way (R2).
				this.#state(hold, undefined);
				return answer;
			}
			// Lost: the database may have given it, or may yet. Unanswered: a release now is VOID, and so is what goes
			// before the next press (R2); held once a list shows the hold seated by it.
			this.#state(hold, "maybe");
			return { state: "uncertain" };
		})();
		hold.pending = pending;
		this.#attempts.set(pending, { hold, ticket });
		void pending.finally(() => {
			if (hold.pending === pending) hold.pending = undefined;
		});
		return pending;
	}

	/** Whether the take-over this answer is of was called off (a release of the machine, or a newer take-over of it): it
	 * is no one's then, and a press waits for no answer of it (review r12 F19). */
	calledOff(answer: Promise<DesktopTake>): boolean {
		const attempt = this.#attempts.get(answer);
		return (
			attempt !== undefined &&
			(attempt.hold.take !== attempt.ticket || this.#holds.get(attempt.hold.machineId) !== attempt.hold)
		);
	}

	/** A hold of the member's that the window shows from elsewhere (another window, or this page before a reload), at the
	 * epoch and in the seat its list gave, which the member is handing back now (review r15 F23, F26): owed at that epoch
	 * from the click, so the hand-back of that seat goes at once, asked again until answered. Nothing when the page
	 * already knows a newer epoch (that hold is fenced). */
	owe(machineId: string, agentId: string, epoch: number, seat: number): void {
		if (this.#left || !this.#computer) return;
		const hold = this.#holds.get(machineId) ?? this.#entry(machineId);
		hold.agents.add(agentId);
		if (hold.epoch !== undefined && epoch < hold.epoch) return;
		this.#learn(hold, epoch);
		if (hold.epoch !== epoch) return;
		hold.seen = Math.max(hold.seen ?? seat, seat);
		this.#changed();
	}

	/** The hold under `epoch` in the seat `seat` ended (a heartbeat or an action was told so: handed back, run out,
	 * another tab seated anew, or another member's now): what the window uses ends, and so does what is owed of that seat
	 * (R5: a seat once left is never live again). */
	ended(machineId: string, epoch: number, seat: number): void {
		const hold = this.#holds.get(machineId);
		if (!hold || hold.epoch !== epoch || hold.mine !== seat) return;
		hold.mine = undefined;
		if (hold.state === "held") this.#state(hold, undefined);
		else this.#changed();
	}

	/** Gives this machine back: marked at once, before anything is awaited, then one hand-back at the known epoch, asked
	 * again until answered (window or not). A take-over still queued is dropped, never sent. Its form (F27, F28): VOID
	 * while a take-over of this page's is unanswered; else EXACT, by the seat this page's own take-over got (`mine`), or,
	 * with `elsewhere` (Hand back, I'm done), the highest of that and the seat seen held (`seen`: the lower one is gone);
	 * nothing when there is none. */
	release(machineId: string, agentId?: string, reason: Hold["reason"] = "handed_back", elsewhere = false): void {
		if (this.#left || !this.#computer) return;
		this.#machineReleasedAt.set(machineId, ++this.#releases);
		const hold = this.#holds.get(machineId);
		if (!hold) return;
		if (agentId) hold.agents.add(agentId);
		if (hold.state === "queued") this.#state(hold, undefined);
		// A take-over queued or on its way is called off: whatever comes of it is said to no one (review r11).
		hold.take = undefined;
		// Asked, so given back in this page's lifetime, whether or not anything is sent (found by the schedule explorer):
		// an own hold a list shows here later is owed, until a take-over on purpose.
		this.#givenBack.add(machineId);
		const form = this.#form(hold, elsewhere);
		if (!hold.calling && (form === undefined || hold.epoch === undefined)) return;
		if (!hold.calling) {
			hold.calling = true;
			hold.callEpoch = hold.epoch;
			hold.callSeat = form ?? null;
			hold.reason = reason;
		}
		this.#changed();
		void this.#ask(hold);
	}

	/** The window's machine changed (review r4 F8): every machine of this agent's in the ledger but the one now chosen
	 * is given back, whatever its state and whatever the window believes. */
	releaseOthers(agentId: string, keep: string | undefined): void {
		for (const hold of [...this.#holds.values()])
			if (hold.agents.has(agentId) && hold.machineId !== keep) this.release(hold.machineId, agentId);
	}

	/** Everything this agent's windows may hold, given back: every machine of the agent's in the ledger is released at
	 * once (review r5 F11). True once every hand-back was answered and nothing of the agent's is owed; false while one is
	 * not answered (asked again meanwhile; the lease also ends by itself in 5 minutes). With `elsewhere` (Hand back, I'm
	 * done) it then reads the member's list until a read that counts leaves nothing owed, handing back what reads show the
	 * member holding (another tab, an earlier page, what this page took), a few rounds; without a list it says no.
	 *
	 * What I'm done answers (reviews r9, r10): once, after a list read that counts (none of its machines below the epoch
	 * the ledger knows), nothing of the agent's machines is owed. Whatever the page sent, took up or saw held under an
	 * epoch is discharged by learning, from the database, an epoch above it, or seat by seat at that epoch (r19): a
	 * take-over with no answer by its own answer (or a list showing the hold it seated); a seat the page's own take-over
	 * got, or one shown it, by an EXACT hand-back's answer for that seat or a higher one, or by a heartbeat or an action
	 * answered `ended` for it. Nothing else discharges anything (no refusal of another request, timeout or closed
	 * window), and a hold that read shows at the current epoch is owed like any other. A take-over the member starts
	 * from another tab after that read was taken is a new take-over, outside this answer; the agent then hears
	 * DESKTOP_MEMBER_IN_CONTROL, as for any take-over without a card. No page can exclude what the member does a moment
	 * later. */
	async releaseAgent(agentId: string, reason: Hold["reason"] = "handed_back", elsewhere = false): Promise<boolean> {
		// The hand-backs this asks, each waited for once: a failed one says no (it is asked again on its own, after a wait).
		const asks = new Map<Hold, Promise<boolean>>();
		const give = (hold: Hold) => {
			this.release(hold.machineId, agentId, reason, elsewhere);
			if (hold.calling) asks.set(hold, this.#ask(hold));
		};
		if (elsewhere) this.#finishing.set(agentId, (this.#finishing.get(agentId) ?? 0) + 1);
		// Every machine of the agent's, those the page learns of later too; and no press before this one is acted on.
		this.#agentsGivenBack.add(agentId);
		this.#agentReleasedAt.set(agentId, ++this.#releases);
		try {
			// At once, before anything is awaited (review r5 F11).
			for (const hold of [...this.#holds.values()]) if (hold.agents.has(agentId)) give(hold);
			for (let round = 0; ; round++) {
				const answered = await Promise.all(asks.values());
				asks.clear();
				if (!answered.every(Boolean)) return false;
				if (!elsewhere) return !this.has(agentId);
				// A read asked after every hand-back so far was answered (review r8). What it shows is reconciled into the
				// ledger first (listed: a hold of the member's it shows is owed now); it counts only when none of its
				// machines is below the epoch the ledger knows, and then the ledger alone decides (review r9): done when
				// nothing of the agent's machines is owed.
				const list = await this.#readList(agentId);
				if (!list) return false;
				const counts = list.machines.every((row) => {
					const known = this.#holds.get(row.machineId)?.epoch;
					return known === undefined || row.epoch >= known;
				});
				if (counts && !this.has(agentId)) return true;
				if (round >= HOLDING_ROUNDS) return false;
				for (const hold of [...this.#holds.values()]) if (hold.agents.has(agentId) && this.#busy(hold)) give(hold);
			}
		} finally {
			if (elsewhere) {
				const left = (this.#finishing.get(agentId) ?? 1) - 1;
				if (left > 0) this.#finishing.set(agentId, left);
				else this.#finishing.delete(agentId);
			}
		}
	}

	/** A list read of an agent's machines, ordered by the database's own counter (review r8): for a machine, a list whose
	 * epoch is below what the page knows says nothing. At the epoch the page knows or above it is used: an epoch above is
	 * learned (and discharges what was owed below it); a hold of the member's it shows at its epoch is real: owed (`seen`)
	 * on a machine this page gave back, or while an I'm done works on its agent (review r9); and a take-over of this
	 * page's whose answer was lost, shown at its epoch seated by that very request, is answered and held. Nothing else a list shows is ever the page's to use
	 * (review r14): a hold from elsewhere is the window's to show, and a press takes it over. A list never ends a hold by
	 * not showing it; a release on its way waits for its own answer. */
	listed(list: MemberAgentMachines, agentId: string): void {
		for (const row of list.machines) {
			const hold = this.#holds.get(row.machineId) ?? this.#entry(row.machineId);
			if (hold.epoch !== undefined && row.epoch < hold.epoch) continue;
			this.#coveredBy(hold, agentId);
			hold.agents.add(agentId);
			this.#learn(hold, row.epoch);
			const own = row.control?.mine === true && row.control.seat !== null ? row.control : null;
			if (
				own !== null &&
				own.epoch === row.epoch &&
				(this.#givenBack.has(row.machineId) || [...hold.agents].some((agent) => this.#finishing.has(agent)))
			) {
				const seat = own.seat ?? 0;
				hold.seen = Math.max(hold.seen ?? seat, seat);
				this.#changed();
			}
			if (hold.calling) continue;
			// A take-over whose answer was lost is held only when the list shows the hold seated by that very request
			// (F26): never another tab's. That request is answered then (F28); it was the only one on its way (R2).
			if (
				hold.state === "maybe" &&
				own !== null &&
				own.epoch === hold.epoch &&
				hold.press !== undefined &&
				own.press === hold.press
			) {
				hold.unanswered = false;
				hold.mine = own.seat ?? undefined;
				this.#state(hold, "held");
			}
		}
	}

	/** As the company's page is left for good (or its access is gone): each machine owed is asked back once more, at its
	 * epoch, in a request the browser finishes after the page; nothing waits for it, and nothing is kept. Its form is the
	 * one of a hand-back on its way, else as a close's (F27, F28): VOID while a take-over of this page's is unanswered,
	 * else EXACT by the seat this page's own take-over got; never for a hold only seen. */
	leave(): void {
		this.#pageReleasedAt = ++this.#releases;
		for (const hold of this.#holds.values()) {
			hold.gone = true;
			clearTimeout(hold.timer);
			const epoch = hold.calling ? hold.callEpoch : hold.epoch;
			const seat = hold.calling ? hold.callSeat : this.#form(hold, false);
			if (epoch !== undefined && seat !== undefined) this.#computer?.handBackOnLeave(hold.machineId, epoch, seat);
		}
		if (!this.#holds.size) return;
		this.#holds.clear();
		this.#changed();
	}

	/** As the page is hidden for good or put in the browser's cache: every machine is released, as ever, and also asked
	 * back in a request the browser finishes after the page. What it gave back stays until a hand-back is answered, so a
	 * page that comes back from the cache confirms it before I'm done answers. */
	#hidden(): void {
		if (this.#left) return;
		this.#pageReleasedAt = ++this.#releases;
		this.#pageGivenBack = true;
		for (const hold of [...this.#holds.values()]) {
			this.release(hold.machineId);
			if (hold.calling && hold.callEpoch !== undefined)
				this.#computer?.handBackOnLeave(hold.machineId, hold.callEpoch, hold.callSeat);
		}
	}

	/** The form of a hand-back of the machine now (F27, F28): VOID (null) while a take-over of this page's is unanswered;
	 * else EXACT by the seat this page's own take-over got, or, for Hand back and I'm done (`elsewhere`), the highest of
	 * that and the seat seen held (the lower one is gone: seats only grow); nothing (undefined) when nothing is owed. */
	#form(hold: Hold, elsewhere: boolean): number | null | undefined {
		if (hold.unanswered) return null;
		const seats = [hold.mine, elsewhere ? hold.seen : undefined].filter((seat) => seat !== undefined);
		return seats.length ? Math.max(...seats) : undefined;
	}

	/** VOID before a new take-over (R2): an earlier take-over of this page's at the epoch is unanswered. Not a release:
	 * nothing is called off by it, and the press that asked it waits for its answer. */
	#void(hold: Hold): void {
		if (hold.epoch === undefined) return;
		hold.calling = true;
		hold.callEpoch = hold.epoch;
		hold.callSeat = null;
		hold.reason = "handed_back";
		this.#changed();
		void this.#ask(hold);
	}

	/** A machine the page learns is this agent's: given back, if all the agent's machines (or the page's) were. */
	#coveredBy(hold: Hold, agentId: string): void {
		if (!hold.agents.has(agentId) && (this.#pageGivenBack || this.#agentsGivenBack.has(agentId)))
			this.#givenBack.add(hold.machineId);
	}

	#entry(machineId: string): Hold {
		const hold: Hold = {
			machineId,
			agents: new Set(),
			epoch: undefined,
			state: undefined,
			mine: undefined,
			unanswered: false,
			press: undefined,
			seen: undefined,
			calling: false,
			callEpoch: undefined,
			callSeat: null,
			reason: "handed_back",
			tries: 0,
			failed: false,
		};
		this.#holds.set(machineId, hold);
		return hold;
	}

	/** The member's epoch for the machine, as the database said it. An epoch above the known one discharges everything
	 * owed (it was owed at the known one, and the epoch moves past it only when nothing of the member's is live under it,
	 * and a take-over sent under it is refused whenever it arrives) and ends what the window had there (held, may be
	 * held); one at or below it changes nothing (review r10). A take-over on its way keeps its state: its own answer
	 * settles it, and a press meanwhile waits for that (r11). */
	#learn(hold: Hold, epoch: number): void {
		if (hold.epoch !== undefined && epoch <= hold.epoch) return;
		const moved = hold.epoch !== undefined;
		hold.epoch = epoch;
		hold.mine = undefined;
		hold.unanswered = false;
		hold.seen = undefined;
		// Nothing this page sent under the older epoch holds: its press names nothing at this one (F26).
		hold.press = undefined;
		if (moved && !hold.calling && (hold.state === "held" || hold.state === "maybe")) hold.state = undefined;
		this.#changed();
	}

	/** Whether the page owes something of the machine, or has a hand-back of it unanswered. */
	#busy(hold: Hold): boolean {
		return hold.unanswered || hold.mine !== undefined || hold.seen !== undefined || hold.calling;
	}

	#state(hold: Hold, state: Hold["state"]): void {
		hold.state = state;
		this.#changed();
	}

	/** Reads the agent's list, and learns what it says (listed); undefined when it could not be read. */
	async #readList(agentId: string): Promise<MemberAgentMachines | undefined> {
		const computer = this.#computer;
		if (!computer || this.#left) return undefined;
		try {
			const list = await computer.agentMachines(agentId, AbortSignal.timeout(HOLD_CALL_MS));
			this.listed(list, agentId);
			return list;
		} catch {
			return undefined;
		}
	}

	/** The machine's hand-back at the epoch it was asked at, in the form it was asked in, or the one on its way. Its answer
	 * is the database's word on the member's epoch (learned: above the known one, it discharges what was owed; a VOID's
	 * answer always is), on the seat an EXACT one named (ended now or gone already: it and every lower seat are
	 * discharged), and on whether they hold the machine now (if so, at the epoch the page knows, it is owed: `seen`). Not
	 * answered: asked again after a wait, in the same form. */
	#ask(hold: Hold): Promise<boolean> {
		if (hold.asking) return hold.asking;
		if (!hold.calling) return Promise.resolve(true);
		const computer = this.#computer;
		const epoch = hold.callEpoch;
		const seat = hold.callSeat;
		if (!computer || epoch === undefined || this.#left || this.#holds.get(hold.machineId) !== hold)
			return Promise.resolve(false);
		clearTimeout(hold.timer);
		hold.timer = undefined;
		const asking = (async () => {
			try {
				const answer = await computer.handBackDesktop(
					hold.machineId,
					hold.reason,
					epoch,
					seat,
					AbortSignal.timeout(HOLD_CALL_MS),
				);
				hold.asking = undefined;
				hold.failed = false;
				hold.tries = 0;
				hold.calling = false;
				hold.callEpoch = undefined;
				hold.callSeat = null;
				this.#learn(hold, answer.epoch);
				if (seat !== null && answer.epoch === epoch && hold.epoch === epoch) {
					// EXACT, the epoch where it was (R5): the seat named ended now or was gone already, and so is every lower one.
					if (hold.mine !== undefined && hold.mine <= seat) hold.mine = undefined;
					if (hold.seen !== undefined && hold.seen <= seat) hold.seen = undefined;
				}
				// The member holds the machine at the epoch the page knows, in a seat this hand-back did not name (another
				// tab's): owed, in that seat (F26), and the epoch stays while it lives.
				if (answer.holding && answer.epoch === hold.epoch && answer.seat !== null)
					hold.seen = Math.max(hold.seen ?? answer.seat, answer.seat);
				// A take-over asked on purpose after the release (queued) goes on at the new epoch; nothing else is used.
				if (hold.state !== "queued") hold.state = undefined;
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

	/** The machine's hand-back, asked now and waited for. True once none is unanswered. */
	async #settle(hold: Hold): Promise<boolean> {
		for (let round = 0; round < SETTLE_ROUNDS; round++) {
			if (this.#holds.get(hold.machineId) !== hold || !hold.calling) return true;
			if (!(await this.#ask(hold))) return false;
		}
		return this.#holds.get(hold.machineId) !== hold || !hold.calling;
	}

	#wait(tries: number): number {
		return RELEASE_RETRY_MS[Math.min(Math.max(tries, 1), RELEASE_RETRY_MS.length) - 1] as number;
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}
