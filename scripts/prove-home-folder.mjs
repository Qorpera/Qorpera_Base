import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ENVIRONMENT, finish, pass, proveCompanyRun, repositoryRoot, textObjects } from "./prove-company-run.mjs";

// The agent's home in the company folder (slice 3, migration 20260930754000, as reworked after the audit of 13 Nov
// 2026). End to end, through the real patched Codex and a migrated database (scripts/prove-company-run.mjs says what is
// real and what stands in):
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-home-folder.mjs
//
// Alice's conversation run, with builder A's switch on for the company, has a home: the agent's own machine, started for
// the member she works for by an earlier run that has ended, whose boot has the company-wide view as every boot does.
// - The offer (A's qorpera_company_home_available, narrowed here) gives the run that machine and not the agent's machine
//   of another member; A's authority writes the session; the executor's ask answers it open, and the executor's own
//   parser reads the ids its folder command window carries.
// - Credit: a change made while the session's window is open carries the session's id in its credits; the commit names
//   the session and acts as Alice's run, and a path her agent may not write is denied in the folder.
// - Reads: a read the machine was served and the folder service released reaches Alice's run while her session is open
//   (the view itself acts as the agent alone: its starter's run has ended), and the executor's take-in for her run,
//   which every batch of the channel's output waits for in the executor's own gate, answers before anything leaves.
//   Once her session is closed, a release no longer reaches her.
// - A session left open by an executor that crashed, whose run ended long ago, credits nothing and is closed as ended.
// - A machine the run may not share is no home: another member's machine is not offered and its session is refused;
//   a closed session is refused as ended.
// - The mount gives /company to the image's agent account, and a backend without the migration refuses the executor's
//   ask by its code, so the executor starts no channel: the migration rolls before the executor.
// Real: as the harness says, plus the folder core's view open, commit, release and take-in, A's offer and authority,
// this migration's ask, and the executor's parser and output gate (bundled from packages/runner-orchestrator). Stand-ins:
// the machine and its placement rows are written as the executor's custody leaves them (SQL test 510 does the same),
// the boot's view is opened as the executor opens it, and the commit and the release are made as the folder service
// makes them with the session's window open. Not covered: the executor's own process and the folder service's (their
// unit tests drive them), a FUSE mount on a real machine, a real model's own shell.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const AGENT = "92400000-0000-4000-8000-000000000030";
const OWNER_USER = "92400000-0000-4000-8000-000000000001";
const PROFILE = "92400000-0000-4000-8000-000000000010";
const HOME = "40bb0000-0000-4000-8000-000000000001";
const OTHER_MEMBERS = "40bb0000-0000-4000-8000-000000000002";
const NODE = "40bb0000-0000-4000-8000-0000000000e2";
const EXECUTOR_NODE = "40bb0000-0000-4000-8000-000000000460";
/** The run that started the machines: an earlier run of Alice's for the same member, whose job was cancelled long ago,
 * so the boot's view has no live run and acts as the agent alone. */
const STARTER_RUN = "40bb0000-0000-4000-8000-0000000000a0";
const STARTER_JOB = "40bb0000-0000-4000-8000-0000000000a1";

/** The company's two machines of Alice's, as the executor's custody leaves them: one started for the member her run
 * works for, one for another member. Each has a running, reserved placement on its first boot. */
