import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { createComputerBillingRpc, handleComputerBilling, STRIPE_API_VERSION, type ComputerBillingOptions } from "./computer-billing.ts";

const now = Date.parse("2026-09-25T10:00:00Z");
const userId = "63000000-0000-4000-8000-000000000001";
const subscription = {
	id: "sub_example", customer: "cus_example", livemode: false, status: "canceled",
	items: { has_more: false, data: [{ quantity: 1, current_period_start: 1790000000, current_period_end: 1792600000,
		price: { id: "price_basis", currency: "dkk", unit_amount: 18500, recurring: { interval: "month", interval_count: 1 } } }] },
};
const invoice = { id: "in_example", customer: "cus_example", livemode: false, status: "paid", amount_remaining: 0, amount_paid: 18500,
	pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
	currency: "dkk", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_example" } },
	lines: { has_more: false, data: [{ quantity: 1, currency: "dkk", parent: { subscription_item_details: { subscription: "sub_example", proration: false } },
		pricing: { price_details: { price: "price_basis" }, unit_amount_decimal: "18500" }, period: { start: 1790000000, end: 1792600000 } }] } };
const charge = { id: "ch_example", customer: "cus_example", livemode: false, payment_intent: "pi_example", paid: true, disputed: false, amount_refunded: 0 };
const invoicePayment = { id: "inpay_example", invoice: "in_example", livemode: false, status: "paid", amount_paid: 18500,
	payment: { type: "payment_intent", payment_intent: "pi_example" } };
function fixture() {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const requests: { url: string; init?: RequestInit }[] = [];
	const options: ComputerBillingOptions = {
		stripeSecretKey: "sk_test_fake", webhookSecret: "whsec_fake", returnUrl: "https://qorpera.test/settings/computers",
		portalConfigurationId: "bpc_test",
		liveMode: false, pricePlans: { price_basis: { planKey: "basis", version: 1 } }, now: () => now,
		authenticate: async (token) => token === "valid" ? userId : null,
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json(String(input).includes("billing_portal/configurations")
				? { id: "bpc_test", active: true, livemode: false, features: { subscription_update: { enabled: false } } }
				: String(input).includes("billing_portal") ? { url: "https://billing.stripe.com/p/session_test" }
				: String(input).includes("/invoice_payments?") ? { has_more: false, data: [invoicePayment] }
				: String(input).includes("/payment_intents/") ? { id: "pi_example", customer: "cus_example", livemode: false, latest_charge: "ch_example" }
				: String(input).includes("/charges/") ? charge
				: String(input).includes("/invoices/") ? invoice : subscription);
		},
		rpc: async (name, args) => {
			calls.push({ name, args });
			if (name === "qorpera_begin_computer_billing_sync") return { state: "claimed", leaseToken: "lease" };
			if (name === "qorpera_computer_billing_customer") return { userId, customerId: "cus_example" };
			if (name === "qorpera_computer_plan_catalog") return { plans: [{ planKey: "basis", version: 1, monthlyPriceMinor: 18500, activeForCheckout: false }] };
			return null;
		},
	};
	return { calls, requests, options };
}
function webhook(overrides: Record<string, unknown> = {}, timestamp = now / 1000, bodySuffix = "") {
	const body = JSON.stringify({ id: "evt_example", type: "customer.subscription.updated", api_version: STRIPE_API_VERSION,
		livemode: false, created: now / 1000 - 200, data: { object: { id: "sub_example", status: "active" } }, ...overrides });
	const digest = createHmac("sha256", "whsec_fake").update(`${timestamp}.${body}`).digest("hex");
	return new Request("https://edge.test/computer-billing/webhook", { method: "POST", body: body + bodySuffix,
		headers: { "stripe-signature": `t=${timestamp},v1=${digest}` } });
}
function memberRequest(action: string, body: unknown = {}, token = "valid") {
	return new Request(`https://edge.test/computer-billing/${action}`, { method: "POST", body: JSON.stringify(body),
		headers: { authorization: `Bearer ${token}`, origin: "https://qorpera.test" } });
}

