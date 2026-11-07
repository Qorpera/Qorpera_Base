import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildContainerName,
	expandTestFixture,
	checkLocale,
	LOCALE_QUERY,
	POSTGRES_IMAGE,
	POSTGRES_LOCALE,
	parseArguments,
	SQL_TEST_DATABASES,
	selectTests,
	sortMigrationNames,
	splitTests,
	startInTurn,
} from "./test-hosted-db.mjs";
import {
	bestSnapshot,
	CLUSTER_ENV,
	HostedDbCluster,
	MIGRATED,
	newestBundleActivation,
	plannedMigrations,
	sessionPerFile,
	snapshotPlan,
	WARM_START,
	warmChain,
	warmCopy,
	warmDatabasesToDrop,
	warmVolumeName,
	warmVolumesToRemove,
} from "./test-hosted-db-cluster.mjs";

test("sorts hosted migrations and rejects duplicate versions", () => {
	assert.deepEqual(
		sortMigrationNames([
			"README.md",
			"20260817001000_second.sql",
			"20260816001000_first.sql",
		]),
		["20260816001000_first.sql", "20260817001000_second.sql"],
	);
	assert.throws(
		() => sortMigrationNames(["20260816001000_first.sql", "20260816001000_second.sql"]),
		/Duplicate migration version 20260816001000/,
	);
});

test("uses an exact temporary container identity and digest-pinned image", () => {
	assert.equal(buildContainerName(42, "0123abcd"), "qorpera-hosted-db-42-0123abcd");
	assert.match(POSTGRES_IMAGE, /^docker\.io\/library\/postgres:[^@]+@sha256:[0-9a-f]{64}$/);
	// Not on musl: PostgreSQL there takes about twice the CPU for the same migrations.
	assert.doesNotMatch(POSTGRES_IMAGE, /alpine/);
});

