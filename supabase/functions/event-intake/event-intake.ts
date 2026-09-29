/* Event intake (build step W1a; contract section 19, 2026-09-29 amendment "events wake agents";
 * design deploy/first-node/RUNTIME-EVENT-INTAKE.md).
 *
 * POST /event-intake/<address>: one delivery to one of a company's hooks. The function holds no
 * company secret. It reads the body up to 1 MiB, keeps an allowed list of headers and hands the
 * delivery to the database's intake door, qorpera_receive_event, which decides the outcome:
 * accepted (202), duplicate (200), unknown (404), paused or not_ready (409), too_large (413) or
 * limited (429). A database failure answers 503, so the sender retries. Signatures of signed hooks
 * are checked later by the company's vault, never here. */

export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HEADER_VALUE = 2048;
const MAX_HEADERS_JSON = 8192;
const ADDRESS = /\/event-intake\/([A-Za-z0-9_-]{43})\/?$/;

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
	receive(address: string, contentType: string | null, headers: Record<string, string>, bodyBase64: string): Promise<Json>;
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
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

/** The body, or null when it is over the limit. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
	const declared = request.headers.get("content-length");
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null;
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
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
	limited: { status: 429, body: { error: "Too many deliveries to this hook" }, headers: { "retry-after": "60" } },
};

/** The Edge Function. */
export async function handleEventIntake(request: Request, store: IntakeStore): Promise<Response> {
	const address = ADDRESS.exec(new URL(request.url).pathname)?.[1];
	if (!address) return json({ error: "No hook has this address" }, 404);
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
	const headers = keptHeaders(request.headers);
	if (JSON.stringify(headers).length > MAX_HEADERS_JSON) return json({ error: "The headers are too large" }, 431);
	const body = await readBody(request, MAX_BODY_BYTES);
	if (!body) return json({ error: "The body is over 1 MiB" }, 413);
	const contentType = headers["content-type"];
	let result: Json;
	try {
		result = await store.receive(
			address,
			contentType && contentType.length <= 256 ? contentType : null,
			headers,
			base64(body),
		);
	} catch (error) {
		if (error instanceof IntakeStoreError && error.code === "22023")
			return json({ error: "The delivery is malformed" }, 400);
		console.error(`event-intake: ${error instanceof Error ? error.message : String(error)}`);
		return json({ error: "Events are unavailable right now" }, 503);
	}
	const outcome = OUTCOMES[typeof result.outcome === "string" ? result.outcome : ""];
	if (!outcome) {
		console.error(`event-intake: unexpected outcome ${JSON.stringify(result.outcome)}`);
		return json({ error: "Events are unavailable right now" }, 503);
	}
	return json(outcome.body, outcome.status, outcome.headers);
}
