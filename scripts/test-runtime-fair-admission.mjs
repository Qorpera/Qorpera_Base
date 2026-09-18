// Disposable PostgreSQL regressions for bounded queue rotation and contention.
// No external database URL, credentials or provider process is accepted.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { hash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert(
	args.length === 0 || (args.length === 2 && args[0] === "--report"),
	"Usage: node scripts/test-runtime-fair-admission.mjs [--report PATH]",
);
const container = `qorpera-fair-admission-${process.pid}-${randomBytes(4).toString("hex")}`;
const volume = `${container}-data`;
const report = {
	schema: "qorpera.fair-admission-regressions/v1",
	startedAt: new Date().toISOString(),
	network: "none",
	providerInvoked: false,
	deployedAcceptance: false,
	driverSha256: hash("sha256", readFileSync(fileURLToPath(import.meta.url))),
	migrations: [],
	concurrency: [],
	passed: false,
};
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "review"];
const sessions = new Set();
function docker(argumentsValue, input) {
	const result = spawnSync("docker", argumentsValue, {
		input,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || result.stdout);
	return result.stdout.trim();
}
const sql = (query) => docker(psql, "set statement_timeout='20s';\n" + query);
function session() {
	const child = spawn("docker", psql);
	sessions.add(child);
	let output = "",
		error = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		error += chunk;
	});
	const done = new Promise((resolveDone, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			sessions.delete(child);
			resolveDone({ code, output: output.trim(), error });
		});
	});
	return { child, done, output: () => output, error: () => error };
}
async function until(predicate, description) {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}
async function begin(query) {
	const current = session();
	current.child.stdin.write(`begin;\n${query}\nselect 'REVIEW_READY';\n`);
	await until(
		() => current.output().includes("REVIEW_READY") || current.child.exitCode !== null,
		"transaction barrier",
	);
	assert(current.output().includes("REVIEW_READY"), current.error());
	return current;
}
async function commit(current) {
	current.child.stdin.end("commit;\n");
	const result = await current.done;
	assert.equal(result.code, 0, result.error);
	return result;
}
let started = false,
	volumeCreated = false;
