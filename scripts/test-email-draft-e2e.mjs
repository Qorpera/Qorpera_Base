// Isolated cross-layer acceptance: production client, broker, SQL and adapters.
// Gmail/OAuth responses are synthetic. No LLM or external mailbox is contacted.
// Usage: node scripts/test-email-draft-e2e.mjs
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expandTestFixture, POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "qorpera-email-e2e-"));
const container = `qorpera-email-e2e-${process.pid}-${randomBytes(4).toString("hex")}`;
let started = false;
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.status}`);
	return result.stdout;
}
try {
	run("docker", ["run", "--detach", "--rm", "--network", "none", "--name", container,
		"--env", "POSTGRES_PASSWORD=qorpera-test-only", "--env", "POSTGRES_DB=qorpera_test",
		"--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g", POSTGRES_IMAGE]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "qorpera_test"]);
		ready = result.status === 0 ? ready + 1 : 0;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	if (ready < 2) throw new Error("Isolated PostgreSQL did not become ready");
	const psql = (sql) => run("docker", ["exec", "-i", container, "psql", "-X", "-q", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1"], { input: sql });
	psql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	console.log(`Applying ${migrations.length} migrations to isolated PostgreSQL`);
	for (let index = 0; index < migrations.length; index++) {
		psql(readFileSync(join(root, "supabase/migrations", migrations[index]), "utf8"));
		if ((index + 1) % 50 === 0) console.log(`Applied ${index + 1}/${migrations.length} migrations`);
	}
	const fixture = expandTestFixture("620_member_email_drafts.test.sql", (name) => readFileSync(join(root, "supabase/tests", name), "utf8"));
	const end = fixture.indexOf("do $$ declare v jsonb; begin");
	if (end < 0) throw new Error("Email draft seed marker is missing");
	writeFileSync(join(temporary, "seed.sql"), fixture.slice(0, end));
	// Trust only this temporary loopback certificate; do not disable TLS validation.
	writeFileSync(join(temporary, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
	run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", join(temporary, "openssl.cnf"), "-keyout", join(temporary, "key.pem"), "-out", join(temporary, "cert.pem")]);
	await build({ entryPoints: [join(root, "scripts/fixtures/email-draft-e2e.mjs")], outfile: join(temporary, "harness.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
	run(process.execPath, [join(temporary, "harness.mjs"), container, temporary], { stdio: "inherit", env: { ...process.env, NODE_EXTRA_CA_CERTS: join(temporary, "cert.pem") } });
	console.log(`Email draft E2E passed (${migrations.length} real migrations; simulated Gmail; no real LLM or email delivery)`);
} finally {
	if (started) spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
	rmSync(temporary, { recursive: true, force: true });
}
