import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	parseRunnerBearer,
	readRunnerControlRequest,
	type RunnerControlRequest,
} from "./runner-control.ts";

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function configuredServiceKey(): string | undefined {
	const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const key = Object.values(parsed).find((value): value is string => typeof value === "string" && value.length > 20);
			if (key) return key;
		}
	} catch {
		// Fall through to the legacy project secret when configured.
	}
	return legacyServiceRoleKey || undefined;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rpcStatus(error: { code?: string }): number {
	if (error.code === "42501") return 401;
	if (error.code === "40001" || error.code === "55000") return 409;
	return 503;
}

function rpcName(action: RunnerControlRequest["action"]): string {
	switch (action) {
		case "activate":
			return "qorpera_activate_runner";
		case "heartbeat":
			return "qorpera_heartbeat_runner";
		case "claim":
			return "qorpera_claim_runner_job";
		case "renew":
			return "qorpera_renew_runner_job";
		case "complete":
			return "qorpera_complete_runner_job_v2";
		case "fail":
			return "qorpera_fail_runner_job";
	}
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const supabaseUrl = Deno.env.get("SUPABASE_URL");
	const serviceKey = configuredServiceKey();
	if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Runner control is not configured" }, 503);
	let action: RunnerControlRequest;
	let currentToken: string;
	try {
		currentToken = parseRunnerBearer(request.headers.get("authorization"));
		action = await readRunnerControlRequest(request);
	} catch {
		return jsonResponse({ error: "Invalid runner request" }, 400);
	}
	const currentTokenSha256 = await sha256(currentToken);
	const client = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
	let args: Record<string, unknown>;
	switch (action.action) {
		case "activate":
			args = {
				p_runner_id: action.runnerId,
				p_activation_token_sha256: currentTokenSha256,
				p_session_token_sha256: await sha256(action.nextSessionToken),
				p_platform: action.platform,
				p_runner_version: action.runnerVersion,
			};
			break;
		case "heartbeat":
			args = {
				p_runner_id: action.runnerId,
				p_current_token_sha256: currentTokenSha256,
				p_next_token_sha256: await sha256(action.nextSessionToken),
				p_renewal_id: action.renewalId,
			};
			break;
		case "claim":
			args = {
				p_runner_id: action.runnerId,
				p_session_token_sha256: currentTokenSha256,
				p_client_lease_id: action.clientLeaseId,
				p_lease_token_sha256: await sha256(action.leaseToken),
			};
			break;
		case "renew":
			args = {
				p_runner_id: action.runnerId,
				p_session_token_sha256: currentTokenSha256,
				p_job_id: action.jobId,
				p_lease_token_sha256: await sha256(action.leaseToken),
			};
			break;
		case "complete":
			args = {
				p_runner_id: action.runnerId,
				p_session_token_sha256: currentTokenSha256,
				p_job_id: action.jobId,
				p_lease_token_sha256: await sha256(action.leaseToken),
				p_client_artifact_index_id: action.clientArtifactIndexId,
				p_client_substrate_version_id: action.clientSubstrateVersionId,
				p_result: action.result,
			};
			break;
		case "fail":
			args = {
				p_runner_id: action.runnerId,
				p_session_token_sha256: currentTokenSha256,
				p_job_id: action.jobId,
				p_lease_token_sha256: await sha256(action.leaseToken),
				p_error: action.error,
				p_retryable: action.retryable,
			};
			break;
	}
	const { data, error } = await client.rpc(rpcName(action.action), args);
	if (error) return jsonResponse({ error: "Runner request was rejected" }, rpcStatus(error));
	return jsonResponse({ value: data });
});
