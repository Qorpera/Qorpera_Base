import {
	type HostedPrimaryTransport,
	type HostedSessionEventType,
	QorperaHostedPrimary,
} from "@qorpera/cloud-client/hosted-primary";
import type { JsonValue } from "@qorpera/pi-protocol";
import { describe, expect, it, vi } from "vitest";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const sessionId = "a17381c2-3508-4573-b351-a5394adbd1f4";
const clientSessionId = "5b07e271-c030-422c-a3ef-ad10830c393d";
const eventId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const runId = "e7c5380d-a213-460e-9c6d-35c6da9fa9f0";
const runnerAssignmentId = "46651b43-5769-45a5-bc1c-8fba94a52712";
const memberUserId = "509eb21f-981a-4c39-9f64-5fa1b121f367";
const createdAt = "2026-08-16T12:00:00.000Z";
const eventHash = "a".repeat(64);
const promotionId = "4a9d13d1-89fe-4896-a39e-67fc33db67d1";
const companyCreationId = "4a9d13d1-89fe-4896-a39e-67fc33db67d2";
const staffAgentId = "11111111-1111-4111-8111-111111111111";
const formationId = "11111111-1111-4111-8111-111111111112";
const cofounderSessionId = "11111111-1111-4111-8111-111111111113";
const responsibilityId = "11111111-1111-4111-8111-111111111114";
const projectId = "11111111-1111-4111-8111-111111111115";
const roomId = "11111111-1111-4111-8111-111111111116";
const pathVersionId = "11111111-1111-4111-8111-111111111117";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const clientWorkspaceId = "33333333-3333-4333-8333-333333333333";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const clientSnapshotId = "55555555-5555-4555-8555-555555555555";
const substrateVersionId = "66666666-6666-4666-8666-666666666666";
const clientSubstrateVersionId = "77777777-7777-4777-8777-777777777777";
const artifactId = "88888888-8888-4888-8888-888888888888";
const clientArtifactId = "99999999-9999-4999-8999-999999999999";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const clientArtifactIndexId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const artifactHoldId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const clientArtifactHoldId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const objectGraphId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const objectProofId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const artifactGcPlanId = "12121212-1212-4121-8121-121212121212";
const clientArtifactGcPlanId = "13131313-1313-4131-8131-131313131313";
const treeManifestSha256 = "b".repeat(64);
const substrateContentSha256 = "c".repeat(64);
const artifactContentSha256 = "d".repeat(64);
const artifactIndexContentSha256 = "e".repeat(64);

function profileRecord() {
	return {
		profile_id: profileId,
		environment_id: environmentId,
		profile_name: "Qorpera",
		environment_name: "Qorpera Company",
		role: "owner",
		contract_version: 1,
		created_at: createdAt,
	};
}

function sessionRecord() {
	return {
		session_id: sessionId,
		client_session_id: clientSessionId,
		profile_id: profileId,
		environment_id: environmentId,
		title: "Financial Officer",
		staff_agent_id: "financial-officer",
		parent_session_id: null,
		company_snapshot_id: snapshotId,
		staff_version: 3,
		audience_kind: "company",
		audience_user_id: null,
		status: "open",
		created_by_user_id: actorUserId,
		created_at: createdAt,
		updated_at: createdAt,
	};
}

function eventRecord(eventType: HostedSessionEventType = "message") {
	return {
		session_id: sessionId,
		sequence: 1,
		event_id: eventId,
		event_type: eventType,
		actor_user_id: actorUserId,
		body: { text: "What is our runway?" },
		previous_hash: null,
		event_hash: eventHash,
		created_at: createdAt,
	};
}

function memberRecord() {
	return {
		user_id: memberUserId,
		email: "friend@example.com",
		display_name: "Friend",
		avatar_url: null,
		role: "contributor",
		joined_at: createdAt,
	};
}

function invitationDeliveryRecord(status = "pending") {
	return {
		status,
		attempt_count: status === "pending" ? 0 : 1,
		next_attempt_at: createdAt,
		provider_message_id: status === "delivered" ? "provider-message" : null,
		last_error: null,
		sent_at: status === "delivered" ? createdAt : null,
	};
}

function staffRecord() {
	return {
		profile_id: profileId,
		staff_agent_id: staffAgentId,
		display_name: "Financial Officer",
		role: "Finance lead",
		charter: "Maintain the verified financial baseline.",
		template_id: "financial-officer",
		department_id: null,
		appearance_color: "green",
		appearance_shape: "gem",
		appearance_creature: null,
		model_provider: null,
		model_id: null,
		employment_status: "active",
		lifecycle_state: "active",
		version: 1,
		created_at: createdAt,
		updated_at: createdAt,
		updated_by_user_id: actorUserId,
	};
}

function companyOrganizationRecord() {
	return {
		schema: "qorpera.company-organization/v1",
		profile_id: profileId,
		cofounder: {
			staff_agent_id: staffAgentId,
			formation_id: formationId,
			member_session_id: cofounderSessionId,
		},
		formation: {
			formation_id: formationId,
			state: "source_inventory",
			status: "active",
			revision: 1,
			projection_status: "verified",
			source_path: "organization/formation.json",
			source_path_version: pathVersionId,
			source_snapshot_id: snapshotId,
			source_file_sha256: treeManifestSha256,
		},
		responsibilities: [
			{
				responsibility_id: responsibilityId,
				slug: "engineering",
				name: "Engineering",
				status: "active",
				accountable_staff_agent_id: staffAgentId,
				accountable_user_id: actorUserId,
				attention_cadence: "weekly",
				measures: [
					{
						measure_id: "11111111-1111-4111-8111-111111111119",
						key: "release-cadence",
						label: "Release cadence",
						status: "active",
						sources: [
							{
								path: "engineering/releases.json",
								path_match: "exact",
								source_path_version: pathVersionId,
								source_snapshot_id: snapshotId,
								source_file_sha256: treeManifestSha256,
							},
						],
					},
				],
				version: 1,
				source_path: "organization/responsibilities/engineering.json",
				source_path_version: pathVersionId,
				source_snapshot_id: snapshotId,
				source_file_sha256: treeManifestSha256,
			},
		],
		projects: [
			{
				project_id: projectId,
				key: "launch",
				name: "Launch",
				status: "active",
				sponsoring_responsibility_id: responsibilityId,
				lead_staff_agent_id: staffAgentId,
				room_id: roomId,
				staff: [{ staff_agent_id: staffAgentId, role: "Lead", status: "active" }],
				version: 1,
				source_path: "organization/projects/launch.json",
				source_path_version: pathVersionId,
				source_snapshot_id: snapshotId,
				source_file_sha256: treeManifestSha256,
			},
		],
	};
}

function workspaceRecord(headSnapshotId: string | null = null) {
	return {
		workspace_id: workspaceId,
		profile_id: profileId,
		environment_id: environmentId,
		client_workspace_id: clientWorkspaceId,
		name: "Jonas MacBook",
		head_snapshot_id: headSnapshotId,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		updated_at: createdAt,
	};
}

