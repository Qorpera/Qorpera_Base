// Actual native/Company File SQL authority in a disposable network-isolated DB.
// Presence remains a client-side Realtime state; no hosted service or model calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
import { testCompanyPresenceWire } from "./test-runtime-company-presence-wire.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = `qorpera-presence-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", name, "psql", "-X", "-qAt", "-U", "postgres", "-d", "presence", "-v", "ON_ERROR_STOP=1"];
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert(!result.error && result.status === 0, result.stderr || result.stdout || String(result.error)); return result.stdout.trim();
}
let started = false;
try {
	docker(["run", "--rm", "-d", "--name", name, "--network", "none", "-e", "POSTGRES_PASSWORD=presence-fixture-only", "-e", "POSTGRES_DB=presence", POSTGRES_IMAGE]); started = true;
	let ready = false;
	for (let attempt = 0; attempt < 60; attempt++) {
		// The image's temporary init server accepts Unix sockets before the
		// requested database exists. Only its final server listens on TCP.
		if (spawnSync("docker", ["exec", name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "presence", "-qAt", "-c", "select 1"], { timeout: 2000, stdio: "ignore" }).status === 0) { ready = true; break; }
		await new Promise((accept) => setTimeout(accept, 500));
	}
	assert(ready); docker(psql, readFileSync(join(root,"supabase/tests/bootstrap.sql"),"utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root,"supabase/migrations")));
	for (const migration of migrations) docker(psql, readFileSync(join(root,"supabase/migrations",migration),"utf8"));
	const fixture = readFileSync(join(root,"supabase/tests/300_runtime_wake_bus.test.sql"),"utf8").split("-- END WAKE FIXTURE");
	assert.equal(fixture.length,2);
	docker(psql, fixture[0]+"\n"+readFileSync(join(root,"supabase/tests/fixtures/runtime-company-presence-cases.sql"),"utf8")+"\nrollback;");
	console.log(`PASS: ${migrations.length} migrations; actual native presence admission, path privacy, policy token rotation, expiry, revocation and exact cleanup`);
	await testCompanyPresenceWire({root,query:(input)=>docker(psql,input),fixture:fixture[0]});
} finally { if (started) docker(["rm","-f",name]); }
