import { createHash } from "node:crypto";
import { parseRecord, parseUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { type ModelLoginRunBinding, parseModelLoginRunBinding } from "./cloud-model-login-vault.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{32,256}$/;
const GEMINI_API_KEY = /^(?:AIza[A-Za-z0-9_-]{20,200}|AQ\.[A-Za-z0-9._-]{20,200})$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const GEMINI_API_KEY_FIELD = "gemini_api_key";
const GEMINI_VERIFY_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
const GEMINI_CHECK_GENERATE_URL =
	"https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent";
// WHY: Key checks send a minimal generateContent probe because metadata GET returns 200 for unbilled keys; the
// negligible probe cost is intentionally not tracked against the member's monthly spend cap ledger.
const GEMINI_CHECK_REQUEST_BODY = JSON.stringify({
	contents: [{ role: "user", parts: [{ text: "Reply with ok." }] }],
	generationConfig: {
		maxOutputTokens: 32,
		thinkingConfig: { thinkingLevel: "low" },
	},
});
const MAX_GEMINI_ERROR_BYTES = 8 * 1024;
const MAX_RETRY_AFTER_MS = 120_000;

export const GEMINI_PROVIDER_ERROR_CODES = Object.freeze([
	"key_rejected",
	"billing_required",
	"quota_exhausted",
	"model_unavailable",
	"invalid_request",
	"provider_outage",
	"transport_unavailable",
] as const);

export type GeminiProviderErrorCode = (typeof GEMINI_PROVIDER_ERROR_CODES)[number];

export const GEMINI_PROVIDER_ERROR_DETAILS = Object.freeze([
	"api_key_invalid",
	"api_key_expired",
	"api_key_blocked",
	"service_disabled",
	"billing_disabled",
	"prepay_balance_empty",
	"free_tier_limit_zero",
	"quota_limit_zero",
	"rate_limited",
	"daily_quota_exhausted",
	"spend_limit_reached",
	"region_unsupported",
	"model_not_found",
	"overloaded",
] as const);

export type GeminiProviderErrorDetail = (typeof GEMINI_PROVIDER_ERROR_DETAILS)[number];

export interface GeminiHttpErrorClassification {
	readonly code: GeminiProviderErrorCode;
	readonly providerStatus: string | null;
	readonly detailCode: GeminiProviderErrorDetail | null;
	readonly retryAfterMs: number | null;
}

const GOOGLE_RPC_STATUSES = new Set([
	"INVALID_ARGUMENT",
	"FAILED_PRECONDITION",
	"UNAUTHENTICATED",
	"PERMISSION_DENIED",
	"NOT_FOUND",
	"RESOURCE_EXHAUSTED",
	"INTERNAL",
	"UNAVAILABLE",
	"DEADLINE_EXCEEDED",
]);

const BILLING_REASONS = new Set([
	"BILLING_DISABLED",
	"BILLING_NOT_ENABLED",
	"BILLING_ACCOUNT_DISABLED",
	"BILLING_ACCOUNT_CLOSED",
	"BILLING_REQUIRED",
]);

const KEY_INVALID_REASONS = new Set(["API_KEY_INVALID", "ACCESS_TOKEN_TYPE_UNSUPPORTED"]);
const KEY_EXPIRED_REASONS = new Set(["API_KEY_EXPIRED"]);
const KEY_BLOCKED_REASONS = new Set([
	"API_KEY_SERVICE_BLOCKED",
	"API_KEY_HTTP_REFERRER_BLOCKED",
	"API_KEY_IP_ADDRESS_BLOCKED",
	"API_KEY_ANDROID_APP_BLOCKED",
	"API_KEY_IOS_APP_BLOCKED",
]);
const REGION_REASONS = new Set(["LOCATION_NOT_SUPPORTED", "REGION_NOT_SUPPORTED"]);

const FREE_TIER_PATTERN = /free[_\s-]?tier/i;
const ZERO_LIMIT_PATTERN = /\blimit\s*:\s*0\b/i;
const PREPAY_MESSAGE_PATTERN =
	/prepa(?:y|id)\s+(?:credits?|balance)|credit\s+balance\s+above\s+\$?0|payment\s+required/i;
const BILLING_MESSAGE_PATTERN =
	/billing(?:\s+account)?\s+(?:is\s+)?(?:not\s+enabled|disabled|required|closed)|enable\s+billing|prepaid\s+billing|claim\s+(?:your\s+)?credits?/i;
const SPEND_LIMIT_PATTERN = /spend(?:ing)?\s*(?:cap|limit)|monthly\s+(?:spend|budget)/i;
const SPEND_METRIC_PATTERN = /spend|budget|credit/i;
const DAILY_QUOTA_PATTERN = /per[_\s-]?day|daily\s+(?:quota|limit)|requests\s+per\s+day|perday/i;
const REGION_MESSAGE_PATTERN =
	/user\s+location\s+is\s+not\s+supported|location\s+is\s+not\s+supported|not\s+available\s+in\s+your\s+(?:region|country)/i;
const KEY_INVALID_MESSAGE_PATTERN = /api\s+key\s+(?:not\s+valid|invalid)|api_key_invalid/i;
const KEY_EXPIRED_MESSAGE_PATTERN = /api\s+key\s+expired|api_key_expired/i;
const SERVICE_DISABLED_MESSAGE_PATTERN = /generative\s+language\s+api\s+has\s+not\s+been\s+used|service\s+disabled/i;
const GOOGLE_DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s)$/;

