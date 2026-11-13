import assert from "node:assert/strict";
import { ENVIRONMENT, finish, pass, proveCompanyRun, textObjects } from "./prove-company-run.mjs";

// The agent's home, slice 3 (migration 20260930754000): a folder window per run. End to end, through the real patched
// Codex and a migrated database (scripts/prove-company-run.mjs says what is real and what stands in):
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-home-folder-window.mjs
//
// Alice's conversation run has a home machine. The relay asks the folder for a window on it before a session starts
// there, and the home mounts the window instead of the company folder:
// - The window belongs to exactly one run: its row names the run, the machine, the placement (its own machine id) and
//   the boot, and the folder service learns its kind and its machine from the renewal it does by the window's pass.
// - It shows the run's own folder: a file under a narrower resource that only Alice's agent holds a grant on is read
//   through the window, and NOT through the company-wide view of another machine, which reads the root and the rules
//   alone. A path the run may not read is read through neither. The refusal is the folder's, never the home's.
// - Every read released under the window is recorded as that run's read, as a read through the run's own tools is.
// - A change the window saves while a native call is open carries the call's id, and the commit is credited to it; the
//   call's id is its own run operation receipt, begun by the real receipt function, so the change carries that receipt
//   as a write through machine_run does. With the call ended, a change credits nothing and is the run's own alone.
// - If a window cannot be made, the session is not started: the ask answers refused and the runtime turns each reason
//   into plain words for the model (no steps, no commands, no terminal, no ids).
// - Both orders of a roll: over a kernel that does not list the three calls yet (an old backend), the ask is refused as
//   an unknown call and the relay says so and starts no session, so the migration goes before the runtime bundle.
// Real: as the harness says, plus the runtime's own window module (openHomeFolderWindow, its calls and its words), the
// runtime's folder client, and every kernel function they use: the window's open, the calls' open and end, the folder's
// read, release and commit, the receipt's begin. Stand-ins: the machine and its placement rows are written as the
// executor's custody leaves them (SQL test 510 does the same), and the commits a window saves are made here as the
// folder service makes them (the same core call with the view actor and its credits). Not covered: the folder service's
// own process and the FUSE mount on the home, a real machine, a real model's own shell.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const AGENT = "92400000-0000-4000-8000-000000000030";
const OWNER_USER = "92400000-0000-4000-8000-000000000001";
const PROFILE = "92400000-0000-4000-8000-000000000010";
const HOME = "40bb0000-0000-4000-8000-000000000001";
const OTHER = "40bb0000-0000-4000-8000-000000000002";
const NODE = "40bb0000-0000-4000-8000-0000000000e2";
/** What the runtime's own refusal is when the backend does not carry the three functions yet: the class and the code it
 * raises, never its words (a public message is sanitised). 42883 is PostgreSQL's undefined_function. */
const ROLL_REFUSAL = "CloudCompanyFolderRpcError:42883";

/** The company's machines and their disks, as the executor's custody leaves them, plus a narrower folder resource that
 * only Alice's agent may read and one the run may not read at all. The other machine's disk gets the company-wide view
 * a test machine's boot opens, which is what makes it no home for a window. */
