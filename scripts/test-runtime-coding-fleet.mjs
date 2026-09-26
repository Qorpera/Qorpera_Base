// Local PostgreSQL only. No hosted credentials or deployed node is touched.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { expandTestFixture, POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-coding-fleet-${randomBytes(6).toString("hex")}`;
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
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "fleet"], { timeout: 2000 });
		ready = result.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(ready, 2, "PostgreSQL did not become ready");
	sql(read("supabase/tests/bootstrap.sql"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) sql(read(`supabase/migrations/${name}`));
	const tests = process.argv.slice(2);
	if (!tests.length) tests.push("395_runtime_coding_sessions.test.sql", "396_runtime_coding_executor.test.sql", "600_runtime_coding_member_machines.test.sql", "601_runtime_coding_turn_continuity.test.sql", "602_runtime_coding_fleet.test.sql");
	for (const test of tests) {
		assert(/^[0-9a-z_]+\.test\.sql$/.test(test));
		process.stdout.write(`Running ${test}\n`);
		sql(expandTestFixture(test, (name) => read(`supabase/tests/${name}`)));
	}
	// Commit only the disposable fixture, then have two independent PostgreSQL
	// sessions plan two leased members against one remaining physical slot.
	const fixture = expandTestFixture("602_runtime_coding_fleet.test.sql", (name) => read(`supabase/tests/${name}`));
	const setup = fixture.split("-- BEGIN FLEET PLACEMENT ASSERTIONS")[0];
	assert(setup !== fixture, "Fleet fixture setup marker missing");
	sql(`${setup}
		select public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-other',false,array['codex']);
		update public.qorpera_runtime_nodes set headroom_cpu_millis=4000 where id='30000000-0000-4000-8000-000000000310';
		select pg_temp.fleet_session('concurrent','30000000-0000-4000-8000-000000000002');
		create table public.qorpera_test_fleet_claims (claim jsonb);
		insert into public.qorpera_test_fleet_claims values(public.qorpera_claim_coding_session('exec-test',60));
		insert into public.qorpera_test_fleet_claims values(public.qorpera_claim_coding_session('exec-test',60));
		commit;`);
	const claims = JSON.parse(sql(`select jsonb_agg(claim) from public.qorpera_test_fleet_claims;`));
	assert.equal(new Set(claims.map((claim) => claim.workerId)).size, 2, "Two different members obtain queue leases");
	const results = await Promise.all(claims.map((claim) => concurrentSql(`${service} begin;
		select public.qorpera_plan_coding_machine('${claim.workerId}','${claim.leaseToken}',repeat('c',64));
		select pg_sleep(0.25); commit;`)));
	const plans = results.map((result) => JSON.parse(result));
	assert.equal(plans.filter((plan) => plan.state === "planned").length, 1, JSON.stringify(plans));
	assert.equal(plans.filter((plan) => plan.reason === "NODE_CAPACITY_EXHAUSTED").length, 1, JSON.stringify(plans));
	assert.equal(sql(`select count(*) from public.qorpera_coding_machines where removed_at is null;`), "1");
	assert.equal(sql(`select count(*) from public.qorpera_runtime_machine_allocations where coding_machine_id is not null;`), "1");
	assert.equal(sql(`select sum(cpu_millis) from public.qorpera_runtime_node_demands where released_at is null and suspended_at is null;`), "2000");
	assert.equal(sql(`select count(*) from public.qorpera_coding_storage_volumes;`), "0", "Planning cannot pin a NAS writer");
	const plan = plans.find((candidate) => candidate.state === "planned");
	const bundled = buildSync({
		stdin: { contents: `import { readFileSync } from 'node:fs'; import { lxdCodingMachinePlan } from './packages/runner-orchestrator/src/coding-machine.ts'; console.log(JSON.stringify(lxdCodingMachinePlan(JSON.parse(readFileSync(0,'utf8')))));`, resolveDir: root },
		absWorkingDir: root, bundle: true, platform: "node", format: "cjs", write: false,
	}).outputFiles[0].text;
	const serialized = spawnSync(process.execPath, ["-e", bundled], { input: JSON.stringify(plan.binding), encoding: "utf8", timeout: 30_000 });
	assert.equal(serialized.status, 0, serialized.stderr);
	const tsPlan = JSON.parse(serialized.stdout);
	assert.equal(plan.bindingText, tsPlan.text, "SQL and lxdCodingMachinePlan must emit identical bytes");
	assert.equal(sql(`select instance_sha256 from public.qorpera_coding_machines where id='${plan.machineId}';`), tsPlan.instanceSha256);
	process.stdout.write(JSON.stringify({ schema: "qorpera.coding-fleet-sql-proof/v1", migrations: migrations.length, tests, concurrentLastSlot: true, typescriptBindingBytes: true, passed: true }) + "\n");
} finally {
	if (started) spawnSync("docker", ["rm", "-f", container], { timeout: 30_000 });
}