test("a rebuilt test machine pulls the image the tests use, and every PostgreSQL they start has production's locale", () => {
	const scripts = dirname(fileURLToPath(import.meta.url));
	assert.ok(readFileSync(join(scripts, "..", "deploy", "test-machine", "guest-setup.sh"), "utf8").includes(`PG_IMAGE='${POSTGRES_IMAGE}'`));
	assert.deepEqual(POSTGRES_LOCALE, ["--env", "POSTGRES_INITDB_ARGS=--locale-provider=icu --encoding=UTF-8 --icu-locale=en_US.UTF-8"]);
	const starters = readdirSync(scripts).filter(
		(name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "test-hosted-db.mjs" && /\bPOSTGRES_IMAGE\b/.test(readFileSync(join(scripts, name), "utf8")),
	);
	assert.ok(starters.includes("test-hosted-db-cluster.mjs") && starters.includes("load-folder-core.mjs"));
	for (const name of starters) {
		const source = readFileSync(join(scripts, name), "utf8");
		assert.match(source, /\.\.\.POSTGRES_LOCALE\b/, name);
		// And each refuses its cluster when the locale is not production's, before it applies anything.
		assert.match(source, /checkLocale\(.*LOCALE_QUERY/, name);
	}
	// A cluster on anything else stops the run before a test sees it.
	checkLocale("i|en-US\n");
	for (const line of ["c|", "i|en-GB", "b|C.UTF-8", ""]) assert.throws(() => checkLocale(line), /not on ICU en-US/);
	assert.throws(() => buildContainerName(42, "../escape"), /Invalid hosted database container identity/);
});

test("a test can run after another test's fixture section", () => {
	const files = {
		"300_base.test.sql": "begin;\nselect 1;\n-- END FIXTURE\nselect 2;\nrollback;\n",
		"370_next.test.sql": '-- @fixture 300_base.test.sql until "-- END FIXTURE"\nselect 3;\nrollback;\n',
		"380_self.test.sql": '-- @fixture 380_self.test.sql until "x"\n',
		"390_missing.test.sql": '-- @fixture 300_base.test.sql until "-- ABSENT"\n',
		"395_chained.test.sql": '-- @fixture 370_next.test.sql until "rollback;"\nselect 4;\nrollback;\n',
		"396_cycle_a.test.sql": '-- @fixture 397_cycle_b.test.sql until "x"\nx\n',
		"397_cycle_b.test.sql": '-- @fixture 396_cycle_a.test.sql until "x"\nx\n',
	};
	const read = (name) => files[name];
	assert.equal(expandTestFixture("300_base.test.sql", read), files["300_base.test.sql"]);
	assert.equal(expandTestFixture("370_next.test.sql", read), "begin;\nselect 1;\nselect 3;\nrollback;\n");
	assert.throws(() => expandTestFixture("380_self.test.sql", read), /fixture is unavailable/);
	assert.throws(() => expandTestFixture("390_missing.test.sql", read), /fixture is unavailable/);
	assert.equal(expandTestFixture("395_chained.test.sql", read), "begin;\nselect 1;\nselect 3;\nselect 4;\nrollback;\n");
	assert.throws(() => expandTestFixture("396_cycle_a.test.sql", read), /fixture is unavailable/);
});

test("one psql process opens a fresh session for every file", () => {
	assert.equal(
		sessionPerFile("qorpera_test", ["/qorpera/bootstrap.sql", "/qorpera/migrations/20260816001000_first.sql"]),
		"\\connect qorpera_test\n\\i /qorpera/bootstrap.sql\n\\connect qorpera_test\n\\i /qorpera/migrations/20260816001000_first.sql\n",
	);
	assert.match(sessionPerFile("office", ["/qorpera/a.sql"], { echo: true }), /^\\echo Applying a\.sql\n\\connect office\n/);
	assert.throws(() => sessionPerFile("Office; drop", ["/qorpera/a.sql"]), /Invalid hosted database name/);
	assert.throws(() => sessionPerFile("office", ["/qorpera/a b.sql"]), /Unsafe SQL file path/);
});

test("a database copies the nearest snapshot and replays only the gap", () => {
	const names = ["1_a.sql", "2_b.sql", "3_activation_v7.sql", "4_c.sql", "5_d.sql"];
	assert.deepEqual(plannedMigrations(names), { wanted: names, prefix: 5 });
	assert.deepEqual(plannedMigrations(names, { before: "4_c.sql" }), { wanted: names.slice(0, 3), prefix: 3 });
	// Holding one back keeps the migrations after it; only the part before it can come from a copy.
	assert.deepEqual(plannedMigrations(names, { skip: ["3_activation_v7.sql"] }), {
		wanted: ["1_a.sql", "2_b.sql", "4_c.sql", "5_d.sql"],
		prefix: 2,
	});
	assert.throws(() => plannedMigrations(names, { before: "9_z.sql" }), /Unknown migration 9_z\.sql/);
	assert.throws(() => plannedMigrations(names, { skip: ["9_z.sql"] }), /Unknown migration 9_z\.sql/);
	const snapshots = [
		{ applied: 0, database: "qorpera_snapshot_0000" },
		{ applied: 2, database: "qorpera_snapshot_0002" },
		{ applied: 5, database: "qorpera_migrated" },
	];
	assert.equal(bestSnapshot(snapshots, 5).database, "qorpera_migrated");
	assert.equal(bestSnapshot(snapshots, 3).database, "qorpera_snapshot_0002");
	assert.equal(bestSnapshot(snapshots, 1).database, "qorpera_snapshot_0000");
	assert.equal(bestSnapshot([], 3), undefined);
});

test("a warm copy's link covers the image, the bootstrap, the build scripts and every migration before it", () => {
	const files = new Map();
	const read = (file) => {
		const name = file.split("/").at(-1);
		return Buffer.from(files.get(name) ?? `contents of ${name}`);
	};
	const names = ["1_a.sql", "2_b.sql", "3_c.sql"];
	const chain = warmChain(names, read);
	assert.equal(chain.length, 4);
	for (const link of chain) assert.match(link, /^[0-9a-f]{32}$/);
	assert.equal(new Set(chain).size, 4);
	assert.deepEqual(warmChain(names, read), chain);
	// A changed migration changes its link and every later one, not the ones before it.
	files.set("2_b.sql", "changed");
	const changed = warmChain(names, read);
	assert.deepEqual(changed.slice(0, 2), chain.slice(0, 2));
	assert.notEqual(changed[2], chain[2]);
	assert.notEqual(changed[3], chain[3]);
	files.delete("2_b.sql");
	// So does a renamed one with the same bytes, and a migration added in between.
	const renamed = warmChain(["1_a.sql", "2_x.sql", "3_c.sql"], (file) => read(file.replace("2_x.sql", "2_b.sql")));
	assert.deepEqual(renamed.slice(0, 2), chain.slice(0, 2));
	assert.notEqual(renamed[3], chain[3]);
	assert.notEqual(warmChain(["1_a.sql", "1_b.sql", "2_b.sql", "3_c.sql"], read)[3], chain[3]);
	// A list that goes on shares the links of its first migrations.
	assert.deepEqual(warmChain([...names, "4_d.sql"], read).slice(0, 4), chain);
	// A cluster with another bootstrap superuser has copies of its own.
	assert.notEqual(warmChain(names, read, "fixture_admin")[0], chain[0]);
	for (const builder of ["bootstrap.sql", "platform-function-defaults.sql", "test-hosted-db-cluster.mjs", "test-hosted-db.mjs"]) {
		files.set(builder, "changed");
		assert.notEqual(warmChain(names, read)[0], chain[0], builder);
		files.delete(builder);
	}
	assert.match(warmVolumeName(chain[3], 1760000000), new RegExp(`^qorpera-hosted-db-warm-${chain[3]}-1760000000-[0-9a-f]{4}$`));
});

test("a warm start copies its data into an empty directory only, so a restarted container keeps its own", () => {
	const temporary = mkdtempSync(join(tmpdir(), "qorpera-warm-start-"));
	try {
		const warm = join(temporary, "warm");
		const data = join(temporary, "data");
		mkdirSync(join(warm, "data"), { recursive: true });
		mkdirSync(data);
		writeFileSync(join(warm, "data", "PG_VERSION"), "17\n");
		writeFileSync(join(warm, "data", "row"), "from the copy\n");
		const start = () => {
			const script = WARM_START.replaceAll("/qorpera-warm", warm).replace("exec docker-entrypoint.sh postgres", "true");
			const result = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PGDATA: data } });
			assert.equal(result.status, 0, result.stderr);
		};
		start();
		assert.equal(readFileSync(join(data, "row"), "utf8"), "from the copy\n");
		writeFileSync(join(data, "row"), "written before the restart\n");
		start();
		assert.equal(readFileSync(join(data, "row"), "utf8"), "written before the restart\n");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a run starts from the complete warm copy of the most of its migrations, the newest of those, under six hours old", () => {
	const chain = ["a".repeat(32), "b".repeat(32), "c".repeat(32), "d".repeat(32)];
	const copy = (link, seconds, random = "0000") => `qorpera-hosted-db-warm-${link}-${seconds}-${random}`;
	const complete = (...names) => names.flatMap((name) => [name, `${name}-ready`]);
	const now = 1760000200;
	assert.equal(warmCopy([], chain, now), null);
	assert.deepEqual(warmCopy(complete(copy(chain[1], 1760000000), copy(chain[2], 1760000000)), chain, now), {
		applied: 2,
		volume: copy(chain[2], 1760000000),
	});
	// One without its -ready volume is still being written, or was left unfinished.
	assert.deepEqual(warmCopy([...complete(copy(chain[1], 1760000000)), copy(chain[3], 1760000100)], chain, now), {
		applied: 1,
		volume: copy(chain[1], 1760000000),
	});
	assert.deepEqual(warmCopy(complete(copy(chain[2], 1760000000, "ffff"), copy(chain[2], 1760000100)), chain, now), {
		applied: 2,
		volume: copy(chain[2], 1760000100),
	});
	// Another chain's copies (another branch's migrations, another image) and other volumes are not used.
	assert.equal(warmCopy([...complete(copy("e".repeat(32), 1760000000)), "qorpera-hosted-db-warm-x", "other"], chain, now), null);
	// A copy six hours old is not used: a younger one of fewer migrations is, or none.
	const old = complete(copy(chain[3], 1760000000));
	assert.deepEqual(warmCopy(old, chain, 1760000000 + 6 * 3600 - 1), { applied: 3, volume: copy(chain[3], 1760000000) });
	assert.equal(warmCopy(old, chain, 1760000000 + 6 * 3600), null);
	assert.deepEqual(warmCopy([...old, ...complete(copy(chain[1], 1760010000))], chain, 1760000000 + 6 * 3600), {
		applied: 1,
		volume: copy(chain[1], 1760010000),
	});
});

