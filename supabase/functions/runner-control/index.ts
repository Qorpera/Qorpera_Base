import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	parseRunnerBearer,
	readRunnerControlRequest,
	runnerControlRpcName,
	runnerControlRpcStatus,
	type RunnerControlRequest,
} from "./runner-control.ts";

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function configuredServiceKey(): string | undefined {
	/* Prefer the legacy service-role JWT: it is verified locally at the
	 * gateway, while new-format secret keys resolve through the platform's
	 * key-management service — a dependency that has shed requests for
	 * minutes at a time during platform incidents. Both keys address the
	 * same hosted project. */
	const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	if (legacyServiceRoleKey) return legacyServiceRoleKey;
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const key = Object.values(parsed).find((value): value is string => typeof value === "string" && value.length > 20);
			if (key) return key;
		}
	} catch {
		// No configured service credential.
	}
	return undefined;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
		case "accept":
			args = {
				p_runner_id: action.runnerId,
				p_session_token_sha256: currentTokenSha256,
				p_assignment_id: action.assignmentId,
				p_job_id: action.jobId,
				p_assignment_capability_sha256: await sha256(action.assignmentCapability),
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
				p_output_snapshot_id: action.outputSnapshotId ?? null,
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
	const { data, error } = await client.rpc(runnerControlRpcName(action.action), args);
	if (error) return jsonResponse({ error: "Runner request was rejected" }, runnerControlRpcStatus(error));
	return jsonResponse({ value: data });
});