describe("computer billing service", () => {
	it("verifies exact raw bytes and timestamp before any authority or provider call", async () => {
		const { options, calls, requests } = fixture();
		assert.equal((await handleComputerBilling(webhook({}, now / 1000, " "), options)).status, 400);
		assert.equal((await handleComputerBilling(webhook({}, now / 1000 - 301), options)).status, 400);
		assert.equal(calls.length, 0);
		assert.equal(requests.length, 0);
	});
	it("fetches canonical state under the lease instead of applying stale event data", async () => {
		const { options, calls, requests } = fixture();
		const response = await handleComputerBilling(webhook(), options);
		assert.equal(response.status, 200);
		assert.equal(calls[0].name, "qorpera_begin_computer_billing_sync");
		assert.equal(requests[0].url, "https://api.stripe.com/v1/subscriptions/sub_example");
		assert.equal(new Headers(requests[0].init?.headers).get("stripe-version"), STRIPE_API_VERSION);
		const finish = calls.find((call) => call.name === "qorpera_finish_computer_billing_sync");
		assert.equal((finish?.args.p_payload as Record<string, unknown>).status, "canceled");
		assert.equal((finish?.args.p_payload as Record<string, unknown>).userId, userId);
	});
	it("completed event retry makes no new Stripe retrieval", async () => {
		const { options, requests } = fixture();
		options.rpc = async () => ({ state: "completed" });
		assert.equal((await handleComputerBilling(webhook(), options)).status, 200);
		assert.equal(requests.length, 0);
	});
	it("busy reconciliation retries and provider failure releases its lease", async () => {
		const { options, calls } = fixture();
		options.fetch = async () => new Response("provider failure", { status: 500 });
		assert.equal((await handleComputerBilling(webhook(), options)).status, 503);
		assert.equal(calls.at(-1)?.name, "qorpera_release_computer_billing_sync");
		assert.equal(calls.some((call) => call.name === "qorpera_finish_computer_billing_sync"), false);
		options.rpc = async () => ({ state: "busy" });
		assert.equal((await handleComputerBilling(webhook(), options)).status, 503);
	});
	it("invoice event retrieves its subscription and validates configured price against catalog", async () => {
		const { options, calls } = fixture();
		assert.equal((await handleComputerBilling(webhook({ type: "invoice.paid", data: { object: { id: "in_example", parent: { subscription_details: { subscription: "sub_example" } } } } }), options)).status, 200);
		assert.equal((calls.find((call) => call.name === "qorpera_finish_computer_billing_sync")?.args.p_paid_invoice as Record<string, unknown>).invoiceId, "in_example");
		options.fetch = async () => Response.json({ ...subscription, items: { has_more: false, data: [{ ...subscription.items.data[0], price: { ...subscription.items.data[0].price, unit_amount: 1 } }] } });
		calls.length = 0;
		assert.equal((await handleComputerBilling(webhook(), options)).status, 503);
		assert.equal(calls.some((call) => call.name === "qorpera_finish_computer_billing_sync"), false);
	});
	it("paid event cannot manufacture funds from an unpaid or prorated canonical invoice", async () => {
		for (const badInvoice of [{ ...invoice, status: "open" }, { ...invoice, billing_reason: "subscription_update" },
			{ ...invoice, lines: { ...invoice.lines, data: [{ ...invoice.lines.data[0], parent: { subscription_item_details: { subscription: "sub_example", proration: true } } }] } }]) {
			const { options, calls } = fixture();
			options.fetch = async (input) => Response.json(String(input).includes("/invoices/") ? badInvoice : subscription);
			assert.equal((await handleComputerBilling(webhook({ type: "invoice.paid", data: { object: invoice } }), options)).status, 503);
			assert.equal(calls.some((call) => call.name === "qorpera_finish_computer_billing_sync"), false);
		}
	});
	it("failed atomic invoice funding retries canonical invoice and the same event", async () => {
		const { options, calls, requests } = fixture();
		const rpc = options.rpc;
		let fail = true;
		options.rpc = async (name, args) => {
			const result = await rpc(name, args);
			if (name === "qorpera_finish_computer_billing_sync" && fail) { fail = false; throw new Error("funding unavailable"); }
			return result;
		};
		assert.equal((await handleComputerBilling(webhook({ type: "invoice.paid", data: { object: invoice } }), options)).status, 503);
		assert.equal((await handleComputerBilling(webhook({ type: "invoice.paid", data: { object: invoice } }), options)).status, 200);
		assert.equal(requests.filter((entry) => entry.url.endsWith("/invoices/in_example")).length, 2);
		assert.deepEqual(calls.filter((call) => call.name === "qorpera_finish_computer_billing_sync").map((call) => call.args.p_event_id), ["evt_example", "evt_example"]);
	});
	it("never starts Checkout for unpublished offers, even with valid Stripe configuration", async () => {
		const { options, requests } = fixture();
		assert.equal((await handleComputerBilling(memberRequest("checkout", { planKey: "basis", version: 1, requestId: "request" }), options)).status, 409);
		assert.equal(requests.length, 0);
		assert.equal((await handleComputerBilling(memberRequest("checkout", {}, "bad"), options)).status, 401);
	});
	it("published Checkout creates the authenticated customer and session with stable command keys, then replays", async () => {
		const { options, requests } = fixture();
		const results = new Map<string, Record<string, unknown>>();
		options.rpc = async (name, args) => {
			if (name === "qorpera_computer_plan_catalog") return { plans: [{ planKey: "basis", version: 1, tariffVersion: 1, monthlyPriceMinor: 18500, activeForCheckout: true }] };
			if (name === "qorpera_begin_computer_billing_command") {
				assert.equal(args.p_user_id, userId);
				const id = String(args.p_kind);
				return results.has(id) ? { state: "completed", result: results.get(id) } : { state: "claimed", commandId: id, leaseToken: "lease", idempotencyKey: `stable-${id}` };
			}
			if (name === "qorpera_finish_computer_billing_command") results.set(String(args.p_command_id), args.p_result as Record<string, unknown>);
			return null;
		};
		options.fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			if (String(input).endsWith("/prices/price_basis")) return Response.json({ ...subscription.items.data[0].price, active: true, livemode: false });
			if (String(input).endsWith("/customers")) return Response.json({ id: "cus_created" });
			if (String(input).includes("/subscriptions?")) return Response.json({ data: [], has_more: false });
			return Response.json({ id: "cs_test_example", url: "https://checkout.stripe.com/c/pay/test", expires_at: now / 1000 + 3600 });
		};
		const body = { planKey: "basis", version: 1, requestId: "63000000-0000-4000-8000-000000000050" };
		assert.equal((await handleComputerBilling(memberRequest("checkout", body), options)).status, 200);
		const customerRequest = requests.find((entry) => entry.url.endsWith("/customers"));
		assert.equal(new Headers(customerRequest?.init?.headers).get("idempotency-key"), "stable-customer");
		assert.equal((customerRequest?.init?.body as URLSearchParams).get("metadata[qorpera_user_id]"), userId);
		const checkoutRequest = requests.find((entry) => entry.url.endsWith("/checkout/sessions"));
		assert.equal(new Headers(checkoutRequest?.init?.headers).get("idempotency-key"), "stable-checkout");
		assert.equal((checkoutRequest?.init?.body as URLSearchParams).get("customer"), "cus_created");
		assert.equal((checkoutRequest?.init?.body as URLSearchParams).get("success_url"), options.returnUrl);
		assert.equal((await handleComputerBilling(memberRequest("checkout", body), options)).status, 200);
		assert.equal(requests.filter((entry) => entry.init?.method === "POST").length, 2);
	});
	it("ambiguous create retries use the same provider key and do not grant paid access", async () => {
		const { options, requests } = fixture();
		options.rpc = async (name, args) => {
			if (name === "qorpera_computer_plan_catalog") return { plans: [{ planKey: "basis", version: 1, tariffVersion: 1, monthlyPriceMinor: 18500, activeForCheckout: true }] };
			if (name === "qorpera_begin_computer_billing_command") return args.p_kind === "customer"
				? { state: "completed", result: { customerId: "cus_example" } }
				: { state: "claimed", commandId: "checkout", leaseToken: "new-lease", idempotencyKey: "same-checkout-key" };
			if (name === "qorpera_finish_computer_billing_command") throw new Error("Commit response lost");
			return null;
		};
		options.fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			if (String(input).includes("/subscriptions?")) return Response.json({ data: [], has_more: false });
			return Response.json(String(input).includes("/prices/") ? { ...subscription.items.data[0].price, active: true, livemode: false }
				: { id: "cs_test_example", url: "https://checkout.stripe.com/c/pay/test", expires_at: now / 1000 + 3600 });
		};
		const body = { planKey: "basis", version: 1, requestId: "63000000-0000-4000-8000-000000000050" };
		assert.equal((await handleComputerBilling(memberRequest("checkout", body), options)).status, 503);
		assert.equal((await handleComputerBilling(memberRequest("checkout", body), options)).status, 503);
		assert.deepEqual(requests.filter((entry) => entry.init?.method === "POST").map((entry) => new Headers(entry.init?.headers).get("idempotency-key")), ["same-checkout-key", "same-checkout-key"]);
	});
	it("portal uses the authenticated customer's mapping and configured return URL only", async () => {
		const { options, calls, requests } = fixture();
		assert.equal((await handleComputerBilling(memberRequest("portal", { customerId: "cus_other" }), options)).status, 400);
		assert.equal((await handleComputerBilling(memberRequest("portal", {}), options)).status, 200);
		assert.deepEqual(calls[0].args, { p_user_id: userId });
		const body = requests[1].init?.body as URLSearchParams;
		assert.equal(body.get("customer"), "cus_example");
		assert.equal(body.get("return_url"), options.returnUrl);
	});
	it("late subscription webhooks cannot allow another purchase after Checkout expiry", async () => {
		const { options, requests } = fixture();
		options.rpc = async (name, args) => {
			if (name === "qorpera_computer_plan_catalog") return { plans: [{ planKey: "basis", version: 1, tariffVersion: 1, monthlyPriceMinor: 18500, activeForCheckout: true }] };
			if (name === "qorpera_begin_computer_billing_command") return args.p_kind === "customer"
				? { state: "completed", result: { customerId: "cus_example" } }
				: { state: "claimed", commandId: "new-command", leaseToken: "lease", idempotencyKey: "new-key" };
			return null;
		};
		options.fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json(String(input).includes("/prices/") ? { ...subscription.items.data[0].price, active: true, livemode: false }
				: { data: [{ id: "sub_paid_but_webhook_late", status: "active" }], has_more: false });
		};
		assert.equal((await handleComputerBilling(memberRequest("checkout", { planKey: "basis", version: 1, requestId: "63000000-0000-4000-8000-000000000051" }), options)).status, 409);
		assert.equal(requests.some((entry) => entry.init?.method === "POST"), false);
	});
	it("portal cannot bypass unpublished plans through subscription updates", async () => {
		const { options, requests } = fixture();
		options.fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json({ id: "bpc_test", active: true, livemode: false, features: { subscription_update: { enabled: true } } });
		};
		assert.equal((await handleComputerBilling(memberRequest("portal"), options)).status, 503);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].url.endsWith("/configurations/bpc_test"), true);
	});
	it("rejects unconfigured billing, cross-origin member calls, oversized bodies and wrong live mode", async () => {
		const { options, requests } = fixture();
		assert.equal((await handleComputerBilling(webhook({ livemode: true }), options)).status, 400);
		const crossOrigin = memberRequest("portal");
		crossOrigin.headers.set("origin", "https://attacker.test");
		assert.equal((await handleComputerBilling(crossOrigin, options)).status, 403);
		assert.equal((await handleComputerBilling(new Request("https://edge.test/computer-billing/webhook", { method: "POST", body: "x".repeat(1048577) }), options)).status, 413);
		assert.equal((await handleComputerBilling(webhook(), { ...options, stripeSecretKey: "" })).status, 503);
		assert.equal(requests.length, 0);
	});
});

