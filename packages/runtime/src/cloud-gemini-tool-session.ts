import { createHash, randomUUID } from "node:crypto";
import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import type { JsonValue } from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import {
	CLOUD_ACTION_REVIEW_SPECIFICATION,
	CLOUD_ACTION_REVIEW_TOOL,
	CloudActionReviewBusy,
	type CloudActionReviewChannel,
} from "./cloud-action-review.ts";
import type {
	CloudCodexContextComposer,
	CloudCodexOpening,
	CloudCodexToolSessionResult,
} from "./cloud-codex-tool-session.ts";
import {
	classifyGeminiHttpError,
	GEMINI_PROVIDER_ERROR_CODES,
	GEMINI_PROVIDER_ERROR_DETAILS,
	type GeminiProviderErrorCode,
	type GeminiProviderErrorDetail,
	geminiNeonSpendMicrodollars,
	readGeminiErrorSnippet,
} from "./cloud-gemini-key-vault.ts";
import {
	CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
	type CloudNativeContextItem,
} from "./cloud-native-context-composition.ts";
import { tagNativeRuntimeFailure } from "./cloud-native-failure.ts";
import { CLOUD_NATIVE_RESULT_FENCE_SCHEMA, type CloudNativeFenceRequest } from "./cloud-native-result-fence.ts";
import {
	CLOUD_TOOL_RESULT_INSTRUCTIONS,
	type CloudNativeFencedResult,
	type CloudNativeResultInput,
	type CloudNativeToolBoundary,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import type {
	CloudRuntimeObservability,
	CloudRuntimeObservationSpan,
	CloudRuntimeOutcome,
} from "./cloud-runtime-observability.ts";
import type { CloudRuntimeGeminiEffort, CloudRuntimeGeminiModel } from "./cloud-runtime-policy.ts";

export const GEMINI_DEFAULT_API_BASE = "https://generativelanguage.googleapis.com";
export const GEMINI_ACTION_REVIEW_MODEL = "gemini-4-neon";

const MAX_GEMINI_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_GEMINI_REQUEST_MS = 5 * 60_000;
const GEMINI_COMPOSITION_RENEW_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MAX_GEMINI_RETRY_WAIT_MS = 15_000;
const CALL_ID = /^[A-Za-z0-9_:.-]{1,160}$/;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export {
	GEMINI_PROVIDER_ERROR_CODES,
	GEMINI_PROVIDER_ERROR_DETAILS,
	type GeminiProviderErrorCode,
	type GeminiProviderErrorDetail,
};

export class GeminiCapReachedError extends Error {
	readonly monthlyCapCents: number;
	readonly monthSpendMicrodollars: number;

	constructor(monthlyCapCents: number, monthSpendMicrodollars: number) {
		super("Your monthly Gemini API spend cap was reached. Raise the cap in Settings or switch models to continue.");
		this.name = "GeminiCapReachedError";
		this.monthlyCapCents = monthlyCapCents;
		this.monthSpendMicrodollars = monthSpendMicrodollars;
	}
}

export class GeminiKeyRevokedError extends Error {
	readonly httpStatus: number | null;
	readonly providerStatus: string | null;
	readonly detailCode: GeminiProviderErrorDetail | null;

	constructor(
		message = "Your Gemini API key is no longer valid or was removed.",
		httpStatus: number | null = null,
		providerStatus: string | null = null,
		detailCode: GeminiProviderErrorDetail | null = null,
	) {
		super(message);
		this.name = "GeminiKeyRevokedError";
		this.httpStatus = httpStatus;
		this.providerStatus = providerStatus;
		this.detailCode = detailCode;
	}
}

export class GeminiProviderError extends Error {
	readonly code: GeminiProviderErrorCode;
	readonly httpStatus: number | null;
	readonly providerStatus: string | null;
	readonly detailCode: GeminiProviderErrorDetail | null;

	constructor(
		code: GeminiProviderErrorCode,
		httpStatus: number | null,
		providerStatus: string | null,
		message: string,
		options?: ErrorOptions,
		detailCode: GeminiProviderErrorDetail | null = null,
	) {
		super(message, options);
		this.name = "GeminiProviderError";
		this.code = code;
		this.httpStatus = httpStatus;
		this.providerStatus = providerStatus;
		this.detailCode = detailCode;
	}
}

const GEMINI_FAILURE_CODES: Readonly<Record<GeminiProviderErrorCode, string>> = {
	key_rejected: "GEMINI_API:KEY_REJECTED",
	billing_required: "GEMINI_API:BILLING_REQUIRED",
	quota_exhausted: "GEMINI_API:QUOTA_EXHAUSTED",
	model_unavailable: "GEMINI_API:MODEL_UNAVAILABLE",
	invalid_request: "GEMINI_API:REQUEST_REJECTED",
	provider_outage: "GEMINI_API:PROVIDER_OUTAGE",
	transport_unavailable: "GEMINI_API:TRANSPORT_UNAVAILABLE",
};

export function geminiProviderErrorCode(error: unknown): GeminiProviderErrorCode | undefined {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
		if (current instanceof GeminiProviderError) return current.code;
		if (current instanceof GeminiKeyRevokedError) return "key_rejected";
		current = current.cause;
	}
	return undefined;
}

export function geminiProviderFailureCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
		if (current instanceof GeminiCapReachedError) return "GEMINI_API:CAP_REACHED";
		if (current instanceof GeminiKeyRevokedError) return "GEMINI_API:KEY_REJECTED";
		if (current instanceof GeminiProviderError) return GEMINI_FAILURE_CODES[current.code];
		current = current.cause;
	}
	return undefined;
}

export function geminiProviderDiagnostic(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
		if (current instanceof GeminiProviderError) {
			const parts = [`geminiCode=${current.code}`];
			if (current.detailCode !== null) parts.push(`geminiDetail=${current.detailCode}`);
			if (current.httpStatus !== null) parts.push(`httpStatus=${current.httpStatus}`);
			if (current.providerStatus !== null) parts.push(`providerStatus=${current.providerStatus}`);
			return parts.join(", ");
		}
		if (current instanceof GeminiKeyRevokedError) {
			const parts = ["geminiCode=key_rejected"];
			if (current.detailCode !== null) parts.push(`geminiDetail=${current.detailCode}`);
			if (current.httpStatus !== null) parts.push(`httpStatus=${current.httpStatus}`);
			if (current.providerStatus !== null) parts.push(`providerStatus=${current.providerStatus}`);
			return parts.join(", ");
		}
		if (current instanceof GeminiCapReachedError) return "geminiCode=cap_reached";
		current = current.cause;
	}
	return undefined;
}

