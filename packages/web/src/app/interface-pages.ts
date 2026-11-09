import { CloudRpcError } from "../cloud/client.ts";
import type { InterfacePageCalls, InterfacePageName, MemberInterfacePages } from "../cloud/interface-pages.ts";

/* Which pages the company shows (Interfaces C6a; supabase/CLIENT-CONTRACT.md "Pages"). They are read when the company
 * opens, when the window comes back into focus, and each minute while it shows; a member hides or shows one on their own
 * rail (views/shell.ts), and the answer is published at once. A cloud
 * without the calls, or a member the calls don't answer, publishes nothing, so no page shows. A read that fails keeps
 * what was read before. */

export type InterfacePagesState = MemberInterfacePages;

const POLL_MS = 60_000;

export class CompanyInterfacePages {
	readonly #calls: InterfacePageCalls;
	readonly #publishTo: (state: InterfacePagesState | undefined) => void;
	readonly #stop = new AbortController();
	#poll?: ReturnType<typeof setInterval>;
	/** The read on its way. */
	#reading: Promise<void> | null = null;
	/** The read asked for while one was on its way: it runs once that one is answered, for every call meanwhile. */
	#again: Promise<void> | null = null;
	/** What was last published, as JSON; nothing is published while it stays the same. */
	#shown: string | undefined;
	/** Counts changes: a read that a change overtook is dropped, so the change's answer stays the last word. */
	#changes = 0;
	/** The last change asked for, settled: the next one starts after it. */
	#changing: Promise<void> = Promise.resolve();

	constructor(
		calls: InterfacePageCalls,
		publish: (state: InterfacePagesState | undefined) => void,
		signal: AbortSignal,
	) {
		this.#calls = calls;
		this.#publishTo = publish;
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#stop.signal });
	}

	/** Reads the pages, then follows focus and the minute poll. */
	open(): void {
		if (this.#stop.signal.aborted || this.#poll) return;
		const listen = { signal: this.#stop.signal };
		const shows = () => document.visibilityState === "visible";
		window.addEventListener("focus", () => void this.refresh(), listen);
		document.addEventListener("visibilitychange", () => void (shows() && this.refresh()), listen);
		this.#poll = setInterval(() => void (shows() && this.refresh()), POLL_MS);
		void this.refresh();
	}

	dispose(): void {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		clearInterval(this.#poll);
	}

	/** Hides a page from the member's own rail, or shows it again. Changes run one at a time, each after the last has answered
	 * (or failed and been read again), so an older answer never lands over a newer one. A change that fails reads the
	 * pages again (it may still have landed) and throws. */
	hide(page: InterfacePageName, hidden: boolean): Promise<void> {
		const run = () => this.#change(page, hidden);
		const next = this.#changing.then(run, run);
		this.#changing = next.catch(() => {});
		return next;
	}

	async #change(page: InterfacePageName, hidden: boolean): Promise<void> {
		if (this.#stop.signal.aborted) return;
		this.#changes++;
		let state: InterfacePagesState;
		try {
			state = await this.#calls.hide(page, hidden);
		} catch (error) {
			this.#changes++;
			await this.refresh();
			throw error;
		}
		if (this.#stop.signal.aborted) return;
		this.#changes++;
		this.#publish(state);
	}

	#publish(state: InterfacePagesState | undefined): void {
		const shown = JSON.stringify(state ?? null);
		if (shown === this.#shown) return;
		this.#shown = shown;
		this.#publishTo(state);
	}

	refresh(): Promise<void> {
		if (this.#stop.signal.aborted) return Promise.resolve();
		if (this.#reading) {
			const next = () => {
				this.#again = null;
				return this.refresh();
			};
			this.#again ??= this.#reading.then(next, next);
			return this.#again;
		}
		this.#reading = this.#read().finally(() => {
			this.#reading = null;
		});
		return this.#reading;
	}

	async #read(): Promise<void> {
		const changes = this.#changes;
		let state: InterfacePagesState | undefined;
		try {
			state = await this.#calls.list();
		} catch (error) {
			// Not deployed, or not answered for this member: there are no pages to show. Anything else keeps the last.
			if (!(error instanceof CloudRpcError && (error.missing || error.denied))) return;
			state = undefined;
		}
		if (this.#stop.signal.aborted || changes !== this.#changes) return;
		this.#publish(state);
	}
}
