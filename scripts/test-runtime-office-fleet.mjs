// Disposable PostgreSQL proof. Physical host readiness remains synthetic.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-office-fleet-${randomBytes(6).toString("hex")}`;
const read = (path) => readFileSync(join(root, path), "utf8");
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = (text) => docker(["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "fleet", "-v", "ON_ERROR_STOP=1"], text);
function concurrentSql(statement) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "fleet", "-v", "ON_ERROR_STOP=1"], { timeout: 30_000 });
		let output = "";
		let error = "";
		child.stdout.on("data", (bytes) => { output += bytes; });
		child.stderr.on("data", (bytes) => { error += bytes; });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
		child.stdin.end(statement);
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
	sql(migrations.map((name) => read(`supabase/migrations/${name}`)).join("\n"));
	const wake = read("supabase/tests/300_runtime_wake_bus.test.sql").split("-- END WAKE FIXTURE");
	const office = read("supabase/tests/fixtures/runtime-office-registry-cases.sql").split("-- Synthetic guest readiness only.");
	assert.equal(wake.length, 2);
	assert.equal(office.length, 2);
	const cases = read("supabase/tests/fixtures/runtime-office-fleet-cases.sql");
	sql(`${wake[0]}\n${office[0]}\n${cases}\nrollback;`);
	// Independent clients attempt placement against the same staged generation.
	const scope = JSON.parse(sql(`${wake[0]}\n${office[0]}\n${cases.split("savepoint fleet_staged;")[0]}\nselect current_setting('qorpera_test.office_scope'); commit;`).split("\n").at(-1));
	const statement = `set request.jwt.claims='{"role":"service_role"}'; set role service_role; select public.qorpera_place_runtime_office_fleet('${JSON.stringify(scope)}'::jsonb,1);`;
	const replies = await Promise.all([concurrentSql(statement), concurrentSql(statement)]);
	assert.deepEqual(JSON.parse(replies[0]), JSON.parse(replies[1]));
	assert.equal(JSON.parse(replies[0]).state, "placed");
	assert.equal(sql("select count(*) from public.qorpera_runtime_machine_allocations;"), "1");
	assert.equal(sql("select count(*) from public.qorpera_runtime_node_demands where reserved_at is not null;"), "1");
	assert.equal(sql("select count(*) from public.qorpera_runtime_office_fleet_offers where selected_at is not null;"), "1");
	process.stdout.write(JSON.stringify({ schema: "qorpera.office-fleet-sql-proof/v1", migrations: migrations.length, passed: true, concurrentPlacers: 2, physicalHost: "synthetic" }) + "\n");
} finally {
	if (started) spawnSync("docker", ["rm", "-f", container], { timeout: 30_000 });
}