describe("computer payment reversals", () => {
	it("reconciles canonical partial refunds, disputes and credit notes rather than webhook snapshots", async () => {
		for (const [type, id, canonical, path, reason] of [
			["charge.refunded", "ch_example", { ...charge, amount_refunded: 1 }, "/charges/", "charge_adverse"],
			["refund.created", "re_example", { id: "re_example", status: "pending", charge: "ch_example" }, "/refunds/", "refund"],
			["charge.dispute.created", "du_example", { id: "du_example", livemode: false, charge: "ch_example", status: "needs_response" }, "/disputes/", "dispute"],
			["credit_note.created", "cn_example", { id: "cn_example", livemode: false, customer: "cus_example", invoice: "in_example", amount: 1, status: "issued" }, "/credit_notes/", "credit_note"],
		] as const) {
			const { options, calls } = fixture(), fetcher = options.fetch;
			options.fetch = async (input, init) => String(input).includes(path) ? Response.json(canonical) : fetcher(input, init);
			const event = { type, data: { object: { id, customer: "cus_forged", amount_refunded: 0 } } };
			assert.equal((await handleComputerBilling(webhook(event), options)).status, 200, type);
			const fence = calls.find((call) => call.name === "qorpera_fence_computer_payment");
			assert.deepEqual(fence?.args.p_proof, { invoiceId: "in_example", subscriptionId: "sub_example", customerId: "cus_example", sourceId: id, reason });
			assert.equal(calls.some((call) => call.name === "qorpera_finish_computer_billing_sync"), false);
		}
	});
	it("lost fence response stays retryable and replays the same immutable proof", async () => {
		const { options, calls } = fixture(), fetcher = options.fetch, rpc = options.rpc;
		options.fetch = async (input, init) => String(input).includes("/charges/") ? Response.json({ ...charge, disputed: true }) : fetcher(input, init);
		let first = true;
		options.rpc = async (name, args) => { const result = await rpc(name, args); if (name === "qorpera_fence_computer_payment" && first) { first = false; throw new Error("lost reply"); } return result; };
		const event = { type: "charge.refunded", data: { object: { id: "ch_example" } } };
		assert.equal((await handleComputerBilling(webhook(event), options)).status, 503);
		assert.equal((await handleComputerBilling(webhook(event), options)).status, 200);
		const records = calls.filter((call) => call.name === "qorpera_fence_computer_payment");
		assert.equal(records.length, 2); assert.deepEqual(records[0].args, records[1].args);
	});
	it("invoice.paid checks payment reversals and credit notes before finishing funding", async () => {
		for (const changed of [{ ...charge, amount_refunded: 18500 }, { ...charge, disputed: true }, null]) {
			const { options, calls } = fixture(), fetcher = options.fetch;
			options.fetch = async (input, init) => changed && String(input).includes("/charges/") ? Response.json(changed)
				: !changed && String(input).includes("/invoices/") ? Response.json({ ...invoice, post_payment_credit_notes_amount: 100 }) : fetcher(input, init);
			assert.equal((await handleComputerBilling(webhook({ type: "invoice.paid", data: { object: invoice } }), options)).status, 200);
			const fence = calls.findIndex((call) => call.name === "qorpera_fence_computer_payment");
			assert(fence >= 0 && fence < calls.findIndex((call) => call.name === "qorpera_finish_computer_billing_sync"));
		}
	});
	it("unknown, incomplete or cross-customer payment history never authorizes funding", async () => {
		for (const bad of [{ has_more: true, data: [invoicePayment] }, { has_more: false, data: [] },
			{ has_more: false, data: [{ ...invoicePayment, invoice: "in_other" }] },
			{ has_more: false, data: [{ ...invoicePayment, payment: { type: "payment_record", payment_record: "pr_example" } }] }]) {
			const { options, calls } = fixture(), fetcher = options.fetch;
			options.fetch = async (input, init) => String(input).includes("/invoice_payments?") ? Response.json(bad) : fetcher(input, init);
			assert.equal((await handleComputerBilling(webhook({ type: "invoice.paid", data: { object: invoice } }), options)).status, 503);
			assert.equal(calls.some((call) => call.name === "qorpera_finish_computer_billing_sync"), false);
		}
		const { options, calls } = fixture(), fetcher = options.fetch;
		options.fetch = async (input, init) => String(input).includes("/charges/") ? Response.json({ ...charge, customer: "cus_other", amount_refunded: 1 }) : fetcher(input, init);
		assert.equal((await handleComputerBilling(webhook({ type: "charge.refunded", data: { object: charge } }), options)).status, 503);
		assert.equal(calls.some((call) => call.name === "qorpera_fence_computer_payment"), false);
	});
	it("failed refunds and void credit notes do not mint or restore funds", async () => {
		for (const [type, id, canonical, path] of [
			["refund.failed", "re_example", { id: "re_example", status: "failed", charge: "ch_example" }, "/refunds/"],
			["credit_note.voided", "cn_example", { id: "cn_example", livemode: false, status: "void", amount: 100 }, "/credit_notes/"],
		] as const) {
			const { options, calls } = fixture(), fetcher = options.fetch;
			options.fetch = async (input, init) => String(input).includes(path) ? Response.json(canonical) : fetcher(input, init);
			assert.equal((await handleComputerBilling(webhook({ type, data: { object: { id } } }), options)).status, 200);
			assert.equal(calls.length, 0);
		}
	});
});

