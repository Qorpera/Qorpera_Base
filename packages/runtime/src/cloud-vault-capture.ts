import { createHash, timingSafeEqual } from "node:crypto";
import { parseClosedRecord, parseInteger } from "@qorpera/contracts";
import type { CloudSecretEnvelopeIdentity, CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/* What the vault's captures share (E3c's Stripe hook secrets, cloud-event-hook-vault.ts; coding values,
 * cloud-coding-value-vault.ts): the database's refusals the runtime reads, the version the vault holds as a read
 * carries it, the comparison of a captured value with it, and the reads again after a store that met another capture
 * (40003). No value is ever in an answer, a log or an error. */

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** SQL's answers the runtime reads, as manage_hook's host path raises them: the request's rules, the company's state,
 * the run's authority and the wake's (refused in the model's words, or asked again: 40P01, QRC01, 55P03). Their
 * messages hold no value. */
export const VAULT_CAPTURE_REFUSALS: ReadonlySet<string> = new Set([
	"0A000",
	"22023",
	"23505",
	"42501",
	"54000",
	"55000",
	"55P03",
	"40P01",
	"QRC01",
	"P0002",
]);
/** How many times a capture reads and stores before a race it keeps losing (40003) is left unconfirmed. */
const CAPTURE_ATTEMPTS = 3;

/** A database refusal (or the vault's own, `vaultRefused`) the model reads: its code and words; null for any other
 * failure, which is unconfirmed. */
export function vaultCaptureRefusal(error: unknown): { readonly code: string; readonly message: string } | null {
	if (!error || typeof error !== "object") return null;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code !== "string" || !VAULT_CAPTURE_REFUSALS.has(code) || typeof message !== "string") return null;
	return { code, message: message.slice(0, 512) };
}

/** The vault's own refusal, in the database's form: the model reads it and the call is not asked again. */
export function vaultRefused(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

/** `work` again after a store that met another capture (40003: the version it read is no longer the next), a few
 * times, for the same receipt and box, never the page; any other failure at once. */
export async function withCaptureRetries<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await work();
		} catch (error) {
			if (attempt >= CAPTURE_ATTEMPTS || (error as { code?: unknown } | null)?.code !== "40003") throw error;
			signal.throwIfAborted();
		}
	}
}

/** The version the vault holds, as a read carries it: its envelope checked against its digest. */
export interface HeldVersion {
	readonly version: number;
	readonly keyId: string;
	readonly envelope: Buffer;
}

/** A read's `current`: the held version's number, key and envelope, which matches its digest; else an error. */
export function parseHeldVersion(value: unknown, label: string): HeldVersion {
	const current = parseClosedRecord(value, label, ["version", "keyId", "encryptedEnvelopeBase64", "envelopeSha256"]);
	const { keyId, encryptedEnvelopeBase64, envelopeSha256 } = current;
	// PostgreSQL's encode(…, 'base64') breaks lines every 76 characters; the line breaks carry nothing.
	const base64 = typeof encryptedEnvelopeBase64 === "string" ? encryptedEnvelopeBase64.replace(/\n/g, "") : null;
	if (
		typeof keyId !== "string" ||
		!KEY_ID.test(keyId) ||
		base64 === null ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
		typeof envelopeSha256 !== "string" ||
		!SHA256.test(envelopeSha256)
	)
		throw new Error(`${label} is malformed`);
	const version = parseInteger(current.version, `${label} version`, 1, Number.MAX_SAFE_INTEGER);
	const envelope = Buffer.from(base64, "base64");
	if (
		envelope.toString("base64") !== base64 ||
		createHash("sha256").update(envelope).digest("hex") !== envelopeSha256
	) {
		envelope.fill(0);
		throw new Error(`${label} envelope is malformed`);
	}
	return { version, keyId, envelope };
}

/** Whether the held version's one field `field` is `value`, compared in constant time. */
export function heldValueIs(
	keys: CloudSecretKeyring,
	held: HeldVersion,
	identity: Omit<CloudSecretEnvelopeIdentity, "version" | "keyId">,
	field: string,
	value: Buffer,
): Promise<boolean> {
	const { companyId, environmentId, secretId } = identity;
	const sealed = { companyId, environmentId, secretId, version: held.version, keyId: held.keyId };
	return keys.use(held.envelope, sealed, async (fields) => {
		const stored = Object.hasOwn(fields, field) ? fields[field] : undefined;
		if (typeof stored !== "string") throw new Error("Held secret is malformed");
		const bytes = Buffer.from(stored, "utf8");
		try {
			return bytes.byteLength === value.byteLength && timingSafeEqual(bytes, value);
		} finally {
			bytes.fill(0);
		}
	});
}
