import type { Cloud } from "./client.ts";
import { type HostedCompanyOrganization, parseHostedCompanyOrganization } from "./organization.ts";
import { collectPages, type PageCursor } from "./pagination.ts";
import {
	parseAccountEntitlement,
	parseCompanyFile,
	parseCompanyProposal,
	parseCompanyProposalComment,
	parseCompanyProposalCommentPage,
	parseCompanyProposalPage,
	parseCompanySnapshot,
	parseCompanySnapshots,
	parseCompanyWorkspaces,
	parseCreatedCompany,
	parseEvents,
	parseFriends,
	parseIncomingInvitations,
	parseInvitation,
	parsePendingSessionInputs,
	parseProfiles,
	parseSessionInputReceipt,
	parseSessionPage,
	parseStaff,
	parseStaffExecutionActivity,
	parseStaffList,
	parseStaffSessionHandle,
	parseTeam,
	UUID_PATTERN,
} from "./parse.ts";
import type {
	CreatedCompanyResult,
	HostedAccountEntitlement,
	HostedCompanyFile,
	HostedCompanyProposal,
	HostedCompanyProposalComment,
	HostedCompanyProposalCommentPage,
	HostedCompanyProposalPage,
	HostedCompanyProposalStatus,
	HostedCompanySnapshot,
	HostedCompanyWorkspace,
	HostedFriend,
	HostedIncomingProfileInvitation,
	HostedProfile,
	HostedProfileInvitation,
	HostedProfileRole,
	HostedProfileTeam,
	HostedSession,
	HostedSessionEvent,
	HostedStaffAgent,
	HostedStaffExecutionActivity,
	PendingSessionInputPage,
	SessionInputReceipt,
	StaffSessionHandle,
} from "./types.ts";

/* Typed member surface over CLIENT-CONTRACT.md §2. One method per RPC the web
 * app uses; nothing here writes a table, runs an agent, or resolves a secret. */

function requiredUuid(value: string, label: string): string {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
	return value;
}

export const SESSION_PROMPT_SCHEMA = "qorpera.session-prompt/v1";
export const COMPANY_CONTRACT_VERSION = 2;

export class CloudApi {
	readonly cloud: Cloud;

	constructor(cloud: Cloud) {
		this.cloud = cloud;
	}

	// Accounts, profiles, membership

	listProfiles(): Promise<HostedProfile[]> {
		return this.cloud.rpc("qorpera_list_hosted_profiles").then(parseProfiles);
	}

	getAccountEntitlement(): Promise<HostedAccountEntitlement> {
		return this.cloud.rpc("qorpera_get_account_entitlement").then(parseAccountEntitlement);
	}

	listIncomingInvitations(): Promise<HostedIncomingProfileInvitation[]> {
		return this.cloud.rpc("qorpera_list_profile_invitations").then(parseIncomingInvitations);
	}

	async acceptInvitation(invitationId: string): Promise<void> {
		await this.cloud.rpc("qorpera_accept_profile_invitation", {
			p_invitation_id: requiredUuid(invitationId, "Invitation id"),
		});
	}

	async declineInvitation(invitationId: string): Promise<void> {
		await this.cloud.rpc("qorpera_decline_profile_invitation", {
			p_invitation_id: requiredUuid(invitationId, "Invitation id"),
		});
	}

	// Friends. Company invitations only reach accounts you are already friends
	// with, so this list is the account's address book (CLIENT-CONTRACT.md §2,
	// "Members, presence, friends, feedback").

	listFriends(): Promise<HostedFriend[]> {
		return this.cloud.rpc("qorpera_list_friends").then(parseFriends);
	}

	async sendFriendRequest(email: string): Promise<void> {
		await this.cloud.rpc("qorpera_send_friend_request", { p_email: email.trim().toLowerCase() });
	}

	async respondFriendRequest(userId: string, accept: boolean): Promise<void> {
		await this.cloud.rpc("qorpera_respond_friend_request", {
			p_user_id: requiredUuid(userId, "Account id"),
			p_accept: accept,
		});
	}

	async removeFriend(userId: string): Promise<void> {
		await this.cloud.rpc("qorpera_remove_friend", { p_user_id: requiredUuid(userId, "Account id") });
	}

