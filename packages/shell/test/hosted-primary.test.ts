import { describe, expect, it, vi } from "vitest";
import {
	type HostedPrimaryTransport,
	type HostedSessionEventType,
	QorperaHostedPrimary,
} from "../src/hosted-primary.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const sessionId = "a17381c2-3508-4573-b351-a5394adbd1f4";
const clientSessionId = "5b07e271-c030-422c-a3ef-ad10830c393d";
const eventId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const memberUserId = "509eb21f-981a-4c39-9f64-5fa1b121f367";
const createdAt = "2026-08-16T12:00:00.000Z";
const eventHash = "a".repeat(64);
const promotionId = "4a9d13d1-89fe-4896-a39e-67fc33db67d1";
const staffAgentId = "11111111-1111-4111-8111-111111111111";
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
		employment_status: "active",
		version: 1,
		created_at: createdAt,
		updated_at: createdAt,
		updated_by_user_id: actorUserId,
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

function transport(overrides: Partial<HostedPrimaryTransport> = {}): HostedPrimaryTransport {
	return {
		createProfile: vi.fn(async () => profileRecord()),
		promoteProfile: vi.fn(async () => profileRecord()),
		listProfiles: vi.fn(async () => [profileRecord()]),
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
		putStaff: vi.fn(async () => staffRecord()),
		createSession: vi.fn(async () => sessionRecord()),
		listSessions: vi.fn(async () => [sessionRecord()]),
		appendAccountEvent: vi.fn(async (input) => eventRecord(input.p_event_type)),
		readSessionEvents: vi.fn(async () => [eventRecord()]),
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
		createObjectRestoreProof: vi.fn(async () => objectProofRecord()),
		captureCompanySubstrateVersion: vi.fn(async () => substrateVersionRecord()),
		getCompanySubstrateVersion: vi.fn(async () => substrateVersionRecord()),
		listCompanySubstrateOperations: vi.fn(async () => [companyOperationRecord()]),
		...overrides,
	};
}

describe("Qorpera hosted primary", () => {
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
			}),
		).resolves.toEqual({
			sessionId,
			clientSessionId,
			profileId,
			environmentId,
			title: "Financial Officer",
			staffAgentId: "financial-officer",
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
		});
	});

	it("lists and writes authoritative staff with optimistic versions", async () => {
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
			p_employment_status: "active",
			p_created_at: createdAt,
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
		const fake = transport();
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
});
