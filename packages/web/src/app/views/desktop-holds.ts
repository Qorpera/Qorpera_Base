import type { MemberAgentMachine, MemberDesktopHold } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { WebCompanyComputer } from "../../cloud/computer.ts";

/** The waits before a hand-back, or the list read that confirms one, is asked again: 2, 4, 8, then 15 s. */
export const RELEASE_RETRY_MS = [2000, 4000, 8000, 15_000];
/** The own deadline of a take-over, a hand-back and the list read that confirms one: none of them is a window's. */
export const HOLD_CALL_MS = 15_000;
/** How many hand-backs one "give it all back" asks for a machine that a list read still shows held before it says no. */
const SETTLE_ROUNDS = 3;

/** A take-over as the ledger answers it: held; refused (the database said why); uncertain (the answer was lost: the
 * machine may be held); called off (a hand-back was asked while it was on its way: what it got goes back); or not
 * asked, because the machine's own hand-back is not confirmed yet. */
export type DesktopTake =
	| { readonly state: "ok" }
	| Extract<MemberDesktopHold, { state: "refused" }>
	| { readonly state: "uncertain" }
	| { readonly state: "called-off" }
	| { readonly state: "releasing" };

/** How a machine's hand-back stands: on its way (or its confirming list read is), not reached (asked again after a
 * wait), or waiting for the list read that confirms it. */
export type DesktopRelease = "asking" | "failed" | "pending";

interface Release {
	/** What the database records: the member's word, or a window that closed. */
	readonly reason: "handed_back" | "closed";
	/** Only a list read asked at or after this says anything of the hand-back (the asking, then the answer). */
	checkAfter: number;
	tries: number;
	failed: boolean;
	/** The database answered it: the list read that confirms it comes next. */
	answered: boolean;
	asking?: Promise<boolean>;
	verifying?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
}
interface Hold {
	readonly machineId: string;
	/** The agents whose windows took it over or took it up (one machine may be on two agents' lists): each agent's
	 * take-over card asks the ledger by its own id. */
	readonly agents: Set<string>;
	/** taking: asked, no answer yet; held: the database gave it; maybe: an answer was lost, or a hand-back is asked. */
	state: "taking" | "held" | "maybe";
	/** When the state last changed: a list read asked before then says nothing of it. */
	changedAt: number;
	taking?: Promise<DesktopTake>;
	release?: Release;
	/** The page went (or the company was left) while a take-over was on its way: what it gets goes back as it comes. */
	gone?: boolean;
}

/**
 * What this member may hold of the company's desktops, for the page's lifetime (migration 20260930713000; review r2 of
 * #1661). It is the company's (ComputerPanels), never a window's, so closing a window forgets nothing.
 *
 * - A machine enters it the moment a take-over is asked, before the answer, and stays through every uncertain outcome:
 *   a failed, timed-out or lost answer counts as "may be held".
 * - A hand-back that was asked (Hand back, the card's I'm done, a window's close, a switch to another machine) stays
 *   here until it is confirmed, and is asked again with growing waits (RELEASE_RETRY_MS), window or not.
 * - A machine leaves only when no take-over is on its way for it and a list read asked after its hand-back (after the
 *   database's answer, once it answered) shows no hold of this member's on it. After an answer the ledger reads the
 *   list itself, so a take-over that committed after the member gave up on its answer is caught and given back.
 * - A machine whose hand-back was asked in this page's lifetime is never taken up again from a list read, nor renewed,
 *   unless the member takes it over again on purpose: a hold a list still shows there is given back again.
 * - The take-over card asks it, not a window: I'm done answers only once nothing of that agent's is in it.
 * - As the page goes (pagehide, or the company's page left), every machine in it is asked back once more in a request
 *   the browser finishes after the page. The lease's own end, 5 minutes without a heartbeat, stays the last word.
 */
export class DesktopHoldLedger {
	readonly #computer: WebCompanyComputer | undefined;
	readonly #holds = new Map<string, Hold>();
	/** Machines whose hand-back was asked in this page's lifetime, and since when: a hold a list asked after then shows
	 * on one is given back again, never taken up, unless the member took it over again on purpose. */
	readonly #givenBack = new Map<string, number>();
	readonly #listeners = new Set<() => void>();
	/** The company's page is gone: nothing is asked any more. */
	#left = false;

