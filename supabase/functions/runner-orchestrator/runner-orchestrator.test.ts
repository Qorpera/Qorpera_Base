import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { before, describe, it } from "node:test";
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
});

describe("the edge function's route for the one call", () => {
	type RpcAnswer = { data?: unknown; error?: { code: string } };
	type Handler = (request: Request) => Promise<Response>;
	const calls: [string, unknown][] = [];
	let answer: (name: string) => RpcAnswer = () => ({ data: null });
	let handler: Handler | undefined;

	// index.ts as it is, under Node: Deno and its npm specifier are stand-ins that record what it asks of PostgREST.
	before(async () => {
		Reflect.set(globalThis, "qorperaEdgeTestClient", () => ({
			rpc: async (name: string, args: unknown) => {
				calls.push([name, args]);
				return answer(name);
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
		const client = "data:text/javascript,export const createClient = (...values) => globalThis.qorperaEdgeTestClient(...values);";
		const hooks = registerHooks({
			resolve: (specifier, context, nextResolve) =>
				specifier.startsWith("npm:@supabase/supabase-js@") ? { url: client, shortCircuit: true } : nextResolve(specifier, context),
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
		name === "qorpera_runner_orchestrator_control_valid" ? { data: controlValid } : summary;

	it("checks the control token first, then calls the summary with no arguments and returns its answer", async () => {
		calls.length = 0;
		answer = answers(true, { data: { listen: true, workers: false } });
		const response = await post({ action: "due_summary", orchestratorId });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), { value: { listen: true, workers: false } });
		assert.deepEqual(calls, [
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
		assert.deepEqual(calls.map(([name]) => name), ["qorpera_runner_orchestrator_control_valid"]);
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

	it("names the function the migration makes, whose answers are the drains' due lists, the materializer's and the heads", () => {
		const migration = readFileSync(
			new URL("../../migrations/20260930612000_orchestrator_due_summary.sql", import.meta.url),
			"utf8",
		);
		assert.match(migration, /create function public\.qorpera_orchestrator_due_summary\(\)/);
		const lists = [
			...Object.entries(FOLDER_DRAINS).map(([name, drain]) => [name, drain.due]),
			["materialize", "qorpera_folder_materialize_due"],
			["routine_heads", "qorpera_list_routine_schedule_heads"],
		];
		for (const [name, due] of lists) {
			assert.ok(migration.includes(`'${name}', public.${due}(null, 1) -> 'items' <> '[]'::jsonb`), `${name} reads ${due}`);
		}
		assert.equal(migration.match(/\(null, 1\) -> 'items'/g)?.length, lists.length);
	});
});
