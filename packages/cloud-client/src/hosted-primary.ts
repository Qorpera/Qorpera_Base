import type { StaffAgent } from "@qorpera/company/company-staff";
import type { ExecutionIdentity, JsonValue } from "@qorpera/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type HostedCompanyOrganization, parseHostedCompanyOrganization } from "./cloud-company-organization.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PROFILE_NAME_LENGTH = 120;
const MAX_SESSION_TITLE_LENGTH = 256;
const MAX_AGENT_ID_LENGTH = 128;
const MAX_EVENT_BODY_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_REACHABILITY_STORAGE_BYTES = 2 * 1024 * 1024 * 1024 * 1024;

export const HOSTED_PROFILE_ROLES = ["owner", "admin", "contributor", "viewer"] as const;
export type HostedProfileRole = (typeof HOSTED_PROFILE_ROLES)[number];
const HOSTED_MEMBER_ROLES = ["admin", "contributor", "viewer"] as const;
export const HOSTED_INVITATION_DELIVERY_STATUSES = [
	"pending",
	"delivering",
	"retrying",
	"delivered",
	"failed",
] as const;
export type HostedInvitationDeliveryStatus = (typeof HOSTED_INVITATION_DELIVERY_STATUSES)[number];

export const HOSTED_SESSION_EVENT_TYPES = [
	"message",
	"session_info",
	"run_receipt",
	"artifact_receipt",
	"authorization_request",
	"authorization_decision",
	"interaction_request",
	"interaction_answer",
] as const;
export type HostedSessionEventType = (typeof HOSTED_SESSION_EVENT_TYPES)[number];

export const HOSTED_COMPANY_OPERATION_TYPES = ["staff_state", "session_state", "session_event"] as const;
export type HostedCompanyOperationType = (typeof HOSTED_COMPANY_OPERATION_TYPES)[number];

export const HOSTED_ARTIFACT_ROOT_CONTRACTS = ["qorpera.object/v1", "qorpera.cloud-file-manifest/v1"] as const;
export type HostedArtifactRootContract = (typeof HOSTED_ARTIFACT_ROOT_CONTRACTS)[number];

export interface HostedProfile {
	profileType: "cloud";
	profileId: string;
	environmentId: string;
	profileName: string;
	environmentName: string;
	role: HostedProfileRole;
	contractVersion: number;
	createdAt: string;
}

export interface HostedProfileInvitation {
	id: string;
	profileId: string;
	email: string;
	role: Exclude<HostedProfileRole, "owner">;
	invitedByUserId: string;
	createdAt: string;
	expiresAt: string;
	/** Present on the owner-side team listing only; the incoming-invitation
	 * listing has no delivery record (the invitee never sees delivery state). */
	delivery?: {
		status: HostedInvitationDeliveryStatus;
		attemptCount: number;
		nextAttemptAt: string;
		providerMessageId?: string;
		lastError?: string;
		sentAt?: string;
	};
}

export interface HostedIncomingProfileInvitation extends HostedProfileInvitation {
	environmentId: string;
	profileName: string;
	environmentName: string;
}

export interface HostedProfileMember {
	userId: string;
	email: string;
	displayName: string;
	avatarUrl?: string;
	role: HostedProfileRole;
	joinedAt: string;
}

export interface HostedProfileTeam {
	profileType: "cloud";
	profileId: string;
	role: HostedProfileRole;
	capabilities: {
		read: true;
		write: boolean;
		authorize: boolean;
		manageMembers: boolean;
	};
	members: HostedProfileMember[];
	invitations: HostedProfileInvitation[];
}

export type HostedSessionAudience = { kind: "company" } | { kind: "member_private"; userId: string };

export interface HostedSession {
	sessionId: string;
	/** Stable trail identity chosen by the originating kernel. */
	clientSessionId: string;
	profileId: string;
	environmentId: string;
	title: string;
	staffAgentId?: string;
	parentSessionId?: string;
	executionScope?: JsonValue;
	/** Immutable Company File revision used as this session's input base. */
	companySnapshotId?: string;
	/** Immutable hosted staff configuration version used at session start. */
	staffVersion?: number;
	/** Server-owned visibility boundary. Private staff trails never become company-wide chat state. */
	audience: HostedSessionAudience;
	status: "open" | "closed";
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
}

export interface HostedSessionPage {
	items: HostedSession[];
	hasMore: boolean;
	nextUpdatedAt?: string;
	nextId?: string;
}

export interface HostedRunnerExecutionIdentity {
	kind: "run";
	id: string;
	claimantId: string;
	runnerAssignmentId: string;
}

export type HostedSessionExecutionIdentity = ExecutionIdentity | HostedRunnerExecutionIdentity;

export interface HostedSessionEvent {
	sessionId: string;
	sequence: number;
	eventId: string;
	eventType: HostedSessionEventType;
	actorUserId: string;
	body: JsonValue;
	previousHash?: string;
	eventHash: string;
	execution?: HostedSessionExecutionIdentity;
	sessionInputId?: string;
	createdAt: string;
}

export interface HostedStaffAgent extends StaffAgent {
	profileId: string;
	version: number;
	updatedByUserId: string;
}

export interface HostedCompanySnapshot {
	snapshotId: string;
	profileId: string;
	environmentId: string;
	workspaceId: string;
	clientSnapshotId: string;
	parentSnapshotId?: string;
	tree: {
		manifestSha256: string;
		manifestBytes: number;
		contractVersion: number;
		fileCount: number;
		totalBytes: number;
	};
	createdByUserId: string;
	createdAt: string;
	publicationState?: "prepared" | "published";
}

export interface HostedAccountEntitlement {
	planKey: "freemium" | "internal";
	billingMode: "free" | "complimentary";
	featureSet: "standard" | "all";
	storageAllocation: "metered" | "unlimited";
	storageAllocationBytes?: number;
	source: "default" | "explicit";
	updatedAt?: string;
}

export interface HostedCompanyFile {
	profileId: string;
	environmentId: string;
	canonicalWorkspaceId: string;
	headSnapshotId?: string;
	state: "provisioning" | "ready";
	logicalBytes: number;
	retainedStorageBytes: number;
	storageUsedBytes: number;
	storageLimitBytes: number;
	objectBackends: string[];
	entitlement: HostedAccountEntitlement;
	createdAt: string;
	updatedAt: string;
}

export interface HostedCompanySubstrateVersion {
	versionId: string;
	profileId: string;
	environmentId: string;
	companySnapshotId: string;
	clientVersionId: string;
	contractVersion: number;
	operationSequence: number;
	operationCount: number;
	artifactIndexId?: string;
	artifactManifestSha256?: string;
	contentSha256: string;
	createdByUserId: string;
	createdAt: string;
}

export interface HostedArtifact {
	artifactId: string;
	profileId: string;
	environmentId: string;
	clientArtifactId: string;
	sessionId?: string;
	artifactType: string;
	name: string;
	rootObjectSha256: string;
	rootContract: HostedArtifactRootContract;
	contentSha256: string;
	bytes: number;
	mediaType: string;
	createdByUserId: string;
	createdAt: string;
	eligibleForGcAt: string;
}

export interface HostedArtifactIndex {
	indexId: string;
	profileId: string;
	environmentId: string;
	clientIndexId: string;
	contractVersion: 1;
	contentSha256: string;
	artifactCount: number;
	totalBytes: number;
	createdByUserId: string;
	createdAt: string;
}

export interface HostedArtifactIndexEntry extends HostedArtifact {
	ordinal: number;
}

export interface HostedCompanyOperation {
	profileId: string;
	sequence: number;
	environmentId?: string;
	operationType: HostedCompanyOperationType;
	entityId: string;
	entityVersion: number;
	contentSha256: string;
	payload: JsonValue;
	actorUserId: string;
	createdAt: string;
}

export interface HostedOperationExecution {
	kind: "turn" | "wake";
	id: string;
	claimantId: string;
}

export interface HostedPresenceIdentity {
	clientId: string;
	userId: string;
	name: string;
	publicKey: string;
}

export type HostedOperationReceiptBegin =
	| { started: true; status: "executing" }
	| { started: false; status: "executing" }
	| { started: false; status: "completed"; result: JsonValue };

export interface CreateHostedSessionInput {
	environmentId: string;
	clientSessionId: string;
	title: string;
	staffAgentId?: string;
	parentSessionId?: string;
	executionScope?: JsonValue;
	companySnapshotId?: string;
	staffVersion?: number;
}

export interface AppendHostedSessionEventInput {
	sessionId: string;
	eventId: string;
	eventType: HostedSessionEventType;
	body: JsonValue;
	/** Last sequence observed by the caller. The append fails if the trail advanced. */
	expectedSequence?: number;
	execution?: ExecutionIdentity;
}

