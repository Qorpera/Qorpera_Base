export const STRIPE_API_VERSION = "2026-08-26.dahlia";
const encoder = new TextEncoder();

export interface ComputerBillingOptions {
	stripeSecretKey: string;
	webhookSecret: string;
	returnUrl: string;
	portalConfigurationId: string;
	liveMode: boolean;
	pricePlans: Record<string, { planKey: string; version: number }>;
	fetch: typeof fetch;
	now(): number;
	authenticate(token: string): Promise<string | null>;
	rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** This credential belongs only to the payment bridge, never a runtime guest. */
export function createComputerBillingRpc(supabaseUrl: string, serviceKey: string, billingSecret: string, fetcher: typeof fetch): ComputerBillingOptions["rpc"] {
	if (!supabaseUrl || !serviceKey || billingSecret.length < 32 || billingSecret.length > 512)
		throw new Error("Computer billing database authority is not configured");
	let origin: URL;
	try { origin = new URL(supabaseUrl); } catch { throw new Error("Computer billing database authority is not configured"); }
	if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
		throw new Error("Computer billing database authority is not configured");
	const endpoint = new URL("/rest/v1/rpc/qorpera_computer_billing_rpc", origin);
	return async (name, args) => {
		try {
			const response = await fetcher(endpoint, {
				method: "POST", headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
				body: JSON.stringify({ p_method: name, p_args: args, p_billing_secret: billingSecret }),
				signal: AbortSignal.timeout(10000), redirect: "error",
			});
			if (!response.ok) throw new Error("Billing database unavailable");
			return response.status === 204 ? null : JSON.parse(new TextDecoder().decode(await boundedBody(response, 65536)));
		} catch { throw new Error("Billing database unavailable"); }
	};
}

class BillingError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new BillingError(400, "Invalid billing payload");
	return value as Record<string, unknown>;
}

function identifier(value: unknown, prefix: string): string {
	if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,240}$`).test(value))
		throw new BillingError(400, "Invalid billing identity");
	return value;
}

async function boundedBody(request: Request | Response, limit: number): Promise<Uint8Array> {
	if (!request.body) throw new BillingError(400, "Request body required");
	const reader = request.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new BillingError(413, "Billing request too large");
			}
			parts.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return bytes;
}

export async function verifyStripeSignature(bytes: Uint8Array, header: string, secret: string, now: number): Promise<void> {
	if (!secret || header.length > 4096) throw new BillingError(400, "Invalid webhook signature");
	const parts = header.split(",");
	const timestamps = parts.filter((part) => part.startsWith("t=")).map((part) => part.slice(2));
	const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
	if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamps[0]) || Math.abs(now / 1000 - Number(timestamps[0])) > 300)
		throw new BillingError(400, "Invalid webhook timestamp");
	if (signatures.length < 1 || signatures.length > 20) throw new BillingError(400, "Invalid webhook signature");
	const prefix = encoder.encode(`${timestamps[0]}.`);
	const signed = new Uint8Array(prefix.length + bytes.length);
	signed.set(prefix);
	signed.set(bytes, prefix.length);
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	for (const signature of signatures) {
		if (!/^[a-f0-9]{64}$/.test(signature)) continue;
		const digest = Uint8Array.from(signature.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
		if (await crypto.subtle.verify("HMAC", key, digest, signed)) return;
	}
	throw new BillingError(400, "Invalid webhook signature");
}

async function stripe(options: ComputerBillingOptions, path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<Record<string, unknown>> {
	const response = await options.fetch(`https://api.stripe.com/v1/${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			authorization: `Bearer ${options.stripeSecretKey}`,
			"Stripe-Version": STRIPE_API_VERSION,
			...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
			...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
		},
		body,
		signal: AbortSignal.timeout(15000),
		redirect: "error",
	});
	if (!response.ok) throw new BillingError(503, "Payment provider unavailable");
	return object(await response.json());
}