test("a machine keeps its newest complete warm copies for seven hours and removes unfinished ones after an hour", () => {
	const copy = (index, seconds) => `qorpera-hosted-db-warm-${String(index).padStart(32, "0")}-${seconds}-0000`;
	const complete = Array.from({ length: 12 }, (_, index) => copy(index, 1760000000 + index * 10));
	const volumes = [...complete.flatMap((name) => [name, `${name}-ready`]), copy(20, 1760000000), copy(21, 1760003500), "other"];
	assert.deepEqual(warmVolumesToRemove(volumes, 1760003700), [
		`${complete[0]}-ready`,
		complete[0],
		`${complete[1]}-ready`,
		complete[1],
		copy(20, 1760000000),
	]);
	assert.deepEqual(warmVolumesToRemove([`${copy(1, 1760000000)}-ready`], 1760000000), [`${copy(1, 1760000000)}-ready`]);
	// A complete copy stays an hour after it is too old to start from (six hours), then goes.
	const two = complete.slice(0, 2).flatMap((name) => [name, `${name}-ready`]);
	assert.deepEqual(warmVolumesToRemove(two, 1760000000 + 7 * 3600), []);
	assert.deepEqual(warmVolumesToRemove(two, 1760000001 + 7 * 3600), [`${complete[0]}-ready`, complete[0]]);
});

