// Local PostgreSQL only: applies every migration to a disposable container and
// proves the 2026-09-16 placement chooser with two registered nodes. No hosted
// database, provider or node is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-node-placement-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "placement", "-v", "ON_ERROR_STOP=1"];
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout?.slice(-4000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = (text) => docker(psql, text);
const literal = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
const read = (path) => readFileSync(join(root, path), "utf8");
const nodeA = "36000000-0000-4000-8000-000000000010", // the capacity fixture node, reconfigured to the amendment sizes
	nodeB = "36000000-0000-4000-8000-0000000000b2";
const policy = (id, label, machine) => ({
	schema: "qorpera.runtime-node-policy/v1", nodeId: id, machineIdSha256: machine, label, cpuMillis: 32000, memoryBytes: 131072 * 1024 * 1024,
	headroomCpuMillis: 8000, headroomMemoryBytes: 60 * 1024 * 1024 * 1024, standardCpuMillis: 8000, standardMemoryBytes: 16 * 1024 * 1024 * 1024, enabled: true,
});
const observe = (id, machine, state = "ready") => `select public.qorpera_test_observe_runtime_node(${literal({
	schema: "qorpera.runtime-node-observation/v1", nodeId: id, machineIdSha256: machine, observationId: randomUUID(),
	observedAt: new Date().toISOString(), cpuMillis: 32000, memoryBytes: 131072 * 1024 * 1024, state })});`;
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "-e", "POSTGRES_PASSWORD=disposable-placement", "-e", "POSTGRES_DB=placement", POSTGRES_IMAGE]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "placement"], { timeout: 2000 });
		ready = result.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(ready, 2, "postgres did not become ready");
	sql(read("supabase/tests/bootstrap.sql"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) sql(read(`supabase/migrations/${name}`));
	sql(read("supabase/tests/fixtures/runtime-node-inventory-observer.sql"));
	const mA = "c".repeat(64), mB = "b".repeat(64);
	// Governed companies, offices and the fixture node come from the capacity proof's setup.
	const wake = read("supabase/tests/300_runtime_wake_bus.test.sql").split("-- END WAKE FIXTURE");
	const office = read("supabase/tests/fixtures/runtime-office-registry-cases.sql").split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");
	assert.equal(wake.length, 2); assert.equal(office.length, 2);
	sql(`${wake[0]}\n${office[0]}\n${read("supabase/tests/fixtures/runtime-node-capacity-setup.sql")}\ncommit;`);
	sql(`${service} select public.qorpera_configure_runtime_node(${literal(policy(nodeA, "node-a", mA))},1); select public.qorpera_configure_runtime_node(${literal(policy(nodeB, "node-b", mB))},0);`);
	sql(`${service} select public.qorpera_enroll_runtime_node_provider('${nodeA}','${mA}','native','native-a',repeat('1',64),4000,8589934592);
		select public.qorpera_enroll_runtime_node_provider('${nodeB}','${mB}','native','native-b',repeat('2',64),4000,8589934592);
		select public.qorpera_enroll_runtime_node_provider('${nodeA}','${mA}','login','login-a',repeat('3',64),4000,8589934592);`);
	// No observations yet: nobody is eligible; the chooser defers (records it) and leaves the node-level reservation to refuse.
	const alloc1 = randomUUID();
	let d = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${alloc1}','native','native-a');`));
	assert.equal(d.decision, "deferred");
	assert.equal(d.reason, "NO_ELIGIBLE_NODE");
	sql(`${service} ${observe(nodeA, mA)} ${observe(nodeB, mB)}`);
	// Both eligible and empty: ties resolve to the lowest node id (node A).
	d = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${alloc1}','native','native-a');`));
	assert.equal(d.decision, "placed"); assert.equal(d.reason, "LEAST_LOADED"); assert.equal(d.preferredNodeId, nodeA);
	const dB = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','native-b');`));
	assert.equal(dB.decision, "refused"); assert.equal(dB.reason, "NODE_NOT_PREFERRED"); assert.equal(dB.preferredNodeId, nodeA);
	// Load node A through the official path: the capacity proof's governed companies and office
	// registrations give two real office allocations; both are reserved on node A (8000 mCPU / 16 GiB each).
	const secondCompany = wake[0].split("insert into public.qorpera_shared_sessions")[0]
		.replaceAll("30000000", "30100000").replaceAll("path-", "second-path-")
		.replaceAll("where sha256 = current_setting", "where profile_id='30100000-0000-4000-8000-000000000010' and sha256 = current_setting");
	const secondOffice = office[0].split("create function pg_temp.office_call")[0].replaceAll("30000000", "30100000").replaceAll("34000000", "34100000");
	const helpers = wake[0].split("-- BEGIN WAKE HELPERS")[1].split("create function pg_temp.wake_routine")[0];
	sql(`${secondCompany}\n${helpers}\n${secondOffice}\n${service}
	 select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,'36000000-0000-4000-8000-000000000001',repeat('e',64),0,true);
	 select public.qorpera_reserve_runtime_machine('34100000-0000-4000-8000-000000000088','lxd',repeat('d',64),null,null,(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,1); commit;`);
	const offices = JSON.parse(sql(`select jsonb_agg(jsonb_build_object('id',a.id,'policy',p.policy_sha256,'instance',a.instance_sha256)) from public.qorpera_runtime_machine_allocations a
		join public.qorpera_runtime_office_providers p on p.office_id=a.office_id and p.computer_generation=a.computer_generation where a.runner_id is null;`));
	assert.equal(offices.length, 2);
	sql(`${service} ${observe(nodeA, mA)} ${observe(nodeB, mB)}`);
	// The fixture already binds office provider …01 (policy f…, 2000 mCPU / 2 GiB) to node A; reserving that office there loads node A to 2 free slots against node B's 3.
	const fixtureOffice = offices.find((o) => o.policy === "f".repeat(64));
	assert(fixtureOffice, "fixture office allocation missing");
	const r = JSON.parse(sql(`${service} select public.qorpera_reserve_runtime_node_machine('${fixtureOffice.id}','office','36000000-0000-4000-8000-000000000001','${fixtureOffice.policy}','${fixtureOffice.instance}','${mA}',2000,2147483648);`));
	assert.equal(r.state, "reserved", JSON.stringify(r));
	// Historical policy rows for the same provider on one node must not multiply that node's demand.
	sql(`insert into public.qorpera_runtime_node_providers(provider_kind,provider_id,node_id,policy_sha256,cpu_millis,memory_bytes) values ('native','native-a','${nodeA}',repeat('5',64),4000,8589934592),('native','native-a','${nodeA}',repeat('6',64),4000,8589934592);`);
	const dup = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_candidates('native');`));
	const rowA = dup.find((c) => c.providerId === "native-a");
	assert.equal(dup.filter((c) => c.providerId === "native-a").length, 1, "one candidate row per provider per node");
	assert.equal(rowA.allocatedCpuMillis, 2000, "demand counted once despite three policy rows");
	// Node A now has 2 free slots, node B 3: node B is preferred; node A's claimant is refused.
	const dA2 = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','native-a');`));
	assert.equal(dA2.decision, "refused"); assert.equal(dA2.preferredNodeId, nodeB);
	const dB2 = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','native-b');`));
	assert.equal(dB2.decision, "placed"); assert.equal(dB2.nodeId, nodeB);
	const free = Object.fromEntries(dB2.candidates.map((c) => [c.providerId, c.freeSlots]));
	assert.equal(free["native-a"], 2); assert.equal(free["native-b"], 3); // the fixture node also carries its own native provider ("process")
	// A stale observation makes a node ineligible; the other node wins even with fewer free slots.
	sql(`update public.qorpera_runtime_node_observations set observed_at=clock_timestamp()-interval '5 minutes' where node_id='${nodeB}';`);
	const dA3 = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','native-a');`));
	assert.equal(dA3.decision, "placed"); assert.equal(dA3.nodeId, nodeA);
	// An adapter without a node row is left alone (single-node behaviour), never refused.
	const dU = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','native-unregistered');`));
	assert.equal(dU.decision, "unbound"); assert.equal(dU.reason, "PROVIDER_UNBOUND");
	// Login kind ranks only nodes with a login provider.
	const dL = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','login','login-a');`));
	assert.equal(dL.decision, "placed"); assert.equal(dL.candidates.length, 1);
	// Identity home: a native run follows the node where its member identity logged in.
	sql(`${service} ${observe(nodeA, mA)} ${observe(nodeB, mB)}`);
	const identity = sql(`select id from public.qorpera_member_compute_identities where profile_id='30000000-0000-4000-8000-000000000010' order by created_at limit 1;`);
	assert.match(identity, /^[0-9a-f-]{36}$/);
	// The fixture's native run allocation occupies this identity; release it through the official path first.
	const occupied = JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'adapter',a.provider_adapter,'instance',a.instance_sha256)),'[]') from public.qorpera_runtime_machine_allocations a join public.qorpera_runners r on r.id=a.runner_id where r.compute_identity_id='${identity}' and a.released_at is null;`));
	for (const o of occupied) sql(`${service} select public.qorpera_release_runtime_machine('${o.id}','${o.adapter}','${o.instance}');`);
	// A real login machine reservation on node A's login adapter "lxd" gives the identity its home.
	const pathClaims = read("supabase/tests/300_runtime_wake_bus.test.sql").match(/create (?:or replace )?function pg_temp\.path_claims[\s\S]*?\$\$;/)[0];
	sql(`begin; ${pathClaims}
	 reset role; select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001'); set local role authenticated;
	 select set_config('qorpera_test.placement_login',public.qorpera_begin_native_provider_login('30000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000101','38000000-0000-4000-8000-000000000102','${identity}','openai','codex-cli',repeat('8',64),900)::text,true);
	 reset role; ${service}
	 select public.qorpera_reserve_runtime_login_machine('38000000-0000-4000-8000-000000000103','lxd',repeat('7',64),(current_setting('qorpera_test.placement_login')::jsonb->>'login_id')::uuid,repeat('8',64));
	 commit;`);
	const loginReservation = sql(`select jsonb_build_object('allocs',(select count(*) from public.qorpera_runtime_machine_allocations where login_compute_identity_id='${identity}'),'requests',(select jsonb_agg(jsonb_build_object('adapter',r.provider_adapter,'refusal',r.last_refusal)) from public.qorpera_runtime_login_machine_requests r where r.compute_identity_id='${identity}'),'logins',(select jsonb_agg(jsonb_build_object('status',l.status,'identity',l.compute_identity_id)) from public.qorpera_native_provider_login_sessions l where l.profile_id='30000000-0000-4000-8000-000000000010'));`);
	assert.equal(sql(`select provider_adapter from public.qorpera_runtime_machine_allocations where login_compute_identity_id='${identity}';`), "lxd");
	// A reserved but unfinished login is not a home yet; the identity defers until its login session completes.
	sql(`${service} select public.qorpera_enroll_runtime_node_provider('${nodeA}','${mA}','native','lxd',repeat('4',64),4000,8589934592);`);
	const pendingHome = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','lxd','${identity}');`));
	assert.equal(pendingHome.reason, "NO_IDENTITY_HOME"); assert.deepEqual(pendingHome.identityHomes, []);
	sql(`update public.qorpera_native_provider_login_sessions set status='completed', completed_at=statement_timestamp() where id=(select login_session_id from public.qorpera_runtime_machine_allocations where login_compute_identity_id='${identity}');`);
	sql(`${service} select public.qorpera_enroll_runtime_node_provider('${nodeA}','${mA}','native','lxd',repeat('4',64),4000,8589934592);`);
	const home = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','lxd','${identity}');`));
	assert.equal(home.decision, "placed"); assert.equal(home.reason, "IDENTITY_HOME_LEAST_LOADED"); assert.deepEqual(home.identityHomes, ["lxd"]);
	const away = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','native-b','${identity}');`));
	assert.equal(away.decision, "refused"); assert.equal(away.reason, "NODE_IDENTITY_ELSEWHERE"); assert.equal(away.preferredNodeId, nodeA);
	const nohome = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','native-b','${randomUUID()}');`));
	assert.equal(nohome.decision, "deferred"); assert.equal(nohome.reason, "NO_IDENTITY_HOME");
	const loginStill = JSON.parse(sql(`${service} select public.qorpera_runtime_node_placement_decide('${randomUUID()}','login','login-a');`));
	assert.equal(loginStill.decision, "placed"); assert.equal(loginStill.reason, "LEAST_LOADED");
	assert(sql(`select pg_get_functiondef('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure);`).includes("p_provider_adapter,v_run.compute_identity_id)"), "run reservation passes the identity");
	// Claim time: a queued job of the homed identity is invisible to an orchestrator on another adapter and claimed by the home one.
	sql(`${service} select public.qorpera_register_runner_orchestrator('6a000000-0000-4000-8000-000000000001','home orchestrator','lxd',repeat('1',64),3600);
	 select public.qorpera_register_runner_orchestrator('6a000000-0000-4000-8000-000000000002','away orchestrator','native-b',repeat('2',64),3600);`);
	const baseRun = sql(`select id from public.qorpera_execution_runs where compute_identity_id='${identity}' order by created_at limit 1;`);
	assert(baseRun, "a fixture run of the identity exists");
	const jobId = randomUUID(), runId = randomUUID();
	sql(`insert into public.qorpera_runner_jobs(id,profile_id,environment_id,session_id,substrate_version_id,client_job_id,required_capability,job_type,payload,created_by_user_id)
	 select '${jobId}',profile_id,environment_id,session_id,substrate_version_id,'${runId}','agent_turn','agent_turn','{}',requested_by_user_id from public.qorpera_execution_runs where id='${baseRun}';
	 insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,required_capability,job_type,payload_sha256,compute_identity_id,compute_recovery_epoch,logical_computer_id,transcript_start_sequence,created_by_user_id,deadline_at)
	 select '${runId}',profile_id,environment_id,'session_turn','${runId}',session_id,'${jobId}',substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,'agent_turn','agent_turn',repeat('e',64),compute_identity_id,compute_recovery_epoch,logical_computer_id,0,requested_by_user_id,statement_timestamp()+interval '10 minutes' from public.qorpera_execution_runs where id='${baseRun}';
	 update public.qorpera_runner_jobs set run_id='${runId}' where id='${jobId}';
	 select public.qorpera_reserve_execution_sponsor_authority('${runId}');`);
	if (sql(`select count(*) from public.qorpera_runner_model_policies where job_id='${jobId}';`) === "0") sql(`insert into public.qorpera_runner_model_policies select * from jsonb_populate_record(null::public.qorpera_runner_model_policies,(select to_jsonb(p)||jsonb_build_object('job_id','${jobId}') from public.qorpera_runner_model_policies p join public.qorpera_execution_runs r on r.job_id=p.job_id where r.id='${baseRun}' limit 1));`);
	const claimable = JSON.parse(sql(`select jsonb_build_object('queued',job.status='queued','deadline',run.deadline_at>statement_timestamp(),'sponsor',public.qorpera_execution_sponsor_available(run),'compute',public.qorpera_execution_compute_available(run)) from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.id=job.run_id where job.id='${jobId}';`));
	assert(claimable.queued && claimable.deadline && claimable.sponsor && claimable.compute, `the test job is claimable on its own terms: ${JSON.stringify(claimable)}`);
	const awayClaim = sql(`${service} select public.qorpera_claim_runner_job_for_orchestrator('6a000000-0000-4000-8000-000000000002','${randomUUID()}',60);`);
	assert.equal(awayClaim, "null", "non-home orchestrator sees no work");
	assert.equal(sql(`select status from public.qorpera_runner_jobs where id='${jobId}';`), "queued");
	const homeClaim = sql(`${service} select public.qorpera_claim_runner_job_for_orchestrator('6a000000-0000-4000-8000-000000000001','${randomUUID()}',60);`);
	assert(homeClaim !== "null" && homeClaim.includes(jobId), "home orchestrator claims the job");
	// Placement deferral: a typed admission refusal keeps the job queued and uncounted; the refusing
	// orchestrator waits for a node-preference refusal, everyone waits for a capacity refusal.
	const homeOrchestrator = "6a000000-0000-4000-8000-000000000001";
	const homeClaimId = JSON.parse(homeClaim).claim_id;
	const deferred = JSON.parse(sql(`${service} select public.qorpera_release_runner_job_claim('${homeOrchestrator}','${homeClaimId}','${randomUUID()}','ADMISSION_REFUSED:NODE_NOT_PREFERRED');`));
	assert.equal(deferred.deferred, true); assert.equal(deferred.dispatch_failure_count, 0);
	assert.equal(sql(`select status||' '||dispatch_failure_count||' '||coalesce(dispatch_refused_by::text,'-') from public.qorpera_runner_jobs where id='${jobId}';`), `queued 0 ${homeOrchestrator}`);
	assert.equal(sql(`select count(*) from public.qorpera_execution_run_events where run_id='${runId}' and event_type='placement_deferred';`), "1");
	assert.equal(sql(`${service} select public.qorpera_claim_runner_job_for_orchestrator('${homeOrchestrator}','${randomUUID()}',60);`), "null", "refusing orchestrator is deferred");
	sql(`update public.qorpera_runner_jobs set dispatch_deferred_until=statement_timestamp()-interval '1 second' where id='${jobId}';`);
	const again = sql(`${service} select public.qorpera_claim_runner_job_for_orchestrator('${homeOrchestrator}','${randomUUID()}',60);`);
	assert(again.includes(jobId), "deferral passed: the home orchestrator claims again");
	const capacity = JSON.parse(sql(`${service} select public.qorpera_release_runner_job_claim('${homeOrchestrator}','${JSON.parse(again).claim_id}','${randomUUID()}','ADMISSION_REFUSED:MACHINE_CAPACITY_EXHAUSTED');`));
	assert.equal(capacity.deferred, true);
	assert.equal(sql(`select coalesce(dispatch_refused_by::text,'-')||' '||dispatch_failure_count from public.qorpera_runner_jobs where id='${jobId}';`), "- 0");
	assert.equal(sql(`${service} select public.qorpera_claim_runner_job_for_orchestrator('${homeOrchestrator}','${randomUUID()}',60);`), "null", "capacity deferral holds every orchestrator");
	sql(`update public.qorpera_runner_jobs set dispatch_deferred_until=statement_timestamp()-interval '1 second' where id='${jobId}';`);
	const third = sql(`${service} select public.qorpera_claim_runner_job_for_orchestrator('${homeOrchestrator}','${randomUUID()}',60);`);
	const plain = JSON.parse(sql(`${service} select public.qorpera_release_runner_job_claim('${homeOrchestrator}','${JSON.parse(third).claim_id}','${randomUUID()}','guest agent probe failed');`));
	assert.equal(plain.dispatch_failure_count, 1, "an ordinary failure still counts");
	// Login gateways: the edge function's choice follows the login candidates and falls back to any registered gateway.
	assert.equal(JSON.parse(sql(`${service} select public.qorpera_runtime_login_gateway_choose();`)).reason, "NO_GATEWAY");
	if (sql(`select count(*) from public.qorpera_runtime_node_providers where provider_kind='login' and node_id='${nodeB}';`) === "0") sql(`${service} select public.qorpera_enroll_runtime_node_provider('${nodeB}','${mB}','login','login-b',repeat('9',64),4000,8589934592);`);
	sql(`${service} ${observe(nodeA, mA)} ${observe(nodeB, mB)}`);
	sql(`${service} select public.qorpera_register_runtime_login_gateway('login-a','${nodeA}','https://node-a.example:10000/'); select public.qorpera_register_runtime_login_gateway('login-b','${nodeB}','https://node-b.example:10000/');`);
	const chosen = JSON.parse(sql(`${service} select public.qorpera_runtime_login_gateway_choose();`));
	assert.equal(chosen.reason, "LEAST_LOADED"); assert.equal(chosen.nodeId, nodeB); assert.equal(chosen.url, "https://node-b.example:10000/");
	const deniedGateway = spawnSync("docker", psql, { input: `set request.jwt.claims='{"role":"authenticated"}'; set role authenticated; select public.qorpera_runtime_login_gateway_choose();`, encoding: "utf8", timeout: 60_000 });
	assert.notEqual(deniedGateway.status, 0);
	// Records: one row per allocation, attempts counted, decisions overwritten by the latest.
	assert.equal(sql(`select attempts||' '||decision from public.qorpera_runtime_node_placements where allocation_id='${alloc1}';`), "2 placed");
	// The patched reservations carry the chooser call.
	for (const [fn, call] of [["public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)", "qorpera_runtime_node_placement_decide(p_allocation_id,'native',p_provider_adapter,v_run.compute_identity_id)"], ["public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)", "qorpera_runtime_node_placement_decide(p_allocation_id,'login',p_provider_adapter)"]]) {
		const def = sql(`select pg_get_functiondef('${fn}'::regprocedure);`);
		assert(def.includes(call), `${fn} not patched`);
		assert(def.includes("v_placement jsonb"), `${fn} declare not patched`);
	}
	// Non-service callers are refused.
	const denied = spawnSync("docker", psql, { input: `set request.jwt.claims='{"role":"authenticated"}'; set role authenticated; select public.qorpera_runtime_node_placement_decide('${randomUUID()}','native','native-a');`, encoding: "utf8" });
	assert.notEqual(denied.status, 0); assert.match(denied.stderr, /authority required|permission denied/);
	console.log(JSON.stringify({ schema: "qorpera.runtime-node-placement-sql-proof/v1", migrations: migrations.length, twoNodePreference: true, identityHome: true, claimTimeHome: true, loginGateways: true, completedLoginsOnly: true, placementDeferral: true, refusalRecorded: true, staleObservationExcluded: true, unboundAdapterUntouched: true, reservationsPatched: true, passed: true }));
} finally {
	if (started) spawnSync("docker", ["rm", "-f", container], { timeout: 30_000 });
}
