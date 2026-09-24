import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { JsonValue } from "@qorpera/contracts";

/**
 * Shared transport for the compiled connector adapters. Every provider request
 * is pinned to one HTTPS origin, never follows redirects, is bounded in time
 * and size, and reduces the provider's answer to either parsed JSON or text.
 * Expected provider refusals become a closed failure result the model can act
 * on; transport faults throw and the broker reports them generically.
 */

export const CONNECTOR_REQUEST_DEADLINE_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ConnectorFailureReason =
	| "not_found"
	| "forbidden"
	| "authorization_required"
	| "rate_limited"
	| "invalid_request"
	| "provider_error"
	| "unsupported_content"
	| "result_too_large";

/* Type aliases, not interfaces: only aliases satisfy JsonValue's index signature. */
export type ConnectorFailure = {
	schema: "qorpera.connector-result/v1";
	status: "failed";
	reason: ConnectorFailureReason;
	detail: string;
};

export type ConnectorSuccess = {
	schema: "qorpera.connector-result/v1";
	status: "completed";
	result: JsonValue;
};

export type ConnectorResult = ConnectorFailure | ConnectorSuccess;

export function connectorFailure(reason: ConnectorFailureReason, detail: string): ConnectorFailure {
	return { schema: "qorpera.connector-result/v1", status: "failed", reason, detail: clipText(detail, 240).text };
}

export function connectorSuccess(result: JsonValue): ConnectorSuccess {
	return { schema: "qorpera.connector-result/v1", status: "completed", result };
}

/** Thrown by adapters for an expected provider outcome; the adapter's outer
 * layer turns it into a closed failure result. */
export class ConnectorRequestError extends Error {
	readonly reason: ConnectorFailureReason;
	constructor(reason: ConnectorFailureReason, detail: string) {
		super(detail);
		this.name = "ConnectorRequestError";
		this.reason = reason;
	}
}

/** The broker refuses a connector result whose JSON exceeds 32 KiB
 * (`cloudToolJsonText(result, 32 * 1024)`). Adapters budget their text in
 * bytes under this bound, and the adapter layer turns anything still larger
 * into a closed `result_too_large` failure instead of an opaque error. */
export const CONNECTOR_RESULT_MAX_BYTES = 30 * 1024;

/** UTF-8 bytes a string occupies inside a JSON document, quotes excluded. */
export function jsonTextBytes(value: string): number {
	return Buffer.byteLength(JSON.stringify(value)) - 2;
}

/** UTF-8 bytes of a whole JSON value as the broker serializes it. */
export function jsonValueBytes(value: JsonValue): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/** Clips at a code point boundary to at most `maximumCharacters` characters
 * and, when given, at most `maximumBytes` JSON bytes (escapes and multi-byte
 * characters counted), ellipsis included. */
export function clipText(
	value: string,
	maximumCharacters: number,
	maximumBytes = Number.POSITIVE_INFINITY,
): { text: string; truncated: boolean } {
	const fitsCharacters = value.length <= maximumCharacters || [...value].length <= maximumCharacters;
	if (fitsCharacters && jsonTextBytes(value) <= maximumBytes) return { text: value, truncated: false };
	const ellipsis = "…";
	const budget = maximumBytes - jsonTextBytes(ellipsis);
	let bytes = 0;
	let characters = 0;
	let end = 0;
	for (const character of value) {
		if (characters >= maximumCharacters) break;
		const size = jsonTextBytes(character);
		if (bytes + size > budget) break;
		bytes += size;
		characters += 1;
		end += character.length;
	}
	return { text: `${value.slice(0, end)}${ellipsis}`, truncated: true };
}

/** Keeps the leading items whose JSON fits in `maximumBytes`; the caller
 * reports how many were left out. */
export function fitItems(items: readonly JsonValue[], maximumBytes: number): { items: JsonValue[]; omitted: number } {
	const kept: JsonValue[] = [];
	let bytes = 2;
	for (const item of items) {
		const size = jsonValueBytes(item) + (kept.length > 0 ? 1 : 0);
		if (bytes + size > maximumBytes) break;
		bytes += size;
		kept.push(item);
	}
	return { items: kept, omitted: items.length - kept.length };
}

export interface ConnectorResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly bytes: Uint8Array;
}

export interface ConnectorRequestInput {
	readonly fetch: typeof fetch;
	readonly origin: string;
	readonly path: string;
	readonly query?: Readonly<Record<string, string | undefined>>;
	readonly method?: "GET" | "POST" | "PATCH";
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: Uint8Array | string;
	readonly signal: AbortSignal;
	readonly maximumBytes?: number;
	readonly deadlineMs?: number;
	/** Response headers the adapter needs, lowercase. Everything else is dropped
	 * before the response leaves this function. */
	readonly keepHeaders?: readonly string[];
}