test("a warm copy goes on only from the databases a build leaves there", () => {
	const names = ["1_a.sql", "2_b.sql", "3_activation_v7.sql", "4_c.sql", "5_d.sql"];
	const snapshots = snapshotPlan(names, ["3_activation_v7.sql"]);
	assert.deepEqual(snapshots, [
		{ applied: 0, database: "qorpera_snapshot_0000" },
		{ applied: 2, database: "qorpera_snapshot_0002" },
		{ applied: 5, database: MIGRATED },
	]);
	assert.throws(() => snapshotPlan(names, ["9_z.sql"]), /Unknown migration 9_z\.sql/);
	assert.deepEqual(warmDatabasesToDrop(["qorpera_snapshot_0000", "qorpera_snapshot_0002", MIGRATED], snapshots, 5), []);
	assert.deepEqual(warmDatabasesToDrop(["qorpera_snapshot_0000", "qorpera_snapshot_0002", MIGRATED], snapshots, 4), []);
	// A copy of 2 migrations has no snapshot at 2 yet: the build takes it as it goes on.
	assert.deepEqual(warmDatabasesToDrop(["qorpera_snapshot_0000", MIGRATED], snapshots, 2), []);
	// A snapshot this build does not take (an older newest activation) is dropped.
	assert.deepEqual(warmDatabasesToDrop(["qorpera_snapshot_0000", "qorpera_snapshot_0001", MIGRATED], snapshots, 2), [
		"qorpera_snapshot_0001",
	]);
	// A fresh cluster (the copy could not be read), a missing snapshot or another database: a full replay.
	assert.equal(warmDatabasesToDrop([], snapshots, 5), null);
	assert.equal(warmDatabasesToDrop(["qorpera_snapshot_0000", MIGRATED], snapshots, 5), null);
	assert.equal(warmDatabasesToDrop(["qorpera_snapshot_0000", "qorpera_snapshot_0002", MIGRATED, "qorpera_test"], snapshots, 5), null);
});

test("the newest bundle activation is chosen by version, not by name", () => {
	assert.equal(
		newestBundleActivation([
			"20260926034000_runtime_bundle_activation_v128.sql",
			"20260927010000_runtime_bundle_activation_v99.sql",
			"20260928010000_other.sql",
		]),
		"20260926034000_runtime_bundle_activation_v128.sql",
	);
});

