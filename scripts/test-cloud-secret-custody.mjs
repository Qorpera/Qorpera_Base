import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const container = `qorpera-secret-custody-${randomBytes(6).toString("hex")}`;

function docker(args, input) {
	const result = spawnSync("docker", args, {
		cwd: root,
		input,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Disposable secret-custody database command failed: ${result.error ?? result.stderr}`);
	}
	return result.stdout;
}

const psql = [
	"exec",
	"--interactive",
	container,
	"psql",
	"--username",
	"postgres",
	"--dbname",
	"qorpera_test",
	"--no-psqlrc",
	"--set",
	"ON_ERROR_STOP=1",
];

async function waitForDatabase() {
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt += 1) {
		const probe = spawnSync(
			"docker",
			["exec", container, "pg_isready", "--username", "postgres", "--dbname", "qorpera_test"],
			{ cwd: root, encoding: "utf8", timeout: 2000 },
		);
		ready = probe.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	}
	if (ready < 2) throw new Error("Disposable secret-custody database did not become ready");
}

let started = false;
try {
	docker([
		"run",
		"--detach",
		"--rm",
		"--name",
		container,
		"--label",
		"qorpera.step2-test=cloud-secret-custody",
		"--env",
		"POSTGRES_PASSWORD=qorpera-test-only",
		"--env",
		"POSTGRES_DB=qorpera_test",
		"--tmpfs",
		"/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
		POSTGRES_IMAGE,
	]);
	started = true;
	await waitForDatabase();
	docker(psql, readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const migration of migrations) {
		docker(psql, readFileSync(join(root, "supabase/migrations", migration), "utf8"));
	}
	docker(psql, readFileSync(join(root, "supabase/tests/305_cloud_secret_custody.test.sql"), "utf8"));
	docker(psql, readFileSync(join(root, "scripts/cloud-secret-broker-service-role-fixture.sql"), "utf8"));
	docker(
		psql,
		readFileSync(join(root, "supabase/migrations/20260828018100_cloud_secret_broker_role.sql"), "utf8"),
	);
	docker(psql, readFileSync(join(root, "supabase/tests/305_cloud_secret_custody.test.sql"), "utf8"));
	console.log(
		`Passed cloud secret custody SQL after ${migrations.length} migrations and the service-role upgrade fixture`,
	);
} finally {
	if (started) {
		spawnSync("docker", ["rm", "--force", container], { cwd: root, encoding: "utf8" });
		console.log(`Removed disposable secret-custody database ${container}`);
	}
}
