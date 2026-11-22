import { describe, expect, it, vi } from "vitest";
import {
	CLOUD_FOLDER_DRAINS,
	type CloudFolderDrainPage,
	type CloudFolderDrainResult,
	CloudFolderDrains,
	type CloudFolderDynamicRoutine,
	type CloudFolderDynamicRoutinePage,
	type CloudFolderDynamicRoutineRun,
	type CloudFolderMaterialization,
	type CloudFolderMaterializationPage,
	CloudFolderRunMaterializer,
	CloudOrchestratorPassDue,
	type CloudRoutineScheduleHead,
	CloudRoutineScheduleReconciler,
	type CloudRunnerOrchestrationClaim,
	CloudRunnerOrchestrator,
	type CloudRunnerOrchestratorControlPlane,
	CloudRunnerOrchestratorRequestError,
	type CloudRunnerWork,
	LocalCloudRunnerProviderAdapter,
	SupabaseCloudRunnerOrchestratorControlPlane,
	validateCloudRunnerWork,
} from "../src/orchestrator.ts";
import { CloudRunnerProviderRequestError } from "../src/provider-http.ts";

const orchestratorId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const runnerId = "55555555-5555-4555-8555-555555555555";
const logicalComputerId = "66666666-6666-4666-8666-666666666666";
const assignmentId = "77777777-7777-4777-8777-777777777777";
const capability = "a".repeat(43);

