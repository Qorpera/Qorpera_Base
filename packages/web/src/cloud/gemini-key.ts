import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type Cloud, CloudRpcError } from "./client.ts";
import { boundedInteger, CloudShapeError, nonEmptyString, record, timestamp, UUID_PATTERN, uuid } from "./parse.ts";

export const GEMINI_MIN_CAP_CENTS = 100;
export const GEMINI_MAX_CAP_CENTS = 10_000_000;

const GEMINI_API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{20,200}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export class GeminiKeyInvalidError extends Error {
	constructor(message = "Google rejected this Gemini API key.") {
		super(message);
		this.name = "GeminiKeyInvalidError";
	}
}

export class GeminiKeyStaleError extends Error {
	constructor(message = "Gemini key settings changed elsewhere.") {
		super(message);
		this.name = "GeminiKeyStaleError";
	}
}

export interface GeminiKeyInfo {
	id: string;
	keyHint: string;
	defaultForChats: boolean;
	monthlyCapCents: number | null;
	spendMonth: string;
	monthSpendMicrodollars: number;
	monthInputTokens: number;
	monthCachedTokens: number;
	monthOutputTokens: number;
	capReached: boolean;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface GeminiKeyState {
	vaultAvailable: boolean;
	key: GeminiKeyInfo | null;
}

export interface GeminiKeySaveInput {
	apiKey: string;
	defaultForChats: boolean;
	monthlyCapCents: number | null;
}

export interface GeminiKeySettingsInput {
	defaultForChats: boolean;
	monthlyCapCents: number | null;
	expectedVersion: number;
}

export interface WebGeminiKey {
	read(signal?: AbortSignal): Promise<GeminiKeyState>;
	save(input: GeminiKeySaveInput, signal?: AbortSignal): Promise<GeminiKeyState>;
	updateSettings(input: GeminiKeySettingsInput, signal?: AbortSignal): Promise<GeminiKeyState>;
	revoke(signal?: AbortSignal): Promise<GeminiKeyState>;
}

export function geminiKeyLooksValid(value: string): boolean {
	return GEMINI_API_KEY_PATTERN.test(value.trim());
}

export function formatUsdMicrodollars(microdollars: number): string {
	const safe = Number.isFinite(microdollars) && microdollars > 0 ? microdollars : 0;
	return `$${(safe / 1_000_000).toFixed(2)}`;
}

export function formatUsdCents(cents: number): string {
	const safe = Number.isFinite(cents) && cents > 0 ? cents : 0;
	return safe % 100 === 0 ? `$${(safe / 100).toFixed(0)}` : `$${(safe / 100).toFixed(2)}`;
}

function validateMonthlyCapCents(value: number | null): number | null {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || value < GEMINI_MIN_CAP_CENTS || value > GEMINI_MAX_CAP_CENTS) {
		throw new Error("Invalid monthly spend cap.");
	}
	return value;
}

function parseHttpsOrigin(value: unknown, label: string): string {
	const raw = nonEmptyString(value, label, 2048);
	const parsed = new URL(raw);
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new CloudShapeError(label);
	}
	return parsed.origin;
}

export function parseGeminiKeyState(value: unknown): GeminiKeyState {
	const input = record(value, "gemini key state");
	if (input.schema !== "qorpera.gemini-key/v1" || typeof input.vaultAvailable !== "boolean") {
		throw new CloudShapeError("gemini key state");
	}
	if (input.key === null) {
		return { vaultAvailable: input.vaultAvailable, key: null };
	}
	const key = record(input.key, "gemini key");
	if (
		typeof key.defaultForChats !== "boolean" ||
		typeof key.capReached !== "boolean" ||
		typeof key.spendMonth !== "string" ||
		!MONTH_PATTERN.test(key.spendMonth)
	) {
		throw new CloudShapeError("gemini key");
	}
	const monthlyCapCents =
		key.monthlyCapCents === null
			? null
			: boundedInteger(key.monthlyCapCents, "gemini monthly cap", GEMINI_MIN_CAP_CENTS, GEMINI_MAX_CAP_CENTS);
	return {
		vaultAvailable: input.vaultAvailable,
		key: {
			id: uuid(key.id, "gemini key id"),
			keyHint: nonEmptyString(key.keyHint, "gemini key hint", 16),
			defaultForChats: key.defaultForChats,
			monthlyCapCents,
			spendMonth: key.spendMonth,
			monthSpendMicrodollars: boundedInteger(
				key.monthSpendMicrodollars,
				"gemini month spend",
				0,
				Number.MAX_SAFE_INTEGER,
			),
			monthInputTokens: boundedInteger(key.monthInputTokens, "gemini input tokens", 0, Number.MAX_SAFE_INTEGER),
			monthCachedTokens: boundedInteger(key.monthCachedTokens, "gemini cached tokens", 0, Number.MAX_SAFE_INTEGER),
			monthOutputTokens: boundedInteger(key.monthOutputTokens, "gemini output tokens", 0, Number.MAX_SAFE_INTEGER),
			capReached: key.capReached,
			version: boundedInteger(key.version, "gemini key version", 1, Number.MAX_SAFE_INTEGER),
			createdAt: timestamp(key.createdAt, "gemini key creation time"),
			updatedAt: timestamp(key.updatedAt, "gemini key update time"),
		},
	};
}

interface GeminiKeyTicket {
	ticketId: string;
	capability: string;
	serviceOrigin: string;
	profileId: string;
}