const SETUP = `
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'home-ack') \\g /dev/null
create schema home_proof;
-- A machine of Alice's, with a running, reserved placement on its first boot.
create function home_proof.machine(p_id uuid, p_name text) returns uuid language plpgsql as $$
declare v_place uuid := extensions.gen_random_uuid(); v_boot uuid := extensions.gen_random_uuid();
	v_instance text := encode(extensions.digest(v_place::text, 'sha256'), 'hex');
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
	select p_id, '${PROFILE}', '${ENVIRONMENT}', p_name, 'The agent''s home.', r.staff_agent_id, r.id,
		extensions.gen_random_uuid(), r.requested_by_user_id, 2, 4294967296, 21474836480, 'standard', 'task'
	from public.qorpera_execution_runs r
	where r.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
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
	-- A placement made before the folder check counts as used; these are fresh disks.
	update public.qorpera_company_machine_placements set folder_unchecked_at = null where id = v_place;
	set local session_replication_role = origin;
	return v_place;
end $$;
do $$
declare v_narrow uuid;
begin
	perform home_proof.machine('${HOME}', 'alice-home');
	perform home_proof.machine('${OTHER}', 'alice-other');
	-- The narrower folder: only Alice's agent holds a grant on it, and nobody on the locked one.
	perform public.base_seed_home_paths();
	v_narrow := public.qorpera_folder_set_resource('${ENVIRONMENT}',
		'{"kind":"member","userId":"${OWNER_USER}"}'::jsonb, 'home-narrow', 'subtree', 'company_shared', 'normal')
		->> 'resourceId';
	perform public.qorpera_folder_grant('${ENVIRONMENT}', '{"kind":"member","userId":"${OWNER_USER}"}'::jsonb, v_narrow,
		'staff_agent', '${AGENT}', array['read','write']);
	perform public.qorpera_folder_set_resource('${ENVIRONMENT}',
		'{"kind":"member","userId":"${OWNER_USER}"}'::jsonb, 'home-locked', 'subtree', 'company_shared', 'normal');
end $$;
`;

/** The two files the checks read: one under the narrower folder, one under the locked one. The platform writes both. */
const SEED = `
create function public.base_seed_home_paths() returns void language plpgsql as $$
begin
	perform pg_temp.base_commit('{"kind":"platform"}', 'home-seed', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','home-narrow'),
		jsonb_build_object('op','write','path','home-narrow/n.txt','file',pg_temp.base_stage('narrow')),
		jsonb_build_object('op','mkdir','path','home-locked'),
		jsonb_build_object('op','write','path','home-locked/l.txt','file',pg_temp.base_stage('locked'))));
end $$;
`;

const CALLS = [
	() => ({ name: "company_read", arguments: { path: "home-narrow/n.txt" } }),
	() => ({ name: "company_read", arguments: { path: "home-locked/l.txt" } }),
];

