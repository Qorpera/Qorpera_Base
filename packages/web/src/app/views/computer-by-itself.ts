/* The computer's window shows by itself in an agent's thread while the agent uses its desktop computer (Jonas, 13 Nov
 * 2026: "when an agent IS using a desktop computer, the computers window pops up in it's threat for you to see";
 * 20260930742000). The rules, one company's worth (they outlive a thread view, as the windows do):
 * - It shows in THAT agent's thread only, while the agent works at its computer (the rail's `computer` state), the
 *   window is not shown there already, and the member neither has any computer's large view open nor types privately
 *   on any computer (busy). It shows as a row of the thread beside the agent, watch only, and takes no focus.
 * - Once per stretch of the agent's use (the database's `since`): a window the member closed stays closed until the
 *   agent stopped and began again (a new `since`). There is no setting: closing it is the member's no.
 * - Once shown it stays in the thread after the agent stopped, where it stood, as a still (Jonas, 14 Nov 2026, asked
 *   whether an untouched window that came by itself should stay too: "Yes, keep it"). Only the member closes it.
 * - It never wakes or starts a computer: the agent's machine runs while the signal is on, and the window opens as the
 *   member's own click would, without asking for a start (the open path's "member asked" is false).
 *
 * What it keeps: `#shownFor` and `#declined` (per agent: a stretch), plain memory, no timer; a new stretch replaces
 * them. */

export class ComputerByItself {
	/** The stretch each agent's window last came by itself for: once per stretch. */
	readonly #shownFor = new Map<string, string>();
	/** The stretch in which the member closed each agent's window: it stays closed through it. */
	readonly #declined = new Map<string, string>();
	#done = false;

	/** Whether the agent's window should show by itself now in its thread: the agent uses its computer in the stretch
	 * `since` (undefined: it does not), `open` the window shows in this thread already, `busy` the member has a large
	 * view open or types privately on a computer. */
	wanted(agentId: string, since: string | undefined, open: boolean, busy: boolean): boolean {
		if (this.#done || since === undefined || open || busy) return false;
		if (this.#declined.get(agentId) === since) return false;
		return this.#shownFor.get(agentId) !== since;
	}

	/** The window came by itself for the stretch `since`. */
	opened(agentId: string, since: string): void {
		if (!this.#done) this.#shownFor.set(agentId, since);
	}

	/** The member closed the agent's window while it used its computer in the stretch `since` (undefined: it did not):
	 * the window stays closed through that stretch. */
	closed(agentId: string, since: string | undefined): void {
		if (since !== undefined) this.#declined.set(agentId, since);
	}

	dispose(): void {
		this.#done = true;
		this.#shownFor.clear();
		this.#declined.clear();
	}
}