test("a script attaches only to a hosted-db container with valid snapshot names", () => {
	assert.equal(HostedDbCluster.attach({}), null);
	const cluster = HostedDbCluster.attach({
		[CLUSTER_ENV]: JSON.stringify({ container: "qorpera-hosted-db-42-0123abcd", snapshots: [{ applied: 3, database: "qorpera_migrated" }] }),
	});
	assert.equal(cluster.container, "qorpera-hosted-db-42-0123abcd");
	assert.deepEqual(cluster.psqlArgs("office", ["-qAt"]), [
		"exec",
		"-i",
		"qorpera-hosted-db-42-0123abcd",
		"psql",
		"-X",
		"-qAt",
		"-U",
		"postgres",
		"-d",
		"office",
		"-v",
		"ON_ERROR_STOP=1",
	]);
	const attach = (value) => () => HostedDbCluster.attach({ [CLUSTER_ENV]: JSON.stringify(value) });
	assert.throws(attach({ container: "production-db", snapshots: [] }), /Invalid hosted database container/);
	assert.throws(attach({ container: "qorpera-hosted-db-42-0123abcd", snapshots: [{ applied: 1, database: "x;y" }] }), /Invalid hosted database name/);
	assert.throws(attach({ container: "qorpera-hosted-db-42-0123abcd", snapshots: [{ applied: -1, database: "x" }] }), /Invalid hosted database snapshot/);
});

