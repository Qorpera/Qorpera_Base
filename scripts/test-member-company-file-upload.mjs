// Disposable real SQL authority; storage catalog entries in the SQL fixture
// stand in for objects. HTTP/bytes acceptance is a separate composed layer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
import { testMemberUploadHttp } from "./test-member-company-file-upload-http.mjs";
import { testMemberWebFilesSql } from "./test-member-web-files-sql.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-member-upload-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "uploads", "-v", "ON_ERROR_STOP=1"];
const docker = (args, input) => {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout?.slice(-4000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
};
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "-e", "POSTGRES_PASSWORD=disposable-upload", "-e", "POSTGRES_DB=uploads", POSTGRES_IMAGE]); started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "uploads"], { timeout: 2000 });
		ready = result.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise(accept => setTimeout(accept, 500));
	}
	assert.equal(ready, 2); docker(psql, readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) docker(psql, readFileSync(join(root, "supabase/migrations", name), "utf8"));
	const legacy = readFileSync(join(root, "supabase/tests/295_member_company_file_commands.test.sql"), "utf8");
	assert(legacy.trimEnd().endsWith("rollback;"));
	docker(psql, legacy.slice(0, legacy.lastIndexOf("rollback;")) + readFileSync(join(root, "supabase/tests/fixtures/member-company-file-upload-cases.sql"), "utf8") + "\nrollback;");
	console.log(JSON.stringify({ schema: "qorpera.member-company-file-upload-sql/v1", migrations: migrations.length, legacyCommands: true, actualAuthority: true,
		binaryBytes: 4194307, chunkIdentity: true, exactSource: true, replay: true, emptyFile: true, privateLedger: true, retainedChunks: true, storage: "catalog-fixture", hosted: false }));
	const marker = "-- Human commands never mint a native run, lease or tool binding.";
	assert(legacy.includes(marker));
	const composition = process.env.QORPERA_WEB_SQL_TEST_BROWSER ? testMemberWebFilesSql : testMemberUploadHttp;
	await composition({ root, query: text => docker(psql, text), seed: legacy.slice(0, legacy.indexOf(marker)) + "\ncommit;" });
} finally { if (started) docker(["rm", "-f", container]); }
