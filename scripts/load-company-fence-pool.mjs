import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildContainerName, expandTestFixture, POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

/**
 * One company under load the way production serves it: every call is one transaction on a small pool of
 * connections with the PostgREST role's timeouts (statement_timeout and lock_timeout 8 s, as observed on
 * 2026-09-12, 20260913000100), with request.path and the service role's claims set as PostgREST sets them.
 * Several agents (each its own run and native binding) send what every model request sends (the tool
 * authority and the read-set check, together) and Company File reads; every third round an acting tool's
 * receipt (begin and complete); some agents also write the Company File (upload, verify, prepare, upload and
 * verify the tree, commit).
 * Beside them, object GC (claim, storage delete, complete) and transactions that insert a row pointing at the
 * company's profile row (a foreign-key KEY SHARE). A call's time counts from asking the pool for a
 * connection; a call slower than its client's deadline is counted as given up (the runtime would have
 * stopped waiting; its statement still runs, as behind PostgREST).
 *
 *   node scripts/load-company-fence-pool.mjs [--skip <migration file>]... [--seconds 40] [--agents 8]
 *     [--writers 2] [--pool 10] [--rtt 50] [--check]
 *
 * --rtt is each call's round trip outside the database (the runtime to PostgREST and back, about 50-65 ms
 * from Denmark): a client waits that long before its next call, and it counts towards the client's deadline.
 * --rtt 0 sends calls back to back, far denser than production.
 *
 * --skip leaves a migration out, to compare with the text before it. --check exits 1 when any call
 * deadlocked (40P01), ran into the statement timeout (57014) or failed for a reason that is not load: a GC
 * lease making a call wait for storage (QRC01), a Company File head that moved under a write (PT409), a lock
 * wait that ran out (55P03) or a NOWAIT lock that was taken are reported, not failures.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = { skipped: new Set(), seconds: 40, agents: 8, writers: 2, pool: 10, rtt: 50, check: false };
{
	const args = process.argv.slice(2);
	const count = (value, name, min, max) => {
		const number = Number(value);
		if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} must be ${min}-${max}`);
		return number;
	};
	for (let index = 0; index < args.length; index += 1) {
		const [flag, value] = [args[index], args[index + 1]];
		if (flag === "--check") options.check = true;
		else if (flag === "--skip" && value) options.skipped.add(args[++index]);
		else if (flag === "--seconds" && value) options.seconds = count(args[++index], flag, 5, 600);
		else if (flag === "--agents" && value) options.agents = count(args[++index], flag, 1, 32);
		else if (flag === "--writers" && value) options.writers = count(args[++index], flag, 0, 32);
		else if (flag === "--pool" && value) options.pool = count(args[++index], flag, 2, 64);
		else if (flag === "--rtt" && value) options.rtt = count(args[++index], flag, 0, 1000);
		else throw new Error(`Unknown argument ${flag}; see the usage in ${fileURLToPath(import.meta.url)}`);
	}
	options.writers = Math.min(options.writers, options.agents);
}
const COMPANY = "30000000-0000-4000-8000-000000000010";
const ENVIRONMENT = "30000000-0000-4000-8000-000000000020";
const OWNER = "30000000-0000-4000-8000-000000000001";
const SERVICE_CLAIMS = JSON.stringify({ role: "service_role" });
const database = "qorpera_test";
const password = "qorpera-load-only";
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

function run(command, commandArgs, input) {
	const result = spawnSync(command, commandArgs, { input, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`${command} ${commandArgs.slice(0, 4).join(" ")} failed:\n${result.stderr}`);
	return result.stdout;
}
const psql = (sql) =>
	run(
		"docker",
		["exec", "-i", containerName, "psql", "-q", "-U", "postgres", "-d", database, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-At"],
		sql,
	);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** A failed call's class: what the harness reports, and what --check refuses. */
