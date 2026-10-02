import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/**
 * Signed hooks (Q1 step W1b, migration 20260929998000; contract section 19, item 8; design
 * deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Verification in the vault (W1b)"). A delivery to a hook proven
 * by a Stripe, GitHub or Standard Webhooks signature waits as `received`. The broker that serves the company
 * claims it with the sealed current version of the hook's signing secret (connector `event_hook`), opens the
 * secret in memory, checks the signature and answers one verdict: verified with a sender id and the event's
 * type, refused with a fixed reason, or retry. The secret never leaves this process, and nothing here logs a
 * body, a header or a secret.
 *
 * The sender id is always one the signature covers, so nobody who saw a signed delivery can replay it under a
 * new id or type and have the real event dropped as a duplicate:
 * - `stripe`: `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=…]`, HMAC-SHA256 of `<t>.<body>` with the endpoint's
 *   signing secret (`whsec_…`, used as it is); the id is the event's `id` and the type its `type`, both in the
 *   signed body.
 * - `github`: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the body. GitHub signs neither
 *   `X-GitHub-Delivery` nor `X-GitHub-Event`, so the id is `sig:<signature>`: a redelivery or a replay of the same
 *   body is a duplicate. The type is `X-GitHub-Event` and, when the body has one, `.<action>`
 *   (`pull_request.opened`); a replay that changes it is still the same signature, so a duplicate.
 * - `hmac-sha256`: Standard Webhooks (standardwebhooks.com, also Svix's `svix-*` headers): `webhook-signature:
 *   v1,<base64>[ v1,<base64>…]` over `<webhook-id>.<webhook-timestamp>.<body>` with the secret's key (`whsec_` and
 *   base64); the id is `webhook-id` and the type the body's `type`.
 *
 * Signatures with a timestamp are accepted within 300 seconds of the delivery's arrival, so a check that runs
 * late still judges the sender's time against when the delivery came. A signed id the database cannot keep
 * becomes `sig:<signature>`.
 */

export type EventHookProof = "stripe" | "github" | "hmac-sha256";
export type EventSignatureCheck = { ok: true; key: string; type: string | null } | { ok: false; reason: string };

const TOLERANCE_SECONDS = 300;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;
/** A Standard Webhooks secret: `whsec_` (optional) and the base64 key. */
const STANDARD_SECRET = /^(?:whsec_)?([A-Za-z0-9+/]{22,}={0,2})$/;
const SECONDS = /^[0-9]{1,12}$/;
/** A sender id or an event type as the database keeps them: printable ASCII without spaces. */
const PRINTABLE = /^[\x21-\x7e]+$/;
const PROOFS = new Set<EventHookProof>(["stripe", "github", "hmac-sha256"]);
/** Deliveries per claim (SQL allows 16), claims per pass, finishes that may fail before a pass stops, and how
 * often a pass runs. */
const CLAIM_LIMIT = 16;
const CLAIMS_PER_PASS = 4;
const FAILURES_PER_PASS = 3;
const PASS_EVERY_MS = 5000;
const DATABASE_DEADLINE_MS = 10_000;
/** The vault field the hook's signing secret is captured under. */
export const EVENT_HOOK_SECRET_FIELD = "signing_secret";

const refuse = (reason: string): EventSignatureCheck => ({ ok: false, reason });

/** HMAC-SHA256 with a key buffer that is zeroed once the MAC is made. */
function hmac(key: Buffer, ...parts: Array<string | Uint8Array>): Buffer {
	try {
		const mac = createHmac("sha256", key);
		for (const part of parts) mac.update(part);
		return mac.digest();
	} finally {
		key.fill(0);
	}
}

/** One of the given signatures equals the expected MAC, compared in constant time. */
function matches(given: readonly Buffer[], expected: Buffer): boolean {
	let found = false;
	for (const candidate of given) {
		if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) found = true;
	}
	return found;
}

const hexSignatures = (values: readonly string[]) =>
	values.filter((value) => HEX_SIGNATURE.test(value)).map((value) => Buffer.from(value, "hex"));

function senderId(value: string | undefined): string | undefined {
	return value !== undefined && value.length <= 256 && PRINTABLE.test(value) && !value.startsWith("body:")
		? value
		: undefined;
}

function eventType(value: unknown): string | null {
	return typeof value === "string" && value.length <= 128 && PRINTABLE.test(value) ? value : null;
}

/** The body as a JSON object, or undefined. */
function jsonObject(body: Uint8Array): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function fresh(timestamp: string, receivedAt: number): boolean {
	return Math.abs(receivedAt - Number(timestamp)) <= TOLERANCE_SECONDS;
}