try {
	docker(["volume", "create", volume]);
	volumeCreated = true;
	docker([
		"run",
		"--detach",
		"--name",
		container,
		"--network",
		"none",
		"--env",
		"POSTGRES_PASSWORD=review-disposable-only",
		"--env",
		"POSTGRES_DB=review",
		"--mount",
		`type=volume,source=${volume},target=/var/lib/postgresql/data`,
		POSTGRES_IMAGE,
	]);
	started = true;
	await until(
		() =>
			spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "review"], {
				stdio: "ignore",
			}).status === 0,
		"PostgreSQL startup",
	);
	sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const deferredMigrations=[];
	for (const file of sortMigrationNames(readdirSync(join(root, "supabase/migrations")))) {
		if(file >= "20260907000860") {deferredMigrations.push(file);continue;}
		const bytes = readFileSync(join(root, "supabase/migrations", file));
		sql(bytes);
		report.migrations.push({ file, sha256: hash("sha256", bytes) });
	}

 const component = readFileSync(join(root, 'supabase/tests/335_runtime_session_queue_isolation.test.sql'), 'utf8');
 report.componentSha256 = hash('sha256', component);
 const fixture = component.split('-- END QUEUE FIXTURE')[0];
 const helpers = [...fixture.matchAll(/^create function pg_temp[\s\S]+?\$\$;/gm)].map(match=>match[0]).join('\n');
 const setup = JSON.parse(sql(fixture + `
create temporary table fair_reviews(company jsonb, proposal uuid, blocked boolean);
do $$ declare i integer; company jsonb; begin
 for i in 400..432 loop
  company:=pg_temp.queue_company(i);
  insert into fair_reviews values(company,pg_temp.queue_review(company),i<432);
 end loop;
end $$;
create temporary table fair_work(lane text, blocked jsonb, healthy jsonb);
do $$ declare lane text; a jsonb; b jsonb; work jsonb; healthy jsonb; i integer; n integer:=350;
begin
 foreach lane in array array['ordinary','sponsored','wake'] loop
  a:=pg_temp.queue_company(n); b:=pg_temp.queue_company(n+1); n:=n+2;
  work:=pg_temp.queue_recovery_work(a,lane);
  for i in 2..32 loop perform pg_temp.queue_more_work(work,lane); end loop;
  healthy:=pg_temp.queue_recovery_work(b,lane);
  insert into fair_work values(lane,work,healthy);
 end loop;
end $$;
select jsonb_build_object('lanes',(select jsonb_agg(to_jsonb(w)) from fair_work w),
 'reviews',(select jsonb_agg(to_jsonb(r)) from fair_reviews r)); commit;`).split('\n').at(-1));
 const quote = value => "'"+String(value).replaceAll("'","''")+"'";
 const literal = value => quote(JSON.stringify(value))+'::jsonb';
 const tables = ['qorpera_session_execution_bindings','qorpera_session_turn_requests','qorpera_wake_occurrences','qorpera_company_proposal_review_assignments'];
 const rows = () => JSON.parse(sql(`select jsonb_build_object(${tables.map(t=>`${quote(t)},(select jsonb_agg(to_jsonb(t)-'admission_scan_at' order by to_jsonb(t)::text) from public.${t} t)`).join(',')});`));
 const catalogQuery = "select jsonb_agg(jsonb_build_object('name',p.proname,'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'qorpera_%';";
 const beforeRows = rows(), beforeFunctions = JSON.parse(sql(catalogQuery));
 for(const file of deferredMigrations) {
  const bytes=readFileSync(join(root,'supabase/migrations',file)); sql(bytes);
  report.migrations.push({file,sha256:hash('sha256',bytes)});
 }
 assert.deepEqual(rows(),beforeRows,'migration changed existing work');
 const afterFunctions = JSON.parse(sql(catalogQuery));
 assert.deepEqual(afterFunctions.map(({definition,...rest})=>rest),beforeFunctions.map(({definition,...rest})=>rest));
 report.changedFunctions = afterFunctions.filter((item,i)=>item.definition!==beforeFunctions[i].definition).map(item=>item.name);
 assert.deepEqual([...report.changedFunctions].sort(),[
  'qorpera_drain_company_file_wakes','qorpera_guard_wake_identity','qorpera_materialize_company_proposal_review_runs',
  'qorpera_materialize_session_execution_runs','qorpera_materialize_session_turn_requests','qorpera_materialize_wake_execution_runs'].sort());
 const passed=name=>{report.concurrency.push(name); console.log('PASS '+name);};
 const check=query=>assert.equal(sql(query),'t',query);
 const service=`set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
 passed('upgrade_preserves_existing_work_and_all_function_owners_acls_signatures');
 for(const table of tables) for(const role of ['anon','authenticated']) {
  check(`select not has_column_privilege('${role}','public.${table}','admission_scan_at','UPDATE');`);
 }
 passed('scan_positions_are_not_writable_by_public_api_roles');
 const blockedProfiles=[...setup.lanes.map(l=>l.blocked.profile),...setup.reviews.filter(r=>r.blocked).map(r=>r.company.profile)];
 const profiles=blockedProfiles.map(quote).join(',');
 for(const table of tables) sql(`update public.${table} set admission_scan_at=statement_timestamp()-interval '1 hour' where profile_id in(${profiles});`);
 const locks=await begin(`select id from public.qorpera_profiles where id in(${profiles}) for update;`);
 const materializers=['qorpera_materialize_session_execution_runs','qorpera_materialize_session_turn_requests','qorpera_materialize_wake_execution_runs','qorpera_materialize_company_proposal_review_runs'];
 for(let i=0;i<materializers.length;i++) {
  const table=tables[i];
  // Two independent transactions: the first defers 32 locked entries, the
  // second must reach the healthy entry that follows them.
  sql(service+`select public.${materializers[i]}(32);`);
  sql(service+`select public.${materializers[i]}(32);`);
  if(i<3) {
   const {blocked,healthy}=setup.lanes[i];
   check(`select count(*)=1 from public.qorpera_execution_runs where profile_id='${healthy.profile}';`);
   check(`select count(*)=0 from public.qorpera_execution_runs where profile_id='${blocked.profile}';`);
  } else {
   const healthy=setup.reviews.find(r=>!r.blocked);
   check(`select status='running' and run_id is not null from public.qorpera_company_proposal_review_assignments where proposal_id='${healthy.proposal}';`);
   check(`select count(*)=32 and bool_and(status='queued' and run_id is null) from public.qorpera_company_proposal_review_assignments where profile_id in(${profiles});`);
  }
  passed(materializers[i]+'_rotates_32_contended_entries_across_transactions');
 }
 await commit(locks);
 // A transaction rollback also rolls back scan rotation; retry can safely
 // rescan without losing durable work or reserving a duplicate run.
 const recovery=JSON.parse(sql('begin;'+helpers+'\nselect pg_temp.queue_begin_recovery('+literal(setup.lanes[0].blocked)+');commit;').split('\n').at(-1));
 const beforeScan=sql(`select jsonb_agg(to_jsonb(b) order by session_id) from public.qorpera_session_execution_bindings b;`);
 sql('begin;'+service+'select public.qorpera_materialize_session_execution_runs(1);rollback;');
 assert.equal(sql(`select jsonb_agg(to_jsonb(b) order by session_id) from public.qorpera_session_execution_bindings b;`),beforeScan);
 passed('rollback_restores_scan_position_and_does_not_consume_recovering_work');
 sql('begin;'+helpers+'\nselect pg_temp.queue_finish_recovery('+literal(setup.lanes[0].blocked)+','+literal(recovery)+');commit;');
 // File listener rotation uses the same company lock, but its processed head
 // must remain atomic with event claims when a scan is deferred.
 const listenerSetup=JSON.parse(sql('begin;'+helpers+`
