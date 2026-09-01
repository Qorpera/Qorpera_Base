import type { JsonValue } from "@qorpera/contracts";
import { assertConnectorDestination, type ConnectorCatalogEntry } from "./cloud-connector-catalog.ts";
import {
	CLOUD_CONNECTOR_RESULT_SCHEMA,
	CONNECTOR_MAX_DURATION_MS,
	CONNECTOR_MAX_RESULT_BYTES,
	type ConnectorAuthority,
	type ConnectorContinuationPort,
	type ConnectorCredentialVault,
	ConnectorFailure,
	type ConnectorInvocation,
	type ConnectorJsonObject,
	type ConnectorOutcome,
	type ConnectorReceiptContext,
	type ConnectorRunIdentity,
	connectorFailure,
	connectorJsonText,
	connectorUntilAborted,
} from "./cloud-connector-contract.ts";
import { connectorSourceInventory, parseIssuedConnectorContinuation } from "./cloud-connector-source.ts";

const JSON_CONTENT_TYPE = /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i;

interface CredentialRedactor {
	readonly exact: readonly string[];
	readonly percentEncodedPattern: string;
}

function cancelResponse(response: Response): void {
	void response.body?.cancel().catch(() => undefined);
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function percentHexPattern(byte: number): string {
	return byte
		.toString(16)
		.padStart(2, "0")
		.split("")
		.map((character) => (/[a-f]/.test(character) ? `[${character}${character.toUpperCase()}]` : character))
		.join("");
}

function credentialRedactor(bearer: string): CredentialRedactor {
	const bytes = Buffer.from(bearer);
	const base64 = bytes.toString("base64");
	const base64url = bytes.toString("base64url");
	const representations = [
		bearer,
		base64,
		base64.replace(/=+$/, ""),
		base64url,
		`${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`,
		bytes.toString("hex"),
		bytes.toString("hex").toUpperCase(),
	];
	const exact = [...new Set(representations.flatMap((value) => [value, encodeURIComponent(value)]))].sort(
		(left, right) => right.length - left.length,
	);
	const percentEncodedPattern = [...bytes]
		.map((byte) => `(?:${escapeRegularExpression(String.fromCharCode(byte))}|%${percentHexPattern(byte)})`)
		.join("");
	return { exact, percentEncodedPattern };
}

function redactText(value: string, redactor: CredentialRedactor): string {
	let text = value;
	for (const secret of redactor.exact) text = text.replaceAll(secret, "[REDACTED]");
	text = text.replace(new RegExp(redactor.percentEncodedPattern, "g"), "[REDACTED]");
	return text.replace(/github_pat_[a-z0-9_]+|gh[opusr]_[a-z0-9_]+/gi, "[REDACTED]");
}

function redact(value: JsonValue, redactor: CredentialRedactor): JsonValue {
	if (typeof value === "string") return redactText(value, redactor);
	if (Array.isArray(value)) return value.map((item) => redact(item, redactor));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [redactText(key, redactor), redact(item, redactor)]),
		);
	return value;
}

async function boundedBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null && (!/^\d{1,12}$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
		cancelResponse(response);
		throw new ConnectorFailure("response_too_large");
	}
	if (!response.body) throw new ConnectorFailure("invalid_response");
	const reader = response.body.getReader();
	const abort = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", abort, { once: true });
	let complete = false;
	try {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		while (true) {
			signal.throwIfAborted();
			const chunk = await connectorUntilAborted(() => reader.read(), signal);
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > maximumBytes) throw new ConnectorFailure("response_too_large");
			chunks.push(chunk.value);
		}
		signal.throwIfAborted();
		complete = true;
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} finally {
		signal.removeEventListener("abort", abort);
		if (!complete) abort();
		reader.releaseLock();
	}
}