function snapshotRecord() {
	return {
		snapshot_id: snapshotId,
		profile_id: profileId,
		environment_id: environmentId,
		workspace_id: workspaceId,
		client_snapshot_id: clientSnapshotId,
		parent_snapshot_id: null,
		tree_manifest_sha256: treeManifestSha256,
		tree_manifest_bytes: 1024,
		tree_contract_version: 1,
		file_count: 3,
		total_bytes: 4096,
		created_by_user_id: actorUserId,
		created_at: createdAt,
	};
}

function companyFileRecord(headSnapshotId: string | null = snapshotId) {
	return {
		profile_id: profileId,
		environment_id: environmentId,
		canonical_workspace_id: workspaceId,
		head_snapshot_id: headSnapshotId,
		state: headSnapshotId ? "ready" : "provisioning",
		logical_bytes: headSnapshotId ? 4096 : 0,
		retained_storage_bytes: headSnapshotId ? 1024 : 0,
		storage_used_bytes: 5120,
		storage_limit_bytes: 50 * 1024 * 1024 * 1024,
		object_backends: ["nas-object-gateway"],
		entitlement: accountEntitlementRecord(),
		created_at: createdAt,
		updated_at: createdAt,
	};
}

function accountEntitlementRecord() {
	return {
		plan_key: "freemium",
		billing_mode: "free",
		feature_set: "standard",
		storage_allocation: "metered",
		storage_allocation_bytes: 50 * 1024 * 1024 * 1024,
		source: "default",
		updated_at: null,
	};
}

function substrateVersionRecord() {
	return {
		version_id: substrateVersionId,
		profile_id: profileId,
		environment_id: environmentId,
		company_snapshot_id: snapshotId,
		client_version_id: clientSubstrateVersionId,
		contract_version: 1,
		operation_sequence: 2,
		operation_count: 2,
		artifact_index_id: artifactIndexId,
		artifact_manifest_sha256: artifactIndexContentSha256,
		content_sha256: substrateContentSha256,
		created_by_user_id: actorUserId,
		created_at: createdAt,
	};
}

function artifactRecord() {
	return {
		artifact_id: artifactId,
		profile_id: profileId,
		environment_id: environmentId,
		client_artifact_id: clientArtifactId,
		session_id: sessionId,
		artifact_type: "report",
		name: "90-day financial snapshot",
		root_object_sha256: treeManifestSha256,
		root_contract: "qorpera.cloud-file-manifest/v1",
		content_sha256: artifactContentSha256,
		bytes: 4096,
		media_type: "application/pdf",
		created_by_user_id: actorUserId,
		created_at: createdAt,
		eligible_for_gc_at: "2026-09-15T12:00:00.000Z",
	};
}

function objectGraphRecord(status: "uploading" | "complete" = "complete") {
	return {
		graph_id: objectGraphId,
		profile_id: profileId,
		environment_id: environmentId,
		root_kind: "artifact",
		root_id: artifactId,
		client_graph_id: artifactId,
		root_object_sha256: treeManifestSha256,
		contract_version: 1,
		content_sha256: artifactIndexContentSha256,
		object_count: 2,
		storage_bytes: 5120,
		status,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		completed_at: status === "complete" ? createdAt : null,
	};
}

function objectProofRecord() {
	return {
		proof_id: objectProofId,
		graph_id: objectGraphId,
		profile_id: profileId,
		client_proof_id: artifactId,
		restored_content_sha256: artifactContentSha256,
		restored_bytes: 4096,
		verified_by_user_id: actorUserId,
		verified_at: createdAt,
		valid_until: "2026-08-23T12:00:00.000Z",
	};
}

function artifactGcPlanRecord(status = "waiting") {
	return {
		plan_id: artifactGcPlanId,
		profile_id: profileId,
		artifact_id: artifactId,
		graph_id: objectGraphId,
		restore_proof_id: objectProofId,
		client_plan_id: clientArtifactGcPlanId,
		status,
		object_count: 2,
		storage_bytes: 5120,
		not_before: "2026-08-17T12:00:00.000Z",
		next_attempt_at: "2026-08-17T12:00:00.000Z",
		attempt_count: 0,
		last_error: null,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		started_at: null,
		completed_at: status === "completed" ? "2026-08-17T12:00:00.000Z" : null,
		cancelled_by_user_id: status === "cancelled" ? actorUserId : null,
		cancelled_at: status === "cancelled" ? "2026-08-16T13:00:00.000Z" : null,
		pending_object_count: status === "completed" ? 0 : 2,
		deleted_object_count: status === "completed" ? 2 : 0,
		retained_object_count: 0,
	};
}

function artifactIndexRecord() {
	return {
		index_id: artifactIndexId,
		profile_id: profileId,
		environment_id: environmentId,
		client_index_id: clientArtifactIndexId,
		contract_version: 1,
		content_sha256: artifactIndexContentSha256,
		artifact_count: 1,
		total_bytes: 4096,
		created_by_user_id: actorUserId,
		created_at: createdAt,
	};
}

function artifactHoldRecord(released = false) {
	return {
		hold_id: artifactHoldId,
		profile_id: profileId,
		artifact_id: artifactId,
		client_hold_id: clientArtifactHoldId,
		reason: "Financial evidence",
		expires_at: null,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		released_by_user_id: released ? actorUserId : null,
		released_at: released ? "2026-08-17T12:00:00.000Z" : null,
	};
}

function companyOperationRecord() {
	return {
		profile_id: profileId,
		sequence: 2,
		environment_id: environmentId,
		operation_type: "session_event",
		entity_id: sessionId,
		entity_version: 1,
		content_sha256: eventHash,
		payload: { session_id: sessionId, sequence: 1, event_hash: eventHash },
		actor_user_id: actorUserId,
		created_at: createdAt,
	};
}

function companyProposalRecord(status: "open" | "accepted" | "rejected" = "open") {
	return {
		proposal_id: objectGraphId,
		profile_id: profileId,
		environment_id: environmentId,
		client_proposal_id: clientArtifactId,
		base_snapshot_id: snapshotId,
		proposal_snapshot: {
			...snapshotRecord(),
			snapshot_id: artifactId,
			parent_snapshot_id: snapshotId,
			tree_contract_version: 3,
			publication_state: "prepared",
		},
		execution_kind: "turn",
		execution_id: eventId,
		execution_claimant_id: objectProofId,
		session_id: sessionId,
		trail_end_sequence: 4,
		reason: "policy",
		policy_key: "directional-research",
		title: "Review directional research",
		reviewer_staff_ids: [artifactIndexId],
		review_revision: 1,
		reviews: [
			{
				assignment_id: objectProofId,
				proposal_revision: 1,
				reviewer_staff_agent_id: artifactIndexId,
				reviewer_name: "Legal reviewer",
				status: "approved",
				run_id: eventId,
				comment_id: artifactGcPlanId,
				failure_reason: null,
				created_at: createdAt,
				started_at: createdAt,
				completed_at: createdAt,
			},
		],
		status,
		created_by_user_id: actorUserId,
		created_by_name: "Jonas",
		created_at: createdAt,
		resolved_by_user_id: status === "open" ? null : actorUserId,
		resolved_at: status === "open" ? null : createdAt,
	};
}

function companyProposalCommentRecord() {
	return {
		comment_id: artifactGcPlanId,
		proposal_id: objectGraphId,
		body: "Verify the volume assumptions.",
		author_user_id: actorUserId,
		author_name: "Jonas",
		created_at: createdAt,
	};
}

