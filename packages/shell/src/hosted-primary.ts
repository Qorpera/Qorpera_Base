import type { StaffAgent } from "@qorpera/pi-coding-agent/company-staff";
import type { JsonValue } from "@qorpera/pi-protocol";
import type { SupabaseClient } from "@supabase/supabase-js";

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

export interface HostedSession {
	sessionId: string;
	/** Stable trail identity chosen by the originating kernel. */
	clientSessionId: string;
	profileId: string;
	environmentId: string;
	title: string;
	staffAgentId?: string;
	parentSessionId?: string;
	status: "open" | "closed";
	createdByUserId: string;
	createdAt: string;
	updatedAt: string;
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

export interface CreateHostedSessionInput {
	environmentId: string;
	clientSessionId: string;
	title: string;
	staffAgentId?: string;
	parentSessionId?: string;
}

export interface AppendHostedSessionEventInput {
	sessionId: string;
	eventId: string;
	eventType: HostedSessionEventType;
	body: JsonValue;
	/** Last sequence observed by the caller. The append fails if the trail advanced. */
	expectedSequence?: number;
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
	}): Promise<unknown>;
	listSessions(input: { p_environment_id: string }): Promise<unknown>;
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
	claimSessionTurn(input: { p_session_id: string; p_claimant_id: string; p_lease_seconds: number }): Promise<unknown>;
	renewSessionTurn(input: { p_session_id: string; p_claimant_id: string; p_lease_seconds: number }): Promise<unknown>;
	completeSessionTurn(input: { p_session_id: string; p_claimant_id: string }): Promise<unknown>;
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
	}): Promise<unknown>;
	readSessionEvents(input: { p_session_id: string; p_after_sequence: number; p_limit: number }): Promise<unknown>;
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
			qorpera_create_shared_session_v2: {
				Args: {
					p_environment_id: string;
					p_client_session_id: string;
					p_title: string;
					p_staff_agent_id: string | null;
					p_parent_session_id: string | null;
				};
				Returns: JsonValue;
			};
			qorpera_list_shared_sessions: { Args: { p_environment_id: string }; Returns: JsonValue };
			qorpera_ensure_staff_session: {
				Args: { p_environment_id: string; p_staff_agent_id: string; p_client_session_id: string; p_title: string };
				Returns: JsonValue;
			};
			qorpera_append_session_input: {
				Args: { p_session_id: string; p_client_input_id: string; p_kind: string; p_body: JsonValue };
				Returns: JsonValue;
			};
			qorpera_claim_session_turn: {
				Args: { p_session_id: string; p_claimant_id: string; p_lease_seconds: number };
				Returns: JsonValue;
			};
			qorpera_renew_session_turn: {
				Args: { p_session_id: string; p_claimant_id: string; p_lease_seconds: number };
				Returns: JsonValue;
			};
			qorpera_complete_session_turn: {
				Args: { p_session_id: string; p_claimant_id: string };
				Returns: JsonValue;
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
				};
				Returns: JsonValue;
			};
			qorpera_read_session_events: {
				Args: { p_session_id: string; p_after_sequence: number; p_limit: number };
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

	async claimSessionTurn(input: Parameters<HostedPrimaryTransport["claimSessionTurn"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_claim_session_turn", input);
		if (error) throw rpcError(error);
		return data;
	}

	async renewSessionTurn(input: Parameters<HostedPrimaryTransport["renewSessionTurn"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_renew_session_turn", input);
		if (error) throw rpcError(error);
		return data;
	}

	async completeSessionTurn(input: Parameters<HostedPrimaryTransport["completeSessionTurn"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_complete_session_turn", input);
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

	async putStaff(input: Parameters<HostedPrimaryTransport["putStaff"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_put_profile_staff", input);
		if (error) throw rpcError(error);
		return data;
	}

	async createSession(input: Parameters<HostedPrimaryTransport["createSession"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_create_shared_session_v2", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listSessions(input: Parameters<HostedPrimaryTransport["listSessions"]>[0]): Promise<unknown> {
		const { data, error } = await this.client.rpc("qorpera_list_shared_sessions", input);
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

function parseSession(value: unknown): HostedSession {
	const input = record(value, "session");
	const status = input.status;
	if (status !== "open" && status !== "closed") throw new Error("Hosted primary returned invalid session status");
	const staffAgentId = input.staff_agent_id;
	const parentSessionId = input.parent_session_id;
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
	return {
		sessionId: uuid(input.session_id, "event session id"),
		sequence: sequence as number,
		eventId: uuid(input.event_id, "event id"),
		eventType: sessionEventType(input.event_type),
		actorUserId: uuid(input.actor_user_id, "event actor id"),
		body: jsonValue(input.body),
		...(typeof previousHash === "string" ? { previousHash } : {}),
		eventHash: input.event_hash,
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
	if (typeof input.tree_manifest_sha256 !== "string" || !SHA256_PATTERN.test(input.tree_manifest_sha256)) {
		throw new Error("Hosted primary returned invalid company tree manifest hash");
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
			contractVersion: boundedInteger(input.tree_contract_version, "company tree contract version", 1, 1_000_000),
			fileCount: boundedInteger(input.file_count, "company tree file count", 0, MAX_TREE_FILES),
			totalBytes: boundedInteger(input.total_bytes, "company tree total bytes", 0, MAX_TREE_BYTES),
		},
		createdByUserId: uuid(input.created_by_user_id, "company snapshot creator id"),
		createdAt: timestamp(input.created_at, "company snapshot creation time"),
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
	environmentId: string;
	title: string;
	created: boolean;
	createdByUserId: string;
}

export interface SessionTurnInput {
	inputId: string;
	position: number;
	kind: "kickoff" | "user_message";
	authorUserId: string;
	body: JsonValue;
	createdAt: string;
}

export type SessionTurnClaim =
	| { claimed: true; inputs: SessionTurnInput[] }
	| { claimed: false; reason: "turn-in-flight" | "queue-empty" };

function parseStaffSessionHandle(value: unknown): StaffSessionHandle {
	const payload = record(value, "staff session");
	return {
		sessionId: uuid(payload.session_id, "Session id"),
		environmentId: uuid(payload.environment_id, "Environment id"),
		title: String(payload.title ?? ""),
		created: payload.created === true,
		createdByUserId: uuid(payload.created_by_user_id, "Session creator"),
	};
}

function parseSessionTurnClaim(value: unknown): SessionTurnClaim {
	const payload = record(value, "session turn claim");
	if (payload.claimed !== true) {
		const reason = payload.reason === "turn-in-flight" ? "turn-in-flight" : "queue-empty";
		return { claimed: false, reason };
	}
	const inputs = array(payload.inputs, "session turn inputs").map((entry) => {
		const input = record(entry, "session turn input");
		const kind = input.kind === "kickoff" ? "kickoff" : "user_message";
		return {
			inputId: uuid(input.input_id, "Input id"),
			position: Number(input.position),
			kind: kind as SessionTurnInput["kind"],
			authorUserId: uuid(input.author_user_id, "Input author"),
			body: jsonValue(input.body ?? {}),
			createdAt: timestamp(input.created_at, "Input created at"),
		};
	});
	return { claimed: true, inputs };
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

	async appendSessionInput(sessionId: string, clientInputId: string, body: JsonValue): Promise<void> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(clientInputId, "Client input id");
		await this.transport.appendSessionInput({
			p_session_id: sessionId,
			p_client_input_id: clientInputId,
			p_kind: "user_message",
			p_body: body,
		});
	}

	async claimSessionTurn(sessionId: string, claimantId: string, leaseSeconds = 120): Promise<SessionTurnClaim> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(claimantId, "Claimant id");
		return parseSessionTurnClaim(
			await this.transport.claimSessionTurn({
				p_session_id: sessionId,
				p_claimant_id: claimantId,
				p_lease_seconds: leaseSeconds,
			}),
		);
	}

	async renewSessionTurn(sessionId: string, claimantId: string, leaseSeconds = 120): Promise<void> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(claimantId, "Claimant id");
		await this.transport.renewSessionTurn({
			p_session_id: sessionId,
			p_claimant_id: claimantId,
			p_lease_seconds: leaseSeconds,
		});
	}

	async completeSessionTurn(sessionId: string, claimantId: string): Promise<void> {
		requiredUuid(sessionId, "Session id");
		requiredUuid(claimantId, "Claimant id");
		await this.transport.completeSessionTurn({ p_session_id: sessionId, p_claimant_id: claimantId });
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
		return parseSession(
			await this.transport.createSession({
				p_environment_id: input.environmentId,
				p_client_session_id: input.clientSessionId,
				p_title: requiredText(input.title, "Session title", MAX_SESSION_TITLE_LENGTH),
				p_staff_agent_id: input.staffAgentId
					? requiredText(input.staffAgentId, "Staff agent id", MAX_AGENT_ID_LENGTH)
					: null,
				p_parent_session_id: input.parentSessionId ?? null,
			}),
		);
	}

	async listSessions(environmentId: string): Promise<HostedSession[]> {
		requiredUuid(environmentId, "Environment id");
		return array(await this.transport.listSessions({ p_environment_id: environmentId }), "session list").map(
			parseSession,
		);
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
		return parseEvent(
			await this.transport.appendAccountEvent({
				p_session_id: input.sessionId,
				p_event_id: input.eventId,
				p_event_type: input.eventType,
				p_body: eventBody,
				p_expected_sequence: input.expectedSequence ?? null,
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