/** Performs one pinned request. `path` must start with `/` and may not carry
 * its own query string; `query` is encoded here. Redirects are refused. */
export async function connectorRequest(input: ConnectorRequestInput): Promise<ConnectorResponse> {
	if (!input.path.startsWith("/") || input.path.includes("?") || input.path.includes("#") || /[\s]/.test(input.path))
		throw new Error("Connector request path is invalid");
	const url = new URL(input.origin);
	if (url.origin !== input.origin || url.protocol !== "https:") throw new Error("Connector request origin is invalid");
	url.pathname = input.path;
	for (const [key, value] of Object.entries(input.query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	if (url.origin !== input.origin) throw new Error("Connector request escaped its origin");
	const body = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
	return withCloudDeadline(
		async (requestSignal) => {
			const response = await input.fetch(url, {
				method: input.method ?? "GET",
				redirect: "error",
				headers: { accept: "application/json", ...input.headers },
				...(body ? { body } : {}),
				signal: requestSignal,
			});
			const bytes = await readBoundedCloudResponse(
				response,
				input.maximumBytes ?? MAX_RESPONSE_BYTES,
				requestSignal,
			);
			const headers: Record<string, string> = {};
			for (const name of input.keepHeaders ?? []) {
				const value = response.headers.get(name);
				if (value !== null) headers[name] = value;
			}
			return { status: response.status, headers, bytes };
		},
		input.deadlineMs ?? CONNECTOR_REQUEST_DEADLINE_MS,
		input.signal,
	);
}

export function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function parseJsonResponse(response: ConnectorResponse): unknown {
	if (response.bytes.byteLength === 0) return null;
	try {
		return JSON.parse(decodeUtf8(response.bytes)) as unknown;
	} catch {
		throw new ConnectorRequestError("provider_error", "The service answered with something other than JSON.");
	}
}

export function jsonRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

export function jsonString(value: unknown, maximumCharacters = 4096): string | null {
	return typeof value === "string" ? clipText(value, maximumCharacters).text : null;
}

export function jsonInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function jsonBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

export function jsonArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Maps a provider status to a closed failure, using a short provider message
 * when one is present. Bodies are never echoed whole. */
export function providerRefusal(response: ConnectorResponse, service: string): ConnectorRequestError {
	let message = "";
	try {
		const parsed = jsonRecord(parseJsonResponse(response));
		const nested = jsonRecord(parsed.error);
		message = jsonString(parsed.message ?? nested.message ?? parsed.error_description, 200) ?? "";
	} catch {
		message = "";
	}
	const detail = message ? `${service}: ${message}` : `${service} answered ${response.status}.`;
	if (response.status === 401) return new ConnectorRequestError("authorization_required", detail);
	if (response.status === 403) {
		return new ConnectorRequestError(
			response.headers["x-ratelimit-remaining"] === "0" ? "rate_limited" : "forbidden",
			detail,
		);
	}
	if (response.status === 404 || response.status === 410) return new ConnectorRequestError("not_found", detail);
	if (response.status === 429) return new ConnectorRequestError("rate_limited", detail);
	if (response.status === 400 || response.status === 422 || response.status === 409)
		return new ConnectorRequestError("invalid_request", detail);
	return new ConnectorRequestError("provider_error", detail);
}

/** Wraps an adapter body so expected refusals become results and everything
 * else stays an error for the broker's generic failure path. */
export async function connectorOutcome(run: () => Promise<JsonValue>): Promise<JsonValue> {
	try {
		const outcome = connectorSuccess(await run());
		if (jsonValueBytes(outcome) > CONNECTOR_RESULT_MAX_BYTES)
			return connectorFailure(
				"result_too_large",
				"The result is too large to return. Ask for fewer items or a smaller part.",
			);
		return outcome;
	} catch (error) {
		if (error instanceof ConnectorRequestError) return connectorFailure(error.reason, error.message);
		throw error;
	}
}

export function encodeBase64Url(value: Uint8Array | string): string {
	return Buffer.from(value).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new ConnectorRequestError("provider_error", "Malformed content.");
	return Buffer.from(value, "base64url");
}

const ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/** A small, dependency-free reduction of HTML to readable text for email
 * bodies. It is not a sanitizer: the output is data the broker still fences. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
			if (entity[0] === "#") {
				const code =
					entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
				return Number.isSafeInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
			}
			return ENTITIES[entity.toLowerCase()] ?? match;
		})
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
