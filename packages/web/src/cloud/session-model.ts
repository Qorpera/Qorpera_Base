import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type Cloud, CloudRpcError } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

export const SESSION_MODELS = [
	{ id: "gpt-6-astra", name: "GPT-6 Astra" },
	{ id: "gpt-6-sol", name: "GPT-6 Sol" },
	{ id: "gpt-6-luna", name: "GPT-6 Luna" },
] as const;

/** The only listed model a cloud without per-conversation effort accepts. */
export const SESSION_MODEL_BEFORE_EFFORT = "gpt-6-astra";

export const SESSION_EFFORTS = ["low", "medium", "high"] as const;

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
					!(SESSION_EFFORTS as readonly string[]).includes(selection.reasoningEffort)) ||
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