describe("computer billing database authority", () => {
	it("fails closed before HTTP without a dedicated bridge credential", () => {
		for (const secret of ["", "x".repeat(31), "x".repeat(513)])
			assert.throws(() => createComputerBillingRpc("https://db.test", "guest-shared-service-key", secret, fetch), /not configured/);
		for (const url of ["invalid", "http://db.test", "https://u:p@db.test", "https://db.test/path", "https://db.test?key=secret", "https://db.test#secret"])
			assert.throws(() => createComputerBillingRpc(url, "service-key", "x".repeat(64), fetch), /not configured/);
	});
	it("uses a fixed dispatcher, prevents redirects, and does not expose database errors", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const secret = "bridge-only-".repeat(5);
		const rpc = createComputerBillingRpc("https://db.test", "service-key", secret, async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json({ state: "claimed" });
		});
		assert.deepEqual(await rpc("qorpera_begin_computer_billing_sync", { p_event_id: "evt_test" }), { state: "claimed" });
		assert.equal(requests[0].url, "https://db.test/rest/v1/rpc/qorpera_computer_billing_rpc");
		assert.equal(requests[0].init?.redirect, "error");
		assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
			p_method: "qorpera_begin_computer_billing_sync", p_args: { p_event_id: "evt_test" }, p_billing_secret: secret,
		});
		assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer service-key");
		await rpc("../../forged", {});
		assert.equal(requests[1].url, requests[0].url);
		const failed = createComputerBillingRpc("https://db.test", "service-key", secret,
			async () => new Response(`database echoed ${secret}`, { status: 403 }));
		await assert.rejects(failed("qorpera_computer_plan_catalog", {}), { message: "Billing database unavailable" });
		for (const fetcher of [
			async () => { throw new Error(`transport echoed ${secret}`); },
			async () => new Response(secret),
			async () => new Response("x".repeat(65537)),
		]) {
			await assert.rejects(createComputerBillingRpc("https://db.test", "service-key", secret, fetcher)("qorpera_computer_plan_catalog", {}),
				{ message: "Billing database unavailable" });
		}
	});
});
