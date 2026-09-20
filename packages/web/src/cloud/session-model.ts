import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type Cloud, CloudRpcError } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

export const SESSION_MODELS = [
	{ id: "gpt-6-astra", name: "GPT-6 Astra" },
	{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
	{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
] as const;

export interface SessionModel {
	sessionId: string;
	modelId: string;
	version: number;
}

export interface WebSessionModel {
	read(sessionId: string, signal?: AbortSignal): Promise<SessionModel>;
	set(sessionId: string, modelId: string, expectedVersion: number, signal?: AbortSignal): Promise<SessionModel>;
}

/** The cloud owns this conversation's override; reads retain unfamiliar models
 * so the selector never misrepresents an existing setting. */
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
		selection?: { modelId: string; expectedVersion: number },
		signal?: AbortSignal,
	): Promise<SessionModel> => {
		if (!UUID_PATTERN.test(sessionId)) throw new Error("Invalid conversation identity.");
		if (
			selection &&
			(!SESSION_MODELS.some((model) => model.id === selection.modelId) ||
				!Number.isSafeInteger(selection.expectedVersion) ||
				selection.expectedVersion < 0 ||
				selection.expectedVersion === Number.MAX_SAFE_INTEGER)
		)
			throw new Error("Invalid conversation model selection.");
		const method = selection ? "qorpera_set_session_model" : "qorpera_get_session_model";
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
				const response = await fetch(`${origin.origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${data.session.access_token}`,
						apikey: cloud.config.publishableKey,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						p_session_id: sessionId,
						...(selection
							? { p_model_id: selection.modelId, p_expected_version: selection.expectedVersion }
							: {}),
					}),
					signal: deadline,
					redirect: "error",
					cache: "no-store",
					credentials: "omit",
				});
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
					if (
						result.session_id !== sessionId ||
						typeof result.model_id !== "string" ||
						!result.model_id ||
						result.model_id !== result.model_id.trim() ||
						new TextEncoder().encode(result.model_id).length > 256 ||
						typeof result.version !== "number" ||
						!Number.isSafeInteger(result.version) ||
						result.version < 0 ||
						(selection &&
							(result.model_id !== selection.modelId || result.version !== selection.expectedVersion + 1))
					)
						throw new Error("Invalid conversation model response.");
					return { sessionId, modelId: result.model_id, version: result.version };
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
		set: async (sessionId, modelId, expectedVersion, signal) => {
			try {
				return await request(sessionId, { modelId, expectedVersion }, signal);
			} catch (error) {
				if (error instanceof CloudRpcError) throw error;
				throw new Error("The conversation model change could not be confirmed. Refresh it before trying again.", {
					cause: error,
				});
			}
		},
	};
}