const SETUP = `
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'home-ack') \\g /dev/null
create schema home_proof;
-- The earlier run: Alice's run's own rows, copied under new ids, its job cancelled two hours ago.
do $$
declare v_run public.qorpera_execution_runs; v_job public.qorpera_runner_jobs;
begin
	select * into v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	select * into v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs select (jsonb_populate_record(null::public.qorpera_runner_jobs,
		to_jsonb(v_job) || jsonb_build_object('id', '${STARTER_JOB}', 'client_job_id', extensions.gen_random_uuid(),
			'run_id', '${STARTER_RUN}', 'status', 'cancelled', 'cancelled_at', clock_timestamp() - interval '2 hours',
			'cancelled_by_user_id', '${OWNER_USER}', 'lease_token_sha256', null, 'lease_expires_at', null, 'client_lease_id', null, 'result', null,
			'finished_at', null))).*;
	insert into public.qorpera_execution_runs select (jsonb_populate_record(null::public.qorpera_execution_runs,
		to_jsonb(v_run) || jsonb_build_object('id', '${STARTER_RUN}', 'job_id', '${STARTER_JOB}',
			'source_id', extensions.gen_random_uuid()))).*;
	set local session_replication_role = origin;
end $$;
create function home_proof.machine(p_id uuid, p_name text, p_member uuid, p_used timestamptz) returns uuid
language plpgsql as $$
declare v_place uuid := extensions.gen_random_uuid(); v_boot uuid := extensions.gen_random_uuid();
	v_instance text := encode(extensions.digest(v_place::text, 'sha256'), 'hex');
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
		desired_state, last_used_at)
	values (p_id, '${PROFILE}', '${ENVIRONMENT}', p_name, 'The agent''s home.', '${AGENT}', '${STARTER_RUN}',
		extensions.gen_random_uuid(), p_member, 2, 4294967296, 21474836480, 'standard', 'task', 'running', p_used);
	insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
		instance_sha256, running_at, boot_id)
	values (v_place, p_id, '${PROFILE}', 'node-a', repeat('8', 64), '{}', v_instance, clock_timestamp(), v_boot);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
		instance_sha256, reserved_at)
	values (v_place, '${PROFILE}', v_place, 'lxd', v_instance, clock_timestamp());
	-- The node row and its provider are not reached in replica mode (SQL test 510 places a machine the same way).
	insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256,
		cpu_millis, memory_bytes, reserved_at)
	values (v_place, '${NODE}', 'machine', 'lxd', repeat('4', 64), 2000, 4294967296, clock_timestamp());
	update public.qorpera_company_machine_placements set folder_unchecked_at = null where id = v_place;
	set local session_replication_role = origin;
	return v_place;
end $$;
-- A node with a machine executor, so the company has machines at all (as SQL tests 1241 and 1246 set it up).
create function home_proof.observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('${EXECUTOR_NODE}');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','${EXECUTOR_NODE}','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
end $$;
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-proof','providerPolicySha256',repeat('f',64),
	'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines',
	'network','qagent0');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','${EXECUTOR_NODE}','machineIdSha256',repeat('c',64),'label','machine-proof','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','${EXECUTOR_NODE}','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,
		'infrastructure','[]'::jsonb));
	perform home_proof.observe();
	perform public.qorpera_enroll_runtime_node_provider('${EXECUTOR_NODE}', repeat('c',64), 'machine', 'machine-proof',
		repeat('f',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-proof', repeat('c',64), true, v_policy, 322122547200);
end $$;
do $$
begin
	perform home_proof.machine('${HOME}', 'alice-home', '${OWNER_USER}', clock_timestamp() - interval '1 hour');
	-- Another member's machine of the same agent, used more lately: still no home of this run's.
	perform home_proof.machine('${OTHER_MEMBERS}', 'alice-other-member', (select user_id from public.qorpera_profile_members
		where profile_id = '${PROFILE}' and user_id <> '${OWNER_USER}' order by user_id limit 1), clock_timestamp());
	perform pg_temp.base_commit('{"kind":"platform"}', 'home-seed', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','home-proof'),
		jsonb_build_object('op','write','path','home-proof/plan.txt','file',pg_temp.base_stage('plan'))));
end $$;
`;

/** The executor's parser and output gate, bundled as the executor carries them. */
async function executorCode(scratch) {
	const modulePath = join(scratch, "executor.mjs");
	await build({
		absWorkingDir: repositoryRoot,
		stdin: {
			resolveDir: repositoryRoot,
			contents:
				'export {HomeOutputGate, parseHomeFolderAnswer} from "./packages/runner-orchestrator/src/machine-home-folder.ts";',
		},
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: modulePath,
		logLevel: "silent",
	});
	return import(pathToFileURL(modulePath).href);
}

