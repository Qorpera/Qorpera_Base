import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
import { verifyIdentityRecoveryRoundTrip } from "./identity-recovery-round-trip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out")) throw new Error("Use --out <new-evidence-directory>");
const evidence = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), "qorpera-recovery-db-"));
if (args.length) await mkdir(evidence, { mode: 0o700 });
const container = `qorpera-recovery-test-${randomBytes(6).toString("hex")}`;
const volume = `${container}-data`;
const tests = [
	"160_native_subscription_compute_identity.test.sql", "165_cloud_agent_public_mouth_privileges.test.sql",
	"280_cloud_session_run_control.test.sql", "297_company_path_computer_interlock.test.sql",
	"298_compute_identity_recovery.test.sql",
	"299_member_identity_recovery_review.test.sql",
];
const checksums = {};
async function source(path) {
	const bytes = await readFile(join(root, path));
	checksums[path] = createHash("sha256").update(bytes).digest("hex");
	return bytes.toString("utf8");
}
function docker(args, input) {
	const child = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
	if (child.error || child.status !== 0) throw new Error(`${child.error ?? child.stderr}\n${child.stdout}`);
	return child.stdout;
}
const psql = ["exec", "-i", container, "psql", "-X", "-q", "-t", "-A", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1"];
function sql(statement) { return docker(psql, statement).trim(); }
async function waitForDatabase() {
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const probe = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "qorpera_test"], { encoding: "utf8", timeout: 2_000 });
		ready = probe.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	}
	if (ready < 2) throw new Error("Disposable PostgreSQL did not become ready");
}
function concurrentSql(statement) {
	return new Promise((resolveResult, reject) => {
		const child = spawn("docker", psql, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = ""; let stderr = "";
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Recovery concurrency fixture timed out")); }, 15_000);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new Error(stderr)); else resolveResult(stdout.trim());
		});
		child.stdin.end(statement);
	});
}
const ids = {
	company: "29800000-0000-4000-8000-000000000010", identity: "29800000-0000-4000-8000-000000000020",
	authority: "29800000-0000-4000-8000-000000000030", owner: "29800000-0000-4000-8000-000000000001",
	member: "29800000-0000-4000-8000-000000000002", target: "29800000-0000-4000-8000-000000000040",
	otherTarget: "29800000-0000-4000-8000-000000000042", client: "29800000-0000-4000-8000-000000000060",
	otherClient: "29800000-0000-4000-8000-000000000061",
};
function actor(role, user, statement) {
	return `begin; set local statement_timeout='10s'; set local role ${role};
		set local request.jwt.claims='${JSON.stringify({ role, ...(user ? { sub: user } : {}) })}';
		${statement}; commit;`;
}
function request(target, client) {
	return actor("authenticated", ids.owner, `select public.qorpera_request_identity_recovery(
		'${ids.identity}','${target}','${client}',1,repeat('b',64),'nas')`);
}
function service(statement) { return actor("service_role", undefined, statement); }
let started = false;
let volumeCreated = false;
try {
	docker(["volume", "create", "--label", "qorpera.step2-test=identity-recovery", volume]);
	volumeCreated = true;
	docker(["run", "-d", "--rm", "--name", container, "--label", "qorpera.step2-test=identity-recovery",
		"-e", "POSTGRES_PASSWORD=qorpera-test-only", "-e", "POSTGRES_DB=qorpera_test",
		"--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, POSTGRES_IMAGE]);
	started = true;
	await waitForDatabase();
	sql(await source("supabase/tests/bootstrap.sql"));
	const migrations = sortMigrationNames(await readdir(join(root, "supabase/migrations")));
	for (const migration of migrations) sql(await source(`supabase/migrations/${migration}`));
	console.log(`PASS ${migrations.length} migrations`);
	for (const test of tests) {
		await writeFile(join(evidence, `${test}.log`), sql(await source(`supabase/tests/${test}`)), { mode: 0o600 });
		console.log(`PASS ${test}`);
	}
	const recoveryTest = await source("supabase/tests/298_compute_identity_recovery.test.sql");
	const sections = recoveryTest.split("-- RECOVERY_CONCURRENCY_FIXTURE_READY");
	assert.equal(sections.length, 2, "Recovery setup fixture boundary changed");
	sql(sections[0] + "\ncommit;");
	const duplicates = await Promise.all([concurrentSql(request(ids.target, ids.client)), concurrentSql(request(ids.target, ids.client))]);
	const first = JSON.parse(duplicates[0]);
	assert.equal(JSON.parse(duplicates[1]).recoveryId, first.recoveryId);
	assert.match(first.recoveryId, /^[0-9a-f-]{36}$/);
	sql(service(`select public.qorpera_register_identity_recovery_target('${ids.authority}',repeat('c',64),
		'${ids.otherTarget}','${ids.identity}','29800000-0000-4000-8000-000000000043',
		repeat('1',64),repeat('2',64),repeat('A',550),repeat('3',64))`));
	const second = JSON.parse(sql(request(ids.otherTarget, ids.otherClient)));
	assert.match(second.recoveryId, /^[0-9a-f-]{36}$/);
	const races = await Promise.allSettled([first, second].map((row) => concurrentSql(actor("authenticated", ids.member,
		`select public.qorpera_consent_identity_recovery('${row.recoveryId}')`))));
	assert.equal(races.filter((result) => result.status === "fulfilled").length, 1, "Competing restores both activated");
	const denial = races.find((result) => result.status === "rejected");
	assert.match(String(denial.reason), /already in progress/);
	const winner = JSON.parse(races.find((result) => result.status === "fulfilled").value);
	assert.equal(winner.epoch, 1);
	sql(`update public.qorpera_identity_recoveries set not_before=clock_timestamp()-interval '1 second' where id='${winner.recoveryId}'`);
	const releaseArgs = `'${ids.authority}',repeat('c',64),'${winner.recoveryId}',repeat('3',64)`;
	const plans = await Promise.all([0, 1].map(() => concurrentSql(service(
		`select public.qorpera_prepare_identity_key_release(${releaseArgs})`))));
	assert.deepEqual(JSON.parse(plans[0]), JSON.parse(plans[1]), "Concurrent release preparation changed the grant");
	const commits = await Promise.allSettled(["4", "5"].map((digest) => concurrentSql(service(
		`select public.qorpera_commit_identity_key_release(${releaseArgs},repeat('${digest}',64),1024)`))));
	assert.equal(commits.filter((result) => result.status === "fulfilled").length, 1, "Competing envelopes were both committed");
	assert.match(String(commits.find((result) => result.status === "rejected").reason), /already bound/);
	const release = JSON.parse(commits.find((result) => result.status === "fulfilled").value);
	assert.match(release.releaseSha256, /^[0-9a-f]{64}$/);
	const completions = await Promise.all([0, 1].map(() => concurrentSql(service(
		`select public.qorpera_complete_identity_recovery(${releaseArgs},'${release.releaseSha256}',repeat('6',64))`))));
	assert.deepEqual(JSON.parse(completions[0]), JSON.parse(completions[1]), "Concurrent completion changed the receipt");
	assert.equal(sql(`select count(*) from public.qorpera_identity_recoveries where status='completed'`), "1");
	assert.equal(sql(`select recovery_epoch from public.qorpera_member_compute_identities where id='${ids.identity}'`), "1");
	const completed = JSON.parse(completions[0]);
	// Restart PostgreSQL, then use the same immutable receipt through the real RPC.
	docker(["restart", container]);
	await waitForDatabase();
	const replay = JSON.parse(sql(service(`select public.qorpera_complete_identity_recovery(
		${releaseArgs},'${release.releaseSha256}',repeat('6',64))`)));
	assert.deepEqual(replay, completed);
	console.log("PASS concurrent request dedupe, competing restores, release fencing, completion dedupe and database restart replay");
	const roundTrip = await verifyIdentityRecoveryRoundTrip({ sql, source, actor });
	console.log("PASS real SQL + HTTP + signed-envelope backup/restore + native capsule decryption and lost-ACK replay");
	for (const path of [
		"scripts/test-identity-recovery.mjs", "scripts/identity-recovery-round-trip.mjs",
		"packages/shell/src/cloud-identity-recovery.ts", "packages/shell/src/cloud-identity-recovery-crypto.ts",
		"packages/shell/src/cloud-identity-recovery-service.ts", "packages/shell/src/cloud-identity-recovery-store.ts",
		"packages/shell/src/cloud-identity-recovery-guest.ts", "packages/shell/src/cloud-native-provider-host.ts",
	]) await source(path);
	await writeFile(join(evidence, "manifest.json"), JSON.stringify({
		schema: "qorpera.identity-recovery-verification/v1", at: new Date().toISOString(), root,
		image: POSTGRES_IMAGE, migrations: migrations.length, tests, checksums,
		concurrentRequests: true, concurrentRestores: true, conflictingReleases: true, concurrentCompletion: true, databaseRestartReplay: true,
		roundTrip,
		productionChanged: false, realProviderCalls: false,
	}, null, 2)+"\n", { mode: 0o600 });
	console.log(evidence);
} finally {
	if (started) docker(["rm", "-f", container]);
	if (volumeCreated) docker(["volume", "rm", volume]);
	console.log("Removed disposable recovery database and its test volume");
}