export interface HostedPrimaryTransport {
	getCompanyOrganization(input: { p_profile_id: string }): Promise<unknown>;
	listProfiles(): Promise<unknown>;
	getAccountEntitlement(): Promise<unknown>;
	inviteMember(input: {
		p_profile_id: string;
		p_email: string;
		p_role: Exclude<HostedProfileRole, "owner">;
	}): Promise<unknown>;
	listInvitations(): Promise<unknown>;
	acceptInvitation(input: { p_invitation_id: string }): Promise<unknown>;
	leaveProfile(input: { p_profile_id: string }): Promise<unknown>;
	deleteProfile(input: { p_profile_id: string }): Promise<unknown>;
	declineInvitation(input: { p_invitation_id: string }): Promise<unknown>;
	profileTeam(input: { p_profile_id: string }): Promise<unknown>;
	cancelInvitation(input: { p_profile_id: string; p_invitation_id: string }): Promise<unknown>;
	retryInvitationDelivery(input: { p_profile_id: string; p_invitation_id: string }): Promise<unknown>;
	updateMemberRole(input: {
		p_profile_id: string;
		p_member_user_id: string;
		p_role: Exclude<HostedProfileRole, "owner">;
	}): Promise<unknown>;
	removeMember(input: { p_profile_id: string; p_member_user_id: string }): Promise<unknown>;
	listStaff(input: { p_profile_id: string }): Promise<unknown>;
	createSession(input: {
		p_environment_id: string;
		p_client_session_id: string;
		p_title: string;
		p_staff_agent_id: string | null;
		p_parent_session_id: string | null;
		p_execution_scope: JsonValue;
		p_company_snapshot_id: string | null;
		p_staff_version: number | null;
	}): Promise<unknown>;
	closeSession(input: { p_session_id: string }): Promise<unknown>;
	listSessions(input: { p_environment_id: string }): Promise<unknown>;
	listSessionsPage(input: {
		p_environment_id: string;
		p_after_updated_at: string | null;
		p_after_id: string | null;
		p_limit: number;
	}): Promise<unknown>;
	getSessionByClient(input: { p_environment_id: string; p_client_session_id: string }): Promise<unknown>;
	ensureStaffSession(input: {
		p_environment_id: string;
		p_staff_agent_id: string;
		p_client_session_id: string;
		p_title: string;
	}): Promise<unknown>;
	appendSessionInput(input: {
		p_session_id: string;
		p_client_input_id: string;
		p_kind: "user_message";
		p_body: JsonValue;
	}): Promise<unknown>;
	listSessionInputs(input: { p_session_id: string; p_after_position: number; p_limit: number }): Promise<unknown>;
	listStaffExecutionActivity(input: { p_environment_id: string }): Promise<unknown>;
	resolveFailedExecutionRun(input: { p_run_id: string; p_action: "retry" | "discard" }): Promise<unknown>;
	beginOperationReceipt(input: {
		p_execution_kind: HostedOperationExecution["kind"];
		p_execution_id: string;
		p_claimant_id: string;
		p_operation_id: string;
		p_operation_kind: string;
		p_input_sha256: string;
	}): Promise<unknown>;
	stageOperationReceiptObjects(input: {
		p_execution_id: string;
		p_claimant_id: string;
		p_operation_id: string;
		p_objects: JsonValue;
	}): Promise<unknown>;
	completeOperationReceipt(input: {
		p_execution_id: string;
		p_claimant_id: string;
		p_operation_id: string;
		p_result: JsonValue;
	}): Promise<unknown>;
	resolveOperationReceipt(input: {
		p_operation_id: string;
		p_resolution: "confirmed_completed" | "confirmed_not_run";
		p_result: JsonValue | null;
	}): Promise<unknown>;
	resolveRunOperationReceipt(input: {
		p_receipt_id: string;
		p_resolution: "confirmed_completed" | "confirmed_not_run";
		p_result: JsonValue | null;
		p_output_snapshot_id: string | null;
		p_proposal_id: string | null;
	}): Promise<unknown>;
	registerPresenceDevice(input: { p_profile_id: string; p_client_id: string; p_public_key: string }): Promise<unknown>;
	listPresenceDevices(input: { p_profile_id: string; p_client_ids: string[] }): Promise<unknown>;
	unregisterPresenceDevice(input: { p_profile_id: string; p_client_id: string }): Promise<unknown>;
	sendFriendRequest(input: { p_email: string }): Promise<unknown>;
	listFriends(): Promise<unknown>;
	respondFriendRequest(input: { p_user_id: string; p_accept: boolean }): Promise<unknown>;
	removeFriend(input: { p_user_id: string }): Promise<unknown>;
	appendAccountEvent(input: {
		p_session_id: string;
		p_event_id: string;
		p_event_type: HostedSessionEventType;
		p_body: JsonValue;
		p_expected_sequence: number | null;
		p_execution_kind: ExecutionIdentity["kind"] | null;
		p_execution_id: string | null;
		p_execution_claimant_id: string | null;
	}): Promise<unknown>;
	readSessionEvents(input: { p_session_id: string; p_after_sequence: number; p_limit: number }): Promise<unknown>;
	getCompanyFile(input: { p_environment_id: string }): Promise<unknown>;
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
			qorpera_create_shared_session_v4: {
				Args: {
					p_environment_id: string;
					p_client_session_id: string;
					p_title: string;
					p_staff_agent_id: string | null;
					p_parent_session_id: string | null;
					p_execution_scope: JsonValue;
					p_company_snapshot_id: string | null;
					p_staff_version: number | null;
				};
				Returns: JsonValue;
			};
			qorpera_close_shared_session: { Args: { p_session_id: string }; Returns: JsonValue };
			qorpera_list_shared_sessions: { Args: { p_environment_id: string }; Returns: JsonValue };
			qorpera_list_shared_sessions_page: {
				Args: {
					p_environment_id: string;
					p_after_updated_at: string | null;
					p_after_id: string | null;
					p_limit: number;
				};
				Returns: JsonValue;
			};
			qorpera_get_shared_session_by_client: {
				Args: { p_environment_id: string; p_client_session_id: string };
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
			qorpera_begin_operation_receipt: {
				Args: {
					p_execution_kind: HostedOperationExecution["kind"];
					p_execution_id: string;
					p_claimant_id: string;
					p_operation_id: string;
					p_operation_kind: string;
					p_input_sha256: string;
				};
				Returns: JsonValue;
			};
			qorpera_stage_operation_receipt_objects: {
				Args: {
					p_execution_id: string;
					p_claimant_id: string;
					p_operation_id: string;
					p_objects: JsonValue;
				};
				Returns: JsonValue;
			};
			qorpera_complete_operation_receipt: {
				Args: {
					p_execution_id: string;
					p_claimant_id: string;
					p_operation_id: string;
					p_result: JsonValue;
				};
				Returns: JsonValue;
			};
			qorpera_resolve_operation_receipt: {
				Args: { p_operation_id: string; p_resolution: string; p_result: JsonValue | null };
				Returns: JsonValue;
			};
			qorpera_resolve_run_operation_receipt: {
				Args: {
					p_receipt_id: string;
					p_resolution: string;
					p_result: JsonValue | null;
					p_output_snapshot_id: string | null;
					p_proposal_id: string | null;
				};
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
			qorpera_append_account_event: {
				Args: {
					p_session_id: string;
					p_event_id: string;
					p_event_type: HostedSessionEventType;
					p_body: JsonValue;
					p_expected_sequence: number | null;
					p_execution_kind: ExecutionIdentity["kind"] | null;
					p_execution_id: string | null;
					p_execution_claimant_id: string | null;
				};
				Returns: JsonValue;
			};
			qorpera_read_session_events: {
				Args: { p_session_id: string; p_after_sequence: number; p_limit: number };
				Returns: JsonValue;
			};
			qorpera_get_company_file: { Args: { p_environment_id: string }; Returns: JsonValue };
		};
	};
}

function rpcError(error: { message: string; code?: string }): Error {
	return new Error(error.code ? `${error.message} (${error.code})` : error.message);
}

export class SupabaseHostedPrimaryTransport implements HostedPrimaryTransport {
	private readonly client: SupabaseClient<HostedPrimaryDatabase>;

	constructor(client: SupabaseClient<HostedPrimaryDatabase>) {
		this.client = client;
	}

	async getCompanyOrganization(
		input: Parameters<HostedPrimaryTransport["getCompanyOrganization"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_company_organization_json", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listProfiles(): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_hosted_profiles", {});
		if (error) throw rpcError(error);
		return data;
	}

