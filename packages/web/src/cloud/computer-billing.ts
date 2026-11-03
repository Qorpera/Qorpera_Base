import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, nonEmptyString, oneOf, record, timestamp, uuid } from "./parse.ts";

/* Plans and computer hours bought through Stripe (migration
 * 20260928248910_runtime_computer_hours_payments, Edge Function
 * computer-billing; contract section 19, 2026-09-28 amendment "computer
 * hours", item 8). Card data never passes through here: the member pays on
 * Stripe's checkout page and manages cards and invoices on Stripe's billing
 * page. */

export interface ComputerHourOffer {
	itemKey: string;
	kind: "plan" | "credits";
	name: string;
	/** Excluding VAT, in øre. */
	priceMinor: number;
	currency: "dkk";
	/** Hours a month for a plan, hours in the pack for credits. */
	hours: number;
	/** Whether this member can buy it now. */
	available: boolean;
}

export interface MyComputerPlan {
	/** Before the live switch nothing is charged: payments only make trial records. */
	mode: "dry_run" | "live";
	plan: {
		itemKey: string;
		status: string;
		periodStart?: string;
		periodEnd?: string;
		cancelAtPeriodEnd: boolean;
	} | null;
	/** Left out until live payments: members see only measured hours before then. */
	hours: {
		/** Hours in the plan's current period, in standard seconds. */
		grantedSeconds: number;
		/** What each company used of it this period, most first. */
		companies: { profileId: string; seconds: number }[];
	} | null;
}

const MAX_SECONDS = 1_000_000_000_000;

export function parseComputerHourOffers(value: unknown): ComputerHourOffer[] {
	const input = record(value, "computer hour offers");
	if (input.schema !== "qorpera.computer-hour-offers/v1") throw new CloudShapeError("computer hour offers");
	return array(input.items, "computer hour offers").map((item) => {
		const offer = record(item, "computer hour offer");
		if (offer.currency !== "dkk") throw new CloudShapeError("computer hour offer currency");
		return {
			itemKey: nonEmptyString(offer.itemKey, "computer hour offer", 32),
			kind: oneOf(offer.kind, ["plan", "credits"] as const, "computer hour offer kind"),
			name: nonEmptyString(offer.name, "computer hour offer name", 64),
			priceMinor: boundedInteger(offer.priceMinor, "computer hour offer price", 1, 100_000_000),
			currency: "dkk",
			hours: boundedInteger(offer.hours, "computer hour offer hours", 1, 1_000_000),
			available: offer.available === true,
		};
	});
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : timestamp(value, label);
}

export function parseMyComputerPlan(value: unknown): MyComputerPlan {
	const input = record(value, "computer plan");
	if (input.schema !== "qorpera.my-computer-plan/v1") throw new CloudShapeError("computer plan");
	const plan = input.plan === null || input.plan === undefined ? null : record(input.plan, "computer plan");
	const hours = input.hours === null || input.hours === undefined ? null : record(input.hours, "computer plan hours");
	return {
		mode: oneOf(input.mode, ["dry_run", "live"] as const, "computer plan mode"),
		plan: plan
			? {
					itemKey: nonEmptyString(plan.itemKey, "computer plan item", 32),
					status: nonEmptyString(plan.status, "computer plan status", 64),
					periodStart: optionalTimestamp(plan.periodStart, "computer plan period start"),
					periodEnd: optionalTimestamp(plan.periodEnd, "computer plan period end"),
					cancelAtPeriodEnd: plan.cancelAtPeriodEnd === true,
				}
			: null,
		hours: hours
			? {
					grantedSeconds: boundedInteger(hours.grantedSeconds, "computer plan hours", 0, MAX_SECONDS),
					companies: array(hours.companies, "computer plan companies").map((item) => {
						const used = record(item, "computer plan company");
						return {
							profileId: uuid(used.profileId, "computer plan company"),
							seconds: boundedInteger(used.seconds, "computer plan company hours", 0, MAX_SECONDS),
						};
					}),
				}
			: null,
	};
}

export async function listComputerHourOffers(cloud: Cloud): Promise<ComputerHourOffer[]> {
	return parseComputerHourOffers(await cloud.rpc("qorpera_list_computer_hour_offers", {}));
}

export async function readMyComputerPlan(cloud: Cloud): Promise<MyComputerPlan> {
	return parseMyComputerPlan(await cloud.rpc("qorpera_read_my_computer_plan", {}));
}

/** Why the billing function turned a request down. */
export type ComputerBillingRefusal = "has_plan" | "not_a_founder" | "item_unavailable" | "no_customer" | "unavailable";

export class ComputerBillingError extends Error {
	readonly refusal: ComputerBillingRefusal;
	constructor(refusal: ComputerBillingRefusal) {
		super(`Computer billing refused: ${refusal}`);
		this.name = "ComputerBillingError";
		this.refusal = refusal;
	}
}

const REFUSALS = ["has_plan", "not_a_founder", "item_unavailable", "no_customer"] as const;

/** Only Stripe's own pages are opened: a checkout on checkout.stripe.com, the billing page on billing.stripe.com. */
async function stripePage(cloud: Cloud, route: "checkout" | "portal", body: object, host: string): Promise<string> {
	const { data } = await cloud.supabase.auth.getSession();
	const token = data.session?.access_token;
	if (!token) throw new ComputerBillingError("unavailable");
	let response: Response;
	try {
		response = await fetch(`${cloud.config.projectUrl}/functions/v1/computer-billing/${route}`, {
			method: "POST",
			headers: {
				apikey: cloud.config.publishableKey,
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			redirect: "error",
			credentials: "omit",
		});
	} catch {
		throw new ComputerBillingError("unavailable");
	}
	cloud.noticeResponse?.(`${cloud.config.projectUrl}/functions/v1/computer-billing/${route}`, token, response);
	const answer: unknown = await response.json().catch(() => null);
	const fields =
		answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
	if (response.status === 409) {
		const refusal = REFUSALS.find((item) => item === fields.refused);
		throw new ComputerBillingError(refusal ?? "unavailable");
	}
	if (!response.ok || typeof fields.url !== "string") throw new ComputerBillingError("unavailable");
	const url = new URL(fields.url);
	// Stripe's own origin exactly (a Stripe custom domain would need a change here).
	if (url.origin !== `https://${host}`) throw new ComputerBillingError("unavailable");
	return url.href;
}

/** Stripe's checkout page for a plan (for the member) or a pack of hours (for the company; founders only). */
export function startComputerCheckout(cloud: Cloud, itemKey: string, profileId?: string): Promise<string> {
	return stripePage(cloud, "checkout", profileId ? { itemKey, profileId } : { itemKey }, "checkout.stripe.com");
}

/** Stripe's billing page: cards, invoices, changing or cancelling the plan. */
export function openComputerBillingPortal(cloud: Cloud): Promise<string> {
	return stripePage(cloud, "portal", {}, "billing.stripe.com");
}
