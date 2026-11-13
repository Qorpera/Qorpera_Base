import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ENVIRONMENT, finish, pass, proveCompanyRun, repositoryRoot } from "./prove-company-run.mjs";

// agent-box slice 5 (migration 20260930757000): a sleeping machine keeps its disk unless its server is really short, and
// never loses it silently. End to end, through the real patched Codex and a migrated database
// (scripts/prove-company-run.mjs says what is real and what stands in):
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-disk-kept.mjs
//
// Three machines sleep on the node's executor: Alice's alice-old (unused for 3 days), Alice's alice-recent (2 hours) and
// another company's other-old (5 days, asleep longest), 40 GiB each, so the executor's paper budget (120 GiB) is full, as
// node 2's was on 13 Nov. Its LXD pool is node 2's as read that day (1.45 TiB, 539.5 GiB used; each sleeping disk about
// 30 MiB of its own). Alice's conversation run, with the runtime's own machine tools:
// - What the model provider sees: machine_start and machine_stop say when a machine comes back with an empty disk, and
//   that the result then says diskFreed.
// - Full on paper, real room: a new machine (market-data) is placed and runs, and no sleeping disk goes.
// - Real pressure (the pool so full that 25 GiB are left above the reserve; alice-old holds 30 GiB, other-old 20 GiB of
//   their own): the next machine (second-job) waits in line while alice-old's disk goes (Alice's own old one: not the
//   other company's that slept longest, not her recent one), only it; alice-old's row says when; then it runs.
// - Take-again: her next task machine of alice-old's size is alice-recent, which kept its disk; the one after is alice-old,
//   whose answer says its disk was freed and that it starts empty, and it runs on a new disk that says so too.
// Real: as the harness says, plus the runtime's machine tools (a conversation's), every kernel function they and the
// executor call (start, status, the disk report, admission, custody, mark running, release), the executor's own LXD
// client read of the pool (LxdUnixClient.readStoragePoolUse) and its own report (companyMachineDiskReport). Stand-ins:
// the executor's process (its pass, made by these calls in its order: report, admission, its steps), LXD (an HTTP server
// on a Unix socket answering the two reads as node 2's LXD 6.9 did, its figures the proof's) and the machine (a boot is
// the guest's mark). Not covered: a real VM, LXD's own deletion, a real model.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const GIB = 1073741824;
// Node 2's pool, read 13 Nov 2026 17:50Z (lanes/agent-box-20261113/home/node-read-pool.out).
const POOL_TOTAL = 1589674780672;
const POOL_USED = 579340568064;
const RESERVE = Math.floor(POOL_TOTAL / 5);
const OTHER = "12530000-0000-4000-8000-000000000010";
const OTHER_ENVIRONMENT = "12530000-0000-4000-8000-000000000020";
const NODE = "d0000000-0000-4000-8000-000000000410";

