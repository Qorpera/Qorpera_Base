import assert from "node:assert/strict";
import { finish, pass, platformCommit, proveCompanyRun, sha256, textObjects } from "./prove-company-run.mjs";

// The agent's home program, B2: the answer first, then the bookkeeping. End to end, through the real patched Codex and a
// migrated database with 20260930748000 (scripts/prove-company-run.mjs says what is real and what stands in):
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-b2-answer-first.mjs
//
// Alice's run in her thread (SQL test 924) answers the owner. The tools are the runtime's own: the boundary, the folder
// file tools, update_wall (cloudWallTools) and manage_todo (cloudWorkerTools on CloudFolderTodos), and send_message as
// the company runtime makes it (its mouth, CloudAgentMouth, delivering through qorpera_send_native_agent_message; the
// company runtime's own tool is built inline, so this proof builds the same tool from the same parts). Each model round
// takes ROUND_MS, a round's fixed cost as Part D measured it (1.76 s), so the times below are a chat turn's shape.
// - After: the run reads, answers, then keeps its wall and its to-do list. The answer is in the thread before either
//   change is begun; both land after it, each with its receipt, commit, release and step; the model sees each result,
//   and the turn ends when the model stops (one closing round).
// - Before: the same work in today's order (bookkeeping, then the answer). The answer comes two rounds later.
// - Refused: after the answer, a call that is not bookkeeping runs nothing (nothing is read), and the turn ends at the
//   next model request: no later call reaches the run.
// - A provider error after the answer leaves the run delivered; the same error before any answer fails it.
// - An older kernel (without 20260930748000) under this runtime: the bookkeeping after the answer is refused and nothing
//   is written; the answer stands and the run ends.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const ROUND_MS = 1760;
const NOTE = { path: "notes/prices.md", text: "# Prices\n\nThe price list is ready: 40 kr a bag.\n" };
const SETUP = platformCommit("prove-b2-notes", [
	{ op: "mkdir", path: "notes" },
	{ op: "write", path: NOTE.path, text: NOTE.text },
]);
const WALL = "QorperaOS/agents/alice/wall.md";
const TODO = "QorperaOS/agents/alice/todos/suppliers.md";

const read = () => ({ name: "company_read", arguments: { path: NOTE.path } });
const answer = () => ({
	name: "send_message",
	arguments: { idempotencyKey: "answer", text: "The price list is ready: 40 kr a bag.", phase: "final" },
});
const wall = () => ({
	name: "update_wall",
	arguments: {
		now: "Prices set, now choosing suppliers",
		waiting: null,
		working: [{ headline: "Choosing suppliers" }],
		done: [{ headline: "Price list ready", detail: "40 kr a bag. [Prices](folder:notes/prices.md)" }],
	},
});
const todo = () => ({
	name: "manage_todo",
	arguments: { action: "upsert", operationKey: "suppliers", todoKey: "suppliers", title: "Choose suppliers" },
});

/** The run's send_message, its wall and its to-do list, as the company runtime gives a company run of Alice's. `sent`
 * keeps when each send was confirmed. */
function agentTools(sent) {
	return (code, { db, binding, folder, operations, identity }) => {
		const mouth = new code.CloudAgentMouth(binding.runId, async (input) =>
			code.parseCloudAgentSendReceipt(
				db.direct("qorpera_send_native_agent_message", {
					p_lease_id: binding.leaseId,
					p_run_id: binding.runId,
					p_job_id: binding.jobId,
					p_runner_id: binding.runnerId,
					p_assignment_id: binding.assignmentId,
					p_credential_capsule_id: binding.credentialCapsuleId,
					p_compute_identity_id: binding.computeIdentityId,
					p_provider: binding.provider,
					p_native_harness: binding.nativeHarness,
					p_idempotency_key: input.idempotencyKey,
					p_text: input.text,
					p_phase: input.phase,
				}),
				binding.runId,
			),
		);
		const send = {
			name: "send_message",
			source: "runtime",
			description: code.CLOUD_AGENT_SEND_INSTRUCTIONS,
			inputSchema: {
				type: "object",
				properties: {
					idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
					text: { type: "string", minLength: 1, maxLength: 65536 },
					phase: { type: "string", enum: ["progress", "final"] },
				},
				required: ["idempotencyKey", "text", "phase"],
				additionalProperties: false,
			},
			parseArguments(value) {
				const input = code.parseCloudAgentSendInput(value);
				return { idempotencyKey: input.idempotencyKey, text: input.text, phase: input.phase };
			},
			async execute(value, context) {
				const input = code.parseCloudAgentSendInput(value);
				const receipt = await mouth.send(input, context.signal);
				sent.push({ phase: input.phase, at: Date.now(), messageId: receipt.messageId });
				return { kind: "text", value: JSON.stringify(receipt), completesTurn: input.phase === "final" };
			},
		};
		const todos = code
			.cloudWorkerTools(binding, identity, { kind: "room", source: { kind: "room" } }, {
				folderTodos: new code.CloudFolderTodos({ folder, operations, identity, handle: "alice" }),
				folderWorkers: new code.CloudFolderWorkers({ folder, operations, identity, handle: "alice" }),
			})
			.filter((tool) => tool.name === "manage_todo");
		return [send, ...code.cloudWallTools({ folder, operations, identity, handle: "alice", timeZone: "UTC" }), ...todos];
	};
}