await finish(
	proveCompanyRun({
		name: "qorpera_prove_home_folder",
		prompt: "Read the plan you were given, then say what it says.",
		setup: SETUP,
		objects: textObjects(["plan"]),
		calls: [() => ({ name: "company_read", arguments: { path: "home-proof/plan.txt" } })],
		async check({ db, binding, outputs }) {
			const scratch = await mkdtemp(join(tmpdir(), "prove-home-folder-"));
			try {
				const executor = await executorCode(scratch);
				const runId = binding.runId;
				// The executor's control: the service role's calls, as PostgREST makes them.
				const control = (method, args) => db.direct(method, args);
				const service = (text) =>
					db.json(`begin;
						set local request.jwt.claims = '{"role":"service_role"}';
						${text.replace(/;?\s*$/, "")};
						commit;`);
				const row = (sql) => db.json(`select coalesce((${sql}), 'null')::text`);
				const placeOf = (machine) =>
					row(`select to_jsonb(p) from public.qorpera_company_machine_placements p
						where p.machine_id = '${machine}' and p.retired_at is null`);
				const home = placeOf(HOME);

				assert.match(outputs[0].text, /plan/, `the plan's text: ${outputs[0].text}`);
				pass("the run's own folder tools work in the run that gets a home");

				// The boot's company-wide view, opened as the executor opens it at every boot.
				const view = service(`select public.qorpera_folder_view_open('${ENVIRONMENT}', '{"kind":"platform"}'::jsonb,
					'test_machine', jsonb_build_object('companyMachineId','${HOME}','placementId','${home.id}',
						'bootId','${home.boot_id}'))::text`);
				const actor = JSON.stringify({ kind: "view", viewId: view.viewId, pass: view.pass });
				assert.equal(
					service(`select to_jsonb(public.qorpera_folder_reads_root('${ENVIRONMENT}', '${PROFILE}', '${AGENT}',
						'${OWNER_USER}'))::text`),
					true,
					"Alice and her member read the folder's root",
				);

				// 1. The offer, A's authority, and the executor's ask.
				service(`insert into public.qorpera_home_settings(singleton, enabled) values (true, true);
					insert into public.qorpera_home_companies(profile_id) values ('${PROFILE}');
					select to_jsonb(1)::text`);
				const offer = control("qorpera_company_home_available", { p_binding: binding });
				assert.equal(offer.available, true, JSON.stringify(offer));
				assert.equal(offer.machineId, HOME, "the offer is the agent's machine for this member, not the newer one");
				const session = db.json("select to_jsonb(extensions.gen_random_uuid())::text");
				const authorized = control("qorpera_authorize_home_session", {
					p_binding: binding,
					p_scope: { machineId: HOME },
					p_session_id: session,
				});
				assert.equal(authorized.state, "authorized", JSON.stringify(authorized));
				const asked = executor.parseHomeFolderAnswer(
					control("qorpera_folder_home_session_window", { p_session_id: session }),
					{ sessionId: session, placementId: home.id },
				);
				assert.equal(asked.state, "open", JSON.stringify(asked));
				assert.deepEqual(asked.session, {
					sessionId: session,
					runId,
					staffAgentId: AGENT,
					requestedByUserId: OWNER_USER,
					machineId: HOME,
					placementId: home.id,
					bootId: home.boot_id,
				});
				pass("the run is offered its agent's machine for its own member, and the executor's ask opens its session");

				// 2. Credit: the folder service saves what the machine changed while the session's window was open, with the
				// window's id (the session's) in each unit's credits, through the boot's own view.
				const commit = (key, units) =>
					service(`select public.qorpera_folder_commit('${ENVIRONMENT}', '${actor}'::jsonb, '${key}',
						'${JSON.stringify(units)}'::jsonb)::text`);
				const credited = commit("home-credited", [
					{ op: "mkdir", path: "home-proof/made", credits: [session] },
					{ op: "mkdir", path: "QorperaOS/rules/home-made", credits: [session] },
				]);
				assert.equal(credited.units[0].outcome, "saved", JSON.stringify(credited));
				assert.equal(credited.units[1].outcome, "denied", JSON.stringify(credited));
				const saved = row(`select to_jsonb(c) from public.qorpera_folder_commits c where c.id = '${credited.commitId}'`);
				assert.deepEqual(saved.credits, [session]);
				assert.equal(saved.view_kind, "test_machine");
				assert.equal(saved.view_id, view.viewId);
				assert.equal(saved.run_id, runId, "the commit acts as the session's run, not the machine's starter");
				assert.equal(saved.actor_id, AGENT);
				// A session of another machine is no credit on this one: that unit is refused alone.
				const stranger = db.json("select to_jsonb(extensions.gen_random_uuid())::text");
				const refused = commit("home-stranger", [{ op: "mkdir", path: "home-proof/stranger", credits: [stranger] }]);
				assert.equal(refused.units[0].outcome, "refused", JSON.stringify(refused));
				assert.equal(refused.units[0].reason, "command_ended");
				pass("a change the home makes while its session is open is credited to the session, and acts as its run");

				// 3. Reads: what the machine was served reaches the run while its session is open, and its take-in answers
				// before the executor's gate lets the channel's output out.
				const entry = service(`select public.qorpera_folder_read('${ENVIRONMENT}', '${actor}'::jsonb,
					'home-proof/plan.txt')::text`).entry;
				const release = (id) =>
					service(`select public.qorpera_folder_record_release('${ENVIRONMENT}', '${actor}'::jsonb, '${id}',
						'${JSON.stringify([{ path: entry.path, version: entry.version, authority: entry.authority }])}'::jsonb,
						repeat('5', 64))::text`);
				const reached = (id) =>
					Number(
						db.json(`select to_jsonb(count(*))::text from public.qorpera_folder_run_read_records
							where run_id = '${runId}' and release_id = '${id}'`),
					);
				const first = db.json("select to_jsonb(extensions.gen_random_uuid())::text");
				const released = release(first);
				assert.equal(released.runId, null, "the view acts as the agent alone: its starter's run has ended");
				assert.equal(reached(first), 1, "the release reaches the run with a session open on the machine");
				const order = [];
				const gate = new executor.HomeOutputGate({
					release: async () => {
						const taken = control("qorpera_folder_test_machine_inherit_reads", {
							p_placement_id: home.id,
							p_boot_id: home.boot_id,
							p_run_id: runId,
							p_inherit_id: db.json("select to_jsonb(extensions.gen_random_uuid())::text"),
						});
						assert.equal(taken.schema, "qorpera.folder-inherit/v1", JSON.stringify(taken));
						assert.equal(taken.viewId, view.viewId);
						assert(taken.reads >= 1, JSON.stringify(taken));
						order.push("taken in");
						return undefined;
					},
					pass: (chunk) => order.push(`out ${chunk.toString()}`),
					fail: (why) => order.push(`failed ${why}`),
					spacingMs: 200,
					limitBytes: 1024,
				});
				gate.push(Buffer.from('{"id":1}'));
				assert.deepEqual(order, [], "nothing leaves before the release");
				await gate.drained();
				assert.deepEqual(order, ["taken in", 'out {"id":1}']);
				pass("what the machine read reaches the session's run, and its output leaves only after the run's take-in");

				// 4. The run's session closes: a release no longer reaches it, and the executor's ask says it ended.
				control("qorpera_close_home_session", { p_binding: binding, p_session_id: session, p_reason: "ended" });
				const later = db.json("select to_jsonb(extensions.gen_random_uuid())::text");
				release(later);
				assert.equal(reached(later), 0, "a closed session's run");
				assert.deepEqual(
					executor.parseHomeFolderAnswer(control("qorpera_folder_home_session_window", { p_session_id: session }), {
						sessionId: session,
						placementId: home.id,
					}),
					{ state: "refused", reason: "HOME_SESSION_ENDED" },
				);
				// What it saved while it was open stays credited to it.
				const kept = row(`select to_jsonb(c.credits) from public.qorpera_folder_commits c where c.id = '${credited.commitId}'`);
				assert.deepEqual(kept, [session]);
				pass("a closed session hears it ended, its reads stop, and its credit stays");

				// 4b. A session an executor that crashed left open, of a run that ended long ago (the starter's, its job
				// cancelled two hours ago): a change that still names it is credited to no one's session, and the
				// session is closed as ended.
				const stale = db.json("select to_jsonb(extensions.gen_random_uuid())::text");
				service(`set local session_replication_role = replica;
					insert into public.qorpera_company_home_sessions(id, machine_id, placement_id, boot_id, run_id,
						staff_agent_id, requested_by_user_id, opened_at)
					values ('${stale}', '${HOME}', '${home.id}', '${home.boot_id}', '${STARTER_RUN}', '${AGENT}',
						'${OWNER_USER}', clock_timestamp() - interval '2 hours');
					select to_jsonb(1)::text`);
				const late = commit("home-stale", [{ op: "mkdir", path: "home-proof/after-the-run", credits: [stale] }]);
				assert.equal(late.units[0].outcome, "saved", JSON.stringify(late));
				const lateCommit = row(`select to_jsonb(c) from public.qorpera_folder_commits c where c.id = '${late.commitId}'`);
				assert.equal(lateCommit.credits, null, "a run that is over is credited");
				const staleRow = row(`select to_jsonb(s) from public.qorpera_company_home_sessions s where s.id = '${stale}'`);
				assert.notEqual(staleRow.closed_at, null);
				assert.equal(staleRow.close_reason, "ended");
				pass("a session whose run is over credits nothing more, and is closed as ended");

				// 5. Another member's machine of the same agent is no home of this run's: A's authority would open a session
				// there, and the executor's ask refuses it, so no channel starts.
				const other = placeOf(OTHER_MEMBERS);
				const strangerSession = db.json("select to_jsonb(extensions.gen_random_uuid())::text");
				const there = control("qorpera_authorize_home_session", {
					p_binding: binding,
					p_scope: { machineId: OTHER_MEMBERS },
					p_session_id: strangerSession,
				});
				assert.equal(there.state, "authorized", JSON.stringify(there));
				assert.deepEqual(
					executor.parseHomeFolderAnswer(
						control("qorpera_folder_home_session_window", { p_session_id: strangerSession }),
						{ sessionId: strangerSession, placementId: other.id },
					),
					{ state: "refused", reason: "HOME_NOT_SHARED" },
				);
				pass("a machine the run may not share is not offered, and the executor refuses a session on it");

				// 6. The mount gives /company to the image's agent account, not to root, and carries no environment.
				const unit = readFileSync(join(repositoryRoot, "deploy/machine/qorpera-machine-folder.service"), "utf8");
				const owner = /--allow-other yes --owner-uid (\d+) --owner-gid (\d+)$/m.exec(unit);
				assert(owner, "the machine's mount names the agent account's ids");
				const image = readFileSync(join(repositoryRoot, "deploy/machine/build-machine-image.sh"), "utf8");
				assert.match(image, new RegExp(`useradd --uid ${owner[1]} --gid ${owner[2]} [^\\n]*qorpera-agent`));
				assert.doesNotMatch(unit, /^(Environment|EnvironmentFile|PassEnvironment)/m);
				pass("the machine's mount gives the company folder to the agent's own account, not to root");

				// 7. The order of a roll: over a backend without the migration the executor's ask is refused by its code (the
				// function is missing: PostgreSQL's 42883, or PostgREST's PGRST202 once its schema cache reloaded), so the
				// executor starts no channel and A's relay tells the model the machine is not available.
				db.query("drop function public.qorpera_folder_home_session_window(uuid)");
				let missing;
				assert.throws(
					() => control("qorpera_folder_home_session_window", { p_session_id: session }),
					(error) => {
						missing = error;
						return true;
					},
				);
				assert(["42883", "PGRST202"].includes(missing?.code) && missing?.status === 404, `the refusal: ${missing?.code}`);
				pass("without the migration the executor's ask is refused by its code, so the migration rolls first");
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		},
	}),
);