export interface GeminiToolSessionUsage {
	readonly inputTokens: number;
	readonly cachedTokens: number;
	readonly outputTokens: number;
}

export interface GeminiUsageReceipt {
	readonly monthSpendMicrodollars: number;
	readonly monthlyCapCents: number | null;
	readonly capReached: boolean;
}

interface GeminiSchema {
	type?: "OBJECT" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN" | "ARRAY";
	description?: string;
	nullable?: boolean;
	enum?: string[];
	properties?: Record<string, GeminiSchema>;
	required?: string[];
	items?: GeminiSchema;
	minItems?: number;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
}

export interface GeminiFunctionDeclaration {
	readonly name: string;
	readonly description: string;
	readonly parameters?: GeminiSchema;
}

type GeminiPart = Record<string, unknown>;

interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

interface GeminiFunctionCall {
	readonly id?: string;
	readonly name: string;
	readonly args: JsonValue;
}

interface GeminiApiResponse {
	readonly parts: GeminiPart[];
	readonly usage: GeminiToolSessionUsage;
	readonly finishReason?: string;
	readonly groundingMetadata?: Record<string, unknown>;
}

class GeminiMalformedResponseError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "GeminiMalformedResponseError";
	}
}

class GeminiStreamError extends Error {
	readonly status: number;
	readonly bodyText: string;

	constructor(status: number, bodyText: string) {
		super(`Gemini stream returned error (${status})`);
		this.name = "GeminiStreamError";
		this.status = status;
		this.bodyText = bodyText;
	}
}

