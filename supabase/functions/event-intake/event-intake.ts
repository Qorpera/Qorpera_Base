/* Event intake (build step W1a; contract section 19, 2026-09-29 amendment "events wake agents";
 * design deploy/first-node/RUNTIME-EVENT-INTAKE.md).
 *
 * POST /event-intake/<address>: one delivery to one of a company's hooks. The function holds no
 * company secret. It reads the body up to 256 KiB, keeps an allowed list of headers and hands the
 * delivery to the database's intake door, qorpera_receive_event, which decides the outcome:
 * accepted (202), duplicate (200), unknown (404), paused or not_ready (409), too_large (413),
 * limited (429, with Retry-After) or unavailable (503, the intake is switched off). The function
 * itself answers 404 for a path that is not a hook address (decided by its shape alone, whether or
 * not the intake is switched on), 405 for a method other than POST, 413 for a body over 256 KiB,
 * 431 for kept headers over 8000 bytes, 400 for input the database calls malformed and 503 when
 * the database cannot be reached, so the sender retries. Signatures of signed hooks are checked
 * later by the company's vault, never here. */

import { Buffer } from "node:buffer";
import { BodyTooLargeError, DEFAULT_BODY_READ_TIMEOUT_MS, readBoundedBytes } from "../_shared/http-guards.ts";

export const MAX_BODY_BYTES = 256 * 1024;
const MAX_HEADER_VALUE = 2048;
// The database stores headers as jsonb text (at most 8192 bytes), which adds a space after each
// colon and comma; 8000 bytes of compact JSON always fits.
const MAX_HEADERS_JSON_BYTES = 8000;
const ADDRESS = /\/event-intake\/([A-Za-z0-9_-]{43})\/?$/;
const UTF8_ENCODER = new TextEncoder();

/** The headers the intake keeps; the database refuses any other (qorpera_event_kept_headers). */
export const KEPT_HEADERS: readonly string[] = [
	"content-type",
	"user-agent",
	"stripe-signature",
	"x-hub-signature-256",
	"x-github-event",
	"x-github-delivery",
	"x-github-hook-id",
	"x-qorpera-signature",
	"x-qorpera-timestamp",
	"x-qorpera-delivery",
	"x-qorpera-event",
	"idempotency-key",
	"webhook-id",
	"webhook-timestamp",
	"webhook-signature",
	"svix-id",
	"svix-timestamp",
	"svix-signature",
];

type Json = Record<string, unknown>;

/** The database's intake door: qorpera_receive_event(address, content type, headers, body). */
export interface IntakeStore {
	receive(
		address: string,
		contentType: string | null,
		headers: Record<string, string>,
		bodyBase64: string,
		signal?: AbortSignal,
	): Promise<Json>;
}

/** A refusal or failure from the intake door; code is the Postgres SQLSTATE when there is one. */
export class IntakeStoreError extends Error {
	readonly code: string | undefined;
	constructor(code: string | undefined, message: string) {
		super(message);
		this.name = "IntakeStoreError";
		this.code = code;
	}
}

function json(body: Json, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
	});
}

export function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function isTimeoutOrAbortError(error: unknown): boolean {
	if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
	return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function readBody(
	request: Request,
	limit: number,
	timeoutMs = DEFAULT_BODY_READ_TIMEOUT_MS,
): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly status: 400 | 408 | 413 }> {
	try {
		const bytes = await readBoundedBytes(request, limit, {
			timeoutMs,
			signal: request.signal,
		});
		return { ok: true, bytes };
	} catch (error) {
		if (error instanceof BodyTooLargeError) return { ok: false, status: 413 };
		if (request.signal.aborted || isTimeoutOrAbortError(error)) return { ok: false, status: 408 };
		return { ok: false, status: 400 };
	}
}

/** The kept headers, lowercased, each at most 2048 characters (longer values are dropped). */
export function keptHeaders(headers: Headers): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const name of KEPT_HEADERS) {
		const value = headers.get(name);
		if (value !== null && value.length <= MAX_HEADER_VALUE) kept[name] = value;
	}
	return kept;
}

const OUTCOMES: Record<string, { status: number; body: Json; headers?: Record<string, string> }> = {
	accepted: { status: 202, body: { received: true } },
	duplicate: { status: 200, body: { received: true, duplicate: true } },
	unknown: { status: 404, body: { error: "No hook has this address" } },
	paused: { status: 409, body: { error: "This hook is paused" } },
	not_ready: { status: 409, body: { error: "This hook is not ready to receive" } },
	too_large: { status: 413, body: { error: "The body is over this hook's limit" } },
	limited: { status: 429, body: { error: "Too many deliveries to this hook" } },
	unavailable: { status: 503, body: { error: "Events are unavailable right now" }, headers: { "retry-after": "300" } },
};

/** The Edge Function. */
export async function handleEventIntake(request: Request, store: IntakeStore): Promise<Response> {
	const address = ADDRESS.exec(new URL(request.url).pathname)?.[1];
	if (!address) return json({ error: "This is not a hook address" }, 404);
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
	const headers = keptHeaders(request.headers);
	if (UTF8_ENCODER.encode(JSON.stringify(headers)).length > MAX_HEADERS_JSON_BYTES)
		return json({ error: "The headers are too large" }, 431);
	const read = await readBody(request, MAX_BODY_BYTES);
	if (!read.ok) {
		if (read.status === 413) return json({ error: "The body is over 256 KiB" }, 413);
		if (read.status === 408) return json({ error: "Request body timed out" }, 408);
		return json({ error: "The delivery could not be read" }, 400);
	}
	const body = read.bytes;
	const contentType = headers["content-type"];
	let result: Json;
	try {
		result = await store.receive(
			address,
			contentType && contentType.length <= 256 ? contentType : null,
			headers,
			base64(body),
			request.signal,
		);
	} catch (error) {
		if (error instanceof IntakeStoreError && error.code === "22023")
			return json({ error: "The delivery is malformed" }, 400);
		console.error(`event-intake: ${error instanceof Error ? error.message : String(error)}`);
		return json({ error: "Events are unavailable right now" }, 503);
	}
	const outcomeKey = typeof result.outcome === "string" ? result.outcome : "";
	// WHY: Guard OUTCOMES with Object.hasOwn so prototype keys like "toString" never match a response mapping.
	const outcome = Object.hasOwn(OUTCOMES, outcomeKey) ? OUTCOMES[outcomeKey] : undefined;
	if (!outcome) {
		console.error(`event-intake: unexpected outcome ${JSON.stringify(result.outcome)}`);
		return json({ error: "Events are unavailable right now" }, 503);
	}
	const retryAfter =
		typeof result.retryAfterSeconds === "number" && Number.isInteger(result.retryAfterSeconds)
			? { "retry-after": String(result.retryAfterSeconds) }
			: {};
	return json(outcome.body, outcome.status, { ...outcome.headers, ...retryAfter });
}