function parseGoogleRetryDelayMs(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = GOOGLE_DURATION_PATTERN.exec(value.trim());
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const ms = match[2] === "ms" ? Math.ceil(amount) : Math.ceil(amount * 1_000);
	return Math.max(1, Math.min(MAX_RETRY_AFTER_MS, ms));
}

function parseRetryAfterHeaderMs(value: string | null | undefined): number | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!/^\d{1,6}$/.test(trimmed)) return null;
	const seconds = Number(trimmed);
	if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
	return Math.min(MAX_RETRY_AFTER_MS, seconds * 1_000);
}

export function classifyGeminiHttpError(
	status: number,
	bodyBytes?: Uint8Array,
	retryAfterHeader?: string | null,
): GeminiHttpErrorClassification {
	let providerStatus: string | null = null;
	let billingReason = false;
	let keyDetail: GeminiProviderErrorDetail | null = null;
	let regionUnsupported = false;
	let hasFreeTierQuota = false;
	let hasZeroQuotaLimit = false;
	let hasSpendQuota = false;
	let hasDailyQuota = false;
	let retryAfterMs: number | null = null;
	let message = "";
	if (bodyBytes && bodyBytes.byteLength > 0 && bodyBytes.byteLength <= MAX_GEMINI_ERROR_BYTES) {
		try {
			const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes)) as unknown;
			const err =
				parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>).error
					: undefined;
			if (err && typeof err === "object" && !Array.isArray(err)) {
				const errObj = err as Record<string, unknown>;
				if (typeof errObj.status === "string" && GOOGLE_RPC_STATUSES.has(errObj.status)) {
					providerStatus = errObj.status;
				}
				if (typeof errObj.message === "string") {
					message = errObj.message.slice(0, 2048);
				}
				if (Array.isArray(errObj.details)) {
					for (const detail of errObj.details.slice(0, 12)) {
						if (!detail || typeof detail !== "object" || Array.isArray(detail)) continue;
						const detailObj = detail as Record<string, unknown>;
						if (typeof detailObj.reason === "string") {
							const reason = detailObj.reason;
							if (BILLING_REASONS.has(reason)) {
								billingReason = true;
							} else if (KEY_INVALID_REASONS.has(reason)) {
								keyDetail = "api_key_invalid";
							} else if (KEY_EXPIRED_REASONS.has(reason)) {
								keyDetail = "api_key_expired";
							} else if (KEY_BLOCKED_REASONS.has(reason)) {
								keyDetail = "api_key_blocked";
							} else if (reason === "SERVICE_DISABLED") {
								keyDetail = "service_disabled";
							} else if (REGION_REASONS.has(reason)) {
								regionUnsupported = true;
							}
						}
						if (Array.isArray(detailObj.violations)) {
							for (const violation of detailObj.violations.slice(0, 16)) {
								if (!violation || typeof violation !== "object" || Array.isArray(violation)) continue;
								const v = violation as Record<string, unknown>;
								const metric = typeof v.quotaMetric === "string" ? v.quotaMetric.slice(0, 256) : "";
								const quotaId = typeof v.quotaId === "string" ? v.quotaId.slice(0, 256) : "";
								const description = typeof v.description === "string" ? v.description.slice(0, 512) : "";
								const combined = `${metric} ${quotaId} ${description}`;
								if (FREE_TIER_PATTERN.test(combined)) hasFreeTierQuota = true;
								if (v.quotaValue === "0" || v.quotaValue === 0 || ZERO_LIMIT_PATTERN.test(description)) {
									hasZeroQuotaLimit = true;
								}
								if (
									SPEND_METRIC_PATTERN.test(metric) ||
									SPEND_METRIC_PATTERN.test(quotaId) ||
									SPEND_LIMIT_PATTERN.test(description)
								) {
									hasSpendQuota = true;
								}
								if (DAILY_QUOTA_PATTERN.test(combined)) hasDailyQuota = true;
							}
						}
						if (retryAfterMs === null && detailObj.retryDelay !== undefined) {
							retryAfterMs = parseGoogleRetryDelayMs(detailObj.retryDelay);
						}
					}
				}
			}
		} catch {}
	}
	if (retryAfterMs === null) retryAfterMs = parseRetryAfterHeaderMs(retryAfterHeader);

	const freeTierMessage = FREE_TIER_PATTERN.test(message);
	const zeroLimitMessage = ZERO_LIMIT_PATTERN.test(message);
	const prepayMessage = PREPAY_MESSAGE_PATTERN.test(message);
	const billingMessage = BILLING_MESSAGE_PATTERN.test(message);
	const spendMessage = SPEND_LIMIT_PATTERN.test(message);
	const dailyMessage = DAILY_QUOTA_PATTERN.test(message);
	const regionMessage = REGION_MESSAGE_PATTERN.test(message);
	const keyInvalidMessage = KEY_INVALID_MESSAGE_PATTERN.test(message);
	const keyExpiredMessage = KEY_EXPIRED_MESSAGE_PATTERN.test(message);
	const serviceDisabledMessage = SERVICE_DISABLED_MESSAGE_PATTERN.test(message);

	if (status === 402) {
		return { code: "billing_required", providerStatus, detailCode: "prepay_balance_empty", retryAfterMs: null };
	}
	if (billingReason) {
		return { code: "billing_required", providerStatus, detailCode: "billing_disabled", retryAfterMs: null };
	}
	if ((status === 400 || status === 403 || status === 429) && prepayMessage) {
		return { code: "billing_required", providerStatus, detailCode: "prepay_balance_empty", retryAfterMs: null };
	}
	if ((status === 400 || status === 403 || status === 429) && billingMessage) {
		return { code: "billing_required", providerStatus, detailCode: "billing_disabled", retryAfterMs: null };
	}
	if (status === 429 && (hasFreeTierQuota || freeTierMessage) && (hasZeroQuotaLimit || zeroLimitMessage)) {
		return { code: "billing_required", providerStatus, detailCode: "free_tier_limit_zero", retryAfterMs: null };
	}
	if (status === 429 && (hasZeroQuotaLimit || zeroLimitMessage)) {
		return { code: "billing_required", providerStatus, detailCode: "quota_limit_zero", retryAfterMs: null };
	}
	if (regionUnsupported || ((status === 400 || status === 403) && regionMessage)) {
		return { code: "model_unavailable", providerStatus, detailCode: "region_unsupported", retryAfterMs: null };
	}
	if (
		keyDetail !== null ||
		status === 401 ||
		status === 403 ||
		(status === 400 && (keyInvalidMessage || keyExpiredMessage || serviceDisabledMessage))
	) {
		const resolvedKeyDetail =
			keyDetail ??
			(keyExpiredMessage
				? "api_key_expired"
				: serviceDisabledMessage
					? "service_disabled"
					: keyInvalidMessage
						? "api_key_invalid"
						: null);
		return { code: "key_rejected", providerStatus, detailCode: resolvedKeyDetail, retryAfterMs: null };
	}
	if (status === 429) {
		if (hasSpendQuota || spendMessage) {
			return { code: "quota_exhausted", providerStatus, detailCode: "spend_limit_reached", retryAfterMs: null };
		}
		if (hasDailyQuota || dailyMessage) {
			return { code: "quota_exhausted", providerStatus, detailCode: "daily_quota_exhausted", retryAfterMs: null };
		}
		return { code: "quota_exhausted", providerStatus, detailCode: "rate_limited", retryAfterMs };
	}
	if (status === 404 || providerStatus === "NOT_FOUND") {
		return { code: "model_unavailable", providerStatus, detailCode: "model_not_found", retryAfterMs: null };
	}
	if (status >= 500 && status <= 599) {
		return {
			code: "provider_outage",
			providerStatus,
			detailCode: status === 503 || providerStatus === "UNAVAILABLE" ? "overloaded" : null,
			retryAfterMs,
		};
	}
	return { code: "invalid_request", providerStatus, detailCode: null, retryAfterMs: null };
}