function transport(overrides: Partial<HostedPrimaryTransport> = {}): HostedPrimaryTransport {
	return {
		createCompany: vi.fn(async () => ({
			...profileRecord(),
			company_file: companyFileRecord(),
			bootstrap_state: "completed",
			organization: {
				schema: "qorpera.company-organization-bootstrap/v1",
				cofounder: {
					staff_agent_id: staffAgentId,
					formation_id: formationId,
					member_session_id: cofounderSessionId,
				},
				formation_state: "source_inventory",
			},
		})),
		getCompanyOrganizationBootstrap: vi.fn(async () => ({
			schema: "qorpera.company-organization-bootstrap/v1",
			cofounder: {
				staff_agent_id: staffAgentId,
				formation_id: formationId,
				member_session_id: cofounderSessionId,
			},
			formation_state: "source_inventory",
		})),
		getCompanyOrganization: vi.fn(async () => companyOrganizationRecord()),
		createProfile: vi.fn(async () => profileRecord()),
		promoteProfile: vi.fn(async () => profileRecord()),
		listProfiles: vi.fn(async () => [profileRecord()]),
		getAccountEntitlement: vi.fn(async () => accountEntitlementRecord()),
		inviteMember: vi.fn(async (input) => ({
			id: eventId,
			profile_id: input.p_profile_id,
			email: input.p_email,
			role: input.p_role,
			invited_by_user_id: actorUserId,
			created_at: createdAt,
			expires_at: "2026-08-30T12:00:00.000Z",
			delivery: invitationDeliveryRecord(),
		})),
		listInvitations: vi.fn(async () => [
			{
				id: eventId,
				profile_id: profileId,
				environment_id: environmentId,
				profile_name: "Qorpera",
				environment_name: "Qorpera Company",
				email: "friend@example.com",
				role: "contributor",
				invited_by_user_id: actorUserId,
				created_at: createdAt,
				expires_at: "2026-08-30T12:00:00.000Z",
				delivery: invitationDeliveryRecord("delivered"),
			},
		]),
		acceptInvitation: vi.fn(async () => true),
		declineInvitation: vi.fn(async () => true),
		sendFriendRequest: vi.fn(async () => ({ status: "pending" })),
		listFriends: vi.fn(async () => []),
		respondFriendRequest: vi.fn(async () => true),
		removeFriend: vi.fn(async () => true),
		profileTeam: vi.fn(async () => ({
			profile_id: profileId,
			role: "owner",
			capabilities: { read: true, write: true, authorize: true, manage_members: true },
			members: [memberRecord()],
			invitations: [],
		})),
		cancelInvitation: vi.fn(async () => true),
		retryInvitationDelivery: vi.fn(async () => invitationDeliveryRecord()),
		updateMemberRole: vi.fn(async (input) => ({ ...memberRecord(), role: input.p_role })),
		removeMember: vi.fn(async () => true),
		listStaff: vi.fn(async () => [staffRecord()]),
		deleteStaff: vi.fn(async () => true),
		leaveProfile: vi.fn(async () => true),
		deleteProfile: vi.fn(async () => true),
		ensureStaffSession: vi.fn(async () => sessionRecord()),
		appendSessionInput: vi.fn(async () => ({ input_id: eventId, position: 1 })),
		listSessionInputs: vi.fn(async () => ({ items: [], next_after_position: 0, has_more: false })),
		listSessionRecoveries: vi.fn(async () => ({
			items: [],
			has_more: false,
			next_completed_at: null,
			next_id: null,
		})),
		listSessionExecutionRunRecoveries: vi.fn(async () => []),
		listStaffExecutionActivity: vi.fn(async () => []),
		resolveFailedExecutionRun: vi.fn(async (input) => ({
			resolved: true,
			run_id: input.p_run_id,
			action: input.p_action,
		})),
		resolveSessionRecovery: vi.fn(async (input) => ({
			resolved: true,
			resolution: input.p_resolution,
			input_count: 1,
		})),
		getSessionTurnStatus: vi.fn(async () => ({ status: "completed", input_count: 0, remaining_input_count: 0 })),
		claimSessionTurn: vi.fn(async () => ({ claimed: false, reason: "queue-empty" })),
		renewSessionTurn: vi.fn(async () => ({ renewed: 0 })),
		completeSessionTurn: vi.fn(async () => ({ completed: 0 })),
		quarantineSessionTurn: vi.fn(async () => ({ quarantined: 1 })),
		claimWake: vi.fn(async () => ({ claimed: true })),
		renewWake: vi.fn(async () => ({ renewed: 1 })),
		completeWake: vi.fn(async () => ({ completed: 1 })),
		beginOperationReceipt: vi.fn(async () => ({ started: true, status: "executing", result: null })),
		stageOperationReceiptObjects: vi.fn(async (input) => ({ staged: (input.p_objects as JsonValue[]).length })),
		completeOperationReceipt: vi.fn(async (input) => input.p_result),
		resolveOperationReceipt: vi.fn(async (input) => ({
			operation_id: input.p_operation_id,
			status: input.p_resolution === "confirmed_completed" ? "completed" : "cancelled",
			resolution: input.p_resolution,
			result: input.p_result,
		})),
		resolveRunOperationReceipt: vi.fn(async (input) => ({
			receipt_id: input.p_receipt_id,
			status: input.p_resolution === "confirmed_completed" ? "completed" : "cancelled",
			recovery_resolution: input.p_resolution,
		})),
		registerPresenceDevice: vi.fn(async (input) => ({
			client_id: input.p_client_id,
			user_id: actorUserId,
			name: "Jonas",
		})),
		listPresenceDevices: vi.fn(async () => []),
		unregisterPresenceDevice: vi.fn(async () => null),
		putStaff: vi.fn(async () => staffRecord()),
		createSession: vi.fn(async (input) => ({ ...sessionRecord(), execution_scope: input.p_execution_scope })),
		closeSession: vi.fn(async () => true),
		listSessions: vi.fn(async () => [sessionRecord()]),
		listSessionsPage: vi.fn(async () => ({
			items: [sessionRecord()],
			has_more: false,
			next_updated_at: createdAt,
			next_id: sessionId,
		})),
		getSessionByClient: vi.fn(async () => sessionRecord()),
		appendAccountEvent: vi.fn(async (input) => eventRecord(input.p_event_type)),
		readSessionEvents: vi.fn(async () => [eventRecord()]),
		getCompanyFile: vi.fn(async () => companyFileRecord()),
		prepareCompanyFileRevision: vi.fn(async () => ({ ...snapshotRecord(), tree_contract_version: 3 })),
		prepareCompanyFileProposal: vi.fn(async () => companyProposalRecord().proposal_snapshot),
		publishCompanyFileRevision: vi.fn(async () => ({ ...snapshotRecord(), tree_contract_version: 3 })),
		submitCompanyProposal: vi.fn(async () => companyProposalRecord()),
		listCompanyProposals: vi.fn(async () => ({
			items: [companyProposalRecord()],
			has_more: false,
			next_created_at: createdAt,
			next_id: objectGraphId,
		})),
		rebaseCompanyProposal: vi.fn(async () => companyProposalRecord()),
		acceptCompanyProposal: vi.fn(async () => companyProposalRecord("accepted")),
		retryCompanyProposalReview: vi.fn(async (input) => ({
			assignment_id: input.p_assignment_id,
			proposal_id: objectGraphId,
			proposal_revision: 1,
			status: "queued",
		})),
		rejectCompanyProposal: vi.fn(async () => companyProposalRecord("rejected")),
		getCompanyProposal: vi.fn(async () => companyProposalRecord()),
		appendCompanyProposalComment: vi.fn(async () => companyProposalCommentRecord()),
		listCompanyProposalComments: vi.fn(async () => ({
			items: [companyProposalCommentRecord()],
			has_more: false,
			next_created_at: createdAt,
			next_id: artifactGcPlanId,
		})),
		ensureCompanyWorkspace: vi.fn(async () => workspaceRecord()),
		commitCompanySnapshot: vi.fn(async () => snapshotRecord()),
		getCompanySnapshot: vi.fn(async () => snapshotRecord()),
		listCompanyWorkspaces: vi.fn(async () => [workspaceRecord(snapshotId)]),
		listCompanySnapshots: vi.fn(async () => [snapshotRecord()]),
		registerArtifact: vi.fn(async () => artifactRecord()),
		createArtifactIndex: vi.fn(async () => artifactIndexRecord()),
		getArtifactIndex: vi.fn(async () => artifactIndexRecord()),
		listArtifactIndexEntries: vi.fn(async () => [{ ...artifactRecord(), ordinal: 1 }]),
		createArtifactRetentionHold: vi.fn(async () => artifactHoldRecord()),
		releaseArtifactRetentionHold: vi.fn(async () => artifactHoldRecord(true)),
		listArtifactGcCandidates: vi.fn(async () => [
			{
				...artifactRecord(),
				reachability_graph_id: objectGraphId,
				reachability_ready: true,
				deletable_object_count: 2,
				deletable_storage_bytes: 5120,
				object_deletion_ready: true,
				blocked_reason: null,
			},
		]),
		createArtifactGcPlan: vi.fn(async () => artifactGcPlanRecord()),
		listArtifactGcPlans: vi.fn(async () => [artifactGcPlanRecord()]),
		listArtifactGcAudit: vi.fn(async () => [
			{
				receipt_id: 1,
				plan_id: artifactGcPlanId,
				event_type: "created",
				payload: { object_count: 2 },
				actor_user_id: actorUserId,
				created_at: createdAt,
			},
		]),
		cancelArtifactGcPlan: vi.fn(async () => artifactGcPlanRecord("cancelled")),
		retryArtifactGcPlan: vi.fn(async () => artifactGcPlanRecord("retrying")),
		beginObjectReachabilityGraph: vi.fn(async () => objectGraphRecord("uploading")),
		appendObjectReachabilityEntries: vi.fn(async () => 2),
		completeObjectReachabilityGraph: vi.fn(async () => objectGraphRecord()),
		getObjectReachabilityGraph: vi.fn(async () => objectGraphRecord()),
		verifyCompanySnapshotClosure: vi.fn(async () => ({ verified: true })),
		createObjectRestoreProof: vi.fn(async () => objectProofRecord()),
		captureCompanySubstrateVersion: vi.fn(async () => substrateVersionRecord()),
		getCompanySubstrateVersion: vi.fn(async () => substrateVersionRecord()),
		listCompanySubstrateOperations: vi.fn(async () => [companyOperationRecord()]),
		...overrides,
	};
}

