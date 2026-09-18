import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

// Synthetic, disposable database only. Run explicitly; never uses deployment
// credentials, a configured database URL, or a real provider account.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-path-races-${randomBytes(6).toString("hex")}`;
const environmentId = "29000000-0000-4000-8000-000000000020";
const profileId = "29000000-0000-4000-8000-000000000010";
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
const claims = `set local "request.jwt.claims" = '{"role":"service_role"}';`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;

function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
	if (result.error || result.status !== 0) throw new Error(`Disposable database command failed: ${result.error ?? result.stderr}`);
	return result.stdout;
}

function sql(body) {
	return docker(psql, body);
}

function concurrentSql(body, onOutput = () => undefined) {
	const child = spawn("docker", psql, { stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	const result = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			onOutput(stdout);
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	}).finally(() => clearTimeout(timer));
	child.stdin.end(body);
	return result;
}

let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--label", "qorpera.step2-test=path-races",
		"-e", "POSTGRES_PASSWORD=qorpera-test-only", "-e", "POSTGRES_DB=qorpera_test",
		"--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g", POSTGRES_IMAGE]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const probe = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "qorpera_test"], { encoding: "utf8", timeout: 2_000 });
		ready = probe.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(ready, 2, "Disposable database must start");
	sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const migration of migrations) sql(readFileSync(join(root, "supabase/migrations", migration), "utf8"));
	const fixture = readFileSync(join(root, "supabase/tests/290_company_file_path_gateway.test.sql"), "utf8");
	assert.match(fixture, /rollback;\s*$/i);
	// Retain this fixture only inside this disposable instance so independent
	// connections race the same genuinely admitted native run and path policy.
	sql(fixture.replace(/rollback;\s*$/i, `
		create table public.qorpera_test_path_binding as select current_setting('qorpera_test.path_binding')::jsonb as binding;
		commit;
	`));
	const binding = JSON.parse(sql("select binding from public.qorpera_test_path_binding;").trim());
	const argument = `${literal(environmentId)}::uuid,${json(binding)}`;
	const native = (body) => `begin; ${claims} set local role service_role; ${body} commit;`;
	const nativeJson = (body) => JSON.parse(sql(native(body)).trim());
	const countRevisions = () => Number(sql(`select count(*) from public.qorpera_company_path_revisions where environment_id = ${literal(environmentId)};`).trim());
	const head = () => sql(`select head_snapshot_id from public.qorpera_company_files where environment_id = ${literal(environmentId)};`).trim();

	function candidate(operationKey, path) {
		const plan = { schema: "qorpera.company-path-mutation/v1", operationKey, path, expectedVersion: null, entry: { path, kind: "directory" } };
		const prepared = nativeJson(`select public.qorpera_prepare_company_path_mutation(${argument},${json(plan)});`);
		assert.equal(prepared.state, "ready");
		const manifest = JSON.stringify({
			schema: "qorpera.company-tree/v1", contractVersion: 3,
			omittedLayers: ["company-git-history", "session-trail", "staff-registry", "product-git-checkouts", "dependency-caches", "staff-instructions", "system-metadata"],
			entries: [...prepared.entries, plan.entry].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		});
		const sha256 = createHash("sha256").update(manifest).digest("hex");
		sql(`begin; ${claims}
			insert into storage.objects(bucket_id,name,metadata) values ('qorpera-profile-objects',${literal(`${profileId}/${sha256}`)},jsonb_build_object('size',${Buffer.byteLength(manifest)})) on conflict do nothing;
			select public.qorpera_verify_company_path_tree(${literal(profileId)},${literal(manifest)}); commit;`);
		return { plan, statement: `select public.qorpera_commit_company_path_mutation(${argument},${json(plan)},${literal(prepared.snapshotId)}::uuid,${literal(sha256)});` };
	}

	const beforeRace = countRevisions();
	const first = candidate("race-first", "raced-directory");
	const second = candidate("race-second", "raced-directory");
	const raced = await Promise.all([concurrentSql(native(first.statement)), concurrentSql(native(second.statement))]);
	assert.equal(raced.filter((result) => result.status === 0).length, 1, "Exactly one concurrent writer commits");
	assert.match(raced.find((result) => result.status !== 0).stderr, /PT412/, "The loser must fail its expected version without automatic transaction retry");
	assert.equal(countRevisions(), beforeRace + 1);
	const winner = raced[0].status === 0 ? first : second;
	const receipt = JSON.parse(raced.find((result) => result.status === 0).stdout.trim());
	assert.deepEqual(nativeJson(winner.statement), receipt, "A fresh connection must recover the committed exact outcome");
	assert.equal(countRevisions(), beforeRace + 1);
	console.log("PASS: simultaneous writers, stale-version rejection, and durable receipt replay");

	const beforeCrash = countRevisions();
	const crashHead = head();
	const crashing = candidate("crash-before-commit", "crash-directory");
	let terminated = false;
	const crashed = await concurrentSql(`begin; ${claims} set local role service_role;
		${crashing.statement}
		select 'STAGED:' || pg_backend_pid()::text;
		select pg_sleep(25); commit;`, (stdout) => {
		const pid = /^STAGED:(\d+)$/m.exec(stdout)?.[1];
		if (!terminated && pid) {
			terminated = true;
			assert.equal(sql(`select pg_terminate_backend(${Number(pid)});`).trim(), "t");
		}
	});
	assert.equal(terminated, true, "Crash must happen after all mutation work and before commit");
	assert.notEqual(crashed.status, 0);
	assert.equal(head(), crashHead);
	assert.equal(countRevisions(), beforeCrash);
	assert.equal(sql(`select count(*) from public.qorpera_run_operation_receipts where run_id = ${literal(binding.runId)} and logical_operation_key = 'company_path:crash-before-commit';`).trim(), "0");
	const recovered = nativeJson(crashing.statement);
	assert.equal(recovered.state, "applied");
	assert.equal(countRevisions(), beforeCrash + 1);
	assert.deepEqual(nativeJson(crashing.statement), recovered);
	console.log("PASS: connection death after publication work rolls back head, path, receipt, and projection together");

	const lost = candidate("lost-after-commit", "lost-response-directory");
	const beforeLost = countRevisions();
	// Deliberately discard the successful response; the next connection knows
	// only the logical plan. It must read the receipt, not execute again.
	sql(native(lost.statement));
	const restored = nativeJson(lost.statement);
	assert.equal(restored.state, "applied");
	assert.equal(countRevisions(), beforeLost + 1);
	assert.equal(head(), restored.snapshotId);
	console.log("PASS: lost committed response recovered without a second effect");
	console.log(`Passed Company File transaction races and crash recovery after ${migrations.length} migrations`);
} finally {
	if (started) {
		docker(["rm", "-f", container]);
		console.log(`Removed disposable database ${container}`);
	}
}
