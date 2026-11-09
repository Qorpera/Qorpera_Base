import {
	createCipheriv,
	createDecipheriv,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import { isUuid } from "@qorpera/contracts";

/* A Stripe hook's signing secret on its way from one Company Computer into the vault (E3c,
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.8 point 3). The office reads the value off Stripe's
 * page and seals it to the hook's capture key, whose public half it reads from the database; the private
 * half is derived in the broker's keyring and never stored. The native host only carries the sealed box
 * to the broker, so the value exists in the clear only inside that office service and in the vault.
 *
 * It is A1-3's box (cloud-company-account-fill-box.ts) the other way round, with its own schemas and HKDF
 * info, so a capture box never opens as a fill box or the other way round. It is bound to the computer,
 * its boot generation, the one tool call (effect receipt) and the hook.
 *
 * The box itself (an ephemeral X25519 key, HKDF-SHA256, AES-256-GCM over the identity as associated data) is
 * shared with a coding value's capture (cloud-coding-value-capture-box.ts, 20260930695000), each kind under its own
 * schemas and info, so a box of one kind never opens as the other's. */

/** A box's kind: its schemas, its key derivation's info, and the words its errors use. */
export interface CaptureBoxKind {
	readonly box: string;
	readonly payload: string;
	readonly info: string;
	/** "Hook capture", "Coding value capture". */
	readonly label: string;
}

const HOOK_KIND: CaptureBoxKind = {
	box: "qorpera.event-hook-capture-box/v1",
	payload: "qorpera.event-hook-capture/v1",
	info: "qorpera.event-hook-capture/v1",
	label: "Hook capture",
};
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The X25519 SubjectPublicKeyInfo prefix (RFC 8410), for a raw 32-byte key. */
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
/** A Stripe signing secret, as the office reads it; the length is checked until a live run confirms Stripe's. */
export const EVENT_HOOK_CAPTURE_SECRET = /^whsec_[A-Za-z0-9+/=]{16,200}$/;
/** A captured value is stored within this long after it was read, or never (a hook's and a coding value's). */
export const EVENT_HOOK_CAPTURE_LIFETIME_MS = 90_000;
/** How far apart the computer's and the vault's clocks may be. */
const CLOCK_SKEW_MS = 60_000;

/** Who sealed the box: one computer's boot, for one tool call, with one hook's secret. */
export interface EventHookCaptureIdentity {
	readonly companyId: string;
	readonly companyComputerId: string;
	readonly computerGeneration: number;
	readonly receiptId: string;
	readonly hookId: string;
	readonly field: "signing_secret";
}

export interface EventHookCapture {
	readonly field: "signing_secret";
	/** The secret's bytes (UTF-8). The opener's callback has them; they are zeroed after it. */
	readonly value: Buffer;
	/** The page's host the value was read on. */
	readonly site: string;
	readonly capturedAtMs: number;
}

function base64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function decoded(value: unknown, length: number | readonly [number, number], label: string): Buffer {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is malformed`);
	const out = Buffer.from(value, "base64url");
	const fits = Array.isArray(length)
		? out.byteLength >= length[0] && out.byteLength <= length[1]
		: out.byteLength === length;
	if (!fits || base64(out) !== value) throw new Error(`${label} is malformed`);
	return out;
}

/** Whether `site` is a host a value may be read on: lower case, no scheme, no port. */
export function captureSiteValid(site: unknown): site is string {
	return typeof site === "string" && site.length <= 253 && HOST.test(site);
}

function identity(value: EventHookCaptureIdentity): EventHookCaptureIdentity {
	if (
		!isUuid(value.companyId) ||
		!isUuid(value.companyComputerId) ||
		!isUuid(value.receiptId) ||
		!isUuid(value.hookId) ||
		!Number.isSafeInteger(value.computerGeneration) ||
		value.computerGeneration < 1 ||
		value.field !== "signing_secret"
	)
		throw new Error("Hook capture identity is malformed");
	return {
		companyId: value.companyId,
		companyComputerId: value.companyComputerId,
		computerGeneration: value.computerGeneration,
		receiptId: value.receiptId,
		hookId: value.hookId,
		field: value.field,
	};
}

function publicKey(raw: Buffer): KeyObject {
	return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
}

function boxKey(privateKey: KeyObject, peer: KeyObject, ephemeral: Buffer, recipient: Buffer, info: string): Buffer {
	// X25519 refuses a low-order peer key (an all-zero secret) with an error.
	const shared = diffieHellman({ privateKey, publicKey: peer });
	try {
		return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, recipient]), info, 32));
	} finally {
		shared.fill(0);
	}
}

/**
 * The office's side of any capture box: `payload` (its schema added first) sealed to `recipientPublicKey` under
 * `associatedData`, which names the call. The caller checked the payload and the identity.
 */
export function sealCaptureBox(
	kind: CaptureBoxKind,
	payload: Readonly<Record<string, string | number>>,
	recipientPublicKey: string,
	associatedData: Buffer,
): Record<string, string> {
	const recipient = decoded(recipientPublicKey, 32, `${kind.label} key`);
	const pair = generateKeyPairSync("x25519");
	const ephemeral = Buffer.from(
		pair.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_X25519.byteLength),
	);
	const key = boxKey(pair.privateKey, publicKey(recipient), ephemeral, recipient, kind.info);
	const iv = randomBytes(12);
	const plaintext = Buffer.from(JSON.stringify({ schema: kind.payload, ...payload }), "utf8");
	try {
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(associatedData);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return {
			schema: kind.box,
			ephemeralPublicKey: base64(ephemeral),
			iv: base64(iv),
			tag: base64(cipher.getAuthTag()),
			ciphertext: base64(ciphertext),
		};
	} finally {
		key.fill(0);
		plaintext.fill(0);
	}
}

/**
 * The vault's side of any capture box: the payload of a box of this kind sealed to this key pair under exactly
 * `associatedData`, with its schema checked, its `site` a host and its `capturedAtMs` within the box's lifetime;
 * or an error ("<label> box is malformed", "<label> box does not open here", "<label> is malformed", "<label>
 * expired"). `parse` checks the rest of the payload (its keys included) and keeps what the caller needs, as long as
 * the returned buffer `value` lives: the caller zeroes it.
 */
export function openCaptureBox<T>(
	kind: CaptureBoxKind,
	privateKey: KeyObject,
	recipientPublicKey: string,
	box: unknown,
	associatedData: Buffer,
	parse: (payload: Record<string, unknown>) => T,
	nowMs: number,
): { readonly value: Buffer; readonly site: string; readonly capturedAtMs: number; readonly parsed: T } {
	if (
		!box ||
		typeof box !== "object" ||
		Array.isArray(box) ||
		Object.keys(box).sort().join() !== "ciphertext,ephemeralPublicKey,iv,schema,tag"
	)
		throw new Error(`${kind.label} box is malformed`);
	const input = box as Record<string, unknown>;
	if (input.schema !== kind.box) throw new Error(`${kind.label} box is malformed`);
	const ephemeral = decoded(input.ephemeralPublicKey, 32, `${kind.label} box`);
	const iv = decoded(input.iv, 12, `${kind.label} box`);
	const tag = decoded(input.tag, 16, `${kind.label} box`);
	const ciphertext = decoded(input.ciphertext, [1, 4096], `${kind.label} box`);
	const recipient = decoded(recipientPublicKey, 32, `${kind.label} key`);
	let key: Buffer;
	try {
		key = boxKey(privateKey, publicKey(ephemeral), ephemeral, recipient, kind.info);
	} catch {
		throw new Error(`${kind.label} box does not open here`);
	}
	let plaintext: Buffer;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(associatedData);
		decipher.setAuthTag(tag);
		plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		throw new Error(`${kind.label} box does not open here`);
	} finally {
		key.fill(0);
	}
	let value: Buffer | undefined;
	try {
		const payload = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
		if (
			!payload ||
			typeof payload !== "object" ||
			Array.isArray(payload) ||
			payload.schema !== kind.payload ||
			typeof payload.value !== "string" ||
			!captureSiteValid(payload.site) ||
			!Number.isSafeInteger(payload.capturedAtMs)
		)
			throw new Error(`${kind.label} is malformed`);
		const parsed = parse(payload);
		// Read too long ago, or dated further ahead than the clocks drift: never stored.
		const capturedAtMs = payload.capturedAtMs as number;
		if (capturedAtMs < nowMs - EVENT_HOOK_CAPTURE_LIFETIME_MS || capturedAtMs > nowMs + CLOCK_SKEW_MS)
			throw new Error(`${kind.label} expired`);
		value = Buffer.from(payload.value, "utf8");
		return { value, site: payload.site as string, capturedAtMs, parsed };
	} catch (error) {
		value?.fill(0);
		if (error instanceof Error && error.message === `${kind.label} expired`) throw error;
		throw new Error(`${kind.label} is malformed`);
	} finally {
		plaintext.fill(0);
	}
}

/** The office's side: the value read off the hook's site, sealed to the hook's capture key for one tool call. */
export function sealEventHookCapture(
	capture: { readonly value: string; readonly site: string },
	recipientPublicKey: string,
	expected: EventHookCaptureIdentity,
	nowMs = Date.now(),
): Record<string, string> {
	const checked = identity(expected);
	if (typeof capture.value !== "string" || !EVENT_HOOK_CAPTURE_SECRET.test(capture.value))
		throw new Error("Hook capture value is malformed");
	if (!captureSiteValid(capture.site)) throw new Error("Hook capture site is malformed");
	return sealCaptureBox(
		HOOK_KIND,
		{ field: checked.field, value: capture.value, site: capture.site, capturedAtMs: nowMs },
		recipientPublicKey,
		Buffer.from(JSON.stringify({ schema: HOOK_KIND.box, ...checked }), "utf8"),
	);
}

/** The vault's side: the capture inside a box sealed to this key pair for exactly this identity, given to the
 * callback and zeroed after it; or an error. The keyring holds the private half (CloudSecretKeyring). */
export async function openEventHookCapture<T>(
	privateKey: KeyObject,
	recipientPublicKey: string,
	box: unknown,
	expected: EventHookCaptureIdentity,
	callback: (capture: EventHookCapture) => Promise<T>,
	nowMs = Date.now(),
): Promise<T> {
	const associatedData = Buffer.from(JSON.stringify({ schema: HOOK_KIND.box, ...identity(expected) }), "utf8");
	const { value, site, capturedAtMs } = openCaptureBox(
		HOOK_KIND,
		privateKey,
		recipientPublicKey,
		box,
		associatedData,
		(payload) => {
			if (
				Object.keys(payload).sort().join() !== "capturedAtMs,field,schema,site,value" ||
				payload.field !== expected.field ||
				!EVENT_HOOK_CAPTURE_SECRET.test(payload.value as string)
			)
				throw new Error("Hook capture is malformed");
		},
		nowMs,
	);
	try {
		return await callback({ field: expected.field, value, site, capturedAtMs });
	} finally {
		value.fill(0);
	}
}
