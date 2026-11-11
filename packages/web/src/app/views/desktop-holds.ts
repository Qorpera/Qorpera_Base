import type {
	MemberAgentMachine,
	MemberAgentMachines,
	MemberDesktopHold,
} from "@qorpera/cloud-client/cloud-member-company-computer";
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
	/** Owed at `epoch` (review r10): a take-over this page sent under it, or a hold this page took up under it. Every
	 * release of the machine hands it back. */
	took: boolean;
	/** Owed at `epoch` (review r10): a hold of the member's that a list or a hand-back's answer showed under it, on a
	 * machine this page gave back or while an I'm done works on its agent (another tab, an earlier page). Hand back and
	 * I'm done hand it back; a close or a switch alone give back only what the page took. */
	saw: boolean;
	/** The take-over the state is of, and its promise: an answer of an older one is told apart. */
	take?: object;
	pending?: Promise<DesktopTake>;
	/** A release was asked and its hand-back is not answered: from that moment nothing of the machine is used, renewed
	 * or taken up, and any take-over answer for it is nothing to act on. */
	calling: boolean;
	/** The epoch that hand-back is at. */
	callEpoch: number | undefined;
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
 * One discharge rule (review r10): everything the page owes for a machine (`took`, `saw`, and a release asked while they
 * stand) is owed at the epoch it knows, and is discharged by exactly one thing: the page learning, from the database,
 * that the member's epoch for that machine is above it (a hand-back's answer, a TAKE_CALLED_OFF, a list). No answer or
 * snapshot at that epoch, whatever it says about holding, and no refusal, timeout, close, switch or `ended` discharges
 * anything. What the page knows is ordered by that counter alone, never by its own clock.
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
	/** Machines whose release was asked in this page's lifetime, whether or not anything was owed there: a hold a list
	 * shows there is never taken up (it is owed instead), unless the member took the machine over again on purpose. */
	readonly #givenBack = new Set<string>();
	/** Agents whose machines were all given back in this page's lifetime (Hand back, I'm done, a window's close): a machine
	 * of theirs the page learns of only later was given back too (found by the schedule explorer). */
	readonly #agentsGivenBack = new Set<string>();
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

	/** The epoch of the hold a window may use and renew on this machine: held, and no release asked. */
	holder(machineId: string): number | undefined {
		const hold = this.#holds.get(machineId);
		return hold?.state === "held" && !hold.calling ? hold.epoch : undefined;
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
		// On purpose: this machine may be taken up again.
		this.#givenBack.delete(machineId);
		const mine = () => !this.#left && !hold.gone && this.#holds.get(machineId) === hold && hold.take === ticket;
		const pending = (async (): Promise<DesktopTake> => {
			if (hold.calling && !(await this.#settle(hold))) {
				// The earlier hand-back was not answered: this take-over is never sent.
				if (mine() && hold.state === "queued") this.#state(hold, undefined);
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
			// From here the take-over may reach the database: owed at this epoch until the page learns one above it.
			hold.took = true;
			this.#state(hold, "taking");
			let answer: MemberDesktopHold | undefined;
			try {
				answer = await computer.takeDesktop(machineId, epoch, AbortSignal.timeout(HOLD_CALL_MS));
			} catch {
				answer = undefined;
			}
			if (hold.gone) {
				// The company's page was left meanwhile: what it got goes back in a request that outlives the page.
				if (answer?.state === "ok") computer.handBackOnLeave(machineId, epoch);
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
				this.#state(hold, "held");
				return { state: "ok" };
			}
			if (answer?.state === "refused") {
				// Nothing of this one holds; what was sent at this epoch stays owed (an earlier one may be on its way).
				this.#state(hold, undefined);
				return answer;
			}
			// Lost: the database may have given it. Owed as ever; held once a list shows it.
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

	/** A hold of this member's that the list shows on this agent's machine, at the epoch it was taken under, that no window
	 * knows (the page was loaded again): true, it is the window's now, and owed. False on a machine this page gave back
	 * (and did not take over again), while a release or a take-over of it is on its way, or from a list older than what
	 * the page knows (its epoch lower: review r8). */
	adopt(machineId: string, agentId: string, row: MemberAgentMachine): boolean {
		const epoch = row.control?.mine === true ? row.control.epoch : null;
		if (this.#left || epoch === null || epoch !== row.epoch) return false;
		const hold = this.#holds.get(machineId) ?? this.#entry(machineId);
		this.#coveredBy(hold, agentId);
		if (this.#givenBack.has(machineId)) return false;
		if ((hold.epoch !== undefined && row.epoch < hold.epoch) || hold.calling) return false;
		if (hold.state === "queued" || hold.state === "taking") return false;
		this.#learn(hold, epoch);
		hold.agents.add(agentId);
		hold.took = true;
		this.#state(hold, "held");
		return true;
	}

	/** The hold under `epoch` ended by itself (a heartbeat or an action was told so): what the window uses ends; what is
	 * owed does not (review r10). */
	ended(machineId: string, epoch: number): void {
		const hold = this.#holds.get(machineId);
		if (hold?.state === "held" && hold.epoch === epoch && !hold.calling) this.#state(hold, undefined);
	}

	/** Gives this machine back: marked at once, before anything is awaited, then one hand-back at the known epoch, asked
	 * again until answered (window or not). A take-over still queued is dropped, never sent. It is sent while the page
	 * owes what it took or sent there (`took`), or, with `elsewhere` (Hand back, I'm done), what it saw held (`saw`); else
	 * nothing is sent. */
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
		// a hold a list shows here later is owed, never taken up, until a take-over on purpose.
		this.#givenBack.add(machineId);
		const owes = hold.took || (elsewhere && hold.saw);
		if (!hold.calling && (!owes || hold.epoch === undefined)) return;
		if (!hold.calling) {
			hold.calling = true;
			hold.callEpoch = hold.epoch;
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
	 * the ledger knows), nothing of the agent's machines is owed: whatever the page sent, took up or saw held under an
	 * epoch is discharged only by learning, from the database, an epoch above it, and a hold that read shows at the
	 * current epoch is owed like any other. A take-over the member starts from another tab after that read was taken is
	 * a new take-over, outside this answer; the agent then hears DESKTOP_MEMBER_IN_CONTROL, as for any take-over without
	 * a card. No page can exclude what the member does a moment later. */
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
	 * learned (and discharges what was owed below it); a hold of the member's it shows at its epoch is real: owed (`saw`)
	 * on a machine this page gave back, or while an I'm done works on its agent, whether or not a window may take it up
	 * (review r9); and a lost answer it shows is held. A list never ends a hold by not showing it; a release on its way
	 * waits for its own answer. */
	listed(list: MemberAgentMachines, agentId: string): void {
		for (const row of list.machines) {
			const hold = this.#holds.get(row.machineId) ?? this.#entry(row.machineId);
			if (hold.epoch !== undefined && row.epoch < hold.epoch) continue;
			this.#coveredBy(hold, agentId);
			hold.agents.add(agentId);
			this.#learn(hold, row.epoch);
			const holding = row.control?.mine === true ? row.control.epoch : null;
			// Adoption (input and heartbeats) and obligation (a hand-back owed) are apart: #givenBack blocks the first only.
			if (
				holding === row.epoch &&
				(this.#givenBack.has(row.machineId) || [...hold.agents].some((agent) => this.#finishing.has(agent)))
			) {
				hold.saw = true;
				this.#changed();
			}
			if (hold.calling) continue;
			if (hold.state === "maybe" && holding === hold.epoch) this.#state(hold, "held");
		}
	}

	/** As the company's page is left for good (or its access is gone): each machine owed is asked back once more, at its
	 * epoch, in a request the browser finishes after the page; nothing waits for it, and nothing is kept. */
	leave(): void {
		this.#pageReleasedAt = ++this.#releases;
		for (const hold of this.#holds.values()) {
			hold.gone = true;
			clearTimeout(hold.timer);
			if (this.#busy(hold) && hold.epoch !== undefined) this.#computer?.handBackOnLeave(hold.machineId, hold.epoch);
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
		for (const hold of [...this.#holds.values()]) {
			this.release(hold.machineId);
			if (hold.calling && hold.epoch !== undefined) this.#computer?.handBackOnLeave(hold.machineId, hold.epoch);
		}
	}

	/** A machine the page learns is this agent's: given back, if all the agent's machines were. */
	#coveredBy(hold: Hold, agentId: string): void {
		if (!hold.agents.has(agentId) && this.#agentsGivenBack.has(agentId)) this.#givenBack.add(hold.machineId);
	}

	#entry(machineId: string): Hold {
		const hold: Hold = {
			machineId,
			agents: new Set(),
			epoch: undefined,
			state: undefined,
			took: false,
			saw: false,
			calling: false,
			callEpoch: undefined,
			reason: "handed_back",
			tries: 0,
			failed: false,
		};
		this.#holds.set(machineId, hold);
		return hold;
	}

	/** The member's epoch for the machine, as the database said it. An epoch above the known one discharges everything
	 * owed (it was owed at the known one, and the epoch moves past it only by a hand-back that ends what was taken under
	 * it) and ends what the window had there (held, may be held); one at or below it changes nothing (review r10). A
	 * take-over on its way keeps its state: its own answer settles it, and a press meanwhile waits for that (r11). */
	#learn(hold: Hold, epoch: number): void {
		if (hold.epoch !== undefined && epoch <= hold.epoch) return;
		const moved = hold.epoch !== undefined;
		hold.epoch = epoch;
		hold.took = false;
		hold.saw = false;
		if (moved && !hold.calling && (hold.state === "held" || hold.state === "maybe")) hold.state = undefined;
		this.#changed();
	}

	/** Whether the page owes something of the machine, or has a hand-back of it unanswered. */
	#busy(hold: Hold): boolean {
		return hold.took || hold.saw || hold.calling;
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

	/** The machine's hand-back at the epoch it was asked at, or the one on its way. Its answer is the database's word on
	 * the member's epoch (learned: above the known one, it discharges what was owed) and on whether they hold the machine
	 * now (if so, at the epoch the page knows, it is owed: `saw`). Not answered: asked again after a wait. */
	#ask(hold: Hold): Promise<boolean> {
		if (hold.asking) return hold.asking;
		if (!hold.calling) return Promise.resolve(true);
		const computer = this.#computer;
		const epoch = hold.callEpoch;
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
					AbortSignal.timeout(HOLD_CALL_MS),
				);
				hold.asking = undefined;
				hold.failed = false;
				hold.tries = 0;
				hold.calling = false;
				hold.callEpoch = undefined;
				this.#learn(hold, answer.epoch);
				if (answer.holding && answer.epoch === hold.epoch) hold.saw = true;
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
