import type { KeyObject } from "node:crypto";
import { isUuid } from "@qorpera/contracts";
import {
	type CaptureBoxKind,
	captureSiteValid,
	openCaptureBox,
	sealCaptureBox,
} from "./cloud-event-hook-capture-box.ts";

/* A coding value on its way from one Company Computer into the vault (20260930695000): the environment variable an
 * agent's coding sessions get (an npm token, a Stripe key), made by the agent on the service's own website and read
 * off that page by the office, which seals it to the value's capture key. The vault derives the private half from the
 * company's key and never stores it; the native host only carries the box. It is E3c's box
 * (cloud-event-hook-capture-box.ts) under its own schemas and HKDF info, bound to the computer, its boot generation,
 * the one tool call (effect receipt), the service and the variable's name, so it never opens as a hook's box or the
 * other way round. */

const KIND: CaptureBoxKind = {
	box: "qorpera.coding-value-capture-box/v1",
	payload: "qorpera.coding-value-capture/v1",
	info: "qorpera.coding-value-capture/v1",
	label: "Coding value capture",
};
/** A service's name, as qorpera_coding_value_services keeps it. */
const SERVICE = /^[a-z][a-z0-9-]{0,31}$/;
/** A coding value's name: its environment variable's in lower case (20260928549440). */
const VARIABLE = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * Any coding value, whatever its service: visible ASCII with no space, at least 8 bytes (the shortest value the vault
 * hands a coding session, CODING_ENVIRONMENT_VALUE_MINIMUM_BYTES, so it can be masked in the session's output), at most
 * 1024. Each service's own pattern is checked beside it.
 */
const VALUE = /^[\x21-\x7e]{8,1024}$/;
/**
 * A service's whole-value pattern as the database keeps it (POSIX, `^…$`), when it means the same in JavaScript: only
 * letters, digits, `_` and `-`, bracket expressions of them (with ranges), groups, alternation and the quantifiers
 * `{m}`, `{m,n}`, `?`, `*` and `+`. No escape, dot, class name or anchor inside, where the two dialects differ.
 */
const PORTABLE_PATTERN = /^\^(?:[A-Za-z0-9_()|-]|\[[A-Za-z0-9_-]+\]|\{[0-9]{1,3}(?:,[0-9]{1,3})?\}|[?*+])+\$$/;

/** Who sealed the box: one computer's boot, for one tool call, with one service's value of one name. */
export interface CodingValueCaptureIdentity {
	readonly companyId: string;
	readonly companyComputerId: string;
	readonly computerGeneration: number;
	readonly receiptId: string;
	readonly service: string;
	readonly variable: string;
}

export interface CodingValueCapture {
	/** The value's bytes (UTF-8). The opener's callback has them; they are zeroed after it. */
	readonly value: Buffer;
	/** The page's host the value was read on. */
	readonly site: string;
	readonly capturedAtMs: number;
}

/** A service's pattern, its anchors taken off and put back as `outline` puts them, compiled; or an error. */
function compiled(source: unknown, outline: (body: string) => string, flags: string): RegExp {
	if (typeof source !== "string" || source.length > 512 || !PORTABLE_PATTERN.test(source))
		throw new Error("Coding value pattern is malformed");
	try {
		return new RegExp(outline(source.slice(1, -1)), flags);
	} catch {
		throw new Error("Coding value pattern is malformed");
	}
}

/**
 * A service's whole-value pattern (qorpera_coding_value_services.value_pattern) as a JavaScript expression that
 * matches what PostgreSQL's does, or an error: a pattern outside the portable subset is never guessed at. The whole
 * value must match all of it (`^(?:…)$`), also where the pattern alternates at its top level.
 */
export function codingValuePattern(source: unknown): RegExp {
	return compiled(source, (body) => `^(?:${body})$`, "u");
}

/**
 * Where a page's text shows a service's value: each match of the pattern that does not continue a word on its left
 * (`desk_test_…` is no Stripe key). Global: the caller checks what follows each match.
 */
export function codingValueFinder(source: unknown): RegExp {
	return compiled(source, (body) => `(?<![A-Za-z0-9_])(?:${body})`, "gu");
}

/** Whether `value` is a whole value of the service: the shape every coding value has, and the service's pattern. */
export function codingValueMatches(value: string, pattern: RegExp): boolean {
	return VALUE.test(value) && pattern.test(value);
}

function identity(value: CodingValueCaptureIdentity): CodingValueCaptureIdentity {
	if (
		!isUuid(value.companyId) ||
		!isUuid(value.companyComputerId) ||
		!isUuid(value.receiptId) ||
		!Number.isSafeInteger(value.computerGeneration) ||
		value.computerGeneration < 1 ||
		typeof value.service !== "string" ||
		!SERVICE.test(value.service) ||
		typeof value.variable !== "string" ||
		!VARIABLE.test(value.variable)
	)
		throw new Error("Coding value capture identity is malformed");
	return {
		companyId: value.companyId,
		companyComputerId: value.companyComputerId,
		computerGeneration: value.computerGeneration,
		receiptId: value.receiptId,
		service: value.service,
		variable: value.variable,
	};
}

function associatedData(value: CodingValueCaptureIdentity): Buffer {
	return Buffer.from(JSON.stringify({ schema: KIND.box, ...identity(value) }), "utf8");
}

/** The office's side: the value read off the service's site, whole by the service's pattern, sealed to the value's
 * capture key for one tool call. */
export function sealCodingValueCapture(
	capture: { readonly value: string; readonly site: string },
	pattern: RegExp,
	recipientPublicKey: string,
	expected: CodingValueCaptureIdentity,
	nowMs = Date.now(),
): Record<string, string> {
	const ad = associatedData(expected);
	if (typeof capture.value !== "string" || !codingValueMatches(capture.value, pattern))
		throw new Error("Coding value capture value is malformed");
	if (!captureSiteValid(capture.site)) throw new Error("Coding value capture site is malformed");
	return sealCaptureBox(
		KIND,
		{
			service: expected.service,
			variable: expected.variable,
			value: capture.value,
			site: capture.site,
			capturedAtMs: nowMs,
		},
		recipientPublicKey,
		ad,
	);
}

/** The vault's side: the value inside a box sealed to this key pair for exactly this identity, given to the callback
 * and zeroed after it; or an error. Its shape is checked here; the service's pattern, by the caller. */
export async function openCodingValueCapture<T>(
	privateKey: KeyObject,
	recipientPublicKey: string,
	box: unknown,
	expected: CodingValueCaptureIdentity,
	callback: (capture: CodingValueCapture) => Promise<T>,
	nowMs = Date.now(),
): Promise<T> {
	const { value, site, capturedAtMs } = openCaptureBox(
		KIND,
		privateKey,
		recipientPublicKey,
		box,
		associatedData(expected),
		(payload) => {
			if (
				Object.keys(payload).sort().join() !== "capturedAtMs,schema,service,site,value,variable" ||
				payload.service !== expected.service ||
				payload.variable !== expected.variable ||
				!VALUE.test(payload.value as string)
			)
				throw new Error("Coding value capture is malformed");
		},
		nowMs,
	);
	try {
		return await callback({ value, site, capturedAtMs });
	} finally {
		value.fill(0);
	}
}
