import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENVIRONMENT, finish, pass, proveCompanyRun } from "./prove-company-run.mjs";

// agent-box B1 (migrations 20260930747000 and 20260930755000): an agent's machine is ready and used again, and the start
// waits for it by default. End to end, through the real patched Codex and a migrated database
// (scripts/prove-company-run.mjs says what is real and what stands in):
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-machine-ready.mjs
//
// Alice's conversation run (not a worker) starts machines with the runtime's own machine tools:
// - What the model provider sees: machine_start offers waitSeconds to a conversation's run (Codex sends its type; the
//   bound, 1 to 60, is in the description, and the runtime refuses more) and says the two new sentences; machine_read
//   still offers no wait to it.
// - Her own free machine of the size she asks for (asleep, made earlier) is given to her again in place of a new one,
//   woken, with the answer `reused` and its name; another agent's machine and one of hers for another member are not.
// - She waits for it in place in that call (no model turn spent) until it runs, and runs a command on it.
// - A second machine: hers is now in use by her run, so a new one, waited for in place too; the same start sent again
//   answers the same machine.
// - Both orders of a roll: a start with waitSeconds 0 (no wait, as an old runtime's never waited) answers at once and
//   she is woken when it runs, as before; a wait in place over the old kernel (qorpera_native_machine_manage as it was
//   before 747000 and 755000) still works, but leaves the kernel's word to wake her again after the run and keeps no
//   report of the wait: the migrations go before the runtime bundle.
// - The live case of 13 Nov: a start the model does not ask to wait (no waitSeconds) on a node whose machine disk budget
//   is full, as node 2's was: the start answers `waiting` (NODE_CAPACITY_EXHAUSTED), and the call waits by default
//   through that line while the executor makes room and boots it, and answers running.
// - After the run, the machine events drain delivers one continuation carrying only the words of the two machines she did
//   not see running in a wait of her own (the no-wait start, and the old kernel's), never those she waited for.
// - What is stored: each start's receipt and the machine rows (the purpose, the receipt, the starter kept), her command,
//   each wait's report (whether the model asked, how long, how it ended), and the run's work log with each call.
// Real: as the harness says, plus the runtime's machine tools (cloudMachineTools, a conversation's, not a worker's), and
// every kernel function they and the executor call: start, list, status, command authority, the executor's admission,
// custody and mark running, the machine events drain. Stand-ins: the machine executor's process and the machine (a wake
// boots the machine after BOOT_MS by the executor's own SQL calls; a command answers "hello" and is recorded ended, as
// the executor records it). Not covered: the executor's HTTP and LXD, a real VM and its boot time, the action review of
// machine_run, a real model.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALICE = "92400000-0000-4000-8000-000000000030";
const BOB = "92400000-0000-4000-8000-000000000031";
const CONTRIBUTOR = "92400000-0000-4000-8000-000000000002";
const NODE = "b1000000-0000-4000-8000-000000000410";
/** The stand-in machine's boot: the real one takes 15 to 23 s (p50); its length does not change what is proved. */
const BOOT_MS = 2500;
const SIZE = { cpus: 1, memoryGiB: 2, diskGiB: 40 };

/** The (old, new) pairs of a migration's patch of qorpera_native_machine_manage, to take it back for the old kernel. */
function managePatch(file, marker) {
	const migration = readFileSync(join(repositoryRoot, "supabase/migrations", file), "utf8");
	const section = migration.slice(migration.indexOf("'public.qorpera_native_machine_manage(jsonb,jsonb)'"));
	const block = section.slice(0, section.indexOf("]); end $$;") + 1);
	const pairs = [...block.matchAll(/\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$/g)].map(([, old, neu]) => ({
		old,
		neu,
	}));
	assert(pairs.length > 0 && pairs.some((pair) => pair.neu.includes(marker)), `${file}'s patch is found`);
	return pairs;
}
/** The status look's two texts in the migration (its section 4): new, and as master has it (the old kernel). */
function statusPatch() {
	const migration = readFileSync(
		join(repositoryRoot, "supabase/migrations/20260930747000_machine_ready_and_reused.sql"),
		"utf8",
	);
	const section = migration.slice(migration.indexOf("'public.qorpera_native_machine_manage(jsonb,jsonb)'"));
	const old = /array\[\$old\$([\s\S]*?)\$old\$,/.exec(section)[1];
	const neu = /\$new\$([\s\S]*?)\$new\$\]\); end \$\$;/.exec(section)[1];
	assert(neu.startsWith(old) && neu.includes("20260930747000"), "the migration's status patch is found");
	return { old, neu };
}

