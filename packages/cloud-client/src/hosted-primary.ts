import type { StaffAgent } from "@qorpera/company/company-staff";
import type { ExecutionIdentity, JsonValue } from "@qorpera/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type HostedCompanyOrganization, parseHostedCompanyOrganization } from "./cloud-company-organization.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PROFILE_NAME_LENGTH = 120;
const MAX_SESSION_TITLE_LENGTH = 256;
const MAX_WORKSPACE_NAME_LENGTH = 160;
const MAX_AGENT_ID_LENGTH = 128;
const MAX_EVENT_BODY_BYTES = 256 * 1024;
const MAX_TREE_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_TREE_FILES = 50_000;
const MAX_TREE_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_INDEX_ENTRIES = 5_000;
const MAX_REACHABILITY_OBJECTS = 400_000;
const MAX_REACHABILITY_STORAGE_BYTES = 2 * 1024 * 1024 * 1024 * 1024;
const MAX_COMPANY_VERIFICATION_TRANCHES = Math.ceil(MAX_TREE_BYTES / (64 * 1024 * 1024)) + MAX_TREE_FILES + 1;

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
] as const;
export type HostedSessionEventType = (typeof HOSTED_SESSION_EVENT_TYPES)[number];

export const HOSTED_COMPANY_OPERATION_TYPES = ["staff_state", "session_state", "session_event"] as const;
export type HostedCompanyOperationType = (typeof HOSTED_COMPANY_OPERATION_TYPES)[number];

export const HOSTED_ARTIFACT_ROOT_CONTRACTS = ["qorpera.object/v1", "qorpera.cloud-file-manifest/v1"] as const;
export type HostedArtifactRootContract = (typeof HOSTED_ARTIFACT_ROOT_CONTRACTS)[number];
export const HOSTED_OBJECT_ROOT_KINDS = ["artifact", "company_snapshot"] as const;
export type HostedObjectRootKind = (typeof HOSTED_OBJECT_ROOT_KINDS)[number];
export const HOSTED_ARTIFACT_GC_PLAN_STATUSES = [
	"waiting",
	"deleting",
	"retrying",
	"completed",
	"cancelled",
	"failed",
] as const;
export type HostedArtifactGcPlanStatus = (typeof HOSTED_ARTIFACT_GC_PLAN_STATUSES)[number];

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