async function billingCommand(options: ComputerBillingOptions, userId: string, kind: "customer" | "checkout", requestId: string,
	payload: Record<string, unknown>, execute: (idempotencyKey: string) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
	const command = object(await options.rpc("qorpera_begin_computer_billing_command", {
		p_user_id: userId, p_kind: kind, p_request_id: requestId, p_payload: payload,
	}));
	if (command.state === "completed") return object(command.result);
	if (command.state !== "claimed" || typeof command.commandId !== "string" || typeof command.leaseToken !== "string" || typeof command.idempotencyKey !== "string")
		throw new BillingError(503, command.state === "reconciliation_required" ? "Billing request needs reconciliation" : "Billing request is already being processed");
	try {
		const result = await execute(command.idempotencyKey);
		await options.rpc("qorpera_finish_computer_billing_command", { p_command_id: command.commandId, p_lease_token: command.leaseToken, p_result: result });
		return result;
	} catch (error) {
		try {
			await options.rpc("qorpera_release_computer_billing_command", { p_command_id: command.commandId, p_lease_token: command.leaseToken });
		} catch { /* The finite lease permits a later retry with the same provider key. */ }
		throw error;
	}
}

async function stripeList(options: ComputerBillingOptions, path: string): Promise<Record<string, unknown>[]> {
	const result = await stripe(options, path);
	if (result.has_more !== false || !Array.isArray(result.data) || result.data.length > 100)
		throw new BillingError(503, "Payment history needs reconciliation");
	return result.data.map(object);
}

async function canonicalCharge(options: ComputerBillingOptions, chargeId: string): Promise<Record<string, unknown>> {
	const charge = await stripe(options, `charges/${chargeId}`);
	if (charge.id !== chargeId || charge.livemode !== options.liveMode || typeof charge.disputed !== "boolean" ||
		typeof charge.amount_refunded !== "number" || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0)
		throw new BillingError(503, "Charge retrieval differs");
	return charge;
}

async function fenceInvoice(options: ComputerBillingOptions, eventId: string, bodySha256: string,
	invoice: Record<string, unknown>, sourceId: string, reason: "charge_adverse" | "refund" | "dispute" | "credit_note"): Promise<void> {
	if (invoice.livemode !== options.liveMode) throw new BillingError(503, "Invoice environment differs");
	if (invoice.parent === null) return; // A standalone invoice is not a computer subscription.
	const subscriptionId = identifier(object(object(invoice.parent).subscription_details).subscription, "sub");
	const customerId = identifier(invoice.customer, "cus");
	const mapping = await options.rpc("qorpera_computer_billing_customer", { p_customer_id: customerId });
	if (!mapping) throw new BillingError(503, "Invoice customer is not mapped");
	if (object(mapping).customerId !== customerId) throw new BillingError(503, "Invoice customer differs");
	await options.rpc("qorpera_fence_computer_payment", { p_event_id: eventId, p_body_sha256: bodySha256,
		p_proof: { invoiceId: identifier(invoice.id, "in"), subscriptionId, customerId, sourceId, reason } });
}

/** A monotonic fence is separate from subscription state: cancellation preserves
 * a paid period, whereas reversal cannot be undone by a delayed invoice.paid.
 * Restoring disputed/refunded allowance requires an explicit audited policy.
 */
