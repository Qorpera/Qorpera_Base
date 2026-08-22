import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
