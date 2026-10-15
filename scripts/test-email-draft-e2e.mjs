// Isolated cross-layer acceptance: production client, broker, SQL and adapters.
// Gmail/OAuth responses are synthetic. No LLM or external mailbox is contacted.
// Usage: node scripts/test-email-draft-e2e.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expandTestFixture } from "./test-hosted-db.mjs";
import { hostedDatabase, migrationNames } from "./test-hosted-db-cluster.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "qorpera-email-e2e-"));
let database;
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.status}`);
	return result.stdout;
}
try {
	const migrations = migrationNames();
	// Not qorpera_test: the suite's SQL tests use that database while this script runs beside them.
	database = await hostedDatabase("qorpera_email_draft");
	const container = database.container;
	const fixture = expandTestFixture("620_member_email_drafts.test.sql", (name) => readFileSync(join(root, "supabase/tests", name), "utf8"));
	const end = fixture.indexOf("do $$ declare v jsonb; begin");
	if (end < 0) throw new Error("Email draft seed marker is missing");
	writeFileSync(join(temporary, "seed.sql"), fixture.slice(0, end));
	// Trust only this temporary loopback certificate; do not disable TLS validation.
	writeFileSync(join(temporary, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
	run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", join(temporary, "openssl.cnf"), "-keyout", join(temporary, "key.pem"), "-out", join(temporary, "cert.pem")]);
	await build({ entryPoints: [join(root, "scripts/fixtures/email-draft-e2e.mjs")], outfile: join(temporary, "harness.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
	run(process.execPath, [join(temporary, "harness.mjs"), container, temporary, database.database], { stdio: "inherit", env: { ...process.env, NODE_EXTRA_CA_CERTS: join(temporary, "cert.pem") } });
	console.log(`Email draft E2E passed (${migrations.length} real migrations; simulated Gmail; no real LLM or email delivery)`);
} finally {
	database?.close();
	rmSync(temporary, { recursive: true, force: true });
}
