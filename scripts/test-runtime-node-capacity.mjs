// Local PostgreSQL only. Real admission functions, fixture hardware observations
// and company objects; no physical provider, hosted database or cloud calls.
// On 924's folder-v2 runtime base (ported from snapshot-v1 in the legacy sweep): its company's computer and Alice's
// leased run, and a second folder-v2 company made as 724 makes one.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostedDatabase, migrationNames } from "./test-hosted-db-cluster.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// The proof restarts the server, so this script has a container of its own with its data on disk.
const database = await hostedDatabase("capacity", { restartable: true });
const container = database.container;
const psql = database.cluster.psqlArgs("capacity", ["-qAt"]);
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout?.slice(-4000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = text => docker(psql, text);
const literal = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
const node = "36000000-0000-4000-8000-000000000010";
const read = path => readFileSync(join(root, path), "utf8");
const sessions = new Set();
function session() {
	const child = spawn("docker", psql);
	sessions.add(child);
	let output = "", error = "";
	child.stdout.on("data", chunk => { output += chunk; });
	child.stderr.on("data", chunk => { error += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const done = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", code => { clearTimeout(timer); sessions.delete(child); resolve({ code, output: output.trim(), error }); });
	});
	return { child, done, output: () => output };
}
async function until(check) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		assert(Date.now() < deadline, "Node capacity SQL barrier timed out");
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}
function observe() {
	return `select public.qorpera_test_observe_runtime_node(${literal({schema:"qorpera.runtime-node-observation/v1",nodeId:node,
		machineIdSha256:"c".repeat(64),observationId:randomUUID(),observedAt:new Date().toISOString(),cpuMillis:6000,memoryBytes:8589934592,state:"ready"})});`;
}
const reserve = allocation => `select public.qorpera_reserve_runtime_node_machine('${allocation.id}','${allocation.kind}',
	'${allocation.provider}','${allocation.policy}','${allocation.instance}','${"c".repeat(64)}',${allocation.kind==="native"?3000:2000},2147483648);`;
