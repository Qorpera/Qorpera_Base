/**
 * Kernel side of the generic outbound HTTP lane (Build 3).
 *
 * The trusted boundary of manifesto §7.1/§8: the sandboxed child submits
 * requests carrying opaque `secret://<name>` references; this broker
 * checks the destination against founder-bound network capabilities,
 * dereferences the references kernel-side, executes the request, and
 * returns one response frame. What gets recorded (via `observe`) is the
 * UNRESOLVED request identity — destination, method, reference-bearing
 * URL, request hash, acting behavior, outcome — never a raw secret value
 * and never provider ontology.
 *
 * Deliberately coarser than the model lane (no kernel-signed per-request
 * intents yet): enforcement is destination allowlisting, reference-only
 * secrets, per-turn request budget, replay-proof request ids, bounded
 * sizes, no auto-followed redirects, and full trail observation. The
 * intent refinement is recorded as a stated gap in docs/sandbox.md.
 */

import { createHash } from "node:crypto";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_REFERENCE = /secret:\/\/([a-z0-9][a-z0-9_-]{0,63})/gi;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const MAX_URL_BYTES = 8 * 1024;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUESTS_PER_TURN = 64;
/** Hop-by-hop or kernel-owned headers the child may not set. */
const STRIPPED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "cookie2"]);

export interface HttpRequestObservation {
	requestId: string;
	method: string;
	host: string;
	/** The URL exactly as the child sent it — secret references unresolved. */
	url: string;
	requestSha256: string;
	behavior?: { path: string; contentHash: string };
	status: "started" | "completed" | "failed" | "denied";
	deniedReason?: string;
	httpStatus?: number;
	bodyBytes?: number;
}

interface HttpRequestFrame {
	type: "qorpera_http_request";
	requestId: string;
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
	behavior?: { path: string; contentHash: string };
}

export interface HttpRequestBroker {
	/** Returns true when the frame belonged to this lane (handled or denied). */
	handleFrame: (value: unknown, send: (frame: object) => void) => boolean;
	endTurn: () => void;
	release: () => void;
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function validBehavior(value: unknown): value is { path: string; contentHash: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		exactKeys(value, ["path", "contentHash"]) &&
		typeof (value as { path: unknown }).path === "string" &&
		typeof (value as { contentHash: unknown }).contentHash === "string" &&
		/^[a-f0-9]{64}$/.test((value as { contentHash: string }).contentHash)
	);
}

function parsedFrame(value: unknown): HttpRequestFrame | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const frame = value as Record<string, unknown>;
	if (
		!exactKeys(frame, ["type", "requestId", "method", "url", "headers", "body", "timeoutMs", "behavior"]) ||
		frame.type !== "qorpera_http_request" ||
		typeof frame.requestId !== "string" ||
		!REQUEST_ID_PATTERN.test(frame.requestId) ||
		typeof frame.method !== "string" ||
		!ALLOWED_METHODS.has(frame.method.toUpperCase()) ||
		typeof frame.url !== "string" ||
		Buffer.byteLength(frame.url, "utf-8") > MAX_URL_BYTES ||
		(frame.body !== undefined &&
			(typeof frame.body !== "string" || Buffer.byteLength(frame.body, "utf-8") > MAX_BODY_BYTES)) ||
		(frame.timeoutMs !== undefined &&
			(typeof frame.timeoutMs !== "number" || frame.timeoutMs < 1 || frame.timeoutMs > MAX_TIMEOUT_MS)) ||
		(frame.behavior !== undefined && !validBehavior(frame.behavior))
	)
		return undefined;
	if (frame.headers !== undefined) {
		if (!frame.headers || typeof frame.headers !== "object" || Array.isArray(frame.headers)) return undefined;
		const entries = Object.entries(frame.headers as Record<string, unknown>);
		if (!entries.every(([name, headerValue]) => name && typeof headerValue === "string")) return undefined;
		const bytes = entries.reduce(
			(total, [name, headerValue]) => total + Buffer.byteLength(`${name}: ${headerValue}\n`, "utf-8"),
			0,
		);
		if (bytes > MAX_HEADER_BYTES) return undefined;
	}
	return frame as unknown as HttpRequestFrame;
}

function frameDigest(frame: HttpRequestFrame): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				method: frame.method,
				url: frame.url,
				headers: frame.headers ?? {},
				body: frame.body ?? "",
				behavior: frame.behavior ?? null,
			}),
		)
		.digest("hex");
}

function secretReferenceNames(...texts: Array<string | undefined>): string[] {
	const names = new Set<string>();
	for (const text of texts) {
		if (!text) continue;
		for (const match of text.matchAll(SECRET_REFERENCE)) names.add(match[1]);
	}
	return [...names];
}

function substituteReferences(text: string, resolved: Map<string, string>): string {
	return text.replace(SECRET_REFERENCE, (reference, name: string) => resolved.get(name) ?? reference);
}