function isSseContentType(header: string | null): boolean {
	return header !== null && header.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

function isMergeableTextPart(part: GeminiPart): boolean {
	if (typeof part.text !== "string") return false;
	for (const key of Object.keys(part)) {
		if (key !== "text" && key !== "thought" && key !== "thoughtSignature") return false;
	}
	return true;
}

function appendStreamPart(target: GeminiPart[], part: GeminiPart): void {
	if (isMergeableTextPart(part)) {
		const previous = target.at(-1);
		if (
			previous &&
			isMergeableTextPart(previous) &&
			(previous.thought === true) === (part.thought === true) &&
			previous.thoughtSignature === undefined
		) {
			previous.text = `${previous.text as string}${part.text as string}`;
			if (part.thoughtSignature !== undefined) previous.thoughtSignature = part.thoughtSignature;
			return;
		}
	}
	target.push({ ...part });
}

function createGeminiCompositionTracker(
	observability: CloudRuntimeObservability | undefined,
	context: { readonly threadId: string; readonly turnId: string; readonly parentAttemptId?: string } | undefined,
): { onVisibleText: () => void; finish: (outcome: CloudRuntimeOutcome) => void } {
	let started = false;
	let finished = false;
	let span: CloudRuntimeObservationSpan | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const logicalOperationSha256 =
		observability && context
			? createHash("sha256")
					.update(JSON.stringify([context.threadId, context.turnId, "text"]))
					.digest("hex")
			: undefined;

	const onVisibleText = (): void => {
		if (started || finished || !observability || !context || !logicalOperationSha256) return;
		started = true;
		const renew = (): void => {
			if (finished) return;
			try {
				const previous = span;
				span = observability.start("message_composition", {
					logicalOperationSha256,
					...(context.parentAttemptId ? { parentAttemptId: context.parentAttemptId } : {}),
				});
				// WHY: Start the next expiring pulse before finishing the previous one so long replies have no writing gap.
				previous?.finish("succeeded");
			} catch {
				// WHY: Optional presentation telemetry must never fail a Gemini turn.
			}
			timer = setTimeout(renew, GEMINI_COMPOSITION_RENEW_MS);
			timer.unref?.();
		};
		renew();
	};

	const finish = (outcome: CloudRuntimeOutcome): void => {
		if (finished) return;
		finished = true;
		if (timer) clearTimeout(timer);
		timer = undefined;
		try {
			span?.finish(outcome);
		} catch {
			// WHY: Optional presentation telemetry must never fail a Gemini turn.
		}
	};

	return { onVisibleText, finish };
}

async function readGeminiSseResponse(options: {
	reply: Response;
	maxBytes: number;
	signal: AbortSignal;
	onVisibleText?: () => void;
}): Promise<GeminiApiResponse> {
	if (!options.reply.body) throw new GeminiMalformedResponseError("Gemini API returned an empty response");
	const reader = options.reply.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let totalBytes = 0;
	let pendingLine = "";
	let eventDataLines: string[] = [];
	const parts: GeminiPart[] = [];
	let rawUsageMetadata: Record<string, unknown> = {};
	let finishReason: string | undefined;
	let groundingMetadata: Record<string, unknown> | undefined;
	let sawFrame = false;

	const processFrame = (payloadText: string): void => {
		const trimmed = payloadText.trim();
		if (!trimmed || trimmed === "[DONE]") return;
		let frame: unknown;
		try {
			frame = JSON.parse(trimmed);
		} catch (error) {
			throw new GeminiMalformedResponseError("Gemini API returned malformed JSON", { cause: error });
		}
		if (!isPlainObject(frame)) throw new GeminiMalformedResponseError("Gemini API response is invalid");
		if (isPlainObject(frame.error)) {
			const code =
				typeof frame.error.code === "number" && Number.isSafeInteger(frame.error.code) ? frame.error.code : 500;
			throw new GeminiStreamError(code, trimmed);
		}
		sawFrame = true;
		const candidates = Array.isArray(frame.candidates) ? frame.candidates : [];
		const first = isPlainObject(candidates[0]) ? candidates[0] : undefined;
		const content = first && isPlainObject(first.content) ? first.content : undefined;
		const rawParts = content && Array.isArray(content.parts) ? content.parts : [];
		for (const part of rawParts) {
			if (!isPlainObject(part)) continue;
			appendStreamPart(parts, part);
			if (part.thought !== true && typeof part.text === "string" && part.text.length > 0) {
				options.onVisibleText?.();
			}
		}
		if (first && typeof first.finishReason === "string") finishReason = first.finishReason;
		if (first && isPlainObject(first.groundingMetadata)) groundingMetadata = first.groundingMetadata;
		if (isPlainObject(frame.usageMetadata)) rawUsageMetadata = { ...rawUsageMetadata, ...frame.usageMetadata };
	};

	const flushEvent = (): void => {
		if (eventDataLines.length === 0) return;
		const payloadText = eventDataLines.join("\n");
		eventDataLines = [];
		processFrame(payloadText);
	};

	const consumeLine = (rawLine: string): void => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") {
			flushEvent();
			return;
		}
		if (line.startsWith(":")) return;
		if (line.startsWith("data:")) {
			const rest = line.slice(5);
			eventDataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
		}
	};

	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		if (options.signal.aborted) {
			reject(options.signal.reason);
			return;
		}
		onAbort = () => {
			void reader.cancel(options.signal.reason).catch(() => undefined);
			reject(options.signal.reason);
		};
		options.signal.addEventListener("abort", onAbort, { once: true });
	});
	// WHY: Suppress unhandled rejection if stream finishes cleanly before signal aborts.
	abortPromise.catch(() => undefined);

	try {
		while (true) {
			options.signal.throwIfAborted();
			const { done, value } = await Promise.race([reader.read(), abortPromise]);
			options.signal.throwIfAborted();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			totalBytes += value.byteLength;
			if (totalBytes > options.maxBytes) {
				void reader.cancel().catch(() => undefined);
				throw new Error("Cloud response exceeds its byte limit");
			}
			let decoded: string;
			try {
				decoded = decoder.decode(value, { stream: true });
			} catch (error) {
				throw new GeminiMalformedResponseError("Gemini API returned malformed JSON", { cause: error });
			}
			const combined = pendingLine + decoded;
			const lines = combined.split("\n");
			pendingLine = lines.pop() ?? "";
			for (const line of lines) consumeLine(line);
		}
		let tail: string;
		try {
			tail = decoder.decode();
		} catch (error) {
			throw new GeminiMalformedResponseError("Gemini API returned malformed JSON", { cause: error });
		}
		if (pendingLine || tail) consumeLine(pendingLine + tail);
		flushEvent();
		if (!sawFrame) throw new GeminiMalformedResponseError("Gemini API returned an empty response");
		return {
			parts,
			usage: parseUsageMetadata(rawUsageMetadata),
			...(finishReason !== undefined ? { finishReason } : {}),
			...(groundingMetadata !== undefined ? { groundingMetadata } : {}),
		};
	} finally {
		if (onAbort) options.signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function geminiTypeName(value: string): GeminiSchema["type"] | undefined {
	switch (value) {
		case "object":
			return "OBJECT";
		case "string":
			return "STRING";
		case "integer":
			return "INTEGER";
		case "number":
			return "NUMBER";
		case "boolean":
			return "BOOLEAN";
		case "array":
			return "ARRAY";
		default:
			return undefined;
	}
}

function toGeminiSchema(value: unknown): GeminiSchema {
	if (!isPlainObject(value)) return { type: "STRING" };
	let schema: Record<string, unknown> = value;
	let nullable = value.nullable === true;
	const union = Array.isArray(value.anyOf) ? value.anyOf : Array.isArray(value.oneOf) ? value.oneOf : undefined;
	if (union && union.length > 0) {
		const nonNull = union.filter((item) => !(isPlainObject(item) && item.type === "null"));
		if (nonNull.length < union.length) nullable = true;
		if (nonNull.length === 1 && isPlainObject(nonNull[0])) {
			schema = {
				...(typeof value.description === "string" ? { description: value.description } : {}),
				...nonNull[0],
			};
		} else {
			const types = new Set(
				nonNull.map((item) => (isPlainObject(item) && typeof item.type === "string" ? item.type : "")),
			);
			const chosenType =
				types.size === 1 ? geminiTypeName([...types][0] ?? "") : types.has("object") ? "OBJECT" : "STRING";
			return {
				type: chosenType ?? "STRING",
				...(typeof value.description === "string" && value.description ? { description: value.description } : {}),
				...(nullable ? { nullable: true } : {}),
			};
		}
	}
	const out: GeminiSchema = {};
	if (Array.isArray(schema.type)) {
		const types = schema.type.filter((item): item is string => typeof item === "string");
		if (types.includes("null")) nullable = true;
		const primary = types.find((item) => item !== "null");
		const mapped = primary ? geminiTypeName(primary) : undefined;
		if (mapped) out.type = mapped;
	} else if (typeof schema.type === "string") {
		const mapped = geminiTypeName(schema.type);
		if (mapped) out.type = mapped;
	}
	if (typeof schema.const === "string") {
		out.type = out.type ?? "STRING";
		out.enum = [schema.const];
	} else if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const strings = schema.enum.filter((item): item is string => typeof item === "string");
		if (strings.length === schema.enum.length) {
			out.type = out.type ?? "STRING";
			out.enum = strings;
		}
	}
	if (!out.type) {
		if (isPlainObject(schema.properties)) out.type = "OBJECT";
		else if (schema.items !== undefined) out.type = "ARRAY";
		else out.type = "STRING";
	}
	const descriptions: string[] = [];
	if (typeof schema.description === "string" && schema.description.trim())
		descriptions.push(schema.description.trim());
	if (typeof schema.pattern === "string" && schema.pattern) descriptions.push(`Pattern: ${schema.pattern}`);
	if (descriptions.length > 0) out.description = descriptions.join(" ");
	if (nullable) out.nullable = true;
	if (out.type === "OBJECT") {
		const rawProps = isPlainObject(schema.properties) ? schema.properties : {};
		const properties: Record<string, GeminiSchema> = {};
		for (const [key, propSchema] of Object.entries(rawProps)) properties[key] = toGeminiSchema(propSchema);
		if (Object.keys(properties).length > 0) {
			out.properties = properties;
			if (Array.isArray(schema.required)) {
				const required = schema.required.filter(
					(key): key is string => typeof key === "string" && Object.hasOwn(properties, key),
				);
				if (required.length > 0) out.required = required;
			}
		}
	} else if (out.type === "ARRAY") {
		out.items = schema.items !== undefined ? toGeminiSchema(schema.items) : { type: "STRING" };
		if (typeof schema.minItems === "number" && Number.isSafeInteger(schema.minItems) && schema.minItems >= 0)
			out.minItems = schema.minItems;
		if (typeof schema.maxItems === "number" && Number.isSafeInteger(schema.maxItems) && schema.maxItems >= 0)
			out.maxItems = schema.maxItems;
	} else if (out.type === "STRING") {
		if (typeof schema.minLength === "number" && Number.isSafeInteger(schema.minLength) && schema.minLength >= 0)
			out.minLength = schema.minLength;
		if (typeof schema.maxLength === "number" && Number.isSafeInteger(schema.maxLength) && schema.maxLength >= 0)
			out.maxLength = schema.maxLength;
	} else if (out.type === "INTEGER" || out.type === "NUMBER") {
		if (typeof schema.minimum === "number" && Number.isFinite(schema.minimum)) out.minimum = schema.minimum;
		if (typeof schema.maximum === "number" && Number.isFinite(schema.maximum)) out.maximum = schema.maximum;
	}
	return out;
}