export async function readGeminiErrorSnippet(reply: Response): Promise<Uint8Array | undefined> {
	if (!reply.body) return undefined;
	const reader = reply.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < MAX_GEMINI_ERROR_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && value.byteLength > 0) {
				const take = Math.min(value.byteLength, MAX_GEMINI_ERROR_BYTES - total);
				chunks.push(take === value.byteLength ? value : value.subarray(0, take));
				total += take;
			}
		}
	} catch {
		return undefined;
	} finally {
		void reader.cancel().catch(() => undefined);
	}
	if (total === 0) return undefined;
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

export class GeminiKeyInvalidError extends Error {
	constructor(message = "Gemini API key was rejected by Google") {
		super(message);
		this.name = "GeminiKeyInvalidError";
	}
}

export function isGeminiApiKeyFormat(value: unknown): value is string {
	return typeof value === "string" && GEMINI_API_KEY.test(value);
}

export function geminiKeyHint(apiKey: string): string {
	if (!isGeminiApiKeyFormat(apiKey)) throw new Error("Gemini API key is invalid");
	const prefix = apiKey.startsWith("AQ.") ? "AQ" : apiKey.slice(0, 4);
	return `${prefix}...${apiKey.slice(-4)}`;
}

export function geminiNeonSpendMicrodollars(usage: {
	readonly inputTokens: number;
	readonly cachedTokens: number;
	readonly outputTokens: number;
}): number {
	const input = Math.max(0, Math.trunc(usage.inputTokens));
	const cached = Math.max(0, Math.min(input, Math.trunc(usage.cachedTokens)));
	const output = Math.max(0, Math.trunc(usage.outputTokens));
	const uncached = input - cached;
	return uncached * 3 + Math.floor((cached * 15 + 99) / 100) + output * 15;
}

