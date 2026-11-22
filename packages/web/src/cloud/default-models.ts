import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import { withScopedCloudDeadline } from "./abort-scope.ts";
import { type Cloud, CloudRpcError } from "./client.ts";
import { boundedInteger, CloudShapeError, nonEmptyString, record, UUID_PATTERN } from "./parse.ts";
import { EFFORTS_BEFORE_LIST, modelProvider, PROVIDER_EFFORTS, type SessionEffort } from "./session-model.ts";

export class DefaultModelsStaleError extends Error {
	constructor(message = "Default model settings changed elsewhere.") {
		super(message);
		this.name = "DefaultModelsStaleError";
	}
}

export class DefaultModelsUnavailableError extends Error {
	constructor(message = "Connect that provider in Settings before selecting it as a default.") {
		super(message);
		this.name = "DefaultModelsUnavailableError";
	}
}

export interface MemberDefaultModels {
	conversationModel: string;
	conversationEffort: SessionEffort;
	codingModel: string;
	codingEffort: SessionEffort;
	storedConversationModel: string | null;
	storedCodingModel: string | null;
	conversationModels: readonly string[];
	codingModels: readonly string[];
	conversationEfforts: Readonly<Record<string, readonly SessionEffort[]>>;
	codingEfforts: Readonly<Record<string, readonly SessionEffort[]>>;
	version: number;
}

export interface MemberDefaultModelsUpdate {
	conversationModel?: string;
	conversationEffort?: SessionEffort;
	codingModel?: string;
	codingEffort?: SessionEffort;
	expectedVersion: number;
}

export interface WebDefaultModels {
	read(signal?: AbortSignal): Promise<MemberDefaultModels>;
	set(update: MemberDefaultModelsUpdate, signal?: AbortSignal): Promise<MemberDefaultModels>;
}

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

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

function parseEffort(value: unknown, label: string): SessionEffort {
	if (typeof value !== "string" || !VALID_EFFORTS.has(value)) {
		throw new CloudShapeError(label);
	}
	return value as SessionEffort;
}

function parseModelList(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
		throw new CloudShapeError(label);
	}
	const models: string[] = [];
	for (const entry of value) {
		const id = nonEmptyString(entry, label, 128);
		if (!models.includes(id)) models.push(id);
	}
	return models;
}

function parseEffortMap(value: unknown, label: string): Readonly<Record<string, readonly SessionEffort[]>> {
	const input = record(value, label);
	const entries = Object.entries(input);
	if (entries.length > 32) throw new CloudShapeError(label);
	const out: Record<string, readonly SessionEffort[]> = {};
	for (const [modelId, list] of entries) {
		nonEmptyString(modelId, label, 128);
		if (!Array.isArray(list) || list.length === 0 || list.length > 16) {
			throw new CloudShapeError(label);
		}
		const efforts: SessionEffort[] = [];
		for (const item of list) {
			const effort = parseEffort(item, label);
			if (!efforts.includes(effort)) efforts.push(effort);
		}
		out[modelId] = efforts;
	}
	return out;
}

function parseOptionalModel(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	return nonEmptyString(value, label, 128);
}

const CODING_EFFORTS_BEFORE_LIST: Record<ReturnType<typeof modelProvider>, readonly SessionEffort[]> = {
	openai: ["low", "medium", "high"],
	anthropic: ["low", "medium", "high", "xhigh", "max"],
	google: ["low", "medium", "high", "xhigh"],
};

export function defaultModelEfforts(
	state: MemberDefaultModels | undefined,
	kind: "conversation" | "coding",
	modelId: string,
): readonly SessionEffort[] {
	const provider = modelProvider(modelId);
	const listed = kind === "coding" ? state?.codingEfforts[modelId] : state?.conversationEfforts[modelId];
	const allowedByProvider = kind === "coding" ? CODING_EFFORTS_BEFORE_LIST[provider] : PROVIDER_EFFORTS[provider];
	const offered = listed ? allowedByProvider.filter((effort) => listed.includes(effort)) : [];
	if (offered.length > 0) return offered;
	return kind === "coding" ? CODING_EFFORTS_BEFORE_LIST[provider] : EFFORTS_BEFORE_LIST[provider];
}