/** Checks one delivery's signature with the hook's secret. Pure: the secret is only used here. */
export function checkEventSignature(input: {
	proof: EventHookProof;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array;
	secret: string;
	/** The delivery's arrival, in whole seconds since the epoch. */
	receivedAt: number;
}): EventSignatureCheck {
	const { headers, body, secret, receivedAt } = input;
	if (!secret) return refuse("The hook's signing secret is empty");
	if (input.proof === "stripe") {
		const header = headers["stripe-signature"];
		if (!header) return refuse("The Stripe-Signature header is missing");
		let timestamp: string | undefined;
		const signatures: string[] = [];
		for (const part of header.split(",")) {
			const at = part.indexOf("=");
			if (at < 1) continue;
			const name = part.slice(0, at).trim();
			const value = part.slice(at + 1).trim();
			if (name === "t") timestamp = value;
			else if (name === "v1") signatures.push(value);
		}
		if (timestamp === undefined || !SECONDS.test(timestamp) || signatures.length === 0)
			return refuse("The Stripe-Signature header is malformed");
		if (!fresh(timestamp, receivedAt)) return refuse("The Stripe signature is outside the five minutes allowed");
		if (!matches(hexSignatures(signatures), hmac(Buffer.from(secret, "utf8"), `${timestamp}.`, body)))
			return refuse("The Stripe signature does not match");
		const event = jsonObject(body);
		const id = typeof event?.id === "string" ? senderId(event.id) : undefined;
		if (!id) return refuse("The Stripe event has no id");
		return { ok: true, key: id, type: eventType(event?.type) };
	}
	if (input.proof === "github") {
		const header = headers["x-hub-signature-256"];
		if (!header) return refuse("The X-Hub-Signature-256 header is missing");
		if (!header.startsWith("sha256=")) return refuse("The X-Hub-Signature-256 header is malformed");
		const expected = hmac(Buffer.from(secret, "utf8"), body);
		if (!matches(hexSignatures([header.slice("sha256=".length)]), expected))
			return refuse("The GitHub signature does not match");
		const name = eventType(headers["x-github-event"]);
		const action = jsonObject(body)?.action;
		return {
			ok: true,
			key: `sig:${expected.toString("hex")}`,
			type: name && typeof action === "string" ? eventType(`${name}.${action}`) : name,
		};
	}
	// Standard Webhooks, under its own header names or Svix's.
	const scheme = headers["webhook-id"] !== undefined ? "webhook" : "svix";
	const id = headers[`${scheme}-id`];
	const timestamp = headers[`${scheme}-timestamp`];
	const header = headers[`${scheme}-signature`];
	if (id === undefined || timestamp === undefined || header === undefined)
		return refuse("The webhook-id, webhook-timestamp or webhook-signature header is missing");
	const signatures = header
		.split(" ")
		.filter((part) => part.startsWith("v1,"))
		.map((part) => part.slice(3));
	if (!SECONDS.test(timestamp) || signatures.length === 0) return refuse("The webhook-signature header is malformed");
	if (!fresh(timestamp, receivedAt)) return refuse("The signature is outside the five minutes allowed");
	const encoded = STANDARD_SECRET.exec(secret)?.[1];
	if (encoded === undefined) return refuse("The hook's signing secret is not a Standard Webhooks secret");
	const expected = hmac(Buffer.from(encoded, "base64"), `${id}.${timestamp}.`, body);
	const given = signatures
		.filter((value) => BASE64_SIGNATURE.test(value))
		.map((value) => Buffer.from(value, "base64"));
	if (!matches(given, expected)) return refuse("The signature does not match");
	return {
		ok: true,
		key: senderId(id) ?? `sig:${expected.toString("hex")}`,
		type: eventType(jsonObject(body)?.type),
	};
}

export type EventVerificationVerdict =
	| { verdict: "verified"; key: string; type: string | null; reason: null }
	| { verdict: "refused"; key: null; type: null; reason: string }
	| { verdict: "retry"; key: null; type: null; reason: null };

export interface EventVerificationAuthority {
	claimEventVerifications(limit: number, signal: AbortSignal): Promise<unknown>;
	finishEventVerification(
		answer: { deliveryId: string; claim: string } & EventVerificationVerdict,
		signal: AbortSignal,
	): Promise<unknown>;
}

interface Held {
	readonly deliveryId: string;
	readonly claim: string;
}

interface Claim extends Held {
	readonly companyId: string;
	readonly environmentId: string;
	readonly proof: EventHookProof;
	readonly receivedAt: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly bodyBase64: string;
	readonly secretId: string;
	readonly version: number;
	readonly keyId: string;
	readonly encryptedEnvelopeBase64: string;
	readonly envelopeSha256: string;
}

