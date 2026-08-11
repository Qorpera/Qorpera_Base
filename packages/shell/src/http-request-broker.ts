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
 * Enforcement: destination allowlisting, reference-only secrets,
 * kernel-signed causal intents with per-intent request budgets,
 * replay-proof request ids, bounded sizes, no auto-followed redirects,
 * and full trail observation.
 *
 * Two body modes. Inline (default): bounded text request/response through
 * the pipe — for inspecting APIs. File (saveTo/sendFile): the kernel
 * streams the response into a validated company file (or a company file
 * out as the request body) and only metadata crosses the pipe — bounded
 * by disk, binary-safe, nothing through model context. The folder is
 * primary; large payloads belong in it, not in the conversation.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { KernelIntentCapability } from "@qorpera/pi-protocol";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INTENT_LIFETIME_MS = 4 * 60 * 60 * 1000;
const SECRET_REFERENCE = /secret:\/\/([a-z0-9][a-z0-9_-]{0,63})/gi;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const MAX_URL_BYTES = 8 * 1024;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** File transfers get a longer leash than inline API calls. */
const DEFAULT_FILE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FILE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_REQUESTS_PER_TURN = 64;
const DEFAULT_MAX_SAVE_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_PATH_BYTES = 1024;
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
	/** Company-relative path the response streamed into (file mode). */
	savedTo?: string;
	/** Company-relative path streamed out as the request body (file mode). */
	sentFile?: string;
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
	/** Stream the response body into this company-relative path (2xx only). */
	saveTo?: string;
	/** Stream this company-relative file out as the request body. */
	sendFile?: string;
	/** The kernel-signed causal intent this request rides on (parity with the model lane). */
	intent: KernelIntentCapability;
}

interface HttpIntentState {
	capability: KernelIntentCapability;
	requests: number;
	status: "active" | "ended";
	expiryTimer: NodeJS.Timeout;
}