function classify(error) {
	if (error.code === "PGRST") {
		try {
			const body = JSON.parse(error.message);
			if (body.code === "QRC01") return { name: "busy", detail: body.message };
			if (body.code === "PT409") return { name: "head-conflict", detail: body.message };
			return { name: "other", detail: `PGRST ${body.code} ${body.message}` };
		} catch {
			return { name: "other", detail: `PGRST ${error.message}` };
		}
	}
	if (error.code === "PT409") return { name: "head-conflict", detail: error.message };
	if (error.code === "40P01") return { name: "deadlock", detail: error.message };
	if (error.code === "55P03")
		return /lock timeout/.test(error.message)
			? { name: "lock-timeout", detail: error.message }
			: { name: "nowait", detail: error.message };
	if (error.code === "57014") return { name: "statement-timeout", detail: error.message };
	return { name: "other", detail: `${error.code ?? "?"} ${String(error.message).slice(0, 160)}` };
}
const CLASSES = ["deadlock", "statement-timeout", "lock-timeout", "nowait", "busy", "head-conflict", "other"];
const UNEXPECTED = new Set(["deadlock", "statement-timeout", "other"]);

const stats = new Map();
function record(kind, sample) {
	if (!stats.has(kind)) stats.set(kind, []);
	stats.get(kind).push(sample);
}
function percentile(values, fraction) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

let pool;
let end = 0;
const running = () => performance.now() < end;

/** One RPC as PostgREST runs it: one transaction on a pooled connection, request.path and claims set. */
async function call(kind, rpc, statements, deadlineMs, { rollback = false } = {}) {
	if (options.rtt) await sleep(options.rtt);
	const started = performance.now();
	const client = await pool.connect();
	const connected = performance.now();
	let value = null;
	let failure = null;
	try {
		await client.query("begin");
		await client.query("select set_config('request.path', $1, true), set_config('request.jwt.claims', $2, true)", [
			`/rpc/${rpc}`,
			SERVICE_CLAIMS,
		]);
		for (const [sql, params] of statements) {
			const result = await client.query(sql, params);
			value = result.rows[0]?.value ?? null;
		}
		await client.query(rollback ? "rollback" : "commit");
	} catch (error) {
		failure = classify(error);
		await client.query("rollback").catch(() => undefined);
	} finally {
		client.release();
	}
	const ended = performance.now();
	record(kind, {
		totalMs: ended - started,
		queueMs: connected - started,
		gaveUp: ended - started + options.rtt > deadlineMs,
		failure,
	});
	return { value, failure };
}

// The runtime's client deadlines: the path gateway's RPCs 3 s (cloud-company-path-control.ts), the tool
// authority 10 s when sent with the read-set check (CLOUD_PAIRED_REQUEST_TIMEOUT_MS), tool receipts 5 s.
const PATH_DEADLINE = 3000;
const PAIRED_DEADLINE = 10_000;
const TOOL_DEADLINE = 5000;

function beforeModelRequest(binding) {
	return Promise.all([
		call(
			"authority",
			"qorpera_describe_native_tool_authority",
			[["select public.qorpera_describe_native_tool_authority($1::jsonb) as value", [binding]]],
			PAIRED_DEADLINE,
		),
		call(
			"read-set",
			"qorpera_assert_company_path_reads",
			[["select 1 as value from public.qorpera_assert_company_path_reads($1::uuid, $2::jsonb, $3::text[])", [ENVIRONMENT, binding, []]]],
			PATH_DEADLINE,
		),
	]);
}

/** One Storage upload (the object gateway's), its own transaction. */
function storeObject(object) {
	return call(
		"write-upload",
		"storage_objects_insert",
		[["select loadpool.store_object($1, $2) as value", [object.sha256, object.bytes]]],
		PATH_DEADLINE,
	);
}

