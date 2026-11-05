/* Good will payments (design: good-will-tax-design.md, migration 20260930566000_good_will).
 *
 * A company pays a monthly share of its customer sales. Three parts live here, beside computer hours:
 * - POST /good-will-card {profileId}: a founder opens Stripe Checkout in setup mode to save the card that pays the
 *   company's good will. Returns {url}. Card data never passes through here.
 * - POST /good-will-invoices: the database's clock (x-qorpera-billing-key) asks for the closed months' invoices. Each
 *   is a Stripe invoice to the company's card with Stripe Tax (25 % Danish moms, or reverse charge for an EU business
 *   with a VAT number), charged by Stripe, which also tries a failed card again.
 * - Stripe's events: a completed setup page saves the card; a paid or failed invoice moves the month.
 * Before the live switch the database invoices nothing with a live key, and test mode is for enrolled testers only. */

type Json = Record<string, unknown>;

export interface GoodWillStore {
	call(method: string, args: Json): Promise<Json>;
}

export interface GoodWillStripe {
	get(path: string): Promise<Json>;
	post(path: string, form: Record<string, string>, idempotencyKey?: string): Promise<Json>;
}

export interface GoodWillDependencies {
	goodWill: GoodWillStore;
	/** The computer-billing door, for the member's Stripe customer. */
	store: GoodWillStore;
	stripe: GoodWillStripe;
	livemode: boolean;
	returnUrl: string;
}

