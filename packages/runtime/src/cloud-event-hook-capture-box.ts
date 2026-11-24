import type { KeyObject } from "node:crypto";
import { isUuid } from "@qorpera/contracts";
import { BOX_CLOCK_SKEW_MS, isValidBoxHost, openX25519Box, sealX25519Box } from "./cloud-x25519-box.ts";

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
	/** A kind read off no page (a machine's clipboard, 20260930705000): its payload has no `site`. */
	readonly siteless?: true;
}

const HOOK_KIND: CaptureBoxKind = {
	box: "qorpera.event-hook-capture-box/v1",
	payload: "qorpera.event-hook-capture/v1",
	info: "qorpera.event-hook-capture/v1",
	label: "Hook capture",
};
/** A Stripe signing secret, as the office reads it; the length is checked until a live run confirms Stripe's. */
export const EVENT_HOOK_CAPTURE_SECRET = /^whsec_[A-Za-z0-9+/=]{16,200}$/;
/** A captured value is stored within this long after it was read, or never (a hook's and a coding value's). */
export const EVENT_HOOK_CAPTURE_LIFETIME_MS = 90_000;

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

/** Whether `site` is a host a value may be read on: lower case, no scheme, no port. */
export function captureSiteValid(site: unknown): site is string {
	return isValidBoxHost(site);
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
	return sealX25519Box({
		boxSchema: kind.box,
		info: kind.info,
		keyLabel: `${kind.label} key`,
		recipientPublicKey,
		associatedData,
		plaintext: Buffer.from(JSON.stringify({ schema: kind.payload, ...payload }), "utf8"),
	});
}

/**
 * The vault's side of any capture box: the payload of a box of this kind sealed to this key pair under exactly
 * `associatedData`, with its schema checked, its `site` a host (none for a siteless kind) and its `capturedAtMs` within
 * the box's lifetime;
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
): { readonly value: Buffer; readonly site: string | undefined; readonly capturedAtMs: number; readonly parsed: T } {
	const plaintext = openX25519Box({
		boxSchema: kind.box,
		info: kind.info,
		boxLabel: `${kind.label} box`,
		keyLabel: `${kind.label} key`,
		privateKey,
		recipientPublicKey,
		box,
		associatedData,
	});
	let value: Buffer | undefined;
	try {
		const payload = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
		if (
			!payload ||
			typeof payload !== "object" ||
			Array.isArray(payload) ||
			payload.schema !== kind.payload ||
			typeof payload.value !== "string" ||
			(kind.siteless ? Object.hasOwn(payload, "site") : !captureSiteValid(payload.site)) ||
			!Number.isSafeInteger(payload.capturedAtMs)
		)
			throw new Error(`${kind.label} is malformed`);
		const parsed = parse(payload);
		// Read too long ago, or dated further ahead than the clocks drift: never stored.
		const capturedAtMs = payload.capturedAtMs as number;
		if (capturedAtMs < nowMs - EVENT_HOOK_CAPTURE_LIFETIME_MS || capturedAtMs > nowMs + BOX_CLOCK_SKEW_MS)
			throw new Error(`${kind.label} expired`);
		value = Buffer.from(payload.value, "utf8");
		return { value, site: kind.siteless ? undefined : (payload.site as string), capturedAtMs, parsed };
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
		// A hook's kind has a site: the opener checked it.
		return await callback({ field: expected.field, value, site: site as string, capturedAtMs });
	} finally {
		value.fill(0);
	}
}