const SETUP = `
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'dk-ack') \\g /dev/null
create schema dk_proof;
create function dk_proof.observe() returns void language plpgsql as $$
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
create function dk_proof.list() returns jsonb language sql as $$
	select public.qorpera_list_executor_machines('mx-dk', repeat('c', 64))
$$;
create function dk_proof.placement(p_id uuid) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement where placement.id = p_id
$$;
create function dk_proof.custody(p_id uuid, p_intent text) returns jsonb language sql as $$
	select public.qorpera_authorize_executor_machine(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256, p_intent) from dk_proof.placement(p_id) p
$$;
-- The executor's boot of a placed machine: its custody to run, and the guest's mark of a new boot.
create function dk_proof.mark(p_id uuid) returns jsonb language plpgsql as $$
begin
	perform dk_proof.custody(p_id, 'run');
	return (select public.qorpera_mark_company_machine_running(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256, extensions.gen_random_uuid()) from dk_proof.placement(p_id) p);
end $$;
-- The executor deleted a retired placement's VM and disk: its custody to delete, then the release.
create function dk_proof.release(p_id uuid) returns jsonb language plpgsql as $$
begin
	perform dk_proof.custody(p_id, 'delete');
	return (select public.qorpera_release_company_machine(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256) from dk_proof.placement(p_id) p);
end $$;
-- A machine that ran on this node and sleeps on its disk, asleep and last used p_ago ago.
create function dk_proof.asleep(p_name text, p_profile uuid, p_environment uuid, p_ago interval) returns void language plpgsql as $$
declare v_machine uuid; v_placement uuid;
begin
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
	values (extensions.gen_random_uuid(), p_profile, p_environment, p_name, 'Earlier work', '92400000-0000-4000-8000-000000000030',
		null, null, (select requested_by_user_id from public.qorpera_execution_runs
			where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid),
		1, 2147483648, 42949672960, 'standard', 'task')
	returning id into v_machine;
	perform dk_proof.observe();
	perform public.qorpera_admit_executor_machines('mx-dk', repeat('c', 64), 16);
	v_placement := (public.qorpera_company_machine_placement(v_machine)).id;
	if v_placement is null then raise exception 'dk_proof: % was not placed', p_name; end if;
	perform dk_proof.mark(v_placement);
	perform public.qorpera_set_company_machine_desired((select m from public.qorpera_company_machines m where m.id = v_machine),
		'stopped', 'kernel');
	perform dk_proof.custody(v_placement, 'stop');
	perform public.qorpera_suspend_company_machine(p.id, p.owner, public.qorpera_company_machine_binding_text(p.binding),
		p.machine_id_sha256) from dk_proof.placement(v_placement) p;
	update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() - p_ago where allocation_id = v_placement;
	update public.qorpera_company_machines set last_used_at = clock_timestamp() - p_ago where id = v_machine;
end $$;
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-dk','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','${NODE}','machineIdSha256',repeat('c',64),'label','machine-dk','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','${NODE}','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform dk_proof.observe();
	perform public.qorpera_enroll_runtime_node_provider('${NODE}', repeat('c',64), 'machine', 'machine-dk', repeat('f',64), 8000,
		34359738368);
	perform public.qorpera_configure_machine_executor('mx-dk', repeat('c',64), true, v_policy, 300::bigint * 1073741824);
	-- Another company on the company folder.
	insert into auth.users(id, email) values ('12530000-0000-4000-8000-000000000001', 'other-owner@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values ('${OTHER}', 'Another company', '12530000-0000-4000-8000-000000000001');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values ('${OTHER}', '12530000-0000-4000-8000-000000000001', 'other-owner@example.test', 'Other', 'owner');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values ('${OTHER_ENVIRONMENT}', '${OTHER}', 'Environment', 1, '12530000-0000-4000-8000-000000000001');
	perform public.qorpera_folder_enable('${OTHER_ENVIRONMENT}');
	perform dk_proof.asleep('other-old', '${OTHER}', '${OTHER_ENVIRONMENT}', interval '5 days');
	perform dk_proof.asleep('alice-old', '92400000-0000-4000-8000-000000000010', '${ENVIRONMENT}', interval '3 days');
	perform dk_proof.asleep('alice-recent', '92400000-0000-4000-8000-000000000010', '${ENVIRONMENT}', interval '2 hours');
	-- Full on paper, as node 2 was: the budget is what the three sleeping disks claim.
	perform public.qorpera_configure_machine_executor('mx-dk', repeat('c',64), true, v_policy, 120::bigint * 1073741824);
end $$;
`;

/** A tool output's answer, as the model got it. */
const answer = (output) => {
	const content = JSON.parse(output).content;
	return JSON.parse(content.text ?? JSON.stringify(content.value));
};

/** The executor's own code, bundled from the tree: LXD's client and the executor's report. */
async function executorCode() {
	const scratch = await mkdtemp(join(tmpdir(), "prove-disk-kept-"));
	const out = join(scratch, "executor.mjs");
	await build({
		absWorkingDir: repositoryRoot,
		stdin: {
			resolveDir: repositoryRoot,
			contents: [
				'export {LxdUnixClient} from "./packages/runner-orchestrator/src/lxd-client.ts";',
				'export {lxdCompanyMachineName} from "./packages/runner-orchestrator/src/company-machine.ts";',
				'export {companyMachineDiskReport} from "./packages/runner-orchestrator/src/company-machine-disk.ts";',
			].join("\n"),
		},
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: out,
		logLevel: "silent",
	});
	return { code: await import(pathToFileURL(out).href), scratch };
}

