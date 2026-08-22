import { describe, expect, it, vi } from "vitest";
import {
	CloudRoutineScheduleReconciler,
	type CloudRunnerOrchestrationClaim,
	CloudRunnerOrchestrator,
	type CloudRunnerOrchestratorControlPlane,
	LocalCloudRunnerProviderAdapter,
	SupabaseCloudRunnerOrchestratorControlPlane,
	validateCloudRunnerWork,
} from "../src/orchestrator.ts";

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

function controlPlane(claimed: CloudRunnerOrchestrationClaim | undefined = claim()) {
	const control: CloudRunnerOrchestratorControlPlane = {
		listRoutineScheduleHeads: vi.fn(async () => ({ items: [], hasMore: false })),
		enqueueRoutineWake: vi.fn(async (input) => ({
			occurrenceId: input.occurrenceId,
			status: "queued" as const,
			scheduledFor: input.scheduledFor,
		})),
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
			const body = JSON.parse(String(init?.body)) as { action: string };
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
	});

	it("advances durable interval cursors and reports bounded catch-up honestly", async () => {
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

	it("does not backfill a weekly occurrence from before the routine version existed", async () => {
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

		expect(control.enqueueRoutineWake).not.toHaveBeenCalled();
	});

	it("rejects noncanonical interval start timestamps instead of silently parking them", async () => {
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
					],
					scheduleCursors: [{ triggerId: "infinite" }, { triggerId: "relative" }],
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
			const expected = claim();
			return Response.json({
				value: {
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
				},
			});
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
			{ persistControlTokens: async (state) => void persisted.push({ ...state }) },
		);

		await control.renewControl();

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
		expect(control.renewClaim).toHaveBeenCalledWith(expect.objectContaining({ claimId }), 30);
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

	it("polls durable state so missed work notifications cannot strand a queued job", async () => {
		const control = controlPlane(undefined);
		vi.mocked(control.claimNext).mockResolvedValueOnce(undefined).mockResolvedValueOnce(claim());
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

		await orchestrator.run(controller.signal, { pollIntervalMs: 10 });
		expect(control.claimNext).toHaveBeenCalledTimes(2);
		expect(local.deliver).toHaveBeenCalledOnce();
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
				throw new Error(`provisioning failed for ${capability}`);
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
});