function claim(): CloudRunnerOrchestrationClaim {
	return {
		claimId,
		orchestratorId,
		status: "claimed",
		leaseExpiresAt: "2026-08-20T12:02:00.000Z",
		work: {
			runId,
			jobId,
			profileId: "88888888-8888-4888-8888-888888888888",
			environmentId: "99999999-9999-4999-8999-999999999999",
			sourceKind: "session_turn",
			sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			sessionId: "abababab-abab-4bab-8bab-abababababab",
			substrateVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			companySnapshotId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
			staffVersion: 4,
			inputIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
			transcriptStartSequence: 12,
			deadlineAt: "2026-08-20T18:00:00.000Z",
			requiredCapability: "agent_turn",
			jobType: "agent_turn",
			payload: { input_ids: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"] },
			publicationMode: "automatic",
			reviewerStaffIds: [],
			logicalComputerId,
			workerClass: "managed_sandbox",
			requestedByUserId: "12121212-1212-4212-8212-121212121212",
			sponsor: {
				bindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				version: 2,
				kind: "company_api_billing",
				providerConnectionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				providerConnectionVersion: 1,
				provider: "openai",
				authenticationMode: "api_key",
				nativeHarness: "openai-responses",
				allowAutonomous: true,
			},
			modelPolicy: {
				provider: "openai",
				model: "gpt-test",
				maxCalls: 32,
				maxInputTokens: 2_000_000,
				maxOutputTokens: 500_000,
				maxCostMicrousd: 100_000,
			},
			attempt: 1,
		},
	};
}

// The control plane's raw answer for a claim, with the work's columns overridden.
function claimResponse(expected: CloudRunnerOrchestrationClaim = claim(), work: Record<string, unknown> = {}) {
	const value = {
		claim_id: expected.claimId,
		orchestrator_id: expected.orchestratorId,
		status: expected.status,
		lease_expires_at: expected.leaseExpiresAt,
		work: {
			run_id: expected.work.runId,
			job_id: expected.work.jobId,
			profile_id: expected.work.profileId,
			environment_id: expected.work.environmentId,
			source_kind: expected.work.sourceKind,
			source_id: expected.work.sourceId,
			session_id: expected.work.sessionId,
			substrate_version_id: expected.work.substrateVersionId,
			company_snapshot_id: expected.work.companySnapshotId,
			staff_agent_id: expected.work.staffAgentId,
			staff_version: expected.work.staffVersion,
			input_ids: expected.work.inputIds,
			transcript_start_sequence: expected.work.transcriptStartSequence,
			deadline_at: expected.work.deadlineAt,
			required_capability: expected.work.requiredCapability,
			job_type: expected.work.jobType,
			payload: expected.work.payload,
			publication_mode: expected.work.publicationMode,
			review_policy_key: null,
			reviewer_staff_ids: expected.work.reviewerStaffIds,
			logical_computer_id: expected.work.logicalComputerId,
			compute_identity_id: null,
			worker_class: expected.work.workerClass,
			requested_by_user_id: expected.work.requestedByUserId,
			sponsored_by_user_id: null,
			attempt: expected.work.attempt,
			sponsor: {
				binding_id: expected.work.sponsor.bindingId,
				version: expected.work.sponsor.version,
				kind: expected.work.sponsor.kind,
				provider_connection_id: expected.work.sponsor.providerConnectionId,
				provider_connection_version: expected.work.sponsor.providerConnectionVersion,
				provider: expected.work.sponsor.provider,
				authentication_mode: expected.work.sponsor.authenticationMode,
				native_harness: expected.work.sponsor.nativeHarness,
				allow_autonomous: expected.work.sponsor.allowAutonomous,
			},
			model_policy: {
				allowed_models: [
					{
						provider: expected.work.modelPolicy.provider,
						model: expected.work.modelPolicy.model,
					},
				],
				max_calls: expected.work.modelPolicy.maxCalls,
				max_input_tokens: expected.work.modelPolicy.maxInputTokens,
				max_output_tokens: expected.work.modelPolicy.maxOutputTokens,
				max_cost_microusd: expected.work.modelPolicy.maxCostMicrousd,
			},
		},
	};
	return { value: { ...value, work: { ...value.work, ...work } } };
}

function controlPlane(claimed: CloudRunnerOrchestrationClaim | undefined = claim()) {
	const control: CloudRunnerOrchestratorControlPlane = {
		listRoutineScheduleHeads: vi.fn(async () => ({ items: [], hasMore: false })),
		enqueueRoutineWake: vi.fn(async (input) => ({
			occurrenceId: input.occurrenceId,
			status: "queued" as const,
			scheduledFor: input.scheduledFor,
		})),
		advanceRoutineNextDue: vi.fn(async (input) => ({ status: "advanced" as const, nextDueAt: input.nextDueAt })),
		reconcileExpired: vi.fn(async () => undefined),
		retainedClaims: vi.fn(async () => []),
		claimNext: vi.fn(async () => claimed),
		renewClaim: vi.fn(async (workClaim) => ({ ...workClaim, leaseExpiresAt: "2026-08-20T12:04:00.000Z" })),
		assign: vi.fn(async (workClaim, runner, clientAssignmentId, capabilitySha256) => ({
			assignmentId: clientAssignmentId,
			claimId: workClaim.claimId,
			runId: workClaim.work.runId,
			jobId: workClaim.work.jobId,
			runnerId: runner.runnerId,
			capabilitySha256,
			expiresAt: "2026-08-20T12:02:00.000Z",
		})),
		releaseClaim: vi.fn(async () => undefined),
	};
	return control;
}

function scheduleHead(routineId = "12121212-1212-4212-8212-121212121212"): CloudRoutineScheduleHead {
	const { work } = claim();
	return {
		routineId,
		profileId: work.profileId,
		environmentId: work.environmentId,
		version: 3,
		staffAgentId: work.staffAgentId,
		triggers: [{ id: "schedule-main", kind: "schedule", intervalMinutes: 60, replyPolicy: "required" }],
		scheduleCursors: [{ triggerId: "schedule-main" }],
		contentSha256: "a".repeat(64),
		effectiveAt: "2026-08-20T07:00:00.000Z",
		updatedAt: "2026-08-20T08:00:00.000Z",
	};
}

function localAdapter(deliver = vi.fn(async (): Promise<void> => undefined)) {
	const reconcile = vi.fn(async () => undefined);
	const acquire = vi.fn(async (_work, _signal: AbortSignal) => ({
		runnerId,
		logicalComputerId,
		workerClass: "managed_sandbox" as const,
		providerAdapter: "local",
		capabilities: ["agent_turn"] as const,
		templateKey: "qorpera-test",
		templateVersion: "test-v1",
		policySha256: "f".repeat(64),
	}));
	const stop = vi.fn(async () => undefined);
	return {
		adapter: new LocalCloudRunnerProviderAdapter({ reconcile, acquire, deliver, stop }),
		reconcile,
		acquire,
		deliver,
		stop,
	};
}

describe("cloud runner orchestrator", () => {
	it("rejects non-HTTP loopback control-plane URLs", () => {
		expect(
			() =>
				new SupabaseCloudRunnerOrchestratorControlPlane(
					"file://localhost/private",
					"publishable-key",
					orchestratorId,
					"c".repeat(43),
				),
		).toThrow("must use HTTPS");
	});

	it("preserves member and company compute ownership without sponsor substitution", () => {
		const base = claim().work;
		const identityId = "13131313-1313-4313-8313-131313131313";
		const memberId = "14141414-1414-4414-8414-141414141414";
		expect(() =>
			validateCloudRunnerWork({
				...base,
				computeIdentityId: identityId,
				computeIdentityOwnershipKind: "member",
				computeIdentityOwnerUserId: memberId,
				computeTemplateKey: "qorpera-member-linux",
				computeTemplateVersion: "v1",
				computePolicySha256: "f".repeat(64),
				sponsoredByUserId: memberId,
				sponsor: {
					...base.sponsor,
					kind: "member_connection",
					authenticationMode: "native_subscription",
					nativeHarness: "codex-cli",
				},
			}),
		).not.toThrow();
		expect(() =>
			validateCloudRunnerWork({
				...base,
				computeIdentityId: identityId,
				computeIdentityOwnershipKind: "company",
				computeTemplateKey: "qorpera-company-linux",
				computeTemplateVersion: "v1",
				computePolicySha256: "f".repeat(64),
				sponsor: {
					...base.sponsor,
					kind: "company_service_account",
					authenticationMode: "native_subscription",
					nativeHarness: "codex-cli",
				},
			}),
		).not.toThrow();
		expect(() =>
			validateCloudRunnerWork({
				...base,
				computeIdentityId: identityId,
				computeIdentityOwnershipKind: "member",
				computeIdentityOwnerUserId: memberId,
				computeTemplateKey: "qorpera-member-linux",
				computeTemplateVersion: "v1",
				computePolicySha256: "f".repeat(64),
				sponsoredByUserId: memberId,
				sponsor: {
					...base.sponsor,
					kind: "company_service_account",
					authenticationMode: "native_subscription",
					nativeHarness: "codex-cli",
				},
			}),
		).toThrow("inconsistent ownership or sponsorship");
	});

	it("exposes bounded schedule discovery and idempotent wake admission through the private control plane", async () => {
		const routineId = "12121212-1212-4212-8212-121212121212";
		const occurrenceId = "13131313-1313-4313-8313-131313131313";
		const scheduledFor = "2026-08-20T12:00:00.000Z";
		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { action: string; occurrenceKey?: string };
			if (body.action === "routine_heads") {
				return Response.json({
					value: {
						items: [
							{
								routine_id: routineId,
								profile_id: "88888888-8888-4888-8888-888888888888",
								environment_id: "99999999-9999-4999-8999-999999999999",
								version: 3,
								staff_agent_id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
								triggers: [{ id: "schedule-main", kind: "schedule", intervalMinutes: 60 }],
								schedule_cursors: [
									{
										trigger_id: "schedule-main",
										last_scheduled_for: null,
										next_due_at: null,
									},
								],
								content_sha256: "a".repeat(64),
								effective_at: "2026-08-20T11:30:00.000Z",
								updated_at: scheduledFor,
							},
						],
						has_more: false,
						next_after_routine_id: null,
					},
				});
			}
			if (body.occurrenceKey === "slot:paused") {
				// A paused company: nothing admitted, cursor untouched.
				return Response.json({
					value: {
						occurrence_id: null,
						status: "deferred",
						run_id: null,
						scheduled_for: scheduledFor,
						reason: "paused",
					},
				});
			}
			return Response.json({
				value: {
					occurrence_id: occurrenceId,
					status: "queued",
					run_id: null,
					scheduled_for: scheduledFor,
				},
			});
		});
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			"c".repeat(43),
			fakeFetch as typeof fetch,
		);

		await expect(control.listRoutineScheduleHeads(undefined, 100)).resolves.toMatchObject({
			items: [{ routineId, version: 3, contentSha256: "a".repeat(64) }],
			hasMore: false,
		});
		await expect(
			control.enqueueRoutineWake({
				routineId,
				expectedVersion: 3,
				occurrenceId,
				occurrenceKey: "slot:42",
				triggerId: "schedule-main",
				scheduledFor,
				nextDueAt: "2026-08-20T13:00:00.000Z",
				payload: { coalesced: 1 },
			}),
		).resolves.toEqual({ occurrenceId, status: "queued", scheduledFor });
		await expect(
			control.enqueueRoutineWake({
				routineId,
				expectedVersion: 3,
				occurrenceId,
				occurrenceKey: "slot:paused",
				triggerId: "schedule-main",
				scheduledFor,
				nextDueAt: "2026-08-20T13:00:00.000Z",
				payload: { coalesced: 0 },
			}),
		).resolves.toEqual({ occurrenceId, status: "deferred", scheduledFor });
	});

	it("raises a first slot through the private control plane with the position the orchestrator read", async () => {
		const routineId = "12121212-1212-4212-8212-121212121212";
		const requests: unknown[] = [];
		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push(body);
			return Response.json({
				value:
					body.triggerId === "gone"
						? { status: "stale", next_due_at: null }
						: { status: "advanced", next_due_at: "2026-08-28T09:00:00+00:00" },
			});
		});
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			"c".repeat(43),
			fakeFetch as typeof fetch,
		);

		await expect(
			control.advanceRoutineNextDue({
				routineId,
				expectedVersion: 2,
				triggerId: "brief",
				expectedLastScheduledFor: "2026-08-27T12:15:30.123+02:00",
				nextDueAt: "2026-08-28T09:00:00Z",
			}),
		).resolves.toEqual({ status: "advanced", nextDueAt: "2026-08-28T09:00:00.000Z" });
		await expect(
			control.advanceRoutineNextDue({
				routineId,
				expectedVersion: 2,
				triggerId: "gone",
				nextDueAt: "2026-08-28T09:00:00Z",
			}),
		).resolves.toEqual({ status: "stale" });
		expect(requests).toEqual([
			{
				action: "advance_next_due",
				orchestratorId,
				routineId,
				expectedVersion: 2,
				triggerId: "brief",
				expectedLastScheduledFor: "2026-08-27T10:15:30.123Z",
				nextDueAt: "2026-08-28T09:00:00.000Z",
			},
			{
				action: "advance_next_due",
				orchestratorId,
				routineId,
				expectedVersion: 2,
				triggerId: "gone",
				nextDueAt: "2026-08-28T09:00:00.000Z",
			},
		]);
		await expect(
			control.advanceRoutineNextDue({
				routineId,
				expectedVersion: 2,
				triggerId: "brief",
				expectedLastScheduledFor: "2026-08-28T09:00:00.000Z",
				nextDueAt: "2026-08-28T09:00:00.000Z",
			}),
		).rejects.toThrow("Routine next due time is invalid");
		expect(fakeFetch).toHaveBeenCalledTimes(2);
	});

	it.each(["optional", "required", "silent"])("enqueues %s interval wakes", async (replyPolicy) => {
		const routineId = "12121212-1212-4212-8212-121212121212";
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId,
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 3,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [{ id: "schedule-main", kind: "schedule", intervalMinutes: 60, replyPolicy }],
					scheduleCursors: [
						{
							triggerId: "schedule-main",
							lastScheduledFor: "2026-08-20T08:00:00.000Z",
							nextDueAt: "2026-08-20T09:00:00.000Z",
						},
					],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-20T07:00:00.000Z",
					updatedAt: "2026-08-20T08:00:00.000Z",
				},
			],
			hasMore: false,
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T12:30:00.000Z"),
			catchUpLimit: 2,
		});

		await reconciler.reconcile(control);

		expect(control.enqueueRoutineWake).toHaveBeenCalledOnce();
		expect(control.enqueueRoutineWake).toHaveBeenCalledWith(
			expect.objectContaining({
				routineId,
				scheduledFor: "2026-08-20T12:00:00.000Z",
				expectedLastScheduledFor: "2026-08-20T08:00:00.000Z",
				nextDueAt: "2026-08-20T13:00:00.000Z",
				payload: { schema: "qorpera.routine-schedule-occurrence/v1", coalesced: 3 },
			}),
		);
	});

	it("backfills a bounded number of missed slots in FIFO order", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 3,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [{ id: "schedule-main", kind: "schedule", intervalMinutes: 60 }],
					scheduleCursors: [
						{
							triggerId: "schedule-main",
							lastScheduledFor: "2026-08-20T08:00:00.000Z",
							nextDueAt: "2026-08-20T09:00:00.000Z",
						},
					],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-20T07:00:00.000Z",
					updatedAt: "2026-08-20T08:00:00.000Z",
				},
			],
			hasMore: false,
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T10:30:00.000Z"),
			catchUpLimit: 3,
		});

		await reconciler.reconcile(control);

		expect(vi.mocked(control.enqueueRoutineWake).mock.calls.map(([input]) => input)).toMatchObject([
			{
				scheduledFor: "2026-08-20T09:00:00.000Z",
				expectedLastScheduledFor: "2026-08-20T08:00:00.000Z",
				nextDueAt: "2026-08-20T10:00:00.000Z",
			},
			{
				scheduledFor: "2026-08-20T10:00:00.000Z",
				expectedLastScheduledFor: "2026-08-20T09:00:00.000Z",
				nextDueAt: "2026-08-20T11:00:00.000Z",
			},
		]);
	});

	it("stops a rejected trigger's catch-up while continuing independent triggers and pages", async () => {
		const control = controlPlane();
		const first = scheduleHead();
		const second = scheduleHead("13131313-1313-4313-8313-131313131313");
		first.triggers = [
			{ id: "blocked", kind: "schedule", intervalMinutes: 60 },
			{ id: "independent", kind: "schedule", intervalMinutes: 60 },
		];
		first.scheduleCursors = ["blocked", "independent"].map((triggerId) => ({
			triggerId,
			lastScheduledFor: "2026-08-20T08:00:00.000Z",
			nextDueAt: "2026-08-20T09:00:00.000Z",
		}));
		second.scheduleCursors = [{ ...first.scheduleCursors[0], triggerId: "schedule-main" }];
		vi.mocked(control.listRoutineScheduleHeads).mockImplementation(async (after) =>
			after
				? { items: [second], hasMore: false }
				: { items: [first], hasMore: true, nextAfterRoutineId: first.routineId },
		);
		const failure = new CloudRunnerOrchestratorRequestError(503);
		vi.mocked(control.enqueueRoutineWake).mockImplementation(async (input) => {
			if (input.triggerId === "blocked") throw failure;
			return { occurrenceId: input.occurrenceId, status: "queued", scheduledFor: input.scheduledFor };
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T10:30:00.000Z"),
			catchUpLimit: 3,
		});

		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [failure] });

		expect(vi.mocked(control.enqueueRoutineWake).mock.calls.map(([input]) => input)).toMatchObject([
			{ triggerId: "blocked", scheduledFor: "2026-08-20T09:00:00.000Z" },
			{ triggerId: "independent", scheduledFor: "2026-08-20T09:00:00.000Z" },
			{ triggerId: "independent", scheduledFor: "2026-08-20T10:00:00.000Z" },
			{ routineId: second.routineId, scheduledFor: "2026-08-20T09:00:00.000Z" },
			{ routineId: second.routineId, scheduledFor: "2026-08-20T10:00:00.000Z" },
		]);
		expect(control.listRoutineScheduleHeads).toHaveBeenLastCalledWith(first.routineId, 250);
	});

	it("lists folder-v2 dynamic routines and restores one's run through the private control plane", async () => {
		const routineId = "12121212-1212-4212-8212-121212121212";
		const occurrenceId = "13131313-1313-4313-8313-131313131313";
		const requests: unknown[] = [];
		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push(body);
			return Response.json({
				value:
					body.action === "folder_dynamic_routines"
						? { items: [{ routine_id: routineId, version: 4 }], has_more: true, next_after_routine_id: routineId }
						: body.expectedVersion === 4
							? { status: "inserted", occurrence_id: occurrenceId, not_before: "2026-10-03T09:00:00+00:00" }
							: { status: "changed" },
			});
		});
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			"c".repeat(43),
			fakeFetch as typeof fetch,
		);

		await expect(control.listFolderDynamicRoutines(undefined, 250)).resolves.toEqual({
			items: [{ routineId, version: 4 }],
			hasMore: true,
			nextAfterRoutineId: routineId,
		});
		await expect(control.restoreFolderDynamicRoutineRun({ routineId, version: 4 })).resolves.toEqual({
			status: "inserted",
			occurrenceId,
		});
		await expect(control.restoreFolderDynamicRoutineRun({ routineId, version: 5 })).resolves.toEqual({
			status: "changed",
		});
		expect(requests).toEqual([
			{ action: "folder_dynamic_routines", orchestratorId, limit: 250 },
			{ action: "restore_dynamic_routine", orchestratorId, routineId, expectedVersion: 4 },
			{ action: "restore_dynamic_routine", orchestratorId, routineId, expectedVersion: 5 },
		]);
		await expect(control.listFolderDynamicRoutines("not-a-uuid", 250)).rejects.toThrow(
			"Folder dynamic routine cursor",
		);
		await expect(control.restoreFolderDynamicRoutineRun({ routineId, version: 0 })).rejects.toThrow(
			"Routine version is invalid",
		);
		expect(fakeFetch).toHaveBeenCalledTimes(3);
		// An answer the orchestrator does not know is refused, as is an inserted run without its id.
		fakeFetch.mockImplementationOnce(async () => Response.json({ value: { status: "fired" } }));
		await expect(control.restoreFolderDynamicRoutineRun({ routineId, version: 4 })).rejects.toThrow(
			"invalid folder dynamic routine status",
		);
		fakeFetch.mockImplementationOnce(async () => Response.json({ value: { status: "inserted" } }));
		await expect(control.restoreFolderDynamicRoutineRun({ routineId, version: 4 })).rejects.toThrow("without its id");
	});

	it("restores every listed folder-v2 dynamic routine after the schedule heads, and waits out an edge function that predates them", async () => {
		const first = "14141414-1414-4414-8414-141414141414";
		const second = "15151515-1515-4515-8515-151515151515";
		const third = "16161616-1616-4616-8616-161616161616";
		const control = controlPlane();
		const list = vi.fn(
			async (after: string | undefined, _limit: number): Promise<CloudFolderDynamicRoutinePage> =>
				after
					? { items: [{ routineId: third, version: 1 }], hasMore: false }
					: {
							items: [
								{ routineId: first, version: 2 },
								{ routineId: second, version: 3 },
							],
							hasMore: true,
							nextAfterRoutineId: second,
						},
		);
		const failure = new CloudRunnerOrchestratorRequestError(503);
		const restore = vi.fn(async (routine: CloudFolderDynamicRoutine): Promise<CloudFolderDynamicRoutineRun> => {
			if (routine.routineId === second) throw failure;
			return { status: "inserted", occurrenceId: "17171717-1717-4717-8717-171717171717" };
		});
		control.listFolderDynamicRoutines = list;
		control.restoreFolderDynamicRoutineRun = restore;
		let now = new Date("2026-10-03T09:00:00.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now, folderDynamicIntervalMs: 0 });

		// One routine's failure never stops the others; it is reported after the pass.
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [failure] });
		expect(restore.mock.calls.map(([routine]) => routine)).toEqual([
			{ routineId: first, version: 2 },
			{ routineId: second, version: 3 },
			{ routineId: third, version: 1 },
		]);
		expect(list.mock.calls.map(([after, limit]) => [after, limit])).toEqual([
			[undefined, 250],
			[second, 250],
		]);

		// An edge function that predates the actions answers 400: reported once, then not asked for ten minutes.
		const unknown = new CloudRunnerOrchestratorRequestError(400);
		list.mockRejectedValue(unknown);
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [unknown] });
		now = new Date("2026-10-03T09:05:00.000Z");
		await expect(reconciler.reconcile(control)).resolves.toBeUndefined();
		expect(list).toHaveBeenCalledTimes(3);
		now = new Date("2026-10-03T09:11:00.000Z");
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [unknown] });
		expect(list).toHaveBeenCalledTimes(4);

		// A control plane without the actions only schedules.
		const scheduleOnly = new CloudRoutineScheduleReconciler({ now: () => now });
		await expect(scheduleOnly.reconcile(controlPlane())).resolves.toBeUndefined();
	});

	it("lists the folder-v2 dynamic routines at most every 30 seconds, not on every poll", async () => {
		const control = controlPlane();
		const list = vi.fn(async (): Promise<CloudFolderDynamicRoutinePage> => ({ items: [], hasMore: false }));
		control.listFolderDynamicRoutines = list;
		control.restoreFolderDynamicRoutineRun = vi.fn(
			async (): Promise<CloudFolderDynamicRoutineRun> => ({ status: "pending" }),
		);
		let now = new Date("2026-10-03T09:00:00.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now });
		await reconciler.reconcile(control);
		now = new Date("2026-10-03T09:00:29.000Z");
		await reconciler.reconcile(control);
		expect(list).toHaveBeenCalledTimes(1);
		now = new Date("2026-10-03T09:00:30.000Z");
		await reconciler.reconcile(control);
		expect(list).toHaveBeenCalledTimes(2);
		expect(() => new CloudRoutineScheduleReconciler({ folderDynamicIntervalMs: -1 })).toThrow(
			"Folder dynamic routine interval is outside the supported range",
		);
	});

	it("lists the folder-v2 companies with due work and materializes one through the private control plane", async () => {
		const profileId = "18181818-1818-4818-8818-181818181818";
		const madeRunId = "19191919-1919-4919-8919-191919191919";
		const requests: unknown[] = [];
		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push(body);
			return Response.json({
				value:
					body.action === "folder_materialize_due"
						? { items: [{ profile_id: profileId }], has_more: true, next_after_profile_id: profileId }
						: body.limit === 16
							? { state: "done", run_ids: [madeRunId], failed: 0, cancelled: 0, blocked: 0, skipped: 0 }
							: { state: "paused" },
			});
		});
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			"c".repeat(43),
			fakeFetch as typeof fetch,
		);

		await expect(control.listFolderMaterializationDue(undefined, 100)).resolves.toEqual({
			items: [profileId],
			hasMore: true,
			nextAfterProfileId: profileId,
		});
		await expect(control.materializeFolderCompany(profileId, 16)).resolves.toEqual({
			state: "done",
			runIds: [madeRunId],
		});
		await expect(control.materializeFolderCompany(profileId, 4)).resolves.toEqual({ state: "paused", runIds: [] });
		expect(requests).toEqual([
			{ action: "folder_materialize_due", orchestratorId, limit: 100 },
			{ action: "folder_materialize_company", orchestratorId, profileId, limit: 16 },
			{ action: "folder_materialize_company", orchestratorId, profileId, limit: 4 },
		]);
		await expect(control.listFolderMaterializationDue("not-a-uuid", 100)).rejects.toThrow(
			"Folder materialization cursor",
		);
		await expect(control.materializeFolderCompany(profileId, 17)).rejects.toThrow(
			"Folder materialization limit is outside the supported range",
		);
		expect(fakeFetch).toHaveBeenCalledTimes(3);
		// A state the orchestrator does not know is refused, as is a done answer without its runs.
		fakeFetch.mockImplementationOnce(async () => Response.json({ value: { state: "fired" } }));
		await expect(control.materializeFolderCompany(profileId, 16)).rejects.toThrow(
			"invalid folder materialization state",
		);
		fakeFetch.mockImplementationOnce(async () => Response.json({ value: { state: "done" } }));
		await expect(control.materializeFolderCompany(profileId, 16)).rejects.toThrow("without its runs");
		// A page longer than asked for is refused.
		fakeFetch.mockImplementationOnce(async () =>
			Response.json({ value: { items: [{ profile_id: profileId }, { profile_id: madeRunId }], has_more: false } }),
		);
		await expect(control.listFolderMaterializationDue(undefined, 1)).rejects.toThrow(
			"more folder companies than asked",
		);
	});

	it("materializes every due folder-v2 company in its own request, and waits out an edge function that predates it", async () => {
		const first = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
		const second = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
		const third = "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c";
		const control = controlPlane();
		const list = vi.fn(
			async (after: string | undefined, _limit: number): Promise<CloudFolderMaterializationPage> =>
				after
					? { items: [third], hasMore: false }
					: { items: [first, second], hasMore: true, nextAfterProfileId: second },
		);
		const failure = new CloudRunnerOrchestratorRequestError(503);
		const materialize = vi.fn(async (profileId: string, _limit: number): Promise<CloudFolderMaterialization> => {
			if (profileId === second) throw failure;
			return { state: "idle", runIds: [] };
		});
		control.listFolderMaterializationDue = list;
		control.materializeFolderCompany = materialize;
		let now = new Date("2026-10-04T09:00:00.000Z");
		const materializer = new CloudFolderRunMaterializer({ now: () => now });

		// One company's failure never stops the others; it is reported after the pass.
		await expect(materializer.reconcile(control)).rejects.toMatchObject({ errors: [failure] });
		expect(materialize.mock.calls).toEqual([
			[first, 16],
			[second, 16],
			[third, 16],
		]);
		expect(list.mock.calls.map(([after, limit]) => [after, limit])).toEqual([
			[undefined, 100],
			[second, 100],
		]);

		// An edge function that predates the actions answers 400: reported once, then not asked for ten minutes.
		const unknown = new CloudRunnerOrchestratorRequestError(400);
		list.mockRejectedValue(unknown);
		await expect(materializer.reconcile(control)).rejects.toMatchObject({ errors: [unknown] });
		now = new Date("2026-10-04T09:05:00.000Z");
		await expect(materializer.reconcile(control)).resolves.toBeUndefined();
		expect(list).toHaveBeenCalledTimes(3);
		now = new Date("2026-10-04T09:11:00.000Z");
		await expect(materializer.reconcile(control)).rejects.toMatchObject({ errors: [unknown] });
		expect(list).toHaveBeenCalledTimes(4);

		// A cursor that does not move forward ends the pass instead of looping.
		list.mockReset();
		list.mockImplementation(async (after: string | undefined) =>
			after
				? { items: [first], hasMore: true, nextAfterProfileId: first }
				: { items: [second], hasMore: true, nextAfterProfileId: second },
		);
		await expect(new CloudFolderRunMaterializer({ now: () => now }).reconcile(control)).rejects.toThrow(
			"did not move forward",
		);

		// A control plane without the actions makes no request; the bounds are checked.
		await expect(new CloudFolderRunMaterializer().reconcile(controlPlane())).resolves.toBeUndefined();
		expect(() => new CloudFolderRunMaterializer({ companyLimit: 17 })).toThrow(
			"Folder materialization company limit is outside the supported range",
		);
		expect(() => new CloudFolderRunMaterializer({ pageSize: 0 })).toThrow(
			"Folder materialization page size is outside the supported range",
		);
	});

	it("lists a folder drain's due environments and runs one through the private control plane", async () => {
		const environmentId = "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d";
		const requests: unknown[] = [];
		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push(body);
			return Response.json({
				value:
					body.action === "folder_drain_due"
						? {
								items: [{ environment_id: environmentId }],
								has_more: true,
								next_after_environment_id: environmentId,
							}
						: { schema: "qorpera.folder-listen/v1", state: "done", processedSeq: 7, wakes: 1 },
			});
		});
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			"c".repeat(43),
			fakeFetch as typeof fetch,
		);
		await expect(control.listFolderDrainDue("listen", undefined, 100)).resolves.toEqual({
			items: [environmentId],
			hasMore: true,
			nextAfterEnvironmentId: environmentId,
		});
		await expect(control.runFolderDrain("listen", environmentId, 32)).resolves.toEqual({ state: "done" });
		expect(requests).toEqual([
			{ action: "folder_drain_due", orchestratorId, drain: "listen", limit: 100 },
			{ action: "folder_drain_company", orchestratorId, drain: "listen", environmentId, limit: 32 },
		]);
		await expect(control.listFolderDrainDue("Listen!", undefined, 100)).rejects.toThrow(
			"Folder drain name is invalid",
		);
		await expect(control.runFolderDrain("listen", environmentId, 257)).rejects.toThrow(
			"Folder drain limit is outside the supported range",
		);
		await expect(control.listFolderDrainDue("listen", "not-a-uuid", 100)).rejects.toThrow("Folder drain cursor");
		fakeFetch.mockImplementationOnce(async () => Response.json({ value: { state: "Fired!" } }));
		await expect(control.runFolderDrain("listen", environmentId, 32)).rejects.toThrow("invalid folder drain state");
		fakeFetch.mockImplementationOnce(async () =>
			Response.json({ value: { items: [{ environment_id: environmentId }], has_more: true } }),
		);
		await expect(control.listFolderDrainDue("listen", undefined, 100)).rejects.toThrow(
			"inconsistent folder drain pagination",
		);
	});

	it("runs F2's worker drain before the listener, its human-task wakes after it, then machine events, office wakes, machine check-ins, coding check-ins and event wakes, each with its company limit", () => {
		expect(CLOUD_FOLDER_DRAINS).toEqual([
			{ name: "workers", companyLimit: 32 },
			{ name: "listen", companyLimit: 32 },
			{ name: "human_tasks", companyLimit: 32 },
			{ name: "machine_events", companyLimit: 8 },
			{ name: "office_wakes", companyLimit: 16 },
			{ name: "machine_checkins", companyLimit: 8 },
			{ name: "coding_checkins", companyLimit: 8 },
			{ name: "events", companyLimit: 16 },
		]);
	});

	it("runs each folder drain's companies in their own requests; a drain's outage or a company's failure stops no other", async () => {
		const first = "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e";
		const second = "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f";
		const control = controlPlane();
		const unknown = new CloudRunnerOrchestratorRequestError(400);
		const failure = new CloudRunnerOrchestratorRequestError(503);
		const list = vi.fn(async (drain: string, after: string | undefined): Promise<CloudFolderDrainPage> => {
			if (drain === "workers") throw unknown;
			return after
				? { items: [second], hasMore: false }
				: { items: [first], hasMore: true, nextAfterEnvironmentId: first };
		});
		const run = vi.fn(
			async (drain: string, environmentId: string, _limit: number): Promise<CloudFolderDrainResult> => {
				if (drain === "listen" && environmentId === first) throw failure;
				return { state: "done" };
			},
		);
		control.listFolderDrainDue = list;
		control.runFolderDrain = run;
		let now = new Date("2026-10-04T09:00:00.000Z");
		const drains = new CloudFolderDrains({
			now: () => now,
			drains: [
				{ name: "workers", companyLimit: 8 },
				{ name: "listen", companyLimit: 32 },
			],
		});
		await expect(drains.reconcile(control)).rejects.toMatchObject({ errors: [unknown, failure] });
		expect(run.mock.calls).toEqual([
			["listen", first, 32],
			["listen", second, 32],
		]);
		// The drain the edge function did not know waits ten minutes; the other goes on every pass.
		now = new Date("2026-10-04T09:05:00.000Z");
		run.mockImplementation(async () => ({ state: "idle" }));
		await expect(drains.reconcile(control)).resolves.toBeUndefined();
		expect(list.mock.calls.filter(([drain]) => drain === "workers")).toHaveLength(1);
		now = new Date("2026-10-04T09:11:00.000Z");
		await expect(drains.reconcile(control)).rejects.toMatchObject({ errors: [unknown] });
		expect(list.mock.calls.filter(([drain]) => drain === "workers")).toHaveLength(2);
		// A control plane without the actions makes no request; the bounds and names are checked.
		await expect(new CloudFolderDrains().reconcile(controlPlane())).resolves.toBeUndefined();
		expect(() => new CloudFolderDrains({ drains: [{ name: "listen", companyLimit: 257 }] })).toThrow(
			"Folder drain company limit is outside the supported range",
		);
		expect(() => new CloudFolderDrains({ drains: [{ name: "Listen", companyLimit: 1 }] })).toThrow(
			"Folder drain name is invalid",
		);
		expect(
			() =>
				new CloudFolderDrains({
					drains: [
						{ name: "listen", companyLimit: 1 },
						{ name: "listen", companyLimit: 2 },
					],
				}),
		).toThrow("listed twice");
	});

	it("backs off a failing folder drain and a failing company on their own, doubling, and forgets it after a success", async () => {
		const first = "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e";
		const second = "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f";
		const control = controlPlane();
		const outage = new CloudRunnerOrchestratorRequestError(503);
		let workersDown = true;
		let firstFails = true;
		const list = vi.fn(async (drain: string): Promise<CloudFolderDrainPage> => {
			if (drain === "workers" && workersDown) throw outage;
			return { items: [first, second], hasMore: false };
		});
		const run = vi.fn(async (drain: string, environmentId: string): Promise<CloudFolderDrainResult> => {
			if (drain === "listen" && environmentId === first && firstFails) throw outage;
			return { state: "done" };
		});
		control.listFolderDrainDue = list;
		control.runFolderDrain = run;
		const start = Date.parse("2026-10-04T09:00:00.000Z");
		let now = new Date(start);
		const at = (ms: number) => {
			now = new Date(start + ms);
		};
		const drains = new CloudFolderDrains({
			now: () => now,
			drains: [
				{ name: "workers", companyLimit: 8 },
				{ name: "listen", companyLimit: 32 },
			],
		});
		const listed = (drain: string) => list.mock.calls.filter(([name]) => name === drain).length;
		const ran = (environmentId: string) =>
			run.mock.calls.filter(([drain, id]) => drain === "listen" && id === environmentId).length;

		await expect(drains.reconcile(control)).rejects.toMatchObject({ errors: [outage, outage] });
		expect([listed("workers"), ran(first), ran(second)]).toEqual([1, 1, 1]);
		// Within the first second neither the failed drain nor the failed company is asked; the others are.
		at(500);
		await expect(drains.reconcile(control)).resolves.toBeUndefined();
		expect([listed("workers"), listed("listen"), ran(first), ran(second)]).toEqual([1, 2, 1, 2]);
		// After 1 s both are asked again and fail again: now they wait 2 s.
		at(1_000);
		await expect(drains.reconcile(control)).rejects.toMatchObject({ errors: [outage, outage] });
		expect([listed("workers"), ran(first)]).toEqual([2, 2]);
		at(2_500);
		await expect(drains.reconcile(control)).resolves.toBeUndefined();
		expect([listed("workers"), ran(first), ran(second)]).toEqual([2, 2, 4]);
		// Both recover; a later failure waits 1 s again.
		workersDown = false;
		firstFails = false;
		at(3_000);
		await expect(drains.reconcile(control)).resolves.toBeUndefined();
		expect([listed("workers"), ran(first)]).toEqual([3, 3]);
		firstFails = true;
		at(4_000);
		await expect(drains.reconcile(control)).rejects.toMatchObject({ errors: [outage] });
		at(5_000);
		await expect(drains.reconcile(control)).rejects.toMatchObject({ errors: [outage] });
		expect(ran(first)).toBe(5);
	});

	it("recomputes an unadmitted initial slot from the existing latest-slot rule", async () => {
		const control = controlPlane();
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: [scheduleHead()], hasMore: false });
		const failure = new CloudRunnerOrchestratorRequestError(401);
		vi.mocked(control.enqueueRoutineWake).mockRejectedValue(failure);
		let now = new Date("2026-08-20T09:30:00.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now });

		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [failure] });
		now = new Date("2026-08-20T09:45:00.000Z");
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [failure] });
		now = new Date("2026-08-20T10:30:00.000Z");
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [failure] });

		const attempts = vi.mocked(control.enqueueRoutineWake).mock.calls.map(([input]) => input);
		expect(attempts[1]).toEqual(attempts[0]);
		expect(attempts.map((input) => input.scheduledFor)).toEqual([
			"2026-08-20T09:00:00.000Z",
			"2026-08-20T09:00:00.000Z",
			"2026-08-20T10:00:00.000Z",
		]);
		expect(attempts[2]?.occurrenceId).not.toBe(attempts[0]?.occurrenceId);
		expect(attempts.every((input) => input.expectedLastScheduledFor === undefined)).toBe(true);
	});

	it("retries a durable cursor's first pending slot until the existing catch-up bound coalesces it", async () => {
		const control = controlPlane();
		const head = scheduleHead();
		head.scheduleCursors = [
			{
				triggerId: "schedule-main",
				lastScheduledFor: "2026-08-20T08:00:00.000Z",
				nextDueAt: "2026-08-20T09:00:00.000Z",
			},
		];
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: [head], hasMore: false });
		const failure = new CloudRunnerOrchestratorRequestError(503);
		vi.mocked(control.enqueueRoutineWake).mockRejectedValue(failure);
		let now = new Date("2026-08-20T09:30:00.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now, catchUpLimit: 2 });

		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [failure] });
		now = new Date("2026-08-20T10:30:00.000Z");
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [failure] });
		now = new Date("2026-08-20T12:30:00.000Z");
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [failure] });

		const attempts = vi.mocked(control.enqueueRoutineWake).mock.calls.map(([input]) => input);
		expect(attempts).toHaveLength(3);
		expect(attempts[1]).toEqual(attempts[0]);
		expect(attempts[2]).toMatchObject({
			scheduledFor: "2026-08-20T12:00:00.000Z",
			expectedLastScheduledFor: "2026-08-20T08:00:00.000Z",
			payload: { schema: "qorpera.routine-schedule-occurrence/v1", coalesced: 3 },
		});
		expect(attempts[2]?.occurrenceId).not.toBe(attempts[0]?.occurrenceId);
	});

	it("does not isolate cancellation as an enqueue failure", async () => {
		const control = controlPlane();
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [scheduleHead(), scheduleHead("13131313-1313-4313-8313-131313131313")],
			hasMore: false,
		});
		const controller = new AbortController();
		const failure = new DOMException("Stopped", "AbortError");
		vi.mocked(control.enqueueRoutineWake).mockImplementation(async () => {
			controller.abort();
			throw failure;
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T12:30:00.000Z"),
		});

		await expect(reconciler.reconcile(control, controller.signal)).rejects.toBe(failure);
		expect(control.enqueueRoutineWake).toHaveBeenCalledOnce();
	});

	it("runs a new weekly routine once as a kickoff before its first slot", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "weekly-monday",
							kind: "schedule",
							intervalMinutes: 10_080,
							weekdays: ["monday"],
							localTime: "09:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [{ triggerId: "weekly-monday" }],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-25T10:00:00.000Z",
					updatedAt: "2026-08-25T10:00:00.000Z",
				},
			],
			hasMore: false,
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-25T12:00:00.000Z"),
		});

		await reconciler.reconcile(control);

		expect(control.enqueueRoutineWake).toHaveBeenCalledOnce();
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).not.toHaveProperty("expectedLastScheduledFor");
		expect(control.enqueueRoutineWake).toHaveBeenCalledWith(
			expect.objectContaining({
				routineId: "12121212-1212-4212-8212-121212121212",
				scheduledFor: "2026-08-25T10:00:00.000Z",
				nextDueAt: "2026-08-31T09:00:00.000Z",
				payload: { schema: "qorpera.routine-schedule-occurrence/v1", coalesced: 0 },
			}),
		);
	});

	it("kicks off a later version whose cursor is still fresh, and one whose start is already reached", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 2,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "weekly-monday",
							kind: "schedule",
							intervalMinutes: 10_080,
							weekdays: ["monday"],
							localTime: "09:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [{ triggerId: "weekly-monday" }],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-25T10:00:00.000Z",
					updatedAt: "2026-08-25T10:00:00.000Z",
				},
			],
			hasMore: false,
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-25T12:00:00.000Z"),
		});
		await reconciler.reconcile(control);
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).toMatchObject({
			scheduledFor: "2026-08-25T10:00:00.000Z",
			nextDueAt: "2026-08-31T09:00:00.000Z",
		});

		vi.mocked(control.enqueueRoutineWake).mockClear();
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "weekly-monday",
							kind: "schedule",
							intervalMinutes: 10_080,
							startAt: "2026-08-25T09:00:00.000Z",
							weekdays: ["monday"],
							localTime: "09:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [{ triggerId: "weekly-monday" }],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-25T10:00:00.000Z",
					updatedAt: "2026-08-25T10:00:00.000Z",
				},
			],
			hasMore: false,
		});
		await reconciler.reconcile(control);
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).toMatchObject({
			scheduledFor: "2026-08-25T10:00:00.000Z",
		});
	});

	it("does not kick off when the start lies ahead or the version is not yet effective, and an old version takes its slot", async () => {
		const control = controlPlane(undefined);
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-25T12:00:00.000Z"),
		});
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "weekly-monday",
							kind: "schedule",
							intervalMinutes: 10_080,
							startAt: "2026-08-31T09:00:00.000Z",
							weekdays: ["monday"],
							localTime: "09:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [{ triggerId: "weekly-monday" }],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-25T10:00:00.000Z",
					updatedAt: "2026-08-25T10:00:00.000Z",
				},
			],
			hasMore: false,
		});
		await reconciler.reconcile(control);
		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();

		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "weekly-monday",
							kind: "schedule",
							intervalMinutes: 10_080,
							weekdays: ["monday"],
							localTime: "09:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [{ triggerId: "weekly-monday" }],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-10T10:00:00.000Z",
					updatedAt: "2026-08-10T10:00:00.000Z",
				},
			],
			hasMore: false,
		});
		await reconciler.reconcile(control);
		// Older than the kickoff window: the routine takes its ordinary slot instead.
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).toMatchObject({
			scheduledFor: "2026-08-24T09:00:00.000Z",
		});
		vi.mocked(control.enqueueRoutineWake).mockClear();

		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "weekly-monday",
							kind: "schedule",
							intervalMinutes: 10_080,
							weekdays: ["monday"],
							localTime: "09:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [{ triggerId: "weekly-monday" }],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-25T13:00:00.000Z",
					updatedAt: "2026-08-25T13:00:00.000Z",
				},
			],
			hasMore: false,
		});
		await reconciler.reconcile(control);
		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();
	});

	it("kicks off a new interval routine at its effective instant and then keeps the slot cadence", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [{ id: "schedule-main", kind: "schedule", intervalMinutes: 60 }],
					scheduleCursors: [{ triggerId: "schedule-main" }],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-25T10:20:00.000Z",
					updatedAt: "2026-08-25T10:20:00.000Z",
				},
			],
			hasMore: false,
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-25T10:25:00.000Z"),
		});

		await reconciler.reconcile(control);

		expect(control.enqueueRoutineWake).toHaveBeenCalledOnce();
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).toMatchObject({
			scheduledFor: "2026-08-25T10:20:00.000Z",
			nextDueAt: "2026-08-25T11:00:00.000Z",
		});
	});

	it("runs a routine whose member save restarted its schedule at the first new slot after the save, with no kickoff or catch-up", async () => {
		// A Monday routine last ran 2026-08-24; on Thursday a member made it a weekday
		// routine, so the kernel set the cursor at the save (to the millisecond) and one
		// millisecond later is due, which lists it at once.
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 2,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "brief",
							kind: "schedule",
							intervalMinutes: 1_440,
							weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
							localTime: "09:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [
						{
							triggerId: "brief",
							lastScheduledFor: "2026-08-27T10:15:30.123Z",
							nextDueAt: "2026-08-27T10:15:30.124Z",
						},
					],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-27T10:15:30.123Z",
					updatedAt: "2026-08-27T10:15:30.123Z",
				},
			],
			hasMore: false,
		});
		let now = new Date("2026-08-27T12:00:00.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now });

		await reconciler.reconcile(control);
		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();

		now = new Date("2026-08-28T09:05:00.000Z");
		await reconciler.reconcile(control);
		expect(control.enqueueRoutineWake).toHaveBeenCalledOnce();
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).toMatchObject({
			scheduledFor: "2026-08-28T09:00:00.000Z",
			expectedLastScheduledFor: "2026-08-27T10:15:30.123Z",
			nextDueAt: "2026-08-31T09:00:00.000Z",
			payload: { schema: "qorpera.routine-schedule-occurrence/v1", coalesced: 0 },
		});
	});

	it("raises a restart position to the new cadence's first slot, so the routine is not listed until then", async () => {
		// An hourly routine that last ran on Wednesday at 14:00 was loosened to weekly on
		// Monday 09:00; the kernel restarted its schedule at the save (to the millisecond),
		// due one millisecond later. Nothing is due for five days, so the scheduler raises
		// the next due time to that Monday instead of finding nothing on every poll.
		const control = controlPlane(undefined);
		const head: CloudRoutineScheduleHead = {
			...scheduleHead(),
			version: 4,
			triggers: [
				{
					id: "watch",
					kind: "schedule",
					intervalMinutes: 10_080,
					weekdays: ["monday"],
					localTime: "09:00",
					timeZone: "UTC",
				},
			],
			scheduleCursors: [
				{
					triggerId: "watch",
					lastScheduledFor: "2026-08-26T14:07:12.345Z",
					nextDueAt: "2026-08-26T14:07:12.346Z",
				},
			],
			effectiveAt: "2026-08-26T14:07:12.345Z",
		};
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: [head], hasMore: false });
		let now = new Date("2026-08-26T14:07:20.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now });

		await reconciler.reconcile(control);
		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();
		expect(control.advanceRoutineNextDue).toHaveBeenCalledOnce();
		expect(control.advanceRoutineNextDue).toHaveBeenCalledWith({
			routineId: head.routineId,
			expectedVersion: 4,
			triggerId: "watch",
			expectedLastScheduledFor: "2026-08-26T14:07:12.345Z",
			nextDueAt: "2026-08-31T09:00:00.000Z",
		});

		// Listed again before the slot (say beside another trigger that is due): the
		// cursor already waits for that slot, so there is nothing to raise.
		head.scheduleCursors = [
			{
				triggerId: "watch",
				lastScheduledFor: "2026-08-26T14:07:12.345Z",
				nextDueAt: "2026-08-31T09:00:00.000Z",
			},
		];
		now = new Date("2026-08-28T10:00:00.000Z");
		await reconciler.reconcile(control);
		expect(control.advanceRoutineNextDue).toHaveBeenCalledOnce();
		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();

		// At the slot the same position is compared, as before the raise.
		now = new Date("2026-08-31T09:00:30.000Z");
		await reconciler.reconcile(control);
		expect(control.advanceRoutineNextDue).toHaveBeenCalledOnce();
		expect(control.enqueueRoutineWake).toHaveBeenCalledOnce();
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).toMatchObject({
			scheduledFor: "2026-08-31T09:00:00.000Z",
			expectedLastScheduledFor: "2026-08-26T14:07:12.345Z",
			nextDueAt: "2026-09-07T09:00:00.000Z",
			payload: { schema: "qorpera.routine-schedule-occurrence/v1", coalesced: 0 },
		});
	});

	it("raises a fresh cursor that waits for a later start or a window, and never one that may still owe its kickoff", async () => {
		const control = controlPlane(undefined);
		const weekly = {
			kind: "schedule",
			intervalMinutes: 10_080,
			weekdays: ["monday"],
			localTime: "09:00",
			timeZone: "UTC",
		};
		const laterStart: CloudRoutineScheduleHead = {
			...scheduleHead("21212121-2121-4121-8121-212121212121"),
			version: 1,
			triggers: [{ id: "later-start", ...weekly, startAt: "2026-09-07T09:00:00.000Z" }],
			scheduleCursors: [{ triggerId: "later-start" }],
			effectiveAt: "2026-08-25T10:00:00.000Z",
		};
		const window: CloudRoutineScheduleHead = {
			...scheduleHead("31313131-3131-4131-8131-313131313131"),
			version: 1,
			triggers: [
				{
					id: "office-hours",
					kind: "schedule",
					intervalMinutes: 30,
					weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
					windowStart: "09:00",
					windowEnd: "10:00",
					timeZone: "UTC",
				},
			],
			scheduleCursors: [{ triggerId: "office-hours" }],
			effectiveAt: "2026-08-25T11:00:00.000Z",
		};
		// Saved a minute ahead of this orchestrator's clock: its kickoff is still owed.
		const notYetEffective: CloudRoutineScheduleHead = {
			...scheduleHead("41414141-4141-4141-8141-414141414141"),
			version: 1,
			triggers: [{ id: "not-yet", ...weekly }],
			scheduleCursors: [{ triggerId: "not-yet" }],
			effectiveAt: "2026-08-25T12:01:00.000Z",
		};
		// A start already reached when it was saved: the kickoff runs now.
		const kickoff: CloudRoutineScheduleHead = {
			...scheduleHead("51515151-5151-4151-8151-515151515151"),
			version: 1,
			triggers: [{ id: "kickoff", ...weekly, startAt: "2026-08-24T09:00:00.000Z" }],
			scheduleCursors: [{ triggerId: "kickoff" }],
			effectiveAt: "2026-08-25T10:00:00.000Z",
		};
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [laterStart, window, notYetEffective, kickoff],
			hasMore: false,
		});
		let now = new Date("2026-08-25T12:00:00.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now });

		await reconciler.reconcile(control);
		const advanced = vi.mocked(control.advanceRoutineNextDue).mock.calls.map(([input]) => input);
		expect(advanced).toEqual([
			{
				routineId: laterStart.routineId,
				expectedVersion: 1,
				triggerId: "later-start",
				nextDueAt: "2026-09-07T09:00:00.000Z",
			},
			{
				routineId: window.routineId,
				expectedVersion: 1,
				triggerId: "office-hours",
				nextDueAt: "2026-08-26T09:00:00.000Z",
			},
		]);
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls.map(([input]) => input)).toMatchObject([
			{ routineId: kickoff.routineId, scheduledFor: "2026-08-25T10:00:00.000Z" },
		]);

		// The cursor stays fresh, so at its first slot it runs that slot, not a kickoff.
		vi.mocked(control.enqueueRoutineWake).mockClear();
		vi.mocked(control.advanceRoutineNextDue).mockClear();
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: [laterStart], hasMore: false });
		now = new Date("2026-09-07T09:00:30.000Z");
		await reconciler.reconcile(control);
		expect(control.advanceRoutineNextDue).not.toHaveBeenCalled();
		expect(control.enqueueRoutineWake).toHaveBeenCalledOnce();
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).not.toHaveProperty("expectedLastScheduledFor");
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).toMatchObject({
			scheduledFor: "2026-09-07T09:00:00.000Z",
			nextDueAt: "2026-09-14T09:00:00.000Z",
		});
	});

	it("reports a failed first-slot advance without holding up other routines, and pauses asking a control plane that does not know it", async () => {
		const control = controlPlane(undefined);
		const restarted: CloudRoutineScheduleHead = {
			...scheduleHead(),
			scheduleCursors: [
				{
					triggerId: "schedule-main",
					lastScheduledFor: "2026-08-20T12:10:00.123Z",
					nextDueAt: "2026-08-20T12:10:00.124Z",
				},
			],
		};
		const due: CloudRoutineScheduleHead = {
			...scheduleHead("13131313-1313-4313-8313-131313131313"),
			scheduleCursors: [
				{
					triggerId: "schedule-main",
					lastScheduledFor: "2026-08-20T11:00:00.000Z",
					nextDueAt: "2026-08-20T12:00:00.000Z",
				},
			],
		};
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: [restarted, due], hasMore: false });
		const unavailable = new CloudRunnerOrchestratorRequestError(503);
		vi.mocked(control.advanceRoutineNextDue).mockRejectedValue(unavailable);
		let now = new Date("2026-08-20T12:30:00.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now });

		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [unavailable] });
		expect(control.advanceRoutineNextDue).toHaveBeenCalledWith(
			expect.objectContaining({
				routineId: restarted.routineId,
				expectedLastScheduledFor: "2026-08-20T12:10:00.123Z",
				nextDueAt: "2026-08-20T13:00:00.000Z",
			}),
		);
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls.map(([input]) => input)).toMatchObject([
			{ routineId: due.routineId, scheduledFor: "2026-08-20T12:00:00.000Z" },
		]);

		// A transient failure is asked again at the next poll.
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [unavailable] });
		expect(control.advanceRoutineNextDue).toHaveBeenCalledTimes(2);

		// An edge function that predates the action answers 400: reported, then the routine
		// is listed as before without an error on every poll, and asked again ten minutes
		// later in case the edge function was deployed meanwhile.
		const unknown = new CloudRunnerOrchestratorRequestError(400);
		vi.mocked(control.advanceRoutineNextDue).mockRejectedValue(unknown);
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [unknown] });
		now = new Date("2026-08-20T12:39:59.999Z");
		await expect(reconciler.reconcile(control)).resolves.toBeUndefined();
		expect(control.advanceRoutineNextDue).toHaveBeenCalledTimes(3);
		vi.mocked(control.advanceRoutineNextDue).mockResolvedValue({
			status: "advanced",
			nextDueAt: "2026-08-20T13:00:00.000Z",
		});
		now = new Date("2026-08-20T12:40:00.000Z");
		await expect(reconciler.reconcile(control)).resolves.toBeUndefined();
		expect(control.advanceRoutineNextDue).toHaveBeenCalledTimes(4);
		expect(control.enqueueRoutineWake).toHaveBeenCalledTimes(5);
	});

	it("raises a fresh window cursor to its first slot at or after the effective time when the database clock runs ahead", async () => {
		// The version was saved at 09:10 by the database's clock; this orchestrator reads
		// 08:58. The 09:00 slot is before the version, so its first slot is 09:30.
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					...scheduleHead(),
					version: 1,
					triggers: [
						{
							id: "office-hours",
							kind: "schedule",
							intervalMinutes: 30,
							windowStart: "09:00",
							windowEnd: "10:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [{ triggerId: "office-hours" }],
					effectiveAt: "2026-08-25T09:10:00.000Z",
				},
			],
			hasMore: false,
		});
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => new Date("2026-08-25T08:58:00.000Z") });

		await reconciler.reconcile(control);
		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();
		expect(control.advanceRoutineNextDue).toHaveBeenCalledWith(
			expect.objectContaining({ triggerId: "office-hours", nextDueAt: "2026-08-25T09:30:00.000Z" }),
		);
		expect(vi.mocked(control.advanceRoutineNextDue).mock.calls[0]?.[0]).not.toHaveProperty(
			"expectedLastScheduledFor",
		);
	});

	it.each(["optional", "required", "silent"])("enqueues %s weekday wakes", async (replyPolicy) => {
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "weekday-review",
							kind: "schedule",
							replyPolicy,
							intervalMinutes: 1_440,
							startAt: "2026-08-24T09:00:00.000Z",
							weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
							localTime: "09:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [{ triggerId: "weekday-review" }],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-21T08:00:00.000Z",
					updatedAt: "2026-08-21T08:00:00.000Z",
				},
			],
			hasMore: false,
		});
		let now = new Date("2026-08-21T12:00:00.000Z");
		const reconciler = new CloudRoutineScheduleReconciler({ now: () => now });

		await reconciler.reconcile(control);
		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();

		now = new Date("2026-08-24T09:30:00.000Z");
		await reconciler.reconcile(control);
		expect(control.enqueueRoutineWake).toHaveBeenCalledTimes(1);
		expect(vi.mocked(control.enqueueRoutineWake).mock.calls[0]?.[0]).toMatchObject({
			scheduledFor: "2026-08-24T09:00:00.000Z",
			nextDueAt: "2026-08-25T09:00:00.000Z",
		});
	});

	it.each(["optional", "required", "silent"])("enqueues %s window wakes", async (replyPolicy) => {
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "office-hours",
							kind: "schedule",
							replyPolicy,
							intervalMinutes: 30,
							months: [8],
							weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
							windowStart: "09:00",
							windowEnd: "10:00",
							timeZone: "UTC",
						},
					],
					scheduleCursors: [
						{
							triggerId: "office-hours",
							lastScheduledFor: "2026-08-21T10:00:00.000Z",
							nextDueAt: "2026-08-24T09:00:00.000Z",
						},
					],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-20T07:00:00.000Z",
					updatedAt: "2026-08-21T10:00:00.000Z",
				},
			],
			hasMore: false,
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-24T09:45:00.000Z"),
		});

		await reconciler.reconcile(control);

		expect(vi.mocked(control.enqueueRoutineWake).mock.calls.map(([input]) => input)).toMatchObject([
			{
				scheduledFor: "2026-08-24T09:00:00.000Z",
				nextDueAt: "2026-08-24T09:30:00.000Z",
			},
			{
				scheduledFor: "2026-08-24T09:30:00.000Z",
				nextDueAt: "2026-08-24T10:00:00.000Z",
			},
		]);
	});

	it("rejects noncanonical timestamps, malformed policies, and payload silence flags", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{ id: "infinite", kind: "schedule", intervalMinutes: 60, startAt: "infinity" },
						{ id: "relative", kind: "schedule", intervalMinutes: 60, startAt: "now" },
						{ id: "unknown-policy", kind: "schedule", intervalMinutes: 60, replyPolicy: "unknown" },
						{ id: "null-policy", kind: "schedule", intervalMinutes: 60, replyPolicy: null },
						{ id: "boolean-policy", kind: "schedule", intervalMinutes: 60, replyPolicy: false },
						{ id: "payload-flag", kind: "schedule", intervalMinutes: 60, silenceAllowed: true },
					],
					scheduleCursors: [
						{ triggerId: "infinite" },
						{ triggerId: "relative" },
						{ triggerId: "unknown-policy" },
						{ triggerId: "null-policy" },
						{ triggerId: "boolean-policy" },
						{ triggerId: "payload-flag" },
					],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-08-20T07:00:00.000Z",
					updatedAt: "2026-08-20T08:00:00.000Z",
				},
			],
			hasMore: false,
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T12:30:00.000Z"),
		});

		await reconciler.reconcile(control);

		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();
	});

	it("uses a private orchestrator bearer and parses immutable hosted work pins", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return Response.json(claimResponse());
		});
		const controlToken = "c".repeat(43);
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			controlToken,
			fakeFetch as typeof fetch,
		);

		await expect(control.claimNext(orchestratorId, claimId, 120)).resolves.toEqual(claim());
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://project.supabase.co/functions/v1/runner-orchestrator",
			init: { headers: { apikey: "publishable-key", authorization: `Bearer ${controlToken}` } },
		});
		expect(calls[0]?.init?.body).not.toContain(controlToken);
	});

	it("parses a folder-v2 run without snapshot or substrate ids, and refuses one without the other", async () => {
		const answer = (work: Record<string, unknown>) =>
			new SupabaseCloudRunnerOrchestratorControlPlane(
				"https://project.supabase.co",
				"publishable-key",
				orchestratorId,
				"c".repeat(43),
				vi.fn(async () => Response.json(claimResponse(claim(), work))) as typeof fetch,
			).claimNext(orchestratorId, claimId, 120);
		const folderWork = Object.fromEntries(
			Object.entries(claim().work).filter(([key]) => key !== "substrateVersionId" && key !== "companySnapshotId"),
		) as CloudRunnerWork;

		await expect(answer({ substrate_version_id: null, company_snapshot_id: null })).resolves.toStrictEqual({
			...claim(),
			work: folderWork,
		});
		// Keys left out entirely parse the same.
		await expect(answer({ substrate_version_id: undefined, company_snapshot_id: undefined })).resolves.toStrictEqual({
			...claim(),
			work: folderWork,
		});
		expect(() => validateCloudRunnerWork(folderWork)).not.toThrow();
		await expect(answer({ substrate_version_id: null })).rejects.toThrow("invalid substrate version id");
		await expect(answer({ company_snapshot_id: null })).rejects.toThrow("invalid Company File snapshot id");
		expect(() =>
			validateCloudRunnerWork({ ...folderWork, substrateVersionId: claim().work.substrateVersionId }),
		).toThrow("go together");
		expect(() => validateCloudRunnerWork({ ...claim().work, companySnapshotId: "not-a-uuid" })).toThrow(
			"Company snapshot id is invalid",
		);
	});

	it("recovers a lost control-token rotation response without storing plaintext in Supabase", async () => {
		const current = "c".repeat(43);
		const calls: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
		const persisted: Array<{ current: string; pending?: string }> = [];
		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const authorization = new Headers(init?.headers).get("authorization");
			calls.push({ authorization, body });
			if (calls.length === 1) return Response.json({ error: "response lost after commit" }, { status: 401 });
			return Response.json({ value: { status: "active" } });
		});
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			current,
			fakeFetch as typeof fetch,
			{
				persistControlTokens: async (state) => void persisted.push({ ...state }),
				onControlRotated: () => topics.push(control.wakeTopic()),
			},
		);
		const topics: string[] = [control.wakeTopic()];

		await control.renewControl();

		// The wake-up topic follows the new token as soon as the rotation is confirmed.
		expect(topics).toHaveLength(2);
		expect(topics[1]).not.toBe(topics[0]);
		expect(persisted).toHaveLength(2);
		const next = persisted[0]?.pending;
		expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(persisted).toEqual([{ current, pending: next }, { current: next }]);
		expect(calls.map((call) => call.authorization)).toEqual([`Bearer ${current}`, `Bearer ${next}`]);
		expect(calls[0]?.body).toMatchObject({
			action: "rotate_control",
			orchestratorId,
			controlTokenSeconds: 604_800,
			nextControlTokenSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(JSON.stringify(calls[0]?.body)).not.toContain(next);
	});

	it("reconciles, claims, assigns, and delivers one job-scoped capability", async () => {
		const control = controlPlane();
		const local = localAdapter();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await expect(orchestrator.runOnce()).resolves.toMatchObject({
			status: "assigned",
			claim: { claimId },
			runner: { runnerId },
			assignment: { assignmentId, jobId, runnerId },
		});
		expect(control.reconcileExpired).toHaveBeenCalledWith(orchestratorId);
		expect(local.reconcile).toHaveBeenCalledOnce();
		expect(vi.mocked(control.reconcileExpired).mock.invocationCallOrder[0]).toBeLessThan(
			local.reconcile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
		expect(control.claimNext).toHaveBeenCalledWith(orchestratorId, claimId, 120);
		expect(local.deliver).toHaveBeenCalledWith(
			expect.objectContaining({ runnerId }),
			expect.objectContaining({
				capability,
				assignment: expect.objectContaining({ assignmentId }),
				work: expect.objectContaining({ runId, jobId }),
			}),
		);
		expect(JSON.stringify(vi.mocked(control.assign).mock.calls)).not.toContain(capability);
	});

	it("renews the durable claim while a physical computer is provisioning", async () => {
		const control = controlPlane();
		const local = localAdapter();
		local.acquire.mockImplementationOnce(
			async (_work, signal: AbortSignal) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(
						() =>
							resolve({
								runnerId,
								logicalComputerId,
								workerClass: "managed_sandbox" as const,
								providerAdapter: "local",
								capabilities: ["agent_turn"] as const,
								templateKey: "qorpera-test",
								templateVersion: "test-v1",
								policySha256: "f".repeat(64),
							}),
						25,
					);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new Error("provisioning aborted"));
						},
						{ once: true },
					);
				}),
		);
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			claimLeaseSeconds: 30,
			claimRenewalIntervalMs: 10,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await expect(orchestrator.runOnce()).resolves.toMatchObject({ status: "assigned" });
		expect(control.renewClaim).toHaveBeenCalledWith(
			expect.objectContaining({ claimId }),
			30,
			expect.any(AbortSignal),
		);
	});

	it("aborts an in-flight renewClaim immediately when acquire finishes", async () => {
		const control = controlPlane();
		const local = localAdapter();
		let renewAborted = false;
		let renewStarted!: () => void;
		const renewGate = new Promise<void>((resolve) => {
			renewStarted = resolve;
		});
		vi.mocked(control.renewClaim).mockImplementation(
			(_c, _s, signal) =>
				new Promise((_resolve, reject) => {
					renewStarted();
					signal?.addEventListener(
						"abort",
						() => {
							renewAborted = true;
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		);
		local.acquire.mockImplementationOnce(async () => {
			await renewGate;
			return {
				runnerId,
				logicalComputerId,
				workerClass: "managed_sandbox" as const,
				providerAdapter: "local",
				capabilities: ["agent_turn"] as const,
				templateKey: "qorpera-test",
				templateVersion: "test-v1",
				policySha256: "f".repeat(64),
			};
		});
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			claimLeaseSeconds: 30,
			claimRenewalIntervalMs: 10,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});
		const began = performance.now();
		await expect(orchestrator.runOnce()).resolves.toMatchObject({ status: "assigned" });
		expect(renewAborted).toBe(true);
		expect(performance.now() - began).toBeLessThan(1_000);
	});

	describe("one answer for an idle pass's lists", () => {
		const environmentId = "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e";
		const profileId = "18181818-1818-4818-8818-181818181818";
		const quiet: Readonly<Record<string, boolean>> = {
			...Object.fromEntries(CLOUD_FOLDER_DRAINS.map(({ name }) => [name, false])),
			materialize: false,
			routine_heads: false,
		};
		/** A control plane with every list, each answering "nothing" unless a test says otherwise. */
		function folderControl(answers: Readonly<Record<string, boolean>> = quiet) {
			const control = controlPlane();
			vi.mocked(control.claimNext).mockResolvedValue(undefined);
			const readPassDue = vi.fn(async () => answers);
			const listDrain = vi.fn(
				async (_drain: string, _after: string | undefined, _limit: number): Promise<CloudFolderDrainPage> => ({
					items: [],
					hasMore: false,
				}),
			);
			const runDrain = vi.fn(async (): Promise<CloudFolderDrainResult> => ({ state: "done" }));
			const listMaterialization = vi.fn(async () => ({ items: [] as string[], hasMore: false }));
			const materialize = vi.fn(async () => ({ state: "done" as const, runIds: [] as string[] }));
			const listDynamic = vi.fn(async () => ({ items: [], hasMore: false }));
			control.readPassDue = readPassDue;
			control.listFolderDrainDue = listDrain;
			control.runFolderDrain = runDrain;
			control.listFolderMaterializationDue = listMaterialization;
			control.materializeFolderCompany = materialize;
			control.listFolderDynamicRoutines = listDynamic;
			control.restoreFolderDynamicRoutineRun = vi.fn(async () => ({ status: "gone" as const }));
			const orchestrator = new CloudRunnerOrchestrator({
				orchestratorId,
				controlPlane: control,
				providerAdapter: localAdapter().adapter,
			});
			const listed = () => listDrain.mock.calls.map(([drain]) => drain);
			return {
				control,
				orchestrator,
				readPassDue,
				listDrain,
				runDrain,
				listMaterialization,
				materialize,
				listDynamic,
				listed,
			};
		}

		it("asks one call and no list when nothing is due, and still reconciles and claims", async () => {
			const f = folderControl();
			await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle" });
			expect(f.readPassDue).toHaveBeenCalledTimes(1);
			expect(f.listed()).toEqual([]);
			expect(f.listMaterialization).not.toHaveBeenCalled();
			expect(f.control.listRoutineScheduleHeads).not.toHaveBeenCalled();
			expect(f.control.reconcileExpired).toHaveBeenCalledTimes(1);
			expect(f.control.retainedClaims).toHaveBeenCalledTimes(1);
			expect(f.control.claimNext).toHaveBeenCalledTimes(1);
			// The dynamic routines keep their own 30 s timer: the one call does not answer for them.
			expect(f.listDynamic).toHaveBeenCalledTimes(1);
		});

		it("lists only the drain that is due while nothing has run", async () => {
			const f = folderControl({ ...quiet, machine_checkins: true });
			await f.orchestrator.runOnce();
			expect(f.listed()).toEqual(["machine_checkins"]);
			expect(f.runDrain).not.toHaveBeenCalled();
			expect(f.listMaterialization).not.toHaveBeenCalled();
			expect(f.control.listRoutineScheduleHeads).not.toHaveBeenCalled();
		});

		it("asks every later list once a step ran, so a drain's work is taken in the same pass", async () => {
			// The listener marks human tasks and a drain admits wakes the materializer takes: the answer predates both.
			const f = folderControl({ ...quiet, listen: true });
			f.listDrain.mockImplementation(async (drain) => ({
				items: drain === "listen" ? [environmentId] : [],
				hasMore: false,
			}));
			await f.orchestrator.runOnce();
			const names = CLOUD_FOLDER_DRAINS.map(({ name }) => name);
			expect(f.listed()).toEqual(names.slice(names.indexOf("listen")));
			expect(f.runDrain).toHaveBeenCalledTimes(1);
			expect(f.listMaterialization).toHaveBeenCalledTimes(1);
			expect(f.control.listRoutineScheduleHeads).toHaveBeenCalledTimes(1);
		});

		it("materializes when only the materializer is due, and lists the heads when only they are", async () => {
			const f = folderControl({ ...quiet, materialize: true });
			f.listMaterialization.mockResolvedValue({ items: [profileId], hasMore: false });
			await f.orchestrator.runOnce();
			expect(f.listed()).toEqual([]);
			expect(f.materialize).toHaveBeenCalledTimes(1);
			// The materialization is a step that ran: the heads, though their answer was false, are asked after it.
			expect(f.control.listRoutineScheduleHeads).toHaveBeenCalledTimes(1);
			// An answer of true whose list has nothing by the time it is read runs no step: the heads stay out.
			const empty = folderControl({ ...quiet, materialize: true });
			await empty.orchestrator.runOnce();
			expect(empty.listMaterialization).toHaveBeenCalledTimes(1);
			expect(empty.control.listRoutineScheduleHeads).not.toHaveBeenCalled();
			const heads = folderControl({ ...quiet, routine_heads: true });
			await heads.orchestrator.runOnce();
			expect(heads.listed()).toEqual([]);
			expect(heads.listMaterialization).not.toHaveBeenCalled();
			expect(heads.control.listRoutineScheduleHeads).toHaveBeenCalledTimes(1);
		});

		it("lists a drain the answer does not name", async () => {
			const { events: _events, ...withoutEvents } = quiet;
			const f = folderControl(withoutEvents);
			await f.orchestrator.runOnce();
			expect(f.listed()).toEqual(["events"]);
		});

		it("asks every list itself when the call fails, and reports the failure once per wait", async () => {
			const outage = new CloudRunnerOrchestratorRequestError(503);
			const f = folderControl();
			const start = Date.parse("2026-11-07T06:00:00.000Z");
			f.readPassDue.mockRejectedValue(outage);
			vi.useFakeTimers({ toFake: ["Date"], now: start });
			try {
				await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle", reconciliationErrors: [outage] });
				expect(f.listed()).toEqual(CLOUD_FOLDER_DRAINS.map(({ name }) => name));
				expect(f.listMaterialization).toHaveBeenCalledTimes(1);
				expect(f.control.listRoutineScheduleHeads).toHaveBeenCalledTimes(1);
				// Within the wait a pass is the pass without the call: no call, no report, every list.
				vi.setSystemTime(start + 999);
				f.listDrain.mockClear();
				await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle" });
				expect(f.readPassDue).toHaveBeenCalledTimes(1);
				expect(f.listed()).toEqual(CLOUD_FOLDER_DRAINS.map(({ name }) => name));
				// The wait doubles: 1 s, then 2 s, then 4 s, as a failing drain's does.
				vi.setSystemTime(start + 1_000);
				await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle", reconciliationErrors: [outage] });
				expect(f.readPassDue).toHaveBeenCalledTimes(2);
				vi.setSystemTime(start + 2_999);
				await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle" });
				expect(f.readPassDue).toHaveBeenCalledTimes(2);
				vi.setSystemTime(start + 3_000);
				await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle", reconciliationErrors: [outage] });
				expect(f.readPassDue).toHaveBeenCalledTimes(3);
				vi.setSystemTime(start + 6_999);
				await f.orchestrator.runOnce();
				expect(f.readPassDue).toHaveBeenCalledTimes(3);
				// An answer ends it: the pass leaves its lists out again, and the next failure waits 1 s, not 8 s.
				vi.setSystemTime(start + 7_000);
				f.readPassDue.mockResolvedValueOnce(quiet);
				f.listDrain.mockClear();
				await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle" });
				expect(f.readPassDue).toHaveBeenCalledTimes(4);
				expect(f.listed()).toEqual([]);
				await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle", reconciliationErrors: [outage] });
				expect(f.readPassDue).toHaveBeenCalledTimes(5);
				vi.setSystemTime(start + 8_000);
				await f.orchestrator.runOnce();
				expect(f.readPassDue).toHaveBeenCalledTimes(6);
			} finally {
				vi.useRealTimers();
			}
		});

		it("never waits longer than five minutes between tries of a failing call", async () => {
			const f = folderControl();
			const start = Date.parse("2026-11-07T06:00:00.000Z");
			f.readPassDue.mockRejectedValue(new CloudRunnerOrchestratorRequestError(503));
			vi.useFakeTimers({ toFake: ["Date"], now: start });
			try {
				let now = start;
				for (let failure = 1; failure <= 12; failure++) {
					await f.orchestrator.runOnce();
					expect(f.readPassDue).toHaveBeenCalledTimes(failure);
					now += Math.min(5 * 60_000, 1_000 * 2 ** (failure - 1));
					vi.setSystemTime(now - 1);
					await f.orchestrator.runOnce();
					expect(f.readPassDue).toHaveBeenCalledTimes(failure);
					vi.setSystemTime(now);
				}
			} finally {
				vi.useRealTimers();
			}
		});

		it("waits and asks every list on an answer that is not one, like any other failure", async () => {
			const f = folderControl();
			const invalid = new Error("Runner orchestrator returned an invalid due summary");
			f.readPassDue.mockRejectedValueOnce(invalid);
			await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle", reconciliationErrors: [invalid] });
			expect(f.listed()).toEqual(CLOUD_FOLDER_DRAINS.map(({ name }) => name));
			await f.orchestrator.runOnce();
			expect(f.readPassDue).toHaveBeenCalledTimes(1);
		});

		it("stops the pass when it is shut down during the call, without asking a list or starting a wait", async () => {
			const f = folderControl();
			const stop = new AbortController();
			const stopped = new Error("stopped");
			f.readPassDue.mockImplementationOnce(async () => {
				stop.abort();
				throw stopped;
			});
			await expect(f.orchestrator.runOnce(stop.signal)).rejects.toBe(stopped);
			expect(f.listed()).toEqual([]);
			expect(f.listMaterialization).not.toHaveBeenCalled();
			expect(f.control.listRoutineScheduleHeads).not.toHaveBeenCalled();
			expect(f.control.reconcileExpired).not.toHaveBeenCalled();
			// No wait began: a later pass asks at once.
			await f.orchestrator.runOnce();
			expect(f.readPassDue).toHaveBeenCalledTimes(2);
		});

		it("reports once and does not ask again for ten minutes when the edge function does not know the call", async () => {
			const f = folderControl();
			const unknown = new CloudRunnerOrchestratorRequestError(400);
			f.readPassDue.mockRejectedValue(unknown);
			vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-07T06:00:00.000Z") });
			try {
				await expect(f.orchestrator.runOnce()).resolves.toEqual({
					status: "idle",
					reconciliationErrors: [unknown],
				});
				expect(f.listed()).toEqual(CLOUD_FOLDER_DRAINS.map(({ name }) => name));
				vi.setSystemTime(Date.parse("2026-11-07T06:09:59.000Z"));
				await expect(f.orchestrator.runOnce()).resolves.toEqual({ status: "idle" });
				expect(f.readPassDue).toHaveBeenCalledTimes(1);
				vi.setSystemTime(Date.parse("2026-11-07T06:10:00.000Z"));
				f.readPassDue.mockResolvedValue(quiet);
				f.listDrain.mockClear();
				await f.orchestrator.runOnce();
				expect(f.readPassDue).toHaveBeenCalledTimes(2);
				expect(f.listed()).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("clears a drain's wait when the answer says its list is empty", async () => {
			const outage = new CloudRunnerOrchestratorRequestError(503);
			const f = folderControl();
			let now = new Date("2026-11-07T06:00:00.000Z");
			const drains = new CloudFolderDrains({ now: () => now, drains: [{ name: "listen", companyLimit: 8 }] });
			f.listDrain.mockRejectedValueOnce(outage);
			await expect(drains.reconcile(f.control)).rejects.toMatchObject({ errors: [outage] });
			// Waiting: neither the answer nor the list is consulted.
			await expect(
				drains.reconcile(f.control, undefined, new CloudOrchestratorPassDue({ listen: true })),
			).resolves.toBeUndefined();
			expect(f.listDrain).toHaveBeenCalledTimes(1);
			// The wait over, an empty answer counts as a list that answered: the next failure waits 1 s again, not 2 s.
			now = new Date("2026-11-07T06:00:01.000Z");
			await expect(
				drains.reconcile(f.control, undefined, new CloudOrchestratorPassDue({ listen: false })),
			).resolves.toBeUndefined();
			expect(f.listDrain).toHaveBeenCalledTimes(1);
			f.listDrain.mockRejectedValueOnce(outage);
			await expect(drains.reconcile(f.control)).rejects.toMatchObject({ errors: [outage] });
			now = new Date("2026-11-07T06:00:02.000Z");
			await expect(drains.reconcile(f.control)).resolves.toBeUndefined();
			expect(f.listDrain).toHaveBeenCalledTimes(3);
		});

		it("reads the answer through the private control plane and refuses one that is not yes or no", async () => {
			const requests: unknown[] = [];
			const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
				requests.push(JSON.parse(String(init?.body)));
				return Response.json({ value: { listen: true, workers: false } });
			});
			const control = new SupabaseCloudRunnerOrchestratorControlPlane(
				"https://project.supabase.co",
				"publishable-key",
				orchestratorId,
				"c".repeat(43),
				fakeFetch as typeof fetch,
			);
			await expect(control.readPassDue()).resolves.toEqual({ listen: true, workers: false });
			expect(requests).toEqual([{ action: "due_summary", orchestratorId }]);
			fakeFetch.mockImplementationOnce(async () => Response.json({ value: { listen: "yes" } }));
			await expect(control.readPassDue()).rejects.toThrow("invalid due summary");
			fakeFetch.mockImplementationOnce(async () => Response.json({ value: [] }));
			await expect(control.readPassDue()).rejects.toThrow();
		});
	});

	it("reconciles durable occurrence sources before it claims compute work", async () => {
		const control = controlPlane();
		vi.mocked(control.claimNext).mockResolvedValue(undefined);
		const local = localAdapter();
		const occurrenceReconciler = { reconcile: vi.fn(async () => undefined) };
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			occurrenceReconcilers: [occurrenceReconciler],
		});

		await expect(orchestrator.runOnce()).resolves.toEqual({ status: "idle" });
		expect(occurrenceReconciler.reconcile).toHaveBeenCalledWith(control);
		expect(occurrenceReconciler.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(control.reconcileExpired).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
	});

	it("materializes the due folder-v2 companies on every pass, before it claims compute work", async () => {
		const profileId = "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d";
		const control = controlPlane();
		vi.mocked(control.claimNext).mockResolvedValue(undefined);
		const materialize = vi.fn(async (): Promise<CloudFolderMaterialization> => ({ state: "done", runIds: [runId] }));
		control.listFolderMaterializationDue = vi.fn(
			async (): Promise<CloudFolderMaterializationPage> => ({ items: [profileId], hasMore: false }),
		);
		control.materializeFolderCompany = materialize;
		const local = localAdapter();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
		});

		await expect(orchestrator.runOnce()).resolves.toEqual({ status: "idle" });
		expect(materialize).toHaveBeenCalledWith(profileId, 16);
		expect(materialize.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(control.claimNext).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
	});

	it("reuses a durable retained claim before looking for new work", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.retainedClaims).mockResolvedValue([claim()]);
		const local = localAdapter();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await expect(orchestrator.runOnce()).resolves.toMatchObject({ status: "assigned" });
		expect(control.claimNext).not.toHaveBeenCalled();
	});

	it("waits for an already delivered assignment instead of provisioning a duplicate computer", async () => {
		const retained = claim();
		retained.status = "assigned";
		const control = controlPlane(undefined);
		vi.mocked(control.retainedClaims).mockResolvedValue([retained]);
		const local = localAdapter();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
		});

		await expect(orchestrator.runOnce()).resolves.toMatchObject({ status: "awaiting_assignment" });
		expect(local.acquire).not.toHaveBeenCalled();
		expect(control.assign).not.toHaveBeenCalled();
	});

	it("retries an assignment that raced the runner's activation after 50 ms, then doubling", async () => {
		const control = controlPlane();
		const assign = control.assign;
		const racing = new CloudRunnerOrchestratorRequestError(423);
		let attempts = 0;
		control.assign = vi.fn(async (...args: Parameters<typeof assign>) => {
			if (++attempts < 3) throw racing;
			return assign(...args);
		});
		const waits: number[] = [];
		const setTimer = globalThis.setTimeout;
		const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
			if (attempts > 0 && attempts < 3) waits.push(delay ?? 0);
			return setTimer(callback, delay);
		}) as typeof setTimeout);
		const local = localAdapter();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		try {
			await expect(orchestrator.runOnce()).resolves.toMatchObject({ status: "assigned" });
		} finally {
			timers.mockRestore();
		}
		expect(attempts).toBe(3);
		// 50 ms, then 100 ms (the former first wait was 250 ms).
		expect(waits).toEqual([50, 100]);
		expect(local.deliver).toHaveBeenCalledOnce();
	});

	it("asks for new work on every poll without waiting for the slower reconcile", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.claimNext)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(claim());
		const local = localAdapter();
		const controller = new AbortController();
		local.deliver.mockImplementationOnce(async () => {
			controller.abort();
			return undefined;
		});
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, { pollIntervalMs: 10, reconcileIntervalMs: 60_000 });
		expect(control.claimNext).toHaveBeenCalledTimes(4);
		expect(control.reconcileExpired).toHaveBeenCalledOnce();
		expect(local.reconcile).toHaveBeenCalledOnce();
		expect(control.retainedClaims).toHaveBeenCalledOnce();
		expect(local.deliver).toHaveBeenCalledOnce();
	});

	it("keeps asking for new work while a reconcile pass is still running", async () => {
		// A provider's reconcile can wait on a machine it is starting; claims must not wait with it.
		const control = controlPlane(undefined);
		vi.mocked(control.claimNext)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(claim())
			.mockResolvedValue(undefined);
		const local = localAdapter();
		let finishPass = (): void => undefined;
		local.reconcile
			.mockImplementationOnce(async () => undefined)
			.mockImplementationOnce(
				() =>
					new Promise<undefined>((resolvePass) => {
						finishPass = () => resolvePass(undefined);
					}),
			);
		const controller = new AbortController();
		local.deliver.mockImplementationOnce(async () => {
			controller.abort();
		});
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		const running = orchestrator.run(controller.signal, {
			pollIntervalMs: 10,
			reconcileIntervalMs: 10,
			shutdownGraceMs: 10,
		});
		await running;
		finishPass();
		expect(local.reconcile).toHaveBeenCalledTimes(2);
		expect(local.deliver).toHaveBeenCalledOnce();
		expect(vi.mocked(control.claimNext).mock.invocationCallOrder.at(-1)).toBeGreaterThan(
			local.reconcile.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
		);
	});

	it("reconciles on the next poll after a dispatch fails instead of waiting for the interval", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.claimNext).mockResolvedValueOnce(claim()).mockResolvedValue(undefined);
		const local = localAdapter();
		local.acquire.mockRejectedValueOnce(new Error("Sandbox start failed"));
		const controller = new AbortController();
		// The retained claims are read again after that reconcile, before any new work.
		vi.mocked(control.retainedClaims).mockImplementation(async () => {
			if (vi.mocked(control.retainedClaims).mock.calls.length >= 2) controller.abort();
			return [];
		});
		const onError = vi.fn();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		const started = performance.now();
		await orchestrator.run(controller.signal, { pollIntervalMs: 10, reconcileIntervalMs: 60_000, onError });
		expect(control.reconcileExpired).toHaveBeenCalledTimes(2);
		expect(performance.now() - started).toBeLessThan(30_000);
		expect(onError).toHaveBeenCalled();
		expect(control.retainedClaims).toHaveBeenCalledTimes(2);
		expect(vi.mocked(control.retainedClaims).mock.invocationCallOrder[1]).toBeGreaterThan(
			vi.mocked(control.reconcileExpired).mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
		);
		// No new work is asked for between the failed dispatch and that reconcile.
		const failed = local.acquire.mock.invocationCallOrder[0] ?? 0;
		const reconciled = vi.mocked(control.reconcileExpired).mock.invocationCallOrder[1] ?? 0;
		expect(
			vi.mocked(control.claimNext).mock.invocationCallOrder.every((order) => order < failed || order > reconciled),
		).toBe(true);
	});

	it.each([
		{
			name: "a typed admission refusal",
			failure: new CloudRunnerProviderRequestError(
				422,
				{ state: "deferred", reason: "SANDBOX_CAPACITY_EXHAUSTED" },
				"acquire",
			),
			released: "ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED",
		},
		{
			// A fast host that cannot provision an attempt another provider holds: not typed, but deferred (20260930563000).
			name: "a plain failure the control plane deferred",
			failure: new CloudRunnerProviderRequestError(422, undefined, "acquire"),
			released: "Runner provider request failed (422) [code=PROVIDER_ACQUIRE]",
		},
	])("keeps claiming through a reconcile pass after $name", async ({ failure, released }) => {
		// No machine started and the job waits by its own deferral, and the pass may be materializing a burst of wakes
		// (6 Nov 2026: 11.3 s).
		const control = controlPlane(undefined);
		vi.mocked(control.claimNext)
			.mockResolvedValueOnce(claim())
			.mockResolvedValueOnce(claim())
			.mockResolvedValue(undefined);
		vi.mocked(control.releaseClaim).mockResolvedValueOnce({ deferred: true });
		const local = localAdapter();
		local.reconcile
			.mockImplementationOnce(async () => undefined)
			.mockImplementation(() => new Promise<undefined>(() => undefined));
		local.acquire.mockRejectedValueOnce(failure);
		const controller = new AbortController();
		const giveUp = setTimeout(() => controller.abort(), 3_000);
		local.deliver.mockImplementationOnce(async () => {
			controller.abort();
		});
		const onError = vi.fn();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, {
			pollIntervalMs: 10,
			reconcileIntervalMs: 10,
			shutdownGraceMs: 10,
			onError,
		});
		clearTimeout(giveUp);
		expect(control.releaseClaim).toHaveBeenCalledWith(expect.anything(), assignmentId, released);
		expect(onError).toHaveBeenCalledWith(failure);
		// The next claim went out and was delivered while the pass was still running.
		expect(local.deliver).toHaveBeenCalledOnce();
	});

	it.each([
		{ name: "was lost", release: () => Promise.reject(new Error("Control plane unavailable")) },
		{ name: "was not deferred", release: () => Promise.resolve({ deferred: false }) },
	])("holds claims for the next pass after a refusal whose release $name", async ({ release }) => {
		// A lost release leaves a retained claim behind, and a counted failure may leave a sandbox.
		const control = controlPlane(undefined);
		vi.mocked(control.claimNext).mockResolvedValueOnce(claim()).mockResolvedValue(claim());
		vi.mocked(control.releaseClaim).mockImplementationOnce(release);
		const local = localAdapter();
		local.reconcile
			.mockImplementationOnce(async () => undefined)
			.mockImplementation(() => new Promise<undefined>(() => undefined));
		local.acquire.mockRejectedValueOnce(
			new CloudRunnerProviderRequestError(
				422,
				{ state: "deferred", reason: "SANDBOX_CAPACITY_EXHAUSTED" },
				"acquire",
			),
		);
		const controller = new AbortController();
		const giveUp = setTimeout(() => controller.abort(), 200);
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, {
			pollIntervalMs: 10,
			reconcileIntervalMs: 10,
			shutdownGraceMs: 10,
			onError: () => undefined,
		});
		clearTimeout(giveUp);
		expect(control.claimNext).toHaveBeenCalledOnce();
		expect(local.deliver).not.toHaveBeenCalled();
	});

	it.each([
		{ answer: { released: true, deferred: true, dispatch_failure_count: 0, terminal: false }, deferred: true },
		{ answer: { released: true, dispatch_failure_count: 1, terminal: false }, deferred: false },
		{ answer: null, deferred: false },
	])("reads a release's deferral from the control plane: $deferred", async ({ answer, deferred }) => {
		const fetchImplementation = vi.fn(
			async () => new Response(JSON.stringify({ value: answer }), { status: 200 }),
		) as unknown as typeof fetch;
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://example.supabase.co",
			"publishable",
			orchestratorId,
			"a".repeat(43),
			fetchImplementation,
		);
		await expect(control.releaseClaim(claim(), assignmentId, "ADMISSION_REFUSED:SANDBOX_RETIRING")).resolves.toEqual({
			deferred,
		});
	});

	it("retries a failed reconcile on the next poll and claims nothing until it succeeds", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.reconcileExpired).mockRejectedValueOnce(new Error("Control plane unavailable"));
		vi.mocked(control.claimNext).mockResolvedValueOnce(claim());
		const local = localAdapter();
		const controller = new AbortController();
		local.deliver.mockImplementationOnce(async () => {
			controller.abort();
			return undefined;
		});
		const onError = vi.fn();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, { pollIntervalMs: 10, reconcileIntervalMs: 60_000, onError });
		expect(onError).toHaveBeenCalledOnce();
		expect(control.reconcileExpired).toHaveBeenCalledTimes(2);
		expect(vi.mocked(control.claimNext).mock.invocationCallOrder[0]).toBeGreaterThan(
			vi.mocked(control.reconcileExpired).mock.invocationCallOrder[1],
		);
		expect(local.deliver).toHaveBeenCalledOnce();
	});

	it.each([401, 503])("isolates persistent enqueue %i failures from later schedules and dispatch", async (status) => {
		const control = controlPlane();
		const blocked = scheduleHead();
		const independent = scheduleHead("13131313-1313-4313-8313-131313131313");
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: [blocked, independent], hasMore: false });
		const failure = new CloudRunnerOrchestratorRequestError(status);
		vi.mocked(control.enqueueRoutineWake).mockImplementation(async (input) => {
			if (input.routineId === blocked.routineId) throw failure;
			return { occurrenceId: input.occurrenceId, status: "queued", scheduledFor: input.scheduledFor };
		});
		vi.mocked(control.claimNext)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(claim())
			.mockResolvedValue(undefined);
		const occurrenceReconciler = { reconcile: vi.fn(async () => undefined) };
		const controller = new AbortController();
		const local = localAdapter(vi.fn(async () => controller.abort()));
		let errorCount = 0;
		const onError = vi.fn((_error: unknown) => {
			errorCount += 1;
			if (errorCount >= 4) controller.abort();
		});
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			occurrenceReconcilers: [occurrenceReconciler],
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, { pollIntervalMs: 20, reconcileIntervalMs: 10, onError });

		expect(vi.mocked(control.enqueueRoutineWake).mock.calls.map(([input]) => input.routineId)).toEqual([
			blocked.routineId,
			independent.routineId,
			blocked.routineId,
			independent.routineId,
		]);
		expect(onError.mock.calls.map(([error]) => error)).toEqual([failure, failure]);
		expect(occurrenceReconciler.reconcile).toHaveBeenCalledTimes(2);
		expect(control.reconcileExpired).toHaveBeenCalledTimes(2);
		expect(local.reconcile).toHaveBeenCalledTimes(2);
		expect(control.claimNext).toHaveBeenCalledTimes(2);
		expect(local.deliver).toHaveBeenCalledOnce();
	});

	it("returns admission errors beside a successful single-poll dispatch", async () => {
		const control = controlPlane();
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: [scheduleHead()], hasMore: false });
		const failure = new CloudRunnerOrchestratorRequestError(401);
		vi.mocked(control.enqueueRoutineWake).mockRejectedValue(failure);
		const local = localAdapter();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await expect(orchestrator.runOnce()).resolves.toMatchObject({
			status: "assigned",
			reconciliationErrors: [failure],
		});
		expect(control.reconcileExpired).toHaveBeenCalledOnce();
		expect(local.deliver).toHaveBeenCalledOnce();
	});

	it("preserves fatal schedule-discovery errors instead of dispatching through them", async () => {
		const control = controlPlane();
		const failure = new CloudRunnerOrchestratorRequestError(401);
		vi.mocked(control.listRoutineScheduleHeads).mockRejectedValue(failure);
		const local = localAdapter();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
		});

		await expect(orchestrator.runOnce()).rejects.toBe(failure);
		expect(control.reconcileExpired).not.toHaveBeenCalled();
		expect(control.claimNext).not.toHaveBeenCalled();
	});

	it("dispatches independent durable claims concurrently after one reconciliation pass", async () => {
		const first = claim();
		const second = claim();
		second.claimId = "23232323-2323-4232-8232-232323232323";
		second.work.runId = "34343434-3434-4434-8434-343434343434";
		second.work.jobId = "45454545-4545-4454-8454-454545454545";
		second.work.sourceId = "56565656-5656-4656-8656-565656565656";
		const control = controlPlane(undefined);
		vi.mocked(control.claimNext)
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(second)
			.mockResolvedValue(undefined);
		const controller = new AbortController();
		let deliveries = 0;
		const local = localAdapter(
			vi.fn(async () => {
				deliveries += 1;
				if (deliveries === 2) controller.abort();
			}),
		);
		const assignmentIds = ["77777777-7777-4777-8777-777777777777", "78787878-7878-4878-8878-787878787878"];
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			dispatchConcurrency: 2,
			clientAssignmentId: () => assignmentIds.shift() ?? assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, { pollIntervalMs: 10, shutdownGraceMs: 10 });

		expect(local.deliver).toHaveBeenCalledTimes(2);
		expect(control.reconcileExpired).toHaveBeenCalledOnce();
		expect(control.listRoutineScheduleHeads).toHaveBeenCalledOnce();
	});

	it("does not redispatch a retained claim while its first provider lane is still in flight", async () => {
		const retained = claim();
		const control = controlPlane(undefined);
		vi.mocked(control.retainedClaims).mockResolvedValue([retained]);
		vi.mocked(control.claimNext).mockResolvedValue(undefined);
		const controller = new AbortController();
		vi.mocked(control.reconcileExpired).mockImplementation(async () => {
			if (vi.mocked(control.reconcileExpired).mock.calls.length >= 3) controller.abort();
		});
		const local = localAdapter();
		local.acquire.mockImplementation(() => new Promise(() => undefined));
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			dispatchConcurrency: 2,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, { pollIntervalMs: 10, shutdownGraceMs: 10 });

		expect(local.acquire).toHaveBeenCalledOnce();
		expect(control.assign).not.toHaveBeenCalled();
	});

	it("continues reconciliation while a provider delivery lane is hung", async () => {
		const control = controlPlane();
		vi.mocked(control.claimNext).mockResolvedValueOnce(claim()).mockResolvedValue(undefined);
		const controller = new AbortController();
		vi.mocked(control.reconcileExpired).mockImplementation(async () => {
			if (vi.mocked(control.reconcileExpired).mock.calls.length >= 2) controller.abort();
		});
		const local = localAdapter(vi.fn(() => new Promise<void>(() => undefined)));
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, { pollIntervalMs: 10, shutdownGraceMs: 10 });

		expect(local.deliver).toHaveBeenCalledOnce();
		expect(control.reconcileExpired).toHaveBeenCalledTimes(2);
	});

	it("marks delivery failure and recycles the physical runner without exposing the capability", async () => {
		const control = controlPlane();
		const local = localAdapter(
			vi.fn(async () => {
				throw Object.assign(new Error(`provisioning failed for ${capability}`), { status: 422 });
			}),
		);
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await expect(orchestrator.runOnce()).rejects.toThrow("[redacted]");
		expect(control.releaseClaim).toHaveBeenCalledWith(
			expect.objectContaining({ claimId }),
			assignmentId,
			expect.not.stringContaining(capability),
		);
		expect(local.stop).toHaveBeenCalledWith(expect.objectContaining({ runnerId }), "delivery_failed");
	});

	it("keeps the worker alive when a delivery acknowledgment times out with an unknown outcome", async () => {
		const control = controlPlane();
		const local = localAdapter(
			vi.fn(async () => {
				throw new Error("The operation was aborted due to timeout");
			}),
		);
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await expect(orchestrator.runOnce()).rejects.toThrow("aborted due to timeout");
		expect(control.releaseClaim).not.toHaveBeenCalled();
		expect(local.stop).not.toHaveBeenCalled();
	});

	it("keeps autonomous work queued when its sponsor does not permit it", async () => {
		const autonomous = claim();
		autonomous.work.sourceKind = "wake";
		autonomous.work.inputIds = [];
		autonomous.work.sponsor.allowAutonomous = false;
		const control = controlPlane(autonomous);
		const local = localAdapter();
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			clientClaimId: () => claimId,
		});

		await expect(orchestrator.runOnce()).rejects.toThrow("does not permit autonomous work");
		expect(local.acquire).not.toHaveBeenCalled();
	});

	it("runs independent companies concurrently within a drain or materialization page with bounded concurrency, page-order errors and clean abort settling", async () => {
		const ids = Array.from({ length: 6 }, (_, i) => `90000000-0000-4000-8000-00000000000${i + 1}`);
		let inFlight = 0;
		let maxInFlight = 0;
		let releaseFour!: () => void;
		const fourReached = new Promise<void>((resolve) => {
			let seen = 0;
			releaseFour = () => {
				seen++;
				if (seen === 4) resolve();
			};
		});
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const errFirst = new CloudRunnerOrchestratorRequestError(503);
		const errFourth = new CloudRunnerOrchestratorRequestError(502);
		const control = controlPlane();
		control.listFolderDrainDue = vi.fn(async () => ({ items: ids, hasMore: false }));
		control.runFolderDrain = vi.fn(async (_drain, environmentId) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			releaseFour();
			if (environmentId === ids[3]) {
				inFlight--;
				throw errFourth;
			}
			await gate;
			inFlight--;
			if (environmentId === ids[0]) throw errFirst;
			return { state: "done" };
		});
		const drains = new CloudFolderDrains({
			drains: [{ name: "listen", companyLimit: 8 }],
			concurrency: 4,
		});
		const running = drains.reconcile(control);
		await fourReached;
		expect(maxInFlight).toBe(4);
		openGate();
		await expect(running).rejects.toMatchObject({ errors: [errFirst, errFourth] });

		let matInFlight = 0;
		let matMaxInFlight = 0;
		let matReleaseFour!: () => void;
		const matFourReached = new Promise<void>((resolve) => {
			let seen = 0;
			matReleaseFour = () => {
				seen++;
				if (seen === 4) resolve();
			};
		});
		let matOpenGate!: () => void;
		const matGate = new Promise<void>((resolve) => {
			matOpenGate = resolve;
		});
		const matControl = controlPlane();
		matControl.listFolderMaterializationDue = vi.fn(async () => ({ items: ids, hasMore: false }));
		matControl.materializeFolderCompany = vi.fn(async () => {
			matInFlight++;
			matMaxInFlight = Math.max(matMaxInFlight, matInFlight);
			matReleaseFour();
			await matGate;
			matInFlight--;
			return { state: "idle" as const, runIds: [] };
		});
		const materializer = new CloudFolderRunMaterializer({ concurrency: 4 });
		const matRunning = materializer.reconcile(matControl);
		await matFourReached;
		expect(matMaxInFlight).toBe(4);
		matOpenGate();
		await expect(matRunning).resolves.toBeUndefined();

		const ac = new AbortController();
		let startedOnAbort = 0;
		let settledOnAbort = 0;
		let releaseAborted!: () => void;
		const abortGate = new Promise<void>((resolve) => {
			releaseAborted = resolve;
		});
		let twoStarted!: () => void;
		const twoEntered = new Promise<void>((resolve) => {
			twoStarted = resolve;
		});
		const abortControl = controlPlane();
		abortControl.listFolderDrainDue = vi.fn(async () => ({ items: ids, hasMore: false }));
		const workerAbortError = new Error("worker aborted");
		abortControl.runFolderDrain = vi.fn(async () => {
			startedOnAbort++;
			if (startedOnAbort === 2) twoStarted();
			await abortGate;
			settledOnAbort++;
			throw workerAbortError;
		});
		const abortDrains = new CloudFolderDrains({
			drains: [{ name: "listen", companyLimit: 8 }],
			concurrency: 2,
		});
		const abortRun = abortDrains.reconcile(abortControl, ac.signal);
		await twoEntered;
		ac.abort();
		releaseAborted();
		await expect(abortRun).rejects.toBe(workerAbortError);
		expect(startedOnAbort).toBe(2);
		expect(settledOnAbort).toBe(2);

		const matAbortAc = new AbortController();
		let matAbortStarted = 0;
		let matAbortSettled = 0;
		let releaseMatAbort!: () => void;
		const matAbortGate = new Promise<void>((resolve) => {
			releaseMatAbort = resolve;
		});
		let matTwoStarted!: () => void;
		const matTwoEntered = new Promise<void>((resolve) => {
			matTwoStarted = resolve;
		});
		const matAbortError = new Error("materializer worker aborted");
		const matAbortControl = controlPlane();
		matAbortControl.listFolderMaterializationDue = vi.fn(async () => ({ items: ids, hasMore: false }));
		matAbortControl.materializeFolderCompany = vi.fn(async () => {
			matAbortStarted++;
			if (matAbortStarted === 2) matTwoStarted();
			await matAbortGate;
			matAbortSettled++;
			throw matAbortError;
		});
		const abortMaterializer = new CloudFolderRunMaterializer({ concurrency: 2 });
		const matAbortRun = abortMaterializer.reconcile(matAbortControl, matAbortAc.signal);
		await matTwoEntered;
		matAbortAc.abort();
		releaseMatAbort();
		await expect(matAbortRun).rejects.toBe(matAbortError);
		expect(matAbortStarted).toBe(2);
		expect(matAbortSettled).toBe(2);

		const cleanAc = new AbortController();
		let cleanStarted = 0;
		let cleanSettled = 0;
		let releaseClean!: () => void;
		const cleanGate = new Promise<void>((resolve) => {
			releaseClean = resolve;
		});
		let cleanTwoStarted!: () => void;
		const cleanTwoEntered = new Promise<void>((resolve) => {
			cleanTwoStarted = resolve;
		});
		const cleanControl = controlPlane();
		cleanControl.listFolderDrainDue = vi.fn(async () => ({ items: ids, hasMore: false }));
		cleanControl.runFolderDrain = vi.fn(async () => {
			cleanStarted++;
			if (cleanStarted === 2) cleanTwoStarted();
			await cleanGate;
			cleanSettled++;
			return { state: "idle" as const, count: 0 };
		});
		const cleanRun = abortDrains.reconcile(cleanControl, cleanAc.signal);
		await cleanTwoEntered;
		const cleanReason = new Error("clean abort reason");
		cleanAc.abort(cleanReason);
		releaseClean();
		await expect(cleanRun).rejects.toBe(cleanReason);
		expect(cleanStarted).toBe(2);
		expect(cleanSettled).toBe(2);

		expect(() => new CloudFolderDrains({ concurrency: 0 })).toThrow(
			"Folder drain concurrency is outside the supported range",
		);
		expect(() => new CloudFolderDrains({ concurrency: 17 })).toThrow(
			"Folder drain concurrency is outside the supported range",
		);
		expect(() => new CloudFolderDrains({ concurrency: 1.5 })).toThrow(
			"Folder drain concurrency is outside the supported range",
		);
		expect(() => new CloudFolderRunMaterializer({ concurrency: 0 })).toThrow(
			"Folder materialization concurrency is outside the supported range",
		);
		expect(() => new CloudFolderRunMaterializer({ concurrency: 17 })).toThrow(
			"Folder materialization concurrency is outside the supported range",
		);
	});

	it("evaluates windowed schedules identically across DST transitions and sub-hour time zones", async () => {
		const springControl = controlPlane(undefined);
		vi.mocked(springControl.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "12121212-1212-4212-8212-121212121212",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "cph-spring",
							kind: "schedule",
							intervalMinutes: 30,
							windowStart: "01:30",
							windowEnd: "03:30",
							timeZone: "Europe/Copenhagen",
						},
					],
					scheduleCursors: [
						{
							triggerId: "cph-spring",
							lastScheduledFor: "2026-03-28T02:30:00.000Z",
							nextDueAt: "2026-03-29T00:30:00.000Z",
						},
					],
					contentSha256: "a".repeat(64),
					effectiveAt: "2026-03-28T00:00:00.000Z",
					updatedAt: "2026-03-28T02:30:00.000Z",
				},
			],
			hasMore: false,
		});
		const springReconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-03-29T01:45:00.000Z"),
		});
		await springReconciler.reconcile(springControl);
		expect(
			vi.mocked(springControl.enqueueRoutineWake).mock.calls.map(([input]) => ({
				scheduledFor: input.scheduledFor,
				nextDueAt: input.nextDueAt,
			})),
		).toEqual([
			{ scheduledFor: "2026-03-29T00:30:00.000Z", nextDueAt: "2026-03-29T01:00:00.000Z" },
			{ scheduledFor: "2026-03-29T01:00:00.000Z", nextDueAt: "2026-03-29T01:30:00.000Z" },
			{ scheduledFor: "2026-03-29T01:30:00.000Z", nextDueAt: "2026-03-29T23:30:00.000Z" },
		]);

		const fallControl = controlPlane(undefined);
		vi.mocked(fallControl.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "13131313-1313-4313-8313-131313131313",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "ny-fall",
							kind: "schedule",
							intervalMinutes: 30,
							windowStart: "00:30",
							windowEnd: "02:30",
							timeZone: "America/New_York",
						},
					],
					scheduleCursors: [
						{
							triggerId: "ny-fall",
							lastScheduledFor: "2026-10-31T06:30:00.000Z",
							nextDueAt: "2026-11-01T04:30:00.000Z",
						},
					],
					contentSha256: "b".repeat(64),
					effectiveAt: "2026-10-31T00:00:00.000Z",
					updatedAt: "2026-10-31T06:30:00.000Z",
				},
			],
			hasMore: false,
		});
		const fallReconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-11-01T07:45:00.000Z"),
		});
		await fallReconciler.reconcile(fallControl);
		const fallWakes = vi.mocked(fallControl.enqueueRoutineWake).mock.calls.map(([input]) => ({
			scheduledFor: input.scheduledFor,
			nextDueAt: input.nextDueAt,
		}));
		expect(fallWakes[0]).toEqual({
			scheduledFor: "2026-11-01T04:30:00.000Z",
			nextDueAt: "2026-11-01T05:00:00.000Z",
		});
		expect(fallWakes[fallWakes.length - 1]).toEqual({
			scheduledFor: "2026-11-01T07:30:00.000Z",
			nextDueAt: "2026-11-02T05:30:00.000Z",
		});

		const ktmControl = controlPlane(undefined);
		vi.mocked(ktmControl.listRoutineScheduleHeads).mockResolvedValue({
			items: [
				{
					routineId: "14141414-1414-4414-8414-141414141414",
					profileId: "88888888-8888-4888-8888-888888888888",
					environmentId: "99999999-9999-4999-8999-999999999999",
					version: 1,
					staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
					triggers: [
						{
							id: "ktm-window",
							kind: "schedule",
							intervalMinutes: 15,
							windowStart: "09:00",
							windowEnd: "09:30",
							timeZone: "Asia/Kathmandu",
						},
					],
					scheduleCursors: [
						{
							triggerId: "ktm-window",
							lastScheduledFor: "2026-08-19T03:45:00.000Z",
							nextDueAt: "2026-08-20T03:15:00.000Z",
						},
					],
					contentSha256: "c".repeat(64),
					effectiveAt: "2026-08-19T00:00:00.000Z",
					updatedAt: "2026-08-19T03:45:00.000Z",
				},
			],
			hasMore: false,
		});
		const ktmReconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T03:35:00.000Z"),
		});
		await ktmReconciler.reconcile(ktmControl);
		expect(
			vi.mocked(ktmControl.enqueueRoutineWake).mock.calls.map(([input]) => ({
				scheduledFor: input.scheduledFor,
				nextDueAt: input.nextDueAt,
			})),
		).toEqual([
			{ scheduledFor: "2026-08-20T03:15:00.000Z", nextDueAt: "2026-08-20T03:30:00.000Z" },
			{ scheduledFor: "2026-08-20T03:30:00.000Z", nextDueAt: "2026-08-20T03:45:00.000Z" },
		]);
	});

	it("reconciles distinct routine heads and dynamic restores with bounded concurrency, per-trigger serial wakes, and page-ordered failures", async () => {
		const routineIds = Array.from(
			{ length: 6 },
			(_, i) => `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
		);
		const heads = routineIds.map((id) => {
			const head = scheduleHead(id);
			head.scheduleCursors = [
				{
					triggerId: "schedule-main",
					lastScheduledFor: "2026-08-20T09:00:00.000Z",
					nextDueAt: "2026-08-20T10:00:00.000Z",
				},
			];
			return head;
		});
		let inFlight = 0;
		let maxInFlight = 0;
		const perHeadActive = new Set<string>();
		const perHeadOrder = new Map<string, string[]>();
		let reachedThree!: () => void;
		const threeEntered = new Promise<void>((resolve) => {
			reachedThree = resolve;
		});
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const control = controlPlane();
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: heads, hasMore: false });
		vi.mocked(control.enqueueRoutineWake).mockImplementation(async (input) => {
			expect(perHeadActive.has(input.routineId)).toBe(false);
			perHeadActive.add(input.routineId);
			const seen = perHeadOrder.get(input.routineId) ?? [];
			seen.push(input.scheduledFor);
			perHeadOrder.set(input.routineId, seen);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (maxInFlight === 3) reachedThree();
			await gate;
			inFlight--;
			perHeadActive.delete(input.routineId);
			return { occurrenceId: input.occurrenceId, status: "queued" as const, scheduledFor: input.scheduledFor };
		});

		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T11:30:00.000Z"),
			concurrency: 3,
		});
		const running = reconciler.reconcile(control);
		await threeEntered;
		expect(maxInFlight).toBe(3);
		openGate();
		await expect(running).resolves.toBeUndefined();
		for (const id of routineIds) {
			expect(perHeadOrder.get(id)).toEqual(["2026-08-20T10:00:00.000Z", "2026-08-20T11:00:00.000Z"]);
		}

		const err0 = new CloudRunnerOrchestratorRequestError(500);
		const err3 = new CloudRunnerOrchestratorRequestError(503);
		const orderControl = controlPlane();
		vi.mocked(orderControl.listRoutineScheduleHeads).mockResolvedValue({
			items: routineIds.slice(0, 4).map((id) => scheduleHead(id)),
			hasMore: false,
		});
		vi.mocked(orderControl.enqueueRoutineWake).mockImplementation(async (input) => {
			if (input.routineId === routineIds[0]) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				throw err0;
			}
			if (input.routineId === routineIds[3]) throw err3;
			return { occurrenceId: input.occurrenceId, status: "queued" as const, scheduledFor: input.scheduledFor };
		});
		const orderReconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T12:30:00.000Z"),
			concurrency: 4,
		});
		await expect(orderReconciler.reconcile(orderControl)).rejects.toMatchObject({ errors: [err0, err3] });

		const dynErr0 = new Error("dyn-0");
		const dynErr2 = new Error("dyn-2");
		let dynInFlight = 0;
		let dynMaxInFlight = 0;
		const dynControl = controlPlane();
		dynControl.listFolderDynamicRoutines = vi.fn(async () => ({
			items: [
				{ routineId: routineIds[0]!, version: 1 },
				{ routineId: routineIds[1]!, version: 1 },
				{ routineId: routineIds[2]!, version: 1 },
			],
			hasMore: false,
		}));
		dynControl.restoreFolderDynamicRoutineRun = vi.fn(async (routine) => {
			dynInFlight++;
			dynMaxInFlight = Math.max(dynMaxInFlight, dynInFlight);
			if (routine.routineId === routineIds[0]) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				dynInFlight--;
				throw dynErr0;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
			dynInFlight--;
			if (routine.routineId === routineIds[2]) throw dynErr2;
			return { status: "inserted" as const, occurrenceId: "17171717-1717-4717-8717-171717171717" };
		});
		const dynReconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-20T12:30:00.000Z"),
			concurrency: 3,
			folderDynamicIntervalMs: 0,
		});
		await expect(dynReconciler.reconcile(dynControl)).rejects.toMatchObject({ errors: [dynErr0, dynErr2] });
		expect(dynMaxInFlight).toBe(3);

		expect(() => new CloudRoutineScheduleReconciler({ concurrency: 0 })).toThrow(
			"Routine schedule concurrency is outside the supported range",
		);
		expect(() => new CloudRoutineScheduleReconciler({ concurrency: 17 })).toThrow(
			"Routine schedule concurrency is outside the supported range",
		);
		expect(() => new CloudRoutineScheduleReconciler({ concurrency: 1.5 })).toThrow(
			"Routine schedule concurrency is outside the supported range",
		);
	});

	it("reports only one 400 error when concurrent heads hit a pre-advance control plane", async () => {
		const unknown = new CloudRunnerOrchestratorRequestError(400);
		const ids = Array.from({ length: 4 }, (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
		const items = ids.map((id) => ({
			...scheduleHead(id),
			triggers: [
				{
					id: "office-hours",
					kind: "schedule",
					intervalMinutes: 30,
					windowStart: "09:00",
					windowEnd: "10:00",
					timeZone: "UTC",
				},
			],
			scheduleCursors: [{ triggerId: "office-hours" }],
			effectiveAt: "2026-08-25T09:10:00.000Z",
		}));
		const control = controlPlane(undefined);
		vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items, hasMore: false });
		vi.mocked(control.advanceRoutineNextDue).mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			throw unknown;
		});
		const reconciler = new CloudRoutineScheduleReconciler({
			now: () => new Date("2026-08-25T08:58:00.000Z"),
			concurrency: 4,
		});
		await expect(reconciler.reconcile(control)).rejects.toMatchObject({ errors: [unknown] });
	});

	it("matches exhaustive day-enumeration across every day of 2026-2027 in northern, southern, and sub-hour time zones", async () => {
		const zones: readonly [string, number][] = [
			["Europe/Copenhagen", 1],
			["America/New_York", 7],
			["Australia/Sydney", 16],
			["Asia/Kathmandu", 20],
			["Pacific/Chatham", 13],
			["Australia/Lord_Howe", 15],
		];
		const formatters = new Map(
			zones.map(([timeZone]) => [
				timeZone,
				new Intl.DateTimeFormat("en-CA", {
					timeZone,
					hourCycle: "h23",
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
				}),
			]),
		);
		const partsOf = (instant: Date, timeZone: string) => {
			const parts = formatters.get(timeZone)!.formatToParts(instant);
			const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
			return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
		};
		const refZoned = (year: number, month: number, day: number, hour: number, minute: number, timeZone: string) => {
			const target = Date.UTC(year, month - 1, day, hour, minute);
			let candidate = target;
			for (let i = 0; i < 4; i++) {
				const actual = partsOf(new Date(candidate), timeZone);
				const delta = target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
				if (delta === 0) break;
				candidate += delta;
			}
			const actual = partsOf(new Date(candidate), timeZone);
			return actual.year === year &&
				actual.month === month &&
				actual.day === day &&
				actual.hour === hour &&
				actual.minute === minute
				? new Date(candidate)
				: undefined;
		};
		const refDaySlots = (year: number, month: number, day: number, timeZone: string) => {
			const out: Date[] = [];
			for (let m = 30; m <= 225; m += 45) {
				const slot = refZoned(year, month, day, Math.floor(m / 60), m % 60, timeZone);
				if (slot) out.push(slot);
			}
			return out;
		};
		const refNearest = (instant: Date, timeZone: string, direction: "before-or-at" | "after") => {
			const local = partsOf(instant, timeZone);
			for (let d = 0; d <= 3; d++) {
				const shifted = new Date(
					Date.UTC(local.year, local.month - 1, local.day + (direction === "before-or-at" ? -d : d)),
				);
				const slots = refDaySlots(
					shifted.getUTCFullYear(),
					shifted.getUTCMonth() + 1,
					shifted.getUTCDate(),
					timeZone,
				);
				if (direction === "before-or-at") {
					for (let i = slots.length - 1; i >= 0; i--) {
						if (slots[i]!.getTime() <= instant.getTime()) return slots[i]!;
					}
				} else {
					for (const slot of slots) {
						if (slot.getTime() > instant.getTime()) return slot;
					}
				}
			}
			throw new Error(`No slot found for ${timeZone} at ${instant.toISOString()}`);
		};

		const baseDay = Date.UTC(2026, 0, 1, 0, 15);
		const totalDays = 730;
		for (const [timeZone, probeUtcHour] of zones) {
			const startDay = baseDay + probeUtcHour * 3_600_000;
			let currentNow = new Date(startDay);
			const observed: { scheduledFor: string; nextDueAt: string }[] = [];
			const head = {
				routineId: "40000000-0000-4000-8000-000000000001",
				profileId: "88888888-8888-4888-8888-888888888888",
				environmentId: "99999999-9999-4999-8999-999999999999",
				version: 1,
				staffAgentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
				triggers: [
					{
						id: "sweep",
						kind: "schedule",
						intervalMinutes: 45,
						windowStart: "00:30",
						windowEnd: "03:45",
						timeZone,
					},
				],
				scheduleCursors: [{ triggerId: "sweep" }],
				contentSha256: "d".repeat(64),
				effectiveAt: "2025-12-01T00:00:00.000Z",
				updatedAt: "2025-12-01T00:00:00.000Z",
			};
			const control = controlPlane(undefined);
			vi.mocked(control.listRoutineScheduleHeads).mockResolvedValue({ items: [head], hasMore: false });
			vi.mocked(control.enqueueRoutineWake).mockImplementation(async (input) => {
				observed.push({ scheduledFor: input.scheduledFor, nextDueAt: input.nextDueAt });
				return { occurrenceId: input.occurrenceId, status: "queued" as const, scheduledFor: input.scheduledFor };
			});
			const reconciler = new CloudRoutineScheduleReconciler({ now: () => currentNow });
			for (let day = 0; day < totalDays; day++) {
				currentNow = new Date(startDay + day * 86_400_000);
				observed.length = 0;
				await reconciler.reconcile(control);
				const expectedScheduled = refNearest(currentNow, timeZone, "before-or-at");
				const expectedNext = refNearest(expectedScheduled, timeZone, "after");
				expect(observed).toEqual([
					{
						scheduledFor: expectedScheduled.toISOString(),
						nextDueAt: expectedNext.toISOString(),
					},
				]);
			}
		}
	});

	it("preserves already-claimed work when a mid-batch claimNext call fails transiently", async () => {
		const first = claim();
		const control = controlPlane(first);
		let calls = 0;
		vi.mocked(control.claimNext).mockImplementation(async () => {
			calls += 1;
			if (calls === 1) return first;
			throw new CloudRunnerOrchestratorRequestError(503);
		});
		const controller = new AbortController();
		const local = localAdapter(
			vi.fn(async () => {
				controller.abort();
			}),
		);
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: control,
			providerAdapter: local.adapter,
			dispatchConcurrency: 2,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});

		await orchestrator.run(controller.signal, { pollIntervalMs: 500, reconcileIntervalMs: 10_000 });
		expect(local.deliver).toHaveBeenCalledOnce();
		expect(control.claimNext).toHaveBeenCalledTimes(2);
	});

	it("runs runner stop and claim release independently when one cleanup step fails", async () => {
		const deliverControl = controlPlane();
		vi.mocked(deliverControl.releaseClaim).mockRejectedValueOnce(new Error("release unavailable"));
		const deliverLocal = localAdapter(
			vi.fn(async () => {
				throw Object.assign(new Error("rejected delivery"), { status: 422 });
			}),
		);
		const deliverOrch = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: deliverControl,
			providerAdapter: deliverLocal.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});
		await expect(deliverOrch.runOnce()).rejects.toThrow("rejected delivery");
		expect(deliverControl.releaseClaim).toHaveBeenCalledOnce();
		expect(deliverLocal.stop).toHaveBeenCalledWith(expect.objectContaining({ runnerId }), "delivery_failed");

		const assignControl = controlPlane();
		vi.mocked(assignControl.assign).mockRejectedValueOnce(new CloudRunnerOrchestratorRequestError(422));
		const assignLocal = localAdapter();
		assignLocal.stop.mockRejectedValueOnce(new Error("provider stop failed"));
		const assignOrch = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: assignControl,
			providerAdapter: assignLocal.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});
		await expect(assignOrch.runOnce()).rejects.toThrow("422");
		expect(assignLocal.stop).toHaveBeenCalledWith(expect.objectContaining({ runnerId }), "delivery_failed");
		expect(assignControl.releaseClaim).toHaveBeenCalledOnce();

		const incompatControl = controlPlane();
		const incompatLocal = localAdapter();
		incompatLocal.acquire.mockResolvedValueOnce({
			runnerId,
			logicalComputerId: "99999999-9999-4999-8999-999999999991",
			workerClass: "managed_sandbox",
			providerAdapter: "local",
			capabilities: ["agent_turn"],
			templateKey: "qorpera-test",
			templateVersion: "test-v1",
			policySha256: "f".repeat(64),
		});
		incompatLocal.stop.mockRejectedValueOnce(new Error("provider stop failed"));
		const incompatOrch = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: incompatControl,
			providerAdapter: incompatLocal.adapter,
			clientClaimId: () => claimId,
			clientAssignmentId: () => assignmentId,
			createCapability: () => capability,
		});
		await expect(incompatOrch.runOnce()).rejects.toThrow("incompatible computer");
		expect(incompatLocal.stop).toHaveBeenCalledWith(expect.objectContaining({ runnerId }), "delivery_failed");
		expect(incompatControl.releaseClaim).toHaveBeenCalledOnce();
	});

	it("cancels oversized streaming control-plane responses before buffering the entire body", async () => {
		let pulled = 0;
		let cancelled = false;
		const oversizedFetch = vi.fn(async () => {
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					pulled += 1;
					if (pulled > 10) {
						controller.close();
						return;
					}
					controller.enqueue(new Uint8Array(1024 * 1024));
				},
				cancel() {
					cancelled = true;
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
		});
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			"c".repeat(43),
			oversizedFetch as typeof fetch,
		);
		await expect(control.retainedClaims(orchestratorId)).rejects.toThrow("exceeds its byte limit");
		expect(cancelled).toBe(true);
		expect(pulled).toBeLessThanOrEqual(4);
	});
});