export function geminiFunctionDeclarations(specification: JsonValue): GeminiFunctionDeclaration[] {
	if (!isPlainObject(specification) || !Array.isArray(specification.tools)) return [];
	const declarations: GeminiFunctionDeclaration[] = [];
	for (const entry of specification.tools) {
		if (
			!isPlainObject(entry) ||
			entry.type !== "function" ||
			typeof entry.name !== "string" ||
			!entry.name ||
			typeof entry.description !== "string"
		)
			continue;
		const parameters = toGeminiSchema(entry.inputSchema);
		const hasProperties = parameters.type === "OBJECT" && parameters.properties !== undefined;
		declarations.push({
			name: entry.name,
			description: entry.description,
			...(hasProperties ? { parameters } : {}),
		});
	}
	return declarations;
}

function validateGeminiBaseUrl(value: string, allowLoopback: boolean): string {
	const url = new URL(value);
	const allowedProduction = url.protocol === "https:" && url.hostname === "generativelanguage.googleapis.com";
	const allowedTest =
		allowLoopback && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if ((!allowedProduction && !allowedTest) || url.username || url.password || url.search || url.hash)
		throw new Error("Gemini API base URL is invalid");
	return url.origin;
}

function parseUsageMetadata(value: unknown): GeminiToolSessionUsage {
	if (!isPlainObject(value)) return { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
	const nonNegative = (field: unknown): number =>
		typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : 0;
	const inputTokens = nonNegative(value.promptTokenCount);
	const cachedTokens = Math.min(inputTokens, nonNegative(value.cachedContentTokenCount));
	const candidatesTokens = nonNegative(value.candidatesTokenCount);
	const thoughtsTokens = nonNegative(value.thoughtsTokenCount);
	return { inputTokens, cachedTokens, outputTokens: candidatesTokens + thoughtsTokens };
}

function extractFunctionCalls(parts: readonly GeminiPart[]): GeminiFunctionCall[] {
	const calls: GeminiFunctionCall[] = [];
	for (const part of parts) {
		if (!isPlainObject(part.functionCall) || typeof part.functionCall.name !== "string") continue;
		const id = typeof part.functionCall.id === "string" ? part.functionCall.id : undefined;
		const args = part.functionCall.args !== undefined ? (part.functionCall.args as JsonValue) : {};
		calls.push({ ...(id ? { id } : {}), name: part.functionCall.name, args });
	}
	return calls;
}

function extractVisibleText(parts: readonly GeminiPart[]): string {
	const chunks: string[] = [];
	for (const part of parts) {
		if (part.thought === true) continue;
		if (typeof part.text === "string" && part.text) chunks.push(part.text);
	}
	return chunks.join("");
}

function pauseAbortable(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function generateGeminiContent(options: {
	baseUrl: string;
	model: string;
	apiKey: string;
	body: Record<string, unknown>;
	fetcher: typeof fetch;
	signal: AbortSignal;
	retryOnBusy: boolean;
	observability?: CloudRuntimeObservability;
	compositionContext?: { readonly threadId: string; readonly turnId: string };
}): Promise<GeminiApiResponse> {
	const url = `${options.baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;
	const payload = JSON.stringify(options.body);
	const observation = options.observability?.start("model_request");
	let recorded = false;
	const failObservation = (
		errorCategory:
			| "authority_unavailable"
			| "budget_exhausted"
			| "provider_failed"
			| "transport_unavailable"
			| "timeout"
			| "cancelled",
	): void => {
		if (recorded) return;
		recorded = true;
		observation?.finish(errorCategory === "cancelled" ? "cancelled" : "failed", { errorCategory });
	};
	const throwClassifiedHttpError = (
		status: number,
		snippet: string,
		retryAfterHeader: string | null,
		attempt: number,
	): number => {
		const classified = classifyGeminiHttpError(status, snippet, retryAfterHeader);
		if (classified.code === "billing_required") {
			failObservation("budget_exhausted");
			throw tagNativeRuntimeFailure(
				new GeminiProviderError(
					"billing_required",
					status,
					classified.providerStatus,
					`Gemini API billing or credits required (${status})`,
					undefined,
					classified.detailCode,
				),
				"native-tools",
				"budget_exhausted",
			);
		}
		if (classified.code === "key_rejected") {
			failObservation("authority_unavailable");
			throw tagNativeRuntimeFailure(
				new GeminiKeyRevokedError(
					"Google rejected your Gemini API key.",
					status,
					classified.providerStatus,
					classified.detailCode,
				),
				"native-tools",
				"authority_unavailable",
			);
		}
		if (classified.code === "quota_exhausted" || classified.code === "provider_outage") {
			const nonTransientQuota =
				classified.code === "quota_exhausted" &&
				(classified.detailCode === "daily_quota_exhausted" ||
					classified.detailCode === "spend_limit_reached" ||
					(classified.retryAfterMs !== null && classified.retryAfterMs > MAX_GEMINI_RETRY_WAIT_MS));
			const baseWait = options.retryOnBusy && !nonTransientQuota ? RETRY_DELAYS_MS[attempt] : undefined;
			if (baseWait !== undefined) {
				return classified.retryAfterMs !== null
					? Math.min(MAX_GEMINI_RETRY_WAIT_MS, Math.max(baseWait, classified.retryAfterMs))
					: baseWait;
			}
			failObservation("provider_failed");
			if (!options.retryOnBusy) throw new CloudActionReviewBusy();
			throw tagNativeRuntimeFailure(
				new GeminiProviderError(
					classified.code,
					status,
					classified.providerStatus,
					`Gemini API is temporarily busy (${status})`,
					undefined,
					classified.detailCode,
				),
				"native-tools",
				"provider_failed",
			);
		}
		failObservation("provider_failed");
		throw tagNativeRuntimeFailure(
			new GeminiProviderError(
				classified.code,
				status,
				classified.providerStatus,
				`Gemini API rejected the request (${status})`,
				undefined,
				classified.detailCode,
			),
			"native-tools",
			"provider_failed",
		);
	};
	try {
		for (let attempt = 0; ; attempt++) {
			options.signal.throwIfAborted();
			const scoped = new AbortController();
			const onCallerAbort = (): void => scoped.abort(options.signal.reason);
			options.signal.addEventListener("abort", onCallerAbort, { once: true });
			const requestTimer = setTimeout(
				() => scoped.abort(new DOMException("Gemini API request timed out", "TimeoutError")),
				MAX_GEMINI_REQUEST_MS,
			);
			requestTimer.unref?.();
			const requestSignal = scoped.signal;
			const composition = createGeminiCompositionTracker(
				options.observability,
				options.compositionContext
					? { ...options.compositionContext, parentAttemptId: observation?.attemptId }
					: undefined,
			);
			let compositionOutcome: CloudRuntimeOutcome = "failed";
			let bytes: Uint8Array | undefined;
			let streamed: GeminiApiResponse | undefined;
			let retryWait: number | undefined;
			try {
				let reply: Response;
				try {
					reply = await options.fetcher(url, {
						method: "POST",
						redirect: "error",
						headers: {
							"content-type": "application/json",
							accept: "text/event-stream",
							"x-goog-api-key": options.apiKey,
						},
						body: payload,
						signal: requestSignal,
					});
				} catch (error) {
					if (options.signal.aborted) {
						compositionOutcome = "cancelled";
						throw error;
					}
					const wait = options.retryOnBusy ? RETRY_DELAYS_MS[attempt] : undefined;
					if (wait !== undefined) {
						retryWait = wait;
					} else {
						failObservation("transport_unavailable");
						throw tagNativeRuntimeFailure(
							new GeminiProviderError("transport_unavailable", null, null, "Could not reach the Gemini API", {
								cause: error,
							}),
							"native-tools",
							"transport_unavailable",
						);
					}
					reply = undefined as never;
				}
				if (retryWait === undefined) {
					if (!reply.ok) {
						const snippet = await readGeminiErrorSnippet(reply);
						retryWait = throwClassifiedHttpError(
							reply.status,
							snippet,
							reply.headers.get("retry-after"),
							attempt,
						);
					} else if (isSseContentType(reply.headers.get("content-type"))) {
						try {
							streamed = await readGeminiSseResponse({
								reply,
								maxBytes: MAX_GEMINI_RESPONSE_BYTES,
								signal: requestSignal,
								onVisibleText: composition.onVisibleText,
							});
							compositionOutcome = "succeeded";
						} catch (error) {
							if (options.signal.aborted) {
								compositionOutcome = "cancelled";
								throw error;
							}
							if (error instanceof GeminiStreamError) {
								retryWait = throwClassifiedHttpError(error.status, error.bodyText, null, attempt);
							} else if (error instanceof GeminiMalformedResponseError) {
								failObservation("provider_failed");
								throw tagNativeRuntimeFailure(error, "native-tools", "provider_failed");
							} else if (error instanceof Error && error.message === "Cloud response exceeds its byte limit") {
								failObservation("provider_failed");
								throw tagNativeRuntimeFailure(error, "native-tools", "provider_failed");
							} else {
								const wait = options.retryOnBusy ? RETRY_DELAYS_MS[attempt] : undefined;
								if (wait !== undefined) {
									retryWait = wait;
								} else {
									failObservation("transport_unavailable");
									throw tagNativeRuntimeFailure(
										new GeminiProviderError(
											"transport_unavailable",
											null,
											null,
											"Could not reach the Gemini API",
											{
												cause: error,
											},
										),
										"native-tools",
										"transport_unavailable",
									);
								}
							}
						}
					} else {
						try {
							bytes = await readBoundedCloudResponse(reply, MAX_GEMINI_RESPONSE_BYTES, requestSignal);
							compositionOutcome = "succeeded";
						} catch (error) {
							if (options.signal.aborted) {
								compositionOutcome = "cancelled";
								throw error;
							}
							if (error instanceof Error && error.message === "Cloud response exceeds its byte limit") {
								failObservation("provider_failed");
								throw tagNativeRuntimeFailure(error, "native-tools", "provider_failed");
							}
							const wait = options.retryOnBusy ? RETRY_DELAYS_MS[attempt] : undefined;
							if (wait !== undefined) {
								retryWait = wait;
							} else {
								failObservation("transport_unavailable");
								throw tagNativeRuntimeFailure(
									new GeminiProviderError(
										"transport_unavailable",
										null,
										null,
										"Could not reach the Gemini API",
										{
											cause: error,
										},
									),
									"native-tools",
									"transport_unavailable",
								);
							}
						}
					}
				}
			} finally {
				composition.finish(compositionOutcome);
				clearTimeout(requestTimer);
				options.signal.removeEventListener("abort", onCallerAbort);
			}
			if (retryWait !== undefined) {
				await pauseAbortable(retryWait, options.signal);
				continue;
			}
			if (streamed) {
				recorded = true;
				observation?.finish("succeeded", {
					inputTokens: streamed.usage.inputTokens,
					cachedInputTokens: streamed.usage.cachedTokens,
					outputTokens: streamed.usage.outputTokens,
					totalTokens: streamed.usage.inputTokens + streamed.usage.outputTokens,
				});
				return streamed;
			}
			if (!bytes) {
				failObservation("provider_failed");
				throw new Error("Gemini API returned an empty response");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			} catch (error) {
				failObservation("provider_failed");
				throw tagNativeRuntimeFailure(
					new Error("Gemini API returned malformed JSON", { cause: error }),
					"native-tools",
					"provider_failed",
				);
			}
			if (!isPlainObject(parsed)) {
				failObservation("provider_failed");
				throw tagNativeRuntimeFailure(
					new Error("Gemini API response is invalid"),
					"native-tools",
					"provider_failed",
				);
			}
			const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
			const first = isPlainObject(candidates[0]) ? candidates[0] : undefined;
			const content = first && isPlainObject(first.content) ? first.content : undefined;
			const rawParts = content && Array.isArray(content.parts) ? content.parts : [];
			const parts = rawParts.filter(isPlainObject);
			const finishReason = first && typeof first.finishReason === "string" ? first.finishReason : undefined;
			const groundingMetadata =
				first && isPlainObject(first.groundingMetadata) ? first.groundingMetadata : undefined;
			const usage = parseUsageMetadata(parsed.usageMetadata);
			recorded = true;
			observation?.finish("succeeded", {
				inputTokens: usage.inputTokens,
				cachedInputTokens: usage.cachedTokens,
				outputTokens: usage.outputTokens,
				totalTokens: usage.inputTokens + usage.outputTokens,
			});
			return {
				parts,
				usage,
				...(finishReason !== undefined ? { finishReason } : {}),
				...(groundingMetadata !== undefined ? { groundingMetadata } : {}),
			};
		}
	} catch (error) {
		if (!recorded) {
			const category = options.signal.aborted
				? options.signal.reason instanceof Error && options.signal.reason.name === "TimeoutError"
					? "timeout"
					: "cancelled"
				: "provider_failed";
			failObservation(category);
		}
		throw error;
	}
}

interface GeminiHistoryItem {
	readonly role: "user" | "model";
	readonly item: CloudNativeContextItem;
	readonly parts: readonly GeminiPart[];
}

function appendMergedContent(
	target: GeminiContent[],
	content: { role: "user" | "model"; parts: readonly GeminiPart[] },
): void {
	const previous = target.at(-1);
	if (previous && previous.role === content.role) {
		previous.parts.push(...content.parts);
		return;
	}
	target.push({ role: content.role, parts: [...content.parts] });
}

function mergeHistoryItems(history: readonly GeminiHistoryItem[]): GeminiContent[] {
	const merged: GeminiContent[] = [];
	for (const entry of history) appendMergedContent(merged, entry);
	return merged;
}

// WHY: Default 200-turn safety cap applies only when neither timeoutMs nor monthlyCapCents bounds the run (or when
// maxTurns is passed explicitly), excludes the single turnCorrection retry, and fails with budget_exhausted.
const MAX_GEMINI_TURNS = 200;

async function composeGeminiContents(
	history: GeminiHistoryItem[],
	composer: CloudCodexContextComposer | undefined,
	context: {
		readonly requestId: string;
		readonly threadId: string;
		readonly turnId: string;
		readonly model: string;
	},
	signal: AbortSignal,
): Promise<GeminiContent[]> {
	if (!composer) return mergeHistoryItems(history);
	const composed = await composer(
		{
			schema: CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
			requestId: context.requestId,
			threadId: context.threadId,
			turnId: context.turnId,
			purpose: "turn",
			model: context.model,
			items: history.map((entry) => entry.item),
		},
		signal,
	);
	const result: GeminiContent[] = [];
	const keptIndices = new Set<number>();
	let folded = false;
	for (const entry of composed.input) {
		if ("work" in entry) {
			folded = true;
			appendMergedContent(result, {
				role: "user",
				parts: [{ text: redactCloudWebhookSecrets(entry.work) }],
			});
			continue;
		}
		const kept = history[entry.keep];
		if (kept) {
			keptIndices.add(entry.keep);
			appendMergedContent(result, kept);
		}
	}
	if (folded && result.length > 0) {
		for (let i = 0; i < history.length; i += 1) {
			if (keptIndices.has(i)) continue;
			const entry = history[i];
			if (entry.parts.some((part) => "inlineData" in part)) {
				history[i] = { ...entry, parts: entry.parts.filter((part) => !("inlineData" in part)) };
			}
		}
	}
	return result.length > 0 ? result : mergeHistoryItems(history);
}

export async function runCloudGeminiToolSession(options: {
	boundary: CloudNativeToolBoundary;
	model: CloudRuntimeGeminiModel;
	effort: CloudRuntimeGeminiEffort;
	apiKey: string;
	apiBaseUrl?: string;
	allowLoopback?: boolean;
	fetch?: typeof fetch;
	initialSpendMicrodollars: number;
	monthlyCapCents: number | null;
	onUsage?: (usage: GeminiToolSessionUsage, signal: AbortSignal) => Promise<GeminiUsageReceipt | undefined>;
	beforeModelStart?: (signal: AbortSignal) => Promise<void>;
	opening?: (signal: AbortSignal) => Promise<CloudCodexOpening>;
	composeContext?: CloudCodexContextComposer;
	prompt?: string;
	runtimeInstructions?: string;
	reviewer?: CloudActionReviewChannel;
	turnCorrection?: (signal: AbortSignal) => Promise<string | undefined>;
	closing?: (signal: AbortSignal) => Promise<void>;
	recordContextView?: (
		frame: CloudNativeFenceRequest,
		outputs: readonly CloudNativeFencedResult[],
		signal: AbortSignal,
	) => Promise<void>;
	recordChecksAuthority?: boolean;
	observability?: CloudRuntimeObservability;
	signal: AbortSignal;
	timeoutMs?: number;
	maxTurns?: number;
}): Promise<CloudCodexToolSessionResult> {
	const explicitMaxTurns = options.maxTurns;
	if (explicitMaxTurns !== undefined && (!Number.isSafeInteger(explicitMaxTurns) || explicitMaxTurns < 1))
		throw new Error("Invalid Gemini maxTurns");
	const baseUrl = validateGeminiBaseUrl(options.apiBaseUrl ?? GEMINI_DEFAULT_API_BASE, options.allowLoopback === true);
	const fetcher = options.fetch ?? fetch;
	const runWithSession = async (sessionSignal: AbortSignal): Promise<CloudCodexToolSessionResult> => {
		const threadId = `gemini-${randomUUID()}`;
		let monthSpendMicrodollars = options.initialSpendMicrodollars;
		let monthlyCapCents = options.monthlyCapCents;
		let totalInputTokens = 0;
		let totalCachedTokens = 0;
		let totalOutputTokens = 0;
		let localRunSpendMicrodollars = 0;
		let usageDirty = false;
		let toolCalls = 0;
		let fencedRequests = 0;

		const assertWithinCap = (): void => {
			if (monthlyCapCents !== null && monthSpendMicrodollars >= monthlyCapCents * 10_000) {
				throw tagNativeRuntimeFailure(
					new GeminiCapReachedError(monthlyCapCents, monthSpendMicrodollars),
					"native-tools",
					"budget_exhausted",
				);
			}
		};

		const flushUsage = async (flushSignal?: AbortSignal): Promise<boolean> => {
			if (!options.onUsage || !usageDirty) return true;
			const onUsage = options.onUsage;
			const snapshot: GeminiToolSessionUsage = {
				inputTokens: totalInputTokens,
				cachedTokens: totalCachedTokens,
				outputTokens: totalOutputTokens,
			};
			try {
				const receipt = await withAbortScopes(
					flushSignal ? [flushSignal] : [],
					(signal) => onUsage(snapshot, signal),
					10_000,
				);
				if (!receipt) return false;
				monthSpendMicrodollars = receipt.monthSpendMicrodollars;
				monthlyCapCents = receipt.monthlyCapCents;
				if (
					totalInputTokens === snapshot.inputTokens &&
					totalCachedTokens === snapshot.cachedTokens &&
					totalOutputTokens === snapshot.outputTokens
				) {
					usageDirty = false;
				}
				return true;
			} catch {
				return false;
			}
		};

		const recordUsage = async (usage: GeminiToolSessionUsage): Promise<void> => {
			if (usage.inputTokens === 0 && usage.cachedTokens === 0 && usage.outputTokens === 0) return;
			totalInputTokens += usage.inputTokens;
			totalCachedTokens += usage.cachedTokens;
			totalOutputTokens += usage.outputTokens;
			const nextRunSpend = geminiNeonSpendMicrodollars({
				inputTokens: totalInputTokens,
				cachedTokens: totalCachedTokens,
				outputTokens: totalOutputTokens,
			});
			const delta = Math.max(0, nextRunSpend - localRunSpendMicrodollars);
			localRunSpendMicrodollars = Math.max(localRunSpendMicrodollars, nextRunSpend);
			monthSpendMicrodollars += delta;
			usageDirty = true;
			await flushUsage(sessionSignal);
		};

		assertWithinCap();
		await options.beforeModelStart?.(sessionSignal);
		const opened: CloudCodexOpening = options.opening
			? await options.opening(sessionSignal)
			: {
					prompt: options.prompt ?? "",
					runtimeInstructions: options.runtimeInstructions,
				};
		const composer = opened.composeContext ?? options.composeContext;
		const rawInstructions = opened.runtimeInstructions ?? "";
		const systemText = redactCloudWebhookSecrets(
			opened.resultRulesInside
				? rawInstructions
				: [CLOUD_TOOL_RESULT_INSTRUCTIONS, rawInstructions].filter(Boolean).join("\n\n"),
		);
		const initialPrompt = redactCloudWebhookSecrets(opened.prompt);
		const declarations = geminiFunctionDeclarations(options.boundary.specification);
		const tools: Record<string, unknown>[] = [
			...(declarations.length > 0 ? [{ functionDeclarations: declarations }] : []),
			{ google_search: {} },
		];
		const reviewDeclarations = geminiFunctionDeclarations(CLOUD_ACTION_REVIEW_SPECIFICATION);

		if (options.reviewer) {
			options.reviewer.attach({
				review: async (input, reviewSignal) => {
					assertWithinCap();
					const response = await withAbortScopes([sessionSignal, reviewSignal], (combinedSignal) =>
						generateGeminiContent({
							baseUrl,
							model: options.model,
							apiKey: options.apiKey,
							fetcher,
							signal: combinedSignal,
							retryOnBusy: false,
							observability: options.observability,
							body: {
								systemInstruction: { parts: [{ text: input.instructions }] },
								contents: [{ role: "user", parts: [{ text: input.prompt }] }],
								tools: [{ functionDeclarations: reviewDeclarations }],
								toolConfig: {
									functionCallingConfig: {
										mode: "ANY",
										allowedFunctionNames: [CLOUD_ACTION_REVIEW_TOOL],
									},
								},
								generationConfig: {
									thinkingConfig: { thinkingLevel: "low" },
								},
							},
						}),
					);
					await recordUsage(response.usage);
					const verdictCall = extractFunctionCalls(response.parts).find(
						(call) => call.name === CLOUD_ACTION_REVIEW_TOOL,
					);
					if (!verdictCall) throw new Error("Gemini action reviewer did not call review_verdict");
					return verdictCall.args;
				},
			});
		}

		try {
			const history: GeminiHistoryItem[] = [
				{
					role: "user",
					parts: [{ text: initialPrompt }],
					item: {
						kind: "message",
						role: "user",
						callId: null,
						id: null,
						bytes: Buffer.byteLength(initialPrompt),
						media: 0,
					},
				},
			];
			let pendingFenceInputs: CloudNativeResultInput[] = [];
			let correctionSent = false;
			let turnIndex = 0;
			let countedTurns = 0;
			let isCorrectionTurn = false;

			while (true) {
				sessionSignal.throwIfAborted();
				assertWithinCap();
				const effectiveMaxTurns =
					explicitMaxTurns !== undefined
						? explicitMaxTurns
						: options.timeoutMs === undefined && monthlyCapCents === null
							? MAX_GEMINI_TURNS
							: null;
				if (effectiveMaxTurns !== null && !isCorrectionTurn && countedTurns >= effectiveMaxTurns)
					throw tagNativeRuntimeFailure(
						new Error("Gemini tool session exceeded maximum turn limit"),
						"native-tools",
						"budget_exhausted",
					);
				if (!isCorrectionTurn) countedTurns += 1;
				isCorrectionTurn = false;
				turnIndex += 1;
				const turnId = `gemini-turn-${turnIndex}`;
				const fenced = await options.boundary.fenceNativeResults(pendingFenceInputs, {
					authority: options.recordChecksAuthority ? "with-record" : "here",
				});
				const frame: CloudNativeFenceRequest = {
					schema: CLOUD_NATIVE_RESULT_FENCE_SCHEMA,
					requestId: randomUUID(),
					threadId,
					turnId,
					purpose: "turn",
					outputs: pendingFenceInputs,
				};
				if (options.recordContextView) await options.recordContextView(frame, fenced, sessionSignal);
				fencedRequests += 1;
				pendingFenceInputs = [];

				const requestContents = await composeGeminiContents(
					history,
					composer,
					{ requestId: frame.requestId, threadId, turnId, model: options.model },
					sessionSignal,
				);
				const response = await generateGeminiContent({
					baseUrl,
					model: options.model,
					apiKey: options.apiKey,
					fetcher,
					signal: sessionSignal,
					retryOnBusy: true,
					observability: options.observability,
					compositionContext: { threadId, turnId },
					body: {
						...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
						contents: requestContents,
						tools,
						...(declarations.length > 0 ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
						generationConfig: {
							thinkingConfig: { thinkingLevel: options.effort },
						},
					},
				});
				const visibleText = extractVisibleText(response.parts);
				if (visibleText) options.boundary.runLog?.agentText(visibleText);

				const functionCalls = extractFunctionCalls(response.parts);
				// WHY: overlap cumulative usage flush with tool batch execution; total spend updates synchronously first.
				const usageFlush = functionCalls.length > 0 ? recordUsage(response.usage) : null;
				if (!usageFlush) await recordUsage(response.usage);
				const assignedCallIds = functionCalls.map((call, index) =>
					call.id !== undefined && CALL_ID.test(call.id) ? call.id : `gemini-${fencedRequests}-${index + 1}`,
				);
				let callCursor = 0;
				for (const part of response.parts) {
					if (isPlainObject(part.functionCall) && typeof part.functionCall.name === "string") {
						const callId = assignedCallIds[callCursor] ?? `gemini-${fencedRequests}-${callCursor + 1}`;
						callCursor += 1;
						const args = part.functionCall.args !== undefined ? part.functionCall.args : {};
						history.push({
							role: "model",
							parts: [part],
							item: {
								kind: "function_call",
								role: null,
								callId,
								id: null,
								bytes: Buffer.byteLength(JSON.stringify(args)),
								media: 0,
							},
						});
					} else if (part.thought === true) {
						history.push({
							role: "model",
							parts: [part],
							item: {
								kind: "reasoning",
								role: null,
								callId: null,
								id: null,
								bytes: Buffer.byteLength(JSON.stringify(part)),
								media: 0,
							},
						});
					} else {
						const text = typeof part.text === "string" ? part.text : JSON.stringify(part);
						history.push({
							role: "model",
							parts: [part],
							item: {
								kind: "message",
								role: "assistant",
								callId: null,
								id: null,
								bytes: Buffer.byteLength(text),
								media: 0,
							},
						});
					}
				}

				if (functionCalls.length > 0) {
					let stopAfterBatch = false;
					let batchResults: Awaited<ReturnType<typeof options.boundary.invoke>>[];
					try {
						sessionSignal.throwIfAborted();
						batchResults =
							functionCalls.length === 1
								? [
										await options.boundary.invoke(
											assignedCallIds[0],
											"qorpera",
											functionCalls[0].name,
											functionCalls[0].args,
										),
									]
								: await Promise.all(
										functionCalls.map((call, index) =>
											options.boundary.invoke(assignedCallIds[index], "qorpera", call.name, call.args),
										),
									);
					} finally {
						await usageFlush;
					}
					sessionSignal.throwIfAborted();
					for (const [index, call] of functionCalls.entries()) {
						const callId = assignedCallIds[index];
						const result = batchResults[index];
						toolCalls += 1;
						const envelopeText = result.contentItems[0].text;
						const imageItem = result.contentItems.find(
							(item): item is { type: "inputImage"; imageUrl: string } =>
								item.type === "inputImage" && item.imageUrl.startsWith(PNG_DATA_URL_PREFIX),
						);
						const callParts: GeminiPart[] = [];
						if (imageItem) {
							const base64 = imageItem.imageUrl.slice(PNG_DATA_URL_PREFIX.length);
							const imageSha256 =
								options.boundary.shownImageSha256(result) ??
								createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
							pendingFenceInputs.push({
								kind: "function_call_output",
								callId,
								output: [
									{ type: "input_text", text: envelopeText },
									{ type: "input_image", sha256: imageSha256 },
								],
							});
							callParts.push({
								functionResponse: {
									...(call.id ? { id: call.id } : {}),
									name: call.name,
									response: { output: envelopeText },
								},
							});
							callParts.push({
								inlineData: { mimeType: "image/png", data: base64 },
							});
						} else {
							pendingFenceInputs.push({
								kind: "function_call_output",
								callId,
								output: envelopeText,
							});
							callParts.push({
								functionResponse: {
									...(call.id ? { id: call.id } : {}),
									name: call.name,
									response: { output: envelopeText },
								},
							});
						}
						history.push({
							role: "user",
							parts: callParts,
							item: {
								kind: "function_call_output",
								role: null,
								callId,
								id: null,
								bytes: Buffer.byteLength(envelopeText),
								media: imageItem ? 1 : 0,
							},
						});
						if (result.completesTurn === true || (result.completesTurn === "alone" && functionCalls.length === 1))
							stopAfterBatch = true;
					}
					if (stopAfterBatch) break;
					continue;
				}

				if (!correctionSent && options.turnCorrection) {
					const correction = await options.turnCorrection(sessionSignal);
					if (correction) {
						correctionSent = true;
						if (response.parts.length === 0) {
							history.push({
								role: "model",
								parts: [{ text: "" }],
								item: { kind: "message", role: "assistant", callId: null, id: null, bytes: 0, media: 0 },
							});
						}
						const redactedCorrection = redactCloudWebhookSecrets(correction);
						history.push({
							role: "user",
							parts: [{ text: redactedCorrection }],
							item: {
								kind: "message",
								role: "user",
								callId: null,
								id: null,
								bytes: Buffer.byteLength(redactedCorrection),
								media: 0,
							},
						});
						isCorrectionTurn = true;
						continue;
					}
				}
				break;
			}

			await options.closing?.(sessionSignal);
			return {
				providerSessionId: `gemini:${options.model}:${threadId}`,
				toolCalls,
				codexVersion: options.model,
				fencedRequests,
			};
		} finally {
			options.reviewer?.attach(undefined);
			// WHY: qorpera_record_gemini_run_usage requires an active lease, so if this attempt was cut off and superseded
			// before its final response flushed, this retry is refused and logged rather than blocking teardown.
			if (options.onUsage && usageDirty) {
				const flushed = await flushUsage();
				if (!flushed) {
					const retried = await flushUsage();
					if (!retried) console.error("Gemini run usage was not recorded");
				}
			}
		}
	};
	return options.timeoutMs !== undefined
		? withAbortScopes([options.signal], runWithSession, options.timeoutMs)
		: runWithSession(options.signal);
}