export interface GoodWillOutcome {
	outcome: "applied" | "ignored" | "needs_review";
	detail?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const GOOD_WILL_KIND = "good_will";

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function object(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function idOf(value: unknown): string | undefined {
	return string(value) ?? string(object(value)?.id);
}

function withQuery(base: string, query: string): string {
	return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

/** The member's Stripe customer in this mode, made the first time. */
async function customerOf(member: { id: string; email: string }, known: string | undefined, deps: GoodWillDependencies) {
	if (known) return known;
	const customer = await deps.stripe.post(
		"/v1/customers",
		{ email: member.email, "metadata[qorpera_user_id]": member.id },
		`qorpera-customer-${member.id}-${deps.livemode ? "live" : "test"}`,
	);
	const saved = await deps.store.call("customer_set", {
		userId: member.id,
		customerId: string(customer.id),
		livemode: deps.livemode,
	});
	const customerId = string(saved.customerId);
	if (!customerId) throw new Error("Stripe customer was not saved");
	return customerId;
}

/** Stripe's page where a founder saves the company's card: {url}, or {refused}. */
export async function startGoodWillCard(
	member: { id: string; email: string },
	body: Json | undefined,
	deps: GoodWillDependencies,
): Promise<{ status: number; body: Json }> {
	const profileId = string(body?.profileId);
	if (!profileId || !UUID.test(profileId)) return { status: 400, body: { error: "Choose a company" } };
	const begin = await deps.goodWill.call("card_begin", { userId: member.id, profileId, livemode: deps.livemode });
	if (string(begin.refused)) return { status: 409, body: { refused: begin.refused } };
	const setupId = string(begin.setupId);
	if (!setupId) throw new Error("The card page could not begin");
	const customerId = await customerOf(member, string(begin.customerId), deps);
	const metadata: Record<string, string> = {
		qorpera_kind: GOOD_WILL_KIND,
		qorpera_setup_id: setupId,
		qorpera_profile_id: profileId,
		qorpera_user_id: member.id,
	};
	const form: Record<string, string> = {
		mode: "setup",
		currency: "dkk",
		customer: customerId,
		"payment_method_types[0]": "card",
		// Stripe Tax needs the address on the invoice: 25 % moms in Denmark, reverse charge for an EU business.
		billing_address_collection: "required",
		"customer_update[address]": "auto",
		"customer_update[name]": "auto",
		client_reference_id: setupId,
		success_url: withQuery(deps.returnUrl, "good-will=card-saved"),
		cancel_url: withQuery(deps.returnUrl, "good-will=card-cancelled"),
	};
	for (const [key, value] of Object.entries(metadata)) {
		form[`metadata[${key}]`] = value;
		form[`setup_intent_data[metadata][${key}]`] = value;
	}
	const session = await deps.stripe.post("/v1/checkout/sessions", form, `qorpera-good-will-card-${setupId}`);
	const sessionId = string(session.id);
	const url = string(session.url);
	if (!sessionId || !url) throw new Error("Stripe returned no card page");
	await deps.goodWill.call("card_attach", { setupId, sessionId });
	return { status: 200, body: { url } };
}

/** The closed months' invoices, one each (Stripe's idempotency keys and the database's record keep it once). */
export async function sendGoodWillInvoices(deps: GoodWillDependencies): Promise<Json> {
	const due = await deps.goodWill.call("due", { livemode: deps.livemode });
	const months = Array.isArray(due.months) ? due.months : [];
	let invoiced = 0;
	const failed: string[] = [];
	for (const value of months) {
		const month = object(value);
		const profileId = string(month?.profileId);
		const period = string(month?.month);
		const dueOre = month?.dueOre;
		const customerId = string(month?.customerId);
		const paymentMethodId = string(month?.paymentMethodId);
		if (
			!profileId ||
			!UUID.test(profileId) ||
			!period ||
			!MONTH.test(period) ||
			typeof dueOre !== "number" ||
			!Number.isSafeInteger(dueOre) ||
			dueOre <= 0 ||
			!customerId ||
			!paymentMethodId
		)
			continue;
		const key = `qorpera-good-will-${profileId}-${period}-${deps.livemode ? "live" : "test"}`;
		const metadata = { qorpera_kind: GOOD_WILL_KIND, qorpera_profile_id: profileId, qorpera_month: period };
		try {
			const invoice = await deps.stripe.post(
				"/v1/invoices",
				{
					customer: customerId,
					currency: "dkk",
					collection_method: "charge_automatically",
					default_payment_method: paymentMethodId,
					auto_advance: "true",
					"automatic_tax[enabled]": "true",
					pending_invoice_items_behavior: "exclude",
					description: `Goodwill ${period}${string(month?.companyName) ? ` · ${string(month?.companyName)}` : ""}`,
					...Object.fromEntries(Object.entries(metadata).map(([name, text]) => [`metadata[${name}]`, text])),
				},
				`${key}-invoice`,
			);
			const invoiceId = string(invoice.id);
			if (!invoiceId) throw new Error("Stripe returned no invoice");
			await deps.stripe.post(
				"/v1/invoiceitems",
				{
					customer: customerId,
					invoice: invoiceId,
					currency: "dkk",
					amount: String(dueOre),
					tax_behavior: "exclusive",
					description: `Goodwill ${period}`,
				},
				`${key}-item`,
			);
			const finalized = await deps.stripe.post(
				`/v1/invoices/${encodeURIComponent(invoiceId)}/finalize`,
				{ auto_advance: "true" },
				`${key}-finalize`,
			);
			await deps.goodWill.call("invoiced", {
				profileId,
				month: period,
				invoiceId,
				invoiceUrl: string(finalized.hosted_invoice_url) ?? null,
				userId: string(month?.userId) ?? null,
				livemode: deps.livemode,
			});
			invoiced++;
		} catch (error) {
			// One company's failure leaves the others; the next tick asks again.
			failed.push(`${profileId} ${period}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failed.length) console.error(`good-will invoices: ${failed.join("; ")}`);
	return { invoiced, failed: failed.length };
}

/** Whether a Stripe object (a setup page, an invoice) is good will's. */
export function isGoodWill(value: Json): boolean {
	return object(value.metadata)?.qorpera_kind === GOOD_WILL_KIND;
}

/** A completed setup page of good will's, re-read from Stripe: the card pays the company's good will from now on. */
export async function applyGoodWillCard(session: Json, deps: GoodWillDependencies): Promise<GoodWillOutcome> {
	const id = string(session.id) ?? "";
	const setupIntentId = idOf(session.setup_intent);
	if (!setupIntentId) return { outcome: "needs_review", detail: `card page ${id} has no setup` };
	const setup = await deps.stripe.get(`/v1/setup_intents/${encodeURIComponent(setupIntentId)}`);
	if (setup.status !== "succeeded") return { outcome: "ignored", detail: `setup ${String(setup.status)}` };
	const paymentMethodId = idOf(setup.payment_method);
	const customerId = idOf(session.customer) ?? idOf(setup.customer);
	if (!paymentMethodId || !customerId) return { outcome: "needs_review", detail: `card page ${id} saved no card` };
	const method = await deps.stripe.get(`/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`);
	const card = object(method.card);
	const saved = await deps.goodWill.call("card_saved", {
		sessionId: id,
		livemode: deps.livemode,
		customerId,
		paymentMethodId,
		brand: string(card?.brand) ?? null,
		last4: string(card?.last4) ?? null,
	});
	return saved.outcome === "applied"
		? { outcome: "applied", detail: "good will card" }
		: { outcome: "needs_review", detail: `good will card: ${String(saved.detail)}` };
}

/** A good will invoice paid or failed, re-read from Stripe: the month is charged, or failed (Stripe tries again). */
export async function applyGoodWillInvoice(
	type: string,
	invoice: Json,
	deps: GoodWillDependencies,
): Promise<GoodWillOutcome> {
	if (type === "invoice.paid" && invoice.status !== "paid") return { outcome: "ignored", detail: "invoice not paid" };
	if (type !== "invoice.paid" && type !== "invoice.payment_failed")
		return { outcome: "ignored", detail: `good will ${type}` };
	const result = await deps.goodWill.call(type === "invoice.paid" ? "invoice_paid" : "invoice_failed", {
		invoiceId: string(invoice.id),
		invoiceUrl: string(invoice.hosted_invoice_url) ?? null,
		livemode: deps.livemode,
	});
	return result.outcome === "applied"
		? { outcome: "applied", detail: `good will ${String(result.status)}` }
		: { outcome: "ignored", detail: String(result.detail ?? "no good will month waits on this invoice") };
}
