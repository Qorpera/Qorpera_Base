import type { Cloud } from "./client.ts";
import { type HostedCompanyOrganization, parseHostedCompanyOrganization } from "./organization.ts";
import { collectPages, type PageCursor } from "./pagination.ts";
import {
	type AgentThreadHandle,
	parseAccountEntitlement,
	parseAgentThreadHandle,
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
	parseRoomDeliveryRetry,
	parseRunRecovery,
	parseRunResolution,
	parseSessionInputReceipt,
	parseSessionPage,
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
	HostedRunRecovery,
	HostedSession,
	HostedSessionEvent,
	HostedStaffAgent,
	HostedStaffExecutionActivity,
	JsonValue,
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

	getRunRecovery(runId: string): Promise<HostedRunRecovery> {
		return this.cloud
			.rpc("qorpera_get_execution_run_recovery", { p_run_id: requiredUuid(runId, "Run id") })
			.then(parseRunRecovery);
	}

	/** The desktop's "discard": the run stops counting against the agent. Nothing
	 * is re-run, and the member's own message stays marked failed. */
	discardFailedRun(runId: string): Promise<void> {
		const id = requiredUuid(runId, "Run id");
		return this.cloud
			.rpc("qorpera_resolve_failed_execution_run", { p_run_id: id, p_action: "discard" })
			.then((value) => parseRunResolution(value, id, "discard"));
	}

	/** Dismiss: a member saw the failure. The run stops standing in for the agent;
	 * nothing is discarded, replayed or changed, so this also settles a run whose
	 * durable outcome is still unknown, which discard refuses. */
	acknowledgeFailedRun(runId: string): Promise<void> {
		const id = requiredUuid(runId, "Run id");
		return this.cloud
			.rpc("qorpera_resolve_failed_execution_run", { p_run_id: id, p_action: "acknowledge" })
			.then((value) => parseRunResolution(value, id, "acknowledge"));
	}

	/** Try again for a session turn: the cloud releases the run and queues its inputs again. */
	retryFailedRun(runId: string): Promise<void> {
		const id = requiredUuid(runId, "Run id");
		return this.cloud
			.rpc("qorpera_resolve_failed_execution_run", { p_run_id: id, p_action: "retry" })
			.then((value) => parseRunResolution(value, id, "retry"));
	}

	/** Try again for a post into a room or agent thread (20260920080000): the member's
	 * message stays as it is and wakes the same agent once more, on the account chosen
	 * now. Only the author of the post may do this. */
	retryRoomDelivery(runId: string, sponsorBindingId: string, sponsorVersion: number): Promise<void> {
		const id = requiredUuid(runId, "Run id");
		if (!Number.isSafeInteger(sponsorVersion) || sponsorVersion < 1) throw new Error("Model account is invalid.");
		return this.cloud
			.rpc("qorpera_retry_room_delivery", {
				p_run_id: id,
				p_sponsor_binding_id: requiredUuid(sponsorBindingId, "Model account"),
				p_sponsor_version: sponsorVersion,
			})
			.then((value) => parseRoomDeliveryRetry(value, id));
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

	/** The agent's one shared thread (2026-09-17 amendment); the kernel binds it to the agent's room. */
	agentThread(environmentId: string, staffAgentId: string): Promise<AgentThreadHandle> {
		return this.cloud
			.rpc("qorpera_agent_thread", {
				p_environment_id: requiredUuid(environmentId, "Environment id"),
				p_staff_agent_id: requiredUuid(staffAgentId, "Staff agent id"),
			})
			.then(parseAgentThreadHandle);
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

	/** The company's saved secrets (references only: never a value). */
	listSecretConnections(profileId: string, environmentId: string): Promise<CloudSecretReference[]> {
		return this.cloud
			.rpc("qorpera_list_cloud_secret_connections", {
				p_profile_id: requiredUuid(profileId, "Profile id"),
				p_environment_id: requiredUuid(environmentId, "Environment id"),
			})
			.then(parseSecretReferences);
	}

	/** A one-time ticket to put a secret into the company's cloud custody. The
	 * value itself goes to the secret broker's origin (`captureSecret`), never
	 * through this RPC. */
	beginSecretCapture(input: {
		profileId: string;
		environmentId: string;
		ownerKind: "company" | "member";
		ownerUserId?: string;
		connectorId: string;
		secretName: string;
		purpose: string;
		existingSecretId?: string;
	}): Promise<CloudSecretCaptureTicket> {
		return this.cloud
			.rpc("qorpera_begin_cloud_secret_capture", {
				p_profile_id: requiredUuid(input.profileId, "Profile id"),
				p_environment_id: requiredUuid(input.environmentId, "Environment id"),
				p_owner_kind: input.ownerKind,
				p_owner_user_id: input.ownerUserId ? requiredUuid(input.ownerUserId, "Owner") : null,
				p_connector_id: input.connectorId,
				p_secret_name: input.secretName,
				p_purpose: input.purpose,
				p_existing_secret_id: input.existingSecretId ? requiredUuid(input.existingSecretId, "Secret id") : null,
			})
			.then(parseSecretCaptureTicket);
	}

	/** Post the plaintext to the secret broker, the one place that may see it.
	 * The ticket's capability is the only credential; nothing else identifies
	 * the member, and the answer carries a reference, never the value. */
	async captureSecret(ticket: CloudSecretCaptureTicket, value: string): Promise<CloudSecretReference> {
		if (!value || value.length > 32 * 1024) throw new Error("The secret is empty or too long.");
		const response = await fetch(`${ticket.serviceOrigin}/v1/captures/${ticket.ticketId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.cloud-secret-capture-request/v1",
				captureCapability: ticket.captureCapability,
				fields: { value },
			}),
			redirect: "error",
			credentials: "omit",
		});
		if (!response.ok) throw new Error("The secret could not be saved. Try again in a moment.");
		return parseSecretReference(await response.json());
	}

	/** Answer a typed card the agent raised (kernel bundle v70): queued like a
	 * prompt, so the agent wakes in its own thread with the answer. Never a secret
	 * value: a secret card answers with its outcome only. */
	answerInteraction(
		sessionId: string,
		clientInputId: string,
		interactionId: string,
		outcome: string,
		answer: Record<string, JsonValue> = {},
	): Promise<SessionInputReceipt> {
		return this.cloud
			.rpc("qorpera_answer_interaction", {
				p_session_id: requiredUuid(sessionId, "Session id"),
				p_client_input_id: requiredUuid(clientInputId, "Client input id"),
				p_interaction_id: requiredUuid(interactionId, "Interaction id"),
				p_outcome: outcome,
				p_answer: answer,
			})
			.then(parseSessionInputReceipt);
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

/** A saved secret as the custody describes it: ids, names and owner, never a value. */
export interface CloudSecretReference {
	secretId: string;
	version: number;
	connectorId: string;
	secretName: string;
	purpose: string;
	ownerKind: "company" | "member";
	ownerUserId?: string;
	status: "active" | "revoked";
}

export interface CloudSecretCaptureTicket {
	ticketId: string;
	captureCapability: string;
	serviceOrigin: string;
	secretId: string;
	version: number;
	expiresAt: string;
}

function parseSecretReference(value: unknown): CloudSecretReference {
	const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	if (
		typeof input.secretId !== "string" ||
		!Number.isSafeInteger(input.version) ||
		typeof input.connectorId !== "string" ||
		typeof input.secretName !== "string" ||
		(input.ownerKind !== "company" && input.ownerKind !== "member") ||
		(input.status !== "active" && input.status !== "revoked")
	)
		throw new Error("The saved secret's description is invalid.");
	return {
		secretId: requiredUuid(input.secretId, "Secret id"),
		version: input.version as number,
		connectorId: input.connectorId,
		secretName: input.secretName,
		purpose: typeof input.purpose === "string" ? input.purpose : "",
		ownerKind: input.ownerKind,
		...(typeof input.ownerUserId === "string" ? { ownerUserId: input.ownerUserId } : {}),
		status: input.status,
	};
}

function parseSecretReferences(value: unknown): CloudSecretReference[] {
	return Array.isArray(value) ? value.map(parseSecretReference) : [];
}

function parseSecretCaptureTicket(value: unknown): CloudSecretCaptureTicket {
	const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const scope =
		input.scope && typeof input.scope === "object" && !Array.isArray(input.scope)
			? (input.scope as Record<string, unknown>)
			: {};
	let origin: string;
	try {
		const url = new URL(String(input.serviceOrigin));
		if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error("origin");
		origin = url.origin;
	} catch {
		throw new Error("The secret service is not set up for this company.");
	}
	if (
		input.schema !== "qorpera.cloud-secret-capture/v1" ||
		typeof input.ticketId !== "string" ||
		typeof input.captureCapability !== "string" ||
		typeof scope.secretId !== "string" ||
		!Number.isSafeInteger(scope.version) ||
		typeof input.expiresAt !== "string"
	)
		throw new Error("The secret ticket is invalid.");
	return {
		ticketId: requiredUuid(input.ticketId, "Ticket id"),
		captureCapability: input.captureCapability,
		serviceOrigin: origin,
		secretId: requiredUuid(scope.secretId, "Secret id"),
		version: scope.version as number,
		expiresAt: input.expiresAt,
	};
}