/** LXD on a Unix socket: the pool's resources and each VM disk's state, as node 2's LXD 6.9 answered them, from `lxd`. */
async function fakeLxd(lxd, scratch) {
	const socket = join(scratch, "lxd.socket");
	const server = createServer((request, response) => {
		const url = request.url ?? "";
		lxd.requests.push(url);
		const reply = (status, body) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (url === "/1.0/storage-pools/machines/resources")
			return reply(200, {
				type: "sync",
				status: "Success",
				status_code: 200,
				metadata: { inodes: { total: 0, used: 0 }, space: { total: lxd.total, used: lxd.used } },
			});
		const volume = /^\/1\.0\/storage-pools\/machines\/volumes\/virtual-machine\/([a-z0-9-]+)\/state\?project=machines$/.exec(url);
		if (volume && lxd.own.has(volume[1]))
			return reply(200, {
				type: "sync",
				status: "Success",
				status_code: 200,
				metadata: { usage: { total: 40 * GIB, used: lxd.own.get(volume[1]) } },
			});
		reply(404, { type: "error", error_code: 404, error: "Instance not found" });
	});
	await new Promise((done) => server.listen(socket, done));
	return { server, socket };
}

const proof = { db: null, executor: null, lxd: null, socket: null, reports: [], deleted: [], starts: [], passes: 0, waking: new Map() };

/** SQL as the service role (the executor's own calls). Its last line. */
const service = (sql) =>
	proof.db
		.query(`begin;
		select set_config('request.jwt.claims', '{"role":"service_role"}', true) \\g /dev/null
		${sql}
		commit;`)
		.split("\n")
		.at(-1);

const nameOf = (placementId) => proof.executor.lxdCompanyMachineName(placementId);
const ownOf = (machine) => {
	const placement = proof.db.query(`select coalesce((select p.id::text from public.qorpera_company_machine_placements p
		join public.qorpera_company_machines m on m.id = p.machine_id where m.name = '${machine}' and m.removed_at is null
			and p.retired_at is null and p.removed_at is null), '')`);
	assert(placement, `${machine} holds a disk`);
	return nameOf(placement);
};

/** One pass of the executor, in its order: the disk report (LXD's read, the report), admission, then its steps (a
 * retired placement's VM and disk deleted, then released; a placed machine booted). */
async function executorPass() {
	proof.passes++;
	const listed = JSON.parse(service("select dk_proof.list()::text;"));
	const named = new Map(listed.map((e) => [nameOf(e.placementId), e.placementId]));
	const use = await new proof.executor.LxdUnixClient(proof.socket).readStoragePoolUse(
		"machines",
		[...named.keys()].map((name) => ({ project: "machines", name })),
		AbortSignal.timeout(5000),
	);
	const report = proof.executor.companyMachineDiskReport("machines", use, named);
	const recorded = JSON.parse(
		service(`select public.qorpera_report_executor_disk('mx-dk', repeat('c', 64), $dk$${JSON.stringify(report)}$dk$::jsonb)::text;`),
	);
	assert.equal(recorded.state, "recorded", JSON.stringify(recorded));
	proof.reports.push({ report, roomBytes: recorded.roomBytes });
	service("select dk_proof.observe();");
	for (let i = 0; i < 8; i++)
		if (service("select public.qorpera_admit_executor_machines('mx-dk', repeat('c', 64), 16)::text;") === "[]") break;
	for (const e of JSON.parse(service("select dk_proof.list()::text;"))) {
		const name = nameOf(e.placementId);
		if (e.removeDue && !e.released) {
			proof.lxd.used -= proof.lxd.own.get(name) ?? 0;
			proof.lxd.own.delete(name);
			proof.deleted.push(e.machineId);
			service(`select dk_proof.release('${e.placementId}');`);
		} else if (e.desiredState === "running" && e.reserved && e.runningAt === null) {
			// A new clone holds nothing of its own yet; a woken one keeps what it holds.
			if (!proof.lxd.own.has(name)) proof.lxd.own.set(name, 0);
			service(`select dk_proof.mark('${e.placementId}');`);
		}
	}
}