const SETUP = `
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'b1-ack') \\g /dev/null
-- A machine node and its executor, as SQL tests 1223 and 1241 make them: 8 cpus, 32 GiB, 300 GiB of disk.
create schema b1_proof;
create function b1_proof.observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('${NODE}');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','${NODE}','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
-- The executor's pass for one machine: admission until it is placed, custody to run, and the guest's mark of a new boot.
create function b1_proof.boot(p_machine uuid) returns text language plpgsql as $$
declare v_placement public.qorpera_company_machine_placements; v jsonb;
begin
	-- Room on its disk budget, as node 2's executor gives a sleeping machine's disk to a machine in line.
	perform b1_proof.disk_budget(322122547200);
	perform b1_proof.observe();
	for attempt in 1..12 loop
		select p.* into v_placement from public.qorpera_company_machine_placements p
		where p.machine_id = p_machine and p.retired_at is null and p.removed_at is null;
		exit when v_placement.id is not null;
		exit when public.qorpera_admit_executor_machines('mx-b1', repeat('c', 64), 16) = '[]'::jsonb;
	end loop;
	select p.* into strict v_placement from public.qorpera_company_machine_placements p
	where p.machine_id = p_machine and p.retired_at is null and p.removed_at is null;
	perform public.qorpera_authorize_executor_machine(v_placement.id, v_placement.owner,
		public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256, 'run');
	v := public.qorpera_mark_company_machine_running(v_placement.id, v_placement.owner,
		public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256, extensions.gen_random_uuid());
	return v #>> '{machine,state}';
end $$;
-- The executor's machine disk budget; null: full, exactly what its placements hold, so a new machine waits in line.
create function b1_proof.disk_budget(p_bytes bigint) returns void language sql as $$
	select public.qorpera_configure_machine_executor('mx-b1', repeat('c',64), true, jsonb_build_object('providerId','machine-b1',
		'providerPolicySha256',repeat('f',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','qagent0'), coalesce(p_bytes, (select sum(m.disk_bytes)
			from public.qorpera_company_machine_placements p join public.qorpera_company_machines m on m.id = p.machine_id
			where p.owner = 'mx-b1' and p.removed_at is null and p.retired_at is null)))
$$;
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-b1','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','${NODE}','machineIdSha256',repeat('c',64),'label','machine-b1','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','${NODE}','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform b1_proof.observe();
	perform public.qorpera_enroll_runtime_node_provider('${NODE}', repeat('c',64), 'machine', 'machine-b1', repeat('f',64), 8000,
		34359738368);
	perform public.qorpera_configure_machine_executor('mx-b1', repeat('c',64), true, v_policy, 322122547200);
end $$;
-- Machines made earlier, asleep: Alice's own for the member her run works for (as a member's start makes one: no starter
-- run), Bob's, and Alice's for another member. Each the size Alice will ask for.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state,
	desired_by, last_used_at)
select extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010', '${ENVIRONMENT}', m.name, 'Earlier work', m.agent,
	null, null, coalesce(m.member, (select requested_by_user_id from public.qorpera_execution_runs
		where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid)),
	${SIZE.cpus}, ${SIZE.memoryGiB}::bigint * 1073741824, ${SIZE.diskGiB}::bigint * 1073741824, 'standard', 'task', 'stopped', 'kernel',
	clock_timestamp() - interval '2 days'
from (values ('web-tests', '${ALICE}'::uuid, null::uuid), ('bob-box', '${BOB}', null), ('for-another', '${ALICE}', '${CONTRIBUTOR}'))
	as m(name, agent, member);
`;

/** A tool output's answer, as the model got it. */
const answer = (output) => {
	const content = JSON.parse(output).content;
	return JSON.parse(content.text ?? JSON.stringify(content.value));
};

/** Shared with the scripted calls and the stand-in: the database, and what the stand-in saw. */
const proof = { db: null, binding: null, starts: [], boots: new Map() };
const patch = statusPatch();
const waitsPatch = managePatch("20260930755000_machine_start_waits.sql", "20260930755000");
/** SQL that puts qorpera_native_machine_manage back as the old kernel had it (`back`), or forward again. */
const manageAs = (back) => {
	const pairs = [{ old: patch.old, neu: patch.neu }, ...waitsPatch];
	const steps = (back ? [...pairs].reverse() : pairs).map(({ old, neu }) => {
		const [from, to] = back ? [neu, old] : [old, neu];
		return `if strpos(d, $b1from$${from}$b1from$) = 0 then raise exception 'B1 patch text not found'; end if;
				d := replace(d, $b1from$${from}$b1from$, $b1to$${to}$b1to$);`;
	});
	return `do $b1$ declare d text := pg_get_functiondef('public.qorpera_native_machine_manage(jsonb,jsonb)'::regprocedure);
			begin ${steps.join("\n")} execute d; end $b1$;`;
};