	/** Give a staff agent a new figure and colour. Every other field is handed
	 * back as it was read, and the agent's version guards the write, so two
	 * members editing at once get a conflict instead of a silent overwrite
	 * (qorpera_put_profile_staff). */
	async setStaffAppearance(agent: HostedStaffAgent, creature: string, color: string): Promise<HostedStaffAgent> {
		return parseStaff(
			await this.cloud.rpc("qorpera_put_profile_staff", {
				p_profile_id: requiredUuid(agent.profileId, "Profile id"),
				p_staff_agent_id: requiredUuid(agent.id, "Staff id"),
				p_display_name: agent.displayName,
				p_role: agent.role,
				p_charter: agent.charter,
				p_template_id: agent.templateId ?? null,
				p_department_id: agent.departmentId ?? null,
				p_appearance_color: color,
				p_appearance_shape: agent.appearance.shape,
				p_appearance_creature: creature,
				p_model_provider: agent.model?.provider ?? null,
				p_model_id: agent.model?.modelId ?? null,
				p_employment_status: agent.employmentStatus,
				p_lifecycle_state: agent.lifecycleState,
				p_created_at: agent.createdAt,
				p_expected_version: agent.version,
			}),
		);
	}

	getTeam(profileId: string): Promise<HostedProfileTeam> {
		return this.cloud
			.rpc("qorpera_profile_team_info", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then(parseTeam);
	}

	inviteMember(
		profileId: string,
		email: string,
		memberRole: Exclude<HostedProfileRole, "owner">,
	): Promise<HostedProfileInvitation> {
		return this.cloud
			.rpc("qorpera_invite_profile_member", {
				p_profile_id: requiredUuid(profileId, "Profile id"),
				p_email: email.trim().toLowerCase(),
				p_role: memberRole,
			})
			.then(parseInvitation);
	}

	async cancelInvitation(profileId: string, invitationId: string): Promise<void> {
		await this.cloud.rpc("qorpera_cancel_profile_invitation", {
			p_profile_id: requiredUuid(profileId, "Profile id"),
			p_invitation_id: requiredUuid(invitationId, "Invitation id"),
		});
	}

	async retryInvitationDelivery(profileId: string, invitationId: string): Promise<void> {
		await this.cloud.rpc("qorpera_retry_profile_invitation_delivery", {
			p_profile_id: requiredUuid(profileId, "Profile id"),
			p_invitation_id: requiredUuid(invitationId, "Invitation id"),
		});
	}

	async updateMemberRole(profileId: string, memberUserId: string, memberRole: HostedProfileRole): Promise<void> {
		await this.cloud.rpc("qorpera_update_profile_member_role", {
			p_profile_id: requiredUuid(profileId, "Profile id"),
			p_member_user_id: requiredUuid(memberUserId, "Member id"),
			p_role: memberRole,
		});
	}

	async removeMember(profileId: string, memberUserId: string): Promise<void> {
		await this.cloud.rpc("qorpera_remove_profile_member", {
			p_profile_id: requiredUuid(profileId, "Profile id"),
			p_member_user_id: requiredUuid(memberUserId, "Member id"),
		});
	}

	async leaveProfile(profileId: string): Promise<void> {
		await this.cloud.rpc("qorpera_leave_hosted_profile", { p_profile_id: requiredUuid(profileId, "Profile id") });
	}

	async deleteProfile(profileId: string): Promise<void> {
		await this.cloud.rpc("qorpera_delete_hosted_profile", { p_profile_id: requiredUuid(profileId, "Profile id") });
	}

	/** Idempotent by client creation id: call again with the same id to read
	 * bootstrap progress on clouds that report it. */
	createCompany(clientCreationId: string, name: string): Promise<CreatedCompanyResult> {
		return this.cloud
			.rpc("qorpera_create_cloud_company", {
				p_client_creation_id: requiredUuid(clientCreationId, "Creation id"),
				p_company_name: name.trim(),
				p_contract_version: COMPANY_CONTRACT_VERSION,
			})
			.then(parseCreatedCompany);
	}

	// Organization and staff

	listStaff(profileId: string): Promise<HostedStaffAgent[]> {
		return this.cloud
			.rpc("qorpera_list_profile_staff", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then(parseStaffList);
	}

	getOrganization(profileId: string): Promise<HostedCompanyOrganization | undefined> {
		return this.cloud
			.rpc("qorpera_company_organization_json", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then(parseHostedCompanyOrganization);
	}

	listStaffActivity(environmentId: string): Promise<HostedStaffExecutionActivity[]> {
		return this.cloud
			.rpc("qorpera_list_staff_execution_activity", {
				p_environment_id: requiredUuid(environmentId, "Environment id"),
			})
			.then(parseStaffExecutionActivity);
	}

	// Conversations

	listSessions(environmentId: string, signal?: AbortSignal): Promise<HostedSession[]> {
		return collectPages((cursor) => {
			signal?.throwIfAborted();
			return this.cloud
				.rpc("qorpera_list_shared_sessions_page", {
					p_environment_id: requiredUuid(environmentId, "Environment id"),
					p_after_updated_at: cursor?.time ?? null,
					p_after_id: cursor?.id ?? null,
					p_limit: 100,
				})
				.then(parseSessionPage);
		});
	}

	ensureStaffSession(
		environmentId: string,
		staffAgentId: string,
		clientSessionId: string,
		title: string,
	): Promise<StaffSessionHandle> {
		return this.cloud
			.rpc("qorpera_ensure_staff_session", {
				p_environment_id: requiredUuid(environmentId, "Environment id"),
				p_staff_agent_id: staffAgentId,
				p_client_session_id: requiredUuid(clientSessionId, "Client session id"),
				p_title: title.trim().slice(0, 256) || "Conversation",
			})
			.then(parseStaffSessionHandle);
	}

	ensureMemberPrivateStaffSession(
		environmentId: string,
		staffAgentId: string,
		audienceUserId: string,
		clientSessionId: string,
		title: string,
	): Promise<StaffSessionHandle> {
		return this.cloud
			.rpc("qorpera_ensure_member_private_staff_session", {
				p_environment_id: requiredUuid(environmentId, "Environment id"),
				p_staff_agent_id: requiredUuid(staffAgentId, "Staff agent id"),
				p_audience_user_id: requiredUuid(audienceUserId, "Member id"),
				p_client_session_id: requiredUuid(clientSessionId, "Client session id"),
				p_title: title.trim().slice(0, 256) || "Conversation",
			})
			.then(parseStaffSessionHandle);
	}

	readSessionEvents(sessionId: string, afterSequence = 0, limit = 500): Promise<HostedSessionEvent[]> {
		return this.cloud
			.rpc("qorpera_read_session_events", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_after_sequence: afterSequence,
				p_limit: limit,
			})
			.then(parseEvents);
	}

	listSessionInputs(sessionId: string, afterPosition = 0, limit = 100): Promise<PendingSessionInputPage> {
		return this.cloud
			.rpc("qorpera_list_session_inputs", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_after_position: afterPosition,
				p_limit: limit,
			})
			.then(parsePendingSessionInputs);
	}

	/** The one member write into a conversation: a queued prompt. The mouth is
	 * server-side; this never produces agent text. */
	appendPrompt(sessionId: string, clientInputId: string, text: string): Promise<SessionInputReceipt> {
		return this.cloud
			.rpc("qorpera_append_session_input", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_client_input_id: requiredUuid(clientInputId, "Client input id"),
				p_kind: "user_message",
				p_body: { schema: SESSION_PROMPT_SCHEMA, text, images: [] },
			})
			.then(parseSessionInputReceipt);
	}

