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
const GEMINI_CHECK_MODEL_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon";
const MAX_GEMINI_ERROR_BYTES = 8 * 1024;

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
]);

const KEY_REJECTED_REASONS = new Set(["API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_SERVICE_BLOCKED"]);

export function classifyGeminiHttpError(
	status: number,
	bodyBytes?: Uint8Array,
): { readonly code: GeminiProviderErrorCode; readonly providerStatus: string | null } {
	let providerStatus: string | null = null;
	let billingReason = false;
	let keyRejectedReason = false;
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
				if (Array.isArray(errObj.details)) {
					for (const detail of errObj.details.slice(0, 8)) {
						if (
							detail &&
							typeof detail === "object" &&
							!Array.isArray(detail) &&
							typeof (detail as Record<string, unknown>).reason === "string"
						) {
							const reason = (detail as Record<string, unknown>).reason as string;
							if (BILLING_REASONS.has(reason)) {
								billingReason = true;
								break;
							}
							if (KEY_REJECTED_REASONS.has(reason)) {
								keyRejectedReason = true;
							}
						}
					}
				}
			}
		} catch {}
	}
	if (status === 402 || billingReason) return { code: "billing_required", providerStatus };
	if (keyRejectedReason || status === 401 || status === 403) return { code: "key_rejected", providerStatus };
	if (status === 429) return { code: "quota_exhausted", providerStatus };
	if (status === 404) return { code: "model_unavailable", providerStatus };
	if (status >= 500 && status <= 599) return { code: "provider_outage", providerStatus };
	return { code: "invalid_request", providerStatus };
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
	readonly checkedAt: string;
}

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
): Promise<{ readonly ok: true } | { readonly ok: false; readonly errorCode: GeminiProviderErrorCode }> {
	if (!isGeminiApiKeyFormat(apiKey)) return { ok: false, errorCode: "key_rejected" };
	let answer: Response;
	try {
		answer = await fetcher(GEMINI_CHECK_MODEL_URL, {
			method: "GET",
			redirect: "error",
			headers: { "x-goog-api-key": apiKey },
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw error;
		return { ok: false, errorCode: "transport_unavailable" };
	}
	if (answer.ok) {
		void answer.body?.cancel().catch(() => undefined);
		return { ok: true };
	}
	const snippet = await readGeminiErrorSnippet(answer);
	const classified = classifyGeminiHttpError(answer.status, snippet);
	return { ok: false, errorCode: classified.code };
}

export class CloudGeminiKeyVault {
	readonly #authority: GeminiKeyVaultAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #verifyKey: (apiKey: string, signal: AbortSignal) => Promise<void>;
	readonly #checkKey: (
		apiKey: string,
		signal: AbortSignal,
	) => Promise<{ readonly ok: true } | { readonly ok: false; readonly errorCode: GeminiProviderErrorCode }>;

	constructor(options: {
		authority: GeminiKeyVaultAuthority;
		keyring: CloudSecretKeyring;
		verifyKey?: (apiKey: string, signal: AbortSignal) => Promise<void>;
		checkKey?: (
			apiKey: string,
			signal: AbortSignal,
		) => Promise<{ readonly ok: true } | { readonly ok: false; readonly errorCode: GeminiProviderErrorCode }>;
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
		let outcome: { readonly ok: true } | { readonly ok: false; readonly errorCode: GeminiProviderErrorCode };
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
		return {
			schema: "qorpera.gemini-key-checked/v1",
			ok: completed.ok,
			errorCode: completed.errorCode as GeminiProviderErrorCode | null,
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
