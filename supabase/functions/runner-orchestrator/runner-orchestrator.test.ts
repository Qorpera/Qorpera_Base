import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { before, describe, it } from "node:test";
import {
	FOLDER_DRAINS,
	orchestratorAuthFailure,
	parseRunnerOrchestratorBearer,
	parseRunnerOrchestratorRequest,
	readRunnerOrchestratorRequest,
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
		assert.deepEqual(parseRunnerOrchestratorRequest({ action: "due_summary", orchestratorId }), {
			action: "due_summary",
			orchestratorId,
		});
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
		// A company machine's events (C1c-3i-b): its own RPCs, at most 64 parents a step.
		assert.deepEqual(FOLDER_DRAINS.machine_events, {
			due: "qorpera_folder_machine_events_due",
			company: "qorpera_folder_machine_events_company",
			maximum: 64,
		});
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "machine_events", environmentId, limit: 64 }),
			{ action: "folder_drain_company", orchestratorId, drain: "machine_events", environmentId, limit: 64 },
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "machine_events", environmentId, limit: 65 }),
		);
		// C1c-3l part 2's office wakes: at most 40 waiters of one company per request (a subtransaction each).
		assert.deepEqual(FOLDER_DRAINS.office_wakes, {
			due: "qorpera_folder_office_wakes_due",
			company: "qorpera_folder_office_wakes_company",
			maximum: 40,
		});
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "office_wakes", environmentId, limit: 40 }),
			{ action: "folder_drain_company", orchestratorId, drain: "office_wakes", environmentId, limit: 40 },
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "office_wakes", environmentId, limit: 41 }),
		);
		// The one idle rule's check-ins: their own RPCs, at most 64 parents a step.
		assert.deepEqual(FOLDER_DRAINS.machine_checkins, {
			due: "qorpera_folder_machine_checkins_due",
			company: "qorpera_folder_machine_checkins_company",
			maximum: 64,
		});
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "machine_checkins", environmentId, limit: 65 }),
		);
		// A quiet coding session's check-in (C3c): its own RPCs, at most 32 sessions a step.
		assert.deepEqual(FOLDER_DRAINS.coding_checkins, {
			due: "qorpera_folder_coding_checkins_due",
			company: "qorpera_folder_coding_checkins_company",
			maximum: 32,
		});
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "coding_checkins", environmentId, limit: 32 }),
			{ action: "folder_drain_company", orchestratorId, drain: "coding_checkins", environmentId, limit: 32 },
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "coding_checkins", environmentId, limit: 33 }),
		);
		// Event wakes (E2): W2's listeners on hooks and mailboxes, at most 64 a step.
		assert.deepEqual(FOLDER_DRAINS.events, {
			due: "qorpera_folder_event_wakes_due",
			company: "qorpera_folder_event_wakes_company",
			maximum: 64,
		});
		assert.deepEqual(
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "events", environmentId, limit: 16 }),
			{ action: "folder_drain_company", orchestratorId, drain: "events", environmentId, limit: 16 },
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({ action: "folder_drain_company", orchestratorId, drain: "events", environmentId, limit: 65 }),
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

	it("parses and validates surface job claim and completion actions", () => {
		const previewId = "88888888-8888-4888-8888-888888888888";
		const siteVersionId = "99999999-9999-4999-8999-999999999999";
		const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const conflictChangeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const sha1 = "a".repeat(40);
		const sha2 = "b".repeat(40);

		assert.deepEqual(parseRunnerOrchestratorRequest({ action: "surface_claim_jobs", orchestratorId }), {
			action: "surface_claim_jobs",
			orchestratorId,
			limit: 16,
		});
		assert.deepEqual(parseRunnerOrchestratorRequest({ action: "surface_claim_jobs", orchestratorId, limit: 32 }), {
			action: "surface_claim_jobs",
			orchestratorId,
			limit: 32,
		});
		for (const limit of [0, 65, 1.5, "16", null]) {
			assert.throws(() => parseRunnerOrchestratorRequest({ action: "surface_claim_jobs", orchestratorId, limit }));
		}

		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "surface_complete_preview",
				orchestratorId,
				previewId,
				status: "ready",
				compositeTreeSha: sha1,
				siteVersionId,
				conflictReport: null,
				errorDetail: null,
			}),
			{
				action: "surface_complete_preview",
				orchestratorId,
				previewId,
				status: "ready",
				compositeTreeSha: sha1,
				siteVersionId,
			},
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "surface_complete_preview",
				orchestratorId,
				previewId,
				status: "conflicted",
				conflictReport: { changeIds: [conflictChangeId], paths: ["index.html"] },
			}),
			{
				action: "surface_complete_preview",
				orchestratorId,
				previewId,
				status: "conflicted",
				conflictReport: { changeIds: [conflictChangeId], paths: ["index.html"] },
			},
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_preview",
				orchestratorId,
				previewId,
				status: "building",
			}),
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_preview",
				orchestratorId,
				previewId: "not-a-uuid",
				status: "failed",
				errorDetail: "Build failed",
			}),
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_preview",
				orchestratorId,
				previewId,
				status: "failed",
				errorDetail: "x".repeat(1001),
			}),
		);

		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "surface_complete_session_turn",
				orchestratorId,
				sessionId,
				state: "needs_input",
				replyText: "Line 1\nLine 2",
				question: { text: "Which palette?", options: ["Aftenlys", "Varmt studie"] },
				notePaths: ["notes/decisions.md"],
				branchHeadSha: sha1,
			}),
			{
				action: "surface_complete_session_turn",
				orchestratorId,
				sessionId,
				state: "needs_input",
				replyText: "Line 1\nLine 2",
				question: { text: "Which palette?", options: ["Aftenlys", "Varmt studie"] },
				notePaths: ["notes/decisions.md"],
				branchHeadSha: sha1,
			},
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_session_turn",
				orchestratorId,
				sessionId,
				state: "invalid_state",
			}),
		);
		for (const state of ["queued", "running", "reconciling", "discarded"]) {
			assert.throws(() =>
				parseRunnerOrchestratorRequest({
					action: "surface_complete_session_turn",
					orchestratorId,
					sessionId,
					state,
				}),
			);
		}
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "surface_renew_lease",
				orchestratorId,
				kind: "session",
				id: sessionId,
				leaseToken: jobId,
			}),
			{
				action: "surface_renew_lease",
				orchestratorId,
				kind: "session",
				id: sessionId,
				leaseToken: jobId,
				extendSeconds: 300,
			},
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_renew_lease",
				orchestratorId,
				kind: "invalid",
				id: sessionId,
				leaseToken: jobId,
			}),
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_session_turn",
				orchestratorId,
				sessionId,
				state: "ready",
				notePaths: ["bad\npath"],
			}),
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_session_turn",
				orchestratorId,
				sessionId,
				state: "ready",
				replyText: "x".repeat(16_001),
			}),
		);

		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "surface_complete_merge",
				orchestratorId,
				jobId,
				status: "landed",
				mainBefore: sha1,
				mainAfter: sha2,
			}),
			{
				action: "surface_complete_merge",
				orchestratorId,
				jobId,
				status: "landed",
				mainBefore: sha1,
				mainAfter: sha2,
			},
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "surface_complete_merge",
				orchestratorId,
				jobId,
				status: "conflicted",
				conflictChangeId,
				conflictPaths: ["hero.html"],
				errorDetail: "Merge conflict on hero.html",
			}),
			{
				action: "surface_complete_merge",
				orchestratorId,
				jobId,
				status: "conflicted",
				conflictChangeId,
				conflictPaths: ["hero.html"],
				errorDetail: "Merge conflict on hero.html",
			},
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_merge",
				orchestratorId,
				jobId,
				status: "queued",
			}),
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_merge",
				orchestratorId,
				jobId,
				status: "conflicted",
				conflictChangeId: "not-a-uuid",
			}),
		);

		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "surface_complete_publish",
				orchestratorId,
				jobId,
				status: "published",
				publishedHeadSha: sha2,
			}),
			{
				action: "surface_complete_publish",
				orchestratorId,
				jobId,
				status: "published",
				publishedHeadSha: sha2,
			},
		);
		assert.deepEqual(
			parseRunnerOrchestratorRequest({
				action: "surface_complete_publish",
				orchestratorId,
				jobId,
				status: "failed",
				errorDetail: "Site upload timed out",
			}),
			{
				action: "surface_complete_publish",
				orchestratorId,
				jobId,
				status: "failed",
				errorDetail: "Site upload timed out",
			},
		);
		assert.throws(() =>
			parseRunnerOrchestratorRequest({
				action: "surface_complete_publish",
				orchestratorId,
				jobId,
				status: "publishing",
			}),
		);
	});
});