	// Company File

	getCompanyFile(environmentId: string): Promise<HostedCompanyFile> {
		return this.cloud
			.rpc("qorpera_get_company_file", { p_environment_id: requiredUuid(environmentId, "Environment id") })
			.then(parseCompanyFile);
	}

	usesPathGateway(profileId: string): Promise<boolean> {
		return this.cloud
			.rpc("qorpera_company_uses_path_gateway", { p_profile_id: requiredUuid(profileId, "Profile id") })
			.then((value) => value === true);
	}

	listWorkspaces(environmentId: string): Promise<HostedCompanyWorkspace[]> {
		return this.cloud
			.rpc("qorpera_list_company_workspaces", { p_environment_id: requiredUuid(environmentId, "Environment id") })
			.then(parseCompanyWorkspaces);
	}

	listSnapshots(workspaceId: string, limit = 50): Promise<HostedCompanySnapshot[]> {
		return this.cloud
			.rpc("qorpera_list_company_snapshots", {
				p_workspace_id: requiredUuid(workspaceId, "Workspace id"),
				p_limit: limit,
			})
			.then(parseCompanySnapshots);
	}

	getSnapshot(snapshotId: string): Promise<HostedCompanySnapshot> {
		return this.cloud
			.rpc("qorpera_get_company_snapshot", { p_snapshot_id: requiredUuid(snapshotId, "Snapshot id") })
			.then(parseCompanySnapshot);
	}