test("the shared-server scripts start one at a time, each after the one before it ends, failed or not", async () => {
	const directory = mkdtempSync(join(tmpdir(), "qorpera-hosted-db-in-turn-"));
	try {
		const log = join(directory, "log");
		const script = (name, code) => {
			const file = join(directory, `${name}.mjs`);
			writeFileSync(
				file,
				`import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "start ${name}\\n");
await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
console.log("${name} sees " + process.env.QORPERA_IN_TURN);
appendFileSync(${JSON.stringify(log)}, "end ${name}\\n");
process.exitCode = ${code};
`,
			);
			return file;
		};
		const scripts = [script("a", 0), script("b", 3), script("c", 0)];
		const started = startInTurn(scripts, { QORPERA_IN_TURN: "the cluster" });
		assert.deepEqual(started.map(([name]) => name), scripts);
		const results = await Promise.all(started.map(([, exited]) => exited));
		assert.deepEqual(
			results.map(({ code, output }) => [code, output]),
			[
				[0, "a sees the cluster\n"],
				[3, "b sees the cluster\n"],
				[0, "c sees the cluster\n"],
			],
		);
		assert.equal(readFileSync(log, "utf8"), "start a\nend a\nstart b\nend b\nstart c\nend c\n");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the shared-server scripts run in lanes at the same time, each lane one script at a time", async () => {
	const directory = mkdtempSync(join(tmpdir(), "qorpera-hosted-db-lanes-"));
	try {
		const log = join(directory, "log");
		// A script given `other` waits (up to 20 s) until `other` has started, so it sees that only if the two overlap.
		const script = (name, code, other) => {
			const file = join(directory, `${name}.mjs`);
			const started = `readFileSync(${JSON.stringify(log)}, "utf8").includes("start ${other}\\n")`;
			const wait = other
				? `const until = Date.now() + 20_000;
while (!${started} && Date.now() < until) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
console.log("${name} saw ${other} start: " + ${started});
`
				: "";
			writeFileSync(
				file,
				`import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "start ${name}\\n");
${wait}appendFileSync(${JSON.stringify(log)}, "end ${name}\\n");
process.exitCode = ${code};
`,
			);
			return file;
		};
		const [a, b, c, d] = [script("a", 0, "c"), script("b", 0), script("c", 3, "a"), script("d", 0)];
		const started = startInTurn([a, c, b, d], {}, (file) => ([c, d].includes(file) ? 1 : 0));
		assert.deepEqual(started.map(([name]) => name), [a, c, b, d]);
		const results = await Promise.all(started.map(([, exited]) => exited));
		assert.deepEqual(
			results.map(({ code, output }) => [code, output]),
			[
				[0, "a saw c start: true\n"],
				[3, "c saw a start: true\n"],
				[0, ""],
				[0, ""],
			],
		);
		// In each lane the next script starts only after the one before it ends, failed or not.
		const lines = readFileSync(log, "utf8").split("\n");
		assert.ok(lines.indexOf("end a") < lines.indexOf("start b"), lines.join(", "));
		assert.ok(lines.indexOf("end c") < lines.indexOf("start d"), lines.join(", "));
		assert.equal(lines.filter(Boolean).length, 8, lines.join(", "));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("--only keeps the named tests in order and refuses a value that matches none", () => {
	assert.deepEqual(parseArguments([]), { withScripts: false, only: null });
	assert.deepEqual(parseArguments(["--scripts", "--only", "811,818"]), { withScripts: true, only: ["811", "818"] });
	assert.deepEqual(parseArguments(["--only=811_folder_company_search"]), {
		withScripts: false,
		only: ["811_folder_company_search"],
	});
	for (const bad of [
		["--only"],
		["--only", ""],
		["--only", "--scripts"],
		["--only", "811", "--only", "818"],
		["--only", "../x"],
		["--quick"],
	])
		assert.throws(() => parseArguments(bad), /Usage/);
	const tests = ["001_a.test.sql", "811_search.test.sql", "818_race.test.sql", "8180_other.test.sql"];
	assert.equal(selectTests(tests, null), tests);
	assert.deepEqual(selectTests(tests, ["818_", "001"]), ["001_a.test.sql", "818_race.test.sql"]);
	assert.deepEqual(selectTests(tests, ["818"]), ["818_race.test.sql", "8180_other.test.sql"]);
	assert.throws(() => selectTests(tests, ["811", "999"]), /No hosted database test starts with: 999/);
});

test("the SQL tests split into contiguous runs, and --only keeps one run on qorpera_test", () => {
	const tests = [
		"000_schema_smoke.test.sql",
		"040_account_separation.test.sql",
		"200_deleted_profile_object_gc.test.sql",
		"508_last.test.sql",
		"509_first.test.sql",
		"5090_longer.test.sql",
		"671_last.test.sql",
		"672_first.test.sql",
		"825_last.test.sql",
		"826_first.test.sql",
		"892_last.test.sql",
		"893_first.test.sql",
		"999_end.test.sql",
	];
	const split = splitTests(tests, null);
	assert.deepEqual(split, [
		["qorpera_test", tests.slice(0, 4)],
		["qorpera_test_2", tests.slice(4, 7)],
		["qorpera_test_3", tests.slice(7, 9)],
		["qorpera_test_4", tests.slice(9, 11)],
		["qorpera_test_5", tests.slice(11)],
	]);
	// Every test runs once, in its usual order.
	assert.deepEqual(split.flatMap(([, part]) => part), tests);
	assert.deepEqual(splitTests(tests, ["8"]), [["qorpera_test", tests]]);
	assert.deepEqual(splitTests(tests.slice(0, 3), null), [["qorpera_test", tests.slice(0, 3)]]);
	assert.deepEqual(
		splitTests(tests, null, [
			["a", ""],
			["b", "1"],
			["c", "9"],
		]),
		[
			["a", tests.slice(0, 2)],
			["b", tests.slice(2, 12)],
			["c", tests.slice(12)],
		],
	);
	assert.equal(SQL_TEST_DATABASES[0][0], "qorpera_test");
	assert.equal(SQL_TEST_DATABASES[0][1], "");
	for (let i = 1; i < SQL_TEST_DATABASES.length; i++) assert.ok(SQL_TEST_DATABASES[i - 1][1] < SQL_TEST_DATABASES[i][1]);
});

test("the tests that keep rows for later tests stay in the first database", () => {
	const tests = readdirSync(join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "tests"))
		.filter((name) => name.endsWith(".test.sql"))
		.sort();
	const [[first, kept], ...rest] = splitTests(tests, null);
	assert.equal(first, "qorpera_test");
	assert.ok(rest.length >= 1);
	assert.deepEqual([kept, ...rest.map(([, part]) => part)].flat(), tests);
	// The tests that keep rows for a later one (000 first, 040 and its readers up to 200) are all 200 or below.
	for (const test of tests.filter((name) => name < "201")) assert.ok(kept.includes(test), test);
});