async function boundedFailureBody(
	response: Response,
	maximumBytes: number,
	redactor: CredentialRedactor,
	signal: AbortSignal,
): Promise<JsonValue | null> {
	if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
		cancelResponse(response);
		return null;
	}
	const deadline = new AbortController();
	const combined = AbortSignal.any([signal, deadline.signal]);
	const timer = setTimeout(() => deadline.abort(), 1000);
	const limit = Math.min(maximumBytes, 16 * 1024);
	try {
		const body = await boundedBody(response, limit, combined);
		const parsed: unknown = JSON.parse(body);
		return redact(JSON.parse(connectorJsonText(parsed, limit)) as JsonValue, redactor);
	} catch {
		// Optional error detail must not erase a definitive HTTP rejection. Caller
		// cancellation still takes precedence over this shorter inspection deadline.
		signal.throwIfAborted();
		return null;
	} finally {
		clearTimeout(timer);
		deadline.abort();
	}
}

/**
 * Trusted cloud RPC implementation. It has no public HTTP tool and no local
 * execution path. The only credential consumer is the bounded request below.
 * fetchImpl is a trusted transport seam (loopback mapping in tests), not input
 * from an installed manifest, model, browser or member device.
 */
export async function executeCloudConnectorRpc<I extends ConnectorRunIdentity>(options: {
	entry: ConnectorCatalogEntry;
	invocation: ConnectorInvocation<I>;
	context: ConnectorReceiptContext<I>;
	authority: ConnectorAuthority<I>;
	vault: ConnectorCredentialVault<I>;
	continuations?: ConnectorContinuationPort;
	fetchImpl?: typeof fetch;
	onDispatch: () => void;
	/** Host-built candidate. Never release it before its credential check succeeds. */
	provenance: ConnectorJsonObject;
	onValidatedProvenance: () => void;
}): Promise<ConnectorOutcome> {
	const { entry, invocation, context, authority, vault } = options;
	const { request, operation } = invocation;
	const write = operation.access === "write";
	const stop = new AbortController();
	const deadline = new AbortController();
	const signal = AbortSignal.any([context.signal, stop.signal, deadline.signal]);
	const timer = setTimeout(() => deadline.abort(), Math.min(operation.timeoutMs, CONNECTOR_MAX_DURATION_MS));
	const receipt = { receiptId: context.receiptId, idempotencyKey: context.idempotencyKey };
	let open = true;
	let consumed = false;
	let dispatched = false;
	let received = false;
	let finished = false;
	let result: ConnectorOutcome | undefined;
	try {
		assertConnectorDestination(entry, operation, request);
		if (!invocation.account.credential) throw new ConnectorFailure("authentication_required");
		if (!invocation.account.grant) throw new ConnectorFailure("authorization_required");
		await connectorUntilAborted(
			() =>
				vault.withBearer(
					invocation,
					receipt,
					async (bearer) => {
						if (!open || consumed || signal.aborted) throw new ConnectorFailure("authority_denied");
						consumed = true;
						if (
							typeof bearer !== "string" ||
							bearer.length < 16 ||
							bearer.length > 4096 ||
							/[^A-Za-z0-9._~+/-]/.test(bearer)
						)
							throw new ConnectorFailure("authentication_expired");
						const redactor = credentialRedactor(bearer);
						// Check both provider input and all proposed result metadata while the
						// bearer remains inside its one-use vault callback. Rejected candidates
						// must never be merged back into failures, receipts or replay outcomes.
						const requestText = connectorJsonText(request);
						const provenanceText = connectorJsonText(options.provenance);
						if (
							redactText(requestText, redactor) !== requestText ||
							redactText(provenanceText, redactor) !== provenanceText
						)
							throw new ConnectorFailure("invalid_arguments");
						options.onValidatedProvenance();
						await connectorUntilAborted(
							() => authority.assertAuthorized(invocation, "dispatch", receipt, signal),
							signal,
						);
						signal.throwIfAborted();
						if (!open) throw new ConnectorFailure("authority_denied");
						// No asynchronous work between the last authority check and dispatch.
						dispatched = true;
						options.onDispatch();
						const pendingResponse = (options.fetchImpl ?? fetch)(request.url, {
							method: request.method,
							headers: { ...request.headers, authorization: `Bearer ${bearer}` },
							...(request.body === undefined ? {} : { body: request.body }),
							redirect: "manual",
							credentials: "omit",
							referrerPolicy: "no-referrer",
							signal,
						}).then((response) => {
							if (signal.aborted || !open) {
								cancelResponse(response);
								throw new ConnectorFailure("cancelled");
							}
							return response;
						});
						const response = await connectorUntilAborted(() => pendingResponse, signal);
						received = true;
						const headerBytes = [...response.headers].reduce(
							(sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value),
							0,
						);
						if (
							response.redirected ||
							(response.url !== "" && response.url !== request.url) ||
							headerBytes > 16 * 1024
						) {
							cancelResponse(response);
							throw new ConnectorFailure("invalid_response");
						}
						if (response.status !== request.successStatus) {
							result = entry.adapter.classifyFailure(response.status, response.headers, write, Date.now(), null);
							if (result.status === "provider_rejected") {
								const body = await boundedFailureBody(response, operation.maxResponseBytes, redactor, signal);
								if (body !== null)
									result = entry.adapter.classifyFailure(
										response.status,
										response.headers,
										write,
										Date.now(),
										body,
									);
							} else cancelResponse(response);
						} else {
							if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
								cancelResponse(response);
								throw new ConnectorFailure("invalid_response");
							}
							const body = await boundedBody(response, operation.maxResponseBytes, signal);
							let data: JsonValue;
							try {
								const parsed: unknown = JSON.parse(body);
								// Redact BEFORE projection or truncation, including escaped JSON strings.
								const safe = redact(
									JSON.parse(connectorJsonText(parsed, operation.maxResponseBytes)) as JsonValue,
									redactor,
								);
								const decoded = entry.adapter.decode(operation.id, safe, request, response.headers);
								if (decoded.kind === "data") data = redact(decoded.data, redactor);
								else {
									let continuation = null;
									const nextCursor = decoded.page.nextCursor;
									if (nextCursor !== undefined) {
										const continuationPort = options.continuations;
										const invocationContinuation = invocation.continuation;
										if (!invocationContinuation || !continuationPort)
											throw new ConnectorFailure("unavailable");
										const issued = parseIssuedConnectorContinuation(
											await connectorUntilAborted(
												() => continuationPort.issue(invocationContinuation.scope, nextCursor, signal),
												signal,
											),
											invocationContinuation.scope,
										);
										continuation = issued.handle;
									}
									const page = {
										resources: decoded.page.resources,
										complete: decoded.page.complete,
										truncated: decoded.page.truncated,
										reason: decoded.page.reason,
									};
									const inventory = connectorSourceInventory(invocation, page, continuation);
									const inventoryJson = JSON.parse(connectorJsonText(inventory)) as JsonValue;
									const redacted = redact(inventoryJson, redactor);
									if (connectorJsonText(redacted) !== connectorJsonText(inventoryJson))
										throw new ConnectorFailure("invalid_response");
									data = inventoryJson;
								}
								connectorJsonText(data, CONNECTOR_MAX_RESULT_BYTES);
							} catch (error) {
								// Invalid provider data is not a model argument or authority error.
								if (error instanceof ConnectorFailure)
									throw new ConnectorFailure(
										error.code === "invalid_arguments" ? "invalid_response" : error.code,
									);
								throw new ConnectorFailure("invalid_response");
							}
							result = {
								schema: CLOUD_CONNECTOR_RESULT_SCHEMA,
								status: "ok",
								effect: write ? "applied" : "none",
								retry: { kind: "never" },
								data,
							};
						}
						// Revocation withholds provider data; a possibly applied write keeps its receipt unfinished.
						await connectorUntilAborted(
							() => authority.assertAuthorized(invocation, "release", receipt, signal),
							signal,
						);
						signal.throwIfAborted();
						finished = true;
					},
					signal,
				),
			signal,
		);
		if (!consumed || !finished || !result) throw new ConnectorFailure("invalid_response");
		return result;
	} catch (error) {
		const code = deadline.signal.aborted
			? "timed_out"
			: context.signal.aborted
				? "cancelled"
				: error instanceof ConnectorFailure
					? error.code
					: !consumed
						? "unavailable"
						: dispatched && !received
							? "provider_unavailable"
							: "invalid_response";
		if (write && dispatched)
			return connectorFailure(code === "cancelled" || code === "timed_out" ? code : "uncertain", "uncertain");
		return connectorFailure(
			code,
			"none",
			code === "provider_unavailable" ? { kind: "after", delayMs: 1000 } : undefined,
		);
	} finally {
		open = false;
		clearTimeout(timer);
		stop.abort();
	}
}
