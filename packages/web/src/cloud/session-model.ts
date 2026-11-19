import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type Cloud, CloudRpcError } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

export const SESSION_PROVIDERS = ["openai", "anthropic"] as const;
export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

export const SESSION_MODELS = [
	{ id: "gpt-6.2-sol", name: "GPT-6.2 Sol", provider: "openai" },
	{ id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai" },
	// WHY: a cloud before 20260930816000 still offers GPT-6.1 Sol; the list shows only the models the cloud names.
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai" },
	{ id: "claude-fable-5-2", name: "Fable 5.2", provider: "anthropic" },
	{ id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic" },
] as const satisfies ReadonlyArray<{ id: string; name: string; provider: SessionProvider }>;

export const EARLIER_MODEL_NAMES: Readonly<Record<string, string>> = {
	"gpt-6-sol": "GPT-6 Sol",
	"gpt-6-luna": "GPT-6 Luna",
};

export const MODELS_BEFORE_LIST: readonly string[] = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];

export function modelName(modelId: string): string {
	return SESSION_MODELS.find((model) => model.id === modelId)?.name ?? EARLIER_MODEL_NAMES[modelId] ?? modelId;
}

/** The only listed model a cloud without per-conversation effort accepts. */
export const SESSION_MODEL_BEFORE_EFFORT = "gpt-6-astra";

export const SESSION_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type SessionEffort = (typeof SESSION_EFFORTS)[number];

export const PROVIDER_EFFORTS: Record<SessionProvider, readonly SessionEffort[]> = {
	openai: ["low", "medium", "high", "xhigh"],
	anthropic: ["low", "medium", "high", "xhigh", "max"],
};

export const EFFORTS_BEFORE_LIST: Record<SessionProvider, readonly SessionEffort[]> = {
	openai: ["low", "medium", "high"],
	anthropic: ["low", "medium", "high", "xhigh", "max"],
};

export function modelProvider(modelId: string | undefined): SessionProvider {
	return SESSION_MODELS.find((model) => model.id === modelId)?.provider ?? "openai";
}

export function modelEfforts(
	observed: SessionModel | undefined,
	modelId: string | undefined,
): readonly SessionEffort[] {
	const provider = modelProvider(modelId);
	const listed = modelId !== undefined && observed?.efforts ? observed.efforts[modelId] : undefined;
	const offered = listed ? PROVIDER_EFFORTS[provider].filter((effort) => listed.includes(effort)) : [];
	return offered.length > 0 ? offered : EFFORTS_BEFORE_LIST[provider];
}

/** Fast is the provider's priority tier; standard turns it off. */
export const SESSION_SERVICE_TIERS = ["fast", "standard"] as const;

export interface SessionModel {
	sessionId: string;
	/** Absent in a group chat where no model was chosen: each agent runs its own. */
	modelId?: string;
	/** Absent while the cloud predates per-conversation effort. */
	reasoningEffort?: string;
	/** Absent while the cloud does not run conversations on the Fast tier. */
	serviceTier?: string;
	models?: readonly string[];
	efforts?: Readonly<Record<string, readonly string[]>>;
	version: number;
}

/** What the member changed: an omitted model, effort or speed keeps the
 * conversation's own (a cloud without effort accepts only a model). The speed
 * is saved on its own, never together with a model or an effort. */
export interface SessionModelSelection {
	modelId?: string;
	reasoningEffort?: string;
	serviceTier?: string;
}

export interface WebSessionModel {
	read(sessionId: string, signal?: AbortSignal): Promise<SessionModel>;
	set(
		sessionId: string,
		selection: SessionModelSelection,
		expectedVersion: number,
		signal?: AbortSignal,
	): Promise<SessionModel>;
}

/** The cloud owns this conversation's override; reads retain unfamiliar models,
 * efforts and speeds so the selector never misrepresents an existing setting. */
export function createWebSessionModel(
	cloud: Cloud,
	memberId: string,
	companySignal: AbortSignal,
	current: (sessionId: string) => void,
): WebSessionModel {
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		!UUID_PATTERN.test(memberId)
	)
		throw new Error("Invalid conversation model configuration.");
	const request = async (
		sessionId: string,
		selection?: SessionModelSelection & { expectedVersion: number },
		signal?: AbortSignal,
	): Promise<SessionModel> => {
		if (!UUID_PATTERN.test(sessionId)) throw new Error("Invalid conversation identity.");
		if (
			selection &&
			((selection.modelId === undefined &&
				selection.reasoningEffort === undefined &&
				selection.serviceTier === undefined) ||
				(selection.modelId !== undefined && !SESSION_MODELS.some((model) => model.id === selection.modelId)) ||
				(selection.reasoningEffort !== undefined &&
					!(PROVIDER_EFFORTS[modelProvider(selection.modelId)] as readonly string[]).includes(
						selection.reasoningEffort,
					) &&
					(selection.modelId !== undefined ||
						!(SESSION_EFFORTS as readonly string[]).includes(selection.reasoningEffort))) ||
				(selection.serviceTier !== undefined &&
					(!(SESSION_SERVICE_TIERS as readonly string[]).includes(selection.serviceTier) ||
						selection.modelId !== undefined ||
						selection.reasoningEffort !== undefined)) ||
				!Number.isSafeInteger(selection.expectedVersion) ||
				selection.expectedVersion < 0 ||
				selection.expectedVersion === Number.MAX_SAFE_INTEGER)
		)
			throw new Error("Invalid conversation model selection.");
		const method = !selection
			? "qorpera_get_session_model"
			: selection.serviceTier !== undefined
				? "qorpera_set_session_service_tier"
				: "qorpera_set_session_model";
		return withCloudDeadline(
			async (deadline) => {
				const check = () => {
					deadline.throwIfAborted();
					current(sessionId);
				};
				check();
				const { data, error } = await cloud.supabase.auth.getSession();
				check();
				if (
					error ||
					!data.session ||
					data.session.user.id !== memberId ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				)
					throw new Error("Sign in again to select a conversation model.");
				// No `cache` option: see cloud/native-subscription.ts (the CORS preflight).
				const response = await fetch(`${origin.origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${data.session.access_token}`,
						apikey: cloud.config.publishableKey,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						p_session_id: sessionId,
						...(selection?.serviceTier !== undefined
							? { p_service_tier: selection.serviceTier, p_expected_version: selection.expectedVersion }
							: selection
								? {
										p_model_id: selection.modelId ?? null,
										p_expected_version: selection.expectedVersion,
										...(selection.reasoningEffort ? { p_reasoning_effort: selection.reasoningEffort } : {}),
									}
								: {}),
					}),
					signal: deadline,
					redirect: "error",
					credentials: "omit",
				});
				cloud.noticeResponse?.(`${origin.origin}/rest/v1/rpc/${method}`, data.session.access_token, response);
				try {
					check();
					if (response.status === 401 || response.status === 403)
						throw new CloudRpcError(
							method,
							{ code: "42501", message: "You do not have permission to select this conversation's model." },
							response.status,
						);
					const value: unknown = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 16384, deadline),
						),
					);
					check();
					if (!value || typeof value !== "object" || Array.isArray(value))
						throw new Error("Invalid conversation model response.");
					const result = value as Record<string, unknown>;
					const effort = result.reasoning_effort;
					const tier = result.service_tier;
					const models = result.models;
					const efforts = result.efforts;
					if (response.status !== 200)
						throw new CloudRpcError(
							method,
							{
								code: typeof result.code === "string" ? result.code : undefined,
								message:
									typeof result.message === "string"
										? result.message
										: "The conversation model could not be confirmed. Refresh it before trying again.",
							},
							response.status,
						);
					// A group chat with no model chosen reports none: each agent runs its own (20260928030000).
					const model = result.model_id;
					if (
						result.session_id !== sessionId ||
						(model !== null &&
							(typeof model !== "string" ||
								!model ||
								model !== model.trim() ||
								new TextEncoder().encode(model).length > 256)) ||
						(effort !== undefined &&
							(typeof effort !== "string" ||
								!effort ||
								effort !== effort.trim() ||
								new TextEncoder().encode(effort).length > 64)) ||
						(tier !== undefined &&
							(typeof tier !== "string" ||
								!tier ||
								tier !== tier.trim() ||
								new TextEncoder().encode(tier).length > 64)) ||
						(models !== undefined &&
							(!Array.isArray(models) ||
								models.length > 32 ||
								models.some(
									(item) => typeof item !== "string" || !item || new TextEncoder().encode(item).length > 256,
								))) ||
						(efforts !== undefined &&
							(!efforts ||
								typeof efforts !== "object" ||
								Array.isArray(efforts) ||
								Object.keys(efforts).length > 32 ||
								Object.entries(efforts).some(
									([key, list]) =>
										!key ||
										new TextEncoder().encode(key).length > 256 ||
										!Array.isArray(list) ||
										list.length > 16 ||
										list.some(
											(item) =>
												typeof item !== "string" || !item || new TextEncoder().encode(item).length > 64,
										),
								))) ||
						typeof result.version !== "number" ||
						!Number.isSafeInteger(result.version) ||
						result.version < 0 ||
						(selection &&
							((selection.modelId !== undefined && model !== selection.modelId) ||
								result.version !== selection.expectedVersion + 1 ||
								(selection.reasoningEffort !== undefined && effort !== selection.reasoningEffort) ||
								(selection.serviceTier !== undefined && tier !== selection.serviceTier)))
					)
						throw new Error("Invalid conversation model response.");
					return {
						sessionId,
						...(typeof model === "string" ? { modelId: model } : {}),
						...(typeof effort === "string" ? { reasoningEffort: effort } : {}),
						...(typeof tier === "string" ? { serviceTier: tier } : {}),
						...(Array.isArray(models) ? { models: [...new Set(models as string[])] } : {}),
						...(efforts && typeof efforts === "object"
							? {
									efforts: Object.fromEntries(
										Object.entries(efforts as Record<string, string[]>).map(([key, list]) => [
											key,
											[...new Set(list)],
										]),
									),
								}
							: {}),
						version: result.version,
					};
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}
			},
			10000,
			AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
		);
	};
	return {
		read: (sessionId, signal) => request(sessionId, undefined, signal),
		set: async (sessionId, selection, expectedVersion, signal) => {
			try {
				return await request(sessionId, { ...selection, expectedVersion }, signal);
			} catch (error) {
				if (error instanceof CloudRpcError) throw error;
				throw new Error("The conversation model change could not be confirmed. Refresh it before trying again.", {
					cause: error,
				});
			}
		},
	};
}