/** The run's sends, its receipts and the commits that carried them, as stored, oldest first. */
function stored(db, runId) {
	return db.json(`select jsonb_build_object(
		'sends', (select coalesce(jsonb_agg(jsonb_build_object('phase', s.phase, 'key', s.idempotency_key, 'at', e.created_at)
			order by e.sequence), '[]') from public.qorpera_agent_sends s join public.qorpera_session_events e on e.event_id = s.event_id
			where s.run_id = '${runId}'),
		'receipts', (select coalesce(jsonb_agg(jsonb_build_object('key', r.logical_operation_key, 'status', r.status,
			'begun', r.created_at, 'commit', r.folder_commit_id, 'committed', c.created_at) order by r.created_at), '[]')
			from public.qorpera_run_operation_receipts r left join public.qorpera_folder_commits c on c.id = r.folder_commit_id
			where r.run_id = '${runId}'))::text`);
}

const at = (value) => Date.parse(value);
const seconds = (ms) => (ms / 1000).toFixed(2);
/** When the answer was confirmed and when the run's turn ended, from the first model request. */
function timing(state, run, sent) {
	const start = state.agent[0].at;
	const final = sent.find((send) => send.phase === "final");
	return { answer: final.at - start, end: run.endedAt - start };
}

const times = {};