function parseGeminiKeyTicket(value: unknown, expectedProfileId: string): GeminiKeyTicket {
	const input = record(value, "gemini key ticket");
	if (
		input.schema !== "qorpera.gemini-key-ticket/v1" ||
		typeof input.capability !== "string" ||
		!CAPABILITY_PATTERN.test(input.capability)
	) {
		throw new CloudShapeError("gemini key ticket");
	}
	const profileId = uuid(input.profileId, "gemini key ticket profile");
	if (profileId !== expectedProfileId.toLowerCase()) {
		throw new CloudShapeError("gemini key ticket profile");
	}
	return {
		ticketId: uuid(input.ticketId, "gemini key ticket id"),
		capability: input.capability,
		serviceOrigin: parseHttpsOrigin(input.serviceOrigin, "gemini key broker origin"),
		profileId,
	};
}

export function createWebGeminiKey(
	cloud: Cloud,
	profileId: string,
	memberId: string,
	companySignal: AbortSignal,
	current: () => void,
	fetchImplementation: typeof fetch = fetch,
): WebGeminiKey {
	const origin = parseHttpsOrigin(cloud.config.projectUrl, "cloud origin");
	if (!UUID_PATTERN.test(profileId) || !UUID_PATTERN.test(memberId)) {
		throw new Error("Invalid Gemini key configuration.");
	}
	const normalizedProfileId = profileId.toLowerCase();

	const rpc = async (method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
		return withCloudDeadline(
			async (deadline) => {
				const check = () => {
					deadline.throwIfAborted();
					current();
				};
				check();
				const { data, error } = await cloud.supabase.auth.getSession();
				check();
				if (
					error ||
					!data.session ||
					data.session.user.id !== memberId ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				) {
					throw new Error("Sign in again to manage your Gemini API key.");
				}
				const response = await fetchImplementation(`${origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${data.session.access_token}`,
						apikey: cloud.config.publishableKey,
						"content-type": "application/json",
					},
					body: JSON.stringify(args),
					signal: deadline,
					redirect: "error",
					credentials: "omit",
				});
				cloud.noticeResponse?.(`${origin}/rest/v1/rpc/${method}`, data.session.access_token, response);
				try {
					check();
					if (response.status === 401 || response.status === 403) {
						throw new CloudRpcError(
							method,
							{ code: "42501", message: "You do not have permission to manage this Gemini API key." },
							response.status,
						);
					}
					const value: unknown = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 32768, deadline),
						),
					);
					check();
					if (response.status !== 200) {
						const body =
							value && typeof value === "object" && !Array.isArray(value)
								? (value as Record<string, unknown>)
								: {};
						throw new CloudRpcError(
							method,
							{
								code: typeof body.code === "string" ? body.code : undefined,
								message: typeof body.message === "string" ? body.message : "The Gemini API key request failed.",
							},
							response.status,
						);
					}
					return value;
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}
			},
			15_000,
			AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
		);
	};

	const read = async (signal?: AbortSignal): Promise<GeminiKeyState> => {
		return parseGeminiKeyState(await rpc("qorpera_get_gemini_key", { p_profile_id: normalizedProfileId }, signal));
	};

	return {
		read,
		save: async (input, signal) => {
			const apiKey = input.apiKey.trim();
			if (!geminiKeyLooksValid(apiKey)) {
				throw new GeminiKeyInvalidError();
			}
			const monthlyCapCents = validateMonthlyCapCents(input.monthlyCapCents);
			const ticket = parseGeminiKeyTicket(
				await rpc(
					"qorpera_begin_gemini_key_save",
					{
						p_profile_id: normalizedProfileId,
						p_default_for_chats: input.defaultForChats,
						p_monthly_cap_cents: monthlyCapCents,
					},
					signal,
				),
				normalizedProfileId,
			);
			await withCloudDeadline(
				async (deadline) => {
					const check = () => {
						deadline.throwIfAborted();
						current();
					};
					check();
					const response = await fetchImplementation(
						`${ticket.serviceOrigin}/v1/gemini-keys/${ticket.ticketId}?company=${normalizedProfileId}`,
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								schema: "qorpera.gemini-key-save-request/v1",
								capability: ticket.capability,
								apiKey,
							}),
							signal: deadline,
							redirect: "error",
							credentials: "omit",
						},
					);
					try {
						check();
						const bytes = await readBoundedCloudResponse(response, 32768, deadline);
						let parsed: unknown = null;
						try {
							parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
						} catch {
							parsed = null;
						}
						if (
							response.status === 403 &&
							parsed &&
							typeof parsed === "object" &&
							!Array.isArray(parsed) &&
							(parsed as Record<string, unknown>).reason === "invalid_key"
						) {
							throw new GeminiKeyInvalidError();
						}
						if (response.status !== 200) {
							throw new Error("The Gemini API key could not be saved.");
						}
					} finally {
						if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
					}
				},
				30_000,
				AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
			);
			return read(signal);
		},
		updateSettings: async (input, signal) => {
			const monthlyCapCents = validateMonthlyCapCents(input.monthlyCapCents);
			if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
				throw new Error("Invalid Gemini key version.");
			}
			try {
				const raw = await rpc(
					"qorpera_update_gemini_key_settings",
					{
						p_profile_id: normalizedProfileId,
						p_default_for_chats: input.defaultForChats,
						p_monthly_cap_cents: monthlyCapCents,
						p_expected_version: input.expectedVersion,
					},
					signal,
				);
				return parseGeminiKeyState(raw);
			} catch (error) {
				if (error instanceof CloudRpcError && error.code === "QRC01") {
					throw new GeminiKeyStaleError();
				}
				throw error;
			}
		},
		revoke: async (signal) => {
			const raw = await rpc("qorpera_revoke_gemini_key", { p_profile_id: normalizedProfileId }, signal);
			return parseGeminiKeyState(raw);
		},
	};
}
