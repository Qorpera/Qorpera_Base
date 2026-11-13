/* The computer's window shows by itself in an agent's thread while the agent uses its desktop computer (Jonas, 13 Nov
 * 2026: "when an agent IS using a desktop computer, the computers window pops up in it's threat for you to see";
 * 20260930742000). The rules, one company's worth (they outlive a thread view, as the windows do):
 * - It shows in THAT agent's thread only, while the agent works at its computer (the rail's `computer` state), the
 *   window is not shown there already, and the member neither has any computer's large view open nor types privately
 *   on any computer (busy). It shows small, watch only, where a click would put it, and takes no focus.
 * - Once per stretch of the agent's use (the database's `since`): a window the member closed stays closed until the
 *   agent stopped and began again (a new `since`). There is no setting: closing it is the member's no.
 * - A window that came by itself and that the member never touched goes AUTO_CLOSE_MS after the agent stopped (and
 *   stays if the agent begins again before); one the member touched (a press, a key, a drag, a resize, a wheel) stays
 *   until they close it. A window the member opened is never closed here.
 * - It never wakes or starts a computer: the agent's machine runs while the signal is on, and the window opens as the
 *   member's own click would, without asking for a start (the open path's "member asked" is false). */

/** How long a window that came by itself and was not touched stays after the agent stopped using its computer. */
export const AUTO_CLOSE_MS = 60_000;

interface Shown {
	since: string;
	/** The member touched it: it is theirs now. */
	touched: boolean;
	/** The window's element, while its touch listeners are on. */
	el?: HTMLElement;
	stopTouch?: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

export interface ComputerByItselfOptions {
	/** Ends the agent's window (as ComputerPanels.close). */
	close(agentId: string): void;
}

export class ComputerByItself {
	readonly #options: ComputerByItselfOptions;
	/** The stretch each agent's window last came by itself for, while it is shown or until the stretch ends. */
	readonly #shown = new Map<string, Shown>();
	/** The stretch in which the member closed each agent's window: it stays closed through it. */
	readonly #declined = new Map<string, string>();
	/** The threads that show a window this closes. */
	readonly #listeners = new Set<(agentId: string) => void>();

	constructor(options: ComputerByItselfOptions) {
		this.#options = options;
	}

	/** Whether the agent's window should show by itself now in its thread: the agent uses its computer in the stretch
	 * `since` (undefined: it does not), `open` the window shows in this thread already, `busy` the member has a large
	 * view open or types privately on a computer. */
	wanted(agentId: string, since: string | undefined, open: boolean, busy: boolean): boolean {
		if (since === undefined || open || busy) return false;
		if (this.#declined.get(agentId) === since) return false;
		// Once per stretch: shown for it already (and closed by the rule) is not shown again.
		return this.#shown.get(agentId)?.since !== since;
	}

	/** The window came by itself for the stretch `since`; `el` is its element (a touch makes it the member's). */
	opened(agentId: string, since: string, el: HTMLElement): void {
		this.#forget(agentId);
		const shown: Shown = { since, touched: false, el };
		const touch = () => this.#touched(agentId, shown);
		const events = ["pointerdown", "keydown", "wheel"] as const;
		for (const event of events) el.addEventListener(event, touch, { capture: true, passive: true });
		shown.stopTouch = () => {
			for (const event of events) el.removeEventListener(event, touch, { capture: true });
		};
		this.#shown.set(agentId, shown);
	}

	/** What the agent's thread sees of it now: `since` while it works at its computer, else undefined. A window that came
	 * by itself and was not touched goes AUTO_CLOSE_MS after it stopped; a new stretch keeps it. */
	seen(agentId: string, since: string | undefined): void {
		// A declined stretch needs nothing here: the next stretch has another `since`, and only that one shows it again.
		const shown = this.#shown.get(agentId);
		if (!shown || shown.touched) return;
		if (since !== undefined) {
			clearTimeout(shown.timer);
			shown.timer = undefined;
			return;
		}
		if (shown.timer) return;
		shown.timer = setTimeout(() => {
			shown.timer = undefined;
			if (this.#shown.get(agentId) !== shown || shown.touched) return;
			shown.stopTouch?.();
			shown.stopTouch = undefined;
			shown.el = undefined;
			// Kept (without its window) so the same stretch never brings it back.
			this.#options.close(agentId);
			for (const listener of this.#listeners) listener(agentId);
		}, AUTO_CLOSE_MS);
	}

	/** The member closed the agent's window while it used its computer in the stretch `since` (undefined: it did not):
	 * the window stays closed through that stretch. */
	closed(agentId: string, since: string | undefined): void {
		this.#forget(agentId);
		if (since !== undefined) this.#declined.set(agentId, since);
	}

	/** `listener` hears of each window closed here (by its agent's id), so a thread lets go of it. */
	onClose(listener: (agentId: string) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Whether the agent's window came by itself and the member has not touched it. */
	untouched(agentId: string): boolean {
		const shown = this.#shown.get(agentId);
		return shown !== undefined && shown.el !== undefined && !shown.touched;
	}

	dispose(): void {
		for (const agentId of [...this.#shown.keys()]) this.#forget(agentId);
		this.#declined.clear();
		this.#listeners.clear();
	}

	#touched(agentId: string, shown: Shown): void {
		if (this.#shown.get(agentId) !== shown) return;
		shown.touched = true;
		clearTimeout(shown.timer);
		shown.timer = undefined;
		shown.stopTouch?.();
		shown.stopTouch = undefined;
	}

	#forget(agentId: string): void {
		const shown = this.#shown.get(agentId);
		if (!shown) return;
		clearTimeout(shown.timer);
		shown.stopTouch?.();
		this.#shown.delete(agentId);
	}
}