const CLAIM_KEYS =
	"bodyBase64,claim,companyId,deliveryId,encryptedEnvelopeBase64,envelopeSha256,environmentId,headers,hookId,keyId,proof,receivedAt,schema,secretId,secretVersion";

function parseClaim(input: Record<string, unknown>): Claim | undefined {
	// One base64 line each; a line-broken encoding is joined.
	const line = (field: unknown) => (typeof field === "string" ? field.replace(/\r?\n/g, "") : "");
	const body = line(input.bodyBase64);
	const envelope = line(input.encryptedEnvelopeBase64);
	const headers = input.headers;
	if (
		Object.keys(input).sort().join() !== CLAIM_KEYS ||
		input.schema !== "qorpera.event-verification/v1" ||
		![input.companyId, input.environmentId, input.hookId, input.secretId].every(isUuid) ||
		typeof input.proof !== "string" ||
		!PROOFS.has(input.proof as EventHookProof) ||
		!Number.isSafeInteger(input.receivedAt) ||
		!Number.isSafeInteger(input.secretVersion) ||
		(input.secretVersion as number) < 1 ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		!headers ||
		typeof headers !== "object" ||
		Array.isArray(headers) ||
		Object.values(headers).some((header) => typeof header !== "string") ||
		body.length > 360_000 ||
		!BASE64.test(body) ||
		envelope.length === 0 ||
		envelope.length > 180_000 ||
		!BASE64.test(envelope) ||
		typeof input.envelopeSha256 !== "string" ||
		!SHA256_HEX_PATTERN.test(input.envelopeSha256)
	)
		return undefined;
	return {
		deliveryId: input.deliveryId as string,
		claim: input.claim as string,
		companyId: input.companyId as string,
		environmentId: input.environmentId as string,
		proof: input.proof as EventHookProof,
		receivedAt: input.receivedAt as number,
		headers: headers as Record<string, string>,
		bodyBase64: body,
		secretId: input.secretId as string,
		version: input.secretVersion as number,
		keyId: input.keyId,
		encryptedEnvelopeBase64: envelope,
		envelopeSha256: input.envelopeSha256,
	};
}

/** A claim's deliveries, each readable or only held (answered retry), and how many the claim refused itself.
 * An item without its own delivery and claim ids is left to its lease. */
function parseClaimBatch(value: unknown): { items: Array<Claim | Held>; refused: number } {
	const batch = value as Record<string, unknown> | null;
	if (
		!batch ||
		typeof batch !== "object" ||
		Object.keys(batch).sort().join() !== "deliveries,refused,schema" ||
		batch.schema !== "qorpera.event-verification-claim/v1" ||
		!Array.isArray(batch.deliveries) ||
		batch.deliveries.length > CLAIM_LIMIT ||
		!Number.isSafeInteger(batch.refused) ||
		(batch.refused as number) < 0
	)
		throw new Error("Event verification claim is invalid");
	const items: Array<Claim | Held> = [];
	for (const item of batch.deliveries) {
		const input = item as Record<string, unknown> | null;
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			!isUuid(input.deliveryId) ||
			!isUuid(input.claim)
		)
			continue;
		items.push(parseClaim(input) ?? { deliveryId: input.deliveryId, claim: input.claim });
	}
	return { items, refused: batch.refused as number };
}

export interface EventVerificationCounts {
	verified: number;
	duplicate: number;
	refused: number;
	retried: number;
	stale: number;
	failed: number;
}

const OUTCOMES: Readonly<Record<string, keyof EventVerificationCounts>> = {
	verified: "verified",
	duplicate: "duplicate",
	refused: "refused",
	retry: "retried",
	stale: "stale",
};
const RETRY: EventVerificationVerdict = { verdict: "retry", key: null, type: null, reason: null };

/** One company authority's waiting deliveries: claims, checks each signature, records each verdict. */
export class CloudEventVerifications {
	readonly #authority: EventVerificationAuthority;
	readonly #keyring: Pick<CloudSecretKeyring, "use">;

	constructor(options: { authority: EventVerificationAuthority; keyring: Pick<CloudSecretKeyring, "use"> }) {
		this.#authority = options.authority;
		this.#keyring = options.keyring;
	}

