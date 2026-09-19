import type { Cloud } from "./client.ts";
import { CloudRpcError } from "./client.ts";

/* Runtime verification of the member surface (CLIENT-CONTRACT.md: "verify
 * before relying on any entry"). Each RPC the app uses is called with its exact
 * named parameters set to null under the member's token. PostgREST answers
 * PGRST202 when the function (with those parameter names) is not deployed;
 * a Postgres error or a result means it exists. Parameter names come from the
 * latest migration that defines each function. */

export interface RpcProbeEntry {
	name: string;
	params: string[];
	/** Which product surface depends on it, for the report. */
	area: string;
}

export const RPC_PROBES: RpcProbeEntry[] = [
	{ name: "qorpera_list_hosted_profiles", params: [], area: "Companies" },
	{ name: "qorpera_get_account_entitlement", params: [], area: "Account" },
	{ name: "qorpera_list_profile_invitations", params: [], area: "Invitations" },
	{ name: "qorpera_accept_profile_invitation", params: ["p_invitation_id"], area: "Invitations" },
	{ name: "qorpera_decline_profile_invitation", params: ["p_invitation_id"], area: "Invitations" },
	{ name: "qorpera_profile_team_info", params: ["p_profile_id"], area: "Team" },
	{ name: "qorpera_invite_profile_member", params: ["p_profile_id", "p_email", "p_role"], area: "Team" },
	{ name: "qorpera_cancel_profile_invitation", params: ["p_profile_id", "p_invitation_id"], area: "Team" },
	{ name: "qorpera_retry_profile_invitation_delivery", params: ["p_profile_id", "p_invitation_id"], area: "Team" },
	{ name: "qorpera_update_profile_member_role", params: ["p_profile_id", "p_member_user_id", "p_role"], area: "Team" },
	{ name: "qorpera_remove_profile_member", params: ["p_profile_id", "p_member_user_id"], area: "Team" },
	{ name: "qorpera_leave_hosted_profile", params: ["p_profile_id"], area: "Team" },
	{ name: "qorpera_delete_hosted_profile", params: ["p_profile_id"], area: "Team" },
	{
		name: "qorpera_create_cloud_company",
		params: ["p_client_creation_id", "p_company_name", "p_contract_version"],
		area: "New company",
	},
	{ name: "qorpera_company_organization_bootstrap", params: ["p_profile_id"], area: "Organization (Order 0)" },
	{ name: "qorpera_company_organization_json", params: ["p_profile_id"], area: "Organization (Order 0)" },
	{ name: "qorpera_list_profile_staff", params: ["p_profile_id"], area: "Staff" },
	{
		name: "qorpera_list_shared_sessions_page",
		params: ["p_environment_id", "p_after_updated_at", "p_after_id", "p_limit"],
		area: "Conversations",
	},
	{
		name: "qorpera_ensure_staff_session",
		params: ["p_environment_id", "p_staff_agent_id", "p_client_session_id", "p_title"],
		area: "Conversations",
	},
	{
		name: "qorpera_agent_thread",
		params: ["p_environment_id", "p_staff_agent_id", "p_audience_user_id", "p_client_session_id", "p_title"],
		area: "Co-Founder private session (Order 0)",
	},
	{
		name: "qorpera_append_session_input",
		params: ["p_session_id", "p_client_input_id", "p_kind", "p_body"],
		area: "Conversations",
	},
	{
		name: "qorpera_list_session_inputs",
		params: ["p_session_id", "p_after_position", "p_limit"],
		area: "Conversations",
	},
	{
		name: "qorpera_read_session_events",
		params: ["p_session_id", "p_after_sequence", "p_limit"],
		area: "Conversations",
	},
	{ name: "qorpera_list_staff_execution_activity", params: ["p_environment_id"], area: "Conversations" },
	{ name: "qorpera_get_execution_run_recovery", params: ["p_run_id"], area: "Conversations" },
	{ name: "qorpera_resolve_failed_execution_run", params: ["p_run_id", "p_action"], area: "Conversations" },
	{ name: "qorpera_get_company_file", params: ["p_environment_id"], area: "Company File" },
	{ name: "qorpera_company_uses_path_gateway", params: ["p_profile_id"], area: "Company File (Order 0)" },
	{ name: "qorpera_list_company_workspaces", params: ["p_environment_id"], area: "Company File" },
	{ name: "qorpera_list_company_snapshots", params: ["p_workspace_id", "p_limit"], area: "Company File" },
	{ name: "qorpera_get_company_snapshot", params: ["p_snapshot_id"], area: "Company File" },
	{ name: "qorpera_authorize_profile_object_download", params: ["p_profile_id", "p_sha256"], area: "Company File" },
	{
		name: "qorpera_list_company_proposals",
		params: ["p_environment_id", "p_status", "p_after_created_at", "p_after_id", "p_limit"],
		area: "Proposals",
	},
	{ name: "qorpera_get_company_proposal", params: ["p_proposal_id"], area: "Proposals" },
	{
		name: "qorpera_list_company_proposal_comments",
		params: ["p_proposal_id", "p_after_created_at", "p_after_id", "p_limit"],
		area: "Proposals",
	},
	{
		name: "qorpera_append_company_proposal_comment",
		params: ["p_proposal_id", "p_client_comment_id", "p_body"],
		area: "Proposals",
	},
	{
		name: "qorpera_accept_company_proposal",
		params: ["p_proposal_id", "p_expected_proposal_snapshot_id"],
		area: "Proposals",
	},
	{
		name: "qorpera_reject_company_proposal",
		params: ["p_proposal_id", "p_expected_proposal_snapshot_id"],
		area: "Proposals",
	},
	{ name: "qorpera_presence_topic_profile", params: ["p_topic"], area: "Presence" },
	{
		name: "qorpera_register_presence_device",
		params: ["p_profile_id", "p_client_id", "p_public_key"],
		area: "Presence",
	},
	{ name: "qorpera_list_presence_devices", params: ["p_profile_id", "p_client_ids"], area: "Presence" },
	{
		name: "qorpera_submit_product_feedback",
		params: ["p_client_feedback_id", "p_category", "p_details", "p_include_diagnostics", "p_diagnostics"],
		area: "Feedback",
	},
];

