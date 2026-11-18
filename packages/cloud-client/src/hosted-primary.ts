import type { JsonValue } from "@qorpera/contracts";

const HOSTED_PROFILE_ROLES = ["owner", "admin", "contributor", "viewer"] as const;
export type HostedProfileRole = (typeof HOSTED_PROFILE_ROLES)[number];

export interface HostedPresenceIdentity {
	clientId: string;
	userId: string;
	name: string;
	publicKey: string;
}

export interface HostedPrimaryDatabase {
	public: {
		Tables: Record<never, never>;
		Views: Record<never, never>;
		Functions: {
			qorpera_company_organization_json: { Args: { p_profile_id: string }; Returns: JsonValue };
			qorpera_list_hosted_profiles: { Args: Record<never, never>; Returns: JsonValue };
			qorpera_get_account_entitlement: { Args: Record<never, never>; Returns: JsonValue };
			qorpera_invite_profile_member: {
				Args: {
					p_profile_id: string;
					p_email: string;
					p_role: Exclude<HostedProfileRole, "owner">;
				};
				Returns: JsonValue;
			};
			qorpera_list_profile_invitations: { Args: Record<never, never>; Returns: JsonValue };
			qorpera_accept_profile_invitation: { Args: { p_invitation_id: string }; Returns: JsonValue };
			qorpera_decline_profile_invitation: { Args: { p_invitation_id: string }; Returns: JsonValue };
			qorpera_leave_hosted_profile: { Args: { p_profile_id: string }; Returns: JsonValue };
			qorpera_delete_hosted_profile: { Args: { p_profile_id: string }; Returns: JsonValue };
			qorpera_profile_team_info: { Args: { p_profile_id: string }; Returns: JsonValue };
			qorpera_cancel_profile_invitation: {
				Args: { p_profile_id: string; p_invitation_id: string };
				Returns: JsonValue;
			};
			qorpera_retry_profile_invitation_delivery: {
				Args: { p_profile_id: string; p_invitation_id: string };
				Returns: JsonValue;
			};
			qorpera_update_profile_member_role: {
				Args: {
					p_profile_id: string;
					p_member_user_id: string;
					p_role: Exclude<HostedProfileRole, "owner">;
				};
				Returns: JsonValue;
			};
			qorpera_remove_profile_member: {
				Args: { p_profile_id: string; p_member_user_id: string };
				Returns: JsonValue;
			};
			qorpera_list_profile_staff: { Args: { p_profile_id: string }; Returns: JsonValue };
			qorpera_list_shared_sessions_page: {
				Args: {
					p_environment_id: string;
					p_after_updated_at: string | null;
					p_after_id: string | null;
					p_limit: number;
				};
				Returns: JsonValue;
			};
			qorpera_ensure_staff_session: {
				Args: { p_environment_id: string; p_staff_agent_id: string; p_client_session_id: string; p_title: string };
				Returns: JsonValue;
			};
			qorpera_append_session_input: {
				Args: { p_session_id: string; p_client_input_id: string; p_kind: string; p_body: JsonValue };
				Returns: JsonValue;
			};
			qorpera_list_session_inputs: {
				Args: { p_session_id: string; p_after_position: number; p_limit: number };
				Returns: JsonValue;
			};
			qorpera_list_staff_execution_activity: {
				Args: { p_environment_id: string };
				Returns: JsonValue;
			};
			qorpera_resolve_failed_execution_run: {
				Args: { p_run_id: string; p_action: string };
				Returns: JsonValue;
			};
			qorpera_register_presence_device: {
				Args: { p_profile_id: string; p_client_id: string; p_public_key: string };
				Returns: JsonValue;
			};
			qorpera_list_presence_devices: {
				Args: { p_profile_id: string; p_client_ids: string[] };
				Returns: JsonValue;
			};
			qorpera_unregister_presence_device: {
				Args: { p_profile_id: string; p_client_id: string };
				Returns: undefined;
			};
			qorpera_send_friend_request: { Args: { p_email: string }; Returns: JsonValue };
			qorpera_list_friends: { Args: Record<string, never>; Returns: JsonValue };
			qorpera_respond_friend_request: { Args: { p_user_id: string; p_accept: boolean }; Returns: JsonValue };
			qorpera_remove_friend: { Args: { p_user_id: string }; Returns: JsonValue };
			qorpera_read_session_events: {
				Args: { p_session_id: string; p_after_sequence: number; p_limit: number };
				Returns: JsonValue;
			};
			qorpera_get_company_file: { Args: { p_environment_id: string }; Returns: JsonValue };
		};
	};
}
