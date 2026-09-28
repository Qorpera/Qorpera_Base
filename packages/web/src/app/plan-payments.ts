import type { CloudApi } from "../cloud/api.ts";
import { CloudRpcError } from "../cloud/client.ts";
import { ComputerBillingError, type ComputerHourOffer, type MyComputerPlan } from "../cloud/computer-billing.ts";
import { t } from "../ui/preferences.ts";

/** What Plan & usage shows of payments: the offers, the member's own plan, and a
 * checkout or billing page on its way. Nothing is cached across sign-ins. */
export interface PlanPaymentsState {
	offers: ComputerHourOffer[];
	plan?: MyComputerPlan;
	loaded: boolean;
	/** The item key (or "portal") whose Stripe page is opening. */
	opening?: string;
	error?: string;
	/** Back from Stripe's checkout page. */
	returned?: "done";
}

function refusalText(error: unknown): string {
	if (!(error instanceof ComputerBillingError)) return t("Payments are unavailable right now. Try again in a moment.");
	switch (error.refusal) {
		case "has_plan":
			return t("You already have a plan. Change it under Payments and invoices.");
		case "not_a_founder":
			return t("Only the company's founders can buy computer hours.");
		case "item_unavailable":
			return t("This offer is not available right now.");
		case "no_customer":
			return t("No payments yet.");
		default:
			return t("Payments are unavailable right now. Try again in a moment.");
	}
}

/** Stripe sends the member back to "#/account?checkout=done" (or "=cancelled"): read once, then
 * removed from the address, like a connector's return (cloud/connectors.ts). */
export function takeCheckoutReturn(): "done" | "cancelled" | undefined {
	const hash = location.hash;
	const at = hash.indexOf("?");
	if (at < 0) return undefined;
	const checkout = new URLSearchParams(hash.slice(at + 1)).get("checkout");
	if (checkout !== "done" && checkout !== "cancelled") return undefined;
	history.replaceState(null, "", hash.slice(0, at) || "#/");
	return checkout;
}

/** Stripe confirms a payment a moment after the member is back: the plan is read again once. */
const RETURN_REFRESH_MS = 5000;

export class PlanPayments {
	readonly #api: CloudApi;
	readonly #changed: () => void;
	#state: PlanPaymentsState = { offers: [], loaded: false };
	#loading = false;
	#disposed = false;
	#refresh: ReturnType<typeof setTimeout> | undefined;

	constructor(api: CloudApi, changed: () => void, returned?: "done") {
		this.#api = api;
		this.#changed = changed;
		if (returned) {
			this.#state.returned = returned;
			this.#refresh = setTimeout(() => {
				this.#refresh = undefined;
				if (this.#disposed || this.#loading) return;
				this.#state = { ...this.#state, loaded: false };
				this.load();
			}, RETURN_REFRESH_MS);
		}
	}

	get state(): PlanPaymentsState {
		return this.#state;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#refresh) clearTimeout(this.#refresh);
	}

	#set(next: Partial<PlanPaymentsState>): void {
		if (this.#disposed) return;
		this.#state = { ...this.#state, ...next };
		this.#changed();
	}

	/** Loads once; a cloud without payments shows no offers and no plan. */
	load(): void {
		if (this.#loading || this.#state.loaded) return;
		this.#loading = true;
		// A failed lookup keeps what was shown (a refresh after returning from Stripe must not blank it).
		const shown = this.#state;
		void Promise.all([
			this.#api.listComputerHourOffers().catch((error: unknown) => {
				if (error instanceof CloudRpcError && error.missing) return [];
				throw error;
			}),
			this.#api.getMyComputerPlan().catch((error: unknown) => {
				if (error instanceof CloudRpcError && error.missing) return undefined;
				throw error;
			}),
		])
			.then(([offers, plan]) => this.#set({ offers, plan, loaded: true }))
			// Payments are optional on this page: a failed lookup shows no offers, never an error.
			.catch(() => this.#set({ offers: shown.offers, plan: shown.plan, loaded: true }))
			.finally(() => {
				this.#loading = false;
			});
	}

	/** A plan for the member, or (with a company) a pack of hours for it. */
	checkout(itemKey: string, profileId?: string): void {
		this.#open(itemKey, () => this.#api.startComputerCheckout(itemKey, profileId));
	}

	portal(): void {
		this.#open("portal", () => this.#api.openComputerBillingPortal());
	}

	#open(key: string, page: () => Promise<string>): void {
		if (this.#state.opening) return;
		this.#set({ opening: key, error: undefined, returned: undefined });
		void page()
			.then((url) => {
				if (this.#disposed) return;
				// Coming back with the browser's Back button shows this page again, ready.
				window.addEventListener("pageshow", () => this.#set({ opening: undefined }), { once: true });
				location.assign(url);
			})
			.catch((error: unknown) => this.#set({ opening: undefined, error: refusalText(error) }));
	}
}