	async getAccountEntitlement(): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_account_entitlement", {});
		if (error) throw rpcError(error);
		return data;
	}

	async inviteMember(input: Parameters<HostedPrimaryTransport["inviteMember"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_invite_profile_member", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listInvitations(): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_profile_invitations", {});
		if (error) throw rpcError(error);
		return data;
	}

	async acceptInvitation(input: Parameters<HostedPrimaryTransport["acceptInvitation"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_accept_profile_invitation", input);
		if (error) throw rpcError(error);
		return data;
	}

	async declineInvitation(input: Parameters<HostedPrimaryTransport["declineInvitation"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_decline_profile_invitation", input);
		if (error) throw rpcError(error);
		return data;
	}

	async leaveProfile(input: Parameters<HostedPrimaryTransport["leaveProfile"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_leave_hosted_profile", input);
		if (error) throw rpcError(error);
		return data;
	}

	async deleteProfile(input: Parameters<HostedPrimaryTransport["deleteProfile"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_delete_hosted_profile", input);
		if (error) throw rpcError(error);
		return data;
	}

	async ensureStaffSession(input: Parameters<HostedPrimaryTransport["ensureStaffSession"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_ensure_staff_session", input);
		if (error) throw rpcError(error);
		return data;
	}

	async appendSessionInput(input: Parameters<HostedPrimaryTransport["appendSessionInput"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_append_session_input", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listSessionInputs(input: Parameters<HostedPrimaryTransport["listSessionInputs"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_session_inputs", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listStaffExecutionActivity(
		input: Parameters<HostedPrimaryTransport["listStaffExecutionActivity"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_staff_execution_activity", input);
		if (error) throw rpcError(error);
		return data;
	}

	async resolveFailedExecutionRun(
		input: Parameters<HostedPrimaryTransport["resolveFailedExecutionRun"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_resolve_failed_execution_run", input);
		if (error) throw rpcError(error);
		return data;
	}

	async beginOperationReceipt(
		input: Parameters<HostedPrimaryTransport["beginOperationReceipt"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_begin_operation_receipt", input);
		if (error) throw rpcError(error);
		return data;
	}

	async stageOperationReceiptObjects(
		input: Parameters<HostedPrimaryTransport["stageOperationReceiptObjects"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_stage_operation_receipt_objects", input);
		if (error) throw rpcError(error);
		return data;
	}

	async completeOperationReceipt(
		input: Parameters<HostedPrimaryTransport["completeOperationReceipt"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_complete_operation_receipt", input);
		if (error) throw rpcError(error);
		return data;
	}

	async resolveOperationReceipt(
		input: Parameters<HostedPrimaryTransport["resolveOperationReceipt"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_resolve_operation_receipt", input);
		if (error) throw rpcError(error);
		return data;
	}

	async resolveRunOperationReceipt(
		input: Parameters<HostedPrimaryTransport["resolveRunOperationReceipt"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_resolve_run_operation_receipt", input);
		if (error) throw rpcError(error);
		return data;
	}

	async registerPresenceDevice(
		input: Parameters<HostedPrimaryTransport["registerPresenceDevice"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_register_presence_device", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listPresenceDevices(input: Parameters<HostedPrimaryTransport["listPresenceDevices"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_presence_devices", input);
		if (error) throw rpcError(error);
		return data;
	}

	async unregisterPresenceDevice(
		input: Parameters<HostedPrimaryTransport["unregisterPresenceDevice"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_unregister_presence_device", input);
		if (error) throw rpcError(error);
		return data;
	}

	async sendFriendRequest(input: Parameters<HostedPrimaryTransport["sendFriendRequest"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_send_friend_request", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listFriends(): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_friends", {});
		if (error) throw rpcError(error);
		return data;
	}

	async respondFriendRequest(input: Parameters<HostedPrimaryTransport["respondFriendRequest"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_respond_friend_request", input);
		if (error) throw rpcError(error);
		return data;
	}

	async removeFriend(input: Parameters<HostedPrimaryTransport["removeFriend"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_remove_friend", input);
		if (error) throw rpcError(error);
		return data;
	}

	async profileTeam(input: Parameters<HostedPrimaryTransport["profileTeam"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_profile_team_info", input);
		if (error) throw rpcError(error);
		return data;
	}

	async cancelInvitation(input: Parameters<HostedPrimaryTransport["cancelInvitation"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_cancel_profile_invitation", input);
		if (error) throw rpcError(error);
		return data;
	}

	async retryInvitationDelivery(
		input: Parameters<HostedPrimaryTransport["retryInvitationDelivery"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_retry_profile_invitation_delivery", input);
		if (error) throw rpcError(error);
		return data;
	}

	async updateMemberRole(input: Parameters<HostedPrimaryTransport["updateMemberRole"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_update_profile_member_role", input);
		if (error) throw rpcError(error);
		return data;
	}

	async removeMember(input: Parameters<HostedPrimaryTransport["removeMember"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_remove_profile_member", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listStaff(input: Parameters<HostedPrimaryTransport["listStaff"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_profile_staff", input);
		if (error) throw rpcError(error);
		return data;
	}

	async createSession(input: Parameters<HostedPrimaryTransport["createSession"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_create_shared_session_v4", input);
		if (error) throw rpcError(error);
		return data;
	}

	async closeSession(input: Parameters<HostedPrimaryTransport["closeSession"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_close_shared_session", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listSessions(input: Parameters<HostedPrimaryTransport["listSessions"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_shared_sessions", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listSessionsPage(input: Parameters<HostedPrimaryTransport["listSessionsPage"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_shared_sessions_page", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getSessionByClient(input: Parameters<HostedPrimaryTransport["getSessionByClient"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_shared_session_by_client", input);
		if (error) throw rpcError(error);
		return data;
	}

	async appendAccountEvent(input: Parameters<HostedPrimaryTransport["appendAccountEvent"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_append_account_event", input);
		if (error) throw rpcError(error);
		return data;
	}

	async readSessionEvents(input: Parameters<HostedPrimaryTransport["readSessionEvents"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_read_session_events", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getCompanyFile(input: Parameters<HostedPrimaryTransport["getCompanyFile"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_company_file", input);
		if (error) throw rpcError(error);
		return data;
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Hosted primary returned invalid ${label}`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value))
		throw new Error(`Hosted primary returned invalid ${label}`);
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return value;
}

function nonEmptyString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return value;
}

function role(value: unknown): HostedProfileRole {
	if (!HOSTED_PROFILE_ROLES.some((candidate) => candidate === value)) {
		throw new Error("Hosted primary returned invalid profile role");
	}
	return value as HostedProfileRole;
}

function invitationDeliveryStatus(value: unknown): HostedInvitationDeliveryStatus {
	if (!HOSTED_INVITATION_DELIVERY_STATUSES.some((candidate) => candidate === value)) {
		throw new Error("Hosted primary returned invalid invitation delivery status");
	}
	return value as HostedInvitationDeliveryStatus;
}

function sessionEventType(value: unknown): HostedSessionEventType {
	if (!HOSTED_SESSION_EVENT_TYPES.some((candidate) => candidate === value)) {
		throw new Error("Hosted primary returned invalid event type");
	}
	return value as HostedSessionEventType;
}

function jsonValue(value: unknown, seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object") throw new Error("Hosted primary returned a non-JSON event body");
	if (seen.has(value)) throw new Error("Hosted primary returned a circular event body");
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, seen));
		const output: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) output[key] = jsonValue(entry, seen);
		return output;
	} finally {
		seen.delete(value);
	}
}

function parseProfile(value: unknown): HostedProfile {
	const input = record(value, "profile");
	const contractVersion = input.contract_version;
	if (!Number.isSafeInteger(contractVersion) || (contractVersion as number) < 1) {
		throw new Error("Hosted primary returned invalid environment contract version");
	}
	return {
		profileType: "cloud",
		profileId: uuid(input.profile_id, "profile id"),
		environmentId: uuid(input.environment_id, "environment id"),
		profileName: nonEmptyString(input.profile_name, "profile name", MAX_PROFILE_NAME_LENGTH),
		environmentName: nonEmptyString(input.environment_name, "environment name", MAX_PROFILE_NAME_LENGTH),
		role: role(input.role),
		contractVersion: contractVersion as number,
		createdAt: timestamp(input.created_at, "profile creation time"),
	};
}

function parseCompanyFile(value: unknown): HostedCompanyFile {
	const input = record(value, "company file");
	const headSnapshotId = input.head_snapshot_id;
	const state = input.state;
	if (state !== "provisioning" && state !== "ready") {
		throw new Error("Hosted primary returned invalid company file state");
	}
	if ((state === "ready") !== (typeof headSnapshotId === "string")) {
		throw new Error("Hosted primary returned inconsistent company file state");
	}
	return {
		profileId: uuid(input.profile_id, "company file profile id"),
		environmentId: uuid(input.environment_id, "company file environment id"),
		canonicalWorkspaceId: uuid(input.canonical_workspace_id, "company file workspace id"),
		...(typeof headSnapshotId === "string"
			? { headSnapshotId: uuid(headSnapshotId, "company file head snapshot id") }
			: {}),
		state,
		logicalBytes: boundedInteger(input.logical_bytes, "company file logical bytes", 0, MAX_TREE_BYTES),
		retainedStorageBytes: boundedInteger(
			input.retained_storage_bytes,
			"company file retained storage",
			0,
			MAX_REACHABILITY_STORAGE_BYTES,
		),
		storageUsedBytes: boundedInteger(
			input.storage_used_bytes,
			"company file storage usage",
			0,
			MAX_REACHABILITY_STORAGE_BYTES,
		),
		storageLimitBytes: boundedInteger(
			input.storage_limit_bytes,
			"company file storage allowance",
			1,
			MAX_REACHABILITY_STORAGE_BYTES,
		),
		objectBackends: array(input.object_backends, "company file object backends").map((backend) =>
			nonEmptyString(backend, "company file object backend", 128),
		),
		entitlement: parseAccountEntitlement(input.entitlement),
		createdAt: timestamp(input.created_at, "company file creation time"),
		updatedAt: timestamp(input.updated_at, "company file update time"),
	};
}

function parseAccountEntitlement(value: unknown): HostedAccountEntitlement {
	const input = record(value, "account entitlement");
	const planKey = input.plan_key;
	const billingMode = input.billing_mode;
	const featureSet = input.feature_set;
	const storageAllocation = input.storage_allocation;
	const source = input.source;
	if (planKey !== "freemium" && planKey !== "internal") {
		throw new Error("Hosted primary returned invalid account plan");
	}
	if (billingMode !== "free" && billingMode !== "complimentary") {
		throw new Error("Hosted primary returned invalid account billing mode");
	}
	if (featureSet !== "standard" && featureSet !== "all") {
		throw new Error("Hosted primary returned invalid account feature set");
	}
	if (storageAllocation !== "metered" && storageAllocation !== "unlimited") {
		throw new Error("Hosted primary returned invalid account storage allocation");
	}
	if (source !== "default" && source !== "explicit") {
		throw new Error("Hosted primary returned invalid account entitlement source");
	}
	const isFreemium =
		planKey === "freemium" && billingMode === "free" && featureSet === "standard" && storageAllocation === "metered";
	const isInternal =
		planKey === "internal" &&
		billingMode === "complimentary" &&
		featureSet === "all" &&
		storageAllocation === "unlimited";
	if (!isFreemium && !isInternal) {
		throw new Error("Hosted primary returned inconsistent account entitlement");
	}
	const storageAllocationBytes = input.storage_allocation_bytes;
	const updatedAt = input.updated_at;
	if (storageAllocation === "unlimited" && storageAllocationBytes !== null) {
		throw new Error("Hosted primary returned a limit for unlimited account storage");
	}
	return {
		planKey,
		billingMode,
		featureSet,
		storageAllocation,
		...(storageAllocation === "metered"
			? {
					storageAllocationBytes: boundedInteger(
						storageAllocationBytes,
						"account storage allocation",
						1,
						MAX_REACHABILITY_STORAGE_BYTES,
					),
				}
			: {}),
		source,
		...(typeof updatedAt === "string" ? { updatedAt: timestamp(updatedAt, "account entitlement update time") } : {}),
	};
}

function parseInvitationDelivery(value: unknown): HostedProfileInvitation["delivery"] {
	const delivery = record(value, "invitation delivery");
	const deliveryStatus = invitationDeliveryStatus(delivery.status);
	const attemptCount = delivery.attempt_count;
	if (!Number.isSafeInteger(attemptCount) || (attemptCount as number) < 0) {
		throw new Error("Hosted primary returned invalid invitation delivery attempt count");
	}
	const providerMessageId = delivery.provider_message_id;
	const lastError = delivery.last_error;
	const sentAt = delivery.sent_at;
	if (deliveryStatus === "delivered" ? typeof sentAt !== "string" : sentAt !== null && sentAt !== undefined) {
		throw new Error("Hosted primary returned inconsistent invitation delivery status");
	}
	return {
		status: deliveryStatus,
		attemptCount: attemptCount as number,
		nextAttemptAt: timestamp(delivery.next_attempt_at, "invitation delivery retry time"),
		...(providerMessageId === null || providerMessageId === undefined
			? {}
			: { providerMessageId: nonEmptyString(providerMessageId, "provider message id", 256) }),
		...(lastError === null || lastError === undefined
			? {}
			: { lastError: nonEmptyString(lastError, "invitation delivery error", 1000) }),
		...(typeof sentAt === "string" ? { sentAt: timestamp(sentAt, "invitation delivery time") } : {}),
	};
}

function parseInvitation(value: unknown): HostedProfileInvitation {
	const input = record(value, "profile invitation");
	const invitationRole = role(input.role);
	if (invitationRole === "owner") throw new Error("Hosted primary returned an owner invitation");
	return {
		id: uuid(input.id, "invitation id"),
		profileId: uuid(input.profile_id, "invitation profile id"),
		email: nonEmptyString(input.email, "invitation email", 320),
		role: invitationRole,
		invitedByUserId: uuid(input.invited_by_user_id, "invitation actor id"),
		createdAt: timestamp(input.created_at, "invitation creation time"),
		expiresAt: timestamp(input.expires_at, "invitation expiry"),
		// The incoming listing (qorpera_list_profile_invitations) has never
		// returned a delivery record; demanding one made every invitee's
		// listing throw, and swallowed catches turned that into invitations
		// that simply never appeared anywhere.
		...(input.delivery === null || input.delivery === undefined
			? {}
			: { delivery: parseInvitationDelivery(input.delivery) }),
	};
}

function parseIncomingInvitation(value: unknown): HostedIncomingProfileInvitation {
	const invitation = parseInvitation(value);
	const input = record(value, "incoming profile invitation");
	return {
		...invitation,
		environmentId: uuid(input.environment_id, "invitation environment id"),
		profileName: nonEmptyString(input.profile_name, "invitation profile name", MAX_PROFILE_NAME_LENGTH),
		environmentName: nonEmptyString(input.environment_name, "invitation environment name", MAX_PROFILE_NAME_LENGTH),
	};
}

function parseMember(value: unknown): HostedProfileMember {
	const input = record(value, "profile member");
	const avatarUrl = input.avatar_url;
	return {
		userId: uuid(input.user_id, "member user id"),
		email: nonEmptyString(input.email, "member email", 320),
		displayName: nonEmptyString(input.display_name, "member display name", 256),
		...(avatarUrl === null || avatarUrl === undefined
			? {}
			: { avatarUrl: nonEmptyString(avatarUrl, "member avatar URL", 2048) }),
		role: role(input.role),
		joinedAt: timestamp(input.joined_at, "member join time"),
	};
}

function parseTeam(value: unknown): HostedProfileTeam {
	const input = record(value, "profile team");
	const teamRole = role(input.role);
	const capabilities = record(input.capabilities, "profile capabilities");
	const write = capabilities.write;
	const authorize = capabilities.authorize;
	const manageMembers = capabilities.manage_members;
	if (capabilities.read !== true || typeof write !== "boolean" || typeof authorize !== "boolean") {
		throw new Error("Hosted primary returned invalid profile capabilities");
	}
	if (typeof manageMembers !== "boolean" || authorize !== manageMembers) {
		throw new Error("Hosted primary returned invalid profile member-management capability");
	}
	if (write !== (teamRole !== "viewer") || authorize !== (teamRole === "owner" || teamRole === "admin")) {
		throw new Error("Hosted primary returned capabilities inconsistent with the profile role");
	}
	return {
		profileType: "cloud",
		profileId: uuid(input.profile_id, "team profile id"),
		role: teamRole,
		capabilities: { read: true, write, authorize, manageMembers },
		members: array(input.members, "profile member list").map(parseMember),
		invitations: array(input.invitations, "profile invitation list").map(parseInvitation),
	};
}

function requireTrue(value: unknown, label: string): void {
	if (value !== true) throw new Error(`Hosted primary returned invalid ${label}`);
}

function parseSessionAudience(input: Record<string, unknown>): HostedSessionAudience {
	const audienceKind = input.audience_kind;
	const audienceUserId = input.audience_user_id;
	if (audienceKind === "company" && (audienceUserId === null || audienceUserId === undefined)) {
		return { kind: "company" };
	}
	if (audienceKind === "member_private" && typeof audienceUserId === "string") {
		return { kind: "member_private", userId: uuid(audienceUserId, "session audience user id") };
	}
	throw new Error("Hosted primary returned invalid session audience");
}

function parseSession(value: unknown): HostedSession {
	const input = record(value, "session");
	const status = input.status;
	if (status !== "open" && status !== "closed") throw new Error("Hosted primary returned invalid session status");
	const staffAgentId = input.staff_agent_id;
	const parentSessionId = input.parent_session_id;
	const companySnapshotId = input.company_snapshot_id;
	const staffVersion = input.staff_version;
	const executionScope = input.execution_scope;
	const parsedExecutionScope =
		executionScope === null || executionScope === undefined ? undefined : jsonValue(executionScope);
	if (
		parsedExecutionScope !== undefined &&
		(typeof parsedExecutionScope !== "object" || Array.isArray(parsedExecutionScope))
	) {
		throw new Error("Hosted primary returned invalid session execution scope");
	}
	return {
		sessionId: uuid(input.session_id, "session id"),
		clientSessionId: uuid(input.client_session_id, "client session id"),
		profileId: uuid(input.profile_id, "session profile id"),
		environmentId: uuid(input.environment_id, "session environment id"),
		title: nonEmptyString(input.title, "session title", MAX_SESSION_TITLE_LENGTH),
		...(staffAgentId === null || staffAgentId === undefined
			? {}
			: { staffAgentId: nonEmptyString(staffAgentId, "staff agent id", MAX_AGENT_ID_LENGTH) }),
		...(parentSessionId === null || parentSessionId === undefined
			? {}
			: { parentSessionId: uuid(parentSessionId, "parent session id") }),
		...(parsedExecutionScope === undefined ? {} : { executionScope: parsedExecutionScope }),
		...(companySnapshotId === null || companySnapshotId === undefined
			? {}
			: { companySnapshotId: uuid(companySnapshotId, "session company snapshot id") }),
		...(staffVersion === null || staffVersion === undefined
			? {}
			: { staffVersion: boundedInteger(staffVersion, "session staff version", 1, Number.MAX_SAFE_INTEGER) }),
		audience: parseSessionAudience(input),
		status,
		createdByUserId: uuid(input.created_by_user_id, "session creator id"),
		createdAt: timestamp(input.created_at, "session creation time"),
		updatedAt: timestamp(input.updated_at, "session update time"),
	};
}

function parseStaff(value: unknown): HostedStaffAgent {
	const input = record(value, "staff agent");
	const staffVersion = input.version;
	if (!Number.isSafeInteger(staffVersion) || (staffVersion as number) < 1) {
		throw new Error("Hosted primary returned invalid staff version");
	}
	const employmentStatus = input.employment_status;
	if (employmentStatus !== "active" && employmentStatus !== "archived") {
		throw new Error("Hosted primary returned invalid staff employment status");
	}
	const lifecycleState = input.lifecycle_state;
	if (lifecycleState !== "setup" && lifecycleState !== "active") {
		throw new Error("Hosted primary returned invalid staff lifecycle state");
	}
	const appearanceCreature = input.appearance_creature;
	const modelProvider = input.model_provider;
	const modelId = input.model_id;
	if ((modelProvider === null || modelProvider === undefined) !== (modelId === null || modelId === undefined)) {
		throw new Error("Hosted primary returned an incomplete staff model selection");
	}
	const templateId = input.template_id;
	const departmentId = input.department_id;
	const staffText = (text: unknown, label: string, maxBytes: number, multiline: boolean): string => {
		const checked = nonEmptyString(text, label, maxBytes);
		if (checked !== checked.trim() || checked.includes("\0") || (!multiline && /[\r\n]/.test(checked))) {
			throw new Error(`Hosted primary returned invalid ${label}`);
		}
		if (Buffer.byteLength(checked, "utf-8") > maxBytes) {
			throw new Error(`Hosted primary returned invalid ${label}`);
		}
		return checked;
	};
	const canonicalTimestamp = (time: unknown, label: string): string => new Date(timestamp(time, label)).toISOString();
	return {
		profileId: uuid(input.profile_id, "staff profile id"),
		id: uuid(input.staff_agent_id, "staff agent id"),
		displayName: staffText(input.display_name, "staff display name", 160, false),
		role: staffText(input.role, "staff role", 320, false),
		charter: staffText(input.charter, "staff charter", 32 * 1024, true),
		...(templateId === null || templateId === undefined
			? {}
			: { templateId: staffText(templateId, "staff template id", 256, false) }),
		...(departmentId === null || departmentId === undefined
			? {}
			: { departmentId: staffText(departmentId, "staff department id", 256, false) }),
		appearance: {
			color: staffText(input.appearance_color, "staff appearance color", 64, false),
			shape: staffText(input.appearance_shape, "staff appearance shape", 64, false),
			...(appearanceCreature === null || appearanceCreature === undefined
				? {}
				: { creature: staffText(appearanceCreature, "staff appearance creature", 64, false) }),
		},
		...(modelProvider === null || modelProvider === undefined
			? {}
			: {
					model: {
						provider: staffText(modelProvider, "staff model provider", 128, false),
						modelId: staffText(modelId, "staff model id", 256, false),
					},
				}),
		employmentStatus,
		lifecycleState,
		version: staffVersion as number,
		createdAt: canonicalTimestamp(input.created_at, "staff creation time"),
		updatedAt: canonicalTimestamp(input.updated_at, "staff update time"),
		updatedByUserId: uuid(input.updated_by_user_id, "staff updating user id"),
	};
}

function parseEvent(value: unknown): HostedSessionEvent {
	const input = record(value, "session event");
	const sequence = input.sequence;
	const previousHash = input.previous_hash;
	if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
		throw new Error("Hosted primary returned invalid event sequence");
	}
	if (
		previousHash !== null &&
		previousHash !== undefined &&
		(typeof previousHash !== "string" || !SHA256_PATTERN.test(previousHash))
	) {
		throw new Error("Hosted primary returned invalid previous event hash");
	}
	if (typeof input.event_hash !== "string" || !SHA256_PATTERN.test(input.event_hash)) {
		throw new Error("Hosted primary returned invalid event hash");
	}
	const executionKind = input.execution_kind;
	const executionId = input.execution_id;
	const executionClaimantId = input.execution_claimant_id;
	const runnerAssignmentId = input.runner_assignment_id;
	const sessionInputId = input.session_input_id;
	if (
		(executionKind === null || executionKind === undefined) !== (executionId === null || executionId === undefined) ||
		(executionKind === null || executionKind === undefined) !==
			(executionClaimantId === null || executionClaimantId === undefined) ||
		(executionKind !== null &&
			executionKind !== undefined &&
			executionKind !== "turn" &&
			executionKind !== "wake" &&
			executionKind !== "run") ||
		(executionKind === "run") !== (runnerAssignmentId !== null && runnerAssignmentId !== undefined) ||
		(sessionInputId !== null && sessionInputId !== undefined && executionKind !== null && executionKind !== undefined)
	) {
		throw new Error("Hosted primary returned invalid event execution identity");
	}
	return {
		sessionId: uuid(input.session_id, "event session id"),
		sequence: sequence as number,
		eventId: uuid(input.event_id, "event id"),
		eventType: sessionEventType(input.event_type),
		actorUserId: uuid(input.actor_user_id, "event actor id"),
		body: jsonValue(input.body),
		...(typeof previousHash === "string" ? { previousHash } : {}),
		eventHash: input.event_hash,
		...(executionKind === "run"
			? {
					execution: {
						kind: "run" as const,
						id: uuid(executionId, "event execution id"),
						claimantId: uuid(executionClaimantId, "event execution claimant id"),
						runnerAssignmentId: uuid(runnerAssignmentId, "event runner assignment id"),
					},
				}
			: executionKind === "turn" || executionKind === "wake"
				? {
						execution: {
							kind: executionKind,
							id: uuid(executionId, "event execution id"),
							claimantId: uuid(executionClaimantId, "event execution claimant id"),
						},
					}
				: {}),
		...(sessionInputId === null || sessionInputId === undefined
			? {}
			: { sessionInputId: uuid(sessionInputId, "event session input id") }),
		createdAt: timestamp(input.created_at, "event creation time"),
	};
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return value as number;
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`Hosted primary returned invalid ${label}`);
	return value;
}

function requiredUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

function requiredText(value: string, label: string, maxLength: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maxLength) throw new Error(`${label} is invalid`);
	return normalized;
}

export interface StaffSessionHandle {
	sessionId: string;
	clientSessionId: string;
	environmentId: string;
	title: string;
	companySnapshotId?: string;
	staffVersion?: number;
	audience: HostedSessionAudience;
	created: boolean;
	createdByUserId: string;
	createdAt: string;
}

export interface SessionTurnInput {
	inputId: string;
	position: number;
	kind: "kickoff" | "user_message";
	authorUserId: string;
	authorDisplayName: string;
	body: JsonValue;
	createdAt: string;
}

export interface SessionInputReceipt {
	inputId: string;
	position: number;
}

export interface PendingSessionInput extends SessionTurnInput {
	status: "queued" | "processing" | "failed";
	failureReason?: string;
}

export interface PendingSessionInputPage {
	items: PendingSessionInput[];
	nextAfterPosition: number;
	hasMore: boolean;
}

export interface HostedStaffExecutionActivity {
	runId: string;
	staffAgentId: string;
	sourceKind: "session_turn" | "wake" | "manual" | "room_delivery" | "proposal_review" | "system";
	jobStatus: "queued" | "leased" | "completed" | "failed" | "cancelled";
	activity: "waiting" | "working" | "needs_attention";
	updatedAt: string;
}

function parseStaffSessionHandle(value: unknown): StaffSessionHandle {
	const payload = record(value, "staff session");
	const companySnapshotId = payload.company_snapshot_id;
	const staffVersion = payload.staff_version;
	return {
		sessionId: uuid(payload.session_id, "Session id"),
		clientSessionId: uuid(payload.client_session_id, "Client session id"),
		environmentId: uuid(payload.environment_id, "Environment id"),
		title: String(payload.title ?? ""),
		...(companySnapshotId === null || companySnapshotId === undefined
			? {}
			: { companySnapshotId: uuid(companySnapshotId, "Session Company File revision") }),
		...(staffVersion === null || staffVersion === undefined
			? {}
			: { staffVersion: boundedInteger(staffVersion, "Session staff version", 1, Number.MAX_SAFE_INTEGER) }),
		audience: parseSessionAudience(payload),
		created: payload.created === true,
		createdByUserId: uuid(payload.created_by_user_id, "Session creator"),
		createdAt: timestamp(payload.created_at, "Session creation time"),
	};
}

function parseOperationReceiptBegin(value: unknown): HostedOperationReceiptBegin {
	const receipt = record(value, "operation receipt");
	if (receipt.status === "completed") {
		if (receipt.started !== false) throw new Error("Hosted primary returned inconsistent operation receipt");
		return { started: false, status: "completed", result: jsonValue(receipt.result) };
	}
	if (receipt.status !== "executing" || typeof receipt.started !== "boolean" || receipt.result != null) {
		throw new Error("Hosted primary returned invalid operation receipt");
	}
	return { started: receipt.started, status: "executing" };
}

function parsePresenceIdentity(value: unknown): HostedPresenceIdentity {
	const identity = record(value, "presence identity");
	return {
		clientId: uuid(identity.client_id, "Presence client id"),
		userId: uuid(identity.user_id, "Presence user id"),
		name: nonEmptyString(identity.name, "Presence display name", 256),
		publicKey: nonEmptyString(identity.public_key, "Presence public key", 256),
	};
}

function parseSessionInputs(value: unknown, label: string): SessionTurnInput[] {
	return array(value, label).map((entry) => {
		const input = record(entry, "session turn input");
		const kind = input.kind === "kickoff" ? "kickoff" : "user_message";
		return {
			inputId: uuid(input.input_id, "Input id"),
			position: boundedInteger(input.position, "Input position", 1, Number.MAX_SAFE_INTEGER),
			kind: kind as SessionTurnInput["kind"],
			authorUserId: uuid(input.author_user_id, "Input author"),
			authorDisplayName: nonEmptyString(input.author_display_name, "Input author display name", 256),
			body: jsonValue(input.body ?? {}),
			createdAt: timestamp(input.created_at, "Input created at"),
		};
	});
}

function parsePendingSessionInputs(value: unknown): PendingSessionInputPage {
	const page = record(value, "pending session input page");
	const entries = array(page.items, "pending session inputs");
	const items = parseSessionInputs(entries, "pending session inputs").map((input, index) => {
		const raw = record(entries[index], "pending session input");
		const status: PendingSessionInput["status"] =
			raw.status === "processing" ? "processing" : raw.status === "failed" ? "failed" : "queued";
		return {
			...input,
			status,
			...(typeof raw.failure_reason === "string"
				? { failureReason: nonEmptyString(raw.failure_reason, "Input failure reason", 2048) }
				: {}),
		};
	});
	return {
		items,
		nextAfterPosition: boundedInteger(
			page.next_after_position,
			"Pending session input cursor",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		hasMore: page.has_more === true,
	};
}

function parseStaffExecutionActivity(value: unknown): HostedStaffExecutionActivity {
	const activity = record(value, "staff execution activity");
	if (
		!["session_turn", "wake", "manual", "room_delivery", "proposal_review", "system"].includes(
			String(activity.source_kind),
		) ||
		!["queued", "leased", "completed", "failed", "cancelled"].includes(String(activity.job_status)) ||
		!(["waiting", "working", "needs_attention"] as const).includes(
			activity.activity as "waiting" | "working" | "needs_attention",
		)
	) {
		throw new Error("Hosted primary returned invalid staff execution activity");
	}
	return {
		runId: uuid(activity.run_id, "Staff execution activity run id"),
		staffAgentId: uuid(activity.staff_agent_id, "Staff execution activity staff id"),
		sourceKind: activity.source_kind as HostedStaffExecutionActivity["sourceKind"],
		jobStatus: activity.job_status as HostedStaffExecutionActivity["jobStatus"],
		activity: activity.activity as HostedStaffExecutionActivity["activity"],
		updatedAt: timestamp(activity.updated_at, "Staff execution activity time"),
	};
}

export interface HostedFriend {
	userId: string;
	email: string;
	displayName: string;
	status: "pending" | "accepted";
	direction: "incoming" | "outgoing";
	since: string;
}

function parseFriend(value: unknown): HostedFriend {
	const input = record(value, "friend");
	const status = input.status === "accepted" ? "accepted" : "pending";
	const direction = input.direction === "incoming" ? "incoming" : "outgoing";
	return {
		userId: uuid(input.user_id, "friend user id"),
		email: nonEmptyString(input.email, "friend email", 320),
		displayName: nonEmptyString(input.display_name, "friend display name", 160),
		status,
		direction,
		since: timestamp(input.since, "friendship time"),
	};
}

export class QorperaHostedPrimary {
	private readonly transport: HostedPrimaryTransport;

	constructor(transport: HostedPrimaryTransport) {
		this.transport = transport;
	}

	async getCompanyOrganization(profileId: string): Promise<HostedCompanyOrganization> {
		requiredUuid(profileId, "Profile id");
		return parseHostedCompanyOrganization(await this.transport.getCompanyOrganization({ p_profile_id: profileId }));
	}

	async listProfiles(): Promise<HostedProfile[]> {
		return array(await this.transport.listProfiles(), "profile list").map(parseProfile);
	}

	async getAccountEntitlement(): Promise<HostedAccountEntitlement> {
		return parseAccountEntitlement(await this.transport.getAccountEntitlement());
	}

	async inviteMember(
		profileId: string,
		emailInput: string,
		memberRole: Exclude<HostedProfileRole, "owner">,
	): Promise<HostedProfileInvitation> {
		requiredUuid(profileId, "Profile id");
		if (!HOSTED_MEMBER_ROLES.some((candidate) => candidate === memberRole))
			throw new Error("Profile role is invalid");
		const email = emailInput.trim().toLowerCase();
		if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email is invalid");
		return parseInvitation(
			await this.transport.inviteMember({ p_profile_id: profileId, p_email: email, p_role: memberRole }),
		);
	}

	async listInvitations(): Promise<HostedIncomingProfileInvitation[]> {
		return array(await this.transport.listInvitations(), "incoming profile invitation list").map(
			parseIncomingInvitation,
		);
	}

	async acceptInvitation(invitationId: string): Promise<void> {
		requiredUuid(invitationId, "Invitation id");
		requireTrue(
			await this.transport.acceptInvitation({ p_invitation_id: invitationId }),
			"invitation acceptance result",
		);
	}

	async declineInvitation(invitationId: string): Promise<void> {
		requiredUuid(invitationId, "Invitation id");
		requireTrue(
			await this.transport.declineInvitation({ p_invitation_id: invitationId }),
			"invitation decline result",
		);
	}

	async leaveProfile(profileId: string): Promise<void> {
		requiredUuid(profileId, "Profile id");
		requireTrue(await this.transport.leaveProfile({ p_profile_id: profileId }), "profile leave result");
	}

	async deleteProfile(profileId: string): Promise<void> {
		requiredUuid(profileId, "Profile id");
		requireTrue(await this.transport.deleteProfile({ p_profile_id: profileId }), "profile deletion result");
	}

	async ensureStaffSession(
		environmentId: string,
		staffAgentId: string,
		clientSessionId: string,
		title: string,
	): Promise<StaffSessionHandle> {
		requiredUuid(environmentId, "Environment id");
		requiredUuid(clientSessionId, "Client session id");
		return parseStaffSessionHandle(
			await this.transport.ensureStaffSession({
				p_environment_id: environmentId,
				p_staff_agent_id: requiredText(staffAgentId, "Staff agent id", 128),
				p_client_session_id: clientSessionId,
				p_title: requiredText(title, "Session title", 256),
			}),
		);
	}

	async appendSessionInput(sessionId: string, clientInputId: string, body: JsonValue): Promise<SessionInputReceipt> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(clientInputId, "Client input id");
		const result = record(
			await this.transport.appendSessionInput({
				p_session_id: sessionId,
				p_client_input_id: clientInputId,
				p_kind: "user_message",
				p_body: body,
			}),
			"session input receipt",
		);
		return {
			inputId: uuid(result.input_id, "Session input id"),
			position: boundedInteger(result.position, "Session input position", 1, Number.MAX_SAFE_INTEGER),
		};
	}

	async listSessionInputsPage(sessionId: string, afterPosition = 0, limit = 100): Promise<PendingSessionInputPage> {
		requiredUuid(sessionId, "Session id");
		if (!Number.isSafeInteger(afterPosition) || afterPosition < 0) throw new Error("Session input cursor is invalid");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Session input page size is invalid");
		return parsePendingSessionInputs(
			await this.transport.listSessionInputs({
				p_session_id: sessionId,
				p_after_position: afterPosition,
				p_limit: limit,
			}),
		);
	}

	async listSessionInputs(sessionId: string): Promise<PendingSessionInput[]> {
		const items: PendingSessionInput[] = [];
		let afterPosition = 0;
		for (let pageNumber = 0; pageNumber < 6; pageNumber += 1) {
			const page = await this.listSessionInputsPage(sessionId, afterPosition, 100);
			items.push(...page.items);
			if (!page.hasMore) return items;
			if (page.nextAfterPosition <= afterPosition || items.length > 512) {
				throw new Error("Session input pagination did not advance within its bounded queue");
			}
			afterPosition = page.nextAfterPosition;
		}
		throw new Error("Session input queue exceeded its bounded read contract");
	}

	async listStaffExecutionActivity(environmentId: string): Promise<HostedStaffExecutionActivity[]> {
		requiredUuid(environmentId, "Environment id");
		return array(
			await this.transport.listStaffExecutionActivity({ p_environment_id: environmentId }),
			"staff execution activity",
		).map(parseStaffExecutionActivity);
	}

	async resolveFailedExecutionRun(runId: string, action: "retry" | "discard"): Promise<void> {
		requiredUuid(runId, "Execution run recovery id");
		const result = record(
			await this.transport.resolveFailedExecutionRun({ p_run_id: runId, p_action: action }),
			"execution run recovery resolution",
		);
		if (result.resolved !== true || result.action !== action || result.run_id !== runId) {
			throw new Error("Hosted primary returned an invalid execution run recovery resolution");
		}
	}

	async beginOperationReceipt(
		execution: HostedOperationExecution,
		operationId: string,
		operationKind: string,
		inputSha256: string,
	): Promise<HostedOperationReceiptBegin> {
		requiredUuid(execution.id, "Operation execution id");
		requiredUuid(execution.claimantId, "Operation claimant id");
		requiredUuid(operationId, "Operation id");
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(operationKind) || !SHA256_PATTERN.test(inputSha256)) {
			throw new Error("Operation receipt is invalid");
		}
		return parseOperationReceiptBegin(
			await this.transport.beginOperationReceipt({
				p_execution_kind: execution.kind,
				p_execution_id: execution.id,
				p_claimant_id: execution.claimantId,
				p_operation_id: operationId,
				p_operation_kind: operationKind,
				p_input_sha256: inputSha256,
			}),
		);
	}

	async completeOperationReceipt(
		execution: HostedOperationExecution,
		operationId: string,
		result: JsonValue,
	): Promise<JsonValue> {
		requiredUuid(execution.id, "Operation execution id");
		requiredUuid(execution.claimantId, "Operation claimant id");
		requiredUuid(operationId, "Operation id");
		return jsonValue(
			await this.transport.completeOperationReceipt({
				p_execution_id: execution.id,
				p_claimant_id: execution.claimantId,
				p_operation_id: operationId,
				p_result: result,
			}),
		);
	}

	async stageOperationReceiptObjects(
		execution: HostedOperationExecution,
		operationId: string,
		objects: Array<{ sha256: string; bytes: number }>,
	): Promise<void> {
		requiredUuid(execution.id, "Operation execution id");
		requiredUuid(execution.claimantId, "Operation claimant id");
		requiredUuid(operationId, "Operation id");
		if (
			objects.length < 1 ||
			objects.length > 65 ||
			objects.some(
				(object) =>
					!SHA256_PATTERN.test(object.sha256) ||
					!Number.isSafeInteger(object.bytes) ||
					object.bytes < 0 ||
					object.bytes > 8 * 1024 * 1024,
			)
		) {
			throw new Error("Operation receipt objects are invalid");
		}
		const result = record(
			await this.transport.stageOperationReceiptObjects({
				p_execution_id: execution.id,
				p_claimant_id: execution.claimantId,
				p_operation_id: operationId,
				p_objects: objects as JsonValue,
			}),
			"operation receipt object staging",
		);
		boundedInteger(result.staged, "Staged operation object count", objects.length, objects.length);
	}

	async resolveOperationReceipt(
		operationId: string,
		resolution: "confirmed_completed" | "confirmed_not_run",
		result?: JsonValue,
	): Promise<{ status: "completed" | "cancelled"; resolution: typeof resolution; result?: JsonValue }> {
		requiredUuid(operationId, "Operation id");
		const value = record(
			await this.transport.resolveOperationReceipt({
				p_operation_id: operationId,
				p_resolution: resolution,
				p_result: result ?? null,
			}),
			"operation recovery result",
		);
		if (
			(value.status !== "completed" && value.status !== "cancelled") ||
			(value.resolution !== "confirmed_completed" && value.resolution !== "confirmed_not_run")
		) {
			throw new Error("Hosted primary returned invalid operation recovery result");
		}
		return {
			status: value.status,
			resolution: value.resolution,
			...(value.result === null || value.result === undefined ? {} : { result: jsonValue(value.result) }),
		};
	}

	async resolveRunOperationReceipt(
		operationId: string,
		resolution: "confirmed_completed" | "confirmed_not_run",
	): Promise<{ status: "completed" | "cancelled"; recoveryResolution: typeof resolution }> {
		requiredUuid(operationId, "Run operation id");
		const value = record(
			await this.transport.resolveRunOperationReceipt({
				p_receipt_id: operationId,
				p_resolution: resolution,
				p_result: resolution === "confirmed_completed" ? { recovered: true } : null,
				p_output_snapshot_id: null,
				p_proposal_id: null,
			}),
			"run operation recovery result",
		);
		if ((value.status !== "completed" && value.status !== "cancelled") || value.recovery_resolution !== resolution) {
			throw new Error("Hosted primary returned invalid run operation recovery result");
		}
		return { status: value.status, recoveryResolution: resolution };
	}

	async registerPresenceDevice(
		profileId: string,
		clientId: string,
		publicKey: string,
	): Promise<HostedPresenceIdentity> {
		requiredUuid(profileId, "Presence profile id");
		requiredUuid(clientId, "Presence client id");
		if (!/^[A-Za-z0-9+/]{40,240}={0,2}$/.test(publicKey)) throw new Error("Presence public key is invalid");
		return parsePresenceIdentity(
			await this.transport.registerPresenceDevice({
				p_profile_id: profileId,
				p_client_id: clientId,
				p_public_key: publicKey,
			}),
		);
	}

	async listPresenceDevices(profileId: string, clientIds: string[]): Promise<HostedPresenceIdentity[]> {
		requiredUuid(profileId, "Presence profile id");
		if (clientIds.length > 200) throw new Error("Presence device lookup is too large");
		for (const clientId of clientIds) requiredUuid(clientId, "Presence client id");
		return array(
			await this.transport.listPresenceDevices({ p_profile_id: profileId, p_client_ids: [...new Set(clientIds)] }),
			"presence identities",
		).map(parsePresenceIdentity);
	}

	async unregisterPresenceDevice(profileId: string, clientId: string): Promise<void> {
		requiredUuid(profileId, "Presence profile id");
		requiredUuid(clientId, "Presence client id");
		await this.transport.unregisterPresenceDevice({ p_profile_id: profileId, p_client_id: clientId });
	}

	async sendFriendRequest(emailInput: string): Promise<"pending" | "accepted"> {
		const email = emailInput.trim().toLowerCase();
		if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			throw new Error("Email is invalid");
		}
		const result = record(await this.transport.sendFriendRequest({ p_email: email }), "friend request result");
		return result.status === "accepted" ? "accepted" : "pending";
	}

	async listFriends(): Promise<HostedFriend[]> {
		return array(await this.transport.listFriends(), "friend list").map(parseFriend);
	}

	async respondFriendRequest(userId: string, accept: boolean): Promise<void> {
		requiredUuid(userId, "Friend user id");
		await this.transport.respondFriendRequest({ p_user_id: userId, p_accept: accept });
	}

	async removeFriend(userId: string): Promise<void> {
		requiredUuid(userId, "Friend user id");
		await this.transport.removeFriend({ p_user_id: userId });
	}

	async profileTeam(profileId: string): Promise<HostedProfileTeam> {
		requiredUuid(profileId, "Profile id");
		return parseTeam(await this.transport.profileTeam({ p_profile_id: profileId }));
	}

	async cancelInvitation(profileId: string, invitationId: string): Promise<void> {
		requiredUuid(profileId, "Profile id");
		requiredUuid(invitationId, "Invitation id");
		requireTrue(
			await this.transport.cancelInvitation({ p_profile_id: profileId, p_invitation_id: invitationId }),
			"invitation cancellation result",
		);
	}

	async retryInvitationDelivery(
		profileId: string,
		invitationId: string,
	): Promise<HostedProfileInvitation["delivery"]> {
		requiredUuid(profileId, "Profile id");
		requiredUuid(invitationId, "Invitation id");
		return parseInvitationDelivery(
			await this.transport.retryInvitationDelivery({ p_profile_id: profileId, p_invitation_id: invitationId }),
		);
	}

	async updateMemberRole(
		profileId: string,
		memberUserId: string,
		memberRole: Exclude<HostedProfileRole, "owner">,
	): Promise<HostedProfileMember> {
		requiredUuid(profileId, "Profile id");
		requiredUuid(memberUserId, "Member user id");
		if (!HOSTED_MEMBER_ROLES.some((candidate) => candidate === memberRole)) {
			throw new Error("Profile role is invalid");
		}
		return parseMember(
			await this.transport.updateMemberRole({
				p_profile_id: profileId,
				p_member_user_id: memberUserId,
				p_role: memberRole,
			}),
		);
	}

	async removeMember(profileId: string, memberUserId: string): Promise<void> {
		requiredUuid(profileId, "Profile id");
		requiredUuid(memberUserId, "Member user id");
		requireTrue(
			await this.transport.removeMember({ p_profile_id: profileId, p_member_user_id: memberUserId }),
			"member removal result",
		);
	}

	async listStaff(profileId: string): Promise<HostedStaffAgent[]> {
		requiredUuid(profileId, "Profile id");
		return array(await this.transport.listStaff({ p_profile_id: profileId }), "staff list").map(parseStaff);
	}

	async getCompanyFile(environmentId: string): Promise<HostedCompanyFile> {
		requiredUuid(environmentId, "Environment id");
		return parseCompanyFile(await this.transport.getCompanyFile({ p_environment_id: environmentId }));
	}

	async createSession(input: CreateHostedSessionInput): Promise<HostedSession> {
		requiredUuid(input.environmentId, "Environment id");
		requiredUuid(input.clientSessionId, "Client session id");
		if (input.parentSessionId) requiredUuid(input.parentSessionId, "Parent session id");
		if ((input.companySnapshotId === undefined) !== (input.staffVersion === undefined)) {
			throw new Error("Session execution revisions must be provided together");
		}
		if (input.companySnapshotId) requiredUuid(input.companySnapshotId, "Company snapshot id");
		if (input.staffVersion !== undefined && (!Number.isSafeInteger(input.staffVersion) || input.staffVersion < 1)) {
			throw new Error("Staff version must be a positive integer");
		}
		const executionScope = jsonValue(input.executionScope ?? {});
		if (!executionScope || typeof executionScope !== "object" || Array.isArray(executionScope)) {
			throw new Error("Session execution scope must be an object");
		}
		return parseSession(
			await this.transport.createSession({
				p_environment_id: input.environmentId,
				p_client_session_id: input.clientSessionId,
				p_title: requiredText(input.title, "Session title", MAX_SESSION_TITLE_LENGTH),
				p_staff_agent_id: input.staffAgentId
					? requiredText(input.staffAgentId, "Staff agent id", MAX_AGENT_ID_LENGTH)
					: null,
				p_parent_session_id: input.parentSessionId ?? null,
				p_execution_scope: executionScope,
				p_company_snapshot_id: input.companySnapshotId ?? null,
				p_staff_version: input.staffVersion ?? null,
			}),
		);
	}

	async listSessions(environmentId: string): Promise<HostedSession[]> {
		requiredUuid(environmentId, "Environment id");
		return array(await this.transport.listSessions({ p_environment_id: environmentId }), "session list").map(
			parseSession,
		);
	}

	async listSessionsPage(
		environmentId: string,
		after?: { updatedAt: string; sessionId: string },
		limit = 100,
	): Promise<HostedSessionPage> {
		requiredUuid(environmentId, "Environment id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Session page size is invalid");
		if (after) {
			timestamp(after.updatedAt, "Session page cursor time");
			requiredUuid(after.sessionId, "Session page cursor id");
		}
		const value = record(
			await this.transport.listSessionsPage({
				p_environment_id: environmentId,
				p_after_updated_at: after?.updatedAt ?? null,
				p_after_id: after?.sessionId ?? null,
				p_limit: limit,
			}),
			"session page",
		);
		const nextUpdatedAt = value.next_updated_at;
		const nextId = value.next_id;
		return {
			items: array(value.items, "session page items").map(parseSession),
			hasMore: value.has_more === true,
			...(nextUpdatedAt === null || nextUpdatedAt === undefined
				? {}
				: { nextUpdatedAt: timestamp(nextUpdatedAt, "Session page next cursor time") }),
			...(nextId === null || nextId === undefined ? {} : { nextId: uuid(nextId, "Session page next cursor id") }),
		};
	}

	async getSessionByClient(environmentId: string, clientSessionId: string): Promise<HostedSession | undefined> {
		requiredUuid(environmentId, "Environment id");
		requiredUuid(clientSessionId, "Client session id");
		const value = await this.transport.getSessionByClient({
			p_environment_id: environmentId,
			p_client_session_id: clientSessionId,
		});
		return value === null || value === undefined ? undefined : parseSession(value);
	}

	async closeSession(sessionId: string): Promise<void> {
		requiredUuid(sessionId, "Session id");
		requireTrue(await this.transport.closeSession({ p_session_id: sessionId }), "session close result");
	}

	async appendAccountEvent(input: AppendHostedSessionEventInput): Promise<HostedSessionEvent> {
		requiredUuid(input.sessionId, "Session id");
		requiredUuid(input.eventId, "Event id");
		if (!HOSTED_SESSION_EVENT_TYPES.includes(input.eventType)) throw new Error("Session event type is invalid");
		const eventBody = jsonValue(input.body);
		if (
			input.expectedSequence !== undefined &&
			(!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0)
		) {
			throw new Error("Expected sequence must be a non-negative integer");
		}
		if (Buffer.byteLength(JSON.stringify(eventBody), "utf-8") > MAX_EVENT_BODY_BYTES) {
			throw new Error("Session event body is too large");
		}
		if (input.execution) {
			requiredUuid(input.execution.id, "Event execution id");
			requiredUuid(input.execution.claimantId, "Event execution claimant id");
		}
		return parseEvent(
			await this.transport.appendAccountEvent({
				p_session_id: input.sessionId,
				p_event_id: input.eventId,
				p_event_type: input.eventType,
				p_body: eventBody,
				p_expected_sequence: input.expectedSequence ?? null,
				p_execution_kind: input.execution?.kind ?? null,
				p_execution_id: input.execution?.id ?? null,
				p_execution_claimant_id: input.execution?.claimantId ?? null,
			}),
		);
	}

	async readSessionEvents(sessionId: string, afterSequence = 0, limit = 200): Promise<HostedSessionEvent[]> {
		requiredUuid(sessionId, "Session id");
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
			throw new Error("Event cursor must be a non-negative integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Event page size must be between 1 and 500");
		}
		return array(
			await this.transport.readSessionEvents({
				p_session_id: sessionId,
				p_after_sequence: afterSequence,
				p_limit: limit,
			}),
			"session event list",
		).map(parseEvent);
	}
}

export function createSupabaseHostedPrimary(client: SupabaseClient<HostedPrimaryDatabase>): QorperaHostedPrimary {
	return new QorperaHostedPrimary(new SupabaseHostedPrimaryTransport(client));
}