/** The executor's passes until the machine runs (a wake's word ends its wait, as the real executor's does). */
function untilRunning(machineId) {
	if (!proof.waking.has(machineId))
		proof.waking.set(
			machineId,
			(async () => {
				try {
					for (let i = 0; i < 20; i++) {
						await executorPass();
						const state = service(`select public.qorpera_company_machine_state(m) from public.qorpera_company_machines m
							where m.id = '${machineId}';`);
						if (state === "running") return true;
						await new Promise((done) => setTimeout(done, 300));
					}
					return false;
				} finally {
					proof.waking.delete(machineId);
				}
			})(),
		);
	return proof.waking.get(machineId);
}

const gateway = {
	async start() {
		throw new Error("not in this proof");
	},
	async read() {
		throw new Error("not in this proof");
	},
	async cancel() {
		throw new Error("not in this proof");
	},
	async wake(scope, wait) {
		const running = untilRunning(scope.machineId);
		return wait ? await running : true;
	},
};

const START = (key, name, cpus) => ({
	name: "machine_start",
	arguments: { operationKey: key, name, purpose: `Work for ${name}`, cpus, memoryGiB: 2 * cpus, diskGiB: 40 },
});
const CALLS = [
	// 0: full on paper, real room: a new machine of another size than her sleeping ones (none to take again).
	() => START("dk-market", "market-data", 2),
	// 1: real pressure: an agent's data on two sleeping disks, and the pool so full that 25 GiB are left above the reserve
	// with market-data awake (its 40 GiB could all still be written).
	() => {
		// What the first start left: every disk deleted so far, and each sleeping machine's placements and freed time.
		proof.afterFirst = {
			deleted: proof.deleted.length,
			sleeping: proof.db.json(`select jsonb_object_agg(m.name, jsonb_build_object('freed', m.disk_freed_at,
					'retired', (select count(*) from public.qorpera_company_machine_placements p
						where p.machine_id = m.id and p.retired_at is not null)))::text
				from public.qorpera_company_machines m where m.name in ('alice-old', 'alice-recent', 'other-old') and m.removed_at is null`),
		};
		proof.lxd.own.set(ownOf("alice-old"), 30 * GIB);
		proof.lxd.own.set(ownOf("other-old"), 20 * GIB);
		proof.lxd.own.set(ownOf("alice-recent"), 1 * GIB);
		proof.lxd.own.set(ownOf("market-data"), 0);
		proof.lxd.used = POOL_TOTAL - RESERVE - 40 * GIB - 25 * GIB;
		return START("dk-second", "second-job", 2);
	},
	// 2: a task machine of her sleeping machines' size: one of her own is taken again.
	() => START("dk-notes-a", "notes-a", 1),
	// 3: another one, after other work on the server freed 100 GiB.
	() => {
		proof.lxd.used -= 100 * GIB;
		return START("dk-notes-b", "notes-b", 1);
	},
];

