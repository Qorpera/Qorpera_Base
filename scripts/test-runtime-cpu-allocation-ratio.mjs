// Local PostgreSQL only. No hosted credentials or deployed node is touched.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTestFixture, POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-cpu-ratio-${randomBytes(6).toString("hex")}`;
const read = (path) => readFileSync(join(root, path), "utf8");
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "fleet", "-v", "ON_ERROR_STOP=1"];
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = (text) => docker(psql, text);
const service = `set request.jwt.claims='{"role":"service_role"}';`;
function concurrentSql(text) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", psql, { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
		child.stdin.end(text);
	});
}
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "-e", "POSTGRES_PASSWORD=disposable-fleet", "-e", "POSTGRES_DB=fleet", POSTGRES_IMAGE]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: 2000 });
		const initialized = `${logs.stdout ?? ""}${logs.stderr ?? ""}`.includes("PostgreSQL init process complete; ready for start up.");
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "fleet"], { timeout: 2000 });
		ready = initialized && result.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(ready, 2, "PostgreSQL did not become ready");
	sql(read("supabase/tests/bootstrap.sql"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	sql(migrations.map((name) => read(`supabase/migrations/${name}`)).join("\n"));
	// 403 and 404 run on the folder-v2 base fixture (924). The coding fleet tests 602 and 604 went with C1c-3i
	// (20260930026000), coding sessions folder-v2 only.
	const tests = ["403_runtime_node_capacity_fits_demand.test.sql", "404_runtime_cpu_allocation_ratio.test.sql"];
	for (const test of tests) {
		process.stdout.write(`Running ${test}\n`);
		sql(expandTestFixture(test, (name) => read(`supabase/tests/${name}`)));
	}
	const fixture = expandTestFixture("404_runtime_cpu_allocation_ratio.test.sql", (name) => read(`supabase/tests/${name}`));
	const setup = fixture.split("-- BEGIN CPU RATIO RACE SETUP")[0];
	assert(setup !== fixture);
	// Release three exact fixture reservations; one2CPU VM remains. Reconfigure
	// to4CPU physical−2CPU headroom, doubled=4CPU: exactly one2CPU share free.
	sql(`${setup}
		select public.qorpera_release_runtime_machine(('40300000-0000-4000-8000-00000000020'||n)::uuid,'coding-capacity',
		 encode(extensions.digest('capacity-vm-'||n,'sha256'),'hex')) from generate_series(2,4) n;
		select public.qorpera_configure_runtime_node(pg_temp.ratio_policy()||'{"cpuMillis":4000}',4);
		select pg_temp.ratio_observe(4000);
		insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
		 dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
		select '40400000-0000-4000-8000-000000000106',profile_id,environment_id,staff_agent_id,todo_id,'ratio-race-six',species,title,access,revival,
		 dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version
		from public.qorpera_runtime_workers where id='40300000-0000-4000-8000-000000000102';
		insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
		select '40400000-0000-4000-8000-000000000206',profile_id,'40400000-0000-4000-8000-000000000106',provider_adapter,encode(extensions.digest('capacity-vm-6','sha256'),'hex')
		from public.qorpera_runtime_machine_allocations where id='40300000-0000-4000-8000-000000000202';
		-- A coding worker commits only with its first turn recorded (20260926162500, deferred). The fixture's coding
		-- workers are fixture rows, so their sessions and first turns are too.
		insert into public.qorpera_coding_sessions(worker_id,profile_id,environment_id,harness,repository,branch)
		select id,profile_id,environment_id,'codex','{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}'::jsonb,'ratio-'||worker_key
		from public.qorpera_runtime_workers where species='coding' and profile_id='92400000-0000-4000-8000-000000000010';
		insert into public.qorpera_coding_session_turns(worker_id,sequence,input_from)
		select worker_id,1,'dispatch' from public.qorpera_coding_sessions where profile_id='92400000-0000-4000-8000-000000000010';
		commit;`);
	const reserve = (id, n) => `select public.qorpera_reserve_runtime_node_machine('${id}','coding','coding-capacity',repeat('f',64),
	 encode(extensions.digest('capacity-vm-${n}','sha256'),'hex'),repeat('4',64),2000,4294967296);`;
	const results = await Promise.all([
		concurrentSql(`${service} begin; ${reserve("40300000-0000-4000-8000-000000000205",5)} select pg_sleep(0.25); commit;`),
		concurrentSql(`${service} begin; ${reserve("40400000-0000-4000-8000-000000000206",6)} select pg_sleep(0.25); commit;`),
	]);
	const reservations=results.map(result=>JSON.parse(result));
	assert.equal(reservations.filter(result=>result.state==="reserved").length,1,JSON.stringify(reservations));
	assert.equal(reservations.filter(result=>result.reason==="NODE_CAPACITY_EXHAUSTED").length,1,JSON.stringify(reservations));
	const capacity=JSON.parse(sql(`${service} select public.qorpera_runtime_node_capacity('40300000-0000-4000-8000-000000000010');`));
	assert.equal(capacity.allocatedCpuMillis,4000);
	assert.equal(capacity.allocatableCpuMillis,4000);
	assert.equal(capacity.physicalCpuMillis,4000);
	assert.equal(capacity.headroomCpuMillis,2000);
	assert.equal(capacity.cpuAllocationRatio,2);
	assert.equal(capacity.allocatedComputers,2);
	assert.equal(capacity.freeCpuMillis,0);
	process.stdout.write(JSON.stringify({schema:"qorpera.cpu-allocation-ratio-sql-proof/v1",migrations:migrations.length,tests,
	 concurrentLastBudgetSingleWinner:true,physicalInventoryPreserved:true,hardMemoryLimit:true,passed:true})+"\n");

} finally {
	if (started) spawnSync("docker", ["rm", "-f", container], { timeout: 30_000 });
}