async function writeFile(binding, agent, round) {
	const path = `load-${agent}-${round}.txt`;
	// The object gateway stores the file's bytes and manifest, then the runtime verifies the manifest, prepares,
	// has the tree stored and verifies it, and commits: each its own call.
	const file = (await pool.query("select loadpool.file($1, $2) as value", [path, `Agent ${agent}, change ${round}.`])).rows[0].value;
	for (const object of file.objects) if ((await storeObject(object)).failure) return;
	const verified = await call(
		"write-verify",
		"qorpera_verify_company_path_file",
		[["select public.qorpera_verify_company_path_file($1::uuid, $2) as value", [COMPANY, file.manifest]]],
		PATH_DEADLINE,
	);
	if (verified.failure) return;
	const plan = JSON.stringify({
		schema: "qorpera.company-path-mutation/v1",
		operationKey: `load-${agent}-${round}`,
		path,
		expectedVersion: null,
		entry: file.entry,
	});
	// A moved head is rebuilt a bounded number of times, as the runtime does.
	for (let attempt = 0; attempt < 3 && running(); attempt += 1) {
		const prepared = await call(
			"write-prepare",
			"qorpera_prepare_company_path_mutation",
			[["select public.qorpera_prepare_company_path_mutation($1::uuid, $2::jsonb, $3::jsonb) as value", [ENVIRONMENT, binding, plan]]],
			PATH_DEADLINE,
		);
		if (!prepared.value || prepared.value.state !== "ready") return;
		const tree = (await pool.query("select loadpool.tree($1::jsonb, $2::jsonb) as value", [JSON.stringify(prepared.value), plan]))
			.rows[0].value;
		if ((await storeObject(tree.object)).failure) return;
		const verifiedTree = await call(
			"write-tree",
			"qorpera_verify_company_path_tree",
			[["select public.qorpera_verify_company_path_tree($1::uuid, $2) as value", [COMPANY, tree.manifest]]],
			PATH_DEADLINE,
		);
		if (verifiedTree.failure) return;
		const committed = await call(
			"write-commit",
			"qorpera_commit_company_path_mutation",
			[
				[
					"select public.qorpera_commit_company_path_mutation($1::uuid, $2::jsonb, $3::jsonb, $4::uuid, $5) as value",
					[ENVIRONMENT, binding, plan, prepared.value.snapshotId, verifiedTree.value],
				],
			],
			PATH_DEADLINE,
		);
		if (committed.failure?.name !== "head-conflict") return;
	}
}

async function agent(binding, index, writes) {
	for (let round = 1; running(); round += 1) {
		await beforeModelRequest(binding);
		await call(
			"list",
			"qorpera_list_company_paths_v2",
			[["select public.qorpera_list_company_paths_v2($1::uuid, '', null, null, 10, $2::jsonb) as value", [ENVIRONMENT, binding]]],
			PATH_DEADLINE,
		);
		if (round % 3 === 0) {
			const receipt = randomUUID();
			const input = randomBytes(32).toString("hex");
			const begun = await call(
				"receipt-begin",
				"qorpera_begin_native_tool_operation",
				[
					[
						"select public.qorpera_begin_native_tool_operation($1::jsonb, $2::uuid, $3, $4, $5, false) as value",
						[binding, receipt, `load:${index}:${round}`, input, randomBytes(32).toString("hex")],
					],
				],
				TOOL_DEADLINE,
			);
			// A run holds one unresolved operation at most: the runtime completes it before its next.
			for (let attempt = 0; !begun.failure && attempt < 5; attempt += 1) {
				const completed = await call(
					"receipt-complete",
					"qorpera_complete_native_tool_operation",
					[["select public.qorpera_complete_native_tool_operation($1::jsonb, $2::uuid, $3, '{}'::jsonb) as value", [binding, receipt, input]]],
					TOOL_DEADLINE,
				);
				if (!completed.failure) break;
			}
		}
		if (writes && round % 2 === 0) await writeFile(binding, index, round);
		await beforeModelRequest(binding);
		await sleep(Math.random() * 20);
	}
}

/** Object GC as the worker runs it: claim (the fence, then a lease), delete from Storage, complete. */
async function gc() {
	while (running()) {
		const sha = randomBytes(32).toString("hex");
		const prepared = await call("gc-object", "loadpool_gc_object", [["select loadpool.gc_object($1) as value", [sha]]], 30_000);
		if (prepared.failure) continue;
		const lease = randomUUID();
		const claimed = await call(
			"gc-claim",
			"qorpera_claim_company_object_gc",
			[["select public.qorpera_claim_company_object_gc(1, $1::uuid) as value", [lease]]],
			30_000,
		);
		const objects = claimed.value?.objects ?? [];
		if (objects.length) {
			const shas = objects.map((object) => object.sha256);
			await call(
				"gc-delete",
				"storage_objects_delete",
				[["delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name = any($1::text[])", [shas.map((value) => `${COMPANY}/${value}`)]]],
				30_000,
			);
			await call(
				"gc-complete",
				"qorpera_complete_company_object_gc",
				[["select public.qorpera_complete_company_object_gc($1::uuid, $2::uuid, $3::text[]) as value", [COMPANY, lease, shas]]],
				30_000,
			);
		}
		await sleep(1000);
	}
}

/** A write elsewhere that points at the company: it inserts a row with a foreign key to the profile row (a KEY
 * SHARE lock on it) and works 10 ms more before it ends; rolled back so the table stays small. */