/** SQL as the service role (the executor's and the drain's own calls). Its last line. */
const service = (sql) =>
	proof.db.query(`begin;
		select set_config('request.jwt.claims', '{"role":"service_role"}', true) \\g /dev/null
		${sql}
		commit;`)
		.split("\n")
		.at(-1);

/** The machine executor and the machine, stood in by the executor's own SQL calls. */
function standIn() {
	const boot = (machineId) => {
		if (!proof.boots.has(machineId))
			proof.boots.set(
				machineId,
				(async () => {
					const asked = Date.now();
					await new Promise((done) => setTimeout(done, BOOT_MS));
					const state = service(`select b1_proof.boot('${machineId}');`);
					return { asked, ran: Date.now(), state };
				})(),
			);
		return proof.boots.get(machineId);
	};
	const receipt = (machineId, commandId, inputSha256) => ({
		schema: "qorpera.machine-command-result/v1",
		machineId,
		commandId,
		inputSha256,
		state: "succeeded",
		exitCode: 0,
		output: "hello\n",
		truncated: false,
		log: { offset: 0, nextOffset: 6, totalBytes: 6, limitBytes: 67108864, limitReached: false },
	});
	return {
		async start(scope, input) {
			// The executor asks the kernel's command authority with the run's binding, then runs it; it records the end.
			const authority = proof.db.direct("qorpera_authorize_machine_command", {
				p_binding: proof.binding,
				p_scope: scope,
				p_action: "start",
				p_command_id: input.commandId,
				p_input_sha256: input.inputSha256,
				p_detail: { commandHead: input.command, notify: input.notify },
			});
			assert.equal(authority.state, "authorized", JSON.stringify(authority));
			proof.db.query(`update public.qorpera_company_machine_commands set ended_at = clock_timestamp(), state = 'succeeded',
				exit_code = 0, output_tail = 'hello' where id = '${input.commandId}'`);
			return receipt(scope.machineId, input.commandId, input.inputSha256);
		},
		async read(scope, input) {
			return receipt(scope.machineId, input.commandId, "0".repeat(64));
		},
		async cancel() {
			throw new Error("not in this proof");
		},
		async wake(scope, wait) {
			const booting = boot(scope.machineId);
			return wait ? (await booting).state === "running" : true;
		},
	};
}

/** A new task machine; `wait` is the waitSeconds the model passes, or none (the default wait). */
const START = (key, name, wait) => ({
	name: "machine_start",
	arguments: {
		operationKey: key,
		name,
		purpose: `Work for ${name}`,
		...SIZE,
		...(wait === undefined ? {} : { waitSeconds: wait }),
	},
});
const CALLS = [
	// 0: a new task machine, waiting for it in place.
	() => START("b1-market", "market-research", 60),
	// 1: a command on the machine she got.
	(outputs) => ({
		name: "machine_run",
		arguments: { operationKey: "b1-hello", machine: answer(outputs.at(-1).output).machine.name, command: "echo hello" },
	}),
	// 2: a second machine while she still uses the first.
	() => START("b1-second", "second-task", 60),
	// 3: the first start sent again.
	() => START("b1-market", "market-research", 60),
	// 4: a start that does not wait (waitSeconds 0), as an old runtime's never did.
	() => START("b1-third", "third-task", 0),
	// 5: a wait in place over the old kernel: qorpera_native_machine_manage as it was before 747000 and 755000.
	() => {
		proof.db.query(manageAs(true));
		return START("b1-fourth", "fourth-task", 60);
	},
	// 6: the live case of 13 Nov: no waitSeconds, and the node's machine disk budget full, so the start answers waiting.
	() => {
		proof.db.query(manageAs(false));
		service("select b1_proof.disk_budget(null);");
		return START("b1-in-line", "word-count", undefined);
	},
];

