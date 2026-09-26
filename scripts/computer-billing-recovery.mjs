import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STRIPE_API_VERSION } from "../supabase/functions/computer-billing/computer-billing.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function object(value) { assert(value && typeof value === "object" && !Array.isArray(value), "Invalid recovery object"); return value; }
function providerId(value, prefix) { assert(typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,240}$`).test(value), "Invalid provider identity"); return value; }

/** Only positive, exactly correlated canonical objects resolve old commands.
 * There is deliberately no list/search absence branch or provider mutation. */
export async function prepareBillingRecovery(command, providerObjectId, eventId, { stripe, liveMode, now = Date.now }) {
	object(command); assert(UUID.test(command.commandId) && UUID.test(command.userId), "Invalid command identity");
	if (command.recovery) return object(command.recovery);
	assert(command.result === null && command.recoveredTerminal === false, "Command already resolved");
	assert(Number.isFinite(Date.parse(command.createdAt)) && Date.parse(command.createdAt) <= now() - 23 * 3600000, "Command is not aged");
	assert(command.idempotencyKey === `qorpera-computer-${command.commandId}`, "Command provider key differs");
	assert(command.kind === "customer" || command.kind === "checkout", "Unsupported command kind");
	providerId(providerObjectId, command.kind === "customer" ? "cus" : "cs");
	const canonical = object(await stripe(`${command.kind === "customer" ? "customers" : "checkout/sessions"}/${providerObjectId}`));
	assert(canonical.id === providerObjectId && canonical.livemode === liveMode && canonical.deleted !== true, "Canonical provider object differs");
	assert(Number.isSafeInteger(canonical.created) && canonical.created * 1000 >= Date.parse(command.createdAt) - 5000, "Provider object predates command");
	let event = null;
	if (eventId) {
		providerId(eventId, "evt"); event = object(await stripe(`events/${eventId}`));
		assert(event.id === eventId && event.livemode === liveMode && event.api_version === STRIPE_API_VERSION &&
			object(object(event.data).object).id === canonical.id && object(event.request).idempotency_key === command.idempotencyKey,
			"Provider event does not prove original command");
	} else assert(object(canonical.metadata).qorpera_command_id === command.idempotencyKey, "Provider object lacks exact command correlation");
	const proof = { schema: "qorpera.billing-command-recovery/v1", kind: command.kind, userId: command.userId,
		providerObjectId, providerRequestKey: command.idempotencyKey, customerId: null, priceId: null, returnUrl: null,
		providerState: null, result: null, objectSha256: hash(canonical), eventId: event?.id ?? null,
		eventSha256: event ? hash(event) : null, verifiedAt: new Date(now()).toISOString() };
	if (command.kind === "customer") {
		assert(object(canonical.metadata).qorpera_user_id === command.userId, "Customer user differs");
		assert(command.customerId === null || command.customerId === canonical.id, "Customer mapping differs");
		proof.customerId = canonical.id; proof.providerState = "present"; proof.result = { customerId: canonical.id };
	} else {
		const intent = object(command.payload);
		assert(canonical.mode === "subscription" && canonical.customer === command.customerId && canonical.client_reference_id === command.userId &&
			canonical.success_url === intent.returnUrl && canonical.cancel_url === intent.returnUrl, "Checkout intent differs");
		assert(["open", "complete", "expired"].includes(canonical.status), "Unsupported checkout state");
		const lines = object(await stripe(`checkout/sessions/${providerObjectId}/line_items?limit=2`));
		assert(lines.has_more === false && Array.isArray(lines.data) && lines.data.length === 1 &&
			object(lines.data[0]).quantity === 1 && object(lines.data[0].price).id === intent.priceId, "Checkout offer differs");
		providerId(canonical.customer, "cus");
		proof.customerId = canonical.customer; proof.priceId = intent.priceId; proof.returnUrl = intent.returnUrl;
		proof.providerState = canonical.status;
		// Bind the separately fetched line evidence into the immutable digest.
		proof.objectSha256 = hash({ session: canonical, lineItems: lines });
		if (canonical.status === "open") {
			const url = new URL(canonical.url);
			assert(url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.username && !url.password && !url.port, "Checkout destination differs");
			assert(Number.isSafeInteger(canonical.expires_at) && canonical.expires_at * 1000 > now(), "Open checkout is already expired");
			proof.result = { sessionId: canonical.id, url: canonical.url, expiresAt: new Date(canonical.expires_at * 1000).toISOString() };
		}
	}
	return proof;
}

async function privateJson(path) {
	assert(typeof path === "string" && resolve(path) === path, "Canonical absolute file path required");
	const stat = await lstat(path);
	assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 16384,
		"Recovery files must be private regular files owned by this operator");
	return object(JSON.parse(await readFile(path, "utf8")));
}

async function responseJson(response) {
	assert(response.ok, `Recovery endpoint returned HTTP ${response.status}`);
	const reader = response.body.getReader(), chunks = []; let size = 0;
	try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
		assert(size <= 1048576, "Recovery endpoint response too large"); chunks.push(part.value); } }
	finally { await reader.cancel(); reader.releaseLock(); }
	return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export async function runBillingRecovery(args, fetcher = fetch) {
	const options = {};
	for (let i = 0; i < args.length; i += 2) {
		assert(["--config", "--command", "--object", "--event", "--out", "--apply"].includes(args[i]) && !options[args[i]] && args[i + 1], "Invalid recovery arguments");
		options[args[i]] = args[i + 1];
	}
	const config = await privateJson(options["--config"]), origin = new URL(config.supabaseUrl);
	assert(origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "Invalid billing origin");
	assert(typeof config.serviceKey === "string" && config.serviceKey.length > 20 && typeof config.billingSecret === "string" && config.billingSecret.length >= 32 &&
		typeof config.stripeSecretKey === "string" && config.stripeSecretKey.length > 20 && typeof config.liveMode === "boolean", "Invalid private recovery configuration");
	const rpc = async (method, parameters) => responseJson(await fetcher(new URL("/rest/v1/rpc/qorpera_computer_billing_rpc", origin), {
		method: "POST", headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, "content-type": "application/json" },
		body: JSON.stringify({ p_method: method, p_args: parameters, p_billing_secret: config.billingSecret }), redirect: "error", signal: AbortSignal.timeout(15000),
	}));
	if (options["--apply"]) {
		assert(Object.keys(options).length === 2, "Apply accepts only config and immutable proof file");
		const retained = await privateJson(options["--apply"]);
		assert(retained.schema === "qorpera.billing-recovery-operation/v1" && UUID.test(retained.commandId), "Invalid retained recovery operation");
		await rpc("qorpera_recover_computer_billing_command", { p_command_id: retained.commandId, p_proof: object(retained.proof) });
		return { state: "reconciled", commandId: retained.commandId };
	}
	assert(UUID.test(options["--command"]) && options["--object"] && options["--out"] && resolve(options["--out"]) === options["--out"], "Prepare requires command, provider object and new absolute output path");
	const command = await rpc("qorpera_describe_computer_billing_command", { p_command_id: options["--command"] });
	assert(command.commandId === options["--command"], "Returned command differs");
	const proof = await prepareBillingRecovery(command, options["--object"], options["--event"], { liveMode: config.liveMode,
		stripe: async path => responseJson(await fetcher(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${config.stripeSecretKey}`, "Stripe-Version": STRIPE_API_VERSION }, redirect: "error", signal: AbortSignal.timeout(15000) })) });
	await writeFile(options["--out"], `${JSON.stringify({ schema: "qorpera.billing-recovery-operation/v1", commandId: command.commandId, proof }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	return { state: "proof_retained", commandId: command.commandId, proofSha256: hash(proof) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try { process.stdout.write(`${JSON.stringify(await runBillingRecovery(process.argv.slice(2)))}\n`); }
	catch { process.stderr.write("Billing recovery refused; no command was replayed. Check private configuration and exact provider evidence.\n"); process.exitCode = 1; }
}
