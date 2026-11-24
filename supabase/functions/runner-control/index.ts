import { DEFAULT_RPC_TIMEOUT_MS, jsonResponse, preferredServiceKey, sha256Hex as sha256, withAbortSignal } from "../_shared/http-guards.ts";
import { createPostgrestClient, type PostgrestClient } from "../_shared/postgrest-rpc.ts";
import {
	parseRunnerBearer,
	readRunnerControlRequest,
	runnerControlRejectionLog,
	runnerControlRpcName,
	runnerControlRpcStatus,
	runnerStartRpcStatus,
	type RunnerControlRequest,
} from "./runner-control.ts";

let cachedClient: { readonly key: string; readonly client: PostgrestClient } | undefined;

function getClient(supabaseUrl: string, serviceKey: string): PostgrestClient {
	const key = `${supabaseUrl}\0${serviceKey}`;
	if (cachedClient?.key === key) return cachedClient.client;
	const client = createPostgrestClient(supabaseUrl, serviceKey, { timeoutMs: DEFAULT_RPC_TIMEOUT_MS });
	cachedClient = { key, client };
	return client;
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const supabaseUrl = Deno.env.get("SUPABASE_URL");
	const serviceKey = preferredServiceKey((name) => Deno.env.get(name));
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
	const client = getClient(supabaseUrl, serviceKey);
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
		case "start":
			args = {
				p_runner_id: action.runnerId,
				p_session_token_sha256: currentTokenSha256,
				p_assignment_id: action.assignmentId,
				p_job_id: action.jobId,
				p_assignment_capability_sha256: await sha256(action.assignmentCapability),
				p_native_lease_seconds: action.nativeLeaseSeconds ?? null,
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
	try {
		const { data, error } = await withAbortSignal(
			client.rpc(runnerControlRpcName(action.action), args),
			request.signal,
		);
		if (error) {
			console.warn(runnerControlRejectionLog(action.action, error));
			const status = action.action === "start" ? runnerStartRpcStatus(error) : runnerControlRpcStatus(error);
			return jsonResponse({ error: "Runner request was rejected" }, status);
		}
		return jsonResponse({ value: data });
	} catch {
		return jsonResponse({ error: "Runner control is unavailable" }, 503);
	}
});