	/** Up to four claims; stops when a claim brings and refuses nothing, after three verdicts that could not be
	 * recorded, or when the pass is closed. A delivery claimed but not answered is offered again when its claim
	 * ends (60 seconds). Counts are what the database recorded. */
	async pass(signal: AbortSignal): Promise<EventVerificationCounts> {
		const counts: EventVerificationCounts = {
			verified: 0,
			duplicate: 0,
			refused: 0,
			retried: 0,
			stale: 0,
			failed: 0,
		};
		for (let round = 0; round < CLAIMS_PER_PASS && !signal.aborted; round += 1) {
			const batch = parseClaimBatch(
				await this.#authority.claimEventVerifications(
					CLAIM_LIMIT,
					AbortSignal.any([signal, AbortSignal.timeout(DATABASE_DEADLINE_MS)]),
				),
			);
			counts.refused += batch.refused;
			for (const item of batch.items) {
				if (signal.aborted) break;
				const verdict = "proof" in item ? await this.#verify(item) : RETRY;
				try {
					const result = (await this.#authority.finishEventVerification(
						{ deliveryId: item.deliveryId, claim: item.claim, ...verdict },
						AbortSignal.timeout(DATABASE_DEADLINE_MS),
					)) as Record<string, unknown> | null;
					const outcome = typeof result?.outcome === "string" ? OUTCOMES[result.outcome] : undefined;
					counts[outcome ?? "failed"] += 1;
				} catch {
					counts.failed += 1;
				}
				if (counts.failed >= FAILURES_PER_PASS) return counts;
			}
			if (batch.items.length === 0 && batch.refused === 0) break;
		}
		return counts;
	}

	async #verify(claim: Claim): Promise<EventVerificationVerdict> {
		const envelope = Buffer.from(claim.encryptedEnvelopeBase64, "base64");
		const body = Buffer.from(claim.bodyBase64, "base64");
		try {
			// A damaged envelope or a key this copy of the vault lacks: offered again after a growing wait, and
			// refused by SQL at the fifth try (about two and a half hours).
			if (createHash("sha256").update(envelope).digest("hex") !== claim.envelopeSha256) return RETRY;
			return await this.#keyring.use(
				envelope,
				{
					companyId: claim.companyId,
					environmentId: claim.environmentId,
					secretId: claim.secretId,
					version: claim.version,
					keyId: claim.keyId,
				},
				async (fields): Promise<EventVerificationVerdict> => {
					const secret = Object.hasOwn(fields, EVENT_HOOK_SECRET_FIELD) ? fields[EVENT_HOOK_SECRET_FIELD] : "";
					const check = checkEventSignature({
						proof: claim.proof,
						headers: claim.headers,
						body,
						secret: secret ?? "",
						receivedAt: claim.receivedAt,
					});
					return check.ok
						? { verdict: "verified", key: check.key, type: check.type, reason: null }
						: { verdict: "refused", key: null, type: null, reason: check.reason };
				},
			);
		} catch {
			return RETRY;
		} finally {
			envelope.fill(0);
		}
	}
}

/** Runs one pass and logs what happened, by count only. */
export async function logEventVerificationPass(
	verifications: Pick<CloudEventVerifications, "pass">,
	signal: AbortSignal,
): Promise<void> {
	try {
		const { verified, duplicate, refused, retried, stale, failed } = await verifications.pass(signal);
		if (refused > 0 || retried > 0 || stale > 0 || failed > 0)
			console.error(
				`Event verification: ${verified} verified, ${duplicate} duplicate, ${refused} refused, ${retried} offered again, ${stale} stale, ${failed} not recorded.`,
			);
	} catch {
		console.error("Event verification: a pass stopped on an error; the next pass tries again.");
	}
}

/** A single-company broker's loop: a pass every five seconds, so a signed event wakes its routine promptly. */
export class CloudEventVerificationUpkeep {
	readonly #verifications: Pick<CloudEventVerifications, "pass">;
	readonly #passEveryMs: number;
	readonly #firstPassMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	readonly #closing = new AbortController();
	#started = false;

	constructor(options: {
		verifications: Pick<CloudEventVerifications, "pass">;
		passEveryMs?: number;
		firstPassMs?: number;
	}) {
		this.#verifications = options.verifications;
		this.#passEveryMs = options.passEveryMs ?? PASS_EVERY_MS;
		this.#firstPassMs = options.firstPassMs ?? 2000 + Math.floor(Math.random() * this.#passEveryMs);
	}

	start(): void {
		if (this.#started || this.#closing.signal.aborted) return;
		this.#started = true;
		const loop = (): void => {
			if (this.#closing.signal.aborted) return;
			this.#running = logEventVerificationPass(this.#verifications, this.#closing.signal).finally(() => {
				this.#running = undefined;
				if (!this.#closing.signal.aborted) this.#timer = setTimeout(loop, this.#passEveryMs);
			});
		};
		this.#timer = setTimeout(loop, this.#firstPassMs);
	}

	async close(): Promise<void> {
		this.#closing.abort();
		clearTimeout(this.#timer);
		await this.#running;
	}
}
