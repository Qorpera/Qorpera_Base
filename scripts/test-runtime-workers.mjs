import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

// Disposable component tests only: no published ports, network or credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = randomBytes(6).toString("hex");
const container = "qorpera-step5-test-" + process.pid + "-" + suffix;
const volume = container + "-data";
const objects = mkdtempSync(join(tmpdir(), "qorpera-step5-test-objects-"));

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(command + " failed: " + (result.stdout ?? "") + (result.stderr ?? ""));
	return result.stdout?.trim() ?? "";
}

function sql(text) {
	run("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "qorpera_test", "-X", "-v", "ON_ERROR_STOP=1"], { input: text });
}

let createdVolume = false;
let started = false;
try {
	run("docker", ["volume", "create", "--label", "qorpera.test=runtime-workers", volume]);
	createdVolume = true;
	run("docker", [
		"run", "--detach", "--pull", "never", "--network", "none", "--name", container,
		"--label", "qorpera.test=runtime-workers", "--env", "POSTGRES_PASSWORD=qorpera-disposable-test-only",
		"--env", "POSTGRES_DB=qorpera_test", "--mount", "type=volume,source=" + volume + ",target=/var/lib/postgresql/data", POSTGRES_IMAGE,
	]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "qorpera_test"], { encoding: "utf8" });
		ready = result.status === 0 ? ready + 1 : 0;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	if (ready !== 2) throw new Error("Disposable PostgreSQL did not become ready");
	sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrationsRoot = join(root, "supabase/migrations");
	const migrations = sortMigrationNames(readdirSync(migrationsRoot));
	for (const migration of migrations) {
		process.stdout.write("Applying disposable fixture migration " + migration + "\n");
		sql(readFileSync(join(migrationsRoot, migration), "utf8"));
	}
	process.stdout.write("Running Step 5 persistence tests (" + migrations.length + " existing migrations; durable volume; no published ports)\n");
	run(process.execPath, ["../../node_modules/vitest/dist/cli.js", "--run", "test/cloud-worker-persistence.test.ts", "--reporter=verbose"], {
		cwd: join(root, "packages/shell"), stdio: "inherit",
		env: { ...process.env, QORPERA_WORKER_TEST_CONTAINER: container, QORPERA_WORKER_TEST_OBJECTS: objects },
	});
} finally {
	if (started) spawnSync("docker", ["rm", "--force", container], { encoding: "utf8" });
	if (createdVolume) spawnSync("docker", ["volume", "rm", volume], { encoding: "utf8" });
	rmSync(objects, { recursive: true, force: true });
}