create temporary table fair_listeners(company jsonb,blocked boolean);
do $$ declare company jsonb; n integer; i integer; resource public.qorpera_company_path_resources%rowtype;
begin
 for n in 440..441 loop
  company:=pg_temp.queue_company(n);
  update public.qorpera_company_files set path_gateway_version=1,path_index_snapshot_id=head_snapshot_id where profile_id=(company->>'profile')::uuid;
  insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,policy,created_by_user_id)
   values(pg_temp.queue_id(n,20),'','subtree','company_shared','normal',(company->>'owner')::uuid) returning * into resource;
  perform pg_temp.queue_auth((company->>'owner')::uuid);
  set local role authenticated;
  perform public.qorpera_grant_company_path(resource.id,resource.version,'staff_agent',(company->>'staff')::uuid,array['read']);
  for i in 1..case when n=440 then 32 else 1 end loop
   perform public.qorpera_upsert_cloud_routine(pg_temp.queue_id(n,20),extensions.gen_random_uuid(),extensions.gen_random_uuid(),
    (company->>'staff')::uuid,'Fair listener','Observe file changes.',
    '[{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","replyPolicy":"silent","timeZone":"UTC"}]',
    'low',(company->>'sponsor')::uuid,1,null,'agent_turn','agent_turn',true,'automatic',null,'{}');
  end loop;
  reset role;
  insert into fair_listeners values(company,n=440);
 end loop;
end $$;
select jsonb_agg(to_jsonb(t)) from fair_listeners t;commit;`).split('\n').at(-1));
 const blockedListener=listenerSetup.find(l=>l.blocked).company;
 const healthyListener=listenerSetup.find(l=>!l.blocked).company;
 sql(`update public.qorpera_company_file_wake_cursors set last_scanned_at=statement_timestamp()-interval '1 hour' where environment_id='44000000-0000-4000-8000-000000000020';`);
 const cursorPins=sql("select jsonb_agg(to_jsonb(c)-'last_scanned_at' order by routine_id) from public.qorpera_company_file_wake_cursors c;");
 const scanBefore=sql(`select c.last_scanned_at::text from public.qorpera_company_file_wake_cursors c join public.qorpera_company_environments e on e.id=c.environment_id where e.profile_id='${healthyListener.profile}';`);
 const listenerLocks=await begin(`select id from public.qorpera_profiles where id='${blockedListener.profile}' for update;`);
 for(let i=0;i<2;i++) {
  const drain=JSON.parse(sql(service+'select public.qorpera_drain_company_file_wakes(32);'));
  assert.equal(drain.scanned,32); assert.equal(drain.examined,0); assert.equal(drain.admitted,0);
 }
 assert.notEqual(sql(`select c.last_scanned_at::text from public.qorpera_company_file_wake_cursors c join public.qorpera_company_environments e on e.id=c.environment_id where e.profile_id='${healthyListener.profile}';`),scanBefore);
 assert.equal(sql("select jsonb_agg(to_jsonb(c)-'last_scanned_at' order by routine_id) from public.qorpera_company_file_wake_cursors c;"),cursorPins);
 await commit(listenerLocks);
 passed('file_listener_rotation_survives_contention_without_advancing_processed_heads');
 report.catalogSha256=hash('sha256',JSON.stringify(afterFunctions));
 if(args.length)writeFileSync(resolve(args[1]).replace(/\.json$/,'.functions.json'),JSON.stringify(afterFunctions)+'\n',{flag:'wx'});
 report.passed=true;
} catch (error) {
	report.error = error.message;
	process.exitCode = 1;
	console.error(report.error);
} finally {
	for (const child of sessions) child.kill("SIGTERM");
	if (started) docker(["rm", "--force", container]);
	if (volumeCreated) docker(["volume", "rm", volume]);
	report.cleanupConfirmed = true;
	report.finishedAt = new Date().toISOString();
	if (args.length) writeFileSync(resolve(args[1]), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
	console.log(
		JSON.stringify({
			passed: report.passed,
			migrations: report.migrations.length,
			concurrency: report.concurrency.length,
			cleanupConfirmed: true,
		}),
	);
}