describe("Qorpera hosted primary", () => {
	it("creates one idempotent cloud company with its freemium Company File", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.createCompany({
				clientCreationId: companyCreationId,
				companyName: " Qorpera ",
				contractVersion: 2,
			}),
		).resolves.toEqual({
			profile: {
				profileType: "cloud",
				profileId,
				environmentId,
				profileName: "Qorpera",
				environmentName: "Qorpera Company",
				role: "owner",
				contractVersion: 1,
				createdAt,
			},
			companyFile: {
				profileId,
				environmentId,
				canonicalWorkspaceId: workspaceId,
				headSnapshotId: snapshotId,
				state: "ready",
				logicalBytes: 4096,
				retainedStorageBytes: 1024,
				storageUsedBytes: 5120,
				storageLimitBytes: 50 * 1024 * 1024 * 1024,
				objectBackends: ["nas-object-gateway"],
				entitlement: {
					planKey: "freemium",
					billingMode: "free",
					featureSet: "standard",
					storageAllocation: "metered",
					storageAllocationBytes: 50 * 1024 * 1024 * 1024,
					source: "default",
				},
				createdAt,
				updatedAt: createdAt,
			},
			organization: {
				schema: "qorpera.company-organization-bootstrap/v1",
				cofounder: { staffAgentId, formationId, memberSessionId: cofounderSessionId },
				formationState: "source_inventory",
			},
		});
		await expect(primary.getCompanyOrganizationBootstrap(profileId)).resolves.toEqual({
			schema: "qorpera.company-organization-bootstrap/v1",
			cofounder: { staffAgentId, formationId, memberSessionId: cofounderSessionId },
			formationState: "source_inventory",
		});
		await expect(primary.getCompanyOrganization(profileId)).resolves.toMatchObject({
			schema: "qorpera.company-organization/v1",
			profileId,
			cofounder: { staffAgentId, formationId, memberSessionId: cofounderSessionId },
			formation: { formationId, state: "source_inventory", status: "active", revision: 1 },
			responsibilities: [{ responsibilityId, name: "Engineering", accountableStaffAgentId: staffAgentId }],
			projects: [{ projectId, name: "Launch", sponsoringResponsibilityId: responsibilityId, roomId }],
		});
		const malformed = new QorperaHostedPrimary(
			transport({
				getCompanyOrganizationBootstrap: vi.fn(async () => ({
					schema: "qorpera.company-organization-bootstrap/v1",
					cofounder: {
						staff_agent_id: staffAgentId,
						formation_id: formationId,
						member_session_id: cofounderSessionId,
					},
					formation_state: "source_inventory",
					unexpected: true,
				})),
			}),
		);
		await expect(malformed.getCompanyOrganizationBootstrap(profileId)).rejects.toThrow(
			"invalid company organization bootstrap",
		);
		expect(fake.createCompany).toHaveBeenCalledWith({
			p_client_creation_id: companyCreationId,
			p_company_name: "Qorpera",
			p_contract_version: 2,
		});
	});

	it("creates and projects a stable hosted profile and environment identity", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.createProfile({ profileName: " Qorpera ", environmentName: " Qorpera Company ", contractVersion: 1 }),
		).resolves.toEqual({
			profileType: "cloud",
			profileId,
			environmentId,
			profileName: "Qorpera",
			environmentName: "Qorpera Company",
			role: "owner",
			contractVersion: 1,
			createdAt,
		});
		expect(fake.createProfile).toHaveBeenCalledWith({
			p_profile_name: "Qorpera",
			p_environment_name: "Qorpera Company",
			p_contract_version: 1,
		});
		await expect(primary.listProfiles()).resolves.toHaveLength(1);
		await expect(primary.getAccountEntitlement()).resolves.toEqual({
			planKey: "freemium",
			billingMode: "free",
			featureSet: "standard",
			storageAllocation: "metered",
			storageAllocationBytes: 50 * 1024 * 1024 * 1024,
			source: "default",
		});
	});

	it("uses a stable promotion identity for resumable local-to-cloud creation", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.createProfile({
				profileName: "Qorpera",
				environmentName: "Qorpera Company",
				contractVersion: 1,
				promotionId,
			}),
		).resolves.toMatchObject({ profileId, environmentId });
		expect(fake.promoteProfile).toHaveBeenCalledWith({
			p_promotion_id: promotionId,
			p_profile_name: "Qorpera",
			p_environment_name: "Qorpera Company",
			p_contract_version: 1,
		});
		expect(fake.createProfile).not.toHaveBeenCalled();
	});

	it("normalizes invitations and never permits owner invitations", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(primary.inviteMember(profileId, " Friend@Example.com ", "contributor")).resolves.toMatchObject({
			profileId,
			email: "friend@example.com",
			role: "contributor",
		});
		expect(fake.inviteMember).toHaveBeenCalledWith({
			p_profile_id: profileId,
			p_email: "friend@example.com",
			p_role: "contributor",
		});
		await expect(primary.listInvitations()).resolves.toEqual([
			expect.objectContaining({
				id: eventId,
				profileId,
				environmentId,
				profileName: "Qorpera",
				role: "contributor",
			}),
		]);
		await expect(primary.acceptInvitation(eventId)).resolves.toBeUndefined();
		await expect(primary.declineInvitation(eventId)).resolves.toBeUndefined();
		await expect(primary.inviteMember(profileId, "friend@example.com", "owner" as "contributor")).rejects.toThrow(
			"role",
		);
	});

	it("projects team capabilities and validates member-management requests", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(primary.profileTeam(profileId)).resolves.toMatchObject({
			profileType: "cloud",
			profileId,
			role: "owner",
			capabilities: { read: true, write: true, authorize: true, manageMembers: true },
			members: [{ userId: memberUserId, role: "contributor" }],
		});
		await expect(primary.updateMemberRole(profileId, memberUserId, "viewer")).resolves.toMatchObject({
			userId: memberUserId,
			role: "viewer",
		});
		expect(fake.updateMemberRole).toHaveBeenCalledWith({
			p_profile_id: profileId,
			p_member_user_id: memberUserId,
			p_role: "viewer",
		});
		await expect(primary.cancelInvitation(profileId, eventId)).resolves.toBeUndefined();
		await expect(primary.retryInvitationDelivery(profileId, eventId)).resolves.toMatchObject({
			status: "pending",
			attemptCount: 0,
		});
		await expect(primary.removeMember(profileId, memberUserId)).resolves.toBeUndefined();

		const malformed = new QorperaHostedPrimary(
			transport({
				profileTeam: vi.fn(async () => ({
					profile_id: profileId,
					role: "viewer",
					capabilities: { read: true, write: true, authorize: false, manage_members: false },
					members: [],
					invitations: [],
				})),
			}),
		);
		await expect(malformed.profileTeam(profileId)).rejects.toThrow("inconsistent");
	});

	it("keeps worktree identity separate from the shared session identity", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.createSession({
				environmentId,
				clientSessionId,
				title: "Financial Officer",
				staffAgentId: "financial-officer",
				executionScope: {
					attended: false,
					autonomousLabel: "Daily finance close",
				},
			}),
		).resolves.toEqual({
			sessionId,
			clientSessionId,
			profileId,
			environmentId,
			title: "Financial Officer",
			staffAgentId: "financial-officer",
			executionScope: { attended: false, autonomousLabel: "Daily finance close" },
			companySnapshotId: snapshotId,
			staffVersion: 3,
			audience: { kind: "company" },
			status: "open",
			createdByUserId: actorUserId,
			createdAt,
			updatedAt: createdAt,
		});
		expect(fake.createSession).toHaveBeenCalledWith({
			p_environment_id: environmentId,
			p_client_session_id: clientSessionId,
			p_title: "Financial Officer",
			p_staff_agent_id: "financial-officer",
			p_parent_session_id: null,
			p_execution_scope: { attended: false, autonomousLabel: "Daily finance close" },
			p_company_snapshot_id: null,
			p_staff_version: null,
		});

		const privatePrimary = new QorperaHostedPrimary(
			transport({
				listSessions: vi.fn(async () => [
					{ ...sessionRecord(), audience_kind: "member_private", audience_user_id: actorUserId },
				]),
			}),
		);
		await expect(privatePrimary.listSessions(environmentId)).resolves.toEqual([
			expect.objectContaining({ audience: { kind: "member_private", userId: actorUserId } }),
		]);
		const malformedAudience = new QorperaHostedPrimary(
			transport({ listSessions: vi.fn(async () => [{ ...sessionRecord(), audience_user_id: actorUserId }]) }),
		);
		await expect(malformedAudience.listSessions(environmentId)).rejects.toThrow("invalid session audience");
	});

	it("parses durable session queues, revision pins, and ownership loss", async () => {
		const input = {
			input_id: eventId,
			position: 1,
			kind: "user_message",
			author_user_id: actorUserId,
			author_display_name: "Jonas",
			body: { schema: "qorpera.session-prompt/v1", text: "Review this", images: [] },
			created_at: createdAt,
			status: "processing",
		};
		const listSessionInputs = vi.fn(async (request: { p_after_position: number }) =>
			request.p_after_position === 0
				? { items: [input], next_after_position: 1, has_more: true }
				: { items: [{ ...input, position: 2 }], next_after_position: 2, has_more: false },
		);
		const fake = transport({
			listSessionInputs,
			listSessionRecoveries: vi.fn(async () => ({
				items: [
					{
						turn_id: objectGraphId,
						company_snapshot_id: snapshotId,
						staff_version: 3,
						trail_start_sequence: 1,
						trail_end_sequence: 2,
						failure_reason: "executor lease expired",
						claimed_at: createdAt,
						failed_at: createdAt,
						operation_receipts: [
							{
								operation_id: objectProofId,
								operation_kind: "http_request",
								status: "ambiguous",
								created_at: createdAt,
							},
						],
						inputs: [input],
					},
				],
				has_more: false,
				next_completed_at: createdAt,
				next_id: objectGraphId,
			})),
			listSessionExecutionRunRecoveries: vi.fn(async () => [
				{
					run: { run_id: runId, session_id: sessionId, source_kind: "session_turn" },
					job: { status: "failed", last_error: "runner lease expired", finished_at: createdAt },
					proposal_id: null,
					inputs: [input],
					operations: [
						{
							operation_id: objectProofId,
							operation_kind: "http_request",
							status: "ambiguous",
							recovery_resolution: null,
							created_at: createdAt,
						},
					],
				},
			]),
			listStaffExecutionActivity: vi.fn(async () => [
				{
					run_id: runId,
					staff_agent_id: artifactIndexId,
					source_kind: "session_turn",
					job_status: "leased",
					activity: "working",
					updated_at: createdAt,
				},
			]),
			claimSessionTurn: vi.fn(async () => ({
				claimed: true,
				turn_id: objectGraphId,
				company_snapshot_id: snapshotId,
				staff_version: 3,
				inputs: [input],
			})),
			renewSessionTurn: vi.fn(async () => ({ renewed: 0 })),
			completeSessionTurn: vi.fn(async () => ({ completed: 0 })),
		});
		const primary = new QorperaHostedPrimary(fake);
		await expect(primary.listSessionInputs(sessionId)).resolves.toMatchObject([
			{ inputId: eventId, authorDisplayName: "Jonas", status: "processing" },
			{ inputId: eventId, authorDisplayName: "Jonas", status: "processing", position: 2 },
		]);
		expect(listSessionInputs).toHaveBeenNthCalledWith(2, {
			p_session_id: sessionId,
			p_after_position: 1,
			p_limit: 100,
		});
		await expect(primary.claimSessionTurn(sessionId, eventId, snapshotId, 3)).resolves.toMatchObject({
			claimed: true,
			companySnapshotId: snapshotId,
			staffVersion: 3,
		});
		expect(fake.claimSessionTurn).toHaveBeenCalledWith({
			p_session_id: sessionId,
			p_claimant_id: eventId,
			p_lease_seconds: 120,
			p_company_snapshot_id: snapshotId,
			p_staff_version: 3,
		});
		await expect(primary.renewSessionTurn(sessionId, objectGraphId, eventId)).rejects.toThrow("ownership was lost");
		await expect(primary.completeSessionTurn(sessionId, objectGraphId, eventId, 0)).rejects.toThrow(
			"ownership was lost",
		);
		await expect(primary.listSessionRecoveries(sessionId)).resolves.toMatchObject({
			items: [
				{
					turnId: objectGraphId,
					failureReason: "executor lease expired",
					operationReceipts: [{ operationId: objectProofId, status: "ambiguous" }],
					inputs: [{ inputId: eventId, authorDisplayName: "Jonas" }],
				},
			],
		});
		await expect(primary.listSessionExecutionRunRecoveries(sessionId)).resolves.toMatchObject([
			{
				runId,
				sessionId,
				failureReason: "runner lease expired",
				inputs: [{ inputId: eventId }],
				operationReceipts: [{ operationId: objectProofId, status: "ambiguous" }],
			},
		]);
		await expect(primary.listStaffExecutionActivity(environmentId)).resolves.toEqual([
			{
				runId,
				staffAgentId: artifactIndexId,
				sourceKind: "session_turn",
				jobStatus: "leased",
				activity: "working",
				updatedAt: createdAt,
			},
		]);
		await expect(primary.resolveFailedExecutionRun(runId, "discard")).resolves.toBeUndefined();
		await expect(primary.resolveSessionRecovery(sessionId, objectGraphId, "discard")).resolves.toEqual({
			resolution: "discard",
			inputCount: 1,
		});
		await expect(primary.resolveOperationReceipt(objectProofId, "confirmed_not_run")).resolves.toEqual({
			status: "cancelled",
			resolution: "confirmed_not_run",
		});
		expect(fake.resolveOperationReceipt).toHaveBeenCalledWith({
			p_operation_id: objectProofId,
			p_resolution: "confirmed_not_run",
			p_result: null,
		});
		await expect(primary.resolveRunOperationReceipt(objectProofId, "confirmed_not_run")).resolves.toEqual({
			status: "cancelled",
			recoveryResolution: "confirmed_not_run",
		});
		expect(fake.resolveSessionRecovery).toHaveBeenCalledWith({
			p_session_id: sessionId,
			p_turn_id: objectGraphId,
			p_resolution: "discard",
		});
	});

	it("rejects wake renewal and completion after cloud ownership is lost", async () => {
		const primary = new QorperaHostedPrimary(
			transport({
				renewWake: vi.fn(async () => ({ renewed: 0 })),
				completeWake: vi.fn(async () => ({ completed: 0 })),
			}),
		);
		await expect(primary.renewWake(environmentId, "job:demo:slot:1", eventId)).rejects.toThrow(
			"Wake ownership was lost before renew",
		);
		await expect(primary.completeWake(environmentId, "job:demo:slot:1", eventId)).rejects.toThrow(
			"Wake ownership was lost before complete",
		);
	});

	it("lists, writes, and deletes authoritative staff with optimistic versions", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		const [staff] = await primary.listStaff(profileId);
		expect(staff).toMatchObject({
			profileId,
			id: staffAgentId,
			displayName: "Financial Officer",
			version: 1,
		});
		await expect(primary.putStaff(profileId, staff!, 1)).resolves.toMatchObject({ id: staffAgentId, version: 1 });
		expect(fake.putStaff).toHaveBeenCalledWith({
			p_profile_id: profileId,
			p_staff_agent_id: staffAgentId,
			p_display_name: "Financial Officer",
			p_role: "Finance lead",
			p_charter: "Maintain the verified financial baseline.",
			p_template_id: "financial-officer",
			p_department_id: null,
			p_appearance_color: "green",
			p_appearance_shape: "gem",
			p_appearance_creature: null,
			p_model_provider: null,
			p_model_id: null,
			p_employment_status: "active",
			p_lifecycle_state: "active",
			p_created_at: createdAt,
			p_expected_version: 1,
		});
		await expect(primary.deleteStaff(profileId, staffAgentId, 1)).resolves.toBeUndefined();
		expect(fake.deleteStaff).toHaveBeenCalledWith({
			p_profile_id: profileId,
			p_staff_agent_id: staffAgentId,
			p_expected_version: 1,
		});
	});

	it("appends idempotent account events against an observed trail sequence", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.appendAccountEvent({
				sessionId,
				eventId,
				eventType: "message",
				body: { text: "What is our runway?" },
				expectedSequence: 0,
			}),
		).resolves.toEqual({
			sessionId,
			sequence: 1,
			eventId,
			eventType: "message",
			actorUserId,
			body: { text: "What is our runway?" },
			eventHash,
			createdAt,
		});
		expect(fake.appendAccountEvent).toHaveBeenCalledWith({
			p_session_id: sessionId,
			p_event_id: eventId,
			p_event_type: "message",
			p_body: { text: "What is our runway?" },
			p_expected_sequence: 0,
			p_execution_kind: null,
			p_execution_id: null,
			p_execution_claimant_id: null,
		});
	});

	it("creates fork-safe workspaces and commits immutable tree references with CAS heads", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.ensureCompanyWorkspace({
				environmentId,
				clientWorkspaceId,
				name: " Jonas MacBook ",
			}),
		).resolves.toMatchObject({ workspaceId, clientWorkspaceId, name: "Jonas MacBook" });
		expect(fake.ensureCompanyWorkspace).toHaveBeenCalledWith({
			p_environment_id: environmentId,
			p_client_workspace_id: clientWorkspaceId,
			p_name: "Jonas MacBook",
			p_base_snapshot_id: null,
		});

		await expect(
			primary.commitCompanySnapshot({
				workspaceId,
				clientSnapshotId,
				tree: {
					manifestSha256: treeManifestSha256,
					manifestBytes: 1024,
					contractVersion: 1,
					fileCount: 3,
					totalBytes: 4096,
				},
			}),
		).resolves.toMatchObject({
			snapshotId,
			workspaceId,
			tree: { manifestSha256: treeManifestSha256, fileCount: 3 },
		});
		expect(fake.commitCompanySnapshot).toHaveBeenCalledWith({
			p_workspace_id: workspaceId,
			p_client_snapshot_id: clientSnapshotId,
			p_expected_head_snapshot_id: null,
			p_tree_manifest_sha256: treeManifestSha256,
			p_tree_manifest_bytes: 1024,
			p_tree_contract_version: 1,
			p_file_count: 3,
			p_total_bytes: 4096,
		});
		await expect(primary.listCompanyWorkspaces(environmentId)).resolves.toMatchObject([
			{ workspaceId, headSnapshotId: snapshotId },
		]);
		await expect(primary.getCompanySnapshot(snapshotId)).resolves.toMatchObject({ snapshotId, workspaceId });
		expect(fake.getCompanySnapshot).toHaveBeenCalledWith({ p_snapshot_id: snapshotId });
		await expect(primary.listCompanySnapshots(workspaceId, 50)).resolves.toHaveLength(1);
		expect(fake.listCompanySnapshots).toHaveBeenCalledWith({ p_workspace_id: workspaceId, p_limit: 50 });
	});

	it("reads and advances the one canonical Company File head", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(primary.getCompanyFile(environmentId)).resolves.toMatchObject({
			canonicalWorkspaceId: workspaceId,
			headSnapshotId: snapshotId,
			state: "ready",
			storageLimitBytes: 50 * 1024 * 1024 * 1024,
		});
		await expect(
			primary.prepareCompanyFileRevision({
				environmentId,
				clientRevisionId: clientSnapshotId,
				expectedHeadSnapshotId: snapshotId,
				tree: {
					manifestSha256: treeManifestSha256,
					manifestBytes: 1024,
					contractVersion: 3,
					fileCount: 3,
					totalBytes: 4096,
				},
			}),
		).resolves.toMatchObject({ snapshotId, workspaceId });
		expect(fake.prepareCompanyFileRevision).toHaveBeenCalledWith({
			p_environment_id: environmentId,
			p_client_revision_id: clientSnapshotId,
			p_expected_head_snapshot_id: snapshotId,
			p_tree_manifest_sha256: treeManifestSha256,
			p_tree_manifest_bytes: 1024,
			p_tree_contract_version: 3,
			p_file_count: 3,
			p_total_bytes: 4096,
		});
		await expect(primary.publishCompanyFileRevision(environmentId, snapshotId, snapshotId)).resolves.toMatchObject({
			snapshotId,
			workspaceId,
		});
		expect(fake.publishCompanyFileRevision).toHaveBeenCalledWith({
			p_environment_id: environmentId,
			p_snapshot_id: snapshotId,
			p_expected_head_snapshot_id: snapshotId,
		});
	});

	it("prepares and submits a cloud-durable reviewed Company File proposal", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.prepareCompanyFileProposal({
				environmentId,
				clientRevisionId: clientSnapshotId,
				baseSnapshotId: snapshotId,
				tree: {
					manifestSha256: treeManifestSha256,
					manifestBytes: 1024,
					contractVersion: 3,
					fileCount: 3,
					totalBytes: 4096,
				},
			}),
		).resolves.toMatchObject({ snapshotId: artifactId, parentSnapshotId: snapshotId });
		await expect(
			primary.submitCompanyProposal({
				environmentId,
				clientProposalId: clientArtifactId,
				proposalSnapshotId: artifactId,
				execution: { kind: "turn", id: eventId, claimantId: objectProofId },
				sessionId,
				trailEndSequence: 4,
				reason: "policy",
				policyKey: "directional-research",
				title: "Review directional research",
				reviewerStaffIds: [artifactIndexId],
			}),
		).resolves.toMatchObject({
			proposalId: objectGraphId,
			status: "open",
			proposalSnapshot: { snapshotId: artifactId },
		});
		await expect(primary.listCompanyProposals(environmentId)).resolves.toMatchObject({
			items: [
				{
					proposalId: objectGraphId,
					reviews: [{ reviewerName: "Legal reviewer", status: "approved" }],
				},
			],
			hasMore: false,
		});
		await expect(
			primary.rebaseCompanyProposal(objectGraphId, artifactId, snapshotId, clientSnapshotId),
		).resolves.toMatchObject({ proposalId: objectGraphId, status: "open" });
		await expect(primary.acceptCompanyProposal(objectGraphId, artifactId)).resolves.toMatchObject({
			status: "accepted",
		});
		expect(fake.acceptCompanyProposal).toHaveBeenCalledWith({
			p_proposal_id: objectGraphId,
			p_expected_proposal_snapshot_id: artifactId,
		});
		await expect(primary.retryCompanyProposalReview(objectProofId)).resolves.toBeUndefined();
		expect(fake.retryCompanyProposalReview).toHaveBeenCalledWith({ p_assignment_id: objectProofId });
		await expect(primary.rejectCompanyProposal(objectGraphId, artifactId)).resolves.toMatchObject({
			status: "rejected",
		});
		expect(fake.rejectCompanyProposal).toHaveBeenCalledWith({
			p_proposal_id: objectGraphId,
			p_expected_proposal_snapshot_id: artifactId,
		});
		await expect(primary.getCompanyProposal(objectGraphId)).resolves.toMatchObject({ proposalId: objectGraphId });
		await expect(
			primary.appendCompanyProposalComment(objectGraphId, clientArtifactGcPlanId, "Verify the volume assumptions."),
		).resolves.toMatchObject({ commentId: artifactGcPlanId, authorName: "Jonas" });
		await expect(primary.listCompanyProposalComments(objectGraphId)).resolves.toMatchObject({
			items: [{ commentId: artifactGcPlanId, body: "Verify the volume assumptions." }],
			hasMore: false,
		});
	});

	it("captures and resolves immutable cross-layer substrate versions", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.captureCompanySubstrateVersion({
				snapshotId,
				clientVersionId: clientSubstrateVersionId,
				artifactIndexId,
			}),
		).resolves.toEqual({
			versionId: substrateVersionId,
			profileId,
			environmentId,
			companySnapshotId: snapshotId,
			clientVersionId: clientSubstrateVersionId,
			contractVersion: 1,
			operationSequence: 2,
			operationCount: 2,
			artifactIndexId,
			artifactManifestSha256: artifactIndexContentSha256,
			contentSha256: substrateContentSha256,
			createdByUserId: actorUserId,
			createdAt,
		});
		expect(fake.captureCompanySubstrateVersion).toHaveBeenCalledWith({
			p_snapshot_id: snapshotId,
			p_client_version_id: clientSubstrateVersionId,
			p_contract_version: 1,
			p_artifact_index_id: artifactIndexId,
		});

		await expect(primary.getCompanySubstrateVersion(substrateVersionId)).resolves.toMatchObject({
			versionId: substrateVersionId,
			companySnapshotId: snapshotId,
			operationSequence: 2,
		});
		await expect(primary.listCompanySubstrateOperations(substrateVersionId, 0, 50)).resolves.toEqual([
			{
				profileId,
				sequence: 2,
				environmentId,
				operationType: "session_event",
				entityId: sessionId,
				entityVersion: 1,
				contentSha256: eventHash,
				payload: { session_id: sessionId, sequence: 1, event_hash: eventHash },
				actorUserId,
				createdAt,
			},
		]);
		expect(fake.listCompanySubstrateOperations).toHaveBeenCalledWith({
			p_version_id: substrateVersionId,
			p_after_sequence: 0,
			p_limit: 50,
		});
	});

	it("registers immutable artifacts, indexes them, and exposes only guarded cleanup controls", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.registerArtifact({
				environmentId,
				clientArtifactId,
				sessionId,
				artifactType: "report",
				name: " 90-day financial snapshot ",
				rootObjectSha256: treeManifestSha256,
				rootContract: "qorpera.cloud-file-manifest/v1",
				contentSha256: artifactContentSha256,
				bytes: 4096,
				mediaType: "Application/PDF",
			}),
		).resolves.toMatchObject({ artifactId, artifactType: "report", mediaType: "application/pdf" });
		expect(fake.registerArtifact).toHaveBeenCalledWith({
			p_environment_id: environmentId,
			p_client_artifact_id: clientArtifactId,
			p_session_id: sessionId,
			p_artifact_type: "report",
			p_name: "90-day financial snapshot",
			p_root_object_sha256: treeManifestSha256,
			p_root_contract: "qorpera.cloud-file-manifest/v1",
			p_content_sha256: artifactContentSha256,
			p_bytes: 4096,
			p_media_type: "application/pdf",
		});

		await expect(
			primary.createArtifactIndex({
				environmentId,
				clientIndexId: clientArtifactIndexId,
				artifactIds: [artifactId],
			}),
		).resolves.toMatchObject({ indexId: artifactIndexId, artifactCount: 1, totalBytes: 4096 });
		await expect(primary.getArtifactIndex(artifactIndexId)).resolves.toMatchObject({ indexId: artifactIndexId });
		await expect(primary.listArtifactIndexEntries(artifactIndexId, 0, 50)).resolves.toMatchObject([
			{ ordinal: 1, artifactId },
		]);
		await expect(
			primary.createArtifactRetentionHold(artifactId, clientArtifactHoldId, "Financial evidence"),
		).resolves.toMatchObject({ holdId: artifactHoldId, artifactId });
		await expect(primary.releaseArtifactRetentionHold(artifactHoldId)).resolves.toMatchObject({
			holdId: artifactHoldId,
			releasedByUserId: actorUserId,
		});
		await expect(primary.listArtifactGcCandidates(profileId, 50)).resolves.toMatchObject([
			{
				artifactId,
				objectDeletionReady: true,
				reachabilityReady: true,
				reachabilityGraphId: objectGraphId,
				deletableObjectCount: 2,
				deletableStorageBytes: 5120,
			},
		]);

		await expect(primary.createArtifactGcPlan(artifactId, clientArtifactGcPlanId)).resolves.toMatchObject({
			planId: artifactGcPlanId,
			status: "waiting",
			pendingObjectCount: 2,
		});
		expect(fake.createArtifactGcPlan).toHaveBeenCalledWith({
			p_artifact_id: artifactId,
			p_client_plan_id: clientArtifactGcPlanId,
		});
		await expect(primary.listArtifactGcPlans(profileId, 50)).resolves.toMatchObject([
			{ planId: artifactGcPlanId, status: "waiting" },
		]);
		await expect(primary.listArtifactGcAudit(artifactGcPlanId, 0, 50)).resolves.toMatchObject([
			{ receiptId: 1, planId: artifactGcPlanId, eventType: "created" },
		]);
		await expect(primary.cancelArtifactGcPlan(artifactGcPlanId)).resolves.toMatchObject({
			status: "cancelled",
			cancelledByUserId: actorUserId,
		});
		await expect(primary.retryArtifactGcPlan(artifactGcPlanId)).resolves.toMatchObject({ status: "retrying" });
	});

	it("uploads bounded reachability entries and records a restore proof", async () => {
		const verifyCompanySnapshotClosure = vi
			.fn()
			.mockResolvedValueOnce({ verified: false, pending: true })
			.mockResolvedValueOnce({ verified: false, pending: true })
			.mockResolvedValueOnce({ verified: true });
		const fake = transport({ verifyCompanySnapshotClosure });
		const primary = new QorperaHostedPrimary(fake);
		await expect(
			primary.beginObjectReachabilityGraph({
				rootKind: "artifact",
				rootId: artifactId,
				clientGraphId: artifactId,
				rootObjectSha256: treeManifestSha256,
				contentSha256: artifactIndexContentSha256,
				objectCount: 2,
				storageBytes: 5120,
			}),
		).resolves.toMatchObject({ graphId: objectGraphId, status: "uploading" });
		expect(fake.beginObjectReachabilityGraph).toHaveBeenCalledWith({
			p_root_kind: "artifact",
			p_root_id: artifactId,
			p_client_graph_id: artifactId,
			p_root_object_sha256: treeManifestSha256,
			p_contract_version: 1,
			p_content_sha256: artifactIndexContentSha256,
			p_object_count: 2,
			p_storage_bytes: 5120,
		});
		await expect(
			primary.appendObjectReachabilityEntries(objectGraphId, [
				{ sha256: treeManifestSha256, bytes: 1024 },
				{ sha256: artifactContentSha256, bytes: 4096 },
			]),
		).resolves.toBe(2);
		await expect(primary.completeObjectReachabilityGraph(objectGraphId)).resolves.toMatchObject({
			graphId: objectGraphId,
			status: "complete",
		});
		await expect(primary.getObjectReachabilityGraph(objectGraphId)).resolves.toMatchObject({
			graphId: objectGraphId,
		});
		await expect(primary.verifyCompanySnapshotClosure(snapshotId, objectGraphId)).resolves.toBeUndefined();
		expect(fake.verifyCompanySnapshotClosure).toHaveBeenCalledWith({ snapshotId, graphId: objectGraphId });
		expect(fake.verifyCompanySnapshotClosure).toHaveBeenCalledTimes(3);
		await expect(
			primary.createObjectRestoreProof(objectGraphId, artifactId, artifactContentSha256, 4096),
		).resolves.toMatchObject({ proofId: objectProofId, graphId: objectGraphId, restoredBytes: 4096 });
	});

	it("pages events and rejects malformed or oversized boundary data", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(primary.readSessionEvents(sessionId, 0, 50)).resolves.toHaveLength(1);
		expect(fake.readSessionEvents).toHaveBeenCalledWith({
			p_session_id: sessionId,
			p_after_sequence: 0,
			p_limit: 50,
		});
		await expect(primary.readSessionEvents(sessionId, -1)).rejects.toThrow("cursor");
		await expect(
			primary.appendAccountEvent({
				sessionId,
				eventId,
				eventType: "message",
				body: "x".repeat(256 * 1024),
			}),
		).rejects.toThrow("too large");

		const malformed = new QorperaHostedPrimary(
			transport({ listProfiles: vi.fn(async () => [{ ...profileRecord(), role: "root" }]) }),
		);
		await expect(malformed.listProfiles()).rejects.toThrow("profile role");
	});

	it("parses immutable runner execution provenance on hosted transcript events", async () => {
		const fake = transport({
			readSessionEvents: vi.fn(async () => [
				{
					...eventRecord(),
					execution_kind: "run",
					execution_id: runId,
					execution_claimant_id: runId,
					runner_assignment_id: runnerAssignmentId,
				},
			]),
		});
		const primary = new QorperaHostedPrimary(fake);

		await expect(primary.readSessionEvents(sessionId, 0, 50)).resolves.toEqual([
			expect.objectContaining({
				execution: {
					kind: "run",
					id: runId,
					claimantId: runId,
					runnerAssignmentId,
				},
			}),
		]);
	});
});
