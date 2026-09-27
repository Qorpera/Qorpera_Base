import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContainerName, expandTestFixture, POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

/**
 * Concurrent load on one company's profile fence and Company File row: an agent's tool calls, Storage uploads,
 * the object gateway's NAS replica copies, a node observer and a coding session's turns, all at once, in a
 * disposable PostgreSQL built like `npm run test:hosted-db`. Prints each kind's calls, errors and latency, and
 * the errors by kind.
 *
 *   node scripts/load-company-file-fence.mjs [--skip <migration file>]... [--check]
 *
 * --skip leaves a migration out, to compare with the text before it. --check exits 1 when any call deadlocked
 * (40P01), an agent tool call took longer than the native result boundary's 4 s budget, or any call failed
 * other than a coding turn's begin that found the company's profile row taken on every retry (reported only:
 * the executor begins again until its lease ends).
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const skipped = new Set();
let check = false;
for (let index = 0; index < args.length; index += 1) {
	if (args[index] === "--check") check = true;
	else if (args[index] === "--skip" && args[index + 1]) skipped.add(args[++index]);
	else throw new Error(`Unknown argument ${args[index]}; use --skip <migration file> and --check`);
}
const containerName = buildContainerName(process.pid, randomBytes(4).toString("hex"));
for (const [signal, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
]) {
	process.on(signal, () => {
		spawnSync("docker", ["rm", "--force", containerName]);
		process.exit(code);
	});
}
const database = "qorpera_test";

function run(command, commandArgs, input) {
	const result = spawnSync(command, commandArgs, { input, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`${command} ${commandArgs.slice(0, 4).join(" ")} failed:\n${result.stderr}`);
	return result.stdout;
}
function psqlArgs() {
	return [
		"exec",
		"-i",
		containerName,
		"psql",
		"-q",
		"-U",
		"postgres",
		"-d",
		database,
		"--no-psqlrc",
		"-v",
		"ON_ERROR_STOP=1",
	];
}
const psql = (sql) => run("docker", [...psqlArgs(), "-At"], sql);
const call = (statement) =>
	new Promise((resolveCall, rejectCall) => {
		const child = spawn("docker", [...psqlArgs(), "-c", statement], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => (code === 0 ? resolveCall() : rejectCall(new Error(`${statement}: ${stderr}`))));
	});

try {
	run("docker", ["info", "--format", "{{.ServerVersion}}"]);
	run("docker", [
		"run",
		"--detach",
		"--rm",
		"--name",
		containerName,
		"--env",
		"POSTGRES_PASSWORD=qorpera-load-only",
		"--env",
		`POSTGRES_DB=${database}`,
		"--tmpfs",
		"/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
		POSTGRES_IMAGE,
	]);
	for (let ready = 0, attempt = 0; ready < 2; attempt += 1) {
		if (attempt > 120) throw new Error("Disposable PostgreSQL did not become ready within 60 seconds");
		ready =
			spawnSync("docker", ["exec", containerName, "pg_isready", "-U", "postgres", "-d", database]).status === 0
				? ready + 1
				: 0;
		spawnSync("sleep", ["0.5"]);
	}
	psql(readFileSync(join(repositoryRoot, "supabase", "tests", "bootstrap.sql"), "utf-8"));
	const migrations = sortMigrationNames(readdirSync(join(repositoryRoot, "supabase", "migrations")));
	for (const name of skipped) if (!migrations.includes(name)) throw new Error(`No migration ${name} to skip`);
	for (const migration of migrations.filter((name) => !skipped.has(name))) {
		psql(readFileSync(join(repositoryRoot, "supabase", "migrations", migration), "utf-8"));
	}
	const testsRoot = join(repositoryRoot, "supabase", "tests");
	const fixture = expandTestFixture("load-company-file-fence.sql", (name) =>
		name === "load-company-file-fence.sql"
			? '-- @fixture 602_runtime_coding_lock_order.test.sql until "-- 1. The owner answers"\n'
			: readFileSync(join(testsRoot, name), "utf-8"),
	);
	psql(fixture + readFileSync(join(repositoryRoot, "scripts", "load-company-file-fence.sql"), "utf-8"));

	const started = Date.now();
	await Promise.all([
		call("call loadtest.agent(300)"),
		...[1, 2, 3, 4].map((worker) => call(`call loadtest.storage(${worker}, 120)`)),
		call("call loadtest.replica(60)"),
		call("call loadtest.observer(250)"),
		call("call loadtest.coding(60)"),
	]);
	process.stdout.write(
		`Load ran ${Math.round((Date.now() - started) / 1000)} s${skipped.size ? ` without ${[...skipped].join(", ")}` : ""}\n`,
	);
	process.stdout.write(
		psql(`select rpad(kind, 19) || lpad(count(*)::text, 6) || ' calls' || lpad(count(error)::text, 5) || ' errors'
			|| '  p50 ' || lpad(round(percentile_cont(0.5) within group (order by ms)::numeric)::text, 5) || ' ms'
			|| '  p99 ' || lpad(round(percentile_cont(0.99) within group (order by ms)::numeric)::text, 5) || ' ms'
			|| '  max ' || lpad(round(max(ms)::numeric)::text, 5) || ' ms'
			from loadtest.latency where kind <> 'coding-begin-tries' group by kind order by kind;
			select 'coding begins      ' || lpad(count(*)::text, 6) || ' turns  tries p50 ' || percentile_disc(0.5) within group (order by ms)
				|| ', max ' || max(ms) from loadtest.latency where kind = 'coding-begin-tries';
			select '  ' || kind || ': ' || count(*) || ' x ' || error from loadtest.latency where error is not null
			group by kind, error order by count(*) desc;`),
	);
	const [deadlocks, slowAgents, otherErrors] =
		psql(`select count(*) filter (where error like '40P01%' or error like '% 40P01 %'),
		count(*) filter (where kind = 'agent' and ms > 4000),
		count(*) filter (where error is not null and error not like '40P01%' and error not like '% 40P01 %'
			and error not like 'begin 55P03 % "qorpera_profiles"') from loadtest.latency`)
			.trim()
			.split("|")
			.map(Number);
	if (check && (deadlocks > 0 || slowAgents > 0 || otherErrors > 0)) {
		process.stdout.write(
			`Check failed: ${deadlocks} deadlocks, ${slowAgents} agent calls over 4 s, ${otherErrors} other errors\n`,
		);
		process.exitCode = 1;
	}
} finally {
	spawnSync("docker", ["rm", "--force", containerName]);
}
