import assert from "node:assert/strict";
import test from "node:test";
import {
	buildContainerName,
	expandTestFixture,
	POSTGRES_IMAGE,
	sortMigrationNames,
} from "./test-hosted-db.mjs";
import {
	bestSnapshot,
	CLUSTER_ENV,
	HostedDbCluster,
	newestBundleActivation,
	plannedMigrations,
	sessionPerFile,
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
