import { withTimeoutScope } from "../_shared/abort-timeout.ts";
import { preferredServiceKey, readBoundedJson, serviceHeaders } from "../_shared/http-guards.ts";
import { chatGptPlanReturnUrl, handleChatGptPlanCallback } from "./chatgpt-plan-callback.ts";

const RPC_TIMEOUT_MS = 5_000;
const MAX_RPC_RESPONSE_BYTES = 16 * 1024;

/** The company's vault callback address for a state (qorpera_chatgpt_plan_callback_target), or undefined. */
async function callbackTarget(state: string, parentSignal?: AbortSignal): Promise<string | undefined> {
	const base = Deno.env.get("SUPABASE_URL");
	const key = preferredServiceKey((name) => Deno.env.get(name));
	if (!base || !key) return undefined;
	return withTimeoutScope(
		RPC_TIMEOUT_MS,
		async (signal) => {
			const response = await fetch(new URL("/rest/v1/rpc/qorpera_chatgpt_plan_callback_target", base), {
				method: "POST",
				headers: serviceHeaders(key, { "content-type": "application/json", accept: "application/json" }),
				body: JSON.stringify({ p_state: state }),
				redirect: "error",
				signal,
			});
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				return undefined;
			}
			const target = await readBoundedJson(response, MAX_RPC_RESPONSE_BYTES, {
				signal,
				ignoreContentLength: response.headers.has("content-encoding"),
			});
			return typeof target === "string" ? target : undefined;
		},
		parentSignal,
	);
}

/** Exact web origins this deployment serves, as a JSON array; absent means the production app only. */
function allowedOrigins(): readonly string[] {
	const value = Deno.env.get("QORPERA_WEB_ORIGINS");
	if (!value) return [];
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8 || parsed.some((item) => typeof item !== "string"))
		throw new Error("QORPERA_WEB_ORIGINS must be a JSON array of one to eight origins");
	return parsed as string[];
}

const returnUrl = chatGptPlanReturnUrl(Deno.env.get("QORPERA_CHATGPT_PLAN_RETURN_URL"), allowedOrigins());

Deno.serve((request) => handleChatGptPlanCallback(request, { returnUrl, resolveTarget: callbackTarget }));