	constructor(computer: WebCompanyComputer | undefined, signal?: AbortSignal) {
		this.#computer = computer;
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

	/** Whether anything of this agent's may be held: held, may be held, being taken over, or its hand-back unconfirmed. */
	has(agentId: string): boolean {
		return [...this.#holds.values()].some((hold) => hold.agents.has(agentId));
	}

	/** How this machine's hand-back stands, if one was asked and is not confirmed yet. */
	releasing(machineId: string): DesktopRelease | undefined {
		const release = this.#holds.get(machineId)?.release;
		if (!release) return undefined;
		return release.asking || release.verifying ? "asking" : release.failed ? "failed" : "pending";
	}

	/** Whether a window may use and renew this hold: the database gave it and no hand-back was asked. */
	mayKeep(machineId: string): boolean {
		const hold = this.#holds.get(machineId);
		return hold?.state === "held" && !hold.release && !hold.taking;
	}

	/** A take-over the member asked for on purpose, from this agent's window. The machine enters the ledger before the
	 * answer; a hold that comes back after a hand-back was asked meanwhile goes back at once. A machine whose own hand-back
	 * is not confirmed yet is given back first: no take-over is asked before that. */
	async take(machineId: string, agentId: string): Promise<DesktopTake> {
		const computer = this.#computer;
		if (!computer || this.#left) return { state: "uncertain" };
		const before = this.#holds.get(machineId);
		if (before?.release && !(await this.#settle(before))) return { state: "releasing" };
		let hold = this.#holds.get(machineId);
		if (hold?.taking) {
			hold.agents.add(agentId);
			return hold.taking;
		}
		if (hold?.state === "held" && !hold.release) {
			// Another of the member's windows holds it already: it is this one's too.
			hold.agents.add(agentId);
			return { state: "ok" };
		}
		// On purpose: this machine may be taken up again.
		this.#givenBack.delete(machineId);
		if (!hold) {
			hold = { machineId, agents: new Set(), state: "taking", changedAt: Date.now() };
			this.#holds.set(machineId, hold);
		}
		hold.agents.add(agentId);
		hold.state = "taking";
		hold.changedAt = Date.now();
		const entry = hold;
		const taking = (async (): Promise<DesktopTake> => {
			let answer: MemberDesktopHold | undefined;
			try {
				answer = await computer.takeDesktop(machineId, AbortSignal.timeout(HOLD_CALL_MS));
			} catch {
				answer = undefined;
			}
			entry.taking = undefined;
			entry.changedAt = Date.now();
			if (entry.gone) {
				// The page went (or the company was left) meanwhile: what it got goes back in a request that outlives it.
				if (answer?.state === "ok") computer.handBackOnLeave(machineId);
				return { state: "called-off" };
			}
			if (answer?.state === "refused" && !entry.release) {
				this.#holds.delete(machineId);
				this.#changed();
				return answer;
			}
			// Held, or may be: a lost answer counts as held until a list read or a confirmed hand-back says otherwise.
			entry.state = answer?.state === "ok" ? "held" : "maybe";
			const release = entry.release;
			if (release) {
				// A hand-back was asked while it was on its way: it is asked now, after the answer, and never renewed.
				release.answered = false;
				release.checkAfter = Date.now();
				void this.#ask(entry);
				this.#changed();
				return { state: "called-off" };
			}
			this.#changed();
			return answer?.state === "ok" ? { state: "ok" } : { state: "uncertain" };
		})();
		entry.taking = taking;
		this.#changed();
		return taking;
	}

	/** A hold of this member's that a list read shows on this agent's machine and no window knows (the page was loaded
	 * again): true, it is the window's now. False for a machine whose hand-back was asked in this page's lifetime (the
	 * list read gives it back again: listed) or one being taken over. */
	adopt(machineId: string, agentId: string): boolean {
		if (this.#left || this.#givenBack.has(machineId)) return false;
		const hold = this.#holds.get(machineId);
		if (hold?.release || hold?.taking) return false;
		if (hold) {
			hold.agents.add(agentId);
			hold.state = "held";
			hold.changedAt = Date.now();
		} else
			this.#holds.set(machineId, { machineId, agents: new Set([agentId]), state: "held", changedAt: Date.now() });
		this.#changed();
		return true;
	}

	/** The hold ended by itself (a heartbeat or an action was told so): it leaves, unless a hand-back or a take-over of
	 * it is on its way. */
	ended(machineId: string): void {
		const hold = this.#holds.get(machineId);
		if (!hold || hold.release || hold.taking) return;
		this.#holds.delete(machineId);
		this.#changed();
	}

	/** Asks to give this machine's hold back, and keeps it until that is confirmed (asked again meanwhile). A machine not
	 * in the ledger enters it when an agent is named. A take-over on its way is answered first; the hand-back follows. */
	release(machineId: string, agentId?: string, reason: Release["reason"] = "handed_back"): void {
		if (this.#left || !this.#computer) return;
		let hold = this.#holds.get(machineId);
		if (!hold) {
			if (!agentId) return;
			hold = { machineId, agents: new Set(), state: "maybe", changedAt: Date.now() };
			this.#holds.set(machineId, hold);
		}
		if (agentId) hold.agents.add(agentId);
		this.#givenBack.set(machineId, Date.now());
		hold.release ??= { reason, checkAfter: Date.now(), tries: 0, failed: false, answered: false };
		this.#changed();
		if (!hold.taking) void this.#ask(hold);
	}

	/** Everything this agent's windows may hold, given back and confirmed: true once nothing of its is in the ledger;
	 * false while something is not confirmed (asked again meanwhile; the lease also ends by itself in 5 minutes). */
	async releaseAgent(agentId: string, reason: Release["reason"] = "handed_back"): Promise<boolean> {
		const holds = [...this.#holds.values()].filter((hold) => hold.agents.has(agentId));
		for (const hold of holds) this.release(hold.machineId, agentId, reason);
		const settled = await Promise.all(holds.map((hold) => this.#settle(hold)));
		return settled.every(Boolean) && !this.has(agentId);
	}

	/** A list read of this agent's machines, asked at `askedAt`. A hand-back it shows held no more is confirmed and its
	 * machine leaves; one it still shows held is asked again. A hold without a hand-back follows the list (a lost answer
	 * becomes held, or leaves). A hold on a machine given back in this page's lifetime is given back again. */
	listed(agentId: string, machines: readonly MemberAgentMachine[], askedAt: number): void {
		const mine = (machineId: string) =>
			machines.some((row) => row.machineId === machineId && row.control?.mine === true);
		let changed = false;
		for (const hold of [...this.#holds.values()]) {
			if (!hold.agents.has(agentId) || hold.taking) continue;
			const release = hold.release;
			if (release) {
				if (askedAt < release.checkAfter || release.asking) continue;
				if (!mine(hold.machineId)) {
					this.#forget(hold);
					changed = true;
				} else {
					// Still held: a take-over committed after the member gave up on its answer, or the hand-back did not
					// reach the database. Asked again; another list read must confirm it.
					release.answered = false;
					release.checkAfter = Date.now();
					void this.#ask(hold);
				}
				continue;
			}
			// A machine not on this list says nothing of a hold another agent's window has of it.
			if (askedAt < hold.changedAt || !machines.some((row) => row.machineId === hold.machineId)) continue;
			if (!mine(hold.machineId)) {
				this.#holds.delete(hold.machineId);
				changed = true;
			} else if (hold.state !== "held") {
				hold.state = "held";
				hold.changedAt = Date.now();
				changed = true;
			}
		}
		for (const row of machines) {
			const since = this.#givenBack.get(row.machineId);
			if (row.control?.mine === true && since !== undefined && askedAt >= since && !this.#holds.has(row.machineId))
				this.release(row.machineId, agentId);
		}
		if (changed) this.#changed();
	}

	/** As the page goes: each machine is asked back once more in a request the browser finishes after the page; nothing
	 * waits for it. The machines count as given back in this page's lifetime, should it come back from the cache. */
	leave(): void {
		if (!this.#holds.size) return;
		for (const hold of this.#holds.values()) {
			hold.gone = true;
			if (hold.release) clearTimeout(hold.release.timer);
			this.#givenBack.set(hold.machineId, Date.now());
			this.#computer?.handBackOnLeave(hold.machineId);
		}
		this.#holds.clear();
		this.#changed();
	}

	/** One hand-back asked of the database, or the one on its way. Either answer means the member holds nothing of it
	 * now; the list read that confirms it follows. Not answered: asked again after a wait. */
	#ask(hold: Hold): Promise<boolean> {
		const release = hold.release;
		const computer = this.#computer;
		if (!release || !computer || this.#left || this.#holds.get(hold.machineId) !== hold)
			return Promise.resolve(false);
		if (release.asking) return release.asking;
		if (release.answered) return Promise.resolve(true);
		clearTimeout(release.timer);
		release.timer = undefined;
		const asking = (async () => {
			try {
				await computer.handBackDesktop(hold.machineId, release.reason, AbortSignal.timeout(HOLD_CALL_MS));
				release.asking = undefined;
				release.answered = true;
				release.failed = false;
				release.tries = 0;
				release.checkAfter = Date.now();
				void this.#verify(hold);
				this.#changed();
				return true;
			} catch {
				release.asking = undefined;
				if (this.#holds.get(hold.machineId) !== hold || this.#left) return false;
				release.failed = true;
				release.tries++;
				release.timer = setTimeout(() => void this.#ask(hold), this.#wait(release.tries));
				this.#changed();
				return false;
			}
		})();
		release.asking = asking;
		this.#changed();
		return asking;
	}

	/** After an answered hand-back: one list read, asked after the answer, confirms the member holds nothing of it
	 * (listed). One that fails is asked again after a wait. */
	#verify(hold: Hold): Promise<void> {
		const release = hold.release;
		const computer = this.#computer;
		const agentId = [...hold.agents][0];
		if (!release || !computer || !agentId || this.#left || this.#holds.get(hold.machineId) !== hold)
			return Promise.resolve();
		if (release.verifying) return release.verifying;
		clearTimeout(release.timer);
		release.timer = undefined;
		const verifying = (async () => {
			const asked = Date.now();
			try {
				const listed = await computer.agentMachines(agentId, AbortSignal.timeout(HOLD_CALL_MS));
				release.verifying = undefined;
				this.listed(agentId, listed.machines, asked);
			} catch {
				release.verifying = undefined;
				if (this.#holds.get(hold.machineId) !== hold || this.#left) return;
				release.tries++;
				release.timer = setTimeout(() => void this.#verify(hold), this.#wait(release.tries));
			}
			this.#changed();
		})();
		release.verifying = verifying;
		this.#changed();
		return verifying;
	}

	/** Settles one machine's hand-back now: the take-over on its way first, then the hand-back and the list read that
	 * confirms it, a few rounds while the list still shows it held. True once it left the ledger. */
	async #settle(hold: Hold): Promise<boolean> {
		for (let round = 0; round < SETTLE_ROUNDS; round++) {
			if (hold.taking) await hold.taking;
			if (this.#holds.get(hold.machineId) !== hold) return true;
			if (!hold.release || !(await this.#ask(hold))) return false;
			await this.#verify(hold);
			if (this.#holds.get(hold.machineId) !== hold) return true;
		}
		return false;
	}

	/** The machine's hand-back is confirmed: it leaves the ledger, and counts as given back from now on. */
	#forget(hold: Hold): void {
		if (hold.release) clearTimeout(hold.release.timer);
		this.#holds.delete(hold.machineId);
		this.#givenBack.set(hold.machineId, Date.now());
	}

	#wait(tries: number): number {
		return RELEASE_RETRY_MS[Math.min(Math.max(tries, 1), RELEASE_RETRY_MS.length) - 1] as number;
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}
