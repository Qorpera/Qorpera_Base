import type { TableValue } from "@qorpera/cloud-client/interfaces";
import { CloudRpcError } from "../cloud/client.ts";
import type {
	InterfaceOfferAnswer,
	InterfaceOfferCalls,
	InterfaceOfferRequest,
	MemberInterfaceOffers,
} from "../cloud/interface-offers.ts";
import type {
	InterfaceSupervisionAnswer,
	InterfaceSupervisionCalls,
	MemberInterfaceSupervision,
} from "../cloud/interface-supervisions.ts";

/* The company's open offers of claimed cells (Interfaces step I9c; deploy/first-node/RUNTIME-INTERFACES.md §5
 * "Offers", supabase/CLIENT-CONTRACT.md "Offers of a claimed cell"), and its live supervision consents (step I9b, §5.1;
 * "Supervision consent"). They are read when the company opens, again after the folder the pages read changes
 * (app/application.ts), when the window comes back into focus, and each minute while it shows; making, declining or
 * withdrawing one reads them again. A cloud without the offers' calls, or a member the calls don't answer, publishes
 * nothing, so no page draws an offer; without the consents' calls, no page draws an area's supervision. A read that
 * fails keeps what was read before. */

export interface InterfaceOffersState extends MemberInterfaceOffers {
	/** The live consents, or null where they can't be read. */
	readonly supervisions: readonly MemberInterfaceSupervision[] | null;
}

/** What a page does with offers and consents. Each call reads them again once it is answered, and settles when that
 * read has been published, so a page drawn then shows the change. */
export interface InterfaceOfferActions {
	offer(request: InterfaceOfferRequest): Promise<InterfaceOfferAnswer>;
	decline(offer: string): Promise<void>;
	withdraw(offer: string): Promise<void>;
	/** Consents again to supervise the area whose row has this key (step I9b). */
	consent(key: readonly TableValue[]): Promise<InterfaceSupervisionAnswer>;
	/** Ends the member's own live consent (step I9b). */
	withdrawSupervision(supervision: string): Promise<void>;
	/** Reads the offers again (after an accept, whose save settles the offer), settling once a read that started after
	 * the call is answered. */
	refresh(): Promise<void>;
}

const POLL_MS = 60_000;

/** Calls the cloud doesn't have, or doesn't answer for this member. */
const unanswered = (error: unknown) => error instanceof CloudRpcError && (error.missing || error.denied);

export class CompanyInterfaceOffers implements InterfaceOfferActions {
	readonly #calls: InterfaceOfferCalls;
	readonly #supervisions: InterfaceSupervisionCalls;
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
		supervisions: InterfaceSupervisionCalls,
		publish: (state: InterfaceOffersState | undefined) => void,
		signal: AbortSignal,
	) {
		this.#calls = calls;
		this.#supervisions = supervisions;
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

	async consent(key: readonly TableValue[]): Promise<InterfaceSupervisionAnswer> {
		try {
			return await this.#supervisions.consent(key);
		} finally {
			await this.refresh();
		}
	}

	async withdrawSupervision(supervision: string): Promise<void> {
		try {
			await this.#supervisions.withdraw(supervision);
		} finally {
			await this.refresh();
		}
	}

	async #read(): Promise<void> {
		let state: InterfaceOffersState | undefined;
		try {
			const [offers, supervisions] = await Promise.all([
				this.#calls.list(),
				this.#supervisions.list().then(
					(read) => read.supervisions,
					(error: unknown) => {
						if (unanswered(error)) return null;
						throw error;
					},
				),
			]);
			// The offers of agents to an area's supervisor (I9b) wait for the Members board: the pages draw cells' offers.
			state = { ...offers, offers: offers.offers.filter((offer) => offer.agent === null), supervisions };
		} catch (error) {
			// Not deployed, or not answered for this member: there are no offers to draw. Anything else keeps the last.
			if (!unanswered(error)) return;
			state = undefined;
		}
		if (this.#stop.signal.aborted) return;
		const shown = JSON.stringify(state ?? null);
		if (shown === this.#shown) return;
		this.#shown = shown;
		this.#publish(state);
	}
}