export type RpcProbeState = "present" | "missing" | "signed-out" | "denied" | "unreachable";

export interface RpcProbeResult extends RpcProbeEntry {
	state: RpcProbeState;
	detail: string;
}

export async function probeRpcs(
	cloud: Cloud,
	onResult?: (result: RpcProbeResult) => void,
	signal?: AbortSignal,
): Promise<RpcProbeResult[]> {
	const results: RpcProbeResult[] = [];
	for (const entry of RPC_PROBES) {
		if (signal?.aborted) break;
		const args = Object.fromEntries(entry.params.map((param) => [param, null]));
		let result: RpcProbeResult;
		try {
			await cloud.rpc(entry.name, args);
			result = { ...entry, state: "present", detail: "callable" };
		} catch (error) {
			if (error instanceof CloudRpcError) {
				const postgresResponse = Boolean(error.code && /^[0-9A-Z]{5}$/.test(error.code));
				result = error.missing
					? { ...entry, state: "missing", detail: "PGRST202: not in the deployed schema" }
					: error.status === 401 && error.code !== "42501"
						? { ...entry, state: "signed-out", detail: "no member token" }
						: {
								...entry,
								state: postgresResponse ? (error.denied ? "denied" : "present") : "unreachable",
								detail: `${error.code ?? "error"}: ${error.message}`,
							};
			} else {
				result = { ...entry, state: "unreachable", detail: error instanceof Error ? error.message : String(error) };
			}
		}
		if (signal?.aborted) break;
		results.push(result);
		onResult?.(result);
	}
	return results;
}