export interface HttpRequestBroker {
	/** Register a kernel-issued intent so the child can spend requests against it. */
	authorizeIntent: (capability: KernelIntentCapability) => boolean;
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

function validIntentShape(value: unknown): value is KernelIntentCapability {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const intent = value as Record<string, unknown>;
	return (
		typeof intent.nonce === "string" &&
		REQUEST_ID_PATTERN.test(intent.nonce) &&
		typeof intent.sessionId === "string" &&
		typeof intent.requestHash === "string" &&
		typeof intent.attended === "boolean" &&
		typeof intent.issuedAt === "string" &&
		typeof intent.expiresAt === "string" &&
		typeof intent.signature === "string" &&
		!!intent.budget &&
		typeof intent.budget === "object"
	);
}

function parsedFrame(value: unknown): HttpRequestFrame | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const frame = value as Record<string, unknown>;
	const filePathValid = (value: unknown): boolean =>
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value, "utf-8") <= MAX_FILE_PATH_BYTES &&
		!value.toLowerCase().includes("secret://");
	const fileMode = frame.saveTo !== undefined || frame.sendFile !== undefined;
	const maxTimeout = fileMode ? MAX_FILE_TIMEOUT_MS : MAX_TIMEOUT_MS;
	if (
		!exactKeys(frame, [
			"type",
			"requestId",
			"method",
			"url",
			"headers",
			"body",
			"timeoutMs",
			"behavior",
			"saveTo",
			"sendFile",
			"intent",
		]) ||
		!validIntentShape(frame.intent) ||
		frame.type !== "qorpera_http_request" ||
		typeof frame.requestId !== "string" ||
		!REQUEST_ID_PATTERN.test(frame.requestId) ||
		typeof frame.method !== "string" ||
		!ALLOWED_METHODS.has(frame.method.toUpperCase()) ||
		typeof frame.url !== "string" ||
		Buffer.byteLength(frame.url, "utf-8") > MAX_URL_BYTES ||
		(frame.body !== undefined &&
			(typeof frame.body !== "string" || Buffer.byteLength(frame.body, "utf-8") > MAX_BODY_BYTES)) ||
		(frame.saveTo !== undefined && !filePathValid(frame.saveTo)) ||
		(frame.sendFile !== undefined && !filePathValid(frame.sendFile)) ||
		(frame.sendFile !== undefined && frame.body !== undefined) ||
		(frame.timeoutMs !== undefined &&
			(typeof frame.timeoutMs !== "number" || frame.timeoutMs < 1 || frame.timeoutMs > maxTimeout)) ||
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
				saveTo: frame.saveTo ?? null,
				sendFile: frame.sendFile ?? null,
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
	sessionId: string;
	allowedDestination: (url: URL) => boolean;
	resolveSecret: (name: string) => Promise<string>;
	/**
	 * File-mode path validation, supplied by the kernel: resolve a
	 * company-relative path to an absolute one, throwing on escape or
	 * kernel-protected territory. Write covers saveTo; read covers sendFile.
	 */
	companyFile: {
		resolveForWrite: (relativePath: string) => string;
		resolveForRead: (relativePath: string) => string;
	};
	observe?: (event: HttpRequestObservation) => void;
	fetchImpl?: typeof fetch;
	maxRequestsPerIntent?: number;
	maxSaveBytes?: number;
}): HttpRequestBroker {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxRequestsPerIntent = options.maxRequestsPerIntent ?? DEFAULT_MAX_REQUESTS_PER_TURN;
	const maxSaveBytes = options.maxSaveBytes ?? DEFAULT_MAX_SAVE_BYTES;
	const seenRequestIds = new Set<string>();
	const inFlight = new Map<string, AbortController>();
	const intents = new Map<string, HttpIntentState>();
	let released = false;

	const endIntent = (intent: HttpIntentState): void => {
		if (intent.status !== "active") return;
		intent.status = "ended";
		clearTimeout(intent.expiryTimer);
	};

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
		// The verified causal intent (parity with the model lane): the request
		// must ride an intent the kernel registered for this session, echoed
		// back byte-identical, unexpired, and within its request budget.
		const intent = intents.get(frame.intent.nonce);
		const now = Date.now();
		const expiresAt = Date.parse(frame.intent.expiresAt);
		if (
			!intent ||
			intent.status !== "active" ||
			JSON.stringify(intent.capability) !== JSON.stringify(frame.intent) ||
			frame.intent.sessionId !== options.sessionId ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= now
		) {
			deny("kernel http request denied: no verified causal intent for this turn");
			return;
		}
		const intentBudget = Math.min(
			maxRequestsPerIntent,
			Number.isInteger(intent.capability.budget.maxCalls) ? intent.capability.budget.maxCalls : maxRequestsPerIntent,
		);
		if (intent.requests >= intentBudget) {
			deny(`kernel http request denied: intent request budget (${intentBudget}) exhausted`);
			return;
		}
		intent.requests++;

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
		// File mode: the kernel validates paths against company territory —
		// escapes and kernel-protected paths are denied before any contact.
		let savePath: string | undefined;
		let sendPath: string | undefined;
		try {
			if (frame.saveTo !== undefined) savePath = options.companyFile.resolveForWrite(frame.saveTo);
			if (frame.sendFile !== undefined) sendPath = options.companyFile.resolveForRead(frame.sendFile);
		} catch (error) {
			deny(`kernel http request denied: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const controller = new AbortController();
		inFlight.set(frame.requestId, controller);
		const fileMode = savePath !== undefined || sendPath !== undefined;
		const timeoutMs = frame.timeoutMs ?? (fileMode ? DEFAULT_FILE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		options.observe?.({ ...observed, host: rawUrl.host, status: "started" });
		try {
			const requestBody =
				method === "GET" || method === "HEAD"
					? undefined
					: sendPath !== undefined
						? (Readable.toWeb(createReadStream(sendPath)) as unknown as NonNullable<RequestInit["body"]>)
						: frame.body !== undefined
							? substituteReferences(frame.body, resolved)
							: undefined;
			const response = await fetchImpl(resolvedUrl, {
				method,
				headers: Object.fromEntries(
					headerEntries.map(([name, headerValue]) => [name, substituteReferences(headerValue, resolved)]),
				),
				...(requestBody !== undefined ? { body: requestBody } : {}),
				...(sendPath !== undefined ? { duplex: "half" } : {}),
				redirect: "manual",
				signal: controller.signal,
			} as RequestInit);
			if (savePath !== undefined && response.status >= 200 && response.status < 300) {
				// Stream to disk through a metering hash — nothing buffers, and
				// only metadata crosses the pipe back to the child.
				const temporary = `${savePath}.part-${randomUUID()}`;
				const digest = createHash("sha256");
				let written = 0;
				try {
					mkdirSync(dirname(savePath), { recursive: true });
					const meter = new Transform({
						transform(chunk: Buffer, _encoding, callback) {
							written += chunk.length;
							digest.update(chunk);
							if (written > maxSaveBytes)
								callback(new Error(`response exceeds the ${maxSaveBytes} byte save limit`));
							else callback(null, chunk);
						},
					});
					const source = response.body
						? (Readable.fromWeb(response.body as never) as Readable)
						: Readable.from([]);
					await pipeline(source, meter, createWriteStream(temporary, { flags: "wx" }));
					renameSync(temporary, savePath);
				} catch (error) {
					rmSync(temporary, { force: true });
					throw error;
				}
				const sha256 = digest.digest("hex");
				options.observe?.({
					...observed,
					host: rawUrl.host,
					status: "completed",
					httpStatus: response.status,
					bodyBytes: written,
					savedTo: frame.saveTo,
					...(frame.sendFile ? { sentFile: frame.sendFile } : {}),
				});
				send({
					type: "qorpera_http_response",
					requestId: frame.requestId,
					status: response.status,
					headers: Object.fromEntries(response.headers.entries()),
					body: "",
					bodyBytes: written,
					savedTo: frame.saveTo,
					sha256,
				});
				return;
			}
			const raw = Buffer.from(await response.arrayBuffer());
			const bodyTruncated = raw.length > MAX_RESPONSE_BODY_BYTES;
			const body = raw.subarray(0, MAX_RESPONSE_BODY_BYTES).toString("utf-8");
			options.observe?.({
				...observed,
				host: rawUrl.host,
				status: "completed",
				httpStatus: response.status,
				bodyBytes: raw.length,
				...(frame.sendFile ? { sentFile: frame.sendFile } : {}),
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
		authorizeIntent: (capability) => {
			if (released || !validIntentShape(capability)) return false;
			const now = Date.now();
			const issuedAt = Date.parse(capability.issuedAt);
			const expiresAt = Date.parse(capability.expiresAt);
			if (
				capability.sessionId !== options.sessionId ||
				intents.has(capability.nonce) ||
				!Number.isFinite(issuedAt) ||
				!Number.isFinite(expiresAt) ||
				issuedAt > now + 5_000 ||
				expiresAt <= now ||
				expiresAt <= issuedAt ||
				expiresAt - issuedAt > MAX_INTENT_LIFETIME_MS
			)
				return false;
			const state: HttpIntentState = {
				capability: JSON.parse(JSON.stringify(capability)) as KernelIntentCapability,
				requests: 0,
				status: "active",
				expiryTimer: setTimeout(
					() => {
						const registered = intents.get(capability.nonce);
						if (registered) endIntent(registered);
					},
					Math.max(1, expiresAt - now),
				),
			};
			state.expiryTimer.unref?.();
			intents.set(capability.nonce, state);
			return true;
		},
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
			for (const intent of intents.values()) endIntent(intent);
			intents.clear();
		},
		release: () => {
			released = true;
			for (const intent of intents.values()) endIntent(intent);
			intents.clear();
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