	listProposals(
		environmentId: string,
		status: HostedCompanyProposalStatus,
		limit = 50,
		cursor?: PageCursor,
	): Promise<HostedCompanyProposalPage> {
		return this.cloud
			.rpc("qorpera_list_company_proposals", {
				p_environment_id: requiredUuid(environmentId, "Environment id"),
				p_status: status,
				p_after_created_at: cursor?.time ?? null,
				p_after_id: cursor?.id ?? null,
				p_limit: limit,
			})
			.then(parseCompanyProposalPage);
	}

	getProposal(proposalId: string): Promise<HostedCompanyProposal> {
		return this.cloud
			.rpc("qorpera_get_company_proposal", { p_proposal_id: requiredUuid(proposalId, "Proposal id") })
			.then(parseCompanyProposal);
	}

	listProposalComments(
		proposalId: string,
		limit = 100,
		cursor?: PageCursor,
	): Promise<HostedCompanyProposalCommentPage> {
		return this.cloud
			.rpc("qorpera_list_company_proposal_comments", {
				p_proposal_id: requiredUuid(proposalId, "Proposal id"),
				p_after_created_at: cursor?.time ?? null,
				p_after_id: cursor?.id ?? null,
				p_limit: limit,
			})
			.then(parseCompanyProposalCommentPage);
	}

	appendProposalComment(
		proposalId: string,
		clientCommentId: string,
		body: string,
	): Promise<HostedCompanyProposalComment> {
		return this.cloud
			.rpc("qorpera_append_company_proposal_comment", {
				p_proposal_id: requiredUuid(proposalId, "Proposal id"),
				p_client_comment_id: requiredUuid(clientCommentId, "Comment id"),
				p_body: body.trim(),
			})
			.then(parseCompanyProposalComment);
	}

	acceptProposal(proposalId: string, expectedProposalSnapshotId: string): Promise<HostedCompanyProposal> {
		return this.cloud
			.rpc("qorpera_accept_company_proposal", {
				p_proposal_id: requiredUuid(proposalId, "Proposal id"),
				p_expected_proposal_snapshot_id: requiredUuid(expectedProposalSnapshotId, "Snapshot id"),
			})
			.then(parseCompanyProposal);
	}

	rejectProposal(proposalId: string, expectedProposalSnapshotId: string): Promise<HostedCompanyProposal> {
		return this.cloud
			.rpc("qorpera_reject_company_proposal", {
				p_proposal_id: requiredUuid(proposalId, "Proposal id"),
				p_expected_proposal_snapshot_id: requiredUuid(expectedProposalSnapshotId, "Snapshot id"),
			})
			.then(parseCompanyProposal);
	}

	// Objects

	authorizeObjectDownload(profileId: string, sha256: string): Promise<{ backend: string; bytes: number }> {
		return this.cloud
			.rpc("qorpera_authorize_profile_object_download", {
				p_profile_id: requiredUuid(profileId, "Profile id"),
				p_sha256: sha256,
			})
			.then((value) => {
				const input = value as { backend?: unknown; bytes?: unknown };
				return { backend: String(input.backend ?? "unknown"), bytes: Number(input.bytes ?? 0) };
			});
	}

	// Feedback

	async submitFeedback(clientFeedbackId: string, category: string, details: string): Promise<void> {
		await this.cloud.rpc("qorpera_submit_product_feedback", {
			p_client_feedback_id: requiredUuid(clientFeedbackId, "Feedback id"),
			p_category: category,
			p_details: details,
			p_include_diagnostics: false,
			p_diagnostics: {},
		});
	}
}