export function parseMemberDefaultModels(value: unknown): MemberDefaultModels {
	const input = record(value, "default models");
	if (input.schema !== "qorpera.member-default-models/v1") {
		throw new CloudShapeError("default models");
	}
	return {
		conversationModel: nonEmptyString(input.conversationModel, "conversation default model", 128),
		conversationEffort: parseEffort(input.conversationEffort, "conversation default effort"),
		codingModel: nonEmptyString(input.codingModel, "coding default model", 128),
		codingEffort: parseEffort(input.codingEffort, "coding default effort"),
		storedConversationModel: parseOptionalModel(input.storedConversationModel, "stored conversation model"),
		storedCodingModel: parseOptionalModel(input.storedCodingModel, "stored coding model"),
		conversationModels: parseModelList(input.conversationModels, "conversation models"),
		codingModels: parseModelList(input.codingModels, "coding models"),
		conversationEfforts: parseEffortMap(input.conversationEfforts, "conversation model efforts"),
		codingEfforts: parseEffortMap(input.codingEfforts, "coding model efforts"),
		version: boundedInteger(input.version, "default models version", 0, Number.MAX_SAFE_INTEGER),
	};
}

export function createWebDefaultModels(
	cloud: Cloud,
	profileId: string | null,
	memberId: string,
	companySignal: AbortSignal,
	current: () => void,
	fetchImplementation: typeof fetch = fetch,
): WebDefaultModels {
	const origin = parseHttpsOrigin(cloud.config.projectUrl, "cloud origin");
	if ((profileId !== null && !UUID_PATTERN.test(profileId)) || !UUID_PATTERN.test(memberId)) {
		throw new Error("Invalid default model configuration.");
	}
	const normalizedProfileId = profileId === null ? null : profileId.toLowerCase();

	const rpc = async (method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
		return withScopedCloudDeadline(
			[companySignal, signal],
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
					throw new Error("Sign in again to manage default models.");
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
					const bytes = await readBoundedCloudResponse(response, 32768, deadline);
					let value: unknown = null;
					try {
						value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
					} catch {
						value = null;
					}
					check();
					if (response.status !== 200) {
						const body =
							value && typeof value === "object" && !Array.isArray(value)
								? (value as Record<string, unknown>)
								: {};
						const code = typeof body.code === "string" ? body.code : undefined;
						if (code === "QRC01") {
							throw new DefaultModelsStaleError();
						}
						if (code === "QRC02") {
							throw new DefaultModelsUnavailableError();
						}
						if (response.status === 401 || response.status === 403) {
							throw new CloudRpcError(
								method,
								{ code: "42501", message: "You do not have permission to manage default models." },
								response.status,
							);
						}
						throw new CloudRpcError(
							method,
							{
								code,
								message: typeof body.message === "string" ? body.message : "Default models request failed.",
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
		);
	};

	return {
		read: async (signal) => {
			return parseMemberDefaultModels(
				await rpc("qorpera_get_member_default_models", { p_profile_id: normalizedProfileId }, signal),
			);
		},
		set: async (update, signal) => {
			if (!Number.isSafeInteger(update.expectedVersion) || update.expectedVersion < 0) {
				throw new Error("Invalid default models version.");
			}
			const raw = await rpc(
				"qorpera_set_member_default_models",
				{
					p_profile_id: normalizedProfileId,
					p_conversation_model: update.conversationModel ?? null,
					p_conversation_effort: update.conversationEffort ?? null,
					p_coding_model: update.codingModel ?? null,
					p_coding_effort: update.codingEffort ?? null,
					p_expected_version: update.expectedVersion,
				},
				signal,
			);
			return parseMemberDefaultModels(raw);
		},
	};
}
