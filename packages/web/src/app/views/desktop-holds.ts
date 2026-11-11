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
/** How many more rounds Hand back and I'm done hand machines back while answers say the member holds them at a newer
 * epoch (another tab of theirs, taking it again each time) before they say no. */
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
	/** The agents whose windows took it over or took it up (one machine may be on two agents' lists): each agent's
	 * take-over card asks the ledger by its own id. */
	readonly agents: Set<string>;
	/** The member's hand-back epoch for the machine as this page knows it: from a hand-back's answer, a refusal, or the
	 * list. A take-over is sent at it. */
	epoch: number | undefined;
	/** What the page may hold under `epoch`: a take-over waiting for the machine's hand-back to be answered (queued),
	 * one on its way (taking), held, or may be held (maybe: its answer was lost). It says what the window may use; what
	 * must be given back is `sent`'s. */
	state: "queued" | "taking" | "held" | "maybe" | undefined;
	/** The highest epoch a take-over of this page was sent under, from the moment it left the page, until a hand-back
	 * answered past it (review r6 F12): no refusal, timeout, list read or ended heartbeat clears it, only that answer,
	 * or a TAKE_CALLED_OFF that names a newer epoch (the old one is fenced already). While it is set, every release of the
	 * machine hands back, whatever the state says, and I'm done waits for that answer. */
	sent: number | undefined;
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
	/** A hand-back answered that the member holds the machine at this epoch (another tab of theirs, or an earlier page:
	 * review r7 F13). It stands until a hand-back answers past it, or answers at or past it that the member holds nothing:
	 * no close, switch, list read, refusal or timeout clears it. While it stands the machine counts as held for I'm done,
	 * and Hand back and I'm done hand it back at this epoch; a close or a switch alone still give back only what the page
	 * took. */
	elsewhere: number | undefined;
	/** The company's page was left while a take-over was on its way. */
	gone?: boolean;
}

/**
 * What this member may hold of the company's desktops, for the page's lifetime (migration 20260930713000; reviews r2
 * to r5 of #1661). It is the company's (ComputerPanels), never a window's, so closing a window forgets nothing.
 *
 * The database keeps one hand-back epoch per member and machine, which only it moves. A take-over is sent at the epoch
 * the page knows and is accepted only at the current one; a hand-back at the current epoch moves it on and gives back the
 * lease taken under it, and one at an older epoch changes nothing. So a hand-back's answer for epoch e means nothing
 * taken or sent at e or before holds the desktop, or ever will, whenever it arrives: no clock, no list read, no guess.
 *
 * - A release of a machine (Hand back, the card's I'm done, a window's close, a change of the window's machine, the
 *   page hidden) is marked at once, before anything is awaited: from then on the window takes no input, sends no
 *   heartbeat and ignores any take-over answer for the machine. Then one hand-back at the known epoch is sent, and asked
 *   again with growing waits (RELEASE_RETRY_MS) until answered, window or not; its answer gives the new epoch, which a
 *   take-over the member asks for on purpose afterwards uses. A take-over queued behind an unanswered hand-back waits for
 *   its answer, and is never sent once it was called off meanwhile.
 * - Hand back and I'm done also read the member's list and hand back the agent's machines the list shows the member
 *   holding that the page has nothing of (another tab, an earlier page), at the list's epoch; and when a hand-back
 *   answers that the member holds a machine now (a newer epoch), again at that epoch, at most twice.
 * - The member's own list says the current epoch per machine and the epoch of each hold of theirs: a lost answer whose
 *   epoch holds is held; a held lease the list no longer shows ended; an epoch moved on by another tab ends what this
 *   page had under the older one. A hold the list shows on a machine this page gave back is never taken up.
 * - Leaving the company's page asks every machine back once more, at its epoch, in a request the browser finishes after
 *   the page. The lease's own end, 5 minutes without a heartbeat, stays the last word.
 */
export class DesktopHoldLedger {
	readonly #computer: WebCompanyComputer | undefined;
	readonly #holds = new Map<string, Hold>();
	/** Machines whose hand-back was asked in this page's lifetime: a hold a list shows there is never taken up, unless
	 * the member took the machine over again on purpose. */
	readonly #givenBack = new Set<string>();
	readonly #listeners = new Set<() => void>();
	/** The agents an I'm done (or Hand back) is working on now, how many at once. */
	readonly #finishing = new Map<string, number>();
	/** The company's page is gone: nothing is asked any more. */
	#left = false;

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

	/** Whether anything of this agent's may be held: held, may be held, on its way, queued, or a hand-back unanswered. */
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

