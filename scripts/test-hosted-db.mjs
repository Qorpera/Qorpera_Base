import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HostedDbCluster, migrationNames, newestBundleActivation, sessionPerFile } from "./test-hosted-db-cluster.mjs";

export const POSTGRES_IMAGE =
	"docker.io/library/postgres:17.6-alpine3.22@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_test";

export function sortMigrationNames(names) {
	const migrations = names.filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
	const versions = new Set();
	for (const migration of migrations) {
		const version = migration.slice(0, 14);
		if (versions.has(version)) {
			throw new Error(`Duplicate migration version ${version}`);
		}
		versions.add(version);
	}
	return migrations;
}

/** A test may begin with `-- @fixture <file> until "<marker>"` to run after another test's
 * fixture section instead of copying it. The marker line itself is not included. The other
 * test may itself run after a third one; a cycle is refused. */
export function expandTestFixture(name, read, chain = []) {
	const source = read(name);
	const directive = /^-- @fixture ([0-9a-z_.-]+\.test\.sql) until "([^"\n]+)"\n/.exec(source);
	if (!directive) return source;
	const [line, fixtureName, marker] = directive;
	if (fixtureName === name || chain.includes(fixtureName)) throw new Error(`Test fixture is unavailable: ${fixtureName}`);
	const fixture = expandTestFixture(fixtureName, read, [...chain, name]);
	const end = fixture.indexOf(marker);
	if (end < 0) throw new Error(`Test fixture is unavailable: ${fixtureName}`);
	return fixture.slice(0, end) + source.slice(line.length);
}

export function buildContainerName(pid, suffix) {
	if (!/^\d+$/.test(String(pid)) || !/^[0-9a-f]{8}$/.test(suffix)) {
		throw new Error("Invalid hosted database container identity");
	}
	return `qorpera-hosted-db-${pid}-${suffix}`;
}

/** The PostgreSQL scripts the hosted-db step runs after the SQL tests (`--scripts`), each against its own
 * database in this run's container. */
export const HOSTED_DB_SCRIPTS = [
	"scripts/test-runtime-bundle-activation.mjs",
	"scripts/test-email-draft-e2e.mjs",
	"scripts/test-runtime-node-capacity.mjs",
	"scripts/test-runtime-office-delete-disposition.mjs",
	"scripts/test-runtime-office-current-provider-activation.mjs",
	"scripts/test-coding-turn-backfill.mjs",
	"scripts/test-runtime-room-history.mjs",
];

/** Where those scripts start in the migration chain; the one replay leaves a copy at each. A point missing
 * here costs time only: the script copies the nearest earlier snapshot and replays the gap. */
function scriptStartPoints(names) {
	return [
		"20260913000400_runtime_room_history.sql", // test-runtime-room-history
		"20260925113000_runtime_coding_turn_continuity.sql", // test-coding-turn-backfill
		"20260926034000_runtime_bundle_activation_v128.sql", // test-runtime-bundle-activation
		newestBundleActivation(names), // test-runtime-office-delete-disposition holds it back
	].filter((name) => names.includes(name));
}

const seconds = (since) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

/** Runs the SQL tests in order, each in a fresh session of one psql process, on `database`. Stops at the
 * first failure, as one psql run per test did. */
function runSqlTests(cluster, database, tests) {
	const testsRoot = join(repositoryRoot, "supabase", "tests");
	const files = cluster.copyIn(
		Object.fromEntries(tests.map((test) => [test, expandTestFixture(test, (name) => readFileSync(join(testsRoot, name), "utf-8"))])),
	);
	cluster.script(database, tests.map((test) => `\\echo Running ${test}\n${sessionPerFile(database, [files[test]])}`).join(""), {
		progress: true,
	});
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--scripts")) throw new Error("Usage: node scripts/test-hosted-db.mjs [--scripts]");
	const withScripts = args.includes("--scripts");
	const testsRoot = join(repositoryRoot, "supabase", "tests");
	const tests = readdirSync(testsRoot)
		.filter((name) => name.endsWith(".test.sql"))
		.sort();
	if (tests.length === 0) {
		throw new Error("No hosted database regression tests were found");
	}
	const started = performance.now();
	const cluster = await HostedDbCluster.start();
	const failed = [];
	try {
		process.stdout.write(`Started ${cluster.container} in ${seconds(started)}\n`);
		const building = performance.now();
		const names = migrationNames();
		const migrations = cluster.build({ snapshotBefore: withScripts ? scriptStartPoints(names) : [] });
		process.stdout.write(`Applied the test bootstrap and ${migrations} migrations in ${seconds(building)}\n`);

		const testing = performance.now();
		cluster.create(databaseName);
		try {
			runSqlTests(cluster, databaseName, tests);
			process.stdout.write(`Hosted database checks passed (${migrations} migrations, ${tests.length} tests) in ${seconds(testing)}\n`);
		} catch (error) {
			process.stdout.write(`${error.message}\n`);
			failed.push("SQL tests");
		}
		cluster.drop(databaseName);

		if (withScripts)
			for (const script of HOSTED_DB_SCRIPTS) {
				const scriptStarted = performance.now();
				process.stdout.write(`== hosted-db: ${script}\n`);
				const result = spawnSync(process.execPath, [script], {
					cwd: repositoryRoot,
					stdio: "inherit",
					env: { ...process.env, ...cluster.environment() },
				});
				const passed = result.status === 0;
				if (!passed) failed.push(script);
				process.stdout.write(`== hosted-db: ${script} ${passed ? "passed" : `FAILED (exit ${result.status ?? result.signal})`} in ${seconds(scriptStarted)}\n`);
			}
	} finally {
		cluster.stop();
	}
	process.stdout.write(`== hosted-db: ${failed.length ? `failed: ${failed.join(", ")}` : "all passed"} in ${seconds(started)}\n`);
	if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