describe("the edge function's route for the one call", () => {
	type RpcAnswer = { data?: unknown; error?: { code: string } };
	type Handler = (request: Request) => Promise<Response>;
	const calls: [string, unknown][] = [];
	const signals: (AbortSignal | undefined)[] = [];
	let answer: (name: string, signal?: AbortSignal) => RpcAnswer = () => ({ data: null });
	let handler: Handler | undefined;

	// index.ts as it is, under Node: Deno and its npm specifier are stand-ins that record what it asks of PostgREST.
	before(async () => {
		Reflect.set(globalThis, "qorperaEdgeTestClient", () => ({
			rpc: (name: string, args: unknown) => {
				let attached: AbortSignal | undefined;
				const builder = {
					abortSignal(signal: AbortSignal) {
						attached = signal;
						return builder;
					},
					then(onFulfilled?: (value: RpcAnswer) => unknown, onRejected?: (reason: unknown) => unknown) {
						calls.push([name, args]);
						signals.push(attached);
						return Promise.resolve()
							.then(() => answer(name, attached))
							.then(onFulfilled, onRejected);
					},
				};
				return builder;
			},
		}));
		Reflect.set(globalThis, "Deno", {
			env: {
				get: (name: string) =>
					({ SUPABASE_URL: "https://project.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" })[name],
			},
			serve: (served: Handler) => {
				handler = served;
			},
		});
		const client =
			"data:text/javascript,export const createPostgrestClient = (...values) => globalThis.qorperaEdgeTestClient(...values);";
		const hooks = registerHooks({
			resolve: (specifier, context, nextResolve) =>
				specifier.endsWith("/postgrest-rpc.ts") ? { url: client, shortCircuit: true } : nextResolve(specifier, context),
		});
		await import("./index.ts");
		hooks.deregister();
	});

	const post = (body: unknown, bearer = token) =>
		(handler as Handler)(
			new Request("https://project.invalid/functions/v1/runner-orchestrator", {
				method: "POST",
				headers: { authorization: `Bearer ${bearer}` },
				body: JSON.stringify(body),
			}),
		);
	const answers = (controlValid: boolean, summary: RpcAnswer) => (name: string) =>
		name === "qorpera_runner_orchestrator_dispatch"
			? { error: { code: "PGRST202" } }
			: name === "qorpera_runner_orchestrator_control_valid"
				? { data: controlValid }
				: summary;

	it("dispatches control-token validation and target RPC in one round trip when dispatch RPC exists", async () => {
		const tokenHash = createHash("sha256").update(token).digest("hex");
		calls.length = 0;
		answer = (name) =>
			name === "qorpera_runner_orchestrator_dispatch"
				? { data: { listen: true, workers: false } }
				: { error: { code: "UNEXPECTED" } };
		const response = await post({ action: "due_summary", orchestratorId });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { value: { listen: true, workers: false } });
		assert.deepEqual(calls, [
			[
				"qorpera_runner_orchestrator_dispatch",
				{
					p_orchestrator_id: orchestratorId,
					p_control_token_sha256: tokenHash,
					p_rpc: "qorpera_orchestrator_due_summary",
					p_args: {},
				},
			],
		]);

		calls.length = 0;
		answer = () => ({ error: { code: "42501" } });
		assert.equal((await post({ action: "due_summary", orchestratorId })).status, 401);
		assert.deepEqual(calls.map(([name]) => name), ["qorpera_runner_orchestrator_dispatch"]);

		calls.length = 0;
		answer = () => ({ error: { code: "08006" } });
		assert.equal((await post({ action: "due_summary", orchestratorId })).status, 503);
		assert.deepEqual(calls.map(([name]) => name), ["qorpera_runner_orchestrator_dispatch"]);
	});

	it("checks the control token first, then calls the summary with no arguments and returns its answer", async () => {
		calls.length = 0;
		answer = answers(true, { data: { listen: true, workers: false } });
		const response = await post({ action: "due_summary", orchestratorId });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), { value: { listen: true, workers: false } });
		assert.deepEqual(calls.slice(1), [
			[
				"qorpera_runner_orchestrator_control_valid",
				{ p_orchestrator_id: orchestratorId, p_control_token_sha256: createHash("sha256").update(token).digest("hex") },
			],
			["qorpera_orchestrator_due_summary", {}],
		]);
	});

	it("never reaches the summary on a refused control token", async () => {
		calls.length = 0;
		answer = answers(false, { data: {} });
		const response = await post({ action: "due_summary", orchestratorId });
		assert.equal(response.status, 401);
		assert.deepEqual(calls.map(([name]) => name), [
			"qorpera_runner_orchestrator_dispatch",
			"qorpera_runner_orchestrator_control_valid",
		]);
	});

	it("maps a failed summary as any other call, and sends none of its text", async () => {
		// PostgREST's answer for a function it does not have: the edge function ahead of the migration.
		answer = answers(true, { error: { code: "PGRST202" } });
		const missing = await post({ action: "due_summary", orchestratorId });
		assert.equal(missing.status, 503);
		assert.deepEqual(await missing.json(), { error: "Orchestrator request was rejected" });
		answer = answers(true, { error: { code: "42501" } });
		assert.equal((await post({ action: "due_summary", orchestratorId })).status, 401);
	});

	it("answers 400 to an action it does not know before it asks anything: what an old edge function says to the call", async () => {
		calls.length = 0;
		const response = await post({ action: "due_summary_from_the_future", orchestratorId });
		assert.equal(response.status, 400);
		assert.deepEqual(calls, []);
	});

	it("names the function the migration makes, each of whose answers reads its own list", () => {
		const migration = readFileSync(
			new URL("../../migrations/20260930612000_orchestrator_due_summary.sql", import.meta.url),
			"utf8",
		);
		assert.match(migration, /create function public\.qorpera_orchestrator_due_summary\(\)/);
		const lists = new Map<string, string>([
			...Object.entries(FOLDER_DRAINS).map(([name, drain]): [string, string] => [name, drain.due]),
			["materialize", "qorpera_folder_materialize_due"],
			["routine_heads", "qorpera_list_routine_schedule_heads"],
		]);
		const answers = [...migration.matchAll(/'([a-z_]+)', public\.([a-z_]+)\(null, 1\) -> 'items' <> '\[\]'::jsonb/g)];
		// Every list the migration reads is checked. A drain it does not name is allowed: the orchestrator lists that one itself.
		assert.ok(answers.length > 0);
		assert.equal(answers.length, migration.match(/\(null, 1\) -> 'items'/g)?.length);
		for (const [, name, due] of answers) assert.equal(due, lists.get(name), `${name} reads ${due}`);
	});

	it("authenticates and dispatches all five surface orchestration RPCs", async () => {
		const previewId = "88888888-8888-4888-8888-888888888888";
		const siteVersionId = "99999999-9999-4999-8999-999999999999";
		const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const conflictChangeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const leaseToken = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		const sha1 = "a".repeat(40);
		const sha2 = "b".repeat(40);
		const tokenHash = createHash("sha256").update(token).digest("hex");

		calls.length = 0;
		answer = answers(true, { data: { sessions: [], previews: [], merges: [], publishes: [] } });
		const claimRes = await post({ action: "surface_claim_jobs", orchestratorId, limit: 24 });
		assert.equal(claimRes.status, 200);
		assert.deepEqual(await claimRes.json(), { value: { sessions: [], previews: [], merges: [], publishes: [] } });
		assert.deepEqual(calls.slice(1), [
			["qorpera_runner_orchestrator_control_valid", { p_orchestrator_id: orchestratorId, p_control_token_sha256: tokenHash }],
			["qorpera_surface_claim_pending_jobs", { p_limit: 24 }],
		]);

		calls.length = 0;
		answer = answers(true, { data: { renewed: true, leaseExpiresAt: "2026-11-22T03:05:00Z" } });
		const renewRes = await post({
			action: "surface_renew_lease",
			orchestratorId,
			kind: "session",
			id: sessionId,
			leaseToken,
			extendSeconds: 300,
		});
		assert.equal(renewRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_renew_lease",
			{
				p_kind: "session",
				p_id: sessionId,
				p_lease_token: leaseToken,
				p_extend_seconds: 300,
			},
		]);

		calls.length = 0;
		answer = answers(true, { data: { sessionId, released: true, state: "queued" } });
		const releaseRes = await post({
			action: "surface_release_session_claim",
			orchestratorId,
			sessionId,
			leaseToken,
		});
		assert.equal(releaseRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_release_session_claim",
			{
				p_session_id: sessionId,
				p_lease_token: leaseToken,
			},
		]);

		calls.length = 0;
		answer = answers(true, { data: { previewId, status: "ready", shortHostId: "ab12cd34", compositeTreeSha: sha1 } });
		const previewRes = await post({
			action: "surface_complete_preview",
			orchestratorId,
			previewId,
			status: "ready",
			compositeTreeSha: sha1,
			siteVersionId,
			leaseToken,
		});
		assert.equal(previewRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_complete_preview",
			{
				p_preview_id: previewId,
				p_status: "ready",
				p_composite_tree_sha: sha1,
				p_site_version_id: siteVersionId,
				p_conflict_report: null,
				p_error_detail: null,
				p_lease_token: leaseToken,
			},
		]);

		calls.length = 0;
		answer = answers(true, { data: { id: sessionId, state: "ready" } });
		const turnRes = await post({
			action: "surface_complete_session_turn",
			orchestratorId,
			sessionId,
			state: "ready",
			replyText: "Prepared changes",
			notePaths: ["notes/plan.md"],
			branchHeadSha: sha1,
			leaseToken,
		});
		assert.equal(turnRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_complete_session_turn",
			{
				p_session_id: sessionId,
				p_state: "ready",
				p_reply_text: "Prepared changes",
				p_question: null,
				p_note_paths: ["notes/plan.md"],
				p_branch_head_sha: sha1,
				p_lease_token: leaseToken,
			},
		]);

		calls.length = 0;
		answer = answers(true, { data: { jobId, status: "conflicted" } });
		const mergeRes = await post({
			action: "surface_complete_merge",
			orchestratorId,
			jobId,
			status: "conflicted",
			mainBefore: sha1,
			conflictChangeId,
			conflictPaths: ["index.html"],
			preMergeSnapshot: { files: { "identity/tokens.json": "{}" } },
			leaseToken,
		});
		assert.equal(mergeRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_complete_merge",
			{
				p_job_id: jobId,
				p_status: "conflicted",
				p_main_before: sha1,
				p_main_after: null,
				p_conflict_change_id: conflictChangeId,
				p_conflict_paths: ["index.html"],
				p_error_detail: null,
				p_pre_merge_snapshot: { files: { "identity/tokens.json": "{}" } },
				p_lease_token: leaseToken,
			},
		]);

		calls.length = 0;
		answer = answers(true, { data: { jobId, status: "published" } });
		const publishRes = await post({
			action: "surface_complete_publish",
			orchestratorId,
			jobId,
			status: "published",
			publishedHeadSha: sha2,
			leaseToken,
		});
		assert.equal(publishRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_complete_publish",
			{
				p_job_id: jobId,
				p_status: "published",
				p_published_head_sha: sha2,
				p_error_detail: null,
				p_lease_token: leaseToken,
			},
		]);

		calls.length = 0;
		answer = answers(true, { data: { sessions: [], previews: [], merges: [], publishes: [], automations: [] } });
		const laneClaimRes = await post({
			action: "surface_claim_jobs",
			orchestratorId,
			limit: 12,
			lane: "sessions",
		});
		assert.equal(laneClaimRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_claim_pending_jobs_for_lane",
			{ p_limit: 12, p_lane: "sessions" },
		]);

		calls.length = 0;
		answer = answers(true, { data: { status: "enqueued", wakeId: claimId, runId: null } });
		const enqueueRes = await post({
			action: "surface_enqueue_session_run",
			orchestratorId,
			sessionId,
			leaseToken,
		});
		assert.equal(enqueueRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_enqueue_session_run",
			{ p_session_id: sessionId, p_lease_token: leaseToken },
		]);

		calls.length = 0;
		answer = answers(true, { data: ["surfaces/thetabands"] });
		const productRootsRes = await post({
			action: "surface_shared_product_folder_roots",
			orchestratorId,
			profileId: assignmentId,
		});
		assert.equal(productRootsRes.status, 200);
		assert.deepEqual(await productRootsRes.json(), { value: ["surfaces/thetabands"] });
		assert.deepEqual(calls[2], [
			"qorpera_surface_shared_product_folder_roots",
			{ p_profile_id: assignmentId },
		]);

		calls.length = 0;
		answer = answers(true, { data: { status: "started", session: { sessionId } } });
		const triggerRes = await post({
			action: "surface_trigger_automation",
			orchestratorId,
			automationId: routineId,
		});
		assert.equal(triggerRes.status, 200);
		assert.deepEqual(calls[2], ["qorpera_surface_trigger_automation", { p_automation_id: routineId }]);

		calls.length = 0;
		answer = answers(true, { data: { updated: 1, sessionId } });
		const rebaseRes = await post({
			action: "surface_update_rebased_changes",
			orchestratorId,
			surfaceId: assignmentId,
			sessionId,
			branchHeadSha: sha2,
			rebasedChanges: [{ changeId: occurrenceId, parentSha: sha1, headSha: sha2 }],
		});
		assert.equal(rebaseRes.status, 200);
		assert.deepEqual(calls[2], [
			"qorpera_surface_update_rebased_changes",
			{
				p_surface_id: assignmentId,
				p_session_id: sessionId,
				p_branch_head_sha: sha2,
				p_rebased_changes: [{ changeId: occurrenceId, parentSha: sha1, headSha: sha2 }],
				p_conflicted_change_id: null,
				p_conflict_paths: null,
			},
		]);
	});

	it("returns 503 on transient control-token validation DB errors instead of 401 and cancels oversized chunked bodies", async () => {
		assert.equal(orchestratorAuthFailure({ code: "08006" }, null)?.status, 503);
		assert.equal(orchestratorAuthFailure({ code: "42501" }, null)?.status, 401);
		assert.equal(orchestratorAuthFailure(null, false)?.status, 401);
		assert.equal(orchestratorAuthFailure(null, true), null);

		calls.length = 0;
		answer = (name) =>
			name === "qorpera_runner_orchestrator_dispatch"
				? { error: { code: "PGRST202" } }
				: name === "qorpera_runner_orchestrator_control_valid"
					? { error: { code: "08006" } }
					: { data: {} };
		const outage = await post({ action: "due_summary", orchestratorId });
		assert.equal(outage.status, 503);

		let pulled = 0;
		let cancelled = false;
		const oversized = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				if (pulled > 32) {
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(64 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		const chunkedReq = new Request("https://project.invalid/functions/v1/runner-orchestrator", {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: oversized,
			duplex: "half",
		} as RequestInit);
		await assert.rejects(readRunnerOrchestratorRequest(chunkedReq), /request size/);
		assert.equal(cancelled, true);
		assert.ok(pulled <= 10, `expected early stream cancellation, saw ${pulled} chunks`);

		let stalledCancelled = false;
		const stalled = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise<void>(() => {});
			},
			cancel() {
				stalledCancelled = true;
			},
		});
		const stalledReq = new Request("https://project.invalid/functions/v1/runner-orchestrator", {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: stalled,
			duplex: "half",
		} as RequestInit);
		await assert.rejects(readRunnerOrchestratorRequest(stalledReq, 15), (error: unknown) => {
			assert.equal(error instanceof Error ? error.name : "", "TimeoutError");
			return true;
		});
		assert.equal(stalledCancelled, true);

		answer = () => {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		};
		const rpcThrown = await post({ action: "due_summary", orchestratorId });
		assert.equal(rpcThrown.status, 503);
		assert.deepEqual(await rpcThrown.json(), { error: "Runner orchestration is unavailable" });

		signals.length = 0;
		const ac = new AbortController();
		answer = (name, signal) => {
			if (name === "qorpera_runner_orchestrator_dispatch") return { error: { code: "PGRST202" } };
			if (name === "qorpera_runner_orchestrator_control_valid") return { data: true };
			signal?.throwIfAborted();
			return { data: {} };
		};
		const req = new Request("https://project.invalid/functions/v1/runner-orchestrator", {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ action: "due_summary", orchestratorId }),
			signal: ac.signal,
		});
		const ok = await (handler as Handler)(req);
		assert.equal(ok.status, 200);
		assert.equal(signals.length, 3);
		assert.equal(signals[0], req.signal);
		assert.equal(signals[1], req.signal);
		assert.equal(signals[2], req.signal);
		ac.abort(new Error("caller gone"));
		assert.equal(signals[2]?.aborted, true);
	});
});