let executorScratch;
await finish(
	(async () => {
		const executor = await executorCode();
		executorScratch = executor.scratch;
		proof.executor = executor.code;
		proof.lxd = { total: POOL_TOTAL, used: POOL_USED, own: new Map(), requests: [] };
		const lxd = await fakeLxd(proof.lxd, executor.scratch);
		proof.socket = lxd.socket;
		try {
			await proveCompanyRun({
				name: "qorpera_prove_disk_kept",
				prompt: "Start machines for the market data and the second job, then two for notes.",
				setup: SETUP,
				objects: new Map(),
				calls: CALLS,
				moreTools(code, { db, binding, identity, operations, paths }) {
					proof.db = db;
					// The sleeping disks as node 2's LXD gave them (about 30 MiB each of their own).
					proof.lxd.own.set(ownOf("other-old"), 33388032);
					proof.lxd.own.set(ownOf("alice-old"), 30721536);
					proof.lxd.own.set(ownOf("alice-recent"), 31457280);
					proof.paper = db.json(`select jsonb_build_object('budget', e.disk_bytes, 'claimed',
						public.qorpera_machine_executor_disk_used(e.owner))::text from public.qorpera_machine_executors e where e.owner = 'mx-dk'`);
					const tools = code.cloudMachineTools({ binding, identity, control: paths, operations, gateway });
					return tools.map((tool) =>
						tool.name !== "machine_start"
							? tool
							: {
									...tool,
									async execute(value, context) {
										// The executor passes every few seconds: its report is fresh when a start asks for room.
										await executorPass();
										const began = Date.now();
										const result = await tool.execute(value, context);
										proof.starts.push({ ms: Date.now() - began, value });
										return result;
									},
								},
					);
				},
				async check({ db, outputs, state, log }) {
					const machine = (name) =>
						db.json(`select coalesce((select to_jsonb(m) from public.qorpera_company_machines m where m.name = '${name}'
							and m.removed_at is null), 'null')::text`);
					const placements = (name) =>
						db.json(`select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'retired', p.retired_at is not null,
								'removed', p.removed_at is not null) order by p.created_at), '[]')::text
							from public.qorpera_company_machine_placements p join public.qorpera_company_machines m on m.id = p.machine_id
							where m.name = '${name}' and m.removed_at is null`);
					const answers = outputs.map((output) => ({ ...output, value: answer(output.output) }));
					for (const a of answers) assert.equal(a.envelope.status, "ok", a.output.slice(0, 400));

					// 1. What the model provider sees.
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
					const stop = find("machine_stop");
					assert(start && stop, `machine_start and machine_stop are offered: ${definitions.map((tool) => tool.name)}`);
					assert(
						start.description.includes(
							"Its disk is kept while the machine sleeps. It comes back with an empty disk only if its server ran out of disk, had no room for it at the wake, is gone, or moved to a new machine image; the result then says diskFreed. Keep what matters in the company's files.",
						),
						start.description,
					);
					assert(
						stop.description.includes(
							"Its disk is kept for a wake on the same server; only if that server runs out of disk, has no room at the wake, is gone or moves to a new machine image does it come back with an empty disk, and its status then says diskFreed.",
						),
						stop.description,
					);
					pass(
						"the model provider sees machine_start and machine_stop say when a machine comes back with an empty disk, and that the result then says diskFreed",
					);

					const [market, second, notesA, notesB] = answers;
					// 2. Full on paper, real room.
					assert.equal(proof.paper.budget, 120 * GIB);
					assert.equal(proof.paper.claimed, 120 * GIB, "the paper budget was full");
					const firstRoom = proof.reports[0].roomBytes;
					assert.equal(firstRoom, POOL_TOTAL - POOL_USED - RESERVE, JSON.stringify(proof.reports[0]));
					assert.equal(market.value.machine.name, "market-data");
					assert.equal(market.value.machine.state, "running");
					assert.equal(market.value.machine.diskFreed, null);
					const firstStart = db.json(`select (r.result #> '{content,value,machine}')::text from public.qorpera_run_operation_receipts r
						where r.logical_operation_key = 'machine_start:dk-market'`);
					assert.equal(firstStart.state, "starting", "placed at the start itself, no line");
					assert.equal(proof.afterFirst.deleted, 0);
					assert.deepEqual(proof.afterFirst.sleeping, {
						"alice-old": { freed: null, retired: 0 },
						"alice-recent": { freed: null, retired: 0 },
						"other-old": { freed: null, retired: 0 },
					});
					pass(
						`full on paper (${proof.paper.claimed / GIB} of ${proof.paper.budget / GIB} GiB claimed), the executor's report from LXD (node 2's pool: ${(POOL_TOTAL / GIB).toFixed(1)} GiB, ${(POOL_USED / GIB).toFixed(1)} used) gave ${(firstRoom / GIB).toFixed(1)} GiB of room: market-data was placed at its start and ran; no sleeping disk went`,
					);

					// 3. Real pressure: the right disk goes, only it, and the row says so.
					const pressed = db.json(`select (r.result #> '{content,value,machine}')::text from public.qorpera_run_operation_receipts r
						where r.logical_operation_key = 'machine_start:dk-second'`);
					assert.equal(pressed.state, "waiting", JSON.stringify(pressed));
					const pressedRoom = proof.reports.find((r) => r.roomBytes < 40 * GIB);
					assert.equal(pressedRoom?.roomBytes, 25 * GIB, JSON.stringify(proof.reports.map((r) => r.roomBytes)));
					assert.equal(second.value.machine.name, "second-job");
					assert.equal(second.value.machine.state, "running");
					const aliceOld = machine("alice-old");
					assert.deepEqual(proof.deleted, [aliceOld.id], "only alice-old's disk was deleted");
					assert(aliceOld.disk_freed_at, "alice-old's row says when its disk was freed");
					assert.equal(placements("alice-old")[0].retired, true);
					assert.equal(placements("alice-old")[0].removed, true);
					for (const name of ["alice-recent", "other-old"]) {
						assert.equal(placements(name)[0].retired, false, name);
						assert.equal(machine(name).disk_freed_at, null, name);
					}
					pass(
						`real pressure (25 GiB of room above the reserve): second-job waited in line (${proof.starts[1].ms} ms in its call) while alice-old's disk went (Alice's own, unused for 3 days, 30 GiB of its own) and not other-old's (another company's, asleep longest) or alice-recent's (used 2 hours ago); only that disk was deleted; alice-old's row says when (${aliceOld.disk_freed_at}); then second-job ran`,
					);

					// 4. Take-again: the one that kept its disk first; then the emptied one, said so.
					assert.equal(notesA.value.machine.name, "alice-recent");
					assert.equal(
						notesA.value.reused,
						"your own free machine alice-recent of this size was given to you again instead of a new one: use the name alice-recent",
					);
					assert.equal(notesA.value.machine.diskFreed, null);
					assert.equal(notesB.value.machine.name, "alice-old");
					assert.equal(
						notesB.value.reused,
						"your own free machine alice-old of this size was given to you again instead of a new one: use the name alice-old. Its disk was freed while it slept, so it starts with an empty disk: what you left on it is gone",
					);
					assert.match(
						notesB.value.machine.diskFreed,
						/^its disk was freed while it slept \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\): it comes back with an empty disk, so what was on it before is gone; the company's files are kept$/,
					);
					assert.equal(notesB.value.machine.state, "running");
					const notesBStart = db.json(`select (r.result #> '{content,value,machine}')::text from public.qorpera_run_operation_receipts r
						where r.logical_operation_key = 'machine_start:dk-notes-b'`);
					assert.match(notesBStart.diskFreed, /^its disk was freed while it slept/);
					assert.deepEqual(
						placements("alice-old").map((p) => [p.retired, p.removed]),
						[
							[true, true],
							[false, false],
						],
					);
					pass(
						`take-again: her next task machine of that size was alice-recent, which kept its disk (no word of a freed disk); the one after was alice-old, whose answer says: "${notesB.value.reused.split(". ")[1]}", and it ran on a new disk whose view says "${notesB.value.machine.diskFreed.slice(0, 60)}..."`,
					);

					// 5. The executor's reads and reports: LXD's two reads, every report recorded.
					assert(proof.lxd.requests.includes("/1.0/storage-pools/machines/resources"));
					assert(proof.lxd.requests.some((url) => url.includes("/volumes/virtual-machine/qorpera-machine-")));
					const stored = db.json(`select to_jsonb(d)::text from public.qorpera_machine_executor_disks d where d.owner = 'mx-dk'`);
					assert.equal(stored.total_bytes, POOL_TOTAL);
					assert.equal(stored.pool, "machines");
					pass(
						`the executor's own LXD read and report: ${proof.passes} passes, ${proof.reports.length} reports recorded, ${proof.lxd.requests.length} LXD reads; the kernel keeps the latest (${(stored.used_bytes / GIB).toFixed(1)} of ${(stored.total_bytes / GIB).toFixed(1)} GiB used)`,
					);

					// 6. The run's work log keeps every call.
					assert.deepEqual(
						log.index.map((step) => step.tool),
						["machine_start", "machine_start", "machine_start", "machine_start"],
					);
					assert(log.index.every((step) => step.finished));
					pass(`the run's work log keeps all ${log.index.length} machine calls, each finished`);
					process.stdout.write(
						`Starts: ${proof.starts.map((s) => `${s.value.name} ${s.ms} ms`).join(", ")}; rooms (GiB): ${proof.reports
							.map((r) => (r.roomBytes / GIB).toFixed(1))
							.join(", ")}\n`,
					);
				},
			});
		} finally {
			await new Promise((done) => lxd.server.close(() => done()));
			await rm(executorScratch, { recursive: true, force: true });
		}
	})(),
);
