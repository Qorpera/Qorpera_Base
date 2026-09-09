// Disposable SQL member export authority. The existing export fixture uses
// real native receipts and synthetic object catalog confirmation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
import { testOfficeFileExport } from "./test-runtime-office-file-export.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-member-exports-${randomBytes(6).toString("hex")}`;
const docker = (args, input) => {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout?.slice(-4000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
};
const sql = text => docker(["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "exports", "-v", "ON_ERROR_STOP=1"], text);
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "-e", "POSTGRES_PASSWORD=disposable-export", "-e", "POSTGRES_DB=exports", POSTGRES_IMAGE]); started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "exports"], { timeout: 2000 });
		ready = result.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise(accept => setTimeout(accept, 500));
	}
	assert.equal(ready, 2); sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) sql(readFileSync(join(root, "supabase/migrations", name), "utf8"));
	const wake = readFileSync(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8").split("-- END WAKE FIXTURE"); assert.equal(wake.length, 2);
	const office = readFileSync(join(root, "supabase/tests/fixtures/runtime-office-registry-cases.sql"), "utf8").split("set local role service_role;\nselect set_config('qorpera_test.office_lease'"); assert.equal(office.length, 2);
	const exported = readFileSync(join(root, "supabase/tests/fixtures/runtime-office-file-exports-cases.sql"), "utf8");
	sql(`${wake[0]}\n${office[0]}\n${exported}\n${readFileSync(join(root, "supabase/tests/fixtures/member-file-export-cases.sql"), "utf8")}\nrollback;`);
	console.log(JSON.stringify({ schema: "qorpera.member-file-export-sql/v1", migrations: migrations.length, actualAuthority: true, actualNativeReceipt: true, sharedMemberRead: true, completedReceiptRequired: true, privateAudienceDenied: true, revocationDenied: true, sourceIdentity: true, retainedAfterOfficeRevocation: true, boundedList: true, manifestLogicalSizeLimit: 131072, storage: "catalog-fixture", hosted: false }));
	const lines = sql(`${wake[0]}\n${office[0]}\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-office-company-file-source.sql"),"utf8")}
	 set local role service_role;
	 select jsonb_build_object('binding',current_setting('qorpera_test.wake_binding')::jsonb,
	 'companyFile',current_setting('qorpera_test.company_import_source')::jsonb,'scope',current_setting('qorpera_test.office_scope')::jsonb); commit;`).split("\n");
	await testOfficeFileExport({root,query:sql,setup:JSON.parse(lines.at(-1))});
} finally { if (started) docker(["rm", "-f", container]); }
