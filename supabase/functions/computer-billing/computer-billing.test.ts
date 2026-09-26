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
const invoice = { id: "in_example", customer: "cus_example", livemode: false, status: "paid", amount_remaining: 0, amount_paid: 18500, total: 18500,
	pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
	currency: "dkk", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_example" } },
	lines: { has_more: false, data: [{ quantity: 1, currency: "dkk", parent: { subscription_item_details: { subscription: "sub_example", proration: false } },
		pricing: { price_details: { price: "price_basis" }, unit_amount_decimal: "18500" }, period: { start: 1790000000, end: 1792600000 } }] } };
const charge = { id: "ch_example", customer: "cus_example", livemode: false, payment_intent: "pi_example", paid: true, currency: "dkk", amount: 18500, disputed: false, amount_refunded: 0 };
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
				: ["/credit_notes?", "/refunds?", "/disputes?"].some(path => String(input).includes(path)) ? { has_more: false, data: [] }
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
			const fetcher = options.fetch;
			options.fetch = async (input, init) => String(input).includes("/invoices/") ? Response.json(badInvoice) : fetcher(input, init);
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
		assert.equal((customerRequest?.init?.body as URLSearchParams).get("metadata[qorpera_command_id]"), "stable-customer");
		const checkoutRequest = requests.find((entry) => entry.url.endsWith("/checkout/sessions"));
		assert.equal(new Headers(checkoutRequest?.init?.headers).get("idempotency-key"), "stable-checkout");
		assert.equal((checkoutRequest?.init?.body as URLSearchParams).get("customer"), "cus_created");
		assert.equal((checkoutRequest?.init?.body as URLSearchParams).get("metadata[qorpera_command_id]"), "stable-checkout");
		assert.equal((checkoutRequest?.init?.body as URLSearchParams).get("success_url"), options.returnUrl);
		assert.equal((await handleComputerBilling(memberRequest("checkout", body), options)).status, 200);
		assert.equal(requests.filter((entry) => entry.init?.method === "POST").length, 2);
	});
	it("recovered terminal Checkout returns a verified conflict without creating another provider session", async () => {
		const requestId = "63000000-0000-4000-8000-000000000052", expiresAt = new Date(now - 1000).toISOString();
		for (const [terminal, status] of [
			[{ state: "recovered_terminal", requestId, sessionId: "cs_test_closed", expiresAt }, 409],
			[{ state: "recovered_terminal", requestId: "different", sessionId: "cs_test_closed", expiresAt }, 503],
			[{ state: "recovered_terminal", requestId, sessionId: "https://wrong.test", expiresAt }, 503],
			[{ state: "recovered_terminal", requestId, sessionId: "cs_test_closed", expiresAt: new Date(now + 1000).toISOString() }, 503],
		] as const) {
			const { options, requests } = fixture();
			options.rpc = async (name) => name === "qorpera_computer_plan_catalog"
				? { plans: [{ planKey: "basis", version: 1, tariffVersion: 1, monthlyPriceMinor: 18500, activeForCheckout: true }] } : terminal;
			options.fetch = async (input, init) => { requests.push({ url: String(input), init }); return Response.json({ ...subscription.items.data[0].price, active: true, livemode: false }); };
			const response = await handleComputerBilling(memberRequest("checkout", { planKey: "basis", version: 1, requestId }), options);
			assert.equal(response.status, status); const body = await response.json();
			if (status === 409) assert.deepEqual(body, { code: "checkout_reconciled_terminal", requestId, sessionId: "cs_test_closed", expiresAt,
				error: "The previous checkout was reconciled and is closed. Start a new checkout to continue." });
			else assert.equal(body.code, undefined);
			assert.equal(requests.some((entry) => entry.init?.method === "POST"), false);
		}
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

function reversalFixture({ refunds = [], notes = [], disputes = [] }: { refunds?: Record<string, unknown>[]; notes?: Record<string, unknown>[]; disputes?: Record<string, unknown>[] } = {}) {
 const f = fixture(), fetcher = f.options.fetch;
 const amount = refunds.filter(r => r.status === "succeeded").reduce((n, r) => n + Number(r.amount), 0);
 const credits = notes.filter(n => n.status === "issued").reduce((n, r) => n + Number(r.amount), 0);
 f.options.fetch = async (input, init) => {
  const url = String(input);
  for (const [kind, data] of [["refunds", refunds], ["credit_notes", notes], ["disputes", disputes]] as const) {
   if (url.includes(`/${kind}?`)) return Response.json({ has_more: false, data });
   if (url.includes(`/${kind}/`)) return Response.json(data.find(value => url.endsWith(String(value.id))));
  }
  if (url.includes("/charges/")) return Response.json({ ...charge, amount_refunded: amount, disputed: disputes.length > 0 });
  if (url.includes("/invoices/")) return Response.json({ ...invoice, post_payment_credit_notes_amount: credits });
  return fetcher(input, init);
 };
 return f;
}
const refund = { id: "re_example", charge: "ch_example", currency: "dkk", amount: 9250, status: "succeeded" };
const dispute = { id: "du_example", charge: "ch_example", currency: "dkk", amount: 18500, livemode: false, status: "needs_response" };
const credit = { id: "cn_example", invoice: "in_example", customer: "cus_example", currency: "dkk", livemode: false,
 amount: 9250, pre_payment_amount: 0, post_payment_amount: 9250, status: "issued", refunds: [] };
function fundingSnapshot(calls: ReturnType<typeof fixture>["calls"]) {
 return calls.findLast(c => c.name === "qorpera_apply_computer_invoice_funding")?.args.p_snapshot as Record<string, unknown>;
}
describe("computer payment reversals", () => {
 it("reduces partial refunds proportionally under the lease despite forged event amounts", async () => {
  const { options, calls } = reversalFixture({ refunds: [refund] });
  assert.equal((await handleComputerBilling(webhook({ type: "refund.created", data: { object: { ...refund, amount: 1 } } }), options)).status, 200);
  assert.equal(fundingSnapshot(calls).basisMinor, 18500); assert.equal(fundingSnapshot(calls).reversedMinor, 9250);
  assert.equal(fundingSnapshot(calls).held, false);
  assert(calls.findIndex(c => c.name === "qorpera_begin_computer_billing_sync") < calls.findIndex(c => c.name === "qorpera_fence_computer_payment"));
  assert.equal(calls.findLast(c => c.name === "qorpera_apply_computer_invoice_funding")?.args.p_complete, true);
 });
 it("counts a credit note's linked refund once, including a failed refund still owed by an issued note", async () => {
  for (const status of ["succeeded", "failed"]) {
   const { options, calls } = reversalFixture({ refunds: [{ ...refund, status }], notes: [{ ...credit, refunds: [{ refund: "re_example", amount_refunded: 9250, type: "refund" }] }] });
   assert.equal((await handleComputerBilling(webhook({ type: "credit_note.created", data: { object: credit } }), options)).status, 200);
   assert.equal(fundingSnapshot(calls).reversedMinor, 9250);
  }
 });
 it("restores failed refunds and won disputes from current history, despite charge.disputed remaining true", async () => {
  for (const state of ["failed", "canceled", "won", "warning_closed", "prevented"]) {
   const isRefund = ["failed", "canceled"].includes(state);
   const { options, calls } = reversalFixture(isRefund ? { refunds: [{ ...refund, status: state }] } : { disputes: [{ ...dispute, status: state }] });
   assert.equal((await handleComputerBilling(webhook({ type: isRefund ? "refund.failed" : "charge.dispute.closed", data: { object: { id: isRefund ? refund.id : dispute.id } } }), options)).status, 200);
   assert.equal(fundingSnapshot(calls).reversedMinor, 0); assert.equal(fundingSnapshot(calls).held, false);
  }
 });
 it("an old dispute-created event retrieves the current won outcome under a fresh lease", async () => {
  const { options, calls } = reversalFixture({ disputes: [{ ...dispute, status: "won" }] });
  assert.equal((await handleComputerBilling(webhook({ type: "charge.dispute.created", data: { object: dispute } }), options)).status, 200);
  assert.equal(fundingSnapshot(calls).held, false); assert.equal(fundingSnapshot(calls).reversedMinor, 0);
  const evidence = JSON.parse(String(fundingSnapshot(calls).evidence)); assert.equal(evidence.disputes[0].status, "won");
 });
 it("holds unresolved disputes and ambiguous lost-dispute/refund overlap without erasing original issuance", async () => {
  for (const value of [dispute, { ...dispute, status: "lost" }]) {
   const { options, calls } = reversalFixture({ disputes: [value], refunds: [refund] });
   assert.equal((await handleComputerBilling(webhook({ type: "charge.dispute.updated", data: { object: value } }), options)).status, 200);
   assert.equal(fundingSnapshot(calls).held, true);
  }
 });
 it("a delayed invoice.paid commits the current reduced cap before funding", async () => {
  const { options, calls } = reversalFixture({ refunds: [refund] });
  assert.equal((await handleComputerBilling(webhook({ type: "invoice.paid", data: { object: invoice } }), options)).status, 200);
  const apply = calls.findIndex(c => c.name === "qorpera_apply_computer_invoice_funding");
  assert(apply >= 0 && apply < calls.findIndex(c => c.name === "qorpera_finish_computer_billing_sync"));
  assert.equal(calls[apply].args.p_complete, false); assert.equal(fundingSnapshot(calls).reversedMinor, 9250);
 });
 it("a lost fence reply remains retryable, and a completed adverse replay cannot re-fence restored funds", async () => {
  const { options, calls } = reversalFixture({ refunds: [refund] }), rpc = options.rpc;
  let first = true;
  options.rpc = async (name, args) => { const result = await rpc(name, args); if (name === "qorpera_fence_computer_payment" && first) { first = false; throw new Error("lost reply"); } return result; };
  const event = { type: "refund.created", data: { object: refund } };
  assert.equal((await handleComputerBilling(webhook(event), options)).status, 503);
  assert.equal((await handleComputerBilling(webhook(event), options)).status, 200);
  const records = calls.filter(c => c.name === "qorpera_fence_computer_payment");
  assert.deepEqual(records[0].args, records[1].args);
  calls.length = 0; options.rpc = async (name, args) => name === "qorpera_begin_computer_billing_sync" ? { state: "completed" } : rpc(name, args);
  assert.equal((await handleComputerBilling(webhook(event), options)).status, 200); assert.equal(calls.length, 0);
 });
 it("unknown or paginated histories leave the conservative fence in place and never commit a restoration", async () => {
  const { options, calls } = reversalFixture({ refunds: [refund] }), fetcher = options.fetch;
  options.fetch = async (input, init) => String(input).includes("/refunds?") ? Response.json({ has_more: true, data: [refund] }) : fetcher(input, init);
  assert.equal((await handleComputerBilling(webhook({ type: "refund.created", data: { object: refund } }), options)).status, 503);
  assert(calls.some(c => c.name === "qorpera_fence_computer_payment")); assert.equal(fundingSnapshot(calls), undefined);
 });
 it("rejects a cross-customer charge before mutating its invoice", async () => {
  const { options, calls } = fixture(), fetcher = options.fetch;
  options.fetch = async (input, init) => String(input).includes("/charges/") ? Response.json({ ...charge, customer: "cus_other" }) : fetcher(input, init);
  assert.equal((await handleComputerBilling(webhook({ type: "charge.refunded", data: { object: charge } }), options)).status, 503);
  assert.equal(calls.length, 0);
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
