// Local PostgreSQL only: applies every migration to a disposable container and
// runs supabase/tests/300_login_recovery_automation.test.sql (2026-09-17 amendment:
// identity recovery inside a member login). No hosted database is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, POSTGRES_LOCALE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-login-recovery-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "recovery", "-v", "ON_ERROR_STOP=1"];
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout?.slice(-4000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = (text) => docker(psql, text);
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "-e", "POSTGRES_PASSWORD=disposable", "-e", "POSTGRES_DB=recovery", ...POSTGRES_LOCALE, POSTGRES_IMAGE]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "recovery"], { timeout: 2000 });
		ready = result.status === 0 ? ready + 1 : 0;
		if (ready < 2) spawnSync("sleep", ["1"]);
	}
	assert(ready >= 2, "postgres did not become ready");
	sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	for (const name of sortMigrationNames(readdirSync(join(root, "supabase/migrations")).filter((n) => n.endsWith(".sql"))))
		sql(readFileSync(join(root, "supabase/migrations", name), "utf8"));
	sql(readFileSync(join(root, "supabase/tests/fixtures/runtime-node-inventory-observer.sql"), "utf8"));
	const output = sql(readFileSync(join(root, "supabase/tests/300_login_recovery_automation.test.sql"), "utf8"));
	assert(output.includes("LOGIN_RECOVERY_AUTOMATION_OK"), output.slice(-2000));
	console.log(JSON.stringify({ passed: true, suite: "300_login_recovery_automation", migrations: readdirSync(join(root, "supabase/migrations")).filter((n) => n.endsWith(".sql")).length }));
} finally {
	if (started) spawnSync("docker", ["rm", "-f", container], { timeout: 30_000 });
}