await finish(
	proveCompanyRun({
		name: "qorpera_prove_machine_ready",
		prompt: "Start a machine for the market research and say hello on it; then two more tasks.",
		setup: SETUP,
		objects: new Map(),
		calls: CALLS,
		moreTools(code, { db, binding, identity, operations, paths }) {
			proof.db = db;
			proof.binding = binding;
			const tools = code.cloudMachineTools({ binding, identity, control: paths, operations, gateway: standIn() });
			// The time each machine_start call takes, as the model waits for it.
			return tools.map((tool) =>
				tool.name !== "machine_start"
					? tool
					: {
							...tool,
							async execute(value, context) {
								const began = Date.now();
								const result = await tool.execute(value, context);
								proof.starts.push({ ms: Date.now() - began, value });
								return result;
							},
						},
			);
		},
		async check({ db, binding, outputs, state, log }) {
			const runId = binding.runId;
			const machine = (name) =>
				db.json(`select coalesce((select to_jsonb(m) from public.qorpera_company_machines m where m.name = '${name}'
					and m.removed_at is null), 'null')::text`);
			const events = (name) =>
				db.json(`select coalesce(jsonb_agg(e.delivery order by e.created_at), '[]')::text
					from public.qorpera_company_machine_events e join public.qorpera_company_machines m on m.id = e.machine_id
					where m.name = '${name}' and e.parent_run_id = '${runId}' and e.kind = 'running'`);
			const answers = outputs.map((output) => ({ ...output, value: answer(output.output) }));
			/** Each wait's report the kernel kept for this run (20260930755000), by machine, oldest first. */
			const reports = () =>
				db.json(`select coalesce(jsonb_agg(jsonb_build_object('machine', m.name, 'asked', w.asked, 'limit', w.limit_seconds,
						'before', w.state_before, 'waitingFor', w.waiting_for, 'ms', w.waited_ms, 'outcome', w.outcome, 'after', w.state_after,
						'worker', w.worker) order by w.created_at, w.id), '[]')::text
					from public.qorpera_company_machine_start_waits w join public.qorpera_company_machines m on m.id = w.machine_id
					where w.run_id = '${runId}'`);
			for (const a of answers) assert.equal(a.envelope.status, "ok", a.output.slice(0, 400));

			// 1. What the model provider sees: the tool definitions in Codex's request.
			// Every object in the first request that names a tool, wherever Codex puts its definitions.
			const definitions = [];
			const walk = (value) => {
				if (Array.isArray(value)) for (const item of value) walk(item);
				else if (value && typeof value === "object") {
					if (typeof value.name === "string" && typeof value.description === "string") definitions.push(value);
					for (const item of Object.values(value)) walk(item);
				}
			};
			walk(state.agent[0].body);
			const find = (name) => definitions.find((tool) => tool.name === name || tool.name.endsWith(`__${name}`));
			const start = find("machine_start");
			const read = find("machine_read");
			assert(
				start && read,
				`machine_start and machine_read are offered: keys ${Object.keys(state.agent[0].body)}, ${definitions.map((tool) => tool.name)}`,
			);
			const parameters = start.parameters ?? start.input_schema ?? start.inputSchema;
			// Codex sends the provider a property's type, not its bounds: the bound reaches the model in the description, and
			// the runtime refuses more (machine_start's parseArguments).
			assert.equal(parameters.properties.waitSeconds?.type, "integer", JSON.stringify(parameters.properties.waitSeconds));
			assert(!(read.parameters ?? read.input_schema ?? read.inputSchema).properties.waitSeconds);
			assert(
				start.description.includes(
					"A new task machine is one of your own again when one of that size is free (woken if asleep): the result says reused; use its name.",
				) &&
					start.description.includes(
						"The call waits up to 60 s while it starts, with no model turn spent (waitSeconds: less, 0 for none); if it is not running yet, finish this run normally: you are woken when it runs.",
					),
			);
			pass(
				`the model provider sees machine_start with waitSeconds (${JSON.stringify(parameters.properties.waitSeconds)}; the default wait of 60 s and how to ask for less in its description) and the reuse sentence; machine_read offers a conversation's run no wait`,
			);

			// 2. Her own free machine again, woken, waited for in place.
			const [first, run, second, replay, third, fourth, inLine] = answers;
			const reusedText =
				"your own free machine web-tests of this size was given to you again instead of a new one: use the name web-tests";
			assert.equal(first.value.machine.name, "web-tests");
			assert.equal(first.value.machine.state, "running");
			assert.equal(first.value.reused, reusedText);
			const webTests = machine("web-tests");
			assert.equal(webTests.purpose, "Work for market-research");
			assert.equal(webTests.started_by_run_id, null, "its starter is kept (none: a member's start made it)");
			assert.equal(webTests.desired_state, "running");
			const receipt = db.json(`select to_jsonb(r)::text from public.qorpera_run_operation_receipts r where r.id = '${webTests.reused_by_receipt_id}'`);
			assert.equal(receipt.run_id, runId);
			assert.equal(receipt.logical_operation_key, "machine_start:b1-market");
			// The kernel finds a live run's earlier asks by the machine in their receipts: the runtime keeps it there.
			assert.equal(receipt.result.content.value.machine.machineId, webTests.id, JSON.stringify(receipt.result).slice(0, 300));
			assert.equal(
				db.query(`select count(*) from public.qorpera_run_operation_receipts r where r.run_id = '${runId}'
					and r.logical_operation_key like 'machine_start:%' and r.status = 'completed'
					and r.result #>> '{content,value,machine,machineId}' = '${webTests.id}'`),
				"1",
			);
			for (const name of ["bob-box", "for-another"]) {
				const other = machine(name);
				assert.equal(other.desired_state, "stopped", name);
				assert.equal(other.purpose, "Earlier work", name);
				assert.equal(other.reused_by_receipt_id, null, name);
			}
			pass(
				"her own free machine web-tests (asleep two days) was given to her again in place of a new one: woken, its purpose the new one, the start's receipt kept on it (and the machine in that receipt's stored answer, where the kernel looks for a live run's asks), its starter kept; Bob's and the one for another member were not touched",
			);
			const waited = proof.starts[0].ms;
			const booted = [...proof.boots.values()];
			assert(waited >= BOOT_MS && waited < BOOT_MS + 6000, `the first start waited ${waited} ms`);
			assert.deepEqual(events("web-tests"), ["suppressed"]);
			pass(
				`she waited for it in place in the same call: ${waited} ms for a ${BOOT_MS} ms boot, no model turn spent; the kernel's word to wake her when it ran is suppressed, since her own look saw it running`,
			);
			assert.equal(run.value.state, "succeeded");
			assert.equal(run.value.output, "hello\n");
			const command = db.json(`select to_jsonb(c)::text from public.qorpera_company_machine_commands c
				where c.machine_id = '${webTests.id}'`);
			assert.equal(command.run_id, runId);
			assert.equal(command.state, "succeeded");
			pass("she ran a command on it in the same run; the kernel recorded it as her run's");

			// 3. A second machine: hers is in use by her run, so a new one; the same start again answers the same machine.
			assert.equal(second.value.machine.name, "second-task");
			assert.equal(second.value.machine.state, "running");
			assert.equal(second.value.reused, undefined);
			assert.equal(machine("second-task").started_by_run_id, runId);
			assert.deepEqual(events("second-task"), ["suppressed"]);
			assert(proof.starts[1].ms >= BOOT_MS && proof.starts[1].ms < BOOT_MS + 6000, `${proof.starts[1].ms} ms`);
			assert.equal(replay.value.machine.machineId, first.value.machine.machineId);
			assert.equal(replay.value.reused, reusedText);
			assert(proof.starts[2].ms < 2000, `the replay took ${proof.starts[2].ms} ms`);
			pass(
				`with web-tests in use by her own run, the second start made a new machine and waited ${proof.starts[1].ms} ms for it in place (its word suppressed too); the first start sent again answered web-tests, reused, at once`,
			);

			// 4. Both orders of a roll.
			assert.equal(third.value.machine.name, "third-task");
			assert(["waiting", "starting"].includes(third.value.machine.state), third.value.machine.state);
			assert(proof.starts[3].ms < 2500, `the start without a wait took ${proof.starts[3].ms} ms`);
			// Its boot ends after the call; wait for it before reading what the kernel left.
			for (let i = 0; i < 100 && machine("third-task").notify_run_ids.length > 0; i++)
				await new Promise((done) => setTimeout(done, 100));
			assert.deepEqual(events("third-task"), ["waiting"]);
			pass(
				`a start with waitSeconds 0 (no wait, as an old runtime's) answered at once (${proof.starts[3].ms} ms, ${third.value.machine.state}); she stayed on the list, and when it ran the kernel left its word to wake her, as before`,
			);
			assert.equal(fourth.value.machine.name, "fourth-task");
			assert.equal(fourth.value.machine.state, "running");
			assert.deepEqual(events("fourth-task"), ["waiting"]);
			pass(
				"a wait in place over the old kernel (machine_manage as before 747000 and 755000) still works, but leaves the kernel's word to wake her again after the run, and keeps no report of the wait: the migrations go before the runtime bundle",
			);

			// 5. The live case of 13 Nov: no waitSeconds, a node whose machine disk budget is full.
			const lined = db.json(`select (r.result #> '{content,value,machine}')::text from public.qorpera_run_operation_receipts r
				where r.run_id = '${runId}' and r.logical_operation_key = 'machine_start:b1-in-line'`);
			assert.equal(lined.state, "waiting", JSON.stringify(lined));
			assert.equal(lined.waitingFor, "NODE_CAPACITY_EXHAUSTED");
			assert.equal(inLine.value.machine.name, "word-count");
			assert.equal(inLine.value.machine.state, "running");
			assert(proof.starts[5].ms >= BOOT_MS && proof.starts[5].ms < BOOT_MS + 8000, `${proof.starts[5].ms} ms`);
			assert.deepEqual(events("word-count"), ["suppressed"]);
			pass(
				`the live case: with the node's disk budget full the start answered waiting (NODE_CAPACITY_EXHAUSTED, place ${lined.queuePosition}), and with no waitSeconds the call waited ${proof.starts[5].ms} ms through that line and the boot by default, then answered running; its word to wake her is suppressed`,
			);

			// 6. Each wait is kept for a release to count: whether the model asked, how long, how it ended.
			const kept = reports();
			assert.deepEqual(
				kept.map((r) => [r.machine, r.asked, r.limit, r.before, r.waitingFor, r.outcome, r.after, r.worker]),
				[
					["web-tests", true, 60, "starting", null, "running", "running", false],
					["second-task", true, 60, "starting", null, "running", "running", false],
					["third-task", true, 0, "starting", null, "not_asked", "starting", false],
					["word-count", false, 60, "waiting", "NODE_CAPACITY_EXHAUSTED", "running", "running", false],
				],
				JSON.stringify(kept),
			);
			assert(kept[3].ms >= BOOT_MS && kept[3].ms <= proof.starts[5].ms, JSON.stringify(kept[3]));
			assert.equal(kept[2].ms, 0);
			pass(
				`each wait is kept (${kept.length} rows): the three waits with how long and how they ended (running), the start that asked not to wait (not_asked); none for the replay (its machine already ran) nor over the old kernel (no report then)`,
			);

			// 7. After the run: the machine events drain continues her only with the words she did not see in a wait.
			db.query(`set session_replication_role = replica;
				update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
					lease_token_sha256 = null, lease_expires_at = null
				where id = '${binding.jobId}';`);
			const drained = JSON.parse(service(`select public.qorpera_folder_machine_events_company('${ENVIRONMENT}', 8)::text;`));
			assert.equal(drained.state, "done", JSON.stringify(drained));
			assert.equal(drained.delivered, 1, JSON.stringify(drained));
			assert.deepEqual(events("web-tests"), ["suppressed"]);
			assert.deepEqual(events("second-task"), ["suppressed"]);
			assert.deepEqual(events("third-task"), ["delivered"]);
			assert.deepEqual(events("fourth-task"), ["delivered"]);
			assert.deepEqual(events("word-count"), ["suppressed"]);
			const wake = db.json(`select to_jsonb(w)::text from public.qorpera_wake_occurrences w
				where w.parent_run_id = '${runId}' and w.source_kind = 'machine-event'`);
			const named = wake.payload.events.map((event) => event.machine ?? event.machineName ?? event.name);
			assert.equal(wake.payload.events.length, 2, JSON.stringify(wake.payload));
			assert(JSON.stringify(wake.payload).includes("third-task") && JSON.stringify(wake.payload).includes("fourth-task"));
			for (const name of ["web-tests", "second-task", "word-count"]) assert(!JSON.stringify(wake.payload).includes(name), name);
			pass(
				`after the run, the machine events drain made one continuation for her (${JSON.stringify(named)}): only the words of the no-wait start and the old kernel's wait; none for the three machines she waited for`,
			);

			// 8. The run's work log keeps every call.
			assert.deepEqual(
				log.index.map((step) => step.tool),
				["machine_start", "machine_run", "machine_start", "machine_start", "machine_start", "machine_start", "machine_start"],
			);
			assert(log.index.every((step) => step.finished));
			pass(`the run's work log keeps all ${log.index.length} machine calls, each finished (${log.blocks.length} blocks)`);
			process.stdout.write(
				`Starts: ${proof.starts.map((s) => `${s.value.name ?? s.value.machine} ${s.ms} ms`).join(", ")}; boots: ${booted.length}\n`,
			);
		},
	}),
);