	/** A take-over the member asked for on purpose, from this agent's window, of the machine chosen at the click. It is
	 * entered before anything is awaited; it waits for the machine's unanswered hand-back and is never sent once a release
	 * called it off meanwhile; it is sent at the epoch the page knows (read from the list first when it knows none). */
	take(machineId: string, agentId: string): Promise<DesktopTake> {
		const computer = this.#computer;
		if (!computer || this.#left) return Promise.resolve({ state: "uncertain" });
		const hold = this.#holds.get(machineId) ?? this.#entry(machineId);
		hold.agents.add(agentId);
		if (this.holder(machineId) !== undefined) return Promise.resolve({ state: "ok" });
		if ((hold.state === "queued" || hold.state === "taking") && hold.pending) return hold.pending;
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
			// From here the take-over may reach the database: only an answered hand-back past this epoch forgets it.
			hold.sent = Math.max(hold.sent ?? epoch, epoch);
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
			// A release was asked meanwhile: its hand-back, at this epoch, covers whatever this got (review r5 F11).
			if (!mine() || hold.calling) return { state: "called-off" };
			if (hold.epoch !== epoch) {
				// The epoch moved on meanwhile (another tab handed it back): nothing taken at the older one holds.
				// (The state is read anew: it may have changed while the answer was on its way.)
				if ((hold.state as Hold["state"]) === "taking") this.#state(hold, undefined);
				return { state: "called-off" };
			}
			if (answer?.state === "ok") {
				this.#state(hold, "held");
				return { state: "ok" };
			}
			if (answer?.state === "refused") {
				// Refused: nothing of this one holds, but an earlier take-over at this epoch may still be on its way, so
				// what was sent stays to be handed back; only a TAKE_CALLED_OFF at a newer epoch shows it fenced already.
				if (answer.epoch !== null) {
					hold.epoch = Math.max(epoch, answer.epoch);
					if (answer.reason === "TAKE_CALLED_OFF" && hold.sent !== undefined && answer.epoch > hold.sent)
						hold.sent = undefined;
				}
				this.#state(hold, undefined);
				return answer;
			}
			// Lost: the database may have given it. Kept as such until the list says, or a hand-back covers it.
			this.#state(hold, "maybe");
			return { state: "uncertain" };
		})();
		hold.pending = pending;
		void pending.finally(() => {
			if (hold.pending === pending) hold.pending = undefined;
		});
		return pending;
	}

	/** A hold of this member's that the list shows on this agent's machine, at the epoch it was taken under, that no window
	 * knows (the page was loaded again): true, it is the window's now. False on a machine this page gave back (and did not
	 * take over again), while a release or a take-over of it is on its way, or from a list older than what the page knows
	 * (its epoch lower: review r8). */
	adopt(machineId: string, agentId: string, row: MemberAgentMachine): boolean {
		const epoch = row.control?.mine === true ? row.control.epoch : null;
		if (this.#left || epoch === null || epoch !== row.epoch || this.#givenBack.has(machineId)) return false;
		const hold = this.#holds.get(machineId) ?? this.#entry(machineId);
		if ((hold.epoch !== undefined && row.epoch < hold.epoch) || hold.calling) return false;
		if (hold.state === "queued" || hold.state === "taking") return false;
		hold.epoch = epoch;
		hold.agents.add(agentId);
		this.#state(hold, "held");
		return true;
	}

	/** The hold under `epoch` ended by itself (a heartbeat or an action was told so). */
	ended(machineId: string, epoch: number): void {
		const hold = this.#holds.get(machineId);
		if (hold?.state === "held" && hold.epoch === epoch && !hold.calling) this.#state(hold, undefined);
	}

	/** Gives this machine back: marked at once, before anything is awaited, then one hand-back at the epoch of what the
	 * page holds, or else of what it sent, asked again until answered (window or not). A take-over still queued is
	 * dropped, never sent. Nothing is sent when the page holds nothing of the machine and sent nothing since the last
	 * answered hand-back. */
	release(machineId: string, agentId?: string, reason: Hold["reason"] = "handed_back", elsewhere = false): void {
		if (this.#left || !this.#computer) return;
		const hold = this.#holds.get(machineId);
		if (!hold) return;
		if (agentId) hold.agents.add(agentId);
		if (hold.state === "queued") this.#state(hold, undefined);
		// Hand back and I'm done also give back what an answer said the member holds elsewhere.
		const owed = this.#owed(hold);
		const epoch = elsewhere && hold.elsewhere !== undefined ? Math.max(owed ?? hold.elsewhere, hold.elsewhere) : owed;
		if (!hold.calling && epoch === undefined) return;
		this.#givenBack.add(machineId);
		if (!hold.calling) {
			hold.calling = true;
			hold.callEpoch = epoch;
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
	 * once (review r5 F11). True once every hand-back was answered and nothing of the agent's is left; false while one
	 * is not answered (asked again meanwhile; the lease also ends by itself in 5 minutes). With `elsewhere` (Hand back,
	 * I'm done) it then reads the member's list until a read that counts leaves nothing held or owed, handing back what
	 * reads show the member holding (another tab, an earlier page, what this page took), a few rounds; without a list it
	 * says no.
	 *
	 * What I'm done answers (review r9): once everything this page took or may have taken is fenced by an answered
	 * hand-back, and a list read that counts (none of its machines below the epoch the ledger knows) shows this member
	 * holding none of the agent's machines after every hold it observed was handed back. A take-over the member starts
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
				// machines is below the epoch the ledger knows, and then the ledger alone decides (review r9).
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

	/** A list read of an agent's machines, ordered by the database's own counter, never by the page's clock (review r8):
	 * for a machine, a list whose epoch is below what the page knows is older and says nothing. At the epoch the page
	 * knows or above it is at least as new: an epoch above moves the page's knowledge on (what the page had under the older
	 * one is fenced: a hand-back of it was answered), and a hold of the member's it shows at that epoch is real: owed
	 * (review r9) on a machine this page gave back, or while an I'm done works on its agent, whether or not a window may
	 * take it up; and a lost answer whose take-over it shows is held. A list never ends a hold at the same epoch by not
	 * showing it: it cannot tell an older read from an ended lease there; the heartbeat (its `ended`) does that. A release
	 * on its way waits for its own answer. */
	listed(list: MemberAgentMachines, agentId: string): void {
		for (const row of list.machines) {
			const hold = this.#holds.get(row.machineId) ?? this.#entry(row.machineId);
			if (hold.epoch !== undefined && row.epoch < hold.epoch) continue;
			hold.agents.add(agentId);
			if (hold.epoch === undefined || row.epoch > hold.epoch) {
				const moved = hold.epoch !== undefined;
				hold.epoch = row.epoch;
				if (moved && !hold.calling && hold.state !== "queued" && hold.state !== undefined)
					this.#state(hold, undefined);
			}
			const holding = row.control?.mine === true ? row.control.epoch : null;
			// Adoption (input and heartbeats) and obligation (a hand-back owed) are apart: #givenBack blocks the first only.
			if (
				holding !== null &&
				holding >= row.epoch &&
				(this.#givenBack.has(row.machineId) || [...hold.agents].some((agent) => this.#finishing.has(agent)))
			) {
				hold.elsewhere = Math.max(hold.elsewhere ?? holding, holding);
				this.#changed();
			}
			if (hold.calling) continue;
			if (hold.state === "maybe" && holding === hold.epoch) this.#state(hold, "held");
		}
	}

	/** As the company's page is left for good (or its access is gone): each machine is asked back once more, at its
	 * epoch, in a request the browser finishes after the page; nothing waits for it, and nothing is kept. */
	leave(): void {
		for (const hold of this.#holds.values()) {
			hold.gone = true;
			clearTimeout(hold.timer);
			const epoch = hold.calling ? hold.callEpoch : this.#owed(hold);
			if (epoch !== undefined) this.#computer?.handBackOnLeave(hold.machineId, epoch);
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
		for (const hold of [...this.#holds.values()]) {
			this.release(hold.machineId);
			if (hold.calling && hold.callEpoch !== undefined)
				this.#computer?.handBackOnLeave(hold.machineId, hold.callEpoch);
		}
	}

	#entry(machineId: string): Hold {
		const hold: Hold = {
			machineId,
			agents: new Set(),
			epoch: undefined,
			state: undefined,
			sent: undefined,
			calling: false,
			callEpoch: undefined,
			reason: "handed_back",
			tries: 0,
			failed: false,
			elsewhere: undefined,
		};
		this.#holds.set(machineId, hold);
		return hold;
	}

	/** Whether the page may hold something of the machine, sent a take-over of it since the last answered hand-back, was
	 * told the member holds it elsewhere, or has a hand-back of it unanswered. */
	#busy(hold: Hold): boolean {
		return hold.state !== undefined || hold.sent !== undefined || hold.elsewhere !== undefined || hold.calling;
	}

	/** The epoch a release of the machine hands back at: that of what the page holds or may hold (never below what it
	 * sent), else that of what it sent; none when it has neither. */
	#owed(hold: Hold): number | undefined {
		if (hold.state !== undefined && hold.state !== "queued" && hold.epoch !== undefined)
			return Math.max(hold.epoch, hold.sent ?? hold.epoch);
		return hold.sent;
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

	/** The machine's hand-back at the epoch it was asked at, or the one on its way. Its answer is the database's word that
	 * nothing taken or sent at that epoch or before holds the machine or ever will, and gives the current epoch. Not
	 * answered: asked again after a wait. */
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
				hold.epoch = Math.max(hold.epoch ?? 0, answer.epoch);
				// The database's epoch is past what was sent: every take-over sent at it, or before, is fenced.
				if (hold.sent !== undefined && answer.epoch > hold.sent) hold.sent = undefined;
				// The member holds it now (at the answer's epoch): owed until an answer past it, or one that says nothing is.
				if (answer.holding) hold.elsewhere = answer.epoch;
				else if (hold.elsewhere !== undefined && answer.epoch >= hold.elsewhere) hold.elsewhere = undefined;
				// A take-over asked on purpose after the release (queued) goes on at the new epoch; nothing else is left.
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