export interface GeminiKeyVaultAuthority {
	describeGeminiKeyTicket(
		request: { ticketId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<unknown>;
	completeGeminiKeySave(
		completion: {
			ticketId: string;
			capabilitySha256: string;
			keyId: string;
			encryptedEnvelope: Uint8Array;
			envelopeSha256: string;
			keyHint: string;
		},
		signal: AbortSignal,
	): Promise<unknown>;
	openGeminiKeyForRun(binding: ModelLoginRunBinding, signal: AbortSignal): Promise<unknown>;
	describeGeminiKeyCheck?(
		request: { ticketId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<unknown>;
	completeGeminiKeyCheck?(
		completion: {
			ticketId: string;
			capabilitySha256: string;
			status: "ok" | "error";
			errorCode: GeminiProviderErrorCode | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface GeminiKeyChecked {
	readonly schema: "qorpera.gemini-key-checked/v1";
	readonly ok: boolean;
	readonly errorCode: GeminiProviderErrorCode | null;
	readonly errorDetail?: GeminiProviderErrorDetail | null;
	readonly checkedAt: string;
}

export type GeminiKeyCheckOutcome =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly errorCode: GeminiProviderErrorCode;
			readonly errorDetail?: GeminiProviderErrorDetail | null;
	  };

export interface GeminiKeySaved {
	readonly schema: "qorpera.gemini-key-saved/v1";
	readonly id: string;
	readonly keyHint: string;
	readonly defaultForChats: boolean;
	readonly monthlyCapCents: number | null;
	readonly version: number;
}

export type GeminiKeyForRun =
	| {
			readonly schema: "qorpera.gemini-key-for-run/v1";
			readonly state: "open";
			readonly geminiKeyId: string;
			readonly apiKey: string;
			readonly spendMonth: string;
			readonly monthSpendMicrodollars: number;
			readonly monthlyCapCents: number | null;
	  }
	| {
			readonly schema: "qorpera.gemini-key-for-run/v1";
			readonly state: "refused";
			readonly reason: "REVOKED";
	  }
	| {
			readonly schema: "qorpera.gemini-key-for-run/v1";
			readonly state: "refused";
			readonly reason: "CAP_REACHED";
			readonly spendMonth: string;
			readonly monthSpendMicrodollars: number;
			readonly monthlyCapCents: number;
	  };

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label} is invalid`);
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
	return value;
}

function optionalCap(value: unknown, label: string): number | null {
	if (value === null) return null;
	const cents = positiveInteger(value, label);
	if (cents < 100 || cents > 10_000_000) throw new Error(`${label} is invalid`);
	return cents;
}

function spendMonth(value: unknown, label: string): string {
	if (typeof value !== "string" || !MONTH_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

export async function verifyGeminiApiKey(
	apiKey: string,
	signal: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	if (!isGeminiApiKeyFormat(apiKey)) throw new GeminiKeyInvalidError("Gemini API key format is invalid");
	const answer = await fetcher(GEMINI_VERIFY_URL, {
		method: "GET",
		redirect: "error",
		headers: { "x-goog-api-key": apiKey },
		signal,
	});
	try {
		if (answer.status === 400 || answer.status === 401 || answer.status === 403)
			throw new GeminiKeyInvalidError("Google rejected this Gemini API key");
		if (!answer.ok) throw new Error("Gemini API key could not be verified right now");
	} finally {
		void answer.body?.cancel().catch(() => undefined);
	}
}

export async function checkGeminiApiKey(
	apiKey: string,
	signal: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<GeminiKeyCheckOutcome> {
	if (!isGeminiApiKeyFormat(apiKey)) {
		return { ok: false, errorCode: "key_rejected", errorDetail: "api_key_invalid" };
	}
	let answer: Response;
	try {
		answer = await fetcher(GEMINI_CHECK_GENERATE_URL, {
			method: "POST",
			redirect: "error",
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": apiKey,
			},
			body: GEMINI_CHECK_REQUEST_BODY,
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw error;
		return { ok: false, errorCode: "transport_unavailable", errorDetail: null };
	}
	if (answer.ok) {
		void answer.body?.cancel().catch(() => undefined);
		return { ok: true };
	}
	const snippet = await readGeminiErrorSnippet(answer);
	const classified = classifyGeminiHttpError(answer.status, snippet, answer.headers.get("retry-after"));
	return { ok: false, errorCode: classified.code, errorDetail: classified.detailCode };
}

export class CloudGeminiKeyVault {
	readonly #authority: GeminiKeyVaultAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #verifyKey: (apiKey: string, signal: AbortSignal) => Promise<void>;
	readonly #checkKey: (apiKey: string, signal: AbortSignal) => Promise<GeminiKeyCheckOutcome>;

	constructor(options: {
		authority: GeminiKeyVaultAuthority;
		keyring: CloudSecretKeyring;
		verifyKey?: (apiKey: string, signal: AbortSignal) => Promise<void>;
		checkKey?: (apiKey: string, signal: AbortSignal) => Promise<GeminiKeyCheckOutcome>;
	}) {
		this.#authority = options.authority;
		this.#keys = options.keyring;
		this.#verifyKey = options.verifyKey ?? ((apiKey, signal) => verifyGeminiApiKey(apiKey, signal));
		this.#checkKey = options.checkKey ?? ((apiKey, signal) => checkGeminiApiKey(apiKey, signal));
	}

	async saveFromTicket(
		request: { readonly ticketId: string; readonly capability: string; readonly apiKey: string },
		signal: AbortSignal,
	): Promise<GeminiKeySaved> {
		const label = "Gemini key capture";
		const ticketId = parseUuid(request.ticketId, label);
		if (typeof request.capability !== "string" || !CAPABILITY.test(request.capability))
			throw new Error(`${label} is invalid`);
		const apiKey = typeof request.apiKey === "string" ? request.apiKey.trim() : "";
		if (!isGeminiApiKeyFormat(apiKey)) throw new GeminiKeyInvalidError("Gemini API key format is invalid");
		const capabilitySha256 = createHash("sha256").update(request.capability).digest("hex");
		const described = parseRecord(
			await this.#authority.describeGeminiKeyTicket({ ticketId, capabilitySha256 }, signal),
			label,
		);
		exactKeys(
			described,
			[
				"schema",
				"ticketId",
				"profileId",
				"ownerUserId",
				"geminiKeyId",
				"keyId",
				"defaultForChats",
				"monthlyCapCents",
				"expiresAt",
			],
			label,
		);
		if (
			described.schema !== "qorpera.gemini-key-ticket-description/v1" ||
			parseUuid(described.ticketId, label) !== ticketId ||
			typeof described.keyId !== "string" ||
			!KEY_ID.test(described.keyId)
		)
			throw new Error(`${label} is invalid`);
		const ownerUserId = parseUuid(described.ownerUserId, label);
		const geminiKeyId = parseUuid(described.geminiKeyId, label);
		const keyId = described.keyId;
		if (!this.#keys.hasMemberKey(keyId)) throw new Error("The vault does not keep member Gemini keys");
		await this.#verifyKey(apiKey, signal);
		const keyHint = geminiKeyHint(apiKey);
		const envelope = this.#keys.sealMember(
			{ [GEMINI_API_KEY_FIELD]: apiKey },
			{ memberId: ownerUserId, loginId: geminiKeyId, version: 1, keyId },
		);
		const envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
		let saved: Record<string, unknown>;
		try {
			saved = parseRecord(
				await this.#authority.completeGeminiKeySave(
					{ ticketId, capabilitySha256, keyId, encryptedEnvelope: envelope, envelopeSha256, keyHint },
					signal,
				),
				label,
			);
		} finally {
			envelope.fill(0);
		}
		exactKeys(saved, ["schema", "id", "keyHint", "defaultForChats", "monthlyCapCents", "version"], label);
		if (
			saved.schema !== "qorpera.gemini-key-saved/v1" ||
			parseUuid(saved.id, label) !== geminiKeyId ||
			typeof saved.keyHint !== "string" ||
			typeof saved.defaultForChats !== "boolean"
		)
			throw new Error(`${label} is invalid`);
		return {
			schema: "qorpera.gemini-key-saved/v1",
			id: geminiKeyId,
			keyHint: saved.keyHint,
			defaultForChats: saved.defaultForChats,
			monthlyCapCents: optionalCap(saved.monthlyCapCents, label),
			version: positiveInteger(saved.version, label),
		};
	}

	async checkFromTicket(
		request: { readonly ticketId: string; readonly capability: string },
		signal: AbortSignal,
	): Promise<GeminiKeyChecked> {
		const label = "Gemini key check";
		if (!this.#authority.describeGeminiKeyCheck || !this.#authority.completeGeminiKeyCheck) {
			throw new Error("The vault does not support Gemini key checks");
		}
		const ticketId = parseUuid(request.ticketId, label);
		if (typeof request.capability !== "string" || !CAPABILITY.test(request.capability))
			throw new Error(`${label} is invalid`);
		const capabilitySha256 = createHash("sha256").update(request.capability).digest("hex");
		const described = parseRecord(
			await this.#authority.describeGeminiKeyCheck({ ticketId, capabilitySha256 }, signal),
			label,
		);
		exactKeys(
			described,
			[
				"schema",
				"ticketId",
				"profileId",
				"ownerUserId",
				"geminiKeyId",
				"keyId",
				"version",
				"envelopeSha256",
				"encryptedEnvelopeBase64",
			],
			label,
		);
		if (
			described.schema !== "qorpera.gemini-key-check-description/v1" ||
			parseUuid(described.ticketId, label) !== ticketId ||
			typeof described.keyId !== "string" ||
			!KEY_ID.test(described.keyId) ||
			typeof described.envelopeSha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(described.envelopeSha256) ||
			typeof described.encryptedEnvelopeBase64 !== "string"
		)
			throw new Error(`${label} is invalid`);
		const memberId = parseUuid(described.ownerUserId, label);
		const geminiKeyId = parseUuid(described.geminiKeyId, label);
		positiveInteger(described.version, label);
		const keyId = described.keyId;
		if (!this.#keys.hasMemberKey(keyId)) throw new Error("The vault does not keep member Gemini keys");
		const envelope = Buffer.from(described.encryptedEnvelopeBase64, "base64");
		let outcome: GeminiKeyCheckOutcome;
		try {
			if (
				envelope.byteLength < 1 ||
				createHash("sha256").update(envelope).digest("hex") !== described.envelopeSha256
			)
				throw new Error(`${label} is invalid`);
			outcome = await this.#keys.useMember(
				envelope,
				{ memberId, loginId: geminiKeyId, version: 1, keyId },
				async (fields) => {
					const value = fields[GEMINI_API_KEY_FIELD];
					if (Object.keys(fields).length !== 1 || !isGeminiApiKeyFormat(value))
						throw new Error("Gemini key envelope is invalid");
					return this.#checkKey(value, signal);
				},
			);
		} finally {
			envelope.fill(0);
		}
		const completed = parseRecord(
			await this.#authority.completeGeminiKeyCheck(
				{
					ticketId,
					capabilitySha256,
					status: outcome.ok ? "ok" : "error",
					errorCode: outcome.ok ? null : outcome.errorCode,
				},
				signal,
			),
			label,
		);
		exactKeys(completed, ["schema", "ok", "errorCode", "checkedAt"], label);
		if (
			completed.schema !== "qorpera.gemini-key-checked/v1" ||
			typeof completed.ok !== "boolean" ||
			typeof completed.checkedAt !== "string" ||
			!Number.isFinite(Date.parse(completed.checkedAt)) ||
			(completed.errorCode !== null &&
				(typeof completed.errorCode !== "string" ||
					!(GEMINI_PROVIDER_ERROR_CODES as readonly string[]).includes(completed.errorCode)))
		)
			throw new Error(`${label} is invalid`);
		const errorDetail = !outcome.ok && outcome.errorDetail ? outcome.errorDetail : null;
		return {
			schema: "qorpera.gemini-key-checked/v1",
			ok: completed.ok,
			errorCode: completed.errorCode as GeminiProviderErrorCode | null,
			...(errorDetail ? { errorDetail } : {}),
			checkedAt: completed.checkedAt,
		};
	}

	async open(binding: ModelLoginRunBinding, signal: AbortSignal): Promise<GeminiKeyForRun> {
		const label = "Gemini key for a run";
		const answer = parseRecord(
			await this.#authority.openGeminiKeyForRun(parseModelLoginRunBinding(binding), signal),
			label,
		);
		if (answer.schema !== "qorpera.gemini-key-for-run/v1") throw new Error(`${label} is invalid`);
		if (answer.state === "refused") {
			if (answer.reason === "REVOKED") {
				exactKeys(answer, ["schema", "state", "reason"], label);
				return { schema: "qorpera.gemini-key-for-run/v1", state: "refused", reason: "REVOKED" };
			}
			if (answer.reason === "CAP_REACHED") {
				exactKeys(
					answer,
					["schema", "state", "reason", "spendMonth", "monthSpendMicrodollars", "monthlyCapCents"],
					label,
				);
				const cap = optionalCap(answer.monthlyCapCents, label);
				if (cap === null) throw new Error(`${label} is invalid`);
				return {
					schema: "qorpera.gemini-key-for-run/v1",
					state: "refused",
					reason: "CAP_REACHED",
					spendMonth: spendMonth(answer.spendMonth, label),
					monthSpendMicrodollars: nonNegativeInteger(answer.monthSpendMicrodollars, label),
					monthlyCapCents: cap,
				};
			}
			throw new Error(`${label} is invalid`);
		}
		exactKeys(
			answer,
			[
				"schema",
				"state",
				"geminiKeyId",
				"ownerUserId",
				"keyId",
				"version",
				"envelopeSha256",
				"encryptedEnvelopeBase64",
				"spendMonth",
				"monthSpendMicrodollars",
				"monthlyCapCents",
			],
			label,
		);
		if (
			answer.state !== "open" ||
			typeof answer.keyId !== "string" ||
			!KEY_ID.test(answer.keyId) ||
			typeof answer.envelopeSha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(answer.envelopeSha256) ||
			typeof answer.encryptedEnvelopeBase64 !== "string"
		)
			throw new Error(`${label} is invalid`);
		const geminiKeyId = parseUuid(answer.geminiKeyId, label);
		const memberId = parseUuid(answer.ownerUserId, label);
		positiveInteger(answer.version, label);
		const keyId = answer.keyId;
		const envelopeSha256 = answer.envelopeSha256;
		const month = spendMonth(answer.spendMonth, label);
		const spend = nonNegativeInteger(answer.monthSpendMicrodollars, label);
		const monthlyCapCents = optionalCap(answer.monthlyCapCents, label);
		if (!this.#keys.hasMemberKey(keyId)) throw new Error("The vault does not keep member Gemini keys");
		const envelope = Buffer.from(answer.encryptedEnvelopeBase64, "base64");
		try {
			if (envelope.byteLength < 1 || createHash("sha256").update(envelope).digest("hex") !== envelopeSha256)
				throw new Error(`${label} is invalid`);
			const apiKey = await this.#keys.useMember(
				envelope,
				{ memberId, loginId: geminiKeyId, version: 1, keyId },
				async (fields) => {
					const value = fields[GEMINI_API_KEY_FIELD];
					if (Object.keys(fields).length !== 1 || !isGeminiApiKeyFormat(value))
						throw new Error("Gemini key envelope is invalid");
					return value;
				},
			);
			return {
				schema: "qorpera.gemini-key-for-run/v1",
				state: "open",
				geminiKeyId,
				apiKey,
				spendMonth: month,
				monthSpendMicrodollars: spend,
				monthlyCapCents,
			};
		} finally {
			envelope.fill(0);
		}
	}
}
