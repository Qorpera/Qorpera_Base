// Disposable PostgreSQL only: a stale source deployment cannot downgrade runtime authority.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-bundle-activation-${randomBytes(6).toString("hex")}`;
assert(process.argv.slice(2).every((arg) => arg === "--v128"), "Usage: test-runtime-bundle-activation.mjs [--v128]");
const target = 128;
const previous = target - 1;
const activationName = "20260926034000_runtime_bundle_activation_v128.sql";
const read = (path) => readFileSync(join(root, path), "utf8");
const activation = read(`supabase/migrations/${activationName}`);
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "activation", "-v", "ON_ERROR_STOP=1"];
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = (text) => docker(psql, text);
const active = () => sql("select b.version from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id=a.runtime_bundle_id where a.singleton;");
function concurrentActivation() {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", psql, { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stderr }));
		child.stdin.end(`begin;\n${activation}\nselect pg_sleep(0.2); commit;`);
	});
}
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "-e", "POSTGRES_PASSWORD=disposable-activation", "-e", "POSTGRES_DB=activation", POSTGRES_IMAGE]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		// The image's temporary initialization server listens only on the socket.
		// Wait for TCP so it cannot restart between readiness and the first query.
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "activation"], { timeout: 2000 });
		ready = result.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(ready, 2, "PostgreSQL did not become ready");
	sql(read("supabase/tests/bootstrap.sql"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	const activationIndex = migrations.indexOf(activationName);
	assert(activationIndex > 0, "The guarded activation must follow its prerequisite migrations");
	// Exercise this historical transition even when later releases add migrations.
	sql(migrations.slice(0, activationIndex).map((name) => read(`supabase/migrations/${name}`)).join("\n"));
	assert.equal(active(), String(previous));
	for (const version of [113, target + 1]) {
		const future = version > target ? `insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256) select bundle_key,${version},manifest,sha256 from public.qorpera_runtime_bundles where version=${previous} and bundle_key='qorpera.cloud-runtime';` : "";
		const result = spawnSync("docker", psql, {
			input: `begin; ${future} update public.qorpera_active_runtime_bundle a set runtime_bundle_id=b.id,runtime_bundle_sha256=b.sha256 from public.qorpera_runtime_bundles b where a.singleton and b.bundle_key='qorpera.cloud-runtime' and b.version=${version};\n${activation}\nrollback;`,
			encoding: "utf8", timeout: 30_000,
		});
		assert(!result.error && result.status !== 0, "Unexpected activation must fail");
		assert.match(result.stderr, new RegExp(`Activation requires exact active runtime v${previous}`));
		assert.equal(active(), String(previous), "Failed transaction preserves the original pointer");
		assert.equal(sql(`select count(*) from public.qorpera_runtime_bundles where version=${target};`), "0", "Refusal inserts no bundle");
	}
	const results = await Promise.all([concurrentActivation(), concurrentActivation()]);
	assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
	assert.match(results.find((result) => result.code !== 0).stderr, new RegExp(`Activation requires exact active runtime v${previous}`));
	assert.equal(active(), String(target));
	assert.equal(sql(`select count(*) from public.qorpera_runtime_bundles where version=${target};`), "1");
	const replay = spawnSync("docker", psql, { input: activation, encoding: "utf8", timeout: 30_000 });
	assert(!replay.error && replay.status !== 0);
	assert.match(replay.stderr, new RegExp(`Activation requires exact active runtime v${previous}`));
	assert.equal(active(), String(target), "Replay cannot change the active pointer");
	process.stdout.write(JSON.stringify({ passed: true, previous, target, olderRefused: 113, newerRefused: target + 1, concurrentWinners: 1, replayRefused: true }) + "\n");
} finally {
	if (started) spawnSync("docker", ["rm", "-f", container], { timeout: 30_000 });
}
