import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReleaseManifest } from "./release-engine/manifest.mjs";
import { evaluateAnchorResults, evaluatePostChecks } from "./release-engine/sql-checks.mjs";
import { sqlOnlyPackets } from "./release-engine/sql-only-packets.mjs";
import { classifyReleaseDiff } from "./release-prep-plan.mjs";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

const database = "sql_only_packets";
let hosted = null;
let psqlArgs = [];

function runPsql(input) {
	return spawnSync("docker", psqlArgs, {
		input,
		encoding: "utf8",
		timeout: 180_000,
		maxBuffer: 64 * 1024 * 1024,
	});
}

function sql(text) {
	const result = runPsql(text);
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout?.slice(-2000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}

function fails(text) {
	const result = runPsql(text);
	assert.notEqual(result.status, 0, `expected refusal:\n${result.stdout}`);
	return result.stderr;
}

function dryRun(text) {
	return sql(text.replace(/commit;\n$/, "rollback;\n"));
}

function lastJsonLine(output) {
	const line = output
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith("{") || entry.startsWith("["))
		.at(-1);
	assert(line, `expected JSON output line, got:\n${output}`);
	return JSON.parse(line);
}

try {
	hosted = await hostedDatabase(database);
	psqlArgs = hosted.cluster.psqlArgs(database, ["-qAt"]);
	sql(
		"create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text);",
	);
	sql(
		`create or replace function public.qorpera_sql_only_fixture_fn() returns text language sql set search_path = '' as $$ select 'v1'::text $$;`,
	);

	const [activeVersionRaw, activeSha] = sql(
		"select b.version || ' ' || b.sha256 from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;",
	).split(" ");
	const activeVersion = Number(activeVersionRaw);

	const mig1File = "supabase/migrations/20260930999910_sql_only_fixture_one.sql";
	const mig2File = "supabase/migrations/20260930999920_sql_only_fixture_two.sql";
	const manifest = createReleaseManifest({
		previousVersion: activeVersion,
		previousBundleSha256: activeSha,
		baseCommit: "a".repeat(40),
		previousNodeReleaseRevision: 157,
		classification: classifyReleaseDiff([mig1File, mig2File]),
		thinRuntimeEnabled: true,
	});
	manifest.migrations[0].anchors = [
		{
			functionSignature: "public.qorpera_sql_only_fixture_fn()",
			snippet: `SET search_path TO ''`,
			expectedCount: 1,
		},
		{
			functionSignature: "public.qorpera_sql_only_fixture_fn()",
			snippet: `'v1'`,
			expectedCount: 1,
		},
	];
	manifest.migrations[1].postChecks = [
		{
			name: "fnValue",
			sql: "select public.qorpera_sql_only_fixture_fn()",
			expected: "v2",
		},
		{
			name: "configObject",
			sql: `select '{"enabled":true,"mode":"sql-only"}'::jsonb`,
			expected: { mode: "sql-only", enabled: true },
		},
	];

	const migrationsByFile = {
		[mig1File]: [
			"begin;",
			"set local lock_timeout = '10s';",
			"create function pg_temp.rehearsal_helper() returns int language sql as $$ select 1 $$;",
			"select pg_temp.rehearsal_helper();",
			`create or replace function public.qorpera_sql_only_fixture_fn() returns text language sql set search_path = '' as $$ select 'v1b'::text $$;`,
			"commit;",
		].join("\n"),
		[mig2File]: [
			"do $$ begin if current_setting('lock_timeout') <> '5s' then raise exception 'lock_timeout carried over: %', current_setting('lock_timeout'); end if; end $$;",
			"create function pg_temp.rehearsal_helper() returns int language sql as $$ select 2 $$;",
			"select pg_temp.rehearsal_helper();",
			`create or replace function public.qorpera_sql_only_fixture_fn() returns text language sql set search_path = '' as $$ select 'v2'::text $$;`,
		].join("\n"),
	};

	const packets = sqlOnlyPackets(manifest, migrationsByFile);

	const checkRows = lastJsonLine(dryRun(packets["00-check.sql"]));
	const anchorEval = evaluateAnchorResults(manifest.migrations[0].anchors, checkRows);
	assert.equal(anchorEval.ok, true, JSON.stringify(anchorEval));

	const rehearsal = lastJsonLine(dryRun(packets["05-rehearse-migrations.sql"]));
	assert.deepEqual(rehearsal, {
		rehearsed: ["20260930999910_sql_only_fixture_one.sql", "20260930999920_sql_only_fixture_two.sql"],
		ok: true,
	});
	assert.equal(sql("select public.qorpera_sql_only_fixture_fn();"), "v1");
	assert.equal(
		sql("select count(*) from supabase_migrations.schema_migrations where version in ('20260930999910','20260930999920');"),
		"0",
	);

	const outOfOrderErr = fails(packets["10-migration-20260930999920_sql_only_fixture_two.sql"]);
	assert.match(outOfOrderErr, /is not recorded yet/);

	const applied1 = lastJsonLine(sql(packets["10-migration-20260930999910_sql_only_fixture_one.sql"]));
	assert.deepEqual(applied1, { migration: "20260930999910_sql_only_fixture_one.sql", recorded: true });

	const replayErr = fails(packets["10-migration-20260930999910_sql_only_fixture_one.sql"]);
	assert.match(replayErr, /is already recorded/);

	const applied2 = lastJsonLine(sql(packets["10-migration-20260930999920_sql_only_fixture_two.sql"]));
	assert.deepEqual(applied2, { migration: "20260930999920_sql_only_fixture_two.sql", recorded: true });

	const storedBody1 = sql("select statements[1] from supabase_migrations.schema_migrations where version = '20260930999910';");
	assert.doesNotMatch(storedBody1, /^\s*begin;/i);
	assert.doesNotMatch(storedBody1, /commit;\s*$/i);

	const postRow = lastJsonLine(dryRun(packets["20-post-check.sql"]));
	const postEval = evaluatePostChecks(manifest.migrations[1].postChecks, postRow);
	assert.equal(postEval.ok, true, JSON.stringify(postEval));

	console.log(JSON.stringify({ schema: "qorpera.sql-only-packets-rehearsal/v1", activeVersion, passed: true }));
} finally {
	hosted?.close();
}
