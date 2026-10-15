import { CloudRpcError } from "../cloud/client.ts";
import type {
	InterfaceOfferAnswer,
	InterfaceOfferCalls,
	InterfaceOfferRequest,
	MemberInterfaceOffers,
} from "../cloud/interface-offers.ts";

/* The company's open offers of claimed cells (Interfaces step I9c; deploy/first-node/RUNTIME-INTERFACES.md §5
 * "Offers", supabase/CLIENT-CONTRACT.md "Offers of a claimed cell"). They are read when the company opens, again after
 * the folder the pages read changes (app/application.ts), when the window comes back into focus, and each minute while
 * it shows; making, declining or withdrawing one reads them again. A cloud without the calls, or a member the calls
 * don't answer, publishes nothing, so no page draws an offer. A read that fails keeps what was read before. */

export type InterfaceOffersState = MemberInterfaceOffers;

/** What a page does with offers. Each call reads the offers again once it is answered, and settles when that read has
 * been published, so a page drawn then shows the change. */
export interface InterfaceOfferActions {
	offer(request: InterfaceOfferRequest): Promise<InterfaceOfferAnswer>;
	decline(offer: string): Promise<void>;
	withdraw(offer: string): Promise<void>;
	/** Reads the offers again (after an accept, whose save settles the offer), settling once a read that started after
	 * the call is answered. */
	refresh(): Promise<void>;
}

const POLL_MS = 60_000;

export class CompanyInterfaceOffers implements InterfaceOfferActions {
	readonly #calls: InterfaceOfferCalls;
	readonly #publish: (state: InterfaceOffersState | undefined) => void;
	readonly #stop = new AbortController();
	#poll?: ReturnType<typeof setInterval>;
	/** The read on its way. */
	#reading: Promise<void> | null = null;
	/** The read asked for while one was on its way: it runs once that one is answered, for every call meanwhile. */
	#again: Promise<void> | null = null;
	/** What was last published, as JSON; nothing is published while it stays the same. */
	#shown: string | undefined;

	constructor(
		calls: InterfaceOfferCalls,
		publish: (state: InterfaceOffersState | undefined) => void,
		signal: AbortSignal,
	) {
		this.#calls = calls;
		this.#publish = publish;
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#stop.signal });
	}

	/** Reads the offers, then follows focus and the minute poll. */
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

	async offer(request: InterfaceOfferRequest): Promise<InterfaceOfferAnswer> {
		try {
			return await this.#calls.offer(request);
		} finally {
			await this.refresh();
		}
	}

	async decline(offer: string): Promise<void> {
		try {
			await this.#calls.decline(offer);
		} finally {
			await this.refresh();
		}
	}

	async withdraw(offer: string): Promise<void> {
		try {
			await this.#calls.withdraw(offer);
		} finally {
			await this.refresh();
		}
	}

	async #read(): Promise<void> {
		let state: InterfaceOffersState | undefined;
		try {
			state = await this.#calls.list();
			// The offers of agents to an area's supervisor (I9b) wait for the Members board: the pages draw cells' offers.
			state = { ...state, offers: state.offers.filter((offer) => offer.agent === null) };
		} catch (error) {
			// Not deployed, or not answered for this member: there are no offers to draw. Anything else keeps the last.
			if (!(error instanceof CloudRpcError && (error.missing || error.denied))) return;
			state = undefined;
		}
		if (this.#stop.signal.aborted) return;
		const shown = JSON.stringify(state ?? null);
		if (shown === this.#shown) return;
		this.#shown = shown;
		this.#publish(state);
	}
}
