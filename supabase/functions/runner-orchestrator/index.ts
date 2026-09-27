import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	parseRunnerOrchestratorBearer,
	readRunnerOrchestratorRequest,
	runnerOrchestratorRpcStatus,
	type RunnerOrchestratorRequest,
} from "./runner-orchestrator.ts";

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
	if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Runner orchestration is not configured" }, 503);
	let action: RunnerOrchestratorRequest;
	let token: string;
	try {
		token = parseRunnerOrchestratorBearer(request.headers.get("authorization"));
		action = await readRunnerOrchestratorRequest(request);
	} catch {
		return jsonResponse({ error: "Invalid orchestrator request" }, 400);
	}
	const client = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
	const { data: valid, error: validationError } = await client.rpc("qorpera_runner_orchestrator_control_valid", {
		p_orchestrator_id: action.orchestratorId,
		p_control_token_sha256: await sha256(token),
	});
	if (validationError || valid !== true) return jsonResponse({ error: "Orchestrator authorization was rejected" }, 401);
	let rpc: string;
	let args: Record<string, unknown>;
	switch (action.action) {
		case "rotate_control":
			rpc = "qorpera_rotate_runner_orchestrator_control";
			args = {
				p_orchestrator_id: action.orchestratorId,
				p_presented_token_sha256: await sha256(token),
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
	const { data, error } = await client.rpc(rpc, args);
	if (error) return jsonResponse({ error: "Orchestrator request was rejected" }, runnerOrchestratorRpcStatus(error));
	return jsonResponse({ value: data });
});
