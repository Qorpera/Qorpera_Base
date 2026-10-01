import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/**
 * Signed hooks (Q1 step W1b, migration 20260929998000; contract section 19, item 8; design
 * deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Verification in the vault (W1b)"). A delivery to a hook proven
 * by a Stripe, GitHub or HMAC-SHA256 signature waits as `received`. The broker that serves the company claims
 * it with the sealed current version of the hook's signing secret (connector `event_hook`), opens the secret in
 * memory, checks the signature and answers one verdict: verified with the sender's id and the event's type,
 * refused with a fixed reason, or retry. The secret never leaves this process, and nothing here logs a body,
 * a header or a secret.
 *
 * - `stripe`: `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=…]`, HMAC-SHA256 of `<t>.<body>` with the endpoint's
 *   signing secret (`whsec_…`, used as it is); the id is the event's `id`, the type its `type`.
 * - `github`: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the body; the id is `X-GitHub-Delivery`, the
 *   type `X-GitHub-Event` and, when the body has one, `.<action>` (`pull_request.opened`).
 * - `hmac-sha256` (senders the company controls): `X-Qorpera-Signature: v1=<hex>` over
 *   `<X-Qorpera-Timestamp>.<body>`; the id is `X-Qorpera-Delivery` or `Idempotency-Key`, the type
 *   `X-Qorpera-Event`.
 *
 * Signatures with a timestamp are accepted within 300 seconds of the delivery's arrival, so a check that
 * runs late still judges the sender's time against when the delivery came. A sender id that is missing or
 * unusable becomes `sig:<signature>`, so an exact replay of one signed delivery is a duplicate.
 */

export type EventHookProof = "stripe" | "github" | "hmac-sha256";
export type EventSignatureCheck = { ok: true; key: string; type: string | null } | { ok: false; reason: string };

const TOLERANCE_SECONDS = 300;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;
const SECONDS = /^[0-9]{1,12}$/;
/** A sender id or an event type as the database keeps them: printable ASCII without spaces. */
const PRINTABLE = /^[\x21-\x7e]+$/;
const PROOFS = new Set<EventHookProof>(["stripe", "github", "hmac-sha256"]);
/** Deliveries per claim (SQL allows 16), claims per pass, and how often a pass runs. */
const CLAIM_LIMIT = 16;
const CLAIMS_PER_PASS = 4;
const PASS_EVERY_MS = 5000;
const DATABASE_DEADLINE_MS = 10_000;
/** The vault field the hook's signing secret is captured under. */
export const EVENT_HOOK_SECRET_FIELD = "signing_secret";

const refuse = (reason: string): EventSignatureCheck => ({ ok: false, reason });

function hmac(secret: string, ...parts: Array<string | Uint8Array>): Buffer {
	const mac = createHmac("sha256", Buffer.from(secret, "utf8"));
	for (const part of parts) mac.update(part);
	return mac.digest();
}

/** One of the given hex signatures equals the expected MAC, compared in constant time. */
function matches(given: readonly string[], expected: Buffer): boolean {
	let found = false;
	for (const candidate of given) {
		if (!HEX_SIGNATURE.test(candidate)) continue;
		if (timingSafeEqual(Buffer.from(candidate, "hex"), expected)) found = true;
	}
	return found;
}

function senderId(value: string | undefined): string | undefined {
	return value !== undefined && value.length <= 256 && PRINTABLE.test(value) && !value.startsWith("body:")
		? value
		: undefined;
}