export function createHttpRequestBroker(options: {
	allowedDestination: (url: URL) => boolean;
	resolveSecret: (name: string) => Promise<string>;
	observe?: (event: HttpRequestObservation) => void;
	fetchImpl?: typeof fetch;
	maxRequestsPerTurn?: number;
}): HttpRequestBroker {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxRequestsPerTurn = options.maxRequestsPerTurn ?? DEFAULT_MAX_REQUESTS_PER_TURN;
	const seenRequestIds = new Set<string>();
	const inFlight = new Map<string, AbortController>();
	let turnRequests = 0;
	let released = false;

	const execute = async (frame: HttpRequestFrame, send: (frame: object) => void): Promise<void> => {
		const method = frame.method.toUpperCase();
		let rawUrl: URL;
		const observed = {
			requestId: frame.requestId,
			method,
			url: frame.url,
			requestSha256: frameDigest(frame),
			...(frame.behavior ? { behavior: frame.behavior } : {}),
		};
		const deny = (reason: string): void => {
			options.observe?.({ ...observed, host: safeHost(frame.url), status: "denied", deniedReason: reason });
			send({ type: "qorpera_http_response", requestId: frame.requestId, error: reason });
		};
		try {
			rawUrl = new URL(frame.url);
		} catch {
			deny("kernel http request denied: invalid URL");
			return;
		}
		// The destination is judged on the URL as sent: secret references may
		// appear only in the path, query, headers, and body — never the host.
		if (`${rawUrl.protocol}//${rawUrl.host}`.toLowerCase().includes("secret://")) {
			deny("kernel http request denied: secret references are not allowed in the destination");
			return;
		}
		if (!options.allowedDestination(rawUrl)) {
			deny(
				`kernel http request denied: ${rawUrl.host} is not a bound network destination for this company (the founder binds destinations with 'qorpera company destination add <host>')`,
			);
			return;
		}
		if (seenRequestIds.has(frame.requestId)) {
			deny("kernel http request denied: replayed request id");
			return;
		}
		seenRequestIds.add(frame.requestId);
		if (turnRequests >= maxRequestsPerTurn) {
			deny(`kernel http request denied: per-turn request budget (${maxRequestsPerTurn}) exhausted`);
			return;
		}
		turnRequests++;

		const headerEntries = Object.entries(frame.headers ?? {}).filter(
			([name]) => !STRIPPED_HEADERS.has(name.toLowerCase()),
		);
		const referenceNames = secretReferenceNames(
			frame.url,
			frame.body,
			...headerEntries.map(([, headerValue]) => headerValue),
		);
		const resolved = new Map<string, string>();
		for (const name of referenceNames) {
			try {
				resolved.set(name, await options.resolveSecret(name));
			} catch (error) {
				deny(`kernel http request denied: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		}
		const resolvedUrl = new URL(substituteReferences(frame.url, resolved));
		if (resolvedUrl.host !== rawUrl.host || resolvedUrl.protocol !== rawUrl.protocol) {
			deny("kernel http request denied: substitution changed the destination");
			return;
		}

		const controller = new AbortController();
		inFlight.set(frame.requestId, controller);
		const timer = setTimeout(() => controller.abort(), frame.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		options.observe?.({ ...observed, host: rawUrl.host, status: "started" });
		try {
			const response = await fetchImpl(resolvedUrl, {
				method,
				headers: Object.fromEntries(
					headerEntries.map(([name, headerValue]) => [name, substituteReferences(headerValue, resolved)]),
				),
				...(frame.body !== undefined && method !== "GET" && method !== "HEAD"
					? { body: substituteReferences(frame.body, resolved) }
					: {}),
				redirect: "manual",
				signal: controller.signal,
			});
			const raw = Buffer.from(await response.arrayBuffer());
			const bodyTruncated = raw.length > MAX_RESPONSE_BODY_BYTES;
			const body = raw.subarray(0, MAX_RESPONSE_BODY_BYTES).toString("utf-8");
			options.observe?.({
				...observed,
				host: rawUrl.host,
				status: "completed",
				httpStatus: response.status,
				bodyBytes: raw.length,
			});
			send({
				type: "qorpera_http_response",
				requestId: frame.requestId,
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
				body,
				bodyBytes: raw.length,
				...(bodyTruncated ? { bodyTruncated: true } : {}),
			});
		} catch (error) {
			options.observe?.({ ...observed, host: rawUrl.host, status: "failed" });
			send({
				type: "qorpera_http_response",
				requestId: frame.requestId,
				error: controller.signal.aborted
					? "kernel http request timed out or was aborted"
					: `kernel http request failed: ${error instanceof Error ? error.message : "network error"}`,
			});
		} finally {
			clearTimeout(timer);
			inFlight.delete(frame.requestId);
		}
	};

	return {
		handleFrame: (value, send) => {
			if (!value || typeof value !== "object") return false;
			if ((value as { type?: unknown }).type !== "qorpera_http_request") return false;
			if (released) return true;
			const frame = parsedFrame(value);
			if (!frame) {
				const requestId = (value as { requestId?: unknown }).requestId;
				if (typeof requestId === "string") {
					send({
						type: "qorpera_http_response",
						requestId,
						error: "kernel http request denied: invalid frame",
					});
				}
				return true;
			}
			void execute(frame, send);
			return true;
		},
		endTurn: () => {
			turnRequests = 0;
		},
		release: () => {
			released = true;
			for (const controller of inFlight.values()) controller.abort();
			inFlight.clear();
		},
	};
}

function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "(invalid)";
	}
}