export interface HostedCompanyWorkspace {
	workspaceId: string;
	profileId: string;
	environmentId: string;
	clientWorkspaceId: string;
	name: string;
	headSnapshotId?: string;
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
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

export const HOSTED_COMPANY_PROPOSAL_STATUSES = ["open", "accepted", "rejected"] as const;
export type HostedCompanyProposalStatus = (typeof HOSTED_COMPANY_PROPOSAL_STATUSES)[number];
export const HOSTED_COMPANY_PROPOSAL_REASONS = ["policy", "authority", "conflict", "recovery"] as const;
export type HostedCompanyProposalReason = (typeof HOSTED_COMPANY_PROPOSAL_REASONS)[number];

export interface HostedCompanyProposalReview {
	assignmentId: string;
	proposalRevision: number;
	reviewerStaffAgentId: string;
	reviewerName: string;
	status: "queued" | "running" | "approved" | "changes_requested" | "failed";
	runId?: string;
	commentId?: string;
	failureReason?: string;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
}

export type HostedCompanyProposalExecution = ExecutionIdentity | { kind: "run"; id: string; claimantId: string };

export interface HostedCompanyProposal {
	proposalId: string;
	profileId: string;
	environmentId: string;
	clientProposalId: string;
	baseSnapshotId: string;
	proposalSnapshot: HostedCompanySnapshot;
	execution: HostedCompanyProposalExecution;
	sessionId?: string;
	trailEndSequence: number;
	reason: HostedCompanyProposalReason;
	policyKey?: string;
	title: string;
	reviewerStaffIds: string[];
	reviewRevision: number;
	reviews: HostedCompanyProposalReview[];
	status: HostedCompanyProposalStatus;
	createdByUserId: string;
	createdByName: string;
	createdAt: string;
	resolvedByUserId?: string;
	resolvedAt?: string;
}

export interface HostedCompanyProposalPage {
	items: HostedCompanyProposal[];
	hasMore: boolean;
	nextCreatedAt?: string;
	nextId?: string;
}

export interface HostedCompanyProposalComment {
	commentId: string;
	proposalId: string;
	body: string;
	authorUserId?: string;
	authorStaffAgentId?: string;
	authorName: string;
	createdAt: string;
}

export interface HostedCompanyProposalCommentPage {
	items: HostedCompanyProposalComment[];
	hasMore: boolean;
	nextCreatedAt?: string;
	nextId?: string;
}

export interface CreatedHostedCompany {
	profile: HostedProfile;
	companyFile: HostedCompanyFile;
	organization: HostedCompanyOrganizationBootstrap;
}

export interface HostedCompanyOrganizationBootstrap {
	schema: "qorpera.company-organization-bootstrap/v1";
	cofounder: {
		staffAgentId: string;
		formationId: string;
		memberSessionId: string;
	};
	formationState: "source_inventory";
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

export interface HostedArtifactRetentionHold {
	holdId: string;
	profileId: string;
	artifactId: string;
	clientHoldId: string;
	reason: string;
	expiresAt?: string;
	createdByUserId: string;
	createdAt: string;
	releasedByUserId?: string;
	releasedAt?: string;
}

export interface HostedArtifactGcCandidate extends HostedArtifact {
	objectDeletionReady: boolean;
	reachabilityReady: boolean;
	reachabilityGraphId?: string;
	deletableObjectCount: number;
	deletableStorageBytes: number;
	blockedReason?: string;
}

export interface HostedObjectReachabilityEntry {
	sha256: string;
	bytes: number;
}

export interface HostedObjectReachabilityGraph {
	graphId: string;
	profileId: string;
	environmentId: string;
	rootKind: HostedObjectRootKind;
	rootId: string;
	clientGraphId: string;
	rootObjectSha256: string;
	contractVersion: 1;
	contentSha256: string;
	objectCount: number;
	storageBytes: number;
	status: "uploading" | "complete";
	createdByUserId: string;
	createdAt: string;
	completedAt?: string;
}

export interface HostedObjectRestoreProof {
	proofId: string;
	graphId: string;
	profileId: string;
	clientProofId: string;
	restoredContentSha256: string;
	restoredBytes: number;
	verifiedByUserId: string;
	verifiedAt: string;
	validUntil: string;
}

export interface HostedArtifactGcPlan {
	planId: string;
	profileId: string;
	artifactId: string;
	graphId: string;
	restoreProofId: string;
	clientPlanId: string;
	status: HostedArtifactGcPlanStatus;
	objectCount: number;
	storageBytes: number;
	pendingObjectCount: number;
	deletedObjectCount: number;
	retainedObjectCount: number;
	notBefore: string;
	nextAttemptAt: string;
	attemptCount: number;
	lastError?: string;
	createdByUserId: string;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	cancelledByUserId?: string;
	cancelledAt?: string;
}

export interface HostedArtifactGcAuditReceipt {
	receiptId: number;
	planId: string;
	eventType:
		| "created"
		| "claimed"
		| "object_batch_acknowledged"
		| "retrying"
		| "failed"
		| "completed"
		| "cancelled"
		| "manual_retry";
	payload: JsonValue;
	actorUserId?: string;
	createdAt: string;
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

export interface CreateHostedProfileInput {
	profileName: string;
	environmentName: string;
	contractVersion: number;
	promotionId?: string;
}

export interface CreateHostedCompanyInput {
	clientCreationId: string;
	companyName: string;
	contractVersion: number;
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

export interface EnsureHostedCompanyWorkspaceInput {
	environmentId: string;
	clientWorkspaceId: string;
	name: string;
	baseSnapshotId?: string;
}

export interface CommitHostedCompanySnapshotInput {
	workspaceId: string;
	clientSnapshotId: string;
	expectedHeadSnapshotId?: string;
	tree: {
		manifestSha256: string;
		manifestBytes: number;
		contractVersion: number;
		fileCount: number;
		totalBytes: number;
	};
}

export interface PrepareHostedCompanyFileRevisionInput {
	environmentId: string;
	clientRevisionId: string;
	expectedHeadSnapshotId?: string;
	tree: CommitHostedCompanySnapshotInput["tree"];
}

export interface PrepareHostedCompanyProposalInput {
	environmentId: string;
	clientRevisionId: string;
	baseSnapshotId: string;
	tree: CommitHostedCompanySnapshotInput["tree"];
}

export interface SubmitHostedCompanyProposalInput {
	environmentId: string;
	clientProposalId: string;
	proposalSnapshotId: string;
	execution: ExecutionIdentity;
	sessionId: string;
	trailEndSequence: number;
	reason: HostedCompanyProposalReason;
	policyKey?: string;
	title: string;
	reviewerStaffIds: string[];
}

export interface CaptureHostedCompanySubstrateVersionInput {
	snapshotId: string;
	clientVersionId: string;
	artifactIndexId: string;
	contractVersion?: number;
}

export interface RegisterHostedArtifactInput {
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
}

export interface CreateHostedArtifactIndexInput {
	environmentId: string;
	clientIndexId: string;
	artifactIds: string[];
}

export interface BeginHostedObjectReachabilityGraphInput {
	rootKind: HostedObjectRootKind;
	rootId: string;
	clientGraphId: string;
	rootObjectSha256: string;
	contentSha256: string;
	objectCount: number;
	storageBytes: number;
}

export interface HostedPrimaryTransport {
	createCompany(input: {
		p_client_creation_id: string;
		p_company_name: string;
		p_contract_version: number;
	}): Promise<unknown>;
	getCompanyOrganizationBootstrap(input: { p_profile_id: string }): Promise<unknown>;
	getCompanyOrganization(input: { p_profile_id: string }): Promise<unknown>;
	createProfile(input: {
		p_profile_name: string;
		p_environment_name: string;
		p_contract_version: number;
	}): Promise<unknown>;
	promoteProfile(input: {
		p_promotion_id: string;
		p_profile_name: string;
		p_environment_name: string;
		p_contract_version: number;
	}): Promise<unknown>;
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
	deleteStaff(input: { p_profile_id: string; p_staff_agent_id: string; p_expected_version: number }): Promise<unknown>;
	putStaff(input: {
		p_profile_id: string;
		p_staff_agent_id: string;
		p_display_name: string;
		p_role: string;
		p_charter: string;
		p_template_id: string | null;
		p_department_id: string | null;
		p_appearance_color: string;
		p_appearance_shape: string;
		p_appearance_creature: string | null;
		p_model_provider: string | null;
		p_model_id: string | null;
		p_employment_status: StaffAgent["employmentStatus"];
		p_lifecycle_state: StaffAgent["lifecycleState"];
		p_created_at: string;
		p_expected_version: number | null;
	}): Promise<unknown>;
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
	claimSessionTurn(input: {
		p_session_id: string;
		p_claimant_id: string;
		p_lease_seconds: number;
		p_company_snapshot_id: string;
		p_staff_version: number;
	}): Promise<unknown>;
	renewSessionTurn(input: {
		p_session_id: string;
		p_turn_id: string;
		p_claimant_id: string;
		p_lease_seconds: number;
	}): Promise<unknown>;
	completeSessionTurn(input: {
		p_session_id: string;
		p_turn_id: string;
		p_claimant_id: string;
		p_trail_end_sequence: number;
	}): Promise<unknown>;
	quarantineSessionTurn(input: {
		p_session_id: string;
		p_turn_id: string;
		p_claimant_id: string;
		p_reason: string;
	}): Promise<unknown>;
	listSessionRecoveries(input: {
		p_session_id: string;
		p_after_completed_at: string | null;
		p_after_id: string | null;
		p_limit: number;
	}): Promise<unknown>;
	listSessionExecutionRunRecoveries(input: { p_session_id: string; p_limit: number }): Promise<unknown>;
	listStaffExecutionActivity(input: { p_environment_id: string }): Promise<unknown>;
	resolveFailedExecutionRun(input: { p_run_id: string; p_action: "retry" | "discard" }): Promise<unknown>;
	resolveSessionRecovery(input: {
		p_session_id: string;
		p_turn_id: string;
		p_resolution: "retry" | "discard";
	}): Promise<unknown>;
	getSessionTurnStatus(input: { p_session_id: string; p_turn_id: string; p_claimant_id: string }): Promise<unknown>;
	claimWake(input: {
		p_environment_id: string;
		p_wake_key: string;
		p_claimant_id: string;
		p_lease_seconds: number;
		p_staff_agent_id: string;
		p_company_snapshot_id: string;
		p_staff_version: number;
	}): Promise<unknown>;
	renewWake(input: {
		p_environment_id: string;
		p_wake_key: string;
		p_claimant_id: string;
		p_lease_seconds: number;
	}): Promise<unknown>;
	completeWake(input: { p_environment_id: string; p_wake_key: string; p_claimant_id: string }): Promise<unknown>;
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
	prepareCompanyFileRevision(input: {
		p_environment_id: string;
		p_client_revision_id: string;
		p_expected_head_snapshot_id: string | null;
		p_tree_manifest_sha256: string;
		p_tree_manifest_bytes: number;
		p_tree_contract_version: number;
		p_file_count: number;
		p_total_bytes: number;
	}): Promise<unknown>;
	prepareCompanyFileProposal(input: {
		p_environment_id: string;
		p_client_revision_id: string;
		p_base_snapshot_id: string;
		p_tree_manifest_sha256: string;
		p_tree_manifest_bytes: number;
		p_tree_contract_version: number;
		p_file_count: number;
		p_total_bytes: number;
	}): Promise<unknown>;
	publishCompanyFileRevision(input: {
		p_environment_id: string;
		p_snapshot_id: string;
		p_expected_head_snapshot_id: string | null;
	}): Promise<unknown>;
	submitCompanyProposal(input: {
		p_environment_id: string;
		p_client_proposal_id: string;
		p_proposal_snapshot_id: string;
		p_execution_kind: ExecutionIdentity["kind"];
		p_execution_id: string;
		p_execution_claimant_id: string;
		p_session_id: string;
		p_trail_end_sequence: number;
		p_reason: HostedCompanyProposalReason;
		p_policy_key: string | null;
		p_title: string;
		p_reviewer_staff_ids: string[];
	}): Promise<unknown>;
	listCompanyProposals(input: {
		p_environment_id: string;
		p_status: HostedCompanyProposalStatus;
		p_after_created_at: string | null;
		p_after_id: string | null;
		p_limit: number;
	}): Promise<unknown>;
	rebaseCompanyProposal(input: {
		p_proposal_id: string;
		p_expected_proposal_snapshot_id: string;
		p_expected_head_snapshot_id: string;
		p_replacement_snapshot_id: string;
	}): Promise<unknown>;
	acceptCompanyProposal(input: { p_proposal_id: string; p_expected_proposal_snapshot_id: string }): Promise<unknown>;
	retryCompanyProposalReview(input: { p_assignment_id: string }): Promise<unknown>;
	rejectCompanyProposal(input: { p_proposal_id: string; p_expected_proposal_snapshot_id: string }): Promise<unknown>;
	getCompanyProposal(input: { p_proposal_id: string }): Promise<unknown>;
	appendCompanyProposalComment(input: {
		p_proposal_id: string;
		p_client_comment_id: string;
		p_body: string;
	}): Promise<unknown>;
	listCompanyProposalComments(input: {
		p_proposal_id: string;
		p_after_created_at: string | null;
		p_after_id: string | null;
		p_limit: number;
	}): Promise<unknown>;
	ensureCompanyWorkspace(input: {
		p_environment_id: string;
		p_client_workspace_id: string;
		p_name: string;
		p_base_snapshot_id: string | null;
	}): Promise<unknown>;
	commitCompanySnapshot(input: {
		p_workspace_id: string;
		p_client_snapshot_id: string;
		p_expected_head_snapshot_id: string | null;
		p_tree_manifest_sha256: string;
		p_tree_manifest_bytes: number;
		p_tree_contract_version: number;
		p_file_count: number;
		p_total_bytes: number;
	}): Promise<unknown>;
	getCompanySnapshot(input: { p_snapshot_id: string }): Promise<unknown>;
	listCompanyWorkspaces(input: { p_environment_id: string }): Promise<unknown>;
	listCompanySnapshots(input: { p_workspace_id: string; p_limit: number }): Promise<unknown>;
	registerArtifact(input: {
		p_environment_id: string;
		p_client_artifact_id: string;
		p_session_id: string | null;
		p_artifact_type: string;
		p_name: string;
		p_root_object_sha256: string;
		p_root_contract: HostedArtifactRootContract;
		p_content_sha256: string;
		p_bytes: number;
		p_media_type: string;
	}): Promise<unknown>;
	createArtifactIndex(input: {
		p_environment_id: string;
		p_client_index_id: string;
		p_artifact_ids: string[];
	}): Promise<unknown>;
	getArtifactIndex(input: { p_index_id: string }): Promise<unknown>;
	listArtifactIndexEntries(input: { p_index_id: string; p_after_ordinal: number; p_limit: number }): Promise<unknown>;
	createArtifactRetentionHold(input: {
		p_artifact_id: string;
		p_client_hold_id: string;
		p_reason: string;
		p_expires_at: string | null;
	}): Promise<unknown>;
	releaseArtifactRetentionHold(input: { p_hold_id: string }): Promise<unknown>;
	listArtifactGcCandidates(input: { p_profile_id: string; p_limit: number }): Promise<unknown>;
	createArtifactGcPlan(input: { p_artifact_id: string; p_client_plan_id: string }): Promise<unknown>;
	listArtifactGcPlans(input: { p_profile_id: string; p_limit: number }): Promise<unknown>;
	listArtifactGcAudit(input: { p_plan_id: string; p_after_id: number; p_limit: number }): Promise<unknown>;
	cancelArtifactGcPlan(input: { p_plan_id: string }): Promise<unknown>;
	retryArtifactGcPlan(input: { p_plan_id: string }): Promise<unknown>;
	beginObjectReachabilityGraph(input: {
		p_root_kind: HostedObjectRootKind;
		p_root_id: string;
		p_client_graph_id: string;
		p_root_object_sha256: string;
		p_contract_version: number;
		p_content_sha256: string;
		p_object_count: number;
		p_storage_bytes: number;
	}): Promise<unknown>;
	appendObjectReachabilityEntries(input: { p_graph_id: string; p_entries: JsonValue }): Promise<unknown>;
	completeObjectReachabilityGraph(input: { p_graph_id: string }): Promise<unknown>;
	getObjectReachabilityGraph(input: { p_graph_id: string }): Promise<unknown>;
	verifyCompanySnapshotClosure(input: { snapshotId: string; graphId: string }): Promise<unknown>;
	createObjectRestoreProof(input: {
		p_graph_id: string;
		p_client_proof_id: string;
		p_restored_content_sha256: string;
		p_restored_bytes: number;
	}): Promise<unknown>;
	captureCompanySubstrateVersion(input: {
		p_snapshot_id: string;
		p_client_version_id: string;
		p_contract_version: number;
		p_artifact_index_id: string;
	}): Promise<unknown>;
	getCompanySubstrateVersion(input: { p_version_id: string }): Promise<unknown>;
	listCompanySubstrateOperations(input: {
		p_version_id: string;
		p_after_sequence: number;
		p_limit: number;
	}): Promise<unknown>;
}

export interface HostedPrimaryDatabase {
	public: {
		Tables: Record<never, never>;
		Views: Record<never, never>;
		Functions: {
			qorpera_create_cloud_company: {
				Args: {
					p_client_creation_id: string;
					p_company_name: string;
					p_contract_version: number;
				};
				Returns: JsonValue;
			};
			qorpera_company_organization_bootstrap: { Args: { p_profile_id: string }; Returns: JsonValue };
			qorpera_company_organization_json: { Args: { p_profile_id: string }; Returns: JsonValue };
			qorpera_create_hosted_profile: {
				Args: {
					p_profile_name: string;
					p_environment_name: string;
					p_contract_version: number;
				};
				Returns: JsonValue;
			};
			qorpera_promote_local_profile: {
				Args: {
					p_promotion_id: string;
					p_profile_name: string;
					p_environment_name: string;
					p_contract_version: number;
				};
				Returns: JsonValue;
			};
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
			qorpera_delete_profile_staff: {
				Args: { p_profile_id: string; p_staff_agent_id: string; p_expected_version: number };
				Returns: JsonValue;
			};
			qorpera_put_profile_staff: {
				Args: {
					p_profile_id: string;
					p_staff_agent_id: string;
					p_display_name: string;
					p_role: string;
					p_charter: string;
					p_template_id: string | null;
					p_department_id: string | null;
					p_appearance_color: string;
					p_appearance_shape: string;
					p_appearance_creature: string | null;
					p_model_provider: string | null;
					p_model_id: string | null;
					p_employment_status: StaffAgent["employmentStatus"];
					p_lifecycle_state: StaffAgent["lifecycleState"];
					p_created_at: string;
					p_expected_version: number | null;
				};
				Returns: JsonValue;
			};
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
			qorpera_claim_session_turn: {
				Args: {
					p_session_id: string;
					p_claimant_id: string;
					p_lease_seconds: number;
					p_company_snapshot_id: string;
					p_staff_version: number;
				};
				Returns: JsonValue;
			};
			qorpera_renew_session_turn_v2: {
				Args: { p_session_id: string; p_turn_id: string; p_claimant_id: string; p_lease_seconds: number };
				Returns: JsonValue;
			};
			qorpera_complete_session_turn_v2: {
				Args: {
					p_session_id: string;
					p_turn_id: string;
					p_claimant_id: string;
					p_trail_end_sequence: number;
				};
				Returns: JsonValue;
			};
			qorpera_quarantine_session_turn: {
				Args: { p_session_id: string; p_turn_id: string; p_claimant_id: string; p_reason: string };
				Returns: JsonValue;
			};
			qorpera_list_session_recoveries: {
				Args: {
					p_session_id: string;
					p_after_completed_at: string | null;
					p_after_id: string | null;
					p_limit: number;
				};
				Returns: JsonValue;
			};
			qorpera_list_session_execution_run_recoveries: {
				Args: { p_session_id: string; p_limit: number };
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
			qorpera_resolve_session_recovery: {
				Args: { p_session_id: string; p_turn_id: string; p_resolution: string };
				Returns: JsonValue;
			};
			qorpera_get_session_turn_status: {
				Args: { p_session_id: string; p_turn_id: string; p_claimant_id: string };
				Returns: JsonValue;
			};
			qorpera_claim_wake_v2: {
				Args: {
					p_environment_id: string;
					p_wake_key: string;
					p_claimant_id: string;
					p_lease_seconds: number;
					p_staff_agent_id: string;
					p_company_snapshot_id: string;
					p_staff_version: number;
				};
				Returns: JsonValue;
			};
			qorpera_renew_wake: {
				Args: { p_environment_id: string; p_wake_key: string; p_claimant_id: string; p_lease_seconds: number };
				Returns: JsonValue;
			};
			qorpera_complete_wake: {
				Args: { p_environment_id: string; p_wake_key: string; p_claimant_id: string };
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
			qorpera_prepare_company_file_revision: {
				Args: {
					p_environment_id: string;
					p_client_revision_id: string;
					p_expected_head_snapshot_id: string | null;
					p_tree_manifest_sha256: string;
					p_tree_manifest_bytes: number;
					p_tree_contract_version: number;
					p_file_count: number;
					p_total_bytes: number;
				};
				Returns: JsonValue;
			};
			qorpera_prepare_company_file_proposal: {
				Args: {
					p_environment_id: string;
					p_client_revision_id: string;
					p_base_snapshot_id: string;
					p_tree_manifest_sha256: string;
					p_tree_manifest_bytes: number;
					p_tree_contract_version: number;
					p_file_count: number;
					p_total_bytes: number;
				};
				Returns: JsonValue;
			};
			qorpera_publish_company_file_revision: {
				Args: {
					p_environment_id: string;
					p_snapshot_id: string;
					p_expected_head_snapshot_id: string | null;
				};
				Returns: JsonValue;
			};
			qorpera_submit_company_proposal: {
				Args: {
					p_environment_id: string;
					p_client_proposal_id: string;
					p_proposal_snapshot_id: string;
					p_execution_kind: ExecutionIdentity["kind"];
					p_execution_id: string;
					p_execution_claimant_id: string;
					p_session_id: string;
					p_trail_end_sequence: number;
					p_reason: HostedCompanyProposalReason;
					p_policy_key: string | null;
					p_title: string;
					p_reviewer_staff_ids: string[];
				};
				Returns: JsonValue;
			};
			qorpera_list_company_proposals: {
				Args: {
					p_environment_id: string;
					p_status: HostedCompanyProposalStatus;
					p_after_created_at: string | null;
					p_after_id: string | null;
					p_limit: number;
				};
				Returns: JsonValue;
			};
			qorpera_rebase_company_proposal: {
				Args: {
					p_proposal_id: string;
					p_expected_proposal_snapshot_id: string;
					p_expected_head_snapshot_id: string;
					p_replacement_snapshot_id: string;
				};
				Returns: JsonValue;
			};
			qorpera_accept_company_proposal: {
				Args: { p_proposal_id: string; p_expected_proposal_snapshot_id: string };
				Returns: JsonValue;
			};
			qorpera_retry_company_proposal_review: { Args: { p_assignment_id: string }; Returns: JsonValue };
			qorpera_reject_company_proposal: {
				Args: { p_proposal_id: string; p_expected_proposal_snapshot_id: string };
				Returns: JsonValue;
			};
			qorpera_get_company_proposal: { Args: { p_proposal_id: string }; Returns: JsonValue };
			qorpera_append_company_proposal_comment: {
				Args: { p_proposal_id: string; p_client_comment_id: string; p_body: string };
				Returns: JsonValue;
			};
			qorpera_list_company_proposal_comments: {
				Args: {
					p_proposal_id: string;
					p_after_created_at: string | null;
					p_after_id: string | null;
					p_limit: number;
				};
				Returns: JsonValue;
			};
			qorpera_ensure_company_workspace: {
				Args: {
					p_environment_id: string;
					p_client_workspace_id: string;
					p_name: string;
					p_base_snapshot_id: string | null;
				};
				Returns: JsonValue;
			};
			qorpera_commit_company_snapshot: {
				Args: {
					p_workspace_id: string;
					p_client_snapshot_id: string;
					p_expected_head_snapshot_id: string | null;
					p_tree_manifest_sha256: string;
					p_tree_manifest_bytes: number;
					p_tree_contract_version: number;
					p_file_count: number;
					p_total_bytes: number;
				};
				Returns: JsonValue;
			};
			qorpera_get_company_snapshot: { Args: { p_snapshot_id: string }; Returns: JsonValue };
			qorpera_list_company_workspaces: { Args: { p_environment_id: string }; Returns: JsonValue };
			qorpera_list_company_snapshots: {
				Args: { p_workspace_id: string; p_limit: number };
				Returns: JsonValue;
			};
			qorpera_register_artifact_v2: {
				Args: {
					p_environment_id: string;
					p_client_artifact_id: string;
					p_session_id: string | null;
					p_artifact_type: string;
					p_name: string;
					p_root_object_sha256: string;
					p_root_contract: HostedArtifactRootContract;
					p_content_sha256: string;
					p_bytes: number;
					p_media_type: string;
				};
				Returns: JsonValue;
			};
			qorpera_create_artifact_index: {
				Args: { p_environment_id: string; p_client_index_id: string; p_artifact_ids: string[] };
				Returns: JsonValue;
			};
			qorpera_get_artifact_index: { Args: { p_index_id: string }; Returns: JsonValue };
			qorpera_list_artifact_index_entries: {
				Args: { p_index_id: string; p_after_ordinal: number; p_limit: number };
				Returns: JsonValue;
			};
			qorpera_create_artifact_retention_hold: {
				Args: {
					p_artifact_id: string;
					p_client_hold_id: string;
					p_reason: string;
					p_expires_at: string | null;
				};
				Returns: JsonValue;
			};
			qorpera_release_artifact_retention_hold: { Args: { p_hold_id: string }; Returns: JsonValue };
			qorpera_list_artifact_gc_candidates: {
				Args: { p_profile_id: string; p_limit: number };
				Returns: JsonValue;
			};
			qorpera_create_artifact_gc_plan: {
				Args: { p_artifact_id: string; p_client_plan_id: string };
				Returns: JsonValue;
			};
			qorpera_list_artifact_gc_plans: {
				Args: { p_profile_id: string; p_limit: number };
				Returns: JsonValue;
			};
			qorpera_list_artifact_gc_audit: {
				Args: { p_plan_id: string; p_after_id: number; p_limit: number };
				Returns: JsonValue;
			};
			qorpera_cancel_artifact_gc_plan: {
				Args: { p_plan_id: string };
				Returns: JsonValue;
			};
			qorpera_retry_artifact_gc_plan: {
				Args: { p_plan_id: string };
				Returns: JsonValue;
			};
			qorpera_begin_object_reachability_graph: {
				Args: {
					p_root_kind: HostedObjectRootKind;
					p_root_id: string;
					p_client_graph_id: string;
					p_root_object_sha256: string;
					p_contract_version: number;
					p_content_sha256: string;
					p_object_count: number;
					p_storage_bytes: number;
				};
				Returns: JsonValue;
			};
			qorpera_append_object_reachability_entries: {
				Args: { p_graph_id: string; p_entries: JsonValue };
				Returns: number;
			};
			qorpera_complete_object_reachability_graph: {
				Args: { p_graph_id: string };
				Returns: JsonValue;
			};
			qorpera_get_object_reachability_graph: {
				Args: { p_graph_id: string };
				Returns: JsonValue;
			};
			qorpera_create_object_restore_proof: {
				Args: {
					p_graph_id: string;
					p_client_proof_id: string;
					p_restored_content_sha256: string;
					p_restored_bytes: number;
				};
				Returns: JsonValue;
			};
			qorpera_capture_company_substrate_version_v2: {
				Args: {
					p_snapshot_id: string;
					p_client_version_id: string;
					p_contract_version: number;
					p_artifact_index_id: string;
				};
				Returns: JsonValue;
			};
			qorpera_get_company_substrate_version: { Args: { p_version_id: string }; Returns: JsonValue };
			qorpera_list_company_substrate_operations: {
				Args: { p_version_id: string; p_after_sequence: number; p_limit: number };
				Returns: JsonValue;
			};
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

	async createCompany(input: Parameters<HostedPrimaryTransport["createCompany"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_create_cloud_company", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getCompanyOrganizationBootstrap(
		input: Parameters<HostedPrimaryTransport["getCompanyOrganizationBootstrap"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_company_organization_bootstrap", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getCompanyOrganization(
		input: Parameters<HostedPrimaryTransport["getCompanyOrganization"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_company_organization_json", input);
		if (error) throw rpcError(error);
		return data;
	}

	async createProfile(input: Parameters<HostedPrimaryTransport["createProfile"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_create_hosted_profile", input);
		if (error) throw rpcError(error);
		return data;
	}

	async promoteProfile(input: Parameters<HostedPrimaryTransport["promoteProfile"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_promote_local_profile", input);
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

	async claimSessionTurn(input: Parameters<HostedPrimaryTransport["claimSessionTurn"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_claim_session_turn", input);
		if (error) throw rpcError(error);
		return data;
	}

	async renewSessionTurn(input: Parameters<HostedPrimaryTransport["renewSessionTurn"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_renew_session_turn_v2", input);
		if (error) throw rpcError(error);
		return data;
	}

	async completeSessionTurn(input: Parameters<HostedPrimaryTransport["completeSessionTurn"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_complete_session_turn_v2", input);
		if (error) throw rpcError(error);
		return data;
	}

	async quarantineSessionTurn(
		input: Parameters<HostedPrimaryTransport["quarantineSessionTurn"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_quarantine_session_turn", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listSessionRecoveries(
		input: Parameters<HostedPrimaryTransport["listSessionRecoveries"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_session_recoveries", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listSessionExecutionRunRecoveries(
		input: Parameters<HostedPrimaryTransport["listSessionExecutionRunRecoveries"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_session_execution_run_recoveries", input);
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

	async resolveSessionRecovery(
		input: Parameters<HostedPrimaryTransport["resolveSessionRecovery"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_resolve_session_recovery", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getSessionTurnStatus(input: Parameters<HostedPrimaryTransport["getSessionTurnStatus"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_session_turn_status", input);
		if (error) throw rpcError(error);
		return data;
	}

	async claimWake(input: Parameters<HostedPrimaryTransport["claimWake"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_claim_wake_v2", input);
		if (error) throw rpcError(error);
		return data;
	}

	async renewWake(input: Parameters<HostedPrimaryTransport["renewWake"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_renew_wake", input);
		if (error) throw rpcError(error);
		return data;
	}

	async completeWake(input: Parameters<HostedPrimaryTransport["completeWake"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_complete_wake", input);
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

	async deleteStaff(input: Parameters<HostedPrimaryTransport["deleteStaff"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_delete_profile_staff", input);
		if (error) throw rpcError(error);
		return data;
	}

	async putStaff(input: Parameters<HostedPrimaryTransport["putStaff"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_put_profile_staff", input);
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

	async prepareCompanyFileRevision(
		input: Parameters<HostedPrimaryTransport["prepareCompanyFileRevision"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_prepare_company_file_revision", input);
		if (error) throw rpcError(error);
		return data;
	}

	async prepareCompanyFileProposal(
		input: Parameters<HostedPrimaryTransport["prepareCompanyFileProposal"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_prepare_company_file_proposal", input);
		if (error) throw rpcError(error);
		return data;
	}

	async publishCompanyFileRevision(
		input: Parameters<HostedPrimaryTransport["publishCompanyFileRevision"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_publish_company_file_revision", input);
		if (error) throw rpcError(error);
		return data;
	}

	async submitCompanyProposal(
		input: Parameters<HostedPrimaryTransport["submitCompanyProposal"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_submit_company_proposal", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listCompanyProposals(input: Parameters<HostedPrimaryTransport["listCompanyProposals"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_company_proposals", input);
		if (error) throw rpcError(error);
		return data;
	}

	async acceptCompanyProposal(
		input: Parameters<HostedPrimaryTransport["acceptCompanyProposal"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_accept_company_proposal", input);
		if (error) throw rpcError(error);
		return data;
	}

	async retryCompanyProposalReview(
		input: Parameters<HostedPrimaryTransport["retryCompanyProposalReview"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_retry_company_proposal_review", input);
		if (error) throw rpcError(error);
		return data;
	}

	async rebaseCompanyProposal(
		input: Parameters<HostedPrimaryTransport["rebaseCompanyProposal"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_rebase_company_proposal", input);
		if (error) throw rpcError(error);
		return data;
	}

	async rejectCompanyProposal(
		input: Parameters<HostedPrimaryTransport["rejectCompanyProposal"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_reject_company_proposal", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getCompanyProposal(input: Parameters<HostedPrimaryTransport["getCompanyProposal"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_company_proposal", input);
		if (error) throw rpcError(error);
		return data;
	}

	async appendCompanyProposalComment(
		input: Parameters<HostedPrimaryTransport["appendCompanyProposalComment"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_append_company_proposal_comment", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listCompanyProposalComments(
		input: Parameters<HostedPrimaryTransport["listCompanyProposalComments"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_company_proposal_comments", input);
		if (error) throw rpcError(error);
		return data;
	}

	async ensureCompanyWorkspace(
		input: Parameters<HostedPrimaryTransport["ensureCompanyWorkspace"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_ensure_company_workspace", input);
		if (error) throw rpcError(error);
		return data;
	}

	async commitCompanySnapshot(
		input: Parameters<HostedPrimaryTransport["commitCompanySnapshot"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_commit_company_snapshot", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getCompanySnapshot(input: Parameters<HostedPrimaryTransport["getCompanySnapshot"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_company_snapshot", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listCompanyWorkspaces(
		input: Parameters<HostedPrimaryTransport["listCompanyWorkspaces"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_company_workspaces", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listCompanySnapshots(input: Parameters<HostedPrimaryTransport["listCompanySnapshots"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_company_snapshots", input);
		if (error) throw rpcError(error);
		return data;
	}

	async registerArtifact(input: Parameters<HostedPrimaryTransport["registerArtifact"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_register_artifact_v2", input);
		if (error) throw rpcError(error);
		return data;
	}

	async createArtifactIndex(input: Parameters<HostedPrimaryTransport["createArtifactIndex"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_create_artifact_index", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getArtifactIndex(input: Parameters<HostedPrimaryTransport["getArtifactIndex"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_artifact_index", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listArtifactIndexEntries(
		input: Parameters<HostedPrimaryTransport["listArtifactIndexEntries"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_artifact_index_entries", input);
		if (error) throw rpcError(error);
		return data;
	}

	async createArtifactRetentionHold(
		input: Parameters<HostedPrimaryTransport["createArtifactRetentionHold"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_create_artifact_retention_hold", input);
		if (error) throw rpcError(error);
		return data;
	}

	async releaseArtifactRetentionHold(
		input: Parameters<HostedPrimaryTransport["releaseArtifactRetentionHold"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_release_artifact_retention_hold", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listArtifactGcCandidates(
		input: Parameters<HostedPrimaryTransport["listArtifactGcCandidates"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_artifact_gc_candidates", input);
		if (error) throw rpcError(error);
		return data;
	}

	async createArtifactGcPlan(input: Parameters<HostedPrimaryTransport["createArtifactGcPlan"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_create_artifact_gc_plan", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listArtifactGcPlans(input: Parameters<HostedPrimaryTransport["listArtifactGcPlans"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_artifact_gc_plans", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listArtifactGcAudit(input: Parameters<HostedPrimaryTransport["listArtifactGcAudit"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_artifact_gc_audit", input);
		if (error) throw rpcError(error);
		return data;
	}

	async cancelArtifactGcPlan(input: Parameters<HostedPrimaryTransport["cancelArtifactGcPlan"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_cancel_artifact_gc_plan", input);
		if (error) throw rpcError(error);
		return data;
	}

	async retryArtifactGcPlan(input: Parameters<HostedPrimaryTransport["retryArtifactGcPlan"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_retry_artifact_gc_plan", input);
		if (error) throw rpcError(error);
		return data;
	}

	async beginObjectReachabilityGraph(
		input: Parameters<HostedPrimaryTransport["beginObjectReachabilityGraph"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_begin_object_reachability_graph", input);
		if (error) throw rpcError(error);
		return data;
	}

	async appendObjectReachabilityEntries(
		input: Parameters<HostedPrimaryTransport["appendObjectReachabilityEntries"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_append_object_reachability_entries", input);
		if (error) throw rpcError(error);
		return data;
	}

	async completeObjectReachabilityGraph(
		input: Parameters<HostedPrimaryTransport["completeObjectReachabilityGraph"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_complete_object_reachability_graph", input);
		if (error) throw rpcError(error);
		return data;
	}

	async verifyCompanySnapshotClosure(
		input: Parameters<HostedPrimaryTransport["verifyCompanySnapshotClosure"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.functions.invoke("company-file-verifier", {
			body: input,
		});
		if (error) {
			const context = (error as { context?: Response }).context;
			if (context instanceof Response) {
				const body = await context.text().catch(() => "");
				throw new Error(
					`Company File verification returned ${context.status}: ${body.slice(0, 500) || error.message}`,
				);
			}
			throw new Error(error.message);
		}
		return data;
	}

	async getObjectReachabilityGraph(
		input: Parameters<HostedPrimaryTransport["getObjectReachabilityGraph"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_object_reachability_graph", input);
		if (error) throw rpcError(error);
		return data;
	}

	async createObjectRestoreProof(
		input: Parameters<HostedPrimaryTransport["createObjectRestoreProof"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_create_object_restore_proof", input);
		if (error) throw rpcError(error);
		return data;
	}

	async captureCompanySubstrateVersion(
		input: Parameters<HostedPrimaryTransport["captureCompanySubstrateVersion"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_capture_company_substrate_version_v2", input);
		if (error) throw rpcError(error);
		return data;
	}

	async getCompanySubstrateVersion(
		input: Parameters<HostedPrimaryTransport["getCompanySubstrateVersion"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_get_company_substrate_version", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listCompanySubstrateOperations(
		input: Parameters<HostedPrimaryTransport["listCompanySubstrateOperations"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_company_substrate_operations", input);
		if (error) throw rpcError(error);
		return data;
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Hosted primary returned invalid ${label}`);
	return value as Record<string, unknown>;
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
	const input = record(value, label);
	const expected = new Set(keys);
	if (Object.keys(input).length !== expected.size || Object.keys(input).some((key) => !expected.has(key))) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return input;
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

function artifactRootContract(value: unknown): HostedArtifactRootContract {
	if (!HOSTED_ARTIFACT_ROOT_CONTRACTS.some((candidate) => candidate === value)) {
		throw new Error("Hosted primary returned invalid artifact root contract");
	}
	return value as HostedArtifactRootContract;
}

function objectRootKind(value: unknown): HostedObjectRootKind {
	if (!HOSTED_OBJECT_ROOT_KINDS.some((candidate) => candidate === value)) {
		throw new Error("Hosted primary returned invalid object root kind");
	}
	return value as HostedObjectRootKind;
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

function parseCreatedCompany(value: unknown): CreatedHostedCompany | undefined {
	const input = record(value, "created company");
	const profile = parseProfile(input);
	const companyFile = parseCompanyFile(input.company_file);
	if (profile.profileId !== companyFile.profileId || profile.environmentId !== companyFile.environmentId) {
		throw new Error("Hosted primary returned a Company File outside the created company");
	}
	if (
		(input.bootstrap_state === "queued" || input.bootstrap_state === "leased") &&
		(input.organization === null || input.organization === undefined)
	) {
		return undefined;
	}
	if (input.bootstrap_state === "blocked") {
		throw new Error("Hosted primary could not provision the canonical Company File");
	}
	if (input.bootstrap_state !== "completed" || !companyFile.headSnapshotId || companyFile.state !== "ready") {
		throw new Error("Hosted primary returned an invalid company bootstrap state");
	}
	return { profile, companyFile, organization: parseCompanyOrganizationBootstrap(input.organization) };
}

function parseCompanyOrganizationBootstrap(value: unknown): HostedCompanyOrganizationBootstrap {
	const organization = exactRecord(value, "company organization bootstrap", [
		"schema",
		"cofounder",
		"formation_state",
	]);
	if (
		organization.schema !== "qorpera.company-organization-bootstrap/v1" ||
		organization.formation_state !== "source_inventory"
	) {
		throw new Error("Hosted primary returned invalid company organization bootstrap");
	}
	const cofounder = exactRecord(organization.cofounder, "company Co-Founder bootstrap", [
		"staff_agent_id",
		"formation_id",
		"member_session_id",
	]);
	return {
		schema: "qorpera.company-organization-bootstrap/v1",
		cofounder: {
			staffAgentId: uuid(cofounder.staff_agent_id, "company Co-Founder staff id"),
			formationId: uuid(cofounder.formation_id, "company formation id"),
			memberSessionId: uuid(cofounder.member_session_id, "company Co-Founder member session id"),
		},
		formationState: "source_inventory",
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

function parseCompanyWorkspace(value: unknown): HostedCompanyWorkspace {
	const input = record(value, "company workspace");
	const headSnapshotId = input.head_snapshot_id;
	return {
		workspaceId: uuid(input.workspace_id, "company workspace id"),
		profileId: uuid(input.profile_id, "company workspace profile id"),
		environmentId: uuid(input.environment_id, "company workspace environment id"),
		clientWorkspaceId: uuid(input.client_workspace_id, "company client workspace id"),
		name: nonEmptyString(input.name, "company workspace name", MAX_WORKSPACE_NAME_LENGTH),
		...(headSnapshotId === null || headSnapshotId === undefined
			? {}
			: { headSnapshotId: uuid(headSnapshotId, "company workspace head snapshot id") }),
		createdByUserId: uuid(input.created_by_user_id, "company workspace creator id"),
		createdAt: timestamp(input.created_at, "company workspace creation time"),
		updatedAt: timestamp(input.updated_at, "company workspace update time"),
	};
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Hosted primary returned invalid ${label}`);
	}
	return value as number;
}

function parseCompanySnapshot(value: unknown): HostedCompanySnapshot {
	const input = record(value, "company snapshot");
	const parentSnapshotId = input.parent_snapshot_id;
	const publicationState = input.publication_state;
	if (typeof input.tree_manifest_sha256 !== "string" || !SHA256_PATTERN.test(input.tree_manifest_sha256)) {
		throw new Error("Hosted primary returned invalid company tree manifest hash");
	}
	if (
		publicationState !== undefined &&
		publicationState !== null &&
		publicationState !== "prepared" &&
		publicationState !== "published"
	) {
		throw new Error("Hosted primary returned invalid company snapshot publication state");
	}
	return {
		snapshotId: uuid(input.snapshot_id, "company snapshot id"),
		profileId: uuid(input.profile_id, "company snapshot profile id"),
		environmentId: uuid(input.environment_id, "company snapshot environment id"),
		workspaceId: uuid(input.workspace_id, "company snapshot workspace id"),
		clientSnapshotId: uuid(input.client_snapshot_id, "company client snapshot id"),
		...(parentSnapshotId === null || parentSnapshotId === undefined
			? {}
			: { parentSnapshotId: uuid(parentSnapshotId, "company parent snapshot id") }),
		tree: {
			manifestSha256: input.tree_manifest_sha256,
			manifestBytes: boundedInteger(
				input.tree_manifest_bytes,
				"company tree manifest bytes",
				1,
				MAX_TREE_MANIFEST_BYTES,
			),
			contractVersion: boundedInteger(input.tree_contract_version, "company tree contract version", 1, 3),
			fileCount: boundedInteger(input.file_count, "company tree file count", 0, MAX_TREE_FILES),
			totalBytes: boundedInteger(input.total_bytes, "company tree total bytes", 0, MAX_TREE_BYTES),
		},
		createdByUserId: uuid(input.created_by_user_id, "company snapshot creator id"),
		createdAt: timestamp(input.created_at, "company snapshot creation time"),
		...(publicationState === "prepared" || publicationState === "published" ? { publicationState } : {}),
	};
}

function parseCompanyProposal(value: unknown): HostedCompanyProposal {
	const input = record(value, "company proposal");
	if (
		!HOSTED_COMPANY_PROPOSAL_REASONS.includes(input.reason as HostedCompanyProposalReason) ||
		!HOSTED_COMPANY_PROPOSAL_STATUSES.includes(input.status as HostedCompanyProposalStatus) ||
		(input.execution_kind !== "turn" && input.execution_kind !== "wake" && input.execution_kind !== "run")
	) {
		throw new Error("Hosted primary returned invalid company proposal state");
	}
	const policyKey = input.policy_key;
	const resolvedByUserId = input.resolved_by_user_id;
	const resolvedAt = input.resolved_at;
	const sessionId = input.session_id;
	if (policyKey !== null && policyKey !== undefined && typeof policyKey !== "string") {
		throw new Error("Hosted primary returned invalid company proposal policy");
	}
	if (typeof input.title !== "string" || typeof input.created_by_name !== "string") {
		throw new Error("Hosted primary returned invalid company proposal text");
	}
	return {
		proposalId: uuid(input.proposal_id, "company proposal id"),
		profileId: uuid(input.profile_id, "company proposal profile id"),
		environmentId: uuid(input.environment_id, "company proposal environment id"),
		clientProposalId: uuid(input.client_proposal_id, "company client proposal id"),
		baseSnapshotId: uuid(input.base_snapshot_id, "company proposal base snapshot id"),
		proposalSnapshot: parseCompanySnapshot(input.proposal_snapshot),
		execution: {
			kind: input.execution_kind,
			id: uuid(input.execution_id, "company proposal execution id"),
			claimantId: uuid(input.execution_claimant_id, "company proposal execution claimant id"),
		},
		...(sessionId === null || sessionId === undefined
			? {}
			: { sessionId: uuid(sessionId, "company proposal session id") }),
		trailEndSequence: boundedInteger(
			input.trail_end_sequence,
			"company proposal trail sequence",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		reason: input.reason as HostedCompanyProposalReason,
		...(policyKey === null || policyKey === undefined
			? {}
			: { policyKey: requiredText(policyKey, "Company proposal policy", 128) }),
		title: requiredText(input.title, "Company proposal title", MAX_SESSION_TITLE_LENGTH),
		reviewerStaffIds: array(input.reviewer_staff_ids, "company proposal reviewers").map((reviewer) =>
			uuid(reviewer, "company proposal reviewer id"),
		),
		reviewRevision: boundedInteger(
			input.review_revision,
			"company proposal review revision",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		reviews: array(input.reviews, "company proposal reviews").map((value) => {
			const review = record(value, "company proposal review");
			if (
				typeof review.reviewer_name !== "string" ||
				(review.status !== "queued" &&
					review.status !== "running" &&
					review.status !== "approved" &&
					review.status !== "changes_requested" &&
					review.status !== "failed")
			) {
				throw new Error("Hosted primary returned invalid company proposal review status");
			}
			if (
				review.failure_reason !== null &&
				review.failure_reason !== undefined &&
				typeof review.failure_reason !== "string"
			) {
				throw new Error("Hosted primary returned invalid company proposal review failure");
			}
			return {
				assignmentId: uuid(review.assignment_id, "company proposal review assignment id"),
				proposalRevision: boundedInteger(
					review.proposal_revision,
					"company proposal review revision",
					1,
					Number.MAX_SAFE_INTEGER,
				),
				reviewerStaffAgentId: uuid(review.reviewer_staff_agent_id, "company proposal reviewer staff id"),
				reviewerName: requiredText(review.reviewer_name, "Company proposal reviewer name", 256),
				status: review.status,
				...(review.run_id === null || review.run_id === undefined
					? {}
					: { runId: uuid(review.run_id, "company proposal review run id") }),
				...(review.comment_id === null || review.comment_id === undefined
					? {}
					: { commentId: uuid(review.comment_id, "company proposal review comment id") }),
				...(review.failure_reason === null || review.failure_reason === undefined
					? {}
					: { failureReason: requiredText(review.failure_reason, "Company proposal review failure", 1000) }),
				createdAt: timestamp(review.created_at, "company proposal review creation time"),
				...(review.started_at === null || review.started_at === undefined
					? {}
					: { startedAt: timestamp(review.started_at, "company proposal review start time") }),
				...(review.completed_at === null || review.completed_at === undefined
					? {}
					: { completedAt: timestamp(review.completed_at, "company proposal review completion time") }),
			};
		}),
		status: input.status as HostedCompanyProposalStatus,
		createdByUserId: uuid(input.created_by_user_id, "company proposal creator id"),
		createdByName: requiredText(input.created_by_name, "Company proposal creator name", 256),
		createdAt: timestamp(input.created_at, "company proposal creation time"),
		...(resolvedByUserId === null || resolvedByUserId === undefined
			? {}
			: { resolvedByUserId: uuid(resolvedByUserId, "company proposal resolver id") }),
		...(resolvedAt === null || resolvedAt === undefined
			? {}
			: { resolvedAt: timestamp(resolvedAt, "company proposal resolution time") }),
	};
}

function parseCompanyProposalComment(value: unknown): HostedCompanyProposalComment {
	const input = record(value, "company proposal comment");
	if (typeof input.body !== "string" || typeof input.author_name !== "string") {
		throw new Error("Hosted primary returned invalid company proposal comment text");
	}
	const authorUserId = input.author_user_id;
	const authorStaffAgentId = input.author_staff_agent_id;
	if (
		(authorUserId === null || authorUserId === undefined) ===
		(authorStaffAgentId === null || authorStaffAgentId === undefined)
	) {
		throw new Error("Hosted primary returned invalid company proposal comment author");
	}
	return {
		commentId: uuid(input.comment_id, "company proposal comment id"),
		proposalId: uuid(input.proposal_id, "company proposal comment proposal id"),
		body: requiredText(input.body, "Company proposal comment", 16_384),
		...(authorUserId === null || authorUserId === undefined
			? {}
			: { authorUserId: uuid(authorUserId, "company proposal comment author id") }),
		...(authorStaffAgentId === null || authorStaffAgentId === undefined
			? {}
			: { authorStaffAgentId: uuid(authorStaffAgentId, "company proposal comment staff author id") }),
		authorName: requiredText(input.author_name, "Company proposal comment author", 256),
		createdAt: timestamp(input.created_at, "company proposal comment creation time"),
	};
}

function parseArtifact(value: unknown): HostedArtifact {
	const input = record(value, "artifact");
	const sessionId = input.session_id;
	if (typeof input.root_object_sha256 !== "string" || !SHA256_PATTERN.test(input.root_object_sha256)) {
		throw new Error("Hosted primary returned invalid artifact root object hash");
	}
	if (typeof input.content_sha256 !== "string" || !SHA256_PATTERN.test(input.content_sha256)) {
		throw new Error("Hosted primary returned invalid artifact content hash");
	}
	const artifactType = nonEmptyString(input.artifact_type, "artifact type", 64);
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(artifactType)) {
		throw new Error("Hosted primary returned invalid artifact type");
	}
	const mediaType = nonEmptyString(input.media_type, "artifact media type", 256);
	if (mediaType !== mediaType.trim().toLowerCase() || !mediaType.includes("/") || /[\r\n\0]/.test(mediaType)) {
		throw new Error("Hosted primary returned invalid artifact media type");
	}
	return {
		artifactId: uuid(input.artifact_id, "artifact id"),
		profileId: uuid(input.profile_id, "artifact profile id"),
		environmentId: uuid(input.environment_id, "artifact environment id"),
		clientArtifactId: uuid(input.client_artifact_id, "artifact client id"),
		...(sessionId === null || sessionId === undefined ? {} : { sessionId: uuid(sessionId, "artifact session id") }),
		artifactType,
		name: nonEmptyString(input.name, "artifact name", 256),
		rootObjectSha256: input.root_object_sha256,
		rootContract: artifactRootContract(input.root_contract),
		contentSha256: input.content_sha256,
		bytes: boundedInteger(input.bytes, "artifact bytes", 0, MAX_TREE_BYTES),
		mediaType,
		createdByUserId: uuid(input.created_by_user_id, "artifact creator id"),
		createdAt: timestamp(input.created_at, "artifact creation time"),
		eligibleForGcAt: timestamp(input.eligible_for_gc_at, "artifact garbage-collection eligibility time"),
	};
}

function parseArtifactIndex(value: unknown): HostedArtifactIndex {
	const input = record(value, "artifact index");
	if (input.contract_version !== 1) throw new Error("Hosted primary returned invalid artifact index contract");
	if (typeof input.content_sha256 !== "string" || !SHA256_PATTERN.test(input.content_sha256)) {
		throw new Error("Hosted primary returned invalid artifact index content hash");
	}
	return {
		indexId: uuid(input.index_id, "artifact index id"),
		profileId: uuid(input.profile_id, "artifact index profile id"),
		environmentId: uuid(input.environment_id, "artifact index environment id"),
		clientIndexId: uuid(input.client_index_id, "artifact client index id"),
		contractVersion: 1,
		contentSha256: input.content_sha256,
		artifactCount: boundedInteger(input.artifact_count, "artifact index count", 0, MAX_ARTIFACT_INDEX_ENTRIES),
		totalBytes: boundedInteger(
			input.total_bytes,
			"artifact index total bytes",
			0,
			MAX_TREE_BYTES * MAX_ARTIFACT_INDEX_ENTRIES,
		),
		createdByUserId: uuid(input.created_by_user_id, "artifact index creator id"),
		createdAt: timestamp(input.created_at, "artifact index creation time"),
	};
}

function parseArtifactIndexEntry(value: unknown): HostedArtifactIndexEntry {
	const input = record(value, "artifact index entry");
	return {
		...parseArtifact(input),
		ordinal: boundedInteger(input.ordinal, "artifact index ordinal", 1, MAX_ARTIFACT_INDEX_ENTRIES),
	};
}

function parseArtifactRetentionHold(value: unknown): HostedArtifactRetentionHold {
	const input = record(value, "artifact retention hold");
	const expiresAt = input.expires_at;
	const releasedByUserId = input.released_by_user_id;
	const releasedAt = input.released_at;
	if (
		(releasedByUserId === null || releasedByUserId === undefined) !==
		(releasedAt === null || releasedAt === undefined)
	) {
		throw new Error("Hosted primary returned inconsistent artifact retention release state");
	}
	return {
		holdId: uuid(input.hold_id, "artifact retention hold id"),
		profileId: uuid(input.profile_id, "artifact retention profile id"),
		artifactId: uuid(input.artifact_id, "artifact retention artifact id"),
		clientHoldId: uuid(input.client_hold_id, "artifact retention client id"),
		reason: nonEmptyString(input.reason, "artifact retention reason", 500),
		...(expiresAt === null || expiresAt === undefined
			? {}
			: { expiresAt: timestamp(expiresAt, "artifact retention expiry") }),
		createdByUserId: uuid(input.created_by_user_id, "artifact retention creator id"),
		createdAt: timestamp(input.created_at, "artifact retention creation time"),
		...(releasedByUserId === null || releasedByUserId === undefined
			? {}
			: {
					releasedByUserId: uuid(releasedByUserId, "artifact retention releasing user id"),
					releasedAt: timestamp(releasedAt, "artifact retention release time"),
				}),
	};
}

function parseArtifactGcCandidate(value: unknown): HostedArtifactGcCandidate {
	const input = record(value, "artifact garbage-collection candidate");
	if (typeof input.object_deletion_ready !== "boolean") {
		throw new Error("Hosted primary returned invalid artifact deletion readiness");
	}
	if (typeof input.reachability_ready !== "boolean") {
		throw new Error("Hosted primary returned invalid artifact reachability readiness");
	}
	if (input.object_deletion_ready && !input.reachability_ready) {
		throw new Error("Hosted primary returned unsafe artifact deletion readiness");
	}
	const reachabilityGraphId = input.reachability_graph_id;
	const blockedReason = input.blocked_reason;
	if (input.object_deletion_ready && blockedReason !== null && blockedReason !== undefined) {
		throw new Error("Hosted primary returned inconsistent artifact deletion blocker");
	}
	return {
		...parseArtifact(input),
		objectDeletionReady: input.object_deletion_ready,
		reachabilityReady: input.reachability_ready,
		...(reachabilityGraphId === null || reachabilityGraphId === undefined
			? {}
			: { reachabilityGraphId: uuid(reachabilityGraphId, "artifact reachability graph id") }),
		deletableObjectCount: boundedInteger(
			input.deletable_object_count,
			"artifact deletable object count",
			0,
			MAX_REACHABILITY_OBJECTS,
		),
		deletableStorageBytes: boundedInteger(
			input.deletable_storage_bytes,
			"artifact deletable storage bytes",
			0,
			MAX_REACHABILITY_STORAGE_BYTES,
		),
		...(blockedReason === null || blockedReason === undefined
			? {}
			: { blockedReason: nonEmptyString(blockedReason, "artifact deletion blocker", 500) }),
	};
}

function parseObjectReachabilityGraph(value: unknown): HostedObjectReachabilityGraph {
	const input = record(value, "object reachability graph");
	const status = input.status;
	const completedAt = input.completed_at;
	if (status !== "uploading" && status !== "complete") {
		throw new Error("Hosted primary returned invalid object reachability status");
	}
	if ((status === "complete") !== (typeof completedAt === "string")) {
		throw new Error("Hosted primary returned inconsistent object reachability completion");
	}
	if (input.contract_version !== 1) {
		throw new Error("Hosted primary returned invalid object reachability contract");
	}
	if (typeof input.root_object_sha256 !== "string" || !SHA256_PATTERN.test(input.root_object_sha256)) {
		throw new Error("Hosted primary returned invalid object reachability root hash");
	}
	if (typeof input.content_sha256 !== "string" || !SHA256_PATTERN.test(input.content_sha256)) {
		throw new Error("Hosted primary returned invalid object reachability content hash");
	}
	return {
		graphId: uuid(input.graph_id, "object reachability graph id"),
		profileId: uuid(input.profile_id, "object reachability profile id"),
		environmentId: uuid(input.environment_id, "object reachability environment id"),
		rootKind: objectRootKind(input.root_kind),
		rootId: uuid(input.root_id, "object reachability root id"),
		clientGraphId: uuid(input.client_graph_id, "object reachability client id"),
		rootObjectSha256: input.root_object_sha256,
		contractVersion: 1,
		contentSha256: input.content_sha256,
		objectCount: boundedInteger(input.object_count, "object reachability count", 1, MAX_REACHABILITY_OBJECTS),
		storageBytes: boundedInteger(
			input.storage_bytes,
			"object reachability storage bytes",
			0,
			MAX_REACHABILITY_STORAGE_BYTES,
		),
		status,
		createdByUserId: uuid(input.created_by_user_id, "object reachability creator id"),
		createdAt: timestamp(input.created_at, "object reachability creation time"),
		...(typeof completedAt === "string"
			? { completedAt: timestamp(completedAt, "object reachability completion time") }
			: {}),
	};
}

function parseObjectRestoreProof(value: unknown): HostedObjectRestoreProof {
	const input = record(value, "object restore proof");
	if (typeof input.restored_content_sha256 !== "string" || !SHA256_PATTERN.test(input.restored_content_sha256)) {
		throw new Error("Hosted primary returned invalid restored content hash");
	}
	return {
		proofId: uuid(input.proof_id, "object restore proof id"),
		graphId: uuid(input.graph_id, "object restore graph id"),
		profileId: uuid(input.profile_id, "object restore profile id"),
		clientProofId: uuid(input.client_proof_id, "object restore client id"),
		restoredContentSha256: input.restored_content_sha256,
		restoredBytes: boundedInteger(input.restored_bytes, "restored bytes", 0, MAX_TREE_BYTES),
		verifiedByUserId: uuid(input.verified_by_user_id, "object restore verifier id"),
		verifiedAt: timestamp(input.verified_at, "object restore verification time"),
		validUntil: timestamp(input.valid_until, "object restore validity time"),
	};
}

function parseArtifactGcPlan(value: unknown): HostedArtifactGcPlan {
	const input = record(value, "artifact cleanup plan");
	const status = input.status;
	if (!HOSTED_ARTIFACT_GC_PLAN_STATUSES.some((candidate) => candidate === status)) {
		throw new Error("Hosted primary returned invalid artifact cleanup status");
	}
	const objectCount = boundedInteger(input.object_count, "artifact cleanup object count", 0, MAX_REACHABILITY_OBJECTS);
	const pendingObjectCount = boundedInteger(
		input.pending_object_count,
		"artifact cleanup pending count",
		0,
		MAX_REACHABILITY_OBJECTS,
	);
	const deletedObjectCount = boundedInteger(
		input.deleted_object_count,
		"artifact cleanup deleted count",
		0,
		MAX_REACHABILITY_OBJECTS,
	);
	const retainedObjectCount = boundedInteger(
		input.retained_object_count,
		"artifact cleanup retained count",
		0,
		MAX_REACHABILITY_OBJECTS,
	);
	if (pendingObjectCount + deletedObjectCount + retainedObjectCount !== objectCount) {
		throw new Error("Hosted primary returned inconsistent artifact cleanup counts");
	}
	const lastError = input.last_error;
	const startedAt = input.started_at;
	const completedAt = input.completed_at;
	const cancelledByUserId = input.cancelled_by_user_id;
	const cancelledAt = input.cancelled_at;
	if ((status === "completed") !== (typeof completedAt === "string")) {
		throw new Error("Hosted primary returned inconsistent artifact cleanup completion");
	}
	if (
		(cancelledByUserId === null || cancelledByUserId === undefined) !==
		(cancelledAt === null || cancelledAt === undefined)
	) {
		throw new Error("Hosted primary returned inconsistent artifact cleanup cancellation");
	}
	return {
		planId: uuid(input.plan_id, "artifact cleanup plan id"),
		profileId: uuid(input.profile_id, "artifact cleanup profile id"),
		artifactId: uuid(input.artifact_id, "artifact cleanup artifact id"),
		graphId: uuid(input.graph_id, "artifact cleanup graph id"),
		restoreProofId: uuid(input.restore_proof_id, "artifact cleanup restore proof id"),
		clientPlanId: uuid(input.client_plan_id, "artifact cleanup client id"),
		status: status as HostedArtifactGcPlanStatus,
		objectCount,
		storageBytes: boundedInteger(
			input.storage_bytes,
			"artifact cleanup storage bytes",
			0,
			MAX_REACHABILITY_STORAGE_BYTES,
		),
		pendingObjectCount,
		deletedObjectCount,
		retainedObjectCount,
		notBefore: timestamp(input.not_before, "artifact cleanup recovery time"),
		nextAttemptAt: timestamp(input.next_attempt_at, "artifact cleanup retry time"),
		attemptCount: boundedInteger(input.attempt_count, "artifact cleanup attempt count", 0, 1000),
		...(lastError === null || lastError === undefined
			? {}
			: { lastError: nonEmptyString(lastError, "artifact cleanup error", 1000) }),
		createdByUserId: uuid(input.created_by_user_id, "artifact cleanup creator id"),
		createdAt: timestamp(input.created_at, "artifact cleanup creation time"),
		...(typeof startedAt === "string" ? { startedAt: timestamp(startedAt, "artifact cleanup start time") } : {}),
		...(typeof completedAt === "string"
			? { completedAt: timestamp(completedAt, "artifact cleanup completion time") }
			: {}),
		...(cancelledByUserId === null || cancelledByUserId === undefined
			? {}
			: {
					cancelledByUserId: uuid(cancelledByUserId, "artifact cleanup cancelling user id"),
					cancelledAt: timestamp(cancelledAt, "artifact cleanup cancellation time"),
				}),
	};
}

function parseArtifactGcAuditReceipt(value: unknown): HostedArtifactGcAuditReceipt {
	const input = record(value, "artifact cleanup audit receipt");
	const eventType = input.event_type;
	if (
		eventType !== "created" &&
		eventType !== "claimed" &&
		eventType !== "object_batch_acknowledged" &&
		eventType !== "retrying" &&
		eventType !== "failed" &&
		eventType !== "completed" &&
		eventType !== "cancelled" &&
		eventType !== "manual_retry"
	) {
		throw new Error("Hosted primary returned invalid artifact cleanup audit event");
	}
	const actorUserId = input.actor_user_id;
	return {
		receiptId: boundedInteger(input.receipt_id, "artifact cleanup receipt id", 1, Number.MAX_SAFE_INTEGER),
		planId: uuid(input.plan_id, "artifact cleanup receipt plan id"),
		eventType,
		payload: jsonValue(input.payload),
		...(actorUserId === null || actorUserId === undefined
			? {}
			: { actorUserId: uuid(actorUserId, "artifact cleanup receipt actor id") }),
		createdAt: timestamp(input.created_at, "artifact cleanup receipt time"),
	};
}

function parseCompanySubstrateVersion(value: unknown): HostedCompanySubstrateVersion {
	const input = record(value, "company substrate version");
	const artifactIndexId = input.artifact_index_id;
	const artifactManifestSha256 = input.artifact_manifest_sha256;
	if (
		artifactManifestSha256 !== null &&
		artifactManifestSha256 !== undefined &&
		(typeof artifactManifestSha256 !== "string" || !SHA256_PATTERN.test(artifactManifestSha256))
	) {
		throw new Error("Hosted primary returned invalid artifact manifest hash");
	}
	if (typeof input.content_sha256 !== "string" || !SHA256_PATTERN.test(input.content_sha256)) {
		throw new Error("Hosted primary returned invalid company substrate content hash");
	}
	return {
		versionId: uuid(input.version_id, "company substrate version id"),
		profileId: uuid(input.profile_id, "company substrate profile id"),
		environmentId: uuid(input.environment_id, "company substrate environment id"),
		companySnapshotId: uuid(input.company_snapshot_id, "company substrate snapshot id"),
		clientVersionId: uuid(input.client_version_id, "company substrate client version id"),
		contractVersion: boundedInteger(input.contract_version, "company substrate contract version", 1, 1_000_000),
		operationSequence: boundedInteger(
			input.operation_sequence,
			"company substrate operation sequence",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		operationCount: boundedInteger(
			input.operation_count,
			"company substrate operation count",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		...(artifactIndexId === null || artifactIndexId === undefined
			? {}
			: { artifactIndexId: uuid(artifactIndexId, "company substrate artifact index id") }),
		...(typeof artifactManifestSha256 === "string" ? { artifactManifestSha256 } : {}),
		contentSha256: input.content_sha256,
		createdByUserId: uuid(input.created_by_user_id, "company substrate creator id"),
		createdAt: timestamp(input.created_at, "company substrate creation time"),
	};
}

function parseCompanyOperation(value: unknown): HostedCompanyOperation {
	const input = record(value, "company operation");
	const operationType = input.operation_type;
	if (!HOSTED_COMPANY_OPERATION_TYPES.some((candidate) => candidate === operationType)) {
		throw new Error("Hosted primary returned invalid company operation type");
	}
	const environmentId = input.environment_id;
	if (typeof input.content_sha256 !== "string" || !SHA256_PATTERN.test(input.content_sha256)) {
		throw new Error("Hosted primary returned invalid company operation content hash");
	}
	return {
		profileId: uuid(input.profile_id, "company operation profile id"),
		sequence: boundedInteger(input.sequence, "company operation sequence", 1, Number.MAX_SAFE_INTEGER),
		...(environmentId === null || environmentId === undefined
			? {}
			: { environmentId: uuid(environmentId, "company operation environment id") }),
		operationType: operationType as HostedCompanyOperationType,
		entityId: uuid(input.entity_id, "company operation entity id"),
		entityVersion: boundedInteger(
			input.entity_version,
			"company operation entity version",
			0,
			Number.MAX_SAFE_INTEGER,
		),
		contentSha256: input.content_sha256,
		payload: jsonValue(input.payload),
		actorUserId: uuid(input.actor_user_id, "company operation actor id"),
		createdAt: timestamp(input.created_at, "company operation creation time"),
	};
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

export interface HostedOperationRecoveryReceipt {
	operationId: string;
	operationKind: string;
	status: "executing" | "completed" | "ambiguous" | "cancelled";
	recoveryResolution?: "confirmed_completed" | "confirmed_not_run";
	createdAt: string;
}

export interface HostedSessionRecovery {
	turnId: string;
	companySnapshotId: string;
	staffVersion: number;
	trailStartSequence: number;
	trailEndSequence: number;
	failureReason: string;
	claimedAt: string;
	failedAt: string;
	operationReceipts: HostedOperationRecoveryReceipt[];
	inputs: SessionTurnInput[];
}

export interface HostedSessionRecoveryPage {
	items: HostedSessionRecovery[];
	hasMore: boolean;
	nextCompletedAt?: string;
	nextId?: string;
}

export interface HostedExecutionRunRecovery {
	runId: string;
	sessionId: string;
	failureReason: string;
	failedAt: string;
	operationReceipts: HostedOperationRecoveryReceipt[];
	inputs: SessionTurnInput[];
	proposalId?: string;
}

export interface HostedStaffExecutionActivity {
	runId: string;
	staffAgentId: string;
	sourceKind: "session_turn" | "wake" | "manual" | "room_delivery" | "proposal_review" | "system";
	jobStatus: "queued" | "leased" | "completed" | "failed" | "cancelled";
	activity: "waiting" | "working" | "needs_attention";
	updatedAt: string;
}

export type SessionTurnClaim =
	| { claimed: true; turnId: string; companySnapshotId: string; staffVersion: number; inputs: SessionTurnInput[] }
	| { claimed: false; reason: "turn-in-flight" | "queue-empty" | "stale-revision" };

export type SessionTurnStatus =
	| { status: "unavailable" }
	| {
			status: "active" | "completed" | "quarantined" | "review_pending";
			inputCount: number;
			remainingInputCount: number;
	  };

export class SessionTurnOwnershipError extends Error {
	constructor(action: "renew" | "complete") {
		super(`Session turn ownership was lost before ${action}`);
		this.name = "SessionTurnOwnershipError";
	}
}

export class WakeOwnershipError extends Error {
	constructor(action: "renew" | "complete") {
		super(`Wake ownership was lost before ${action}`);
		this.name = "WakeOwnershipError";
	}
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

function parseSessionTurnClaim(value: unknown): SessionTurnClaim {
	const payload = record(value, "session turn claim");
	if (payload.claimed !== true) {
		const reason =
			payload.reason === "turn-in-flight"
				? "turn-in-flight"
				: payload.reason === "stale-revision"
					? "stale-revision"
					: "queue-empty";
		return { claimed: false, reason };
	}
	return {
		claimed: true,
		turnId: uuid(payload.turn_id, "session turn id"),
		companySnapshotId: uuid(payload.company_snapshot_id, "claimed Company File revision"),
		staffVersion: boundedInteger(payload.staff_version, "claimed staff version", 1, Number.MAX_SAFE_INTEGER),
		inputs: parseSessionInputs(payload.inputs, "session turn inputs"),
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

function parseSessionRecoveryPage(value: unknown): HostedSessionRecoveryPage {
	const page = record(value, "session recovery page");
	const items = array(page.items, "session recoveries").map((entry) => {
		const recovery = record(entry, "session recovery");
		const operationReceipts = array(recovery.operation_receipts, "session recovery operation receipts").map(
			(entry) => {
				const receipt = record(entry, "session recovery operation receipt");
				const recoveryResolution = receipt.recovery_resolution;
				const parsedRecoveryResolution: HostedOperationRecoveryReceipt["recoveryResolution"] =
					recoveryResolution === "confirmed_completed" || recoveryResolution === "confirmed_not_run"
						? recoveryResolution
						: undefined;
				if (!["executing", "completed", "ambiguous", "cancelled"].includes(String(receipt.status))) {
					throw new Error("Hosted primary returned invalid session recovery receipt status");
				}
				return {
					operationId: uuid(receipt.operation_id, "Session recovery operation id"),
					operationKind: nonEmptyString(receipt.operation_kind, "Session recovery operation kind", 64),
					status: receipt.status as HostedOperationRecoveryReceipt["status"],
					...(parsedRecoveryResolution ? { recoveryResolution: parsedRecoveryResolution } : {}),
					createdAt: timestamp(receipt.created_at, "Session recovery operation creation time"),
				};
			},
		);
		return {
			turnId: uuid(recovery.turn_id, "Session recovery turn id"),
			companySnapshotId: uuid(recovery.company_snapshot_id, "Session recovery Company File revision"),
			staffVersion: boundedInteger(
				recovery.staff_version,
				"Session recovery staff version",
				1,
				Number.MAX_SAFE_INTEGER,
			),
			trailStartSequence: boundedInteger(
				recovery.trail_start_sequence,
				"Session recovery trail start",
				0,
				Number.MAX_SAFE_INTEGER,
			),
			trailEndSequence: boundedInteger(
				recovery.trail_end_sequence,
				"Session recovery trail end",
				0,
				Number.MAX_SAFE_INTEGER,
			),
			failureReason: nonEmptyString(recovery.failure_reason, "Session recovery reason", 2048),
			claimedAt: timestamp(recovery.claimed_at, "Session recovery claim time"),
			failedAt: timestamp(recovery.failed_at, "Session recovery failure time"),
			operationReceipts,
			inputs: parseSessionInputs(recovery.inputs, "session recovery inputs"),
		};
	});
	const nextCompletedAt = page.next_completed_at;
	const nextId = page.next_id;
	return {
		items,
		hasMore: page.has_more === true,
		...(nextCompletedAt === null || nextCompletedAt === undefined
			? {}
			: { nextCompletedAt: timestamp(nextCompletedAt, "Session recovery next cursor time") }),
		...(nextId === null || nextId === undefined ? {} : { nextId: uuid(nextId, "Session recovery next cursor id") }),
	};
}

function parseExecutionRunRecovery(value: unknown): HostedExecutionRunRecovery {
	const recovery = record(value, "execution run recovery");
	const run = record(recovery.run, "execution run recovery run");
	const job = record(recovery.job, "execution run recovery job");
	if (run.source_kind !== "session_turn" || (job.status !== "failed" && job.status !== "cancelled")) {
		throw new Error("Hosted primary returned an invalid execution run recovery");
	}
	const operationReceipts: HostedOperationRecoveryReceipt[] = array(
		recovery.operations,
		"execution run recovery operations",
	).map((entry) => {
		const receipt = record(entry, "execution run recovery operation");
		if (!["executing", "completed", "ambiguous", "cancelled"].includes(String(receipt.status))) {
			throw new Error("Hosted primary returned an invalid execution run recovery operation");
		}
		const recoveryResolution = receipt.recovery_resolution;
		return {
			operationId: uuid(receipt.operation_id, "Execution run recovery operation id"),
			operationKind: nonEmptyString(receipt.operation_kind, "Execution run recovery operation kind", 64),
			status: receipt.status as HostedOperationRecoveryReceipt["status"],
			...(recoveryResolution === "confirmed_completed" || recoveryResolution === "confirmed_not_run"
				? { recoveryResolution }
				: {}),
			createdAt: timestamp(receipt.created_at, "Execution run recovery operation creation time"),
		};
	});
	const proposalId = recovery.proposal_id;
	return {
		runId: uuid(run.run_id, "Execution run recovery id"),
		sessionId: uuid(run.session_id, "Execution run recovery session id"),
		failureReason:
			typeof job.last_error === "string"
				? nonEmptyString(job.last_error, "Execution run recovery reason", 2048)
				: "Cloud runner execution was cancelled.",
		failedAt: timestamp(job.finished_at ?? job.cancelled_at, "Execution run recovery failure time"),
		operationReceipts,
		inputs: parseSessionInputs(recovery.inputs, "execution run recovery inputs"),
		...(proposalId === null || proposalId === undefined
			? {}
			: { proposalId: uuid(proposalId, "Execution run recovery proposal id") }),
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

export type WakeClaimResult =
	| { claimed: true; executionId: string; companySnapshotId: string; staffVersion: number }
	| { claimed: false; reason: "in-flight" | "already-run" | "stale-revision" | "requires-review" };

function parseWakeClaimResult(value: unknown): WakeClaimResult {
	const payload = record(value, "wake claim");
	if (payload.claimed === true) {
		return {
			claimed: true,
			executionId: uuid(payload.execution_id, "wake execution id"),
			companySnapshotId: uuid(payload.company_snapshot_id, "wake company snapshot id"),
			staffVersion: boundedInteger(payload.staff_version, "wake staff version", 1, Number.MAX_SAFE_INTEGER),
		};
	}
	const reason =
		payload.reason === "requires-review"
			? "requires-review"
			: payload.reason === "already-run"
				? "already-run"
				: payload.reason === "stale-revision"
					? "stale-revision"
					: "in-flight";
	return { claimed: false, reason };
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

	async createCompany(input: CreateHostedCompanyInput): Promise<CreatedHostedCompany> {
		requiredUuid(input.clientCreationId, "Company creation id");
		if (!Number.isSafeInteger(input.contractVersion) || input.contractVersion < 1) {
			throw new Error("Environment contract version must be a positive integer");
		}
		const request = {
			p_client_creation_id: input.clientCreationId,
			p_company_name: requiredText(input.companyName, "Company name", MAX_PROFILE_NAME_LENGTH),
			p_contract_version: input.contractVersion,
		};
		const deadline = Date.now() + 120_000;
		while (true) {
			const created = parseCreatedCompany(await this.transport.createCompany(request));
			if (created) return created;
			if (Date.now() >= deadline) throw new Error("Canonical Company File bootstrap did not finish in time");
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
		}
	}

	async getCompanyOrganizationBootstrap(profileId: string): Promise<HostedCompanyOrganizationBootstrap> {
		requiredUuid(profileId, "Profile id");
		return parseCompanyOrganizationBootstrap(
			await this.transport.getCompanyOrganizationBootstrap({ p_profile_id: profileId }),
		);
	}

	async getCompanyOrganization(profileId: string): Promise<HostedCompanyOrganization> {
		requiredUuid(profileId, "Profile id");
		return parseHostedCompanyOrganization(await this.transport.getCompanyOrganization({ p_profile_id: profileId }));
	}

	async createProfile(input: CreateHostedProfileInput): Promise<HostedProfile> {
		if (!Number.isSafeInteger(input.contractVersion) || input.contractVersion < 1) {
			throw new Error("Environment contract version must be a positive integer");
		}
		const request = {
			p_profile_name: requiredText(input.profileName, "Profile name", MAX_PROFILE_NAME_LENGTH),
			p_environment_name: requiredText(input.environmentName, "Environment name", MAX_PROFILE_NAME_LENGTH),
			p_contract_version: input.contractVersion,
		};
		if (input.promotionId === undefined) return parseProfile(await this.transport.createProfile(request));
		requiredUuid(input.promotionId, "Promotion id");
		return parseProfile(
			await this.transport.promoteProfile({
				p_promotion_id: input.promotionId,
				...request,
			}),
		);
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

	async claimSessionTurn(
		sessionId: string,
		claimantId: string,
		companySnapshotId: string,
		staffVersion: number,
		leaseSeconds = 120,
	): Promise<SessionTurnClaim> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(claimantId, "Claimant id");
		requiredUuid(companySnapshotId, "Company File revision");
		if (!Number.isSafeInteger(staffVersion) || staffVersion < 1) throw new Error("Staff version is invalid");
		return parseSessionTurnClaim(
			await this.transport.claimSessionTurn({
				p_session_id: sessionId,
				p_claimant_id: claimantId,
				p_lease_seconds: leaseSeconds,
				p_company_snapshot_id: companySnapshotId,
				p_staff_version: staffVersion,
			}),
		);
	}

	async renewSessionTurn(sessionId: string, turnId: string, claimantId: string, leaseSeconds = 120): Promise<void> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(turnId, "Turn id");
		requiredUuid(claimantId, "Claimant id");
		const result = record(
			await this.transport.renewSessionTurn({
				p_session_id: sessionId,
				p_turn_id: turnId,
				p_claimant_id: claimantId,
				p_lease_seconds: leaseSeconds,
			}),
			"session turn renewal",
		);
		if (boundedInteger(result.renewed, "Renewed input count", 0, Number.MAX_SAFE_INTEGER) === 0) {
			throw new SessionTurnOwnershipError("renew");
		}
	}

	async completeSessionTurn(
		sessionId: string,
		turnId: string,
		claimantId: string,
		trailEndSequence: number,
	): Promise<void> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(turnId, "Turn id");
		requiredUuid(claimantId, "Claimant id");
		boundedInteger(trailEndSequence, "trail end sequence", 0, Number.MAX_SAFE_INTEGER);
		const result = record(
			await this.transport.completeSessionTurn({
				p_session_id: sessionId,
				p_turn_id: turnId,
				p_claimant_id: claimantId,
				p_trail_end_sequence: trailEndSequence,
			}),
			"session turn completion",
		);
		if (boundedInteger(result.completed, "Completed input count", 0, Number.MAX_SAFE_INTEGER) === 0) {
			throw new SessionTurnOwnershipError("complete");
		}
	}

	async quarantineSessionTurn(sessionId: string, turnId: string, claimantId: string, reason: string): Promise<void> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(turnId, "Turn id");
		requiredUuid(claimantId, "Claimant id");
		const result = record(
			await this.transport.quarantineSessionTurn({
				p_session_id: sessionId,
				p_turn_id: turnId,
				p_claimant_id: claimantId,
				p_reason: requiredText(reason, "Quarantine reason", 2048),
			}),
			"session turn quarantine",
		);
		if (boundedInteger(result.quarantined, "Quarantined turn count", 0, 1) === 0) {
			throw new SessionTurnOwnershipError("complete");
		}
	}

	async listSessionRecoveries(
		sessionId: string,
		after?: { completedAt: string; turnId: string },
		limit = 10,
	): Promise<HostedSessionRecoveryPage> {
		requiredUuid(sessionId, "Session id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
			throw new Error("Session recovery page size is invalid");
		}
		if (after) {
			timestamp(after.completedAt, "Session recovery cursor time");
			requiredUuid(after.turnId, "Session recovery cursor id");
		}
		return parseSessionRecoveryPage(
			await this.transport.listSessionRecoveries({
				p_session_id: sessionId,
				p_after_completed_at: after?.completedAt ?? null,
				p_after_id: after?.turnId ?? null,
				p_limit: limit,
			}),
		);
	}

	async listSessionExecutionRunRecoveries(sessionId: string, limit = 20): Promise<HostedExecutionRunRecovery[]> {
		requiredUuid(sessionId, "Session id");
		boundedInteger(limit, "Execution run recovery limit", 1, 20);
		return array(
			await this.transport.listSessionExecutionRunRecoveries({
				p_session_id: sessionId,
				p_limit: limit,
			}),
			"execution run recoveries",
		).map(parseExecutionRunRecovery);
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

	async resolveSessionRecovery(
		sessionId: string,
		turnId: string,
		resolution: "retry" | "discard",
	): Promise<{ resolution: "retry" | "discard"; inputCount: number }> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(turnId, "Session recovery turn id");
		const result = record(
			await this.transport.resolveSessionRecovery({
				p_session_id: sessionId,
				p_turn_id: turnId,
				p_resolution: resolution,
			}),
			"session recovery resolution",
		);
		if (result.resolved !== true || (result.resolution !== "retry" && result.resolution !== "discard")) {
			throw new Error("Hosted primary returned invalid session recovery resolution");
		}
		return {
			resolution: result.resolution,
			inputCount: boundedInteger(result.input_count, "Session recovery input count", 0, 32),
		};
	}

	async getSessionTurnStatus(sessionId: string, turnId: string, claimantId: string): Promise<SessionTurnStatus> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(turnId, "Turn id");
		requiredUuid(claimantId, "Claimant id");
		const result = record(
			await this.transport.getSessionTurnStatus({
				p_session_id: sessionId,
				p_turn_id: turnId,
				p_claimant_id: claimantId,
			}),
			"session turn status",
		);
		if (result.status === "unavailable") return { status: "unavailable" };
		if (
			result.status !== "active" &&
			result.status !== "completed" &&
			result.status !== "quarantined" &&
			result.status !== "review_pending"
		) {
			throw new Error("Hosted primary returned invalid session turn status");
		}
		return {
			status: result.status,
			inputCount: boundedInteger(result.input_count, "Session turn input count", 1, 32),
			remainingInputCount: boundedInteger(result.remaining_input_count, "Session turn remaining input count", 0, 32),
		};
	}

	async claimWake(
		environmentId: string,
		wakeKey: string,
		claimantId: string,
		staffAgentId: string,
		companySnapshotId: string,
		staffVersion: number,
		leaseSeconds = 300,
	): Promise<WakeClaimResult> {
		requiredUuid(environmentId, "Environment id");
		requiredUuid(claimantId, "Claimant id");
		requiredUuid(staffAgentId, "Staff agent id");
		requiredUuid(companySnapshotId, "Company snapshot id");
		if (!Number.isSafeInteger(staffVersion) || staffVersion < 1) throw new Error("Staff version must be positive");
		return parseWakeClaimResult(
			await this.transport.claimWake({
				p_environment_id: environmentId,
				p_wake_key: requiredText(wakeKey, "Wake key", 200),
				p_claimant_id: claimantId,
				p_lease_seconds: leaseSeconds,
				p_staff_agent_id: staffAgentId,
				p_company_snapshot_id: companySnapshotId,
				p_staff_version: staffVersion,
			}),
		);
	}

	async renewWake(environmentId: string, wakeKey: string, claimantId: string, leaseSeconds = 300): Promise<void> {
		requiredUuid(environmentId, "Environment id");
		requiredUuid(claimantId, "Claimant id");
		const result = record(
			await this.transport.renewWake({
				p_environment_id: environmentId,
				p_wake_key: requiredText(wakeKey, "Wake key", 200),
				p_claimant_id: claimantId,
				p_lease_seconds: leaseSeconds,
			}),
			"wake renewal",
		);
		if (boundedInteger(result.renewed, "Renewed wake count", 0, 1) === 0) throw new WakeOwnershipError("renew");
	}

	async completeWake(environmentId: string, wakeKey: string, claimantId: string): Promise<void> {
		requiredUuid(environmentId, "Environment id");
		requiredUuid(claimantId, "Claimant id");
		const result = record(
			await this.transport.completeWake({
				p_environment_id: environmentId,
				p_wake_key: requiredText(wakeKey, "Wake key", 200),
				p_claimant_id: claimantId,
			}),
			"wake completion",
		);
		if (boundedInteger(result.completed, "Completed wake count", 0, 1) === 0) {
			throw new WakeOwnershipError("complete");
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

	async prepareCompanyFileRevision(input: PrepareHostedCompanyFileRevisionInput): Promise<HostedCompanySnapshot> {
		requiredUuid(input.environmentId, "Environment id");
		requiredUuid(input.clientRevisionId, "Client revision id");
		if (input.expectedHeadSnapshotId) requiredUuid(input.expectedHeadSnapshotId, "Expected head snapshot id");
		if (!SHA256_PATTERN.test(input.tree.manifestSha256)) throw new Error("Tree manifest SHA-256 is invalid");
		boundedInteger(input.tree.manifestBytes, "tree manifest bytes", 1, MAX_TREE_MANIFEST_BYTES);
		if (input.tree.contractVersion !== 3) throw new Error("Company File tree contract version must be 3");
		boundedInteger(input.tree.fileCount, "tree file count", 0, MAX_TREE_FILES);
		boundedInteger(input.tree.totalBytes, "tree total bytes", 0, MAX_TREE_BYTES);
		return parseCompanySnapshot(
			await this.transport.prepareCompanyFileRevision({
				p_environment_id: input.environmentId,
				p_client_revision_id: input.clientRevisionId,
				p_expected_head_snapshot_id: input.expectedHeadSnapshotId ?? null,
				p_tree_manifest_sha256: input.tree.manifestSha256,
				p_tree_manifest_bytes: input.tree.manifestBytes,
				p_tree_contract_version: input.tree.contractVersion,
				p_file_count: input.tree.fileCount,
				p_total_bytes: input.tree.totalBytes,
			}),
		);
	}

	async prepareCompanyFileProposal(input: PrepareHostedCompanyProposalInput): Promise<HostedCompanySnapshot> {
		requiredUuid(input.environmentId, "Environment id");
		requiredUuid(input.clientRevisionId, "Client revision id");
		requiredUuid(input.baseSnapshotId, "Proposal base snapshot id");
		if (!SHA256_PATTERN.test(input.tree.manifestSha256)) throw new Error("Tree manifest SHA-256 is invalid");
		boundedInteger(input.tree.manifestBytes, "tree manifest bytes", 1, MAX_TREE_MANIFEST_BYTES);
		if (input.tree.contractVersion !== 3) throw new Error("Company File tree contract version must be 3");
		boundedInteger(input.tree.fileCount, "tree file count", 0, MAX_TREE_FILES);
		boundedInteger(input.tree.totalBytes, "tree total bytes", 0, MAX_TREE_BYTES);
		return parseCompanySnapshot(
			await this.transport.prepareCompanyFileProposal({
				p_environment_id: input.environmentId,
				p_client_revision_id: input.clientRevisionId,
				p_base_snapshot_id: input.baseSnapshotId,
				p_tree_manifest_sha256: input.tree.manifestSha256,
				p_tree_manifest_bytes: input.tree.manifestBytes,
				p_tree_contract_version: input.tree.contractVersion,
				p_file_count: input.tree.fileCount,
				p_total_bytes: input.tree.totalBytes,
			}),
		);
	}

	async publishCompanyFileRevision(
		environmentId: string,
		snapshotId: string,
		expectedHeadSnapshotId?: string,
	): Promise<HostedCompanySnapshot> {
		requiredUuid(environmentId, "Environment id");
		requiredUuid(snapshotId, "Snapshot id");
		if (expectedHeadSnapshotId) requiredUuid(expectedHeadSnapshotId, "Expected head snapshot id");
		return parseCompanySnapshot(
			await this.transport.publishCompanyFileRevision({
				p_environment_id: environmentId,
				p_snapshot_id: snapshotId,
				p_expected_head_snapshot_id: expectedHeadSnapshotId ?? null,
			}),
		);
	}

	async submitCompanyProposal(input: SubmitHostedCompanyProposalInput): Promise<HostedCompanyProposal> {
		requiredUuid(input.environmentId, "Environment id");
		requiredUuid(input.clientProposalId, "Client proposal id");
		requiredUuid(input.proposalSnapshotId, "Proposal snapshot id");
		requiredUuid(input.execution.id, "Proposal execution id");
		requiredUuid(input.execution.claimantId, "Proposal execution claimant id");
		requiredUuid(input.sessionId, "Proposal session id");
		boundedInteger(input.trailEndSequence, "proposal trail end sequence", 0, Number.MAX_SAFE_INTEGER);
		if (!HOSTED_COMPANY_PROPOSAL_REASONS.includes(input.reason)) throw new Error("Proposal reason is invalid");
		if (input.policyKey) requiredText(input.policyKey, "Proposal policy", 128);
		if (input.reviewerStaffIds.length > 20) throw new Error("Proposal has too many reviewers");
		for (const reviewer of input.reviewerStaffIds) requiredUuid(reviewer, "Proposal reviewer id");
		return parseCompanyProposal(
			await this.transport.submitCompanyProposal({
				p_environment_id: input.environmentId,
				p_client_proposal_id: input.clientProposalId,
				p_proposal_snapshot_id: input.proposalSnapshotId,
				p_execution_kind: input.execution.kind,
				p_execution_id: input.execution.id,
				p_execution_claimant_id: input.execution.claimantId,
				p_session_id: input.sessionId,
				p_trail_end_sequence: input.trailEndSequence,
				p_reason: input.reason,
				p_policy_key: input.policyKey ?? null,
				p_title: requiredText(input.title, "Proposal title", MAX_SESSION_TITLE_LENGTH),
				p_reviewer_staff_ids: input.reviewerStaffIds,
			}),
		);
	}

	async listCompanyProposals(
		environmentId: string,
		status: HostedCompanyProposalStatus = "open",
		limit = 50,
		after?: { createdAt: string; proposalId: string },
	): Promise<HostedCompanyProposalPage> {
		requiredUuid(environmentId, "Environment id");
		if (!HOSTED_COMPANY_PROPOSAL_STATUSES.includes(status)) throw new Error("Proposal status is invalid");
		boundedInteger(limit, "proposal page size", 1, 100);
		if (after) {
			timestamp(after.createdAt, "proposal page cursor time");
			requiredUuid(after.proposalId, "Proposal page cursor id");
		}
		const value = record(
			await this.transport.listCompanyProposals({
				p_environment_id: environmentId,
				p_status: status,
				p_after_created_at: after?.createdAt ?? null,
				p_after_id: after?.proposalId ?? null,
				p_limit: limit,
			}),
			"company proposal page",
		);
		const nextCreatedAt = value.next_created_at;
		const nextId = value.next_id;
		return {
			items: array(value.items, "company proposals").map(parseCompanyProposal),
			hasMore: value.has_more === true,
			...(nextCreatedAt === null || nextCreatedAt === undefined
				? {}
				: { nextCreatedAt: timestamp(nextCreatedAt, "proposal next cursor time") }),
			...(nextId === null || nextId === undefined ? {} : { nextId: uuid(nextId, "proposal next cursor id") }),
		};
	}

	async acceptCompanyProposal(proposalId: string, expectedProposalSnapshotId: string): Promise<HostedCompanyProposal> {
		requiredUuid(proposalId, "Proposal id");
		requiredUuid(expectedProposalSnapshotId, "Expected proposal snapshot id");
		const proposal = parseCompanyProposal(
			await this.transport.acceptCompanyProposal({
				p_proposal_id: proposalId,
				p_expected_proposal_snapshot_id: expectedProposalSnapshotId,
			}),
		);
		if (
			proposal.proposalId !== proposalId ||
			proposal.proposalSnapshot.snapshotId !== expectedProposalSnapshotId ||
			proposal.status !== "accepted"
		) {
			throw new Error("Hosted primary did not accept the expected Company File proposal revision");
		}
		return proposal;
	}

	async retryCompanyProposalReview(assignmentId: string): Promise<void> {
		requiredUuid(assignmentId, "Company proposal review assignment id");
		const result = record(
			await this.transport.retryCompanyProposalReview({ p_assignment_id: assignmentId }),
			"company proposal review retry",
		);
		if (uuid(result.assignment_id, "Company proposal review retry assignment id") !== assignmentId) {
			throw new Error("Hosted primary returned another proposal review assignment");
		}
		if (result.status !== "queued") throw new Error("Hosted primary did not queue the proposal review retry");
	}

	async rebaseCompanyProposal(
		proposalId: string,
		expectedProposalSnapshotId: string,
		expectedHeadSnapshotId: string,
		replacementSnapshotId: string,
	): Promise<HostedCompanyProposal> {
		requiredUuid(proposalId, "Proposal id");
		requiredUuid(expectedProposalSnapshotId, "Expected proposal snapshot id");
		requiredUuid(expectedHeadSnapshotId, "Expected Company File head snapshot id");
		requiredUuid(replacementSnapshotId, "Replacement proposal snapshot id");
		return parseCompanyProposal(
			await this.transport.rebaseCompanyProposal({
				p_proposal_id: proposalId,
				p_expected_proposal_snapshot_id: expectedProposalSnapshotId,
				p_expected_head_snapshot_id: expectedHeadSnapshotId,
				p_replacement_snapshot_id: replacementSnapshotId,
			}),
		);
	}

	async rejectCompanyProposal(proposalId: string, expectedProposalSnapshotId: string): Promise<HostedCompanyProposal> {
		requiredUuid(proposalId, "Proposal id");
		requiredUuid(expectedProposalSnapshotId, "Expected proposal snapshot id");
		const proposal = parseCompanyProposal(
			await this.transport.rejectCompanyProposal({
				p_proposal_id: proposalId,
				p_expected_proposal_snapshot_id: expectedProposalSnapshotId,
			}),
		);
		if (
			proposal.proposalId !== proposalId ||
			proposal.proposalSnapshot.snapshotId !== expectedProposalSnapshotId ||
			proposal.status !== "rejected"
		) {
			throw new Error("Hosted primary did not reject the expected Company File proposal revision");
		}
		return proposal;
	}

	async getCompanyProposal(proposalId: string): Promise<HostedCompanyProposal> {
		requiredUuid(proposalId, "Proposal id");
		return parseCompanyProposal(await this.transport.getCompanyProposal({ p_proposal_id: proposalId }));
	}

	async appendCompanyProposalComment(
		proposalId: string,
		clientCommentId: string,
		body: string,
	): Promise<HostedCompanyProposalComment> {
		requiredUuid(proposalId, "Proposal id");
		requiredUuid(clientCommentId, "Proposal comment id");
		return parseCompanyProposalComment(
			await this.transport.appendCompanyProposalComment({
				p_proposal_id: proposalId,
				p_client_comment_id: clientCommentId,
				p_body: requiredText(body, "Proposal comment", 16_384),
			}),
		);
	}

	async listCompanyProposalComments(
		proposalId: string,
		limit = 100,
		after?: { createdAt: string; commentId: string },
	): Promise<HostedCompanyProposalCommentPage> {
		requiredUuid(proposalId, "Proposal id");
		boundedInteger(limit, "proposal comment page size", 1, 100);
		if (after) {
			timestamp(after.createdAt, "proposal comment page cursor time");
			requiredUuid(after.commentId, "Proposal comment page cursor id");
		}
		const value = record(
			await this.transport.listCompanyProposalComments({
				p_proposal_id: proposalId,
				p_after_created_at: after?.createdAt ?? null,
				p_after_id: after?.commentId ?? null,
				p_limit: limit,
			}),
			"company proposal comment page",
		);
		const nextCreatedAt = value.next_created_at;
		const nextId = value.next_id;
		return {
			items: array(value.items, "company proposal comments").map(parseCompanyProposalComment),
			hasMore: value.has_more === true,
			...(nextCreatedAt === null || nextCreatedAt === undefined
				? {}
				: { nextCreatedAt: timestamp(nextCreatedAt, "proposal comment next cursor time") }),
			...(nextId === null || nextId === undefined
				? {}
				: { nextId: uuid(nextId, "proposal comment next cursor id") }),
		};
	}

	async deleteStaff(profileId: string, staffAgentId: string, expectedVersion: number): Promise<void> {
		requiredUuid(profileId, "Profile id");
		requiredUuid(staffAgentId, "Staff agent id");
		if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
			throw new Error("Expected staff version must be a positive integer");
		}
		requireTrue(
			await this.transport.deleteStaff({
				p_profile_id: profileId,
				p_staff_agent_id: staffAgentId,
				p_expected_version: expectedVersion,
			}),
			"staff deletion result",
		);
	}

	async ensureCompanyWorkspace(input: EnsureHostedCompanyWorkspaceInput): Promise<HostedCompanyWorkspace> {
		requiredUuid(input.environmentId, "Environment id");
		requiredUuid(input.clientWorkspaceId, "Client workspace id");
		if (input.baseSnapshotId) requiredUuid(input.baseSnapshotId, "Base snapshot id");
		return parseCompanyWorkspace(
			await this.transport.ensureCompanyWorkspace({
				p_environment_id: input.environmentId,
				p_client_workspace_id: input.clientWorkspaceId,
				p_name: requiredText(input.name, "Workspace name", MAX_WORKSPACE_NAME_LENGTH),
				p_base_snapshot_id: input.baseSnapshotId ?? null,
			}),
		);
	}

	async commitCompanySnapshot(input: CommitHostedCompanySnapshotInput): Promise<HostedCompanySnapshot> {
		requiredUuid(input.workspaceId, "Workspace id");
		requiredUuid(input.clientSnapshotId, "Client snapshot id");
		if (input.expectedHeadSnapshotId) requiredUuid(input.expectedHeadSnapshotId, "Expected head snapshot id");
		if (!SHA256_PATTERN.test(input.tree.manifestSha256)) throw new Error("Tree manifest SHA-256 is invalid");
		boundedInteger(input.tree.manifestBytes, "tree manifest bytes", 1, MAX_TREE_MANIFEST_BYTES);
		boundedInteger(input.tree.contractVersion, "tree contract version", 1, 1_000_000);
		boundedInteger(input.tree.fileCount, "tree file count", 0, MAX_TREE_FILES);
		boundedInteger(input.tree.totalBytes, "tree total bytes", 0, MAX_TREE_BYTES);
		return parseCompanySnapshot(
			await this.transport.commitCompanySnapshot({
				p_workspace_id: input.workspaceId,
				p_client_snapshot_id: input.clientSnapshotId,
				p_expected_head_snapshot_id: input.expectedHeadSnapshotId ?? null,
				p_tree_manifest_sha256: input.tree.manifestSha256,
				p_tree_manifest_bytes: input.tree.manifestBytes,
				p_tree_contract_version: input.tree.contractVersion,
				p_file_count: input.tree.fileCount,
				p_total_bytes: input.tree.totalBytes,
			}),
		);
	}

	async listCompanyWorkspaces(environmentId: string): Promise<HostedCompanyWorkspace[]> {
		requiredUuid(environmentId, "Environment id");
		return array(
			await this.transport.listCompanyWorkspaces({ p_environment_id: environmentId }),
			"company workspace list",
		).map(parseCompanyWorkspace);
	}

	async getCompanySnapshot(snapshotId: string): Promise<HostedCompanySnapshot> {
		requiredUuid(snapshotId, "Snapshot id");
		return parseCompanySnapshot(await this.transport.getCompanySnapshot({ p_snapshot_id: snapshotId }));
	}

	async listCompanySnapshots(workspaceId: string, limit = 100): Promise<HostedCompanySnapshot[]> {
		requiredUuid(workspaceId, "Workspace id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Snapshot page size must be between 1 and 500");
		}
		return array(
			await this.transport.listCompanySnapshots({ p_workspace_id: workspaceId, p_limit: limit }),
			"company snapshot list",
		).map(parseCompanySnapshot);
	}

	async registerArtifact(input: RegisterHostedArtifactInput): Promise<HostedArtifact> {
		requiredUuid(input.environmentId, "Environment id");
		requiredUuid(input.clientArtifactId, "Client artifact id");
		if (input.sessionId) requiredUuid(input.sessionId, "Artifact session id");
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.artifactType)) throw new Error("Artifact type is invalid");
		if (!SHA256_PATTERN.test(input.rootObjectSha256)) throw new Error("Artifact root object SHA-256 is invalid");
		if (!HOSTED_ARTIFACT_ROOT_CONTRACTS.includes(input.rootContract)) {
			throw new Error("Artifact root contract is invalid");
		}
		if (!SHA256_PATTERN.test(input.contentSha256)) throw new Error("Artifact content SHA-256 is invalid");
		boundedInteger(input.bytes, "artifact bytes", 0, MAX_TREE_BYTES);
		if (
			input.rootContract === "qorpera.object/v1" &&
			(input.rootObjectSha256 !== input.contentSha256 || input.bytes > MAX_TREE_MANIFEST_BYTES)
		) {
			throw new Error("Direct artifact object does not match its content");
		}
		const mediaType = input.mediaType.trim().toLowerCase();
		if (!mediaType.includes("/") || mediaType.length > 256 || /[\r\n\0]/.test(mediaType)) {
			throw new Error("Artifact media type is invalid");
		}
		return parseArtifact(
			await this.transport.registerArtifact({
				p_environment_id: input.environmentId,
				p_client_artifact_id: input.clientArtifactId,
				p_session_id: input.sessionId ?? null,
				p_artifact_type: input.artifactType,
				p_name: requiredText(input.name, "Artifact name", 256),
				p_root_object_sha256: input.rootObjectSha256,
				p_root_contract: input.rootContract,
				p_content_sha256: input.contentSha256,
				p_bytes: input.bytes,
				p_media_type: mediaType,
			}),
		);
	}

	async createArtifactIndex(input: CreateHostedArtifactIndexInput): Promise<HostedArtifactIndex> {
		requiredUuid(input.environmentId, "Environment id");
		requiredUuid(input.clientIndexId, "Client artifact index id");
		if (input.artifactIds.length > MAX_ARTIFACT_INDEX_ENTRIES) throw new Error("Artifact index is too large");
		const artifactIds = [...input.artifactIds].sort();
		for (const artifactId of artifactIds) requiredUuid(artifactId, "Artifact id");
		if (new Set(artifactIds).size !== artifactIds.length) throw new Error("Artifact index contains duplicate ids");
		return parseArtifactIndex(
			await this.transport.createArtifactIndex({
				p_environment_id: input.environmentId,
				p_client_index_id: input.clientIndexId,
				p_artifact_ids: artifactIds,
			}),
		);
	}

	async getArtifactIndex(indexId: string): Promise<HostedArtifactIndex> {
		requiredUuid(indexId, "Artifact index id");
		return parseArtifactIndex(await this.transport.getArtifactIndex({ p_index_id: indexId }));
	}

	async listArtifactIndexEntries(indexId: string, afterOrdinal = 0, limit = 200): Promise<HostedArtifactIndexEntry[]> {
		requiredUuid(indexId, "Artifact index id");
		if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0 || afterOrdinal > MAX_ARTIFACT_INDEX_ENTRIES) {
			throw new Error("Artifact index cursor must be between 0 and 5000");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Artifact index page size must be between 1 and 500");
		}
		return array(
			await this.transport.listArtifactIndexEntries({
				p_index_id: indexId,
				p_after_ordinal: afterOrdinal,
				p_limit: limit,
			}),
			"artifact index entry list",
		).map(parseArtifactIndexEntry);
	}

	async createArtifactRetentionHold(
		artifactId: string,
		clientHoldId: string,
		reason: string,
		expiresAt?: string,
	): Promise<HostedArtifactRetentionHold> {
		requiredUuid(artifactId, "Artifact id");
		requiredUuid(clientHoldId, "Client artifact retention id");
		if (expiresAt !== undefined && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
			throw new Error("Artifact retention expiry must be in the future");
		}
		return parseArtifactRetentionHold(
			await this.transport.createArtifactRetentionHold({
				p_artifact_id: artifactId,
				p_client_hold_id: clientHoldId,
				p_reason: requiredText(reason, "Artifact retention reason", 500),
				p_expires_at: expiresAt ?? null,
			}),
		);
	}

	async releaseArtifactRetentionHold(holdId: string): Promise<HostedArtifactRetentionHold> {
		requiredUuid(holdId, "Artifact retention hold id");
		return parseArtifactRetentionHold(await this.transport.releaseArtifactRetentionHold({ p_hold_id: holdId }));
	}

	async listArtifactGcCandidates(profileId: string, limit = 200): Promise<HostedArtifactGcCandidate[]> {
		requiredUuid(profileId, "Profile id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Artifact garbage-collection page size must be between 1 and 500");
		}
		return array(
			await this.transport.listArtifactGcCandidates({ p_profile_id: profileId, p_limit: limit }),
			"artifact garbage-collection candidate list",
		).map(parseArtifactGcCandidate);
	}

	async createArtifactGcPlan(artifactId: string, clientPlanId: string): Promise<HostedArtifactGcPlan> {
		requiredUuid(artifactId, "Artifact id");
		requiredUuid(clientPlanId, "Client artifact cleanup plan id");
		return parseArtifactGcPlan(
			await this.transport.createArtifactGcPlan({
				p_artifact_id: artifactId,
				p_client_plan_id: clientPlanId,
			}),
		);
	}

	async listArtifactGcPlans(profileId: string, limit = 100): Promise<HostedArtifactGcPlan[]> {
		requiredUuid(profileId, "Profile id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Artifact cleanup page size must be between 1 and 500");
		}
		return array(
			await this.transport.listArtifactGcPlans({ p_profile_id: profileId, p_limit: limit }),
			"artifact cleanup plan list",
		).map(parseArtifactGcPlan);
	}

	async listArtifactGcAudit(planId: string, afterReceiptId = 0, limit = 200): Promise<HostedArtifactGcAuditReceipt[]> {
		requiredUuid(planId, "Artifact cleanup plan id");
		if (!Number.isSafeInteger(afterReceiptId) || afterReceiptId < 0) {
			throw new Error("Artifact cleanup receipt cursor must be a non-negative integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Artifact cleanup receipt page size must be between 1 and 500");
		}
		return array(
			await this.transport.listArtifactGcAudit({
				p_plan_id: planId,
				p_after_id: afterReceiptId,
				p_limit: limit,
			}),
			"artifact cleanup audit list",
		).map(parseArtifactGcAuditReceipt);
	}

	async cancelArtifactGcPlan(planId: string): Promise<HostedArtifactGcPlan> {
		requiredUuid(planId, "Artifact cleanup plan id");
		return parseArtifactGcPlan(await this.transport.cancelArtifactGcPlan({ p_plan_id: planId }));
	}

	async retryArtifactGcPlan(planId: string): Promise<HostedArtifactGcPlan> {
		requiredUuid(planId, "Artifact cleanup plan id");
		return parseArtifactGcPlan(await this.transport.retryArtifactGcPlan({ p_plan_id: planId }));
	}

	async beginObjectReachabilityGraph(
		input: BeginHostedObjectReachabilityGraphInput,
	): Promise<HostedObjectReachabilityGraph> {
		if (!HOSTED_OBJECT_ROOT_KINDS.includes(input.rootKind)) throw new Error("Object root kind is invalid");
		requiredUuid(input.rootId, "Object root id");
		requiredUuid(input.clientGraphId, "Client object graph id");
		if (!SHA256_PATTERN.test(input.rootObjectSha256)) throw new Error("Object root SHA-256 is invalid");
		if (!SHA256_PATTERN.test(input.contentSha256)) throw new Error("Object graph content SHA-256 is invalid");
		boundedInteger(input.objectCount, "object graph count", 1, MAX_REACHABILITY_OBJECTS);
		boundedInteger(input.storageBytes, "object graph storage bytes", 0, MAX_REACHABILITY_STORAGE_BYTES);
		return parseObjectReachabilityGraph(
			await this.transport.beginObjectReachabilityGraph({
				p_root_kind: input.rootKind,
				p_root_id: input.rootId,
				p_client_graph_id: input.clientGraphId,
				p_root_object_sha256: input.rootObjectSha256,
				p_contract_version: 1,
				p_content_sha256: input.contentSha256,
				p_object_count: input.objectCount,
				p_storage_bytes: input.storageBytes,
			}),
		);
	}

	async appendObjectReachabilityEntries(graphId: string, entries: HostedObjectReachabilityEntry[]): Promise<number> {
		requiredUuid(graphId, "Object graph id");
		if (entries.length < 1 || entries.length > 500) {
			throw new Error("Object reachability batch must contain between 1 and 500 entries");
		}
		const seen = new Set<string>();
		const payload: Array<{ sha256: string; bytes: number }> = [];
		for (const entry of entries) {
			if (!SHA256_PATTERN.test(entry.sha256)) throw new Error("Reachable object SHA-256 is invalid");
			boundedInteger(entry.bytes, "reachable object bytes", 0, MAX_TREE_MANIFEST_BYTES);
			if (seen.has(entry.sha256)) throw new Error("Object reachability batch contains duplicate hashes");
			seen.add(entry.sha256);
			payload.push({ sha256: entry.sha256, bytes: entry.bytes });
		}
		const result = await this.transport.appendObjectReachabilityEntries({
			p_graph_id: graphId,
			p_entries: payload,
		});
		return boundedInteger(result, "object reachability uploaded count", 1, MAX_REACHABILITY_OBJECTS);
	}

	async completeObjectReachabilityGraph(graphId: string): Promise<HostedObjectReachabilityGraph> {
		requiredUuid(graphId, "Object graph id");
		return parseObjectReachabilityGraph(
			await this.transport.completeObjectReachabilityGraph({ p_graph_id: graphId }),
		);
	}

	async getObjectReachabilityGraph(graphId: string): Promise<HostedObjectReachabilityGraph> {
		requiredUuid(graphId, "Object graph id");
		return parseObjectReachabilityGraph(await this.transport.getObjectReachabilityGraph({ p_graph_id: graphId }));
	}

	async verifyCompanySnapshotClosure(snapshotId: string, graphId: string): Promise<void> {
		requiredUuid(snapshotId, "Company snapshot id");
		requiredUuid(graphId, "Object graph id");
		for (let tranche = 0; tranche < MAX_COMPANY_VERIFICATION_TRANCHES; tranche += 1) {
			const result = await this.transport.verifyCompanySnapshotClosure({ snapshotId, graphId });
			const value = record(result, "Company snapshot verification");
			if (value.verified === true) return;
			if (value.pending !== true) throw new Error("Company snapshot server verification did not complete");
			await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		}
		throw new Error("Company snapshot server verification exceeded the supported Company File limits");
	}

	async createObjectRestoreProof(
		graphId: string,
		clientProofId: string,
		restoredContentSha256: string,
		restoredBytes: number,
	): Promise<HostedObjectRestoreProof> {
		requiredUuid(graphId, "Object graph id");
		requiredUuid(clientProofId, "Client restore proof id");
		if (!SHA256_PATTERN.test(restoredContentSha256)) throw new Error("Restored content SHA-256 is invalid");
		boundedInteger(restoredBytes, "restored bytes", 0, MAX_TREE_BYTES);
		return parseObjectRestoreProof(
			await this.transport.createObjectRestoreProof({
				p_graph_id: graphId,
				p_client_proof_id: clientProofId,
				p_restored_content_sha256: restoredContentSha256,
				p_restored_bytes: restoredBytes,
			}),
		);
	}

	async captureCompanySubstrateVersion(
		input: CaptureHostedCompanySubstrateVersionInput,
	): Promise<HostedCompanySubstrateVersion> {
		requiredUuid(input.snapshotId, "Snapshot id");
		requiredUuid(input.clientVersionId, "Client substrate version id");
		requiredUuid(input.artifactIndexId, "Artifact index id");
		const contractVersion = input.contractVersion ?? 1;
		if (contractVersion !== 1) throw new Error("Company substrate contract version must be 1");
		return parseCompanySubstrateVersion(
			await this.transport.captureCompanySubstrateVersion({
				p_snapshot_id: input.snapshotId,
				p_client_version_id: input.clientVersionId,
				p_contract_version: contractVersion,
				p_artifact_index_id: input.artifactIndexId,
			}),
		);
	}

	async getCompanySubstrateVersion(versionId: string): Promise<HostedCompanySubstrateVersion> {
		requiredUuid(versionId, "Company substrate version id");
		return parseCompanySubstrateVersion(await this.transport.getCompanySubstrateVersion({ p_version_id: versionId }));
	}

	async listCompanySubstrateOperations(
		versionId: string,
		afterSequence = 0,
		limit = 200,
	): Promise<HostedCompanyOperation[]> {
		requiredUuid(versionId, "Company substrate version id");
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
			throw new Error("Company operation cursor must be a non-negative integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Company operation page size must be between 1 and 500");
		}
		return array(
			await this.transport.listCompanySubstrateOperations({
				p_version_id: versionId,
				p_after_sequence: afterSequence,
				p_limit: limit,
			}),
			"company operation list",
		).map(parseCompanyOperation);
	}

	async putStaff(profileId: string, staff: StaffAgent, expectedVersion?: number): Promise<HostedStaffAgent> {
		requiredUuid(profileId, "Profile id");
		requiredUuid(staff.id, "Staff agent id");
		if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
			throw new Error("Expected staff version must be a positive integer");
		}
		return parseStaff(
			await this.transport.putStaff({
				p_profile_id: profileId,
				p_staff_agent_id: staff.id,
				p_display_name: staff.displayName,
				p_role: staff.role,
				p_charter: staff.charter,
				p_template_id: staff.templateId ?? null,
				p_department_id: staff.departmentId ?? null,
				p_appearance_color: staff.appearance.color,
				p_appearance_shape: staff.appearance.shape,
				p_appearance_creature: staff.appearance.creature ?? null,
				p_model_provider: staff.model?.provider ?? null,
				p_model_id: staff.model?.modelId ?? null,
				p_employment_status: staff.employmentStatus,
				p_lifecycle_state: staff.lifecycleState,
				p_created_at: staff.createdAt,
				p_expected_version: expectedVersion ?? null,
			}),
		);
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