async function reconcileAdversePayment(options: ComputerBillingOptions, type: string, data: Record<string, unknown>, eventId: string, bodySha256: string): Promise<void> {
	if (type.startsWith("credit_note.")) {
		const id = identifier(data.id, "cn"), note = await stripe(options, `credit_notes/${id}`);
		if (note.id !== id || note.livemode !== options.liveMode || !["issued", "void"].includes(String(note.status)) ||
			typeof note.amount !== "number" || !Number.isSafeInteger(note.amount) || note.amount < 0)
			throw new BillingError(503, "Credit note retrieval differs");
		if (note.status === "void" || note.amount === 0) return;
		const invoiceId = identifier(note.invoice, "in"), invoice = await stripe(options, `invoices/${invoiceId}`);
		if (invoice.id !== invoiceId || invoice.customer !== note.customer) throw new BillingError(503, "Credit note invoice differs");
		await fenceInvoice(options, eventId, bodySha256, invoice, id, "credit_note");
		return;
	}
	let chargeId: string, sourceId: string, reason: "charge_adverse" | "refund" | "dispute";
	if (type.startsWith("charge.dispute.")) {
		sourceId = identifier(data.id, "du");
		const dispute = await stripe(options, `disputes/${sourceId}`);
		if (dispute.id !== sourceId || dispute.livemode !== options.liveMode) throw new BillingError(503, "Dispute retrieval differs");
		chargeId = identifier(dispute.charge, "ch"); reason = "dispute";
	} else if (type.startsWith("refund.") || type === "charge.refund.updated") {
		sourceId = identifier(data.id, "re");
		const refund = await stripe(options, `refunds/${sourceId}`);
		if (refund.id !== sourceId || !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(String(refund.status)))
			throw new BillingError(503, "Refund retrieval differs");
		if (["failed", "canceled"].includes(String(refund.status))) return;
		chargeId = identifier(refund.charge, "ch"); reason = "refund";
	} else { chargeId = identifier(data.id, "ch"); sourceId = chargeId; reason = "charge_adverse"; }
	const charge = await canonicalCharge(options, chargeId);
	if (reason === "charge_adverse" && charge.disputed === false && charge.amount_refunded === 0) return;
	if (charge.payment_intent === null) throw new BillingError(503, "Charge payment relation needs reconciliation");
	const paymentIntent = identifier(charge.payment_intent, "pi");
	const payments = await stripeList(options, `invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${paymentIntent}&limit=100`);
	for (const payment of payments) {
		if (payment.livemode !== options.liveMode || object(payment.payment).type !== "payment_intent" || object(payment.payment).payment_intent !== paymentIntent)
			throw new BillingError(503, "Invoice payment relation differs");
		const invoiceId = identifier(payment.invoice, "in"), invoice = await stripe(options, `invoices/${invoiceId}`);
		if (invoice.id !== invoiceId || invoice.customer !== charge.customer) throw new BillingError(503, "Charge invoice differs");
		await fenceInvoice(options, eventId, bodySha256, invoice, sourceId, reason);
	}
}

async function inspectInvoiceFunding(options: ComputerBillingOptions, invoice: Record<string, unknown>, eventId: string, bodySha256: string): Promise<void> {
	const invoiceId = identifier(invoice.id, "in");
	for (const field of ["pre_payment_credit_notes_amount", "post_payment_credit_notes_amount"]) {
		const amount = invoice[field];
		if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)
			throw new BillingError(503, "Invoice credit history needs reconciliation");
		if (amount > 0) await fenceInvoice(options, eventId, bodySha256, invoice, invoiceId, "credit_note");
	}
	const payments = await stripeList(options, `invoice_payments?invoice=${invoiceId}&status=paid&limit=100`);
	let total = 0;
	for (const entry of payments) {
		if (entry.invoice !== invoiceId || entry.livemode !== options.liveMode || entry.status !== "paid" ||
			typeof entry.amount_paid !== "number" || !Number.isSafeInteger(entry.amount_paid) || entry.amount_paid < 0)
			throw new BillingError(503, "Invoice payment differs");
		const payment = object(entry.payment);
		if (payment.type !== "payment_intent") throw new BillingError(503, "Invoice payment method needs reconciliation");
		const id = identifier(payment.payment_intent, "pi"), intent = await stripe(options, `payment_intents/${id}`);
		if (intent.id !== id || intent.livemode !== options.liveMode || intent.customer !== invoice.customer)
			throw new BillingError(503, "Invoice payment intent differs");
		const charge = await canonicalCharge(options, identifier(intent.latest_charge, "ch"));
		if (charge.payment_intent !== id || charge.customer !== invoice.customer || charge.paid !== true)
			throw new BillingError(503, "Invoice charge differs");
		if (charge.disputed || Number(charge.amount_refunded) > 0)
			await fenceInvoice(options, eventId, bodySha256, invoice, String(charge.id), "charge_adverse");
		total += entry.amount_paid;
	}
	if (!Number.isSafeInteger(total) || total !== invoice.amount_paid) throw new BillingError(503, "Invoice payments need reconciliation");
}