async function foreignKeyInsert() {
	while (running()) {
		await call(
			"fk-insert",
			"qorpera_member_notification",
			[
				[
					"insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key) values ($1::uuid, $2::uuid, 'provider_usage_limit', '{}', $3)",
					[COMPANY, OWNER, randomUUID()],
				],
				["select pg_sleep(0.01)", []],
			],
			5000,
			{ rollback: true },
		);
		await sleep(Math.random() * 20);
	}
}

/** Each deadlock the server logged: which call waited for which (its DETAIL, with each process's query) and
 * the row the cancelled one was waiting for (its CONTEXT), counted. */
function deadlockCycles() {
	const log = spawnSync("docker", ["logs", containerName], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
	const lines = `${log.stdout}${log.stderr}`.split("\n");
	const call = (query) =>
		/public\.(qorpera_[a-z0-9_]+)\s*\(/.exec(query)?.[1] ??
		/(loadpool\.[a-z_]+)\s*\(/.exec(query)?.[1] ??
		/^(insert into \S+|delete from \S+)/.exec(query.trim())?.[1] ??
		query.trim().slice(0, 40);
	const counts = new Map();
	for (let index = 0; index < lines.length; index += 1) {
		if (!lines[index].includes("ERROR:  deadlock detected")) continue;
		const names = new Map();
		const waits = [];
		let waited = "";
		for (let next = index + 1; next < lines.length && next < index + 60; next += 1) {
			const line = lines[next];
			if (line.includes("ERROR:  ")) break;
			const process = /Process (\d+): (.*)$/.exec(line);
			if (process) names.set(process[1], call(process[2]));
			const wait = /Process (\d+) waits for (\S+) on (transaction|tuple|relation)[^;]*; blocked by process (\d+)/.exec(line);
			if (wait) waits.push(wait);
			const context = /while ([a-z ]+) tuple \(\d+,\d+\) (?:in|of) (?:relation|index) "([^"]+)"/.exec(line);
			if (context && !waited) waited = `${context[1]} ${context[2]}`;
		}
		const cycle = waits
			.map(([, waiter, mode, object, holder]) => `${names.get(waiter)} waits (${mode} on a ${object}) for ${names.get(holder)}`)
			.sort()
			.join("; ");
		const key = `${cycle}${waited ? ` [the cancelled call was ${waited}]` : ""}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function report(seconds) {
	const pad = (value, width) => String(value).padStart(width);
	const lines = [
		`${"kind".padEnd(17)}${pad("calls", 7)}${pad("ok/s", 7)}${pad("p50", 7)}${pad("p95", 7)}${pad("max", 7)}${pad("queue95", 8)}${pad("gave-up", 8)}  failures`,
	];
	const summary = {};
	const all = [];
	for (const [kind, samples] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		all.push(...samples);
		const ok = samples.filter((sample) => !sample.failure).length;
		const failures = Object.fromEntries(
			CLASSES.map((name) => [name, samples.filter((sample) => sample.failure?.name === name).length]).filter(([, count]) => count),
		);
		const totals = samples.map((sample) => sample.totalMs);
		summary[kind] = {
			calls: samples.length,
			okPerSecond: Number((ok / seconds).toFixed(1)),
			p50: Math.round(percentile(totals, 0.5)),
			p95: Math.round(percentile(totals, 0.95)),
			max: Math.round(Math.max(...totals)),
			queueP95: Math.round(percentile(samples.map((sample) => sample.queueMs), 0.95)),
			gaveUp: samples.filter((sample) => sample.gaveUp).length,
			failures,
		};
		const row = summary[kind];
		lines.push(
			`${kind.padEnd(17)}${pad(row.calls, 7)}${pad(row.okPerSecond, 7)}${pad(row.p50, 7)}${pad(row.p95, 7)}${pad(row.max, 7)}${pad(row.queueP95, 8)}${pad(row.gaveUp, 8)}  ${Object.entries(failures)
				.map(([name, count]) => `${name} ${count}`)
				.join(", ")}`,
		);
	}
	const totals = all.map((sample) => sample.totalMs);
	lines.push(
		`${"all".padEnd(17)}${pad(all.length, 7)}${pad((all.filter((sample) => !sample.failure).length / seconds).toFixed(1), 7)}${pad(Math.round(percentile(totals, 0.5)), 7)}${pad(Math.round(percentile(totals, 0.95)), 7)}${pad(Math.round(Math.max(...totals)), 7)}`,
	);
	const details = new Map();
	for (const [kind, samples] of stats)
		for (const sample of samples)
			if (sample.failure) {
				const key = `${kind}: ${sample.failure.name}: ${sample.failure.detail}`;
				details.set(key, (details.get(key) ?? 0) + 1);
			}
	for (const [key, count] of [...details.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) lines.push(`  ${count} x ${key}`);
	const cycles = deadlockCycles();
	if (cycles.length) lines.push("deadlocks from the server log (who waited for whom, and the row the cancelled call waited for):");
	for (const [key, count] of cycles.slice(0, 12)) lines.push(`  ${count} x ${key}`);
	return { lines, summary, all };
}

try {
	run("docker", ["info", "--format", "{{.ServerVersion}}"]);
	run("docker", [
		"run",
		"--detach",
		"--rm",
		"--name",
		containerName,
		"--publish",
		"127.0.0.1::5432",
		"--env",
		`POSTGRES_PASSWORD=${password}`,
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
	for (const name of options.skipped) if (!migrations.includes(name)) throw new Error(`No migration ${name} to skip`);
	for (const migration of migrations.filter((name) => !options.skipped.has(name)))
		psql(readFileSync(join(repositoryRoot, "supabase", "migrations", migration), "utf-8"));
	const testsRoot = join(repositoryRoot, "supabase", "tests");
	const fixture = expandTestFixture("load-company-fence-pool.sql", (name) =>
		name === "load-company-fence-pool.sql"
			? '-- @fixture 602_runtime_coding_lock_order.test.sql until "-- 1. The owner answers"\n'
			: readFileSync(join(testsRoot, name), "utf-8"),
	);
	psql(
		`select set_config('loadpool.agents', '${options.agents}', false);\n${fixture}${readFileSync(join(repositoryRoot, "scripts", "load-company-fence-pool.sql"), "utf-8")}`,
	);
	const bindings = JSON.parse(psql("select coalesce(json_agg(binding order by n), '[]') from loadpool.agents;"));
	if (bindings.length !== options.agents) throw new Error(`The fixture started ${bindings.length} of ${options.agents} agents`);
	const port = /:(\d+)\s*$/.exec(run("docker", ["port", containerName, "5432/tcp"]).trim().split("\n")[0])?.[1];
	if (!port) throw new Error("The disposable PostgreSQL has no published port");

	pool = new pg.Pool({ host: "127.0.0.1", port: Number(port), user: "postgres", password, database, max: options.pool });
	// PostgREST's role settings, as the live `authenticator` has them (20260913000100).
	pool.on("connect", (client) => {
		client.query("set statement_timeout = '8s'; set lock_timeout = '8s'").catch(() => undefined);
	});
	end = performance.now() + options.seconds * 1000;
	const started = performance.now();
	await Promise.all([
		...bindings.map((binding, index) => agent(JSON.stringify(binding), index + 1, index < options.writers)),
		gc(),
		foreignKeyInsert(),
		foreignKeyInsert(),
	]);
	const seconds = (performance.now() - started) / 1000;
	const { lines, summary, all } = report(seconds);
	process.stdout.write(
		`Load ${seconds.toFixed(0)} s on one company: ${options.agents} agents (${options.writers} writing), GC, 2 foreign-key writers; pool ${options.pool}, round trip ${options.rtt} ms, statement_timeout 8s, lock_timeout 8s${options.skipped.size ? `; without ${[...options.skipped].join(", ")}` : ""}\n`,
	);
	process.stdout.write(`${lines.join("\n")}\n`);
	process.stdout.write(`== load-company-fence-pool ${JSON.stringify({ skipped: [...options.skipped], seconds: Number(seconds.toFixed(1)), options: { agents: options.agents, writers: options.writers, pool: options.pool, rtt: options.rtt }, summary })}\n`);
	const unexpected = all.filter((sample) => sample.failure && UNEXPECTED.has(sample.failure.name)).length;
	if (options.check && unexpected > 0) {
		process.stdout.write(`Check failed: ${unexpected} calls deadlocked, ran into the statement timeout or failed unexpectedly\n`);
		process.exitCode = 1;
	}
} finally {
	await pool?.end();
	spawnSync("docker", ["rm", "--force", containerName]);
}
