import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** The PostgreSQL scripts the hosted-db step runs with the SQL tests (`--scripts`), each against its own
 * database: in this run's PostgreSQL after the SQL tests, or in one of its own (OWN_SERVER_SCRIPTS). */
export const HOSTED_DB_SCRIPTS = [
	"scripts/test-runtime-bundle-activation.mjs",
	"scripts/test-email-draft-e2e.mjs",
	"scripts/test-runtime-node-capacity.mjs",
	"scripts/test-runtime-office-delete-disposition.mjs",
	"scripts/test-runtime-office-current-provider-activation.mjs",
	"scripts/test-folder-service-core-shapes.mjs",
	"scripts/test-runtime-roll.mjs",
	"scripts/test-object-gateway-connection-files.mjs",
	"scripts/test-object-gateway-company-creation.mjs",
	"scripts/test-agent-exit-placement-undo.mjs",
	"scripts/test-folder-core-acceptance.mjs",
];

/** Scripts that keep a PostgreSQL of their own (they restart the server or alter the cluster-wide postgres
 * role). The suite starts them first and lets them run beside the SQL tests; a script missing here only
 * runs later, in turn. */
const OWN_SERVER_SCRIPTS = new Set([
	"scripts/test-runtime-node-capacity.mjs",
	"scripts/test-runtime-office-delete-disposition.mjs",
]);

/** Where those scripts start in the migration chain; the one replay leaves a copy at each. A point missing
 * here costs time only: the script copies the nearest earlier snapshot and replays the gap. */
function scriptStartPoints(names) {
	return [
		"20260926034000_runtime_bundle_activation_v128.sql", // test-runtime-bundle-activation
		newestBundleActivation(names), // test-runtime-office-delete-disposition holds it back
	].filter((name) => names.includes(name));
}

const seconds = (since) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

/** Starts `script` with its output going to a file (nothing to drain while this process blocks on psql);
 * the promise settles with its exit, output and time once it ends. The exit is seen only when this process
 * next waits, so the time is taken from the output's last write. */
function startInBackground(script) {
	const output = mkdtempSync(join(tmpdir(), "qorpera-hosted-db-script-"));
	const file = join(output, "output.log");
	const descriptor = openSync(file, "w");
	const started = Date.now();
	const child = spawn(process.execPath, [script], { cwd: repositoryRoot, stdio: ["ignore", descriptor, descriptor] });
	closeSync(descriptor);
	return new Promise((resolveExit) => {
		child.on("error", (error) => resolveExit({ code: null, signal: String(error.message), output: "", time: "0 s" }));
		child.on("exit", (code, signal) => {
			const text = readFileSync(file, "utf-8");
			const time = `about ${((statSync(file).mtimeMs - started) / 1000).toFixed(1)} s`;
			rmSync(output, { recursive: true, force: true });
			resolveExit({ code, signal, output: text, time });
		});
	});
}

function report(failed, script, code, signal, time) {
	if (code !== 0) failed.push(script);
	process.stdout.write(`== hosted-db: ${script} ${code === 0 ? "passed" : `FAILED (exit ${code ?? signal})`} in ${time}\n`);
}

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

const USAGE = "Usage: node scripts/test-hosted-db.mjs [--scripts] [--only <test>[,<test>...]]";

/** The command line: `--scripts` also runs the hosted-db scripts; `--only` keeps the SQL tests whose file name
 * starts with one of the comma-separated values (`--only 811,818` or `--only=811_folder_company_search`). */
export function parseArguments(args) {
	let withScripts = false;
	let only = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--scripts") withScripts = true;
		else if (arg === "--only" || arg.startsWith("--only=")) {
			const value = arg === "--only" ? args[++i] : arg.slice("--only=".length);
			if (only !== null || !value) throw new Error(USAGE);
			only = value.split(",").map((part) => part.trim());
			if (only.some((part) => !/^[0-9a-z_][0-9a-z_.-]*$/.test(part))) throw new Error(USAGE);
		} else throw new Error(USAGE);
	}
	return { withScripts, only };
}

/** The tests `--only` keeps, in their usual order. Every value must match at least one test, so a typo never
 * passes as an empty run. A test that runs after another test's fixture (`-- @fixture`) still reads that file. */
export function selectTests(tests, only) {
	if (only === null) return tests;
	const missing = only.filter((prefix) => !tests.some((test) => test.startsWith(prefix)));
	if (missing.length) throw new Error(`No hosted database test starts with: ${missing.join(", ")}`);
	return tests.filter((test) => only.some((prefix) => test.startsWith(prefix)));
}

async function main() {
	const { withScripts, only } = parseArguments(process.argv.slice(2));
	const testsRoot = join(repositoryRoot, "supabase", "tests");
	const all = readdirSync(testsRoot)
		.filter((name) => name.endsWith(".test.sql"))
		.sort();
	if (all.length === 0) {
		throw new Error("No hosted database regression tests were found");
	}
	const tests = selectTests(all, only);
	const started = performance.now();
	const background = withScripts
		? HOSTED_DB_SCRIPTS.filter((script) => OWN_SERVER_SCRIPTS.has(script)).map((script) => [script, startInBackground(script)])
		: [];
	const failed = [];
	let cluster;
	try {
		cluster = await HostedDbCluster.start();
		process.stdout.write(`Started ${cluster.container} in ${seconds(started)}\n`);
		const building = performance.now();
		const names = migrationNames();
		const migrations = cluster.build({ snapshotBefore: withScripts ? scriptStartPoints(names) : [] });
		process.stdout.write(`Applied the test bootstrap and ${migrations} migrations in ${seconds(building)}\n`);

		const testing = performance.now();
		cluster.create(databaseName);
		try {
			runSqlTests(cluster, databaseName, tests);
			process.stdout.write(
				`Hosted database checks passed (${migrations} migrations, ${tests.length}${only ? ` of ${all.length}` : ""} tests) in ${seconds(testing)}\n`,
			);
		} catch (error) {
			process.stdout.write(`${error.message}\n`);
			failed.push("SQL tests");
		}
		cluster.drop(databaseName);

		if (withScripts)
			for (const script of HOSTED_DB_SCRIPTS.filter((name) => !OWN_SERVER_SCRIPTS.has(name))) {
				const scriptStarted = performance.now();
				process.stdout.write(`== hosted-db: ${script}\n`);
				const result = spawnSync(process.execPath, [script], {
					cwd: repositoryRoot,
					stdio: "inherit",
					env: { ...process.env, ...cluster.environment() },
				});
				report(failed, script, result.status, result.signal, seconds(scriptStarted));
			}
	} finally {
		cluster?.stop();
		for (const [script, exited] of background) {
			const { code, signal, output, time } = await exited;
			process.stdout.write(`== hosted-db: ${script} (ran beside the SQL tests)\n${output}`);
			report(failed, script, code, signal, time);
		}
	}
	process.stdout.write(`== hosted-db: ${failed.length ? `failed: ${failed.join(", ")}` : "all passed"} in ${seconds(started)}\n`);
	if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
