import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const POSTGRES_IMAGE =
	"docker.io/library/postgres:17.6-alpine3.22@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_test";
const databasePassword = "qorpera-test-only";

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

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		encoding: "utf-8",
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
	}
	return result.stdout.trim();
}

function runPsql(containerName, sql) {
	return run(
		"docker",
		[
			"exec",
			"--interactive",
			containerName,
			"psql",
			"--username",
			"postgres",
			"--dbname",
			databaseName,
			"--no-psqlrc",
			"--set",
			"ON_ERROR_STOP=1",
		],
		{ input: sql },
	);
}

async function waitForPostgres(containerName) {
	let consecutiveReadyChecks = 0;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const result = spawnSync(
			"docker",
			[
				"exec",
				containerName,
				"pg_isready",
				"--username",
				"postgres",
				"--dbname",
				databaseName,
			],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		);
		if (result.status === 0) {
			consecutiveReadyChecks += 1;
			if (consecutiveReadyChecks === 2) {
				return;
			}
		} else {
			consecutiveReadyChecks = 0;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	throw new Error("Disposable PostgreSQL did not become ready within 30 seconds");
}

async function main() {
	run("docker", ["info", "--format", "{{.ServerVersion}}"]);
	const containerName = buildContainerName(process.pid, randomBytes(4).toString("hex"));
	let started = false;
	try {
		run("docker", [
			"run",
			"--detach",
			"--rm",
			"--name",
			containerName,
			"--env",
			`POSTGRES_PASSWORD=${databasePassword}`,
			"--env",
			`POSTGRES_DB=${databaseName}`,
			"--tmpfs",
			"/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
			POSTGRES_IMAGE,
		]);
		started = true;
		await waitForPostgres(containerName);

		const bootstrapPath = join(repositoryRoot, "supabase", "tests", "bootstrap.sql");
		process.stdout.write("Applying disposable Supabase fixture\n");
		runPsql(containerName, readFileSync(bootstrapPath, "utf-8"));
		// Production's function default privileges: the SQL suite runs against production's function ACLs.
		runPsql(containerName, readFileSync(join(repositoryRoot, "supabase", "tests", "platform-function-defaults.sql"), "utf-8"));

		const migrationsRoot = join(repositoryRoot, "supabase", "migrations");
		const migrations = sortMigrationNames(readdirSync(migrationsRoot));
		if (migrations.length === 0) {
			throw new Error("No hosted database migrations were found");
		}
		for (const migration of migrations) {
			process.stdout.write(`Applying ${migration}\n`);
			runPsql(containerName, readFileSync(join(migrationsRoot, migration), "utf-8"));
		}

		const testsRoot = join(repositoryRoot, "supabase", "tests");
		const tests = readdirSync(testsRoot)
			.filter((name) => name.endsWith(".test.sql"))
			.sort();
		if (tests.length === 0) {
			throw new Error("No hosted database regression tests were found");
		}
		for (const test of tests) {
			process.stdout.write(`Running ${test}\n`);
			runPsql(containerName, expandTestFixture(test, (name) => readFileSync(join(testsRoot, name), "utf-8")));
		}
		process.stdout.write(`Hosted database checks passed (${migrations.length} migrations, ${tests.length} tests)\n`);
	} finally {
		if (started) {
			spawnSync("docker", ["rm", "--force", containerName], {
				cwd: repositoryRoot,
				encoding: "utf-8",
			});
		}
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
