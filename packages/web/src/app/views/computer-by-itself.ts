/* The computer's window shows by itself in an agent's thread while the agent uses its desktop computer (Jonas, 13 Nov
 * 2026: "when an agent IS using a desktop computer, the computers window pops up in it's threat for you to see";
 * 20260930742000). The rules, one company's worth (they outlive a thread view, as the windows do):
 * - It shows in THAT agent's thread only, while the agent works at its computer (the rail's `computer` state), the
 *   window is not shown there already, and the member neither has any computer's large view open nor types privately
 *   on any computer (busy). It shows small, watch only, where a click would put it, and takes no focus.
 * - Once per stretch of the agent's use (the database's `since`): a window the member closed stays closed until the
 *   agent stopped and began again (a new `since`). There is no setting: closing it is the member's no.
 * - A window that came by itself and that the member never touched goes AUTO_CLOSE_MS after the agent stopped (and
 *   stays if the agent begins again before). It is the rule's only while it is the agent's window now, untouched (a
 *   press, a key, a drag, a resize, a wheel), not in its large view and holding no private desktop: anything else makes
 *   it the member's, and the rule lets go of it for good. A window the member opened is never the rule's, so it never
 *   closes one, and never one through which the member holds a desktop.
 * - The company feeds it (application.ts, on every change of the company's state), whatever thread is shown; the thread
 *   that shows the agent feeds it too.
 * - It never wakes or starts a computer: the agent's machine runs while the signal is on, and the window opens as the
 *   member's own click would, without asking for a start (the open path's "member asked" is false).
 *
 * What it keeps, and what ends each (the table is in lanes/desktop-computers-20261110/AT-COMPUTER-PROGRESS.md):
 * - `#owned` (per agent: the window the rule opened, its stretch, its touch listeners, its close timer): ended by a
 *   touch, by the window ceasing to be the agent's current one or entering its large view or holding a desktop, by the
 *   member's close, by any close of the agent's window (ComputerPanels.close says so), by the timer, by dispose.
 * - The close timer: started when the agent is seen not using its computer; cancelled when it is seen using it again;
 *   on firing it checks ownership again and closes only the window it owns.
 * - `#shownFor` and `#declined` (per agent: a stretch): plain memory, no timer; a new stretch replaces them. */

/** How long a window that came by itself and was not touched stays after the agent stopped using its computer. */
export const AUTO_CLOSE_MS = 60_000;

/** The agent's window as it is now. */
export interface CurrentWindow {
	el: HTMLElement;
	/** The member holds its desktop privately, or has its large view open: the window is theirs. */
	theirs: boolean;
}

interface Owned {
	since: string;
	el: HTMLElement;
	stopTouch: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

export interface ComputerByItselfOptions {
	/** The agent's window now, if there is one. */
	current(agentId: string): CurrentWindow | undefined;
	/** Ends the agent's window (as ComputerPanels.close). */
	close(agentId: string): void;
}

export class ComputerByItself {
	readonly #options: ComputerByItselfOptions;
	/** The windows the rule opened and still owns. */
	readonly #owned = new Map<string, Owned>();
	/** The stretch each agent's window last came by itself for: once per stretch. */
	readonly #shownFor = new Map<string, string>();
	/** The stretch in which the member closed each agent's window: it stays closed through it. */
	readonly #declined = new Map<string, string>();
	/** The threads that show a window this closes. */
	readonly #listeners = new Set<(agentId: string) => void>();
	#done = false;

	constructor(options: ComputerByItselfOptions) {
		this.#options = options;
	}

	/** Whether the agent's window should show by itself now in its thread: the agent uses its computer in the stretch
	 * `since` (undefined: it does not), `open` the window shows in this thread already, `busy` the member has a large
	 * view open or types privately on a computer. */
	wanted(agentId: string, since: string | undefined, open: boolean, busy: boolean): boolean {
		if (this.#done || since === undefined || open || busy) return false;
		if (this.#declined.get(agentId) === since) return false;
		return this.#shownFor.get(agentId) !== since;
	}

	/** The window came by itself for the stretch `since`; `el` is its element. */
	opened(agentId: string, since: string, el: HTMLElement): void {
		if (this.#done) return;
		this.#forget(agentId);
		this.#shownFor.set(agentId, since);
		const touched = () => {
			if (this.#owned.get(agentId)?.el === el) this.#forget(agentId);
		};
		const events = ["pointerdown", "keydown", "wheel"] as const;
		for (const event of events) el.addEventListener(event, touched, { capture: true, passive: true });
		this.#owned.set(agentId, {
			since,
			el,
			stopTouch: () => {
				for (const event of events) el.removeEventListener(event, touched, { capture: true });
			},
		});
	}

	/** What the agent's work is now: `since` while it uses its computer, else undefined. A window the rule owns goes
	 * AUTO_CLOSE_MS after the agent stopped; using it again keeps it. */
	seen(agentId: string, since: string | undefined): void {
		const owned = this.#owned.get(agentId);
		if (!owned || !this.#owns(agentId, owned)) return;
		if (since !== undefined) {
			clearTimeout(owned.timer);
			owned.timer = undefined;
			return;
		}
		if (owned.timer) return;
		owned.timer = setTimeout(() => {
			owned.timer = undefined;
			if (this.#owned.get(agentId) !== owned || !this.#owns(agentId, owned)) return;
			this.#forget(agentId);
			this.#options.close(agentId);
			for (const listener of this.#listeners) listener(agentId);
		}, AUTO_CLOSE_MS);
	}

	/** Every window the rule owns, against the company's word for its agent (`sinceOf`). */
	refresh(sinceOf: (agentId: string) => string | undefined): void {
		for (const agentId of [...this.#owned.keys()]) this.seen(agentId, sinceOf(agentId));
	}

	/** The member closed the agent's window while it used its computer in the stretch `since` (undefined: it did not):
	 * the window stays closed through that stretch. */
	closed(agentId: string, since: string | undefined): void {
		this.#forget(agentId);
		if (since !== undefined) this.#declined.set(agentId, since);
	}

	/** The agent's window ended (any close): the rule owns nothing of the agent's any more. */
	released(agentId: string): void {
		this.#forget(agentId);
	}

	/** Whether the rule owns the agent's window now (it came by itself and is untouched). */
	owns(agentId: string): boolean {
		const owned = this.#owned.get(agentId);
		return owned !== undefined && this.#owns(agentId, owned);
	}

	/** `listener` hears of each window closed here (by its agent's id), so a thread lets go of it. */
	onClose(listener: (agentId: string) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): void {
		this.#done = true;
		for (const agentId of [...this.#owned.keys()]) this.#forget(agentId);
		this.#shownFor.clear();
		this.#declined.clear();
		this.#listeners.clear();
	}

	/** The rule still owns `owned`: it is the agent's window now, and not the member's. Otherwise it lets go for good. */
	#owns(agentId: string, owned: Owned): boolean {
		const current = this.#options.current(agentId);
		if (current?.el === owned.el && !current.theirs) return true;
		if (this.#owned.get(agentId) === owned) this.#forget(agentId);
		return false;
	}

	#forget(agentId: string): void {
		const owned = this.#owned.get(agentId);
		if (!owned) return;
		clearTimeout(owned.timer);
		owned.stopTouch();
		this.#owned.delete(agentId);
	}
}
