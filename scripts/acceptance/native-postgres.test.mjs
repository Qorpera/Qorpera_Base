import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertNativePostgresVersion,
	nativePostgresArguments,
	nativePostgresEnvironment,
	nativePostgresOptions,
	parseNativePostgresCli,
	startNativePostgres,
} from "./native-postgres.mjs";

const binDirectory = "/usr/lib/postgresql/17/bin";

test("acceptance options cannot target an existing cluster, remote server or SQL database", () => {
	assert.deepEqual(nativePostgresOptions({ binDirectory }), { binDirectory, tempParent: "/tmp", onProgress: undefined });
	for (const key of ["dataDirectory", "database", "host", "port", "root", "connectionString", "command"]) {
		assert.throws(() => nativePostgresOptions({ binDirectory, [key]: "/existing" }), /Unknown PostgreSQL option/);
	}
});

test("unsafe, ambiguous and overlong socket roots are refused before any process or filesystem mutation", async () => {
	for (const path of [undefined, "relative", "/", "/tmp/../var", "/tmp/", "/tmp/a b", "/tmp/a\n", "/tmp/a\\b", "/tmp/a'b"]) {
		assert.throws(() => nativePostgresOptions({ binDirectory: path }), /Canonical absolute/);
		if (path !== undefined) assert.throws(() => nativePostgresOptions({ binDirectory, tempParent: path }), /Canonical absolute/);
	}
	assert.throws(() => nativePostgresOptions({ binDirectory, tempParent: `/tmp/${"a".repeat(80)}` }), /socket path too long/);
	await assert.rejects(startNativePostgres({ binDirectory, dataDirectory: "/unrelated/production" }), /Unknown PostgreSQL option/);
});

test("the helper requires PostgreSQL17 production binaries, not a neighboring major or development build", () => {
	for (const version of ["postgres (PostgreSQL) 17.6", "initdb (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)\n", "psql (PostgreSQL) 17.9"]) assertNativePostgresVersion(version);
	for (const version of ["postgres (PostgreSQL) 16.6", "postgres (PostgreSQL) 18.0", "postgres (PostgreSQL) 17beta1", "postgres (PostgreSQL) 17.6evil", "17.6", "postgres (PostgreSQL) 17.6\nignored", undefined]) {
		assert.throws(() => assertNativePostgresVersion(version), /PostgreSQL 17/);
	}
});

test("postgres is explicitly socket-only and retains crash durability", () => {
	const args = nativePostgresArguments("/tmp/owned/data", "/tmp/owned/socket");
	assert.deepEqual(args.slice(0, 6), ["-D", "/tmp/owned/data", "-k", "/tmp/owned/socket", "-p", "5432"]);
	const settings = args.filter((_, i) => args[i - 1] === "-c");
	assert(settings.includes("listen_addresses="));
	assert(settings.includes("unix_socket_permissions=0700"));
	assert(settings.includes("log_min_error_statement=panic"));
	assert(!args.includes("-F"));
	assert(!settings.some((value) => /^(fsync|synchronous_commit|full_page_writes)=off$/.test(value)));
});

test("ambient PG or dynamic loader settings cannot redirect the database or inject startup code", () => {
	const environment = nativePostgresEnvironment("/tmp/owned", binDirectory);
	assert.deepEqual(Object.keys(environment).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "TZ"]);
	assert.equal(environment.HOME, "/tmp/owned");
	assert.equal(environment.PATH, `${binDirectory}:/usr/bin:/bin`);
	assert.equal(environment.PGHOST, undefined);
	assert.equal(environment.PGSERVICE, undefined);
	assert.equal(environment.PGOPTIONS, undefined);
	assert.equal(environment.LD_PRELOAD, undefined);
});

test("CLI refuses arbitrary modes without trying to start PostgreSQL", () => {
	const script = join(dirname(fileURLToPath(import.meta.url)), "native-postgres.mjs");
	const result = spawnSync(process.execPath, [script, "--data", "/unrelated", "--serve"], { encoding: "utf8", timeout: 10000 });
	assert.equal(result.error, undefined);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unknown native PostgreSQL CLI argument/);
	assert.equal(result.stdout, "");
});

test("one-shot CLI accepts exact SQL test names and refuses traversal, duplicate evidence and mixed serving", () => {
	assert.deepEqual(parseNativePostgresCli(["--bin", binDirectory, "--test", "648_office_outage_recovery.test.sql", "--out", "/tmp/native-evidence"]), {
		binDirectory, tests: ["648_office_outage_recovery.test.sql"], out: "/tmp/native-evidence", serve: false,
	});
	assert.equal(parseNativePostgresCli(["--bin", binDirectory, "--serve"]).serve, true);
	for (const args of [
		["--test", "../bootstrap.sql", "--out", "/tmp/out"],
		["--test", "648_test.test.sql", "--test", "648_test.test.sql", "--out", "/tmp/out"],
		["--serve", "--test", "648_test.test.sql", "--out", "/tmp/out"],
		["--serve", "--out", "/tmp/out"],
		["--test", "648_test.test.sql", "--out", "/"],
		["--test", "648_test.test.sql"],
		["--serve", "--bin", binDirectory],
	]) assert.throws(() => parseNativePostgresCli(["--bin", binDirectory, ...args]));
});