async function reconcileWebhook(bytes: Uint8Array, options: ComputerBillingOptions): Promise<void> {
	const event = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	if (event.livemode !== options.liveMode || event.api_version !== STRIPE_API_VERSION)
		throw new BillingError(400, "Webhook environment or API version differs");
	const type = event.type;
	if (typeof type !== "string") throw new BillingError(400, "Invalid webhook type");
	const adverse = type === "charge.refunded" || type === "charge.refund.updated" || type.startsWith("charge.dispute.") ||
		["refund.created", "refund.updated", "refund.failed", "credit_note.created", "credit_note.updated", "credit_note.voided"].includes(type);
	if (!adverse && !type.startsWith("customer.subscription.") && !["invoice.paid", "invoice.payment_failed", "invoice.payment_action_required"].includes(type)) return;
	const data = object(object(event.data).object);
	const eventId = identifier(event.id, "evt");
	if (typeof event.created !== "number" || !Number.isSafeInteger(event.created) || event.created <= 0)
		throw new BillingError(400, "Invalid webhook timestamp");
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	const bodySha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	if (adverse) { await reconcileAdversePayment(options, type, data, eventId, bodySha256); return; }
	if (type.startsWith("invoice.") && data.parent === null) return;
	const subscriptionId = identifier(
		type.startsWith("customer.subscription.") ? data.id : object(object(data.parent).subscription_details).subscription,
		"sub",
	);
	const claim = object(await options.rpc("qorpera_begin_computer_billing_sync", {
		p_event_id: eventId,
		p_subscription_id: subscriptionId,
		p_event_created_at: new Date(event.created * 1000).toISOString(),
		p_body_sha256: bodySha256,
	}));
	if (claim.state === "completed") return;
	if (claim.state !== "claimed" || typeof claim.leaseToken !== "string") throw new BillingError(503, "Subscription reconciliation busy");
	try {
		// Fetch only after the cross-request database lease. Never apply the old
		// event's subscription object or the checkout redirect as payment truth.
		const subscription = await stripe(options, `subscriptions/${subscriptionId}`);
		if (subscription.id !== subscriptionId || subscription.livemode !== options.liveMode)
			throw new BillingError(503, "Subscription retrieval differs");
		const customerId = identifier(subscription.customer, "cus");
		const mapping = await options.rpc("qorpera_computer_billing_customer", { p_customer_id: customerId });
		if (!mapping) throw new BillingError(503, "Subscription customer is not mapped");
		const customer = object(mapping);
		if (typeof customer.userId !== "string" || customer.customerId !== customerId)
			throw new BillingError(503, "Subscription customer is not mapped");
		const items = object(subscription.items);
		if (!Array.isArray(items.data) || items.data.length !== 1 || items.has_more !== false)
			throw new BillingError(503, "Subscription items are unsupported");
		const item = object(items.data[0]);
		const price = object(item.price);
		const plan = options.pricePlans[identifier(price.id, "price")];
		if (!plan || item.quantity !== 1) throw new BillingError(503, "Subscription price is not configured");
		const catalog = object(await options.rpc("qorpera_computer_plan_catalog", {}));
		const offer = Array.isArray(catalog.plans)
			? catalog.plans.map(object).find((entry) => entry.planKey === plan.planKey && entry.version === plan.version)
			: undefined;
		if (!offer || price.currency !== "dkk" || price.unit_amount !== offer.monthlyPriceMinor ||
			object(price.recurring).interval !== "month" || object(price.recurring).interval_count !== 1)
			throw new BillingError(503, "Subscription price differs from catalog");
		const start = item.current_period_start;
		const end = item.current_period_end;
		if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start)
			throw new BillingError(503, "Subscription period is invalid");
		let paidInvoice: Record<string, unknown> | null = null;
		if (type === "invoice.paid") {
			const invoiceId = identifier(data.id, "in");
			const invoice = await stripe(options, `invoices/${invoiceId}`);
			if (invoice.id !== invoiceId || invoice.livemode !== options.liveMode || invoice.customer !== customerId || invoice.status !== "paid" ||
				invoice.amount_remaining !== 0 || typeof invoice.amount_paid !== "number" || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < 0 ||
				invoice.currency !== "dkk" || !["subscription_create", "subscription_cycle"].includes(String(invoice.billing_reason)) ||
				object(object(invoice.parent).subscription_details).subscription !== subscriptionId)
				throw new BillingError(503, "Paid invoice retrieval differs");
			await inspectInvoiceFunding(options, invoice, eventId, bodySha256);
			const lines = object(invoice.lines);
			if (lines.has_more !== false || !Array.isArray(lines.data) || lines.data.length !== 1)
				throw new BillingError(503, "Invoice lines need reconciliation");
			const line = object(lines.data[0]);
			const parent = object(object(line.parent).subscription_item_details);
			const pricing = object(line.pricing);
			const invoicePlan = options.pricePlans[identifier(object(pricing.price_details).price, "price")];
			const invoiceOffer = invoicePlan && Array.isArray(catalog.plans)
				? catalog.plans.map(object).find((entry) => entry.planKey === invoicePlan.planKey && entry.version === invoicePlan.version) : undefined;
			const period = object(line.period);
			if (!invoicePlan || !invoiceOffer || parent.subscription !== subscriptionId || parent.proration !== false || line.quantity !== 1 || line.currency !== "dkk" ||
				Number(pricing.unit_amount_decimal) !== invoiceOffer.monthlyPriceMinor ||
				typeof period.start !== "number" || typeof period.end !== "number" || !Number.isSafeInteger(period.start) || !Number.isSafeInteger(period.end) || period.start <= 0 || period.end <= period.start)
				throw new BillingError(503, "Invoice allowance period or offer differs");
			paidInvoice = { invoiceId, subscriptionId, customerId, planKey: invoicePlan.planKey, planVersion: invoicePlan.version,
				periodStart: new Date(period.start * 1000).toISOString(), periodEnd: new Date(period.end * 1000).toISOString(),
				amountPaid: invoice.amount_paid, billingReason: invoice.billing_reason, status: "paid", currency: "dkk" };
		}
		await options.rpc("qorpera_finish_computer_billing_sync", {
			p_event_id: eventId,
			p_lease_token: claim.leaseToken,
			p_payload: { subscriptionId, customerId, userId: customer.userId, planKey: plan.planKey, planVersion: plan.version,
				status: subscription.status, periodStart: new Date(start * 1000).toISOString(), periodEnd: new Date(end * 1000).toISOString() },
			p_paid_invoice: paidInvoice,
		});
	} catch (error) {
		try {
			await options.rpc("qorpera_release_computer_billing_sync", { p_event_id: eventId, p_lease_token: claim.leaseToken });
		} catch { /* Lease expiry permits recovery when the database itself is unavailable. */ }
		throw error;
	}
}