function eventType(value: string | undefined): string | null {
	return value !== undefined && value.length <= 128 && PRINTABLE.test(value) ? value : null;
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
		if (!matches(signatures, hmac(secret, `${timestamp}.`, body)))
			return refuse("The Stripe signature does not match");
		const event = jsonObject(body);
		const id = typeof event?.id === "string" ? senderId(event.id) : undefined;
		if (!id) return refuse("The Stripe event has no id");
		return { ok: true, key: id, type: eventType(typeof event?.type === "string" ? event.type : undefined) };
	}
	if (input.proof === "github") {
		const header = headers["x-hub-signature-256"];
		if (!header) return refuse("The X-Hub-Signature-256 header is missing");
		if (!header.startsWith("sha256=")) return refuse("The X-Hub-Signature-256 header is malformed");
		const signature = header.slice("sha256=".length);
		if (!matches([signature], hmac(secret, body))) return refuse("The GitHub signature does not match");
		const name = eventType(headers["x-github-event"]);
		const action = jsonObject(body)?.action;
		return {
			ok: true,
			key: senderId(headers["x-github-delivery"]) ?? `sig:${signature}`,
			type: name && typeof action === "string" ? eventType(`${name}.${action}`) : name,
		};
	}
	const header = headers["x-qorpera-signature"];
	const timestamp = headers["x-qorpera-timestamp"];
	if (!header || timestamp === undefined)
		return refuse("The X-Qorpera-Signature or X-Qorpera-Timestamp header is missing");
	const signatures = header
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.startsWith("v1="))
		.map((part) => part.slice(3));
	if (!SECONDS.test(timestamp) || signatures.length === 0)
		return refuse("The X-Qorpera-Signature header is malformed");
	if (!fresh(timestamp, receivedAt)) return refuse("The signature is outside the five minutes allowed");
	const expected = hmac(secret, `${timestamp}.`, body);
	if (!matches(signatures, expected)) return refuse("The signature does not match");
	return {
		ok: true,
		key:
			senderId(headers["x-qorpera-delivery"]) ??
			senderId(headers["idempotency-key"]) ??
			`sig:${expected.toString("hex")}`,
		type: eventType(headers["x-qorpera-event"]),
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

interface Claim {
	readonly deliveryId: string;
	readonly claim: string;
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

function parseClaims(value: unknown): Claim[] {
	if (!Array.isArray(value) || value.length > CLAIM_LIMIT) throw new Error("Event verification claim is invalid");
	return value.map((item) => {
		const input = item as Record<string, unknown>;
		// One base64 line each; a line-broken encoding is joined.
		const line = (field: unknown) => (typeof field === "string" ? field.replace(/\r?\n/g, "") : "");
		const body = line(input?.bodyBase64);
		const envelope = line(input?.encryptedEnvelopeBase64);
		const headers = input?.headers;
		if (
			!input ||
			typeof input !== "object" ||
			Object.keys(input).sort().join() !==
				"bodyBase64,claim,companyId,deliveryId,encryptedEnvelopeBase64,envelopeSha256,environmentId,headers,hookId,keyId,proof,receivedAt,schema,secretId,secretVersion" ||
			input.schema !== "qorpera.event-verification/v1" ||
			![input.deliveryId, input.claim, input.companyId, input.environmentId, input.hookId, input.secretId].every(
				isUuid,
			) ||
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
			throw new Error("Event verification claim is invalid");
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
	});
}

/** One company authority's waiting deliveries: claims, checks each signature, records each verdict. */
export class CloudEventVerifications {
	readonly #authority: EventVerificationAuthority;
	readonly #keyring: Pick<CloudSecretKeyring, "use">;

	constructor(options: { authority: EventVerificationAuthority; keyring: Pick<CloudSecretKeyring, "use"> }) {
		this.#authority = options.authority;
		this.#keyring = options.keyring;
	}

	/** Up to four claims; stops when a claim brings nothing or the pass is closed. A delivery claimed but not
	 * reached before a close is offered again when its claim ends (60 seconds). */
	async pass(signal: AbortSignal): Promise<{ verified: number; refused: number; retried: number }> {
		const counts = { verified: 0, refused: 0, retried: 0 };
		for (let round = 0; round < CLAIMS_PER_PASS && !signal.aborted; round += 1) {
			const claims = parseClaims(
				await this.#authority.claimEventVerifications(
					CLAIM_LIMIT,
					AbortSignal.any([signal, AbortSignal.timeout(DATABASE_DEADLINE_MS)]),
				),
			);
			for (const claim of claims) {
				if (signal.aborted) break;
				const verdict = await this.#verify(claim);
				counts[
					verdict.verdict === "verified" ? "verified" : verdict.verdict === "refused" ? "refused" : "retried"
				] += 1;
				await this.#authority.finishEventVerification(
					{ deliveryId: claim.deliveryId, claim: claim.claim, ...verdict },
					AbortSignal.timeout(DATABASE_DEADLINE_MS),
				);
			}
			if (claims.length === 0) break;
		}
		return counts;
	}

	async #verify(claim: Claim): Promise<EventVerificationVerdict> {
		const retry: EventVerificationVerdict = { verdict: "retry", key: null, type: null, reason: null };
		const envelope = Buffer.from(claim.encryptedEnvelopeBase64, "base64");
		const body = Buffer.from(claim.bodyBase64, "base64");
		try {
			// A damaged envelope or a key this copy of the vault lacks: offered again after a growing wait, and
			// refused by SQL after five tries (about three hours).
			if (createHash("sha256").update(envelope).digest("hex") !== claim.envelopeSha256) return retry;
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
			return retry;
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
		const { verified, refused, retried } = await verifications.pass(signal);
		if (refused > 0 || retried > 0)
			console.error(`Event verification: ${verified} verified, ${refused} refused, ${retried} offered again.`);
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
