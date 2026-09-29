/* Computer hours payments (build step 4b; contract section 19, 2026-09-28 amendment "computer
 * hours", item 8; design deploy/first-node/RUNTIME-COMPUTER-HOURS.md "Payments").
 *
 * Three routes:
 * - POST /checkout {itemKey, profileId?}: a signed-in member starts Stripe Checkout for a plan, or,
 *   as a founder, for credits for their company. Returns {url}.
 * - POST /portal: a member with a Stripe customer opens Stripe's billing page. Returns {url}.
 * - POST /webhook: Stripe's events. Each is verified, recorded once, re-read from Stripe and turned
 *   into sources of hours through the database's billing door. Unknown or unsupported events are
 *   recorded (ignored, or for review) and still answered 2xx; only a passing failure (Stripe or the
 *   database unreachable, or Stripe refusing our key) answers 5xx, so Stripe retries. An event left
 *   for review runs again when it is resent from Stripe's dashboard.
 * Card data never passes through here: Stripe's own pages take it. */

export const STRIPE_API_VERSION = "2026-08-26.dahlia";
const SIGNATURE_TOLERANCE_SECONDS = 300;
const STRIPE_TIMEOUT_MS = 20_000;
const CREDIT_CHECKOUT_SECONDS = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Json = Record<string, unknown>;

/** The database's billing door: qorpera_computer_billing(key, method, args). */
export interface BillingStore {
	call(method: string, args: Json): Promise<Json>;
}

export interface StripeApi {
	get(path: string): Promise<Json>;
	post(path: string, form: Record<string, string>, idempotencyKey?: string): Promise<Json>;
}

export interface MemberAuth {
	/** The signed-in member behind a bearer token, or null. */
	member(token: string): Promise<{ id: string; email: string } | null>;
}

export interface BillingOptions {
	livemode: boolean;
	webhookSecret: string;
	/** Where Checkout and the billing page return to (the web app's Plan & usage). */
	returnUrl: string;
	portalConfiguration?: string;
	allowedOrigins: readonly string[];
	nowSeconds?: () => number;
}

export interface BillingDependencies {
	store: BillingStore;
	stripe: StripeApi;
	auth: MemberAuth;
	options: BillingOptions;
}

/** A Stripe answer that is not 2xx. */
export class StripeRequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "StripeRequestError";
		this.status = status;
	}
}

/** A refusal or failure from the database's billing door. */
export class BillingStoreError extends Error {
	readonly code: string | undefined;
	constructor(code: string | undefined, message: string) {
		super(message);
		this.name = "BillingStoreError";
		this.code = code;
	}
}

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return difference === 0;
}

/** Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]; HMAC-SHA256 of `${t}.${rawBody}`. */
export async function verifyStripeSignature(
	rawBody: string,
	header: string | null,
	secret: string,
	nowSeconds: number,
): Promise<boolean> {
	if (!header || !secret) return false;
	let timestamp: number | undefined;
	const signatures: string[] = [];
	for (const part of header.split(",")) {
		const [key, value] = part.split("=", 2);
		if (key === "t" && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
		else if (key === "v1" && value && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
	}
	if (timestamp === undefined || signatures.length === 0 || signatures.length > 20) return false;
	if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
	return signatures.some((signature) => constantTimeEqual(signature, expected));
}

/** Stripe's REST API with a pinned version, form-encoded requests and idempotency keys. */
export function createStripeApi(secretKey: string, fetchImpl: typeof fetch = fetch): StripeApi {
	const headers = (idempotencyKey?: string): Record<string, string> => ({
		authorization: `Bearer ${secretKey}`,
		"stripe-version": STRIPE_API_VERSION,
		...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
	});
	const answer = async (response: Response): Promise<Json> => {
		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
		if (!response.ok) {
			const message =
				body && typeof body === "object" && "error" in body
					? String((body as { error?: { message?: unknown } }).error?.message ?? response.status)
					: String(response.status);
			throw new StripeRequestError(response.status, `Stripe ${response.status}: ${message}`);
		}
		if (!body || typeof body !== "object") throw new StripeRequestError(502, "Stripe answered without JSON");
		return body as Json;
	};
	return {
		// A request Stripe does not answer in time is a passing failure (a webhook is retried).
		async get(path) {
			return answer(
				await fetchImpl(`https://api.stripe.com${path}`, {
					headers: headers(),
					signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
				}),
			);
		},
		async post(path, form, idempotencyKey) {
			return answer(
				await fetchImpl(`https://api.stripe.com${path}`, {
					method: "POST",
					headers: { ...headers(idempotencyKey), "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams(form).toString(),
					signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
				}),
			);
		},
	};
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function object(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function isoFromUnix(value: unknown): string | undefined {
	return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}

function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
	});
}

function corsHeaders(request: Request, options: BillingOptions): Record<string, string> | undefined {
	const origin = request.headers.get("origin");
	if (!origin) return {};
	if (!options.allowedOrigins.includes(origin)) return undefined;
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "POST, OPTIONS",
		"access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
		"access-control-max-age": "600",
		vary: "origin",
	};
}

function bearer(request: Request): string | undefined {
	const header = request.headers.get("authorization")?.trim();
	return header?.startsWith("Bearer ") ? header.slice(7).trim() || undefined : undefined;
}

/** A passing failure: Stripe or the database could not answer now, or Stripe refused our key (a
 * rolled or expired key, a restricted key missing a permission). Stripe should retry. */
function isPassing(error: unknown): boolean {
	if (error instanceof StripeRequestError) return error.status >= 500 || [401, 403, 409, 429].includes(error.status);
	if (error instanceof BillingStoreError)
		return error.code === undefined || !["22023", "22P02", "23514"].includes(error.code);
	return true;
}

/** The return URL with a query appended. The web app's return is a hash route
 * (https://app.qorpera.com/#/account), so the query lands after the hash, where the app reads it. */
function returnUrl(base: string, query: string): string {
	return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

async function startCheckout(
	request: Request,
	deps: BillingDependencies,
	cors: Record<string, string>,
): Promise<Response> {
	const token = bearer(request);
	const member = token ? await deps.auth.member(token) : null;
	if (!member) return json({ error: "Sign in to buy computer hours" }, 401, cors);
	let body: Json | undefined;
	try {
		body = object(await request.json());
	} catch {
		body = undefined;
	}
	const itemKey = string(body?.itemKey);
	const profileId = body?.profileId === undefined || body?.profileId === null ? undefined : string(body.profileId);
	if (!itemKey || !/^[a-z][a-z0-9_]{0,31}$/.test(itemKey) || (profileId !== undefined && !UUID.test(profileId)))
		return json({ error: "Choose a plan or a pack of hours" }, 400, cors);
	const { livemode } = deps.options;
	const begin = await deps.store.call("checkout_begin", { userId: member.id, itemKey, profileId, livemode });
	if (string(begin.refused)) return json({ refused: begin.refused }, 409, cors);
	const checkoutId = string(begin.checkoutId);
	const priceId = string(begin.priceId);
	const kind = string(begin.kind);
	if (!checkoutId || !priceId || (kind !== "plan" && kind !== "credits"))
		throw new BillingStoreError(undefined, "Checkout could not begin");
	let customerId = string(begin.customerId);
	if (!customerId) {
		const customer = await deps.stripe.post(
			"/v1/customers",
			{ email: member.email, "metadata[qorpera_user_id]": member.id },
			`qorpera-customer-${member.id}-${livemode ? "live" : "test"}`,
		);
		const saved = await deps.store.call("customer_set", {
			userId: member.id,
			customerId: string(customer.id),
			livemode,
		});
		customerId = string(saved.customerId);
		if (!customerId) throw new BillingStoreError(undefined, "Stripe customer was not saved");
	}
	// Stripe's price must still be what the catalog sells.
	const price = await deps.stripe.get(`/v1/prices/${encodeURIComponent(priceId)}`);
	const recurring = object(price.recurring);
	const priceMatches =
		price.active === true &&
		price.currency === "dkk" &&
		price.unit_amount === begin.priceMinor &&
		price.tax_behavior === "exclusive" &&
		(kind === "plan"
			? recurring?.interval === "month" && recurring?.interval_count === 1
			: price.type === "one_time");
	if (!priceMatches) return json({ error: "This offer is not available right now" }, 503, cors);
	const metadata: Record<string, string> = {
		qorpera_checkout_id: checkoutId,
		qorpera_user_id: member.id,
		qorpera_item_key: itemKey,
		...(profileId ? { qorpera_profile_id: profileId } : {}),
	};
	const form: Record<string, string> = {
		mode: kind === "plan" ? "subscription" : "payment",
		"line_items[0][price]": priceId,
		"line_items[0][quantity]": "1",
		customer: customerId,
		"customer_update[address]": "auto",
		"customer_update[name]": "auto",
		"automatic_tax[enabled]": "true",
		"tax_id_collection[enabled]": "true",
		"saved_payment_method_options[payment_method_save]": "enabled",
		"saved_payment_method_options[allow_redisplay_filters][0]": "always",
		"saved_payment_method_options[allow_redisplay_filters][1]": "limited",
		client_reference_id: checkoutId,
		success_url: returnUrl(deps.options.returnUrl, "checkout=done"),
		cancel_url: returnUrl(deps.options.returnUrl, "checkout=cancelled"),
	};
	const nested = kind === "plan" ? "subscription_data" : "payment_intent_data";
	for (const [key, value] of Object.entries(metadata)) {
		form[`metadata[${key}]`] = value;
		form[`${nested}[metadata][${key}]`] = value;
	}
	if (kind === "credits") {
		form["invoice_creation[enabled]"] = "true";
		// A pack is bought for one company: its page closes after an hour (Stripe's default is 24),
		// so a company deleted meanwhile is rarely paid for; one that is still gets review and a refund.
		const now = deps.options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
		form.expires_at = String(now + CREDIT_CHECKOUT_SECONDS);
	}
	const session = await deps.stripe.post("/v1/checkout/sessions", form, `qorpera-checkout-${checkoutId}`);
	const sessionId = string(session.id);
	const url = string(session.url);
	if (!sessionId || !url) throw new StripeRequestError(502, "Stripe returned no checkout page");
	await deps.store.call("checkout_attach", { checkoutId, sessionId });
	return json({ url }, 200, cors);
}

async function openPortal(
	request: Request,
	deps: BillingDependencies,
	cors: Record<string, string>,
): Promise<Response> {
	const token = bearer(request);
	const member = token ? await deps.auth.member(token) : null;
	if (!member) return json({ error: "Sign in to manage payments" }, 401, cors);
	const found = await deps.store.call("customer_get", { userId: member.id, livemode: deps.options.livemode });
	const customerId = string(found.customerId);
	if (!customerId) return json({ refused: "no_customer" }, 409, cors);
	const session = await deps.stripe.post("/v1/billing_portal/sessions", {
		customer: customerId,
		return_url: deps.options.returnUrl,
		...(deps.options.portalConfiguration ? { configuration: deps.options.portalConfiguration } : {}),
	});
	const url = string(session.url);
	if (!url) throw new StripeRequestError(502, "Stripe returned no billing page");
	return json({ url }, 200, cors);
}

interface Outcome {
	outcome: "applied" | "ignored" | "needs_review";
	detail?: string;
}

const applied = (detail?: string): Outcome => ({ outcome: "applied", ...(detail ? { detail } : {}) });
const ignored = (detail: string): Outcome => ({ outcome: "ignored", detail });
const review = (detail: string): Outcome => ({ outcome: "needs_review", detail });

function fromRefusal(result: Json, detail: string): Outcome {
	return string(result.refused) ? review(`${detail}: ${result.refused}`) : applied(detail);
}

interface SubscriptionFacts {
	subscriptionId: string;
	status: string;
	itemKey: string;
	periodStart: string;
	periodEnd: string;
	latestInvoice?: string;
}

/** Re-reads a subscription and records its newest state. */
async function syncSubscription(
	subscriptionId: string,
	eventCreated: string,
	deps: BillingDependencies,
): Promise<SubscriptionFacts | Outcome> {
	const { livemode } = deps.options;
	const subscription = await deps.stripe.get(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
	const customerId = string(subscription.customer) ?? string(object(subscription.customer)?.id);
	const userId = customerId ? string((await deps.store.call("customer_user", { customerId })).userId) : undefined;
	if (!userId) return review(`subscription ${subscriptionId} belongs to no known member`);
	const items = object(subscription.items)?.data;
	const item = Array.isArray(items) && items.length === 1 ? object(items[0]) : undefined;
	const priceId = string(object(item?.price)?.id);
	const periodStart = isoFromUnix(item?.current_period_start);
	const periodEnd = isoFromUnix(item?.current_period_end);
	if (!priceId || !periodStart || !periodEnd)
		return review(`subscription ${subscriptionId} has no single priced item`);
	const itemKey = string((await deps.store.call("catalog_item_by_price", { priceId, livemode })).itemKey);
	if (!itemKey) return review(`subscription ${subscriptionId} uses an unknown price`);
	const state = await deps.store.call("subscription_state", {
		subscriptionId,
		userId,
		itemKey,
		status: string(subscription.status) ?? "unknown",
		periodStart,
		periodEnd,
		cancelAtPeriodEnd: subscription.cancel_at_period_end === true || subscription.cancel_at != null,
		eventCreated,
		livemode,
	});
	if (string(state.refused)) return review(`subscription ${subscriptionId}: ${state.refused}`);
	return {
		subscriptionId,
		status: string(subscription.status) ?? "unknown",
		itemKey,
		periodStart,
		periodEnd,
		latestInvoice: string(subscription.latest_invoice) ?? string(object(subscription.latest_invoice)?.id),
	};
}

interface InvoiceLine {
	priceId?: string;
	amount: number;
	proration: boolean;
	periodStart?: string;
	periodEnd?: string;
}

function invoiceLines(invoice: Json): InvoiceLine[] {
	const data = object(invoice.lines)?.data;
	if (!Array.isArray(data)) return [];
	return data.flatMap((value) => {
		const line = object(value);
		if (!line) return [];
		const pricing = object(line.pricing);
		const period = object(line.period);
		return [
			{
				priceId: pricing?.type === "price_details" ? string(object(pricing.price_details)?.price) : undefined,
				amount: typeof line.amount === "number" ? line.amount : 0,
				proration: object(object(line.parent)?.subscription_item_details)?.proration === true,
				periodStart: isoFromUnix(period?.start),
				periodEnd: isoFromUnix(period?.end),
			},
		];
	});
}

function invoiceSubscription(invoice: Json): string | undefined {
	const parent = object(invoice.parent);
	return parent?.type === "subscription_details"
		? string(object(parent.subscription_details)?.subscription)
		: undefined;
}

async function itemKeyOf(priceId: string | undefined, deps: BillingDependencies): Promise<string | undefined> {
	if (!priceId) return undefined;
	return string(
		(await deps.store.call("catalog_item_by_price", { priceId, livemode: deps.options.livemode })).itemKey,
	);
}

async function applyInvoice(
	event: Json,
	invoiceId: string,
	created: string,
	deps: BillingDependencies,
): Promise<Outcome> {
	const { livemode } = deps.options;
	const invoice = await deps.stripe.get(`/v1/invoices/${encodeURIComponent(invoiceId)}`);
	const subscriptionId = invoiceSubscription(invoice);
	if (!subscriptionId) return ignored("not a subscription invoice");
	const reason = string(invoice.billing_reason);
	const type = string(event.type);
	if (type === "invoice.created" && reason !== "subscription_cycle") return ignored(`created ${reason}`);
	const facts = await syncSubscription(subscriptionId, created, deps);
	if ("outcome" in facts) return facts;
	const lines = invoiceLines(invoice);
	if (reason === "subscription_create" || reason === "subscription_cycle") {
		if (type === "invoice.paid" && invoice.status !== "paid") return ignored("invoice not paid");
		// A renewal whose invoice already failed (a resent event, say) gets no period.
		if (invoice.status === "uncollectible" || invoice.status === "void")
			return ignored(`${reason} invoice ${invoice.status}`);
		// The service period comes from the plan's line, not the invoice's own window.
		const line = lines.find((candidate) => candidate.priceId && !candidate.proration && candidate.amount >= 0);
		const itemKey = (await itemKeyOf(line?.priceId, deps)) ?? facts.itemKey;
		const result = await deps.store.call("plan_period", {
			subscriptionId,
			itemKey,
			periodStart: line?.periodStart ?? facts.periodStart,
			periodEnd: line?.periodEnd ?? facts.periodEnd,
			invoiceId,
			livemode,
		});
		// Stripe keeps invoicing an unpaid subscription and leaves a cancelled one's invoice open:
		// no new period. Paying such an invoice is for review, so the member is not left without hours.
		if (string(result.skipped))
			return type === "invoice.paid"
				? review(`${reason} invoice ${invoiceId} was paid, but the ${String(result.skipped)} gets no period`)
				: ignored(`${reason} period: ${result.skipped}`);
		// A renewal withdrawn after its payment failed stays withdrawn; paying it later is for review.
		if (result.withdrawn === true && type === "invoice.paid")
			return review(`${reason} period ${String(result.reference)} was paid after it was withdrawn`);
		return fromRefusal(result, `${reason} period`);
	}
	if (reason === "subscription_update" && type === "invoice.paid") {
		// A plan change billed at once: a credit line for the old plan, a charge line for the new one.
		// The new plan's line ends where the period ends; the database finds that period and refuses a
		// payment outside it, a change that lowers the hours, and a second change in the period.
		const from = lines.find((line) => line.proration && line.amount < 0);
		const to = lines.find((line) => line.proration && line.amount > 0);
		const fromItemKey = await itemKeyOf(from?.priceId, deps);
		const toItemKey = await itemKeyOf(to?.priceId, deps);
		if (!fromItemKey || !toItemKey || !to?.periodEnd) return review("plan change without a readable proration");
		const paidAt = isoFromUnix(object(invoice.status_transitions)?.paid_at) ?? created;
		const result = await deps.store.call("plan_upgrade", {
			subscriptionId,
			fromItemKey,
			toItemKey,
			periodEnd: to.periodEnd,
			paidAt,
			invoiceId,
			livemode,
		});
		return fromRefusal(result, `plan change ${fromItemKey} to ${toItemKey}`);
	}
	return ignored(`invoice ${reason}`);
}

/** A renewal whose payment finally failed: its period's unused hours are withdrawn. */
async function withdrawFailedRenewal(invoiceId: string | undefined, deps: BillingDependencies): Promise<Outcome> {
	if (!invoiceId) return ignored("no invoice");
	const invoice = await deps.stripe.get(`/v1/invoices/${encodeURIComponent(invoiceId)}`);
	const subscriptionId = invoiceSubscription(invoice);
	if (!subscriptionId || invoice.billing_reason !== "subscription_cycle") return ignored("not a renewal");
	if (invoice.status === "paid" || invoice.status === "void") return ignored(`renewal ${invoice.status}`);
	const line = invoiceLines(invoice).find((candidate) => candidate.priceId && !candidate.proration);
	if (!line?.periodStart) return review(`renewal ${invoiceId} has no period`);
	const result = await deps.store.call("plan_failed", {
		subscriptionId,
		periodStart: line.periodStart,
		livemode: deps.options.livemode,
	});
	return applied(`renewal withdrawn: ${String(result.withdrawn ?? 0)}`);
}

/** The subscription invoice a payment paid, if any (Charges and PaymentIntents no longer name it). */
async function invoiceOfPayment(paymentIntentId: string, deps: BillingDependencies): Promise<string | undefined> {
	const query = new URLSearchParams({
		"payment[type]": "payment_intent",
		"payment[payment_intent]": paymentIntentId,
		status: "paid",
		limit: "10",
	});
	const payments = (await deps.stripe.get(`/v1/invoice_payments?${query}`)).data;
	if (!Array.isArray(payments)) return undefined;
	for (const value of payments) {
		const invoice = object(value)?.invoice;
		const invoiceId = string(invoice) ?? string(object(invoice)?.id);
		if (invoiceId) return invoiceId;
	}
	return undefined;
}

/** The purchase a payment made: a credit pack by its PaymentIntent, plan hours by their invoice. */
async function purchaseOf(paymentIntentId: string, deps: BillingDependencies): Promise<Json> {
	return {
		paymentIntentId,
		invoiceId: (await invoiceOfPayment(paymentIntentId, deps)) ?? null,
		livemode: deps.options.livemode,
	};
}

/** A dispute's effect, from the status Stripe reports now (events can arrive late or out of order). */
function disputeEffect(status: unknown): "open" | "won" | "lost" {
	if (status === "won" || status === "warning_closed" || status === "prevented") return "won";
	if (status === "lost") return "lost";
	return "open";
}

async function applyEvent(event: Json, deps: BillingDependencies): Promise<Outcome> {
	const { livemode } = deps.options;
	const type = string(event.type) ?? "";
	const data = object(object(event.data)?.object);
	const id = string(data?.id);
	const created = isoFromUnix(event.created) ?? new Date().toISOString();
	if (!id) return review("event without an object");
	switch (type) {
		case "checkout.session.completed":
		case "checkout.session.async_payment_succeeded": {
			const session = await deps.stripe.get(`/v1/checkout/sessions/${encodeURIComponent(id)}`);
			if (session.mode !== "payment") return ignored("plan checkouts are paid through invoices");
			if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")
				return ignored(`payment ${String(session.payment_status)}`);
			const paymentIntentId = string(session.payment_intent) ?? string(object(session.payment_intent)?.id);
			if (!paymentIntentId) return review(`checkout ${id} has no payment`);
			const result = await deps.store.call("credits_paid", {
				sessionId: id,
				paymentIntentId,
				paidAt: created,
				livemode,
			});
			return fromRefusal(result, "credits");
		}
		case "invoice.created":
		case "invoice.paid":
			return applyInvoice(event, id, created, deps);
		case "invoice.marked_uncollectible":
			return withdrawFailedRenewal(id, deps);
		case "customer.subscription.created":
		case "customer.subscription.updated":
		case "customer.subscription.deleted": {
			const facts = await syncSubscription(id, created, deps);
			if ("outcome" in facts) return facts;
			if (type === "customer.subscription.deleted" || facts.status === "unpaid" || facts.status === "canceled")
				return withdrawFailedRenewal(facts.latestInvoice, deps);
			return applied(`subscription ${facts.status}`);
		}
		case "charge.refunded": {
			const charge = await deps.stripe.get(`/v1/charges/${encodeURIComponent(id)}`);
			const paymentIntentId = string(charge.payment_intent) ?? string(object(charge.payment_intent)?.id);
			if (!paymentIntentId || !(typeof charge.amount_refunded === "number" && charge.amount_refunded > 0))
				return ignored("nothing refunded");
			const result = await deps.store.call("refund", await purchaseOf(paymentIntentId, deps));
			if (result.matched === 0) return review(`refund of ${paymentIntentId} matched no purchase`);
			return applied(`refund withdrew ${String(result.changed ?? 0)}`);
		}
		case "charge.dispute.created":
		case "charge.dispute.updated":
		case "charge.dispute.closed": {
			const dispute = await deps.stripe.get(`/v1/disputes/${encodeURIComponent(id)}`);
			let paymentIntentId = string(dispute.payment_intent) ?? string(object(dispute.payment_intent)?.id);
			const chargeId = string(dispute.charge) ?? string(object(dispute.charge)?.id);
			if (!paymentIntentId && chargeId) {
				const charge = await deps.stripe.get(`/v1/charges/${encodeURIComponent(chargeId)}`);
				paymentIntentId = string(charge.payment_intent) ?? string(object(charge.payment_intent)?.id);
			}
			if (!paymentIntentId) return review(`dispute ${id} has no payment`);
			const status = disputeEffect(dispute.status);
			const result = await deps.store.call("dispute", { ...(await purchaseOf(paymentIntentId, deps)), status });
			if (result.matched === 0) return review(`dispute ${id} (${String(dispute.status)}) matched no purchase`);
			return applied(`dispute ${String(dispute.status)}: ${String(result.changed ?? 0)}`);
		}
		default:
			return ignored(`unhandled ${type}`);
	}
}

async function receiveWebhook(request: Request, deps: BillingDependencies): Promise<Response> {
	const rawBody = await request.text();
	const nowSeconds = deps.options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
	if (
		!(await verifyStripeSignature(
			rawBody,
			request.headers.get("stripe-signature"),
			deps.options.webhookSecret,
			nowSeconds,
		))
	)
		return json({ error: "Invalid signature" }, 400);
	let event: Json | undefined;
	try {
		event = object(JSON.parse(rawBody));
	} catch {
		event = undefined;
	}
	const eventId = string(event?.id);
	const type = string(event?.type);
	if (!event || !eventId || !/^evt_[A-Za-z0-9]{1,250}$/.test(eventId) || !type)
		return json({ error: "Not an event" }, 400);
	// A test event at a live endpoint, or the other way round, is acknowledged and left alone.
	if (event.livemode !== deps.options.livemode) return json({ received: true, ignored: "other mode" }, 200);
	const livemode = deps.options.livemode;
	const begun = await deps.store.call("event_begin", {
		eventId,
		type,
		livemode,
		bodySha256: await sha256Hex(rawBody),
	});
	if (begun.state === "finished") return json({ received: true, duplicate: true }, 200);
	let outcome: Outcome;
	try {
		outcome = await applyEvent(event, deps);
	} catch (error) {
		if (isPassing(error)) throw error;
		outcome = review(error instanceof Error ? error.message : String(error));
	}
	await deps.store.call("event_finish", { eventId, outcome: outcome.outcome, detail: outcome.detail ?? null });
	return json({ received: true, outcome: outcome.outcome }, 200);
}

/** The Edge Function: /checkout, /portal and /webhook. */
export async function handleComputerBilling(request: Request, deps: BillingDependencies): Promise<Response> {
	const route = new URL(request.url).pathname.replace(/\/+$/, "").split("/").pop();
	// The member's routes answer every outcome, errors too, with the headers the browser needs to read it.
	const cors = route === "webhook" ? {} : corsHeaders(request, deps.options);
	try {
		if (route === "webhook") {
			if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
			return await receiveWebhook(request, deps);
		}
		if (!cors) return json({ error: "Origin not allowed" }, 403);
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
		if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
		if (route === "checkout") return await startCheckout(request, deps, cors);
		if (route === "portal") return await openPortal(request, deps, cors);
		return json({ error: "Not found" }, 404, cors);
	} catch (error) {
		// Passing failures answer 5xx: a webhook is retried by Stripe, a member can try again.
		const message = error instanceof Error ? error.message : String(error);
		console.error(`computer-billing ${route}: ${message}`);
		return json(
			{ error: "Payments are unavailable right now" },
			error instanceof StripeRequestError && error.status < 500 && error.status !== 429 ? 502 : 503,
			cors ?? {},
		);
	}
}