export async function handleComputerBilling(request: Request, options: ComputerBillingOptions): Promise<Response> {
	const headers: Record<string, string> = { "cache-control": "no-store" };
	try {
		const returnUrl = new URL(options.returnUrl);
		if (returnUrl.protocol !== "https:" || returnUrl.username || returnUrl.password || !options.stripeSecretKey || !options.webhookSecret)
			throw new BillingError(503, "Computer billing is not configured");
		const origin = request.headers.get("origin");
		if (origin === returnUrl.origin) {
			headers["access-control-allow-origin"] = origin;
			headers.vary = "Origin";
			headers["access-control-allow-headers"] = "authorization, content-type, apikey";
			headers["access-control-allow-methods"] = "POST, OPTIONS";
		}
		if (request.method === "OPTIONS") return new Response(null, { status: origin === returnUrl.origin ? 204 : 403, headers });
		if (request.method !== "POST") throw new BillingError(405, "Method not allowed");
		const action = new URL(request.url).pathname.split("/").at(-1);
		if (action === "webhook") {
			const bytes = await boundedBody(request, 1048576);
			await verifyStripeSignature(bytes, request.headers.get("stripe-signature") ?? "", options.webhookSecret, options.now());
			await reconcileWebhook(bytes, options);
			return Response.json({ received: true }, { headers });
		}
		if (origin && origin !== returnUrl.origin) throw new BillingError(403, "Billing origin denied");
		if (action !== "portal" && action !== "checkout") throw new BillingError(404, "Billing action unavailable");
		const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
		const userId = token ? await options.authenticate(token) : null;
		if (!userId) throw new BillingError(401, "Sign in required");
		const body = object(JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096))));
		if (Object.keys(body).some((key) => action === "portal" || !["planKey", "version", "requestId"].includes(key)))
			throw new BillingError(400, "Unexpected billing field");
		if (action === "checkout") {
			const catalog = object(await options.rpc("qorpera_computer_plan_catalog", {}));
			const offer = Array.isArray(catalog.plans) ? catalog.plans.map(object).find((plan) => plan.planKey === body.planKey && plan.version === body.version) : undefined;
			if (!offer || offer.activeForCheckout !== true) throw new BillingError(409, "Computer plans are not open for checkout yet");
			if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))
				throw new BillingError(400, "Checkout request identity required");
			const prices = Object.entries(options.pricePlans).filter(([, plan]) => plan.planKey === offer.planKey && plan.version === offer.version);
			if (prices.length !== 1) throw new BillingError(503, "Checkout price is not configured");
			const priceId = identifier(prices[0][0], "price");
			const price = await stripe(options, `prices/${priceId}`);
			if (price.id !== priceId || price.active !== true || price.livemode !== options.liveMode || price.currency !== "dkk" ||
				price.unit_amount !== offer.monthlyPriceMinor || object(price.recurring).interval !== "month" || object(price.recurring).interval_count !== 1)
				throw new BillingError(503, "Checkout price differs from catalog");
			const checkout = await billingCommand(options, userId, "checkout", body.requestId,
				{ planKey: offer.planKey, version: offer.version, tariffVersion: offer.tariffVersion, priceId, returnUrl: options.returnUrl }, async (checkoutKey) => {
					const customer = await billingCommand(options, userId, "customer", body.requestId as string, {}, async (customerKey) => {
						const created = await stripe(options, "customers", new URLSearchParams({ "metadata[qorpera_user_id]": userId }), customerKey);
						return { customerId: identifier(created.id, "cus") };
					});
					// A completed Checkout can be paid even when its webhook is late.
					// Check the mapped customer's canonical subscriptions before each
					// new provider session, including retries after session expiry.
					const existing = await stripe(options, `subscriptions?customer=${identifier(customer.customerId, "cus")}&status=all&limit=100`);
					if (!Array.isArray(existing.data) || existing.has_more !== false)
						throw new BillingError(503, "Existing subscriptions need reconciliation");
					if (existing.data.map(object).some((entry) => !["canceled", "incomplete_expired"].includes(String(entry.status))))
						throw new BillingError(409, "A computer subscription already exists");
					const session = await stripe(options, "checkout/sessions", new URLSearchParams({
						mode: "subscription", customer: identifier(customer.customerId, "cus"), "line_items[0][price]": priceId,
						"line_items[0][quantity]": "1", success_url: options.returnUrl, cancel_url: options.returnUrl,
						client_reference_id: userId, "subscription_data[metadata][qorpera_user_id]": userId,
					}), checkoutKey);
					if (typeof session.url !== "string" || new URL(session.url).protocol !== "https:" || new URL(session.url).hostname !== "checkout.stripe.com" ||
						typeof session.id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(session.id) || typeof session.expires_at !== "number" || !Number.isSafeInteger(session.expires_at))
						throw new BillingError(503, "Checkout session differs");
					return { sessionId: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString() };
				});
			return Response.json({ url: checkout.url, expiresAt: checkout.expiresAt }, { headers });
		}
		const mapping = await options.rpc("qorpera_computer_billing_customer", { p_user_id: userId });
		if (!mapping) throw new BillingError(403, "Billing customer unavailable");
		const customer = object(mapping);
		if (customer.userId !== userId) throw new BillingError(403, "Billing customer unavailable");
		const configurationId = identifier(options.portalConfigurationId, "bpc");
		const configuration = await stripe(options, `billing_portal/configurations/${configurationId}`);
		if (configuration.id !== configurationId || configuration.active !== true || configuration.livemode !== options.liveMode ||
			object(object(configuration.features).subscription_update).enabled !== false)
			throw new BillingError(503, "Billing portal plan changes are not enabled");
		const portal = await stripe(options, "billing_portal/sessions", new URLSearchParams({ customer: identifier(customer.customerId, "cus"), return_url: options.returnUrl, configuration: configurationId }));
		if (typeof portal.url !== "string" || new URL(portal.url).protocol !== "https:" || new URL(portal.url).hostname !== "billing.stripe.com")
			throw new BillingError(503, "Billing portal unavailable");
		return Response.json({ url: portal.url }, { headers });
	} catch (error) {
		const status = error instanceof BillingError ? error.status : error instanceof SyntaxError ? 400 : 503;
		return Response.json({ error: error instanceof BillingError ? error.message : status === 400 ? "Invalid billing payload" : "Billing temporarily unavailable" }, { status, headers });
	}
}
