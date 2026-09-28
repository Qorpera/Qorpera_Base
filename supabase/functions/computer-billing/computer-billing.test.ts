import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
	type BillingDependencies,
	BillingStoreError,
	createStripeApi,
	handleComputerBilling,
	STRIPE_API_VERSION,
	StripeRequestError,
	verifyStripeSignature,
} from "./computer-billing.ts";

const SECRET = "whsec_test_secret";
const NOW = 1_790_000_000;
const MEMBER = { id: "30000000-0000-4000-8000-000000000001", email: "founder@example.test" };
const COMPANY = "30000000-0000-4000-8000-000000000010";

type Json = Record<string, unknown>;

function sign(body: string, timestamp = NOW, secret = SECRET): string {
	return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

interface Fixture {
	deps: BillingDependencies;
	calls: { method: string; args: Json }[];
	posts: { path: string; form: Record<string, string>; idempotencyKey?: string }[];
	gets: string[];
}

function fixture(
	stripe: Record<string, Json | Error> = {},
	store: Record<string, (args: Json) => Json | Error> = {},
): Fixture {
	const calls: Fixture["calls"] = [];
	const posts: Fixture["posts"] = [];
	const gets: string[] = [];
	const defaults: Record<string, (args: Json) => Json> = {
		event_begin: () => ({ state: "open" }),
		event_finish: () => ({ finished: true }),
		customer_user: () => ({ userId: MEMBER.id }),
		catalog_item_by_price: (args) => ({
			itemKey: { price_basis: "basis", price_standard: "standard" }[String(args.priceId)],
		}),
		subscription_state: () => ({ applied: true }),
		plan_period: () => ({ added: true }),
		plan_upgrade: () => ({ added: true, seconds: 1 }),
		plan_failed: () => ({ withdrawn: 1 }),
		credits_paid: () => ({ added: true }),
		refund: () => ({ withdrawn: 1 }),
		dispute: () => ({ changed: 1 }),
		checkout_begin: () => ({
			checkoutId: "c0ffee00-0000-4000-8000-000000000001",
			kind: "credits",
			priceId: "price_hours20",
			priceMinor: 7000,
		}),
		customer_set: (args) => ({ customerId: args.customerId }),
		customer_get: () => ({ customerId: "cus_A1" }),
		checkout_attach: () => ({ attached: true }),
	};
	const deps: BillingDependencies = {
		store: {
			async call(method, args) {
				calls.push({ method, args });
				const answer = (store[method] ?? defaults[method])?.(args);
				if (answer === undefined) throw new Error(`unexpected store call ${method}`);
				if (answer instanceof Error) throw answer;
				return answer;
			},
		},
		stripe: {
			async get(path) {
				gets.push(path);
				const answer = stripe[path];
				if (answer === undefined) throw new StripeRequestError(404, `no fixture for ${path}`);
				if (answer instanceof Error) throw answer;
				return answer;
			},
			async post(path, form, idempotencyKey) {
				posts.push({ path, form, idempotencyKey });
				const answer = stripe[`POST ${path}`];
				if (answer === undefined) throw new StripeRequestError(404, `no fixture for POST ${path}`);
				if (answer instanceof Error) throw answer;
				return answer;
			},
		},
		auth: { member: async (token) => (token === "member-token" ? MEMBER : null) },
		options: {
			livemode: false,
			webhookSecret: SECRET,
			returnUrl: "https://app.qorpera.com/?settings=plan",
			allowedOrigins: ["https://app.qorpera.com"],
			nowSeconds: () => NOW,
		},
	};
	return { deps, calls, posts, gets };
}

function event(type: string, object: Json, overrides: Json = {}): string {
	return JSON.stringify({ id: "evt_1", type, livemode: false, created: NOW - 10, data: { object }, ...overrides });
}

async function webhook(f: Fixture, body: string, signature = sign(body)): Promise<Response> {
	return handleComputerBilling(
		new Request("https://example.supabase.co/functions/v1/computer-billing/webhook", {
			method: "POST",
			headers: { "stripe-signature": signature },
			body,
		}),
		f.deps,
	);
}

const methods = (f: Fixture) => f.calls.map((call) => call.method);
const finished = (f: Fixture) => f.calls.find((call) => call.method === "event_finish")?.args;

const subscription = (status = "active", latestInvoice = "in_cycle") => ({
	id: "sub_1",
	customer: "cus_A1",
	status,
	cancel_at_period_end: false,
	cancel_at: null,
	latest_invoice: latestInvoice,
	items: {
		data: [{ price: { id: "price_basis" }, current_period_start: NOW - 100, current_period_end: NOW + 2_592_000 }],
	},
});
const planLine = (price: string, amount: number, proration = false, start = NOW - 100, end = NOW + 2_592_000) => ({
	amount,
	pricing: { type: "price_details", price_details: { price } },
	parent: { type: "subscription_item_details", subscription_item_details: { proration } },
	period: { start, end },
});

describe("Stripe signatures", () => {
	it("accepts a valid signature among several, and refuses stale, forged or malformed ones", async () => {
		const body = '{"id":"evt_1"}';
		assert.equal(await verifyStripeSignature(body, sign(body), SECRET, NOW), true);
		const forged = sign(body, NOW, "whsec_other").replace("t=", "t=");
		assert.equal(await verifyStripeSignature(body, forged, SECRET, NOW), false);
		const both = `${forged},v1=${sign(body).split("v1=")[1]}`;
		assert.equal(await verifyStripeSignature(body, both, SECRET, NOW), true);
		assert.equal(await verifyStripeSignature(body, sign(body, NOW - 301), SECRET, NOW), false);
		assert.equal(await verifyStripeSignature(`${body} `, sign(body), SECRET, NOW), false);
		assert.equal(await verifyStripeSignature(body, "t=abc,v1=zz", SECRET, NOW), false);
		assert.equal(await verifyStripeSignature(body, null, SECRET, NOW), false);
	});
});

describe("Stripe webhook", () => {
	it("refuses a bad signature and acknowledges another mode without touching billing", async () => {
		const f = fixture();
		const body = event("charge.refunded", { id: "ch_1" });
		assert.equal((await webhook(f, body, sign(body, NOW, "whsec_other"))).status, 400);
		const live = event("charge.refunded", { id: "ch_1" }, { livemode: true });
		const response = await webhook(f, live);
		assert.equal(response.status, 200);
		assert.deepEqual(f.calls, []);
	});

	it("does nothing twice for a replayed event, and refuses another body under a known id", async () => {
		const replay = fixture({}, { event_begin: () => ({ state: "finished", outcome: "applied" }) });
		assert.equal((await webhook(replay, event("charge.refunded", { id: "ch_1" }))).status, 200);
		assert.deepEqual(methods(replay), ["event_begin"]);
		const conflict = fixture(
			{},
			{ event_begin: () => new BillingStoreError("42501", "Billing: another body under a known event id") },
		);
		assert.equal((await webhook(conflict, event("charge.refunded", { id: "ch_1" }))).status, 409);
	});

	it("adds credits for a paid one-off checkout, re-read from Stripe", async () => {
		const f = fixture({
			"/v1/checkout/sessions/cs_1": { id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1" },
		});
		assert.equal(
			(await webhook(f, event("checkout.session.completed", { id: "cs_1", payment_status: "unpaid" }))).status,
			200,
		);
		const credits = f.calls.find((call) => call.method === "credits_paid")?.args;
		assert.deepEqual(credits, {
			sessionId: "cs_1",
			paymentIntentId: "pi_1",
			paidAt: new Date((NOW - 10) * 1000).toISOString(),
			livemode: false,
		});
		assert.equal(finished(f)?.outcome, "applied");
	});

	it("leaves plan checkouts and unpaid checkouts to later events", async () => {
		const f = fixture({ "/v1/checkout/sessions/cs_2": { id: "cs_2", mode: "subscription", payment_status: "paid" } });
		await webhook(f, event("checkout.session.completed", { id: "cs_2" }));
		assert.equal(finished(f)?.outcome, "ignored");
		assert.ok(!methods(f).includes("credits_paid"));
	});

	it("adds the first plan period once its invoice is paid, from the plan line's service period", async () => {
		const f = fixture({
			"/v1/invoices/in_1": {
				id: "in_1",
				status: "paid",
				billing_reason: "subscription_create",
				parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
				lines: { data: [planLine("price_basis", 18500, false, NOW - 100, NOW + 2_592_000)] },
			},
			"/v1/subscriptions/sub_1": subscription(),
		});
		await webhook(f, event("invoice.paid", { id: "in_1" }));
		const state = f.calls.find((call) => call.method === "subscription_state")?.args;
		assert.equal(state?.userId, MEMBER.id);
		assert.equal(state?.itemKey, "basis");
		const period = f.calls.find((call) => call.method === "plan_period")?.args;
		assert.deepEqual(period, {
			subscriptionId: "sub_1",
			itemKey: "basis",
			periodStart: new Date((NOW - 100) * 1000).toISOString(),
			periodEnd: new Date((NOW + 2_592_000) * 1000).toISOString(),
			livemode: false,
		});
		assert.equal(finished(f)?.outcome, "applied");
	});

	it("adds a renewal's period when its invoice is created at the period's start, before payment", async () => {
		const f = fixture({
			"/v1/invoices/in_2": {
				id: "in_2",
				status: "draft",
				billing_reason: "subscription_cycle",
				parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
				lines: { data: [planLine("price_basis", 18500)] },
			},
			"/v1/subscriptions/sub_1": subscription(),
		});
		await webhook(f, event("invoice.created", { id: "in_2" }));
		assert.ok(methods(f).includes("plan_period"));
	});

	it("adds an upgrade's extra hours from the paid proration invoice", async () => {
		const f = fixture({
			"/v1/invoices/in_3": {
				id: "in_3",
				status: "paid",
				billing_reason: "subscription_update",
				status_transitions: { paid_at: NOW - 5 },
				parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
				lines: { data: [planLine("price_basis", -6000, true), planLine("price_standard", 20000, true)] },
			},
			"/v1/subscriptions/sub_1": subscription(),
		});
		await webhook(f, event("invoice.paid", { id: "in_3" }));
		const upgrade = f.calls.find((call) => call.method === "plan_upgrade")?.args;
		assert.equal(upgrade?.fromItemKey, "basis");
		assert.equal(upgrade?.toItemKey, "standard");
		assert.equal(upgrade?.paidAt, new Date((NOW - 5) * 1000).toISOString());
		assert.equal(upgrade?.invoiceId, "in_3");
	});

	it("withdraws a renewal whose payment finally failed", async () => {
		const f = fixture({
			"/v1/subscriptions/sub_1": subscription("canceled", "in_4"),
			"/v1/invoices/in_4": {
				id: "in_4",
				status: "open",
				billing_reason: "subscription_cycle",
				parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
				lines: { data: [planLine("price_basis", 18500)] },
			},
		});
		await webhook(f, event("customer.subscription.deleted", { id: "sub_1" }));
		assert.deepEqual(f.calls.find((call) => call.method === "plan_failed")?.args, {
			subscriptionId: "sub_1",
			periodStart: new Date((NOW - 100) * 1000).toISOString(),
			livemode: false,
		});
	});

	it("takes back refunded credits and freezes, then releases, disputed ones", async () => {
		const refund = fixture({ "/v1/charges/ch_1": { id: "ch_1", payment_intent: "pi_1", amount_refunded: 7000 } });
		await webhook(refund, event("charge.refunded", { id: "ch_1" }));
		assert.deepEqual(refund.calls.find((call) => call.method === "refund")?.args, {
			paymentIntentId: "pi_1",
			livemode: false,
		});
		const opened = fixture({ "/v1/disputes/dp_1": { id: "dp_1", payment_intent: "pi_1", status: "needs_response" } });
		await webhook(opened, event("charge.dispute.created", { id: "dp_1" }));
		assert.equal(opened.calls.find((call) => call.method === "dispute")?.args.status, "open");
		const won = fixture({ "/v1/disputes/dp_1": { id: "dp_1", payment_intent: "pi_1", status: "won" } });
		await webhook(won, event("charge.dispute.closed", { id: "dp_1" }));
		assert.equal(won.calls.find((call) => call.method === "dispute")?.args.status, "won");
	});

	it("records what it cannot use for review and still answers 2xx; a passing failure answers 5xx", async () => {
		const unknown = fixture();
		assert.equal((await webhook(unknown, event("customer.created", { id: "cus_9" }))).status, 200);
		assert.equal(finished(unknown)?.outcome, "ignored");
		const missing = fixture();
		assert.equal((await webhook(missing, event("charge.refunded", { id: "ch_gone" }))).status, 200);
		assert.equal(finished(missing)?.outcome, "needs_review");
		const stranger = fixture(
			{ "/v1/subscriptions/sub_1": subscription() },
			{ customer_user: () => ({ userId: null }) },
		);
		await webhook(stranger, event("customer.subscription.updated", { id: "sub_1" }));
		assert.equal(finished(stranger)?.outcome, "needs_review");
		const down = fixture({ "/v1/charges/ch_1": new StripeRequestError(503, "Stripe 503") });
		assert.equal((await webhook(down, event("charge.refunded", { id: "ch_1" }))).status, 503);
		assert.equal(finished(down), undefined);
		const database = fixture(
			{ "/v1/charges/ch_1": { id: "ch_1", payment_intent: "pi_1", amount_refunded: 1 } },
			{
				refund: () => new BillingStoreError("57P01", "terminating connection"),
			},
		);
		assert.equal((await webhook(database, event("charge.refunded", { id: "ch_1" }))).status, 503);
	});
});

describe("Checkout and the billing page", () => {
	const post = (route: string, body: Json = {}, headers: Record<string, string> = {}) =>
		new Request(`https://example.supabase.co/functions/v1/computer-billing/${route}`, {
			method: "POST",
			headers: { origin: "https://app.qorpera.com", authorization: "Bearer member-token", ...headers },
			body: JSON.stringify(body),
		});

	it("starts credit checkout for a founder: a new Stripe customer, the price checked, VAT, the return page", async () => {
		const f = fixture(
			{
				"POST /v1/customers": { id: "cus_new" },
				"/v1/prices/price_hours20": {
					id: "price_hours20",
					active: true,
					currency: "dkk",
					unit_amount: 7000,
					tax_behavior: "exclusive",
					type: "one_time",
				},
				"POST /v1/checkout/sessions": { id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" },
			},
			{
				checkout_begin: () => ({
					checkoutId: "c0ffee00-0000-4000-8000-000000000001",
					kind: "credits",
					priceId: "price_hours20",
					priceMinor: 7000,
					customerId: null,
				}),
			},
		);
		const response = await handleComputerBilling(
			post("checkout", { itemKey: "hours_20", profileId: COMPANY }),
			f.deps,
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { url: "https://checkout.stripe.com/c/pay/cs_new" });
		assert.equal(response.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
		assert.deepEqual(f.calls[0], {
			method: "checkout_begin",
			args: { userId: MEMBER.id, itemKey: "hours_20", profileId: COMPANY, livemode: false },
		});
		assert.equal(f.posts[0]?.path, "/v1/customers");
		assert.equal(f.posts[0]?.form.email, MEMBER.email);
		const session = f.posts[1];
		assert.equal(session?.path, "/v1/checkout/sessions");
		assert.equal(session?.idempotencyKey, "qorpera-checkout-c0ffee00-0000-4000-8000-000000000001");
		assert.equal(session?.form.mode, "payment");
		assert.equal(session?.form.customer, "cus_new");
		assert.equal(session?.form["automatic_tax[enabled]"], "true");
		assert.equal(session?.form["customer_update[address]"], "auto");
		assert.equal(session?.form["payment_intent_data[metadata][qorpera_profile_id]"], COMPANY);
		assert.equal(
			session?.form.success_url,
			"https://app.qorpera.com/?settings=plan&checkout=done&session_id={CHECKOUT_SESSION_ID}",
		);
		assert.ok(!("ui_mode" in (session?.form ?? {})));
		assert.deepEqual(f.calls.at(-1), {
			method: "checkout_attach",
			args: { checkoutId: "c0ffee00-0000-4000-8000-000000000001", sessionId: "cs_new" },
		});
	});

	it("starts a plan checkout as a subscription and refuses a price Stripe no longer sells as listed", async () => {
		const plan = () => ({
			checkoutId: "c0ffee00-0000-4000-8000-000000000002",
			kind: "plan",
			priceId: "price_basis",
			priceMinor: 18500,
			customerId: "cus_A1",
		});
		const f = fixture(
			{
				"/v1/prices/price_basis": {
					id: "price_basis",
					active: true,
					currency: "dkk",
					unit_amount: 18500,
					tax_behavior: "exclusive",
					recurring: { interval: "month", interval_count: 1 },
				},
				"POST /v1/checkout/sessions": { id: "cs_plan", url: "https://checkout.stripe.com/c/pay/cs_plan" },
			},
			{ checkout_begin: plan },
		);
		assert.equal((await handleComputerBilling(post("checkout", { itemKey: "basis" }), f.deps)).status, 200);
		assert.equal(f.posts[0]?.form.mode, "subscription");
		assert.equal(f.posts[0]?.form["subscription_data[metadata][qorpera_item_key]"], "basis");
		const changed = fixture(
			{
				"/v1/prices/price_basis": {
					id: "price_basis",
					active: true,
					currency: "dkk",
					unit_amount: 19900,
					tax_behavior: "exclusive",
					recurring: { interval: "month", interval_count: 1 },
				},
			},
			{ checkout_begin: plan },
		);
		assert.equal((await handleComputerBilling(post("checkout", { itemKey: "basis" }), changed.deps)).status, 503);
		assert.equal(changed.posts.length, 0);
	});

	it("passes on refusals, and requires a member and an allowed origin", async () => {
		const refused = fixture({}, { checkout_begin: () => ({ refused: "not_a_founder" }) });
		const response = await handleComputerBilling(
			post("checkout", { itemKey: "hours_20", profileId: COMPANY }),
			refused.deps,
		);
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), { refused: "not_a_founder" });
		assert.equal(
			(
				await handleComputerBilling(
					post("checkout", { itemKey: "basis" }, { authorization: "Bearer nobody" }),
					fixture().deps,
				)
			).status,
			401,
		);
		assert.equal(
			(
				await handleComputerBilling(
					post("checkout", { itemKey: "basis" }, { origin: "https://evil.example" }),
					fixture().deps,
				)
			).status,
			403,
		);
		assert.equal((await handleComputerBilling(post("checkout", { itemKey: "Basis!" }), fixture().deps)).status, 400);
		const preflight = await handleComputerBilling(
			new Request("https://example.supabase.co/functions/v1/computer-billing/checkout", {
				method: "OPTIONS",
				headers: { origin: "https://app.qorpera.com" },
			}),
			fixture().deps,
		);
		assert.equal(preflight.status, 204);
	});

	it("opens Stripe's billing page for a member with a customer", async () => {
		const f = fixture({ "POST /v1/billing_portal/sessions": { url: "https://billing.stripe.com/p/session/x" } });
		f.deps.options.portalConfiguration = "bpc_1";
		const response = await handleComputerBilling(post("portal"), f.deps);
		assert.deepEqual(await response.json(), { url: "https://billing.stripe.com/p/session/x" });
		assert.deepEqual(f.posts[0]?.form, {
			customer: "cus_A1",
			return_url: "https://app.qorpera.com/?settings=plan",
			configuration: "bpc_1",
		});
		const none = fixture({}, { customer_get: () => ({ customerId: null }) });
		assert.equal((await handleComputerBilling(post("portal"), none.deps)).status, 409);
	});
});

describe("Stripe API client", () => {
	it("pins the API version, form-encodes and sends idempotency keys", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const api = createStripeApi("sk_test_x", async (url, init) => {
			requests.push({ url: String(url), init });
			return new Response(JSON.stringify({ id: "cus_1" }), { status: 200 });
		});
		await api.post("/v1/customers", { email: "a@b.test", "metadata[k]": "v" }, "key-1");
		const headers = requests[0]?.init?.headers as Record<string, string>;
		assert.equal(headers["stripe-version"], STRIPE_API_VERSION);
		assert.equal(headers["idempotency-key"], "key-1");
		assert.equal(requests[0]?.init?.body, "email=a%40b.test&metadata%5Bk%5D=v");
		const failing = createStripeApi(
			"sk_test_x",
			async () => new Response('{"error":{"message":"No such price"}}', { status: 404 }),
		);
		await assert.rejects(
			failing.get("/v1/prices/x"),
			(error: unknown) => error instanceof StripeRequestError && error.status === 404,
		);
	});
});