async function main() {
// 1. After: read, answer, then the wall and the to-do list -------------------------------------------------------------
{
	const sent = [];
	await proveCompanyRun({
			name: "qorpera_prove_b2_after",
			prompt: "Is the price list ready? Keep your wall and your to-do list in step.",
			setup: SETUP,
			objects: textObjects([NOTE.text]),
			calls: [read, answer, wall, todo],
			tools: agentTools(sent),
			roundMs: ROUND_MS,
			async check({ code, db, binding, run, outputs, state, log }) {
				const runId = binding.runId;
				assert.deepEqual(
					outputs.map((output) => [output.name, output.envelope.status]),
					[
						["company_read", "ok"],
						["send_message", "ok"],
						["update_wall", "ok"],
						["manage_todo", "ok"],
					],
				);
				assert.equal(state.agent.length, 5, "four calls, then the model's own end");
				pass(
					`the run read, answered, then kept its wall and to-do list: every call ran and the model saw each answer (${state.agent.length} model requests: the four calls and its own closing round)`,
				);
				const { sends, receipts } = stored(db, runId);
				assert.deepEqual(
					sends.map((send) => [send.phase, send.key]),
					[["final", "answer"]],
				);
				const answered = at(sends[0].at);
				const after = receipts.filter((receipt) => at(receipt.begun) > answered);
				assert.deepEqual(
					after.map((receipt) => [receipt.key.split(":")[0], receipt.status]),
					[
						["update_wall", "completed"],
						["manage_todo", "completed"],
					],
				);
				assert(after.every((receipt) => receipt.commit && at(receipt.committed) > answered));
				assert.equal(receipts.length, after.length, "nothing was written before the answer");
				pass(
					`the answer was in the thread before either change was begun: ${after.map((r) => `${r.key.split(":")[0]} begun ${at(r.begun) - answered} ms and committed ${at(r.committed) - answered} ms after it`).join("; ")}; each receipt completed with its folder commit`,
				);
				const wallText = (await run.folder.readText(WALL, 64 * 1024, AbortSignal.timeout(30_000)))?.text ?? "";
				assert.match(wallText, /Price list ready/);
				assert.match(wallText, /Prices set, now choosing suppliers/);
				const todoText = (await run.folder.readText(TODO, 64 * 1024, AbortSignal.timeout(30_000)))?.text ?? "";
				assert.match(todoText, /Choose suppliers/);
				pass(`the wall (${WALL}) and the to-do (${TODO}) hold what the run wrote after its answer`);
				// The record: the run's log keeps every step in order, and the context view each output the model got.
				assert.deepEqual(
					log.index.map((step) => [step.tool, step.finished]),
					[
						["company_read", true],
						["send_message", true],
						["update_wall", true],
						["manage_todo", true],
					],
				);
				for (const output of outputs.slice(2))
					assert(
						log.steps.some((step) => step.value.call === output.callId && step.line.includes(`"result":${output.output},`)),
						`${output.callId}'s step keeps its envelope`,
					);
				const views = db
					.json(`select coalesce(jsonb_agg(v.view -> 'outputs'), '[]')::text from public.qorpera_native_context_views v
						where v.run_id = '${runId}'`)
					.flat();
				for (const output of outputs)
					assert(
						views.some((view) => view.callId === output.callId && view.sha256 === sha256(output.output)),
						`${output.callId} is in a context view`,
					);
				pass(
					`the record holds after the answer as before it: the run's log keeps all ${log.index.length} steps in order with each envelope, and the context views each of the ${outputs.length} outputs the model got`,
				);
				assert.equal(code.CLOUD_AFTER_ANSWER_TOOLS.has("update_wall") && code.CLOUD_AFTER_ANSWER_TOOLS.has("manage_todo"), true);
				times.after = timing(state, run, sent);
				pass(
					`with ${seconds(ROUND_MS)} s model rounds the answer was confirmed ${seconds(times.after.answer)} s after the first model request; the turn ended at ${seconds(times.after.end)} s`,
				);
			},
		});
}

// 2. Before: today's order, the bookkeeping, then the answer -----------------------------------------------------------
{
	const sent = [];
	await proveCompanyRun({
			name: "qorpera_prove_b2_before",
			prompt: "Is the price list ready? Keep your wall and your to-do list in step.",
			setup: SETUP,
			objects: textObjects([NOTE.text]),
			calls: [read, wall, todo, answer],
			tools: agentTools(sent),
			roundMs: ROUND_MS,
			async check({ db, binding, run, outputs, state }) {
				assert(outputs.every((output) => output.envelope.status === "ok"));
				const { sends, receipts } = stored(db, binding.runId);
				assert(receipts.every((receipt) => at(receipt.begun) < at(sends[0].at)), "the bookkeeping came before the answer");
				times.before = timing(state, run, sent);
				const sooner = times.before.answer - times.after.answer;
				assert(sooner > 1.5 * ROUND_MS, `the answer came ${sooner} ms sooner after than before`);
				pass(
					`in today's order the answer was confirmed at ${seconds(times.before.answer)} s and the turn ended at ${seconds(times.before.end)} s; answering first gave it ${seconds(sooner)} s sooner (two rounds and the two tools, each round with this test machine's own overhead), and its turn ended at ${seconds(times.after.end)} s (both orders make the same five model requests here; before this change the final ended the turn at once, one closing round sooner)`,
				);
			},
		});
}

// 3. Refused: after the answer, a call that is not bookkeeping runs nothing and ends the turn ---------------------------
{
	const sent = [];
	await proveCompanyRun({
			name: "qorpera_prove_b2_refused",
			prompt: "Is the price list ready?",
			setup: SETUP,
			objects: textObjects([NOTE.text]),
			calls: [answer, read, () => ({ name: "company_list", arguments: { path: "notes" } })],
			tools: agentTools(sent),
			roundMs: 300,
			// The request that carried the refusal is interrupted: the provider may have seen it, never answered it.
			requests: (count) => count === 2 || count === 3,
			async check({ db, binding, outputs, state, log }) {
				assert.equal(outputs[0].envelope.status, "ok", "the answer's receipt reached the model");
				// The refusal as the run's log keeps it (the request that would have carried it to the model was interrupted).
				const refused = log.steps[1].value.result;
				assert.equal(log.steps[1].value.tool, "company_read");
				assert.equal(refused.status, "denied");
				assert.match(
					refused.content.text,
					/^TOOL_UNAVAILABLE: the final send is made, so only the wall, to-do list, apps and sidebar change now/,
				);
				assert.deepEqual(
					log.index.map((step) => [step.tool, step.finished]),
					[
						["send_message", true],
						["company_read", true],
					],
					"no later call reached the run",
				);
				assert(state.agent.length === 2 || state.abandoned.includes(2), "a third request, if it came, was given up unanswered");
				// Nothing was read: the refused step released nothing, and the run's read records name no read of the note.
				assert.deepEqual(log.index[1].releases, []);
				assert.deepEqual(log.steps[1].value.releases, []);
				const reads = db.json(`select coalesce(jsonb_agg(x ->> 'path'), '[]')::text
					from public.qorpera_folder_run_read_records r, jsonb_array_elements(r.reads) x where r.run_id = '${binding.runId}'`);
				assert(!reads.includes(NOTE.path), `no read of ${NOTE.path}: ${JSON.stringify(reads)}`);
				assert.deepEqual(stored(db, binding.runId).receipts, []);
				pass(
					`after the answer, company_read was answered "${refused.content.text.slice(0, 40)}…" with nothing read or released, and the turn ended at the next model request: the run's log has ${log.index.length} steps, the provider got ${state.agent.length} requests${state.abandoned.length ? " (the last given up by Codex, unanswered)" : ""}, and the third call never reached the run`,
				);
			},
		});
}

// 4. A provider error after the answer: the run is delivered; before any answer: the run fails --------------------------
{
	const sent = [];
	await proveCompanyRun({
			name: "qorpera_prove_b2_failed_after",
			prompt: "Is the price list ready?",
			setup: SETUP,
			objects: textObjects([NOTE.text]),
			// Every request after the answer is refused, so a retry by Codex is refused too.
			calls: [answer, ...Array.from({ length: 8 }, () => () => ({ fail: 400 }))],
			tools: agentTools(sent),
			requests: (count) => count >= 2 && count <= 9,
			async check({ db, binding, run, state }) {
				assert(run.result, "the run's session ended as delivered");
				assert.deepEqual(
					stored(db, binding.runId).sends.map((send) => send.phase),
					["final"],
				);
				pass(
					`the provider refused the request after the answer (HTTP 400, ${state.agent.length - 1} request(s) after it): the run's session ended as delivered, with its answer in the thread`,
				);
			},
		});
	await assert.rejects(
		proveCompanyRun({
			name: "qorpera_prove_b2_failed_before",
			prompt: "Is the price list ready?",
			setup: SETUP,
			objects: textObjects([NOTE.text]),
			calls: Array.from({ length: 8 }, () => () => ({ fail: 400 })),
			tools: agentTools([]),
			requests: () => true,
			check: async () => assert.fail("a run whose provider failed before any answer must not end as delivered"),
		}),
		(error) => !/must not end as delivered/.test(`${error?.message}`),
	);
	pass("the same provider error before any answer still fails the run's session");
}

// 5. An older kernel under this runtime: the bookkeeping after the answer is refused, nothing is written ----------------
{
	const sent = [];
	// The receipt's begin as it was before 20260930748000: the wake's work gate alone, so nothing marks the four.
	const OLD_KERNEL = `do $$
	declare v text := pg_get_functiondef('public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure);
		v_from integer := strpos(v, E'\\t-- 20260930748000 (the answer first)');
		v_last text := E'\\tperform set_config(''qorpera.after_answer'', '''', true);\\n';
		v_to integer := strpos(v, v_last);
	begin
		if v_from = 0 or v_to = 0 then raise exception 'the 20260930748000 block is not in the receipt''s begin'; end if;
		execute substr(v, 1, v_from - 1) || E'\\tperform public.qorpera_assert_wake_work_allowed(v_run.id);\\n'
			|| substr(v, v_to + length(v_last));
	end $$;`;
	await proveCompanyRun({
			name: "qorpera_prove_b2_old_kernel",
			prompt: "Is the price list ready? Keep your wall in step.",
			setup: `${SETUP}\n${OLD_KERNEL}`,
			objects: textObjects([NOTE.text]),
			calls: [answer, wall],
			tools: agentTools(sent),
			async check({ db, binding, run, outputs }) {
				assert.equal(
					db.query(`select position('20260930748000' in prosrc) from pg_proc
						where oid = 'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure`),
					"0",
					"this database's receipt begin is the one before 20260930748000",
				);
				assert.equal(outputs[0].envelope.status, "ok");
				assert.notEqual(outputs[1].envelope.status, "ok", outputs[1].output.slice(0, 300));
				assert.deepEqual(stored(db, binding.runId).receipts, []);
				assert.equal(await run.folder.readText(WALL, 64 * 1024, AbortSignal.timeout(30_000)), null);
				assert.deepEqual(
					stored(db, binding.runId).sends.map((send) => send.phase),
					["final"],
				);
				pass(
					`on a kernel without 20260930748000 the wall after the answer was answered ${outputs[1].envelope.status} ("${outputs[1].text.slice(0, 40)}"), no receipt was begun and no wall was written; the answer stands and the run's session ended`,
				);
			},
		});
}

process.stdout.write(
	`Times (model rounds of ${seconds(ROUND_MS)} s): answer ${seconds(times.before.answer)} s -> ${seconds(times.after.answer)} s; turn end ${seconds(times.before.end)} s -> ${seconds(times.after.end)} s\n`,
);
}

if (!process.env.QORPERA_CODEX_FENCE_BINARY) {
	process.stdout.write("NOT RUN: set QORPERA_CODEX_FENCE_BINARY to the patched Codex this tree pins\n");
	process.exit(0);
}
await finish(main());
