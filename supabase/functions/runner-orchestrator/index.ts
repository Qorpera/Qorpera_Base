import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";
import { createTimedFetch, DEFAULT_RPC_TIMEOUT_MS, preferredServiceKey, withAbortSignal } from "../_shared/http-guards.ts";
import {
	FOLDER_DRAINS,
	orchestratorAuthFailure,
	parseRunnerOrchestratorBearer,
	readRunnerOrchestratorRequest,
	runnerOrchestratorRpcStatus,
	type RunnerOrchestratorRequest,
} from "./runner-orchestrator.ts";

const UTF8_ENCODER = new TextEncoder();
const timedFetch = createTimedFetch({ timeoutMs: DEFAULT_RPC_TIMEOUT_MS });
let cachedClient: { readonly key: string; readonly client: SupabaseClient } | undefined;

function getClient(supabaseUrl: string, serviceKey: string): SupabaseClient {
	const key = `${supabaseUrl}\0${serviceKey}`;
	if (cachedClient?.key === key) return cachedClient.client;
	const client = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false },
		global: { fetch: timedFetch },
	});
	cachedClient = { key, client };
	return client;
}

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const supabaseUrl = Deno.env.get("SUPABASE_URL");
	const serviceKey = preferredServiceKey((name) => Deno.env.get(name));
	if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Runner orchestration is not configured" }, 503);
	let action: RunnerOrchestratorRequest;
	let token: string;
	try {
		token = parseRunnerOrchestratorBearer(request.headers.get("authorization"));
		action = await readRunnerOrchestratorRequest(request);
	} catch {
		return jsonResponse({ error: "Invalid orchestrator request" }, 400);
	}
	const client = getClient(supabaseUrl, serviceKey);
	const tokenSha256 = await sha256(token);
	try {
		const { data: valid, error: validationError } = await withAbortSignal(
			client.rpc("qorpera_runner_orchestrator_control_valid", {
				p_orchestrator_id: action.orchestratorId,
				p_control_token_sha256: tokenSha256,
			}),
			request.signal,
		);
		const authFailure = orchestratorAuthFailure(validationError, valid);
		if (authFailure) return jsonResponse({ error: authFailure.error }, authFailure.status);
		let rpc: string;
		let args: Record<string, unknown>;
		switch (action.action) {
			case "rotate_control":
				rpc = "qorpera_rotate_runner_orchestrator_control";
				args = {
					p_orchestrator_id: action.orchestratorId,
					p_presented_token_sha256: tokenSha256,
					p_next_token_sha256: action.nextControlTokenSha256,
					p_control_token_seconds: action.controlTokenSeconds,
				};
				break;
			case "routine_heads":
				rpc = "qorpera_list_routine_schedule_heads";
				args = {
					p_after_routine_id: action.afterRoutineId ?? null,
					p_limit: action.limit,
				};
				break;
			case "enqueue_wake":
				rpc = "qorpera_enqueue_routine_wake";
				args = {
					p_routine_id: action.routineId,
					p_expected_version: action.expectedVersion,
					p_occurrence_id: action.occurrenceId,
					p_occurrence_key: action.occurrenceKey,
					p_trigger_id: action.triggerId,
					p_scheduled_for: action.scheduledFor,
					p_expected_last_scheduled_for: action.expectedLastScheduledFor ?? null,
					p_next_due_at: action.nextDueAt,
					p_payload: action.payload,
				};
				break;
			case "advance_next_due":
				rpc = "qorpera_advance_routine_next_due";
				args = {
					p_routine_id: action.routineId,
					p_expected_version: action.expectedVersion,
					p_trigger_id: action.triggerId,
					p_expected_last_scheduled_for: action.expectedLastScheduledFor ?? null,
					p_next_due_at: action.nextDueAt,
				};
				break;
			case "folder_dynamic_routines":
				rpc = "qorpera_folder_dynamic_routines_due";
				args = {
					p_after_routine_id: action.afterRoutineId ?? null,
					p_limit: action.limit,
				};
				break;
			case "restore_dynamic_routine":
				rpc = "qorpera_folder_restore_dynamic_routine_run";
				args = {
					p_routine_id: action.routineId,
					p_expected_version: action.expectedVersion,
				};
				break;
			case "folder_materialize_due":
				rpc = "qorpera_folder_materialize_due";
				args = {
					p_after_profile_id: action.afterProfileId ?? null,
					p_limit: action.limit,
				};
				break;
			case "folder_materialize_company":
				rpc = "qorpera_folder_materialize_company";
				args = {
					p_profile_id: action.profileId,
					p_limit: action.limit,
				};
				break;
			case "folder_drain_due":
				rpc = FOLDER_DRAINS[action.drain].due;
				args = {
					p_after_environment: action.afterEnvironmentId ?? null,
					p_limit: action.limit,
				};
				break;
			case "folder_drain_company":
				rpc = FOLDER_DRAINS[action.drain].company;
				args = {
					p_environment_id: action.environmentId,
					p_limit: action.limit,
				};
				break;
			case "due_summary":
				rpc = "qorpera_orchestrator_due_summary";
				args = {};
				break;
			case "reconcile":
				rpc = "qorpera_reconcile_runner_orchestrator";
				args = { p_orchestrator_id: action.orchestratorId };
				break;
			case "retained":
				rpc = "qorpera_list_retained_runner_claims";
				args = { p_orchestrator_id: action.orchestratorId };
				break;
			case "claim":
				rpc = "qorpera_claim_runner_job_for_orchestrator";
				args = {
					p_orchestrator_id: action.orchestratorId,
					p_client_claim_id: action.clientClaimId,
					p_lease_seconds: action.leaseSeconds,
				};
				break;
			case "renew_claim":
				rpc = "qorpera_renew_runner_job_claim";
				args = {
					p_orchestrator_id: action.orchestratorId,
					p_claim_id: action.claimId,
					p_lease_seconds: action.leaseSeconds,
				};
				break;
			case "assign":
				rpc = "qorpera_assign_runner_job";
				args = {
					p_orchestrator_id: action.orchestratorId,
					p_claim_id: action.claimId,
					p_runner_id: action.runnerId,
					p_client_assignment_id: action.clientAssignmentId,
					p_capability_sha256: action.capabilitySha256,
					p_assignment_seconds: action.assignmentSeconds,
				};
				break;
			case "release_claim":
				rpc = "qorpera_release_runner_job_claim";
				args = {
					p_orchestrator_id: action.orchestratorId,
					p_claim_id: action.claimId,
					p_client_assignment_id: action.clientAssignmentId,
					p_error: action.error,
				};
				break;
		}
		const { data, error } = await withAbortSignal(client.rpc(rpc, args), request.signal);
		if (error) return jsonResponse({ error: "Orchestrator request was rejected" }, runnerOrchestratorRpcStatus(error));
		return jsonResponse({ value: data });
	} catch {
		return jsonResponse({ error: "Runner orchestration is unavailable" }, 503);
	}
});
