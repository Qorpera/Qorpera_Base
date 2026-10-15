import {
	type HostedPrimaryTransport,
	type HostedSessionEventType,
	QorperaHostedPrimary,
} from "@qorpera/cloud-client/hosted-primary";
import type { JsonValue } from "@qorpera/contracts";
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
const staffAgentId = "11111111-1111-4111-8111-111111111111";
const formationId = "11111111-1111-4111-8111-111111111112";
const cofounderSessionId = "11111111-1111-4111-8111-111111111113";
const responsibilityId = "11111111-1111-4111-8111-111111111114";
const projectId = "11111111-1111-4111-8111-111111111115";
const roomId = "11111111-1111-4111-8111-111111111116";
const pathVersionId = "11111111-1111-4111-8111-111111111117";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const objectGraphId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const objectProofId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const treeManifestSha256 = "b".repeat(64);

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

function transport(overrides: Partial<HostedPrimaryTransport> = {}): HostedPrimaryTransport {
	return {
		getCompanyOrganization: vi.fn(async () => companyOrganizationRecord()),
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
		...overrides,
	};
}

describe("Qorpera hosted primary", () => {
	it("reads the company organization projection", async () => {
		const primary = new QorperaHostedPrimary(transport());
		await expect(primary.getCompanyOrganization(profileId)).resolves.toMatchObject({
			schema: "qorpera.company-organization/v1",
			profileId,
			cofounder: { staffAgentId, formationId, memberSessionId: cofounderSessionId },
			formation: { formationId, state: "source_inventory", status: "active", revision: 1 },
			responsibilities: [{ responsibilityId, name: "Engineering", accountableStaffAgentId: staffAgentId }],
			projects: [{ projectId, name: "Launch", sponsoringResponsibilityId: responsibilityId, roomId }],
		});
	});

	it("projects a stable hosted profile and environment identity", async () => {
		const primary = new QorperaHostedPrimary(transport());
		await expect(primary.listProfiles()).resolves.toEqual([
			{
				profileType: "cloud",
				profileId,
				environmentId,
				profileName: "Qorpera",
				environmentName: "Qorpera Company",
				role: "owner",
				contractVersion: 1,
				createdAt,
			},
		]);
		await expect(primary.getAccountEntitlement()).resolves.toEqual({
			planKey: "freemium",
			billingMode: "free",
			featureSet: "standard",
			storageAllocation: "metered",
			storageAllocationBytes: 50 * 1024 * 1024 * 1024,
			source: "default",
		});
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
							// Settled by a resume after the run was cut off (W5).
							{
								operation_id: eventId,
								operation_kind: "cloud_tool",
								status: "outcome_unknown",
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
						{
							operation_id: eventId,
							operation_kind: "cloud_tool",
							status: "outcome_unknown",
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
					operationReceipts: [
						{ operationId: objectProofId, status: "ambiguous" },
						{ operationId: eventId, status: "outcome_unknown" },
					],
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
				operationReceipts: [
					{ operationId: objectProofId, status: "ambiguous" },
					{ operationId: eventId, status: "outcome_unknown" },
				],
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

	it("lists authoritative staff with their versions", async () => {
		const primary = new QorperaHostedPrimary(transport());
		const [staff] = await primary.listStaff(profileId);
		expect(staff).toMatchObject({
			profileId,
			id: staffAgentId,
			displayName: "Financial Officer",
			version: 1,
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

	it("reads the one canonical Company File head", async () => {
		const fake = transport();
		const primary = new QorperaHostedPrimary(fake);
		await expect(primary.getCompanyFile(environmentId)).resolves.toMatchObject({
			canonicalWorkspaceId: workspaceId,
			headSnapshotId: snapshotId,
			state: "ready",
			storageLimitBytes: 50 * 1024 * 1024 * 1024,
		});
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