await finish(
	proveCompanyRun({
		name: "qorpera_prove_home_folder_window",
		prompt: "Read the two files you were given, then say what you found.",
		setup: `${SEED}${SETUP}`,
		// The bytes of the two files the setup stages, as the gateway holds them.
		objects: textObjects(["narrow", "locked"]),
		calls: CALLS,
		async check({ code, db, binding, run, outputs }) {
			const signal = () => AbortSignal.timeout(30_000);
			const runId = binding.runId;
			// Every folder core function wants the service role, and each psql call is its own session, so each one sets
			// the claim in a transaction of its own (SQL test 924's base_claims does the same inside the fixture).
			const service = (text) =>
				db.json(`begin;
					set local request.jwt.claims = '{"role":"service_role"}';
					${text.replace(/;?\s*$/, "")};
					commit;`);
			// Each psql call is its own session, so the placements are read from the rows, not from a setting.
			const placeOf = (machine) =>
				db.json(`select to_jsonb((select p.id from public.qorpera_company_machine_placements p
					where p.machine_id = '${machine}' and p.retired_at is null))::text`);
			const homePlace = placeOf(HOME);
			const otherPlace = placeOf(OTHER);
			const actor = (view) => JSON.stringify({ kind: "view", viewId: view.viewId, pass: view.pass });
			const read = (path, who) =>
				service(`select public.qorpera_folder_read('${ENVIRONMENT}', '${who}'::jsonb, '${path}')::text`);

			// The run's own tools still read what it may and not what it may not: the model saw both answers.
			assert.match(outputs[0].text, /narrow/, `the narrower file's text: ${outputs[0].text}`);
			assert.match(outputs[1].text, /"kind":"absent"/, `the locked file's answer: ${outputs[1].text}`);
			pass("the run's own folder tools read the narrower file and not the locked one");

			// 1. The relay asks for the window before a session starts on the home.
			const asked = await code.openHomeFolderWindow(run.folder, HOME, signal());
			assert("window" in asked, `the ask gave no window: ${JSON.stringify(asked)}`);
			const window = asked.window;
			const row = db.json(`select coalesce((select to_jsonb(v) from public.qorpera_folder_views v
				where v.id = '${window.viewId}'), 'null')::text`);
			assert.equal(row.kind, "home_window");
			assert.equal(row.state, "open");
			assert.equal(row.run_id, runId);
			assert.equal(row.company_machine_id, HOME);
			assert.equal(row.placement_id, homePlace);
			assert.equal(row.machine_id, row.placement_id);
			assert.equal(row.staff_agent_id, AGENT);
			assert.equal(row.job_id, null);
			pass("the window belongs to exactly one run, on its home's placement and boot");

			// The folder service learns what it serves from the renewal it does by the window's pass.
			const renewed = service(`select public.qorpera_folder_view_renew('${window.viewId}',
				'${window.pass}')::text`);
			assert.equal(renewed.state, "open");
			assert.equal(renewed.kind, "home_window");
			assert.equal(renewed.machineId, homePlace);
			assert.equal(renewed.companyId, PROFILE);
			pass("the folder service renews the window by its pass and learns its kind and its machine");

			// 2. The window shows the run's own folder, the company-wide view the company's.
			const wide = service(`select public.qorpera_folder_view_open('${ENVIRONMENT}', '{"kind":"platform"}'::jsonb,
				'test_machine', jsonb_build_object('companyMachineId','${OTHER}','placementId','${otherPlace}',
					'bootId',(select boot_id from public.qorpera_company_machine_placements where id = '${otherPlace}')))::text`);
			assert.equal(read("home-narrow/n.txt", actor(window)).found, true);
			assert.equal(read("home-narrow/n.txt", actor(wide)).found, false);
			assert.equal(read("home-locked/l.txt", actor(window)).found, false);
			assert.equal(read("home-locked/l.txt", actor(wide)).found, false);
			pass("the window reads the run's own folder; the company-wide view reads the root and the rules alone");

			// 3. A read released under the window is recorded as that run's read.
			const release = db.json("select to_jsonb(extensions.gen_random_uuid())::text");
			const entry = read("home-narrow/n.txt", actor(window)).entry;
			const released = service(`select public.qorpera_folder_record_release('${ENVIRONMENT}', '${actor(window)}'::jsonb,
				'${release}', jsonb_build_array(jsonb_build_object('path', ${sqlLiteral(entry.path)},
					'version', ${sqlLiteral(entry.version)}, 'authority', ${sqlLiteral(JSON.stringify(entry.authority))}::jsonb)),
				repeat('5', 64))::text`);
			assert.equal(released.runId, runId);
			const recorded = db.json(`select to_jsonb(count(*))::text from public.qorpera_folder_run_read_records
				where run_id = '${runId}' and release_id = '${release}'`);
			assert.equal(Number(recorded), 1);
			pass("every read the home makes under the window is recorded as that run's read");

			// 4. A native call on the window: its id is its own receipt, and what the window saves is credited to it.
			const callId = db.json("select to_jsonb(extensions.gen_random_uuid())::text");
			const receipt = service(`select public.qorpera_folder_begin_run_receipt('${JSON.stringify(binding)}'::jsonb,
				'${callId}', 'home_call:one', repeat('7', 64), repeat('8', 64), false)::text`);
			assert.equal(receipt.state, "executing", JSON.stringify(receipt));
			await window.startCall(callId, "apply_patch home-narrow/made.txt", signal());
			const open = db.json(`select coalesce((select to_jsonb(h) from public.qorpera_folder_home_calls h
				where h.call_id = '${callId}'), 'null')::text`);
			assert.equal(open.view_id, window.viewId);
			assert.equal(open.run_id, runId);
			assert.equal(open.ended_at, null);
			assert.equal(open.command_head, "apply_patch home-narrow/made.txt");
			const credited = service(`select public.qorpera_folder_commit('${ENVIRONMENT}', '${actor(window)}'::jsonb,
				'home-credited', jsonb_build_array(jsonb_build_object('op','mkdir','path','home-narrow/made',
					'credits', jsonb_build_array('${callId}'))))::text`);
			assert.equal(credited.units[0].outcome, "saved", JSON.stringify(credited));
			const commit = db.json(`select coalesce((select to_jsonb(c) from public.qorpera_folder_commits c
				where c.id = '${credited.commitId}'), 'null')::text`);
			assert.deepEqual(commit.credits, [callId]);
			assert.equal(commit.view_kind, "home_window");
			assert.equal(commit.run_id, runId);
			pass("a change the home makes while a call is open is credited to that call and to the call's own receipt");

			// 5. With the call ended, what the window saves credits nothing and is the run's own alone.
			assert.equal(await run.folder.endHomeCall({ viewId: window.viewId, callId }, signal()), true);
			assert.equal(await run.folder.endHomeCall({ viewId: window.viewId, callId }, signal()), false);
			const plain = service(`select public.qorpera_folder_commit('${ENVIRONMENT}', '${actor(window)}'::jsonb,
				'home-plain', jsonb_build_array(jsonb_build_object('op','mkdir','path','home-narrow/plain')))::text`);
			assert.equal(plain.units[0].outcome, "saved", JSON.stringify(plain));
			const after = db.json(`select coalesce((select to_jsonb(c) from public.qorpera_folder_commits c
				where c.id = '${plain.commitId}'), 'null')::text`);
			assert.equal(after.credits, null);
			assert.equal(after.run_id, runId);
			// A unit crediting the ended call is refused on its own, and applies nothing.
			const late = service(`select public.qorpera_folder_commit('${ENVIRONMENT}', '${actor(window)}'::jsonb,
				'home-late', jsonb_build_array(jsonb_build_object('op','mkdir','path','home-narrow/late',
					'credits', jsonb_build_array('${callId}'))))::text`);
			assert.equal(late.units[0].outcome, "refused");
			assert.equal(late.units[0].reason, "command_ended");
			assert.equal(read("home-narrow/late", actor(window)).found, false);
			pass("a call that ended credits nothing more, and a change naming it is refused on its own");

			// 6. No window, no session: the other machine's disk has held the company-wide view.
			const refused = await code.openHomeFolderWindow(run.folder, OTHER, signal());
			assert("refused" in refused, `a window on a disk that held the company-wide folder: ${JSON.stringify(refused)}`);
			assert.match(refused.refused, /held the whole company folder/);
			assert.doesNotMatch(refused.refused, /window|view|mount|terminal|[0-9a-f]{8}-/);
			const none = db.json(`select to_jsonb(count(*))::text from public.qorpera_folder_views
				where company_machine_id = '${OTHER}' and kind = 'home_window'`);
			assert.equal(Number(none), 0);
			pass("a home that cannot give a window gives plain words instead, and no window is made");

			// 7. Both orders of a roll: over a backend without the migration the function is not there, so the ask is
			// refused and the relay says plain words and starts no session; the migration goes before the bundle.
			db.query(`delete from public.qorpera_native_host_calls where name like 'qorpera_folder_home%';
				drop function public.qorpera_folder_home_window_open(uuid, jsonb, jsonb);
				drop function public.qorpera_folder_home_call_open(uuid, jsonb, jsonb);
				drop function public.qorpera_folder_home_call_end(uuid, jsonb, jsonb);`);
			// Whichever way an unmigrated backend refuses the ask — the function is not there (42883 here), or the native
			// host does not list the call (42501, the path a run's own box takes) — the relay gets plain words and starts
			// no session. The kernel's refusal is checked by its code, never by words a public message sanitises.
			let thrown;
			await assert.rejects(
				() => run.folder.openHomeWindow(HOME, signal()),
				(error) => {
					thrown = error;
					return true;
				},
			);
			const refusalOf = (error) => `${error?.constructor?.name ?? "?"}:${error?.code ?? "?"}`;
			assert.equal(refusalOf(thrown), ROLL_REFUSAL, `the kernel's refusal: ${refusalOf(thrown)}`);
			const withoutMigration = await code.openHomeFolderWindow(run.folder, HOME, signal());
			assert("refused" in withoutMigration, "a window from a backend that has no window calls");
			assert.match(withoutMigration.refused, /could not be made ready just now/);
			assert.doesNotMatch(withoutMigration.refused, /window|view|mount|terminal|[\da-f]{8}/i);
			pass("over a backend without the migration the ask gives plain words and no session, so a release runs the migration first");
		},
	}),
);

/** A SQL string literal for a value the checks read back from the folder. */
function sqlLiteral(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}
