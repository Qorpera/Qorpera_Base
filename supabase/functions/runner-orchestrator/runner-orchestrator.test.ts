import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FOLDER_DRAINS,
	parseRunnerOrchestratorBearer,
	parseRunnerOrchestratorRequest,
	runnerOrchestratorRpcStatus,
} from "./runner-orchestrator.ts";

const orchestratorId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";
const runnerId = "33333333-3333-4333-8333-333333333333";
const assignmentId = "44444444-4444-4444-8444-444444444444";
const routineId = "55555555-5555-4555-8555-555555555555";
const occurrenceId = "66666666-6666-4666-8666-666666666666";
const profileId = "77777777-7777-4777-8777-777777777777";
const token = "a".repeat(43);

describe("runner orchestrator boundary", () => {
	it("parses private claim and assignment requests", () => {
		assert.equal(parseRunnerOrchestratorBearer(`Bearer ${token}`), token);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "rotate_control",
				orchestratorId,
				nextControlTokenSha256: "c".repeat(64),
				controlTokenSeconds: 604_800,
			}),
			{
				action: "rotate_control",
				orchestratorId,
				nextControlTokenSha256: "c".repeat(64),
				controlTokenSeconds: 604_800,
			},
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "renew_claim",
				orchestratorId,
				claimId,
				leaseSeconds: 120,
			}),
			{ action: "renew_claim", orchestratorId, claimId, leaseSeconds: 120 },
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "claim",
				orchestratorId,
				clientClaimId: claimId,
				leaseSeconds: 120,
			}),
			{ action: "claim", orchestratorId, clientClaimId: claimId, leaseSeconds: 120 },
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "assign",
				orchestratorId,
				claimId,
				runnerId,
				clientAssignmentId: assignmentId,
				capabilitySha256: "b".repeat(64),
				assignmentSeconds: 90,
			}),
			{
				action: "assign",
				orchestratorId,
				claimId,
				runnerId,
				clientAssignmentId: assignmentId,
				capabilitySha256: "b".repeat(64),
				assignmentSeconds: 90,
			},
		);
	});

	it("parses bounded routine discovery and deterministic wake admission", () => {
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "routine_heads", orchestratorId, limit: 100 }),
			{ action: "routine_heads", orchestratorId, limit: 100 },
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "enqueue_wake",
				orchestratorId,
				routineId,
				expectedVersion: 3,
				occurrenceId,
				occurrenceKey: "slot:42",
				triggerId: "schedule-main",
				scheduledFor: "2026-08-20T12:00:00.000Z",
				expectedLastScheduledFor: "2026-08-20T11:00:00.000Z",
				nextDueAt: "2026-08-20T13:00:00.000Z",
				payload: { coalesced: 2 },
			}),
			{
				action: "enqueue_wake",
				orchestratorId,
				routineId,
				expectedVersion: 3,
				occurrenceId,
				occurrenceKey: "slot:42",
				triggerId: "schedule-main",
				scheduledFor: "2026-08-20T12:00:00.000Z",
				expectedLastScheduledFor: "2026-08-20T11:00:00.000Z",
				nextDueAt: "2026-08-20T13:00:00.000Z",
				payload: { coalesced: 2 },
			},
		);
	});

	it("parses a first-slot advance that compares the position the orchestrator read", () => {
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "advance_next_due",
				orchestratorId,
				routineId,
				expectedVersion: 3,
				triggerId: "schedule-main",
				expectedLastScheduledFor: "2026-08-27T10:15:30.123Z",
				nextDueAt: "2026-08-28T09:00:00.000Z",
			}),
			{
				action: "advance_next_due",
				orchestratorId,
				routineId,
				expectedVersion: 3,
				triggerId: "schedule-main",
				expectedLastScheduledFor: "2026-08-27T10:15:30.123Z",
				nextDueAt: "2026-08-28T09:00:00.000Z",
			},
		);
		// A fresh cursor has no position.
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "advance_next_due",
				orchestratorId,
				routineId,
				expectedVersion: 1,
				triggerId: "schedule-main",
				nextDueAt: "2026-08-31T09:00:00+02:00",
			}),
			{
				action: "advance_next_due",
				orchestratorId,
				routineId,
				expectedVersion: 1,
				triggerId: "schedule-main",
				nextDueAt: "2026-08-31T07:00:00.000Z",
			},
		);
		for (const nextDueAt of ["2026-08-27T10:15:30.123Z", "not a time", undefined]) {
			assert.throws(() =>
				parseRunnerOrchestratorRequest({
					action: "advance_next_due",
					orchestratorId,
					routineId,
					expectedVersion: 3,
					triggerId: "schedule-main",
					expectedLastScheduledFor: "2026-08-27T10:15:30.123Z",
					nextDueAt,
				}),
			);
		}
	});

	it("parses the folder-v2 dynamic routines' list and per-routine restore", () => {
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_dynamic_routines", orchestratorId, limit: 250 }),
			{ action: "folder_dynamic_routines", orchestratorId, limit: 250 },
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "folder_dynamic_routines",
				orchestratorId,
				afterRoutineId: routineId,
				limit: 1,
			}),
			{ action: "folder_dynamic_routines", orchestratorId, afterRoutineId: routineId, limit: 1 },
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "restore_dynamic_routine",
				orchestratorId,
				routineId,
				expectedVersion: 4,
			}),
			{ action: "restore_dynamic_routine", orchestratorId, routineId, expectedVersion: 4 },
		);
		for (const limit of [0, 501, 1.5, "10"]) {
			assert.throws(() => parseRunnerOrchestratorRequest({ action: "folder_dynamic_routines", orchestratorId, limit }));
		}
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_dynamic_routines", orchestratorId, afterRoutineId: "x", limit: 1 }),
		);
		for (const expectedVersion of [0, 1_000_001, undefined]) {
			assert.throws(() =>
				parseRunnerOrchestratorRequest({ action: "restore_dynamic_routine", orchestratorId, routineId, expectedVersion }),
			);
		}
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "restore_dynamic_routine", orchestratorId, routineId: "x", expectedVersion: 1 }),
		);
	});

	it("parses the folder-v2 due companies and one company's materialization", () => {
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_materialize_due", orchestratorId, limit: 100 }),
			{ action: "folder_materialize_due", orchestratorId, limit: 100 },
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "folder_materialize_due",
				orchestratorId,
				afterProfileId: profileId,
				limit: 1,
			}),
			{ action: "folder_materialize_due", orchestratorId, afterProfileId: profileId, limit: 1 },
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_materialize_company", orchestratorId, profileId, limit: 16 }),
			{ action: "folder_materialize_company", orchestratorId, profileId, limit: 16 },
		);
		for (const limit of [0, 501, 1.5, "10"]) {
			assert.throws(() => parseRunnerOrchestratorRequest({ action: "folder_materialize_due", orchestratorId, limit }));
		}
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_materialize_due", orchestratorId, afterProfileId: "x", limit: 1 }),
		);
		for (const limit of [0, 17, undefined]) {
			assert.throws(() =>
				parseRunnerOrchestratorRequest({ action: "folder_materialize_company", orchestratorId, profileId, limit }),
			);
		}
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_materialize_company", orchestratorId, profileId: "x", limit: 1 }),
		);
	});

	it("parses the folder drains' due companies and one company's step, for a drain it knows", () => {
		const environmentId = profileId;
		assert.deepEqual(parseRunnerOrchestratorRequest({ action: "folder_drain_due", orchestratorId, drain: "listen", limit: 100 }), {
			action: "folder_drain_due",
			orchestratorId,
			drain: "listen",
			limit: 100,
		});
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "folder_drain_due",
				orchestratorId,
				drain: "listen",
				afterEnvironmentId: environmentId,
				limit: 1,
			}),
			{ action: "folder_drain_due", orchestratorId, drain: "listen", afterEnvironmentId: environmentId, limit: 1 },
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "listen", environmentId, limit: 32 }),
			{ action: "folder_drain_company", orchestratorId, drain: "listen", environmentId, limit: 32 },
		);
		// F2's worker drain, with its own maximum.
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "workers", environmentId, limit: 32 }),
			{ action: "folder_drain_company", orchestratorId, drain: "workers", environmentId, limit: 32 },
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "workers", environmentId, limit: 33 }),
		);
		assert.deepEqual(FOLDER_DRAINS.workers, {
			due: "qorpera_folder_workers_due",
			company: "qorpera_folder_workers_company",
			maximum: 32,
		});
		// F2's human-task wakes (H2c), with the same maximum.
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "human_tasks", environmentId, limit: 32 }),
			{ action: "folder_drain_company", orchestratorId, drain: "human_tasks", environmentId, limit: 32 },
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "human_tasks", environmentId, limit: 33 }),
		);
		assert.deepEqual(FOLDER_DRAINS.human_tasks, {
			due: "qorpera_folder_human_tasks_due",
			company: "qorpera_folder_human_tasks_company",
			maximum: 32,
		});
		// A drain this edge function does not know is refused (400): the orchestrator pauses that drain alone.
		for (const drain of ["machines", "", 7, undefined, "__proto__", "toString"]) {
			assert.throws(() => parseRunnerOrchestratorRequest({ action: "folder_drain_due", orchestratorId, drain, limit: 1 }));
		}
		for (const limit of [0, 501, "10"]) {
			assert.throws(() => parseRunnerOrchestratorRequest({ action: "folder_drain_due", orchestratorId, drain: "listen", limit }));
		}
		for (const limit of [0, FOLDER_DRAINS.listen.maximum + 1, undefined]) {
			assert.throws(() =>
				parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "listen", environmentId, limit }),
			);
		}
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "listen", environmentId: "x", limit: 1 }),
		);
	});

	it("rejects secret-shaped garbage and maps durable conflicts", () => {
		assert.throws(() => parseRunnerOrchestratorBearer(`Bearer ${token}secret`), /authorization/);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "release_claim",
				orchestratorId,
				claimId,
				clientAssignmentId: assignmentId,
				error: token.repeat(30),
			}),
		);
		assert.equal(runnerOrchestratorRpcStatus({ code: "40001" }), 409);
		assert.equal(runnerOrchestratorRpcStatus({ code: "55000" }), 423);
	});
});