try {
	const migrations = migrationNames();
	sql(read("supabase/tests/fixtures/runtime-node-inventory-observer.sql"));
	const base = read("supabase/tests/924_folder_runtime_base.test.sql").split("-- The checks start here");
	assert.equal(base.length, 2);
	const office = read("supabase/tests/fixtures/runtime-office-registry-cases.sql").split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");
	assert.equal(office.length, 2);
	const setup = `${base[0]}\n${office[0]}\n${read("supabase/tests/fixtures/runtime-node-capacity-setup.sql")}`;
	sql(`${setup}\n${read("supabase/tests/fixtures/runtime-login-machine-capacity-cases.sql")}\nrollback;`);
	console.log("PASS: real login allocation, shared node budget, native/login identity exclusion, revocation/expiry cleanup and exact release");
	sql(`${setup}\n${read("supabase/tests/fixtures/runtime-node-capacity-cases.sql")}\nrollback;`);
	console.log("PASS: private node enrollment, immutable host/provider/cost, CPU/RAM headroom, stale health, exact replay, retained demand and deletion-based release");
	sql(`${setup}\n${read("supabase/tests/fixtures/runtime-node-demand-suspension-cases.sql")}\nrollback;`);
	console.log("PASS: a confirmed power-off suspends the company computer's slot, resume re-admits it only when it fits, a requested resume keeps it");
	sql(`${setup}\ncommit;`);
	// A second folder-v2 company (as 724 makes one: owner and contributor added directly, then folder_enable). The
	// office fixture's registration checks run on it with its ids, up to the agent grant (it hires no agents); 924's
	// claim, assert and error helpers come along.
	const second = "92410000-0000-4000-8000-0000000000";
	const helpers = base[0].match(/create function pg_temp\.base_claims[\s\S]*?\$\$;\n/)[0]
		+ base[0].split("-- BEGIN BASE HELPERS")[1].split("create function pg_temp.base_owner")[0];
	const secondOffice = office[0].split("-- Every active agent already holds the default grant");
	assert.equal(secondOffice.length, 2);
	sql(`begin;
	 insert into auth.users(id,email) values('${second}01','second-owner@example.test'),('${second}02','second-member@example.test');
	 insert into public.qorpera_profiles(id,name,created_by_user_id) values('${second}10','Second company','${second}01');
	 insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
	 values('${second}10','${second}01','second-owner@example.test','Owner','owner'),
	  ('${second}10','${second}02','second-member@example.test','Member','contributor');
	 insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
	 values('${second}20','${second}10','Environment',1,'${second}01');
	 ${helpers}
	 select pg_temp.base_claims('service_role');
	 select public.qorpera_folder_enable('${second}20');
	 ${secondOffice[0].replaceAll("92400000-0000-4000-8000-", "92410000-0000-4000-8000-").replaceAll("34000000", "34100000")}
	 reset role;
	 ${service}
	 select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
	 '36000000-0000-4000-8000-000000000001',repeat('e',64),0,true);
	 select public.qorpera_enroll_runtime_node_provider('${node}',repeat('c',64),'office','36000000-0000-4000-8000-000000000001',repeat('e',64),2000,2147483648);
	 select public.qorpera_reserve_runtime_machine('34100000-0000-4000-8000-000000000088','lxd',repeat('d',64),null,null,
	 (current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,1); commit;`);
	const allocations = JSON.parse(sql(`select jsonb_agg(jsonb_build_object('id',a.id,'kind',case when a.runner_id is null then 'office' else 'native' end,
	 'provider',case when a.runner_id is null then p.provider_id::text else a.provider_adapter end,
	 'policy',coalesce(p.policy_sha256,repeat('f',64)),'instance',a.instance_sha256,'company',a.profile_id))
	 from public.qorpera_runtime_machine_allocations a left join public.qorpera_runtime_office_providers p on p.office_id=a.office_id and p.computer_generation=a.computer_generation;`));
	const native = allocations.find(a => a.kind === "native");
	const offices = allocations.filter(a => a.kind === "office");
	assert.equal(offices.length, 2); assert.notEqual(offices[0].company,offices[1].company);
	assert.equal(offices[0].provider,offices[1].provider); assert.notEqual(offices[0].policy,offices[1].policy);
	sql(`${service} ${observe()}`);
	// One native reservation occupies three of four allocatable cores. Two
	// different companies wait on the same node row, not one company fence.
	assert.equal(JSON.parse(sql(`${service} ${reserve(native)}`)).state,"reserved");
	const blocker = session();
	blocker.child.stdin.write(`begin; select id from public.qorpera_runtime_nodes where id='${node}' for update; select 'NODE_LOCKED';\n`);
	await until(() => blocker.output().includes("NODE_LOCKED"));
	const requests = offices.map((allocation,index) => {
		const request = session(); request.child.stdin.end(`${service} set application_name='node-capacity-race-${index}'; ${reserve(allocation)}`); return request;
	});
	await until(() => sql("select count(*) from pg_stat_activity where application_name like 'node-capacity-race-%' and wait_event_type='Lock';") === "2");
	blocker.child.stdin.end("commit;\n");
	assert.equal((await blocker.done).code,0);
	for (const request of requests) {
		const result = await request.done; assert.equal(result.code,0,result.error);
		assert.equal(JSON.parse(result.output).reason,"NODE_CAPACITY_EXHAUSTED");
	}
	assert.equal(sql("select count(*) from public.qorpera_runtime_node_demands where reserved_at is null;"),"2");
	// Exact confirmed cleanup admits both offices, while a replay/lost response
	// can neither allocate twice nor resurrect the retired native computer.
	sql(`${service} select public.qorpera_release_runtime_machine('${native.id}','${native.provider}','${native.instance}');`);
	const policy = JSON.parse(sql(`select policy from public.qorpera_runtime_node_policies where node_id='${node}' and version=1;`));
	sql(`${service} select public.qorpera_configure_runtime_node(${literal({...policy,cpuMillis:4000})},1);`);
	assert.equal(JSON.parse(sql(`${service} ${reserve(offices[0])}`)).reason,"NODE_OBSERVATION_UNAVAILABLE","policy change invalidates old inventory");
	sql(`${service} ${observe()}`);
	const admitted = await Promise.all(offices.map(async allocation => {
		const request = session(); request.child.stdin.end(`${service} ${reserve(allocation)}`);
		const result = await request.done; assert.equal(result.code,0,result.error); return JSON.parse(result.output);
	}));
	assert.equal(admitted.filter(result=>result.state === "reserved").length,1,"one remaining slot cannot be allocated twice");
	assert.equal(admitted.filter(result=>result.reason === "NODE_CAPACITY_EXHAUSTED").length,1);
	// Explicit operator expansion, retaining the losing request and its original
	// placement. No implicit overflow or reassignment can explain the second VM.
	sql(`${service} select public.qorpera_configure_runtime_node(${literal(policy)},2);`);
	sql(`${service} ${observe()}`);
	for(const allocation of offices) assert.equal(JSON.parse(sql(`${service} ${reserve(allocation)}`)).state,"reserved");
	const expiry = session();
	expiry.child.stdin.write(`begin; select id from public.qorpera_runtime_nodes where id='${node}' for update; select 'EXPIRY_LOCKED';\n`);
	await until(()=>expiry.output().includes("EXPIRY_LOCKED"));
	const afterWait=session();
	afterWait.child.stdin.end(`${service} set application_name='node-expiry-race'; ${reserve(offices[0])}`);
	await until(()=>sql("select count(*) from pg_stat_activity where application_name='node-expiry-race' and wait_event_type='Lock';")==="1");
	expiry.child.stdin.end(`update public.qorpera_runtime_node_observations set observed_at=clock_timestamp()-interval '61 seconds' where node_id='${node}'; commit;\n`);
	assert.equal((await expiry.done).code,0);
	const stale=await afterWait.done; assert.equal(stale.code,0,stale.error);
	assert.equal(JSON.parse(stale.output).reason,"NODE_OBSERVATION_UNAVAILABLE","waiting requests cannot use pre-lock freshness");
	sql(`${service} ${observe()}`);
	const before = sql("select jsonb_agg(to_jsonb(d) order by allocation_id) from public.qorpera_runtime_node_demands d;");
	docker(["restart", container]);
	for (let attempt=0; attempt<60; attempt++) {
		const result=spawnSync("docker",["exec",container,"pg_isready","-U","postgres","-d","capacity"],{timeout:2000});
		if(result.status===0) break;
		assert(attempt<59,"Database restart timed out"); await new Promise(resolve=>setTimeout(resolve,250));
	}
	assert.equal(sql("select jsonb_agg(to_jsonb(d) order by allocation_id) from public.qorpera_runtime_node_demands d;"),before);
	sql(`${service} ${observe()}`);
	for(const allocation of offices) assert.equal(JSON.parse(sql(`${service} ${reserve(allocation)}`)).state,"reserved");
	const capacity = JSON.parse(sql(`${service} select public.qorpera_runtime_node_capacity('${node}');`));
	assert.equal(capacity.allocatedComputers,2); assert.equal(capacity.allocatedCompanies,2); assert.equal(capacity.admissibleSlots,0);
	const profile="92400000-0000-4000-8000-000000000010";
	const identity=sql(`select compute_identity_id from public.qorpera_runners where client_runner_id='${native.id}';`);
	// A new sign-in replaces the same member's unfinished one (2026-09-17 login supersede amendment), so two pending
	// logins for one identity now exist only when two authorizing members sign a company-owned identity in. The
	// identity race uses exactly that (924's owner and admin); the third login stays the owner's own member identity.
	const loginOwner='92400000-0000-4000-8000-000000000001',loginAdmin='92400000-0000-4000-8000-000000000004',companyIdentity=randomUUID();
	sql(`insert into public.qorpera_member_compute_identities(id,profile_id,ownership_kind,client_identity_id,display_name)
	 values('${companyIdentity}','${profile}','company','${companyIdentity}','Login race fixture');`);
	// Login reserve and release take the company's row lock first (inside qorpera_lock_profile_gc_fence); the barriers
	// below hold that same row, so each contender waits on a real SQL lock.
	const companyLock=`select 1 from public.qorpera_profiles where id='${profile}' for update;`;
	const newLogin=(member=loginOwner,computeIdentity=identity)=>JSON.parse(sql(`set request.jwt.claims='{"role":"authenticated","sub":"${member}"}'; set role authenticated;
	 select public.qorpera_begin_native_provider_login('${profile}','${randomUUID()}','${randomUUID()}','${computeIdentity}','openai','codex-cli',repeat('8',64),900);`)).login_id;
	const supersededLogin=newLogin(loginOwner,companyIdentity);
	const logins=[newLogin(loginOwner,companyIdentity),newLogin(loginAdmin,companyIdentity),newLogin()].map((loginId,index)=>({loginId,allocationId:randomUUID(),instance:String(index+1).repeat(64)}));
	assert.equal(sql(`select status from public.qorpera_native_provider_login_sessions where id='${supersededLogin}';`),'cancelled','a newer sign-in supersedes the same member\'s earlier pending one');
	assert.equal(sql(`select count(*) from public.qorpera_native_provider_login_sessions where id in ('${logins[0].loginId}','${logins[1].loginId}') and status='pending';`),'2','another member\'s pending sign-in is not superseded');
	const loginReserve=entry=>`select public.qorpera_reserve_runtime_login_machine('${entry.allocationId}','lxd','${entry.instance}','${entry.loginId}',repeat('8',64));`;
	const loginRelease=entry=>`select public.qorpera_release_runtime_login_machine('${entry.allocationId}','lxd','${entry.instance}','${entry.loginId}');`;
	const identityBarrier=session();
	identityBarrier.child.stdin.write(`begin; ${companyLock} select 'LOGIN_IDENTITY_LOCKED';\n`);
	await until(()=>identityBarrier.output().includes('LOGIN_IDENTITY_LOCKED'));
	const loginRaces=logins.slice(0,2).map((entry,index)=>{
	 const contender=session();contender.child.stdin.end(`${service} set application_name='login-capacity-race-${index}'; ${loginReserve(entry)}`);return contender;
	});
	await until(()=>sql("select count(*) from pg_stat_activity where application_name like 'login-capacity-race-%' and wait_event_type='Lock';")==='2');
	identityBarrier.child.stdin.end('commit;\n');assert.equal((await identityBarrier.done).code,0);
	const loginResults=[];for(const contender of loginRaces){const result=await contender.done;assert.equal(result.code,0,result.error);loginResults.push(JSON.parse(result.output));}
	assert.equal(loginResults.filter(result=>result.state==='reserved').length,1);
	assert.equal(loginResults.filter(result=>result.reason==='COMPUTE_IDENTITY_OCCUPIED').length,1);
	const winner=logins[loginResults.findIndex(result=>result.state==='reserved')],loser=logins[loginResults.findIndex(result=>result.state!=='reserved')];
	sql(`${service} select public.qorpera_enroll_runtime_node_provider('${node}',repeat('c',64),'login','lxd',repeat('9',64),1000,1073741824); ${observe()}`);
	const loginNode=JSON.parse(sql(`${service} select public.qorpera_reserve_runtime_node_machine('${winner.allocationId}','login','lxd',repeat('9',64),'${winner.instance}',repeat('c',64),1000,1073741824);`));
	assert.equal(loginNode.reason,'NODE_CAPACITY_EXHAUSTED');
	assert.equal(JSON.parse(sql(`${service} select public.qorpera_runtime_node_capacity('${node}');`)).pendingRequests,1);
	sql(`${service} ${loginRelease(winner)}`);
	assert.equal(JSON.parse(sql(`${service} select public.qorpera_runtime_node_capacity('${node}');`)).pendingRequests,0,'closed unstarted login is not a waiting node request');
	assert.equal(JSON.parse(sql(`${service} ${loginReserve(loser)}`)).state,'reserved');sql(`${service} ${loginRelease(loser)}`);
	// Force release to own the login row before a delayed first reservation.
	// Both wait on real SQL locks, not sleeps or guessed transport ordering.
	const closeBarrier=session();closeBarrier.child.stdin.write(`begin; ${companyLock} select 'LOGIN_CLOSURE_LOCKED';\n`);
	await until(()=>closeBarrier.output().includes('LOGIN_CLOSURE_LOCKED'));
	const closing=session();closing.child.stdin.end(`${service} set application_name='login-close-first'; ${loginRelease(logins[2])}`);
	await until(()=>sql("select count(*) from pg_stat_activity where application_name='login-close-first' and wait_event_type='Lock';")==='1');
	const delayed=session();delayed.child.stdin.end(`${service} set application_name='login-reserve-late'; ${loginReserve(logins[2])}`);
	await until(()=>sql("select count(*) from pg_stat_activity where application_name='login-reserve-late' and wait_event_type='Lock';")==='1');
	closeBarrier.child.stdin.end('commit;\n');assert.equal((await closeBarrier.done).code,0);
	const closed=await closing.done;assert.equal(closed.code,0,closed.error);assert.equal(JSON.parse(closed.output).state,'released');
	const late=await delayed.done;assert.notEqual(late.code,0);assert.match(late.error,/cannot be rebound/);
	assert.equal(sql(`select count(*) from public.qorpera_runtime_machine_allocations where id='${logins[2].allocationId}';`),'0');
	const loginHistory=sql('select jsonb_agg(to_jsonb(r) order by allocation_id) from public.qorpera_runtime_login_machine_requests r;');
	docker(['restart',container]);
	for(let attempt=0;attempt<60;attempt++){
	 const status=spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','capacity'],{timeout:2000});
	 if(status.status===0)break;assert(attempt<59,'Login closure restart timed out');await new Promise(resolve=>setTimeout(resolve,250));
	}
	assert.equal(sql('select jsonb_agg(to_jsonb(r) order by allocation_id) from public.qorpera_runtime_login_machine_requests r;'),loginHistory);
	console.log(JSON.stringify({schema:'qorpera.runtime-login-capacity-sql-proof/v1',migrations:migrations.length,identityRaceSingleWinner:true,
		sharedNodeBudget:true,closedPendingDemandRemoved:true,delayedFirstReservationFenced:true,closureHistorySurvivesRestart:true,physicalDeletion:'provider acknowledgement fixture'}));
	console.log(JSON.stringify({schema:"qorpera.runtime-node-capacity-sql-proof/v1",migrations:migrations.length,actualSql:true,
		crossCompanyConcurrency:true,oneProviderMultipleOfficePolicies:true,lastSlotSingleWinner:true,freshnessAfterLockWait:true,hostCpuMillis:6000,headroomCpuMillis:2000,allocatedCpuMillis:capacity.allocatedCpuMillis,
		allocatedComputers:2,allocatedCompanies:2,restartRetained:true,exactRetry:true,physicalDeletion:"provider acknowledgement fixture",
		hardwareObservations:"fixture",physicalProviderEnforced:false,hosted:false}));
} finally {
	for(const child of sessions) child.kill("SIGKILL");
	database.close();
}
