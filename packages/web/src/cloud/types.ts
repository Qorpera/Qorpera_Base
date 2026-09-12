/* Wire shapes of the member-callable surface, ported from the desktop's
 * hosted-primary.ts so both clients accept the same payloads. Field names are
 * camelCase projections of the RPC JSON. */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const HOSTED_PROFILE_ROLES = ["owner", "admin", "contributor", "viewer"] as const;
export type HostedProfileRole = (typeof HOSTED_PROFILE_ROLES)[number];

export const HOSTED_SESSION_EVENT_TYPES = [
	"message",
	"session_info",
	"run_receipt",
	"artifact_receipt",
	"authorization_request",
	"authorization_decision",
] as const;
export type HostedSessionEventType = (typeof HOSTED_SESSION_EVENT_TYPES)[number];

export interface HostedProfile {
	profileId: string;
	environmentId: string;
	profileName: string;
	environmentName: string;
	role: HostedProfileRole;
	contractVersion: number;
	createdAt: string;
}

export const HOSTED_FRIEND_STATUSES = ["pending", "accepted"] as const;
export type HostedFriendStatus = (typeof HOSTED_FRIEND_STATUSES)[number];

/* A friendship as `qorpera_list_friends` reports it. Direction is relative to
 * the caller: `incoming` means the other account asked and this account
 * answers. Company invitations only reach people you are already friends
 * with, which is why the account menu carries this list. */
export interface HostedFriend {
	userId: string;
	email: string;
	displayName: string;
	status: HostedFriendStatus;
	direction: "incoming" | "outgoing";
	since: string;
}

export interface HostedInvitationDelivery {
	status: string;
	attemptCount: number;
	nextAttemptAt: string;
	providerMessageId?: string;
	lastError?: string;
	sentAt?: string;
}

export interface HostedProfileInvitation {
	id: string;
	profileId: string;
	email: string;
	role: Exclude<HostedProfileRole, "owner">;
	invitedByUserId: string;
	createdAt: string;
	expiresAt: string;
	delivery?: HostedInvitationDelivery;
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
	profileId: string;
	role: HostedProfileRole;
	capabilities: { read: true; write: boolean; authorize: boolean; manageMembers: boolean };
	members: HostedProfileMember[];
	invitations: HostedProfileInvitation[];
}

export type HostedSessionAudience = { kind: "company" } | { kind: "member_private"; userId: string };

export interface HostedSession {
	sessionId: string;
	clientSessionId: string;
	profileId: string;
	environmentId: string;
	title: string;
	staffAgentId?: string;
	parentSessionId?: string;
	executionScope?: Record<string, JsonValue>;
	companySnapshotId?: string;
	staffVersion?: number;
	audience: HostedSessionAudience;
	status: "open" | "closed";
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
}

export type HostedSessionExecutionIdentity =
	| { kind: "turn" | "wake"; id: string; claimantId: string }
	| { kind: "run"; id: string; claimantId: string; runnerAssignmentId: string };

export interface HostedStaffSpeaker {
	runId: string;
	staffAgentId: string;
	staffVersion: number;
	/** Name captured at send time; absent when historical version cannot be established. */
	displayName?: string;
}

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
	staffSpeaker?: HostedStaffSpeaker;
	sessionInputId?: string;
	createdAt: string;
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

export interface PendingSessionInput {
	inputId: string;
	position: number;
	kind: "kickoff" | "user_message";
	authorUserId: string;
	authorDisplayName: string;
	body: JsonValue;
	createdAt: string;
	status: "queued" | "processing" | "failed";
	failureReason?: string;
}

export interface PendingSessionInputPage {
	items: PendingSessionInput[];
	nextAfterPosition: number;
	hasMore: boolean;
}

export interface SessionInputReceipt {
	inputId: string;
	position: number;
}

export interface HostedStaffAgent {
	profileId: string;
	id: string;
	displayName: string;
	role: string;
	charter: string;
	templateId?: string;
	departmentId?: string;
	appearance: { color: string; shape: string; creature?: string };
	model?: { provider: string; modelId: string };
	employmentStatus: "active" | "archived";
	lifecycleState: "setup" | "active";
	version: number;
	createdAt: string;
	updatedAt: string;
	updatedByUserId: string;
}

export interface HostedStaffExecutionActivity {
	runId: string;
	staffAgentId: string;
	sourceKind: "session_turn" | "wake" | "manual" | "room_delivery" | "proposal_review" | "system";
	jobStatus: "queued" | "leased" | "completed" | "failed" | "cancelled";
	activity: "waiting" | "working" | "needs_attention";
	updatedAt: string;
}

export interface HostedAccountEntitlement {
	planKey: string;
	billingMode: string;
	featureSet: string;
	storageAllocation: string;
	storageAllocationBytes?: number;
	source: string;
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
	entitlement?: HostedAccountEntitlement;
	createdAt: string;
	updatedAt: string;
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

export type HostedCompanyProposalStatus = "open" | "accepted" | "rejected";
export type HostedCompanyProposalReason = "policy" | "authority" | "conflict" | "recovery";

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

export interface HostedCompanyProposal {
	proposalId: string;
	profileId: string;
	environmentId: string;
	clientProposalId: string;
	baseSnapshotId: string;
	proposalSnapshot: HostedCompanySnapshot;
	execution: { kind: "turn" | "wake" | "run"; id: string; claimantId: string };
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

export interface CreatedCompanyResult {
	profile: HostedProfile;
	/** Absent on clouds that predate the Order 0 bootstrap ledger. */
	bootstrapState?: "queued" | "leased" | "completed" | "blocked";
}

/* Company tree manifests (COMPANY-FILE.md, cloud-company-snapshot.ts) */

export interface CloudFileReference {
	manifestSha256: string;
	fileSha256: string;
	bytes: number;
	mediaType: string;
}

export type CloudCompanyTreeEntry =
	| { kind: "directory"; path: string }
	| { kind: "file"; path: string; executable: boolean; file: CloudFileReference };

export interface CloudCompanyTreeManifest {
	schema: "qorpera.company-tree/v1";
	contractVersion: number;
	omittedLayers: string[];
	entries: CloudCompanyTreeEntry[];
}
